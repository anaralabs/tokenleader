// `anara-leaderboard link|devices|revoke` — multi-device management run from
// the user's shell (not under launchd). User + endpoint resolve from env
// when set, else from the installed LaunchAgent plist; the daemon-written
// endpoint override file wins over both, mirroring the daemon's own boot
// precedence. Auth is this machine's TOFU secret from `<stateDir>/secret`.
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { readEndpointOverride } from "./endpoint-override";

export const CLI_COMMANDS = ["link", "devices", "revoke"] as const;
export type CliCommand = (typeof CLI_COMMANDS)[number];

const FETCH_TIMEOUT_MS = 10_000;

export interface CliDeps {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  /** Test seam for the plist read; default reads the real LaunchAgent. */
  readPlist?: () => Promise<string>;
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
  const stateDir =
    env.TOKENLEADER_STATE_DIR?.trim() ||
    path.join(homedir(), ".local", "share", "anara-leaderboard");
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
    return await runRevoke(deps, args);
  } catch (err: unknown) {
    printErr(`tokenleader ${command}: ${String((err as Error)?.message ?? err)}`);
    return 1;
  }
}
