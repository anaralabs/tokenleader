// `anara-leaderboard link|devices|revoke` — multi-device management run from
// the user's shell (not under launchd). User + endpoint resolve from env
// when set, else from the installed LaunchAgent plist; the daemon-written
// endpoint override file wins over both, mirroring the daemon's own boot
// precedence. Auth is this machine's TOFU secret from `<stateDir>/secret`.
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { validateCursorToken } from "../parser/cursor-api";
import { extractCursorSessionToken } from "./cursor-auto-login";
import { runCursorCloudSync } from "./cursor-sync";
import { loadCursorToken, saveCursorCredentials, saveCursorToken } from "./cursor-token";
import { readEndpointOverride } from "./endpoint-override";
import { loadState, saveState } from "./state";
import { DEFAULT_BATCH_SIZE } from "./transport";

export const CLI_COMMANDS = [
  "link",
  "devices",
  "revoke",
  "login-cursor",
  "sync-cursor",
] as const;
export type CliCommand = (typeof CLI_COMMANDS)[number];

const FETCH_TIMEOUT_MS = 10_000;

export interface CliDeps {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  /** Test seam for `login-cursor --auto`. */
  extractCursorSession?: typeof extractCursorSessionToken;
  /** Test seam for the plist read; default reads the real LaunchAgent. */
  readPlist?: () => Promise<string>;
  loadState?: typeof loadState;
  saveState?: typeof saveState;
  print?: (line: string) => void;
  printErr?: (line: string) => void;
}

interface CliContext {
  user: string;
  endpoint: string;
  secret: string;
}

function plistPath(): string {
  return path.join(homedir(), "Library", "LaunchAgents", "sh.anara.leaderboard.plist");
}

/** Pull <key>K</key><string>V</string> pairs out of the LaunchAgent plist.
 *  Only ALL-CAPS keys (the env vars) can match; values our installer writes
 *  never contain XML entities. */
export function parsePlistEnv(xml: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of xml.matchAll(/<key>([A-Z0-9_]+)<\/key>\s*<string>([^<]*)<\/string>/g)) {
    out[m[1]!] = m[2]!;
  }
  return out;
}

function resolveStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.TOKENLEADER_STATE_DIR?.trim() ||
    path.join(homedir(), ".local", "share", "anara-leaderboard")
  );
}

async function resolveCliContext(deps: CliDeps): Promise<CliContext> {
  const env = deps.env ?? process.env;
  const readPlist = deps.readPlist ?? (() => fs.readFile(plistPath(), "utf8"));

  let plistEnv: Record<string, string> = {};
  try {
    plistEnv = parsePlistEnv(await readPlist());
  } catch {
    // No LaunchAgent (or unreadable) — env vars may still carry everything.
  }

  const user = env.TOKENLEADER_USER?.trim() || plistEnv.TOKENLEADER_USER || "";
  if (!user) {
    throw new Error(
      "can't determine your handle — is the daemon installed? (set TOKENLEADER_USER to override)",
    );
  }

  let endpoint = env.TOKENLEADER_ENDPOINT?.trim() || plistEnv.TOKENLEADER_ENDPOINT || "";
  const stateDir = resolveStateDir(env);
  try {
    const override = await readEndpointOverride(stateDir);
    if (override) endpoint = override;
  } catch {
    // Corrupt override file loses to the plist/env endpoint.
  }
  if (!endpoint) {
    throw new Error(
      "can't determine the server endpoint — is the daemon installed? (set TOKENLEADER_ENDPOINT to override)",
    );
  }

  let secret = "";
  try {
    secret = (await fs.readFile(path.join(stateDir, "secret"), "utf8")).trim();
  } catch {
    // handled below
  }
  if (!secret) {
    throw new Error(
      `no device secret at ${path.join(stateDir, "secret")} — the daemon creates it on its first sync`,
    );
  }

  return { user, endpoint: endpoint.replace(/\/+$/, ""), secret };
}

