// Typed server configuration: every TOKENLEADER_* var is parsed here and
// mirrored row-for-row in .env.example (config.test.ts enforces parity).
// Every var is OPTIONAL — zero-config boot. Malformed values are fatal
// (ConfigError); out-of-range numerics clamp and warn.

import { readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import path from "node:path";
import { normalizeCompany } from "./company";

export class ConfigError extends Error {}

export interface ServerConfig {
  port: number;
  /** Bind address for Bun.serve. */
  host: string;
  /** Root dir for all server persistent state (db + binary cache). */
  dataDir: string;
  dbPath: string;
  binaryCacheDir: string;
  /** Canonical public URL; unset → inferred per-request from headers. */
  serverUrl?: string;
  /** Display identity (dashboard header, installer banner). Never in paths. */
  teamName?: string;
  adminToken?: string;
  /** Viewer auth for GET /, /stats, /stats/*. Unset = dashboard public. */
  dashboardToken?: string;
  /** Bearer for /api/v1/*. Unset = follows the dashboard posture. */
  apiToken?: string;
  /** First-claim gate for /ingest (X-Tokenleader-Join). Unset = open TOFU. */
  joinToken?: string;
  /** `owner/repo` the BinaryMirror pulls from. No default until cutover. */
  ghRepo?: string;
  ghToken?: string;
  mirrorIntervalSec: number;
  cursorToken?: string;
  cursorIntervalSec: number;
  /** Lowercased email → handle map. Missing/empty with cursorToken set →
   *  the cursor mirror stays off (warned, non-fatal). */
  cursorUserMap?: Readonly<Record<string, string>>;
  /** Normalized domain → domain rewrites applied to X-Tokenleader-Company
   *  at ingest. Operator lever for typo'd self-reported affiliations
   *  ("sync.labs" → "sync.so") without touching teammate machines. */
  companyAliases?: Readonly<Record<string, string>>;
}

export interface ConfigLogger {
  warn: (msg: string) => void;
}

function parseIntOr(raw: string | undefined, fallback: number): number {
  if (!raw || !/^[0-9]+$/.test(raw.trim())) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function clampInt(name: string, n: number, lo: number, hi: number, log: ConfigLogger): number {
  if (n < lo || n > hi) {
    const clamped = n < lo ? lo : hi;
    log.warn(`[tokenleader] ${name}=${n} out of range [${lo}, ${hi}]; using ${clamped}`);
    return clamped;
  }
  return n;
}

function nonEmpty(raw: string | undefined): string | undefined {
  const v = raw?.trim();
  return v && v.length > 0 ? v : undefined;
}

/**
 * TOKENLEADER_DATA_DIR default: darwin → ~/Library/Application Support,
 * linux → $XDG_DATA_HOME else ~/.local/share. Docker sets it explicitly.
 */
export function resolveDataDir(env: NodeJS.ProcessEnv, os: string = platform()): string {
  const explicit = nonEmpty(env.TOKENLEADER_DATA_DIR);
  if (explicit) return path.resolve(explicit);
  if (os === "darwin") {
    return path.join(homedir(), "Library", "Application Support", "tokenleader");
  }
  const xdg = nonEmpty(env.XDG_DATA_HOME);
  if (xdg) return path.join(path.resolve(xdg), "tokenleader");
  return path.join(homedir(), ".local", "share", "tokenleader");
}

/** Handles allowed on the leaderboard without a warning (ingest parity). */
const HANDLE_SAFE_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Cursor email→handle map. `_FILE` wins entirely over inline (no merge).
 * Keys are lowercased; values must be non-empty ≤64 chars after trim
 * (fatal otherwise); chars outside [A-Za-z0-9._-] only warn.
 */
export function parseCursorUserMap(
  env: NodeJS.ProcessEnv,
  log: ConfigLogger,
): Readonly<Record<string, string>> | undefined {
  const file = nonEmpty(env.TOKENLEADER_CURSOR_USER_MAP_FILE);
  const inline = nonEmpty(env.TOKENLEADER_CURSOR_USER_MAP);
  let raw: string;
  let source: string;
  if (file) {
    source = `TOKENLEADER_CURSOR_USER_MAP_FILE (${file})`;
    try {
      raw = readFileSync(file, "utf8");
    } catch (err) {
      throw new ConfigError(`${source} unreadable: ${String((err as Error)?.message ?? err)}`);
    }
  } else if (inline) {
    source = "TOKENLEADER_CURSOR_USER_MAP";
    raw = inline;
  } else {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`${source} is not valid JSON: ${String((err as Error)?.message ?? err)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigError(`${source} must be a JSON object of "email": "handle"`);
  }
  const out: Record<string, string> = {};
  for (const [email, handle] of Object.entries(parsed)) {
    if (typeof handle !== "string") {
      throw new ConfigError(`${source}: value for "${email}" must be a string`);
    }
    const trimmed = handle.trim();
    if (trimmed.length === 0) {
      throw new ConfigError(`${source}: value for "${email}" is empty`);
    }
    if (trimmed.length > 64) {
      throw new ConfigError(`${source}: value for "${email}" exceeds 64 chars after trim`);
    }
    if (!HANDLE_SAFE_RE.test(trimmed)) {
      log.warn(
        `[tokenleader] cursor user map: handle "${trimmed}" has chars outside [A-Za-z0-9._-]`,
      );
    }
    out[email.toLowerCase()] = trimmed;
  }
  return out;
}

export function parseServerConfig(
  env: NodeJS.ProcessEnv,
  log: ConfigLogger = console,
): ServerConfig {
  const portRaw = nonEmpty(env.PORT);
  const port = portRaw === undefined ? 8787 : Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`PORT must be an integer in [1, 65535], got "${portRaw}"`);
  }

  const dataDir = resolveDataDir(env);
  const dbPath = nonEmpty(env.TOKENLEADER_DB)
    ? path.resolve(env.TOKENLEADER_DB!.trim())
    : path.join(dataDir, "tokenleader.sqlite");
  const binaryCacheDir = nonEmpty(env.TOKENLEADER_BINARY_CACHE_DIR)
    ? path.resolve(env.TOKENLEADER_BINARY_CACHE_DIR!.trim())
    : path.join(dataDir, "binaries");

  const serverUrl = nonEmpty(env.TOKENLEADER_SERVER_URL)?.replace(/\/+$/, "");

  const mirrorIntervalSec = clampInt(
    "TOKENLEADER_MIRROR_INTERVAL_SEC",
    parseIntOr(env.TOKENLEADER_MIRROR_INTERVAL_SEC, 900),
    60,
    86_400,
    log,
  );
  const cursorIntervalSec = clampInt(
    "TOKENLEADER_CURSOR_INTERVAL_SEC",
    parseIntOr(env.TOKENLEADER_CURSOR_INTERVAL_SEC, 900),
    60,
    86_400,
    log,
  );

  const cursorToken = nonEmpty(env.TOKENLEADER_CURSOR_TOKEN);
  const cursorUserMap = parseCursorUserMap(env, log);
  // Non-fatal: fielded servers run token-without-map, and a throw here
  // would crash-loop them under launchd KeepAlive on a binary swap.
  if (cursorToken && (!cursorUserMap || Object.keys(cursorUserMap).length === 0)) {
    log.warn(
      "[tokenleader] CURSOR MIRROR DISABLED (TOKENLEADER_CURSOR_TOKEN is set but no user map resolved): set TOKENLEADER_CURSOR_USER_MAP (inline JSON) or TOKENLEADER_CURSOR_USER_MAP_FILE; Cursor team usage will not be mirrored.",
    );
  }

  const companyAliases = parseCompanyAliases(env, log);

  const teamName = nonEmpty(env.TOKENLEADER_TEAM_NAME);
  const adminToken = nonEmpty(env.TOKENLEADER_ADMIN_TOKEN);
  const dashboardToken = nonEmpty(env.TOKENLEADER_DASHBOARD_TOKEN);
  const apiToken = nonEmpty(env.TOKENLEADER_API_TOKEN);
  const joinToken = nonEmpty(env.TOKENLEADER_JOIN_TOKEN);
  const ghRepo = nonEmpty(env.TOKENLEADER_GH_REPO);
  const ghToken = nonEmpty(env.TOKENLEADER_GH_TOKEN);

  const cfg: ServerConfig = {
    port,
    host: nonEmpty(env.TOKENLEADER_HOST) ?? "0.0.0.0",
    dataDir,
    dbPath,
    binaryCacheDir,
    mirrorIntervalSec,
    cursorIntervalSec,
  };
  if (serverUrl !== undefined) cfg.serverUrl = serverUrl;
  if (teamName !== undefined) cfg.teamName = teamName;
  if (adminToken !== undefined) cfg.adminToken = adminToken;
  if (dashboardToken !== undefined) cfg.dashboardToken = dashboardToken;
  if (apiToken !== undefined) cfg.apiToken = apiToken;
  if (joinToken !== undefined) cfg.joinToken = joinToken;
  if (ghRepo !== undefined) cfg.ghRepo = ghRepo;
  if (ghToken !== undefined) cfg.ghToken = ghToken;
  if (cursorToken !== undefined) cfg.cursorToken = cursorToken;
  if (cursorUserMap !== undefined) cfg.cursorUserMap = cursorUserMap;
  if (companyAliases !== undefined) cfg.companyAliases = companyAliases;
  return cfg;
}

/** TOKENLEADER_COMPANY_ALIASES: inline JSON object of domain → domain
 *  rewrites. Both sides run through normalizeCompany; entries that don't
 *  normalize are dropped with a warn. Empty/absent → undefined. */
export function parseCompanyAliases(
  env: NodeJS.ProcessEnv,
  log: ConfigLogger,
): Readonly<Record<string, string>> | undefined {
  const raw = nonEmpty(env.TOKENLEADER_COMPANY_ALIASES);
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(
      `TOKENLEADER_COMPANY_ALIASES is not valid JSON: ${String((err as Error)?.message ?? err)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigError('TOKENLEADER_COMPANY_ALIASES must be a JSON object of "from": "to"');
  }
  const out: Record<string, string> = {};
  for (const [from, to] of Object.entries(parsed)) {
    const f = normalizeCompany(from);
    const t = typeof to === "string" ? normalizeCompany(to) : null;
    if (f === null || t === null) {
      log.warn(
        `[tokenleader] company alias ${JSON.stringify(from)} -> ${JSON.stringify(to)} dropped (not domain-shaped)`,
      );
      continue;
    }
    out[f] = t;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** One boot echo per resolved knob — the operator's "what am I running". */
export function echoConfig(cfg: ServerConfig): void {
  const mirrorOn = Boolean(cfg.ghRepo && cfg.ghToken);
  console.log(`[tokenleader] dataDir=${cfg.dataDir}`);
  console.log(`[tokenleader] db=${cfg.dbPath}`);
  console.log(`[tokenleader] binaryCacheDir=${cfg.binaryCacheDir}`);
  console.log(
    `[tokenleader] serverUrl=${cfg.serverUrl ?? "(inferred — set TOKENLEADER_SERVER_URL in production)"}`,
  );
  if (cfg.teamName) console.log(`[tokenleader] teamName=${cfg.teamName}`);
  console.log(
    `[tokenleader] binaryMirror=${
      mirrorOn
        ? `on repo=${cfg.ghRepo} auth=token (every ${cfg.mirrorIntervalSec}s)`
        : "off(TOKENLEADER_GH_REPO and/or TOKENLEADER_GH_TOKEN unset)"
    }`,
  );
  const cursorOn =
    cfg.cursorToken && cfg.cursorUserMap && Object.keys(cfg.cursorUserMap).length > 0;
  console.log(
    `[tokenleader] cursorMirror=${cursorOn ? `on (every ${cfg.cursorIntervalSec}s)` : "off"}`,
  );
  console.log(`[tokenleader] dashboard=${cfg.dashboardToken ? "token-gated" : "public"}`);
  console.log(
    `[tokenleader] apiV1=${
      cfg.apiToken ? "own-token" : cfg.dashboardToken ? "inherits-dashboard-token" : "open"
    }`,
  );
  console.log(
    `[tokenleader] ingest=${cfg.joinToken ? "join-token-gated first claims" : "open TOFU"}`,
  );
  console.log(
    `[tokenleader] adminToken=${cfg.adminToken ? "from-env" : "unset (/admin/clear disabled)"}`,
  );
}
