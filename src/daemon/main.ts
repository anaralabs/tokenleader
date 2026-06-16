import { promises as fsp } from "node:fs";
import { homedir, hostname } from "node:os";
import path from "node:path";
import { BUILD_SHA, BUILD_VERSION } from "./build-info";
import { CLI_COMMANDS, type CliCommand, runCliCommand } from "./cli";
import { normalizeEndpoint, readEndpointOverride } from "./endpoint-override";
import { log, LOG_FILE } from "./log";
import { loadOrCreateSecret } from "./secret";
import { applyRescanGeneration, ensureStateDir, loadState, saveState } from "./state";
import { tick } from "./tick";
import { DEFAULT_BATCH_SIZE, type TransportOpts } from "./transport";
import { checkForUpdate, pickArch } from "./update";

export interface ResolvedConfig {
  user: string;
  endpoint: string;
  /**
   * Legacy bearer token. No longer sent over the wire — the daemon now
   * presents a per-user TOFU secret loaded from `<stateDir>/secret`.
   * Kept as an optional config field so existing plists with a stale
   * `TOKENLEADER_TOKEN` keep parsing without crashing.
   */
  token?: string;
  /**
   * Optional join code (TOKENLEADER_JOIN, written into the plist by the
   * installer's --join flag). Sent as X-Tokenleader-Join on every ingest
   * POST; the server only consults it on first-claim of a handle and
   * ignores it once the handle's TOFU secret is established.
   */
  join?: string;
  /**
   * Optional company affiliation (TOKENLEADER_COMPANY, written into the
   * plist by the installer's --company flag). Sent raw as
   * X-Tokenleader-Company on ingest POSTs; the server normalizes (lowercase
   * bare hostname) and ignores invalid values.
   */
  company?: string;
  /**
   * Optional one-time link code (TOKENLEADER_LINK, written into the plist
   * by the installer's --link flag). Sent as X-Tokenleader-Link on every
   * ingest POST; the server only consults it when this machine's secret
   * doesn't match an existing device, and the single-use redemption makes
   * the header inert afterwards.
   */
  link?: string;
  intervalSec: number;
  stateDir: string;
  batchSize: number;
  runOnce: boolean;
  // How often to consult the manifest for a new binary. Default 6h.
  updateIntervalSec: number;
  // If true, skip update checks entirely (dev / debugging).
  updateDisabled: boolean;
}

const REQUIRED_ENV = ["TOKENLEADER_USER", "TOKENLEADER_ENDPOINT"] as const;

export class ConfigError extends Error {
  readonly missing: string[];
  constructor(missing: string[]) {
    super(`missing required env: ${missing.join(", ")}`);
    this.missing = missing;
  }
}

