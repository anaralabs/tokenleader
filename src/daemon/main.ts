import { promises as fsp } from "node:fs";
import { homedir, hostname } from "node:os";
import path from "node:path";
import type { CheckinBody, DaemonDirective } from "../types";
import { BUILD_SHA, BUILD_VERSION } from "./build-info";
import { CLI_COMMANDS, type CliCommand, runCliCommand } from "./cli";
import { executeDirective } from "./directives";
import { normalizeEndpoint, readEndpointOverride } from "./endpoint-override";
import {
  clearUpdateMarker,
  createHeartbeat,
  journalExit,
  journalTail,
  readUpdateMarker,
} from "./heartbeat";
import { log, LOG_DIR, LOG_FILE } from "./log";
import { healInstalledPlist } from "./plist-heal";
import { loadOrCreateSecret } from "./secret";
import { applyRescanGeneration, ensureStateDir, loadState, saveState } from "./state";
import { tick } from "./tick";
import { DEFAULT_BATCH_SIZE, postCheckin, postDirectiveAck, type TransportOpts } from "./transport";
import { checkForUpdate, pickArch, RESTART_EXIT_CODE } from "./update";
import { ensureWatchdogInstalled, runWatchdog, type WatchdogInstallStatus } from "./watchdog";

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

  // Ceiling matches the server's per-POST cap (MAX_EVENTS_PER_REQUEST =
  // DEFAULT_BATCH_SIZE): an oversized batch draws a 413, which is
  // non-retriable, so a larger env value would wedge the daemon in a
  // permanent resend loop of the same too-big batch.
  const batchRaw = env.TOKENLEADER_BATCH_SIZE;
  const batchSize = clampInt(parseIntOr(batchRaw, DEFAULT_BATCH_SIZE), 1, DEFAULT_BATCH_SIZE);

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
  // Heartbeat + directive seams (same reason).
  postCheckinImpl?: typeof postCheckin;
  executeDirectiveImpl?: typeof executeDirective;
  // Source of "now" for the update scheduler. Defaults to Date.now.
  nowImpl?: () => number;
  // First-update delay in ms; default 30_000 (production). Tests use 0.
  initialUpdateDelayMs?: number;
  // Random source 0..1 for the update-interval jitter. Tests pin it.
  random?: () => number;
  // Watchdog install outcome from main(), reported in checkins.
  watchdogStatus?: WatchdogInstallStatus;
  // Deliberate self-exit seam (drift/recycle); default journals + exit(75).
  exitImpl?: (code: number) => void;
}

// L1 drift exit: a between-tick sleep that overshoots by this much means the
// runtime's timers are degrading (or the machine slept — in which case a
// fresh process at wake is exactly the churn-reset we want). Deliberate,
// journaled, respawned by KeepAlive.
export const DRIFT_EXIT_MIN_OVERSHOOT_MS = 30 * 60_000;

// L2 recycling: hygiene against slow runtime rot, demoted to 7d + persisted
// per-machine jitter (0-24h) so a fleet never recycles in lockstep.
export const RECYCLE_AFTER_MS = 7 * 24 * 60 * 60_000;
export const RECYCLE_JITTER_MAX_MS = 24 * 60 * 60_000;

async function recycleJitterMs(stateDir: string, rnd: () => number): Promise<number> {
  const p = path.join(stateDir, "recycle-jitter");
  try {
    const v = Number.parseInt(await fsp.readFile(p, "utf8"), 10);
    if (Number.isFinite(v) && v >= 0 && v <= RECYCLE_JITTER_MAX_MS) return v;
  } catch {
    // first boot — mint below
  }
  const v = Math.floor(rnd() * RECYCLE_JITTER_MAX_MS);
  try {
    await fsp.writeFile(p, String(v));
  } catch {
    // unpersisted jitter re-mints next boot; harmless
  }
  return v;
}