async function callServer(
  ctx: CliContext,
  deps: CliDeps,
  method: "GET" | "POST",
  pathname: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const res = await fetchImpl(`${ctx.endpoint}${pathname}`, {
    method,
    headers: {
      "X-Tokenleader-Secret": ctx.secret,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    // non-JSON error body; status carries the story
  }
  return { status: res.status, json };
}

interface DeviceEntry {
  id: number;
  label: string | null;
  version: string | null;
  arch: string | null;
  addedAt: number;
  lastSeen: number | null;
  current: boolean;
}

async function fetchDevices(ctx: CliContext, deps: CliDeps): Promise<DeviceEntry[]> {
  const r = await callServer(ctx, deps, "GET", `/devices?user=${encodeURIComponent(ctx.user)}`);
  if (r.status !== 200) {
    throw new Error(`server said ${r.status}: ${String(r.json.error ?? "unknown error")}`);
  }
  return (r.json.devices ?? []) as DeviceEntry[];
}

function relTime(ms: number | null): string {
  if (ms === null) return "never";
  const mins = Math.round((Date.now() - ms) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / (24 * 60))}d ago`;
}

function deviceLine(d: DeviceEntry): string {
  const label = d.label ?? `device-${d.id}`;
  const marker = d.current ? "  (this machine)" : "";
  return `  [${d.id}] ${label}  ${d.version ?? "version unknown"}  last seen ${relTime(d.lastSeen)}${marker}`;
}

async function runLink(deps: CliDeps): Promise<number> {
  const print = deps.print ?? console.log;
  const ctx = await resolveCliContext(deps);
  const r = await callServer(ctx, deps, "POST", "/devices/link", { user: ctx.user });
  if (r.status !== 200) {
    throw new Error(`server said ${r.status}: ${String(r.json.error ?? "unknown error")}`);
  }
  const mins = Math.max(1, Math.round((Number(r.json.expiresAt) - Date.now()) / 60_000));
  print(`Link code for '${ctx.user}': ${String(r.json.code)}`);
  print(`Valid for ${mins} minutes, single use.`);
  print("");
  print("On the machine you want to add, run:");
  print(`  ${String(r.json.command)}`);
  return 0;
}

async function runDevices(deps: CliDeps): Promise<number> {
  const print = deps.print ?? console.log;
  const ctx = await resolveCliContext(deps);
  const devices = await fetchDevices(ctx, deps);
  print(`Devices posting as '${ctx.user}':`);
  for (const d of devices) print(deviceLine(d));
  print("");
  print("Revoke one with: tokenleader revoke <id>");
  return 0;
}

function loginCursorUsageMessage(): string {
  return (
    "usage: tokenleader login-cursor [--auto | <WorkosCursorSessionToken>]\n" +
    "  Recommended on macOS:\n" +
    "    tokenleader login-cursor --auto\n" +
    "    Reads your Cursor IDE login from ~/Library/Application Support/Cursor/...\n" +
    "  Manual fallback:\n" +
    "    Copy the WorkosCursorSessionToken cookie from cursor.com (DevTools → Application → Cookies)."
  );
}

async function runLoginCursorAuto(deps: CliDeps): Promise<{
  sessionToken: string;
  email: string;
  refreshToken: string;
  machineId: string;
}> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const extract = deps.extractCursorSession ?? extractCursorSessionToken;
  if (!deps.extractCursorSession && process.platform !== "darwin") {
    throw new Error("login-cursor --auto is supported on macOS only");
  }
  const { sessionToken, email, machineId, auth } = await extract({ fetchImpl });
  return {
    sessionToken,
    email,
    refreshToken: auth.refreshToken,
    machineId,
  };
}

async function runLoginCursor(deps: CliDeps, args: string[]): Promise<number> {
  const print = deps.print ?? console.log;
  const env = deps.env ?? process.env;
  const arg0 = (args[0] ?? "").trim();

  if (arg0 === "--auto") {
    if (args.length > 1) {
      throw new Error(loginCursorUsageMessage());
    }
    print("Reading Cursor session from local IDE storage...");
    const { sessionToken, email, refreshToken, machineId } = await runLoginCursorAuto(deps);
    const stateDir = resolveStateDir(env);
    await saveCursorCredentials(stateDir, {
      sessionToken,
      refreshToken,
      machineId,
      email,
    });
    print(`Authenticated as: ${email}`);
    print(`Cursor credentials saved to ${path.join(stateDir, "cursor_credentials.json")}`);

    // Credentials are already on disk; the post-login sync is a convenience.
    // Don't fail the command if the daemon isn't linked yet or the post fails.
    try {
      const ctx = await resolveCliContext(deps);
      const loadFn = deps.loadState ?? loadState;
      const saveFn = deps.saveState ?? saveState;
      const state = await loadFn(stateDir);
      print("Syncing current month usage from Cursor Cloud...");
      const r = await runCursorCloudSync({
        user: ctx.user,
        stateDir,
        state,
        transport: {
          endpoint: ctx.endpoint,
          secret: ctx.secret,
          batchSize: DEFAULT_BATCH_SIZE,
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        },
        mode: "month",
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      });
      if (!r.posted) {
        print(
          "Warning: could not post Cursor usage to the leaderboard — credentials are saved; run `tokenleader sync-cursor` when the server is reachable.",
        );
        return 0;
      }
      await saveFn(stateDir, r.state);
      print(
        `Synced ${r.eventsFetched} Cursor events this month (${r.inserted} new, ${r.duplicates} already on server).`,
      );
    } catch (err: unknown) {
      print(
        `Warning: skipped post-login sync (${String((err as Error)?.message ?? err)}). Run \`tokenleader link\` and then \`tokenleader sync-cursor\` when ready.`,
      );
    }
    return 0;
  }

  const token = arg0;
  if (!token) {
    throw new Error(loginCursorUsageMessage());
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  await validateCursorToken(token, { fetchImpl });

  const stateDir = resolveStateDir(env);
  await saveCursorToken(stateDir, token);
  print(`Cursor session token saved to ${path.join(stateDir, "cursor_token")}`);
  print("Run `tokenleader sync-cursor` to backfill history, or wait for the daemon's next tick.");
  return 0;
}