export function resolveConfig(env: NodeJS.ProcessEnv): ResolvedConfig {
  const missing: string[] = [];
  for (const key of REQUIRED_ENV) {
    const v = env[key];
    if (!v || v.trim().length === 0) missing.push(key);
  }
  if (missing.length > 0) throw new ConfigError(missing);

  const intervalRaw = env.TOKENLEADER_INTERVAL_SEC;
  const intervalSec = clampInt(parseIntOr(intervalRaw, 300), 5, 24 * 60 * 60);

  const batchRaw = env.TOKENLEADER_BATCH_SIZE;
  const batchSize = clampInt(parseIntOr(batchRaw, DEFAULT_BATCH_SIZE), 1, 10_000);

  const stateDir =
    env.TOKENLEADER_STATE_DIR && env.TOKENLEADER_STATE_DIR.length > 0
      ? env.TOKENLEADER_STATE_DIR
      : path.join(homedir(), ".local", "share", "anara-leaderboard");

  const runOnce = isTruthy(env.TOKENLEADER_RUN_ONCE);

  const rawToken = env.TOKENLEADER_TOKEN;
  const token = rawToken && rawToken.trim().length > 0 ? rawToken.trim() : undefined;

  const rawJoin = env.TOKENLEADER_JOIN;
  const join = rawJoin && rawJoin.trim().length > 0 ? rawJoin.trim() : undefined;

  // Passed raw (trimmed) — the server normalizes and ignores invalid values.
  const rawCompany = env.TOKENLEADER_COMPANY;
  const company = rawCompany && rawCompany.trim().length > 0 ? rawCompany.trim() : undefined;

  const rawLink = env.TOKENLEADER_LINK;
  const link = rawLink && rawLink.trim().length > 0 ? rawLink.trim() : undefined;

  // Auto-update cadence. Default 1h so new builds propagate fast. Floor at
  // 60s so dev/test can crank it down; ceiling at 7d so a typo doesn't
  // strand a daemon forever.
  const updateIntervalSec = clampInt(
    parseIntOr(env.TOKENLEADER_UPDATE_INTERVAL_SEC, 60 * 60),
    60,
    7 * 24 * 60 * 60,
  );
  const updateDisabled = isTruthy(env.TOKENLEADER_UPDATE_DISABLED);

  return {
    user: env.TOKENLEADER_USER!.trim(),
    endpoint: env.TOKENLEADER_ENDPOINT!.trim(),
    ...(token ? { token } : {}),
    ...(join ? { join } : {}),
    ...(company ? { company } : {}),
    ...(link ? { link } : {}),
    intervalSec,
    stateDir,
    batchSize,
    runOnce,
    updateIntervalSec,
    updateDisabled,
  };
}