export async function runDaemon(cfg: ResolvedConfig, deps: RunDeps = {}): Promise<void> {
  const tickFn = deps.tickImpl ?? tick;
  const loadFn = deps.loadStateImpl ?? loadState;
  const saveFn = deps.saveStateImpl ?? saveState;
  const loadSecretFn = deps.loadSecretImpl ?? loadOrCreateSecret;
  const updateFn = deps.checkForUpdateImpl ?? checkForUpdate;
  const checkinFn = deps.postCheckinImpl ?? postCheckin;
  const directiveFn = deps.executeDirectiveImpl ?? executeDirective;
  const now = deps.nowImpl ?? Date.now;
  const initialUpdateDelayMs = deps.initialUpdateDelayMs ?? 30_000;
  const rnd = deps.random ?? Math.random;

  await ensureStateDir(cfg.stateDir);
  await ensureCliSymlink();

  const secret = await loadSecretFn(cfg.stateDir);

  // Liveness contract, inner half: the heartbeat file the watchdog stats.
  // First write happens before any slow work so a fresh boot is immediately
  // distinguishable from the wedge it may have replaced.
  const hb = createHeartbeat(cfg.stateDir, BUILD_VERSION);
  hb.progress();
  const bootAt = Date.now();

  // Debris sweep from a previous incarnation: a crash mid-download leaves a
  // partial .new (harmless, but confusing) and a stale update marker (would
  // wrongly widen the watchdog's deadline).
  try {
    await fsp.unlink(`${process.execPath}.new`);
  } catch {
    // none — the normal case
  }
  if (readUpdateMarker(cfg.stateDir)) clearUpdateMarker(cfg.stateDir);

  const device = deviceLabelFromHost(hostname());
  const transport: TransportOpts = {
    endpoint: cfg.endpoint,
    secret,
    batchSize: cfg.batchSize,
    version: BUILD_VERSION,
    arch: process.arch,
    onProgress: () => hb.progress(),
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

  // Update scheduling. The FIRST check runs before the first tick — a binary
  // that crashes in its tick path still gets a self-update window, which is
  // the difference between a bad release self-healing and a fleet reinstall
  // (docs/resilience.md, update-path hardening). After that, every
  // updateIntervalSec with fresh ±10% jitter per cycle so a fleet installed
  // at the same minute doesn't herd binary downloads forever.
  let tickInProgress = false;
  let tickCount = 0;
  // Emit a health heartbeat (cpu/mem/uptime) every this-many ticks (~1h at the
  // default 5-min interval) so daemon resource use is always on record in the
  // local log — makes a future spin/leak diagnosable from a single grep.
  const HEARTBEAT_EVERY_TICKS = 12;
  let updateIntervalMs = jitterUpdateIntervalMs(cfg.updateIntervalSec * 1000, rnd);
  let lastUpdateCheckAt = now() - updateIntervalMs;
  let lastUpdateResult: string | null = null;

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
      lastUpdateResult = r.updated ? "updated" : (r.reason ?? null);
      if (r.updated) {
        // The updater is responsible for exiting the process (launchd
        // respawns the swapped binary); if we somehow get here it means a
        // test stub was used. Log and continue — next iteration will pick
        // up the new binary if the restart happens.
        log.info("update_post_swap", { reason: r.reason, newSha: r.newSha });
      }
    } catch (err: unknown) {
      // Belt-and-suspenders — checkForUpdate is supposed to swallow all
      // errors internally, but if it somehow throws we still don't want
      // to crash the daemon.
      lastUpdateResult = "threw";
      log.warn("update_check_threw", {
        err: String((err as Error)?.message ?? err),
      });
    }
  };

  const deliberateExit = (reason: string) => {
    hb.progress();
    journalExit(cfg.stateDir, reason, RESTART_EXIT_CODE);
    log.info("daemon_deliberate_exit", { reason, code: RESTART_EXIT_CODE });
    (deps.exitImpl ?? process.exit)(RESTART_EXIT_CODE);
  };

  const recycleJitter = await recycleJitterMs(cfg.stateDir, rnd);
  let lastDriftMs = 0;

  const buildCheckinBody = (): CheckinBody => {
    const snap = hb.snapshot();
    const ws = deps.watchdogStatus;
    return {
      uptime_s: Math.round((Date.now() - bootAt) / 1000),
      tick_seq: snap.tick_seq,
      consec_failures: snap.consec_failures,
      last_error: snap.last_error,
      last_update_result: lastUpdateResult,
      disk_free_mb: null,
      drift_ms: lastDriftMs,
      heartbeat_write_failures: hb.writeFailures,
      exit_journal_tail: journalTail(cfg.stateDir, Date.now() - 24 * 60 * 60_000).slice(-20),
      watchdog_installed:
        ws === undefined || ws === "skipped" ? null : ws === "installed" || ws === "already",
    };
  };

  // First update check, before the first tick.
  await maybeCheckForUpdate();

  while (!ac.signal.aborted) {
    // L2 recycling: between ticks only, never while an update is in flight.
    if (
      Date.now() - bootAt > RECYCLE_AFTER_MS + recycleJitter &&
      !cfg.runOnce &&
      readUpdateMarker(cfg.stateDir) === null
    ) {
      deliberateExit("recycle");
    }

    const start = Date.now();
    tickInProgress = true;
    let directive: DaemonDirective | undefined;
    let tickOk = false;
    let tickErr: string | undefined;
    hb.tickStart();
    try {
      const out = await tickFn(state, {
        user: cfg.user,
        stateDir: cfg.stateDir,
        transport,
        signal: ac.signal,
        loadState: loadFn,
        saveState: saveFn,
        progress: () => hb.progress(),
      });
      state = out.state;
      directive = out.result.directive;
      tickOk = out.result.posted || out.result.eventsPosted === 0;
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
      if (!tickOk) tickErr = "post_failed";
    } catch (err: unknown) {
      tickErr = String((err as Error)?.message ?? err);
      log.error("tick_failed", { err: tickErr });
    } finally {
      tickInProgress = false;
      hb.tickEnd(tickOk, tickErr);
    }

    if (cfg.runOnce) {
      log.info("daemon_run_once_exit");
      return;
    }

    // Checkin after EVERY tick — success, quiet, or failure. A sick-but-alive
    // daemon (403 loop, parse loop) previously went server-dark exactly when
    // it mattered; the status body is what lets the fleet classifier tell
    // healthy/degraded/crash-looping apart (docs/resilience.md).
    if (!ac.signal.aborted) {
      const ci = await checkinFn(cfg.user, transport, ac.signal, buildCheckinBody());
      directive ??= ci.directive;
    }

    // Runs between the tick and the sleep so it never overlaps a tick.
    await maybeCheckForUpdate();

    // A directive runs LAST: if the update path already swapped + exited,
    // the process is gone and the directive (usually "restart") is moot.
    if (directive && !ac.signal.aborted) {
      const d = directive;
      await directiveFn(d, {
        log,
        endpoint: cfg.endpoint,
        secret,
        user: cfg.user,
        stateDir: cfg.stateDir,
        ack: async (result, detail) => {
          await postDirectiveAck(
            cfg.user,
            { id: d.id, result, ...(detail ? { detail } : {}), executed_by: "daemon" },
            transport,
            ac.signal,
          );
        },
      });
    }

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
    const sleepStart = Date.now();
    await sleep(sleepMs, ac.signal);

    // L1 drift exit: this sleep resolving grossly late means the runtime's
    // timers are degrading (the wedge precursor) — or the machine slept, in
    // which case a fresh process at wake is exactly the churn-reset we want.
    // Either way: journaled deliberate exit, KeepAlive respawn, no data loss.
    const overshoot = Date.now() - sleepStart - sleepMs;
    lastDriftMs = Math.max(0, overshoot);
    if (!ac.signal.aborted && overshoot > Math.max(3 * intervalMs, DRIFT_EXIT_MIN_OVERSHOOT_MS)) {
      log.warn("clock_drift", { sleepMs, overshootMs: overshoot });
      deliberateExit("clock_drift");
    }
  }

  journalExit(cfg.stateDir, "shutdown", 0);
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

  // The out-of-process liveness checker (docs/resilience.md). Runs under its
  // own launchd label, lives for seconds, always exits 0 — a non-zero exit
  // would only add launchd log spam with no one to react to it.
  if (sub === "watchdog") {
    if (process.platform !== "darwin") return 0;
    const stateDir =
      process.env.TOKENLEADER_STATE_DIR?.trim() ||
      path.join(homedir(), ".local", "share", "anara-leaderboard");
    try {
      const r = await runWatchdog({ log, stateDir, logDir: LOG_DIR });
      log.debug("watchdog_run_done", { action: r.action, staleRuns: r.staleRuns });
    } catch (err: unknown) {
      log.warn("watchdog_run_failed", { err: String((err as Error)?.message ?? err) });
    }
    return 0;
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

  // One-shot per boot: repair a strand-prone LaunchAgent plist from an older
  // install so this daemon can never again stay dead after a clean exit, and
  // install/refresh the watchdog pair. Only the real launchd entrypoint runs
  // these (runDaemon, used by tests, never does), so unit tests and the CI
  // update-gate (TOKENLEADER_WATCHDOG_DISABLED=1) can't touch a developer's
  // or runner's launchd.
  let watchdogStatus: WatchdogInstallStatus = "skipped";
  if (process.platform === "darwin") {
    await healInstalledPlist(log);
    // Heartbeat dir + first write happen inside runDaemon before the first
    // tick; the watchdog treats a missing heartbeat as observe-only, so the
    // ordering slack here is safe.
    try {
      await ensureStateDir(cfg.stateDir);
      watchdogStatus = ensureWatchdogInstalled(log, cfg.stateDir);
    } catch (err: unknown) {
      log.warn("watchdog_install_threw", { err: String((err as Error)?.message ?? err) });
      watchdogStatus = "failed";
    }
  }

  try {
    cfg = await applyEndpointOverride(cfg);
    await runDaemon(cfg, { watchdogStatus });
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