async function runSyncCursor(deps: CliDeps): Promise<number> {
  const print = deps.print ?? console.log;
  const env = deps.env ?? process.env;
  const stateDir = resolveStateDir(env);
  const ctx = await resolveCliContext(deps);

  const token = await loadCursorToken(stateDir);
  if (!token) {
    throw new Error(
      "no cursor session token — run `tokenleader login-cursor --auto` (macOS) or `tokenleader login-cursor <token>` first",
    );
  }

  const loadFn = deps.loadState ?? loadState;
  const saveFn = deps.saveState ?? saveState;
  const state = await loadFn(stateDir);

  print("Fetching Cursor usage history from the dashboard (this may take a minute)...");
  const r = await runCursorCloudSync({
    user: ctx.user,
    stateDir,
    state,
    transport: {
      endpoint: ctx.endpoint,
      secret: ctx.secret,
      batchSize: DEFAULT_BATCH_SIZE,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    },
    mode: "full",
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });

  if (!r.posted) {
    throw new Error("cursor cloud sync failed — check your token and server connection");
  }

  await saveFn(stateDir, r.state);
  print(
    `Synced ${r.eventsFetched} Cursor events (${r.inserted} new, ${r.duplicates} already on server).`,
  );
  return 0;
}

async function runRevoke(deps: CliDeps, args: string[]): Promise<number> {
  const print = deps.print ?? console.log;
  const ctx = await resolveCliContext(deps);
  const target = (args[0] ?? "").trim();
  if (!target) {
    throw new Error("usage: tokenleader revoke <device-id|label>  (see `tokenleader devices`)");
  }
  const devices = await fetchDevices(ctx, deps);
  const matches = /^\d+$/.test(target)
    ? devices.filter((d) => d.id === Number(target))
    : devices.filter((d) => d.label === target);
  if (matches.length === 0) {
    throw new Error(`no active device matches '${target}' — see \`tokenleader devices\``);
  }
  if (matches.length > 1) {
    throw new Error(`'${target}' matches ${matches.length} devices — revoke by id instead`);
  }
  const device = matches[0]!;
  const r = await callServer(ctx, deps, "POST", "/devices/revoke", {
    user: ctx.user,
    deviceId: device.id,
  });
  if (r.status !== 200) {
    throw new Error(`server said ${r.status}: ${String(r.json.error ?? "unknown error")}`);
  }
  print(`Revoked ${deviceLine(device).trim()}`);
  if (r.json.uninstalled === true) {
    print(`That was the last device — '${ctx.user}' is now marked uninstalled.`);
  }
  if (device.current) {
    print("This machine can no longer post; uninstall it or re-link to keep using it.");
  }
  return 0;
}

export async function runCliCommand(
  command: CliCommand,
  args: string[],
  deps: CliDeps = {},
): Promise<number> {
  const printErr = deps.printErr ?? console.error;
  try {
    if (command === "link") return await runLink(deps);
    if (command === "devices") return await runDevices(deps);
    if (command === "login-cursor") return await runLoginCursor(deps, args);
    if (command === "sync-cursor") return await runSyncCursor(deps);
    return await runRevoke(deps, args);
  } catch (err: unknown) {
    printErr(`tokenleader ${command}: ${String((err as Error)?.message ?? err)}`);
    return 1;
  }
}