function parseIntOr(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function clampInt(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function isTruthy(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

// `--version` output: "<BUILD_VERSION> <BUILD_SHA> <platformKey>". Field 1 is
// the bare tag CI's release guard compares against the pushed tag. The
// platform key is the literal darwin-<arch> while the binary is darwin-only.
export function versionLine(): string {
  return `${BUILD_VERSION} ${BUILD_SHA} darwin-${pickArch()}`;
}

/**
 * Make the documented CLI name (`tokenleader link` …) real on machines that
 * only ever auto-update: when this binary is the legacy-named install,
 * ensure a sibling `tokenleader` symlink points at it. Best-effort and
 * never fatal; a no-op under `bun run` (execPath is bun) and when a real
 * file already owns the name.
 */
export async function ensureCliSymlink(execPath: string = process.execPath): Promise<void> {
  try {
    if (path.basename(execPath) !== "anara-leaderboard") return;
    const linkPath = path.join(path.dirname(execPath), "tokenleader");
    try {
      const st = await fsp.lstat(linkPath);
      if (!st.isSymbolicLink()) return;
      if ((await fsp.readlink(linkPath)) === execPath) return;
      await fsp.unlink(linkPath);
    } catch {
      // nothing there — create below
    }
    await fsp.symlink(execPath, linkPath);
  } catch {
    // cosmetic; never block the daemon
  }
}

/** Short hostname → device label ("Krishs-MacBook-Pro.local" →
 *  "krishs-macbook-pro"). Sent as X-Tokenleader-Device; the server treats
 *  it as cosmetic. undefined when nothing survives the cleanup. */
export function deviceLabelFromHost(host: string): string | undefined {
  const s = (host.split(".")[0] ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return s.length > 0 ? s : undefined;
}

/**
 * Boot-time endpoint precedence: `<stateDir>/endpoint` (written by the
 * daemon when the server sent X-Tokenleader-Canonical-Endpoint) wins over
 * TOKENLEADER_ENDPOINT. Malformed or unreadable override files lose to the
 * env so a corrupted file can never brick the daemon.
 */
export async function applyEndpointOverride(cfg: ResolvedConfig): Promise<ResolvedConfig> {
  let override: string | null = null;
  try {
    override = await readEndpointOverride(cfg.stateDir);
  } catch (err: unknown) {
    log.warn("endpoint_override_read_failed", {
      err: String((err as Error)?.message ?? err),
    });
    return cfg;
  }
  if (!override) return cfg;
  if (normalizeEndpoint(override) === normalizeEndpoint(cfg.endpoint)) {
    return cfg;
  }
  log.info("endpoint_override_active", {
    endpoint: override,
    envEndpoint: cfg.endpoint,
  });
  return { ...cfg, endpoint: override };
}

// ±10% jitter on the update-check interval so a fleet doesn't herd ~60MB
// binary downloads onto the server at the same instant.
export function jitterUpdateIntervalMs(
  intervalMs: number,
  rnd: () => number = Math.random,
): number {
  return Math.round(intervalMs * (0.9 + rnd() * 0.2));
}

export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface RunDeps {
  // Test seam: an externally-controlled abort signal short-circuits the loop.
  signal?: AbortSignal;
  // Override for tests.
  tickImpl?: typeof tick;
  loadStateImpl?: typeof loadState;
  saveStateImpl?: typeof saveState;
  loadSecretImpl?: typeof loadOrCreateSecret;
  // Inject the auto-updater for tests so we never hit the network or
  // accidentally process.exit mid-suite.
  checkForUpdateImpl?: typeof checkForUpdate;
  // Source of "now" for the update scheduler. Defaults to Date.now.
  nowImpl?: () => number;
  // First-update delay in ms; default 30_000 (production). Tests use 0.
  initialUpdateDelayMs?: number;
  // Random source 0..1 for the update-interval jitter. Tests pin it.
  random?: () => number;
}

export async function runDaemon(cfg: ResolvedConfig, deps: RunDeps = {}): Promise<void> {
  const tickFn = deps.tickImpl ?? tick;
  const loadFn = deps.loadStateImpl ?? loadState;
  const saveFn = deps.saveStateImpl ?? saveState;
  const loadSecretFn = deps.loadSecretImpl ?? loadOrCreateSecret;
  const updateFn = deps.checkForUpdateImpl ?? checkForUpdate;
  const now = deps.nowImpl ?? Date.now;
  const initialUpdateDelayMs = deps.initialUpdateDelayMs ?? 30_000;
  const rnd = deps.random ?? Math.random;

  await ensureStateDir(cfg.stateDir);
  await ensureCliSymlink();

  const secret = await loadSecretFn(cfg.stateDir);

  const device = deviceLabelFromHost(hostname());
  const transport: TransportOpts = {
    endpoint: cfg.endpoint,
    secret,
    batchSize: cfg.batchSize,
    version: BUILD_VERSION,
    arch: process.arch,
    ...(cfg.join ? { join: cfg.join } : {}),
    ...(cfg.company ? { company: cfg.company } : {}),
    ...(device ? { device } : {}),
    ...(cfg.link ? { link: cfg.link } : {}),
  };

  let state = await loadFn(cfg.stateDir);

  // One-time full rescan (user-prompt backfill). Applied and persisted
  // BEFORE the first tick so a crash mid-tick can never repeat the reset;
  // a state already at the current generation is untouched.
  const rescan = applyRescanGeneration(state);
  if (rescan.changed) {
    state = rescan.state;
    await saveFn(cfg.stateDir, state);
    log.info("rescan_generation_applied", {
      generation: state.rescanGeneration,
      files: Object.keys(state.files).length,
    });
  }

  log.info("daemon_start", {
    user: cfg.user,
    version: BUILD_VERSION,
    buildSha: BUILD_SHA,
    arch: process.arch,
    endpoint: cfg.endpoint,
    intervalSec: cfg.intervalSec,
    stateDir: cfg.stateDir,
    batchSize: cfg.batchSize,
    runOnce: cfg.runOnce,
    knownFiles: Object.keys(state.files).length,
    updateIntervalSec: cfg.updateIntervalSec,
    updateDisabled: cfg.updateDisabled,
    logFile: LOG_FILE,
  });

  const ac = new AbortController();
  const externalSignal = deps.signal;
  if (externalSignal) {
    if (externalSignal.aborted) ac.abort();
    else externalSignal.addEventListener("abort", () => ac.abort(), { once: true });
  }

  const onSig = (sig: string) => {
    log.info("daemon_signal", { sig });
    ac.abort();
  };
  // Note: process.on adds a listener even if we are inside a test;
  // the test passes its own signal so it doesn't depend on signals.
  process.once("SIGINT", () => onSig("SIGINT"));
  process.once("SIGTERM", () => onSig("SIGTERM"));

  // Schedule the first update check ~30s after boot so the very first tick
  // (which on a fresh install can be a big historical-replay POST) doesn't
  // contend with a multi-MB binary download. After that we check every
  // updateIntervalSec. tickInProgress gates the check so we never overlap.
  let tickInProgress = false;
  let tickCount = 0;
  // Emit a health heartbeat (cpu/mem/uptime) every this-many ticks (~1h at the
  // default 5-min interval) so daemon resource use is always on record in the
  // local log — makes a future spin/leak diagnosable from a single grep.
  const HEARTBEAT_EVERY_TICKS = 12;
  // Each cycle's due-interval gets fresh ±10% jitter so a fleet installed
  // at the same minute doesn't herd binary downloads forever.
  let updateIntervalMs = jitterUpdateIntervalMs(cfg.updateIntervalSec * 1000, rnd);
  let lastUpdateCheckAt = now() - updateIntervalMs + initialUpdateDelayMs;

  const maybeCheckForUpdate = async () => {
    if (cfg.updateDisabled || cfg.runOnce) return;
    if (tickInProgress) return; // never overlap with a tick.
    const due = now() - lastUpdateCheckAt >= updateIntervalMs;
    if (!due) return;
    lastUpdateCheckAt = now();
    updateIntervalMs = jitterUpdateIntervalMs(cfg.updateIntervalSec * 1000, rnd);
    try {
      const r = await updateFn({
        log,
        abortSignal: ac.signal,
        endpoint: cfg.endpoint,
        stateDir: cfg.stateDir,
      });
      if (r.updated) {
        // The updater is responsible for spawning launchctl + exiting; if
        // we somehow get here it means a test stub was used. Log and
        // continue — next iteration will pick up the new binary if the
        // restart happens.
        log.info("update_post_swap", { reason: r.reason, newSha: r.newSha });
      }
    } catch (err: unknown) {
      // Belt-and-suspenders — checkForUpdate is supposed to swallow all
      // errors internally, but if it somehow throws we still don't want
      // to crash the daemon.
      log.warn("update_check_threw", {
        err: String((err as Error)?.message ?? err),
      });
    }
  };

  while (!ac.signal.aborted) {
    const start = Date.now();
    tickInProgress = true;
    try {
      const out = await tickFn(state, {
        user: cfg.user,
        stateDir: cfg.stateDir,
        transport,
        signal: ac.signal,
        saveState: saveFn,
      });
      state = out.state;
      log.info("tick_done", {
        scanned: out.result.scannedFiles,
        eligible: out.result.eligibleFiles,
        events: out.result.eventsPosted,
        inserted: out.result.inserted,
        duplicates: out.result.duplicates,
        posted: out.result.posted,
        newFiles: out.result.newFiles,
        elapsedMs: Date.now() - start,
      });
    } catch (err: unknown) {
      log.error("tick_failed", {
        err: String((err as Error)?.message ?? err),
      });
    } finally {
      tickInProgress = false;
    }

    if (cfg.runOnce) {
      log.info("daemon_run_once_exit");
      return;
    }

    // Runs between the tick and the sleep so it never overlaps a tick.
    await maybeCheckForUpdate();

    // Anti-spin guard: if an iteration ran >= one full interval (slow/hung
    // POST, big historical replay, wall clock jumping on wake), do NOT
    // collapse to a short floor — that runs back-to-back ticks and pegs CPU.
    // Always sleep at least a full interval; worst case is one tick per
    // interval, never a sub-interval spin.
    const intervalMs = cfg.intervalSec * 1000;
    const elapsed = Date.now() - start;
    if (elapsed >= intervalMs) {
      log.warn("tick_slow", {
        elapsedMs: elapsed,
        intervalMs,
        hint: "tick exceeded interval; likely slow/hung network POST",
      });
    }
    tickCount += 1;
    if (tickCount % HEARTBEAT_EVERY_TICKS === 0) {
      const mem = process.memoryUsage?.();
      const cpu = process.cpuUsage?.();
      log.info("daemon_health", {
        tickCount,
        uptimeSec: Math.round(process.uptime?.() ?? 0),
        rssMb: mem ? Math.round(mem.rss / (1024 * 1024)) : undefined,
        cpuUserMs: cpu ? Math.round(cpu.user / 1000) : undefined,
        cpuSysMs: cpu ? Math.round(cpu.system / 1000) : undefined,
        knownFiles: Object.keys(state.files).length,
      });
    }
    const sleepMs = elapsed >= intervalMs ? intervalMs : intervalMs - elapsed;
    await sleep(sleepMs, ac.signal);
  }

  log.info("daemon_shutdown");
}

/** Top-level CLI usage. Printed for `tokenleader`, `tokenleader help`,
 *  `-h/--help`, and unknown commands. The background daemon is managed by
 *  launchd (the install script sets it up), so the commands a human runs by
 *  hand are just the device subcommands. */
export function printCliUsage(err?: string): void {
  const out = err ? console.error : console.log;
  if (err) console.error(`tokenleader: ${err}\n`);
  out(`tokenleader — team token-usage leaderboard (daemon + CLI)

Usage:
  tokenleader <command>

Commands:
  link              Mint a one-time code to add another machine to your handle
  devices           List the machines posting under your handle
  revoke <id>       Revoke a machine (lost / stolen / retired)
  login-cursor      Save Cursor dashboard session (--auto on macOS, or paste token)
  sync-cursor       Backfill official Cursor usage from the dashboard API
  --version, -v     Print the daemon version

The background daemon is installed and run for you by the install script
(launchd) — you don't start it by hand. Re-run the install one-liner from
your leaderboard's dashboard to (re)install it.`);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  // Handled before resolveConfig so it works with no env set;
  // CI's release guard parses field 1 of this line.
  if (argv.includes("--version") || argv.includes("-v")) {
    console.log(versionLine());
    return 0;
  }

  // Multi-device subcommands (link/devices/revoke) run in the user's shell,
  // not under launchd — they resolve user/endpoint from env or the plist.
  const sub = argv[0];
  if (sub && (CLI_COMMANDS as readonly string[]).includes(sub)) {
    return runCliCommand(sub as CliCommand, argv.slice(1));
  }

  // Friendly top-level usage. The same binary is BOTH the launchd-run daemon
  // and the user-facing CLI, so we must tell them apart: launchd always sets
  // TOKENLEADER_USER (from the plist), so a bare invocation WITHOUT it is a
  // human who typed `tokenleader` — show usage instead of a daemon config
  // error. An explicit help flag always shows usage; any other unrecognized
  // argument is a usage error.
  if (sub === "help" || argv.includes("-h") || argv.includes("--help")) {
    printCliUsage();
    return 0;
  }
  if (sub) {
    printCliUsage(`unknown command: ${sub}`);
    return 1;
  }
  if (!process.env.TOKENLEADER_USER) {
    printCliUsage();
    return 0;
  }

  let cfg: ResolvedConfig;
  try {
    cfg = resolveConfig(process.env);
  } catch (err: unknown) {
    if (err instanceof ConfigError) {
      log.error("config_error", { missing: err.missing });
      return 1;
    }
    log.error("config_unknown", {
      err: String((err as Error)?.message ?? err),
    });
    return 1;
  }

  try {
    cfg = await applyEndpointOverride(cfg);
    await runDaemon(cfg);
    return 0;
  } catch (err: unknown) {
    log.error("daemon_fatal", {
      err: String((err as Error)?.message ?? err),
    });
    return 1;
  }
}

// Run if invoked as the entry script. `import.meta.main` is Bun-specific.
if ((import.meta as unknown as { main?: boolean }).main) {
  main().then((code) => process.exit(code));
}
