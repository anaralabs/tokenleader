// The out-of-process half of the liveness contract (docs/resilience.md).
//
// This runs as `anara-leaderboard watchdog` under its OWN launchd label
// (sh.anara.leaderboard.watchdog, StartInterval 120 + RunAtLoad, never
// KeepAlive), spawned fresh each interval and alive for seconds — a process
// that short cannot accumulate the sleep-churn that killed the daemon's Bun
// timers in the 2026-07-06 incident. launchd guarantees single-instance and
// DROPS firings that collide with a running instance or land during sleep;
// that drop rule is what makes "heartbeat unchanged across N consecutive
// firings" a measure of AWAKE time with no clock arithmetic at all.
//
// Iron rules encoded here:
// - Kill only the pid recorded in the heartbeat, and only while launchd
//   reports that same pid live for the daemon label (identity anchoring —
//   PID reuse and rolled-back daemons are unkillable by construction).
// - A missing/corrupt heartbeat is observe-only (pre-0.6 daemon, fresh
//   install, rollback).
// - Local decisions before network; every network call is curl with tight
//   timeouts (Bun fetch is banned here entirely).
// - Forensics BEFORE the first signal — evidence first, then the cure.

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import path from "node:path";
import type { WatchdogCheckinBody } from "../types";
import { BUILD_VERSION } from "./build-info";
import { parsePlistEnv } from "./cli";
import { endpointOverridePath, isAcceptableEndpoint, normalizeEndpoint } from "./endpoint-override";
import {
  readHeartbeat,
  readJournal,
  readUpdateMarker,
  UPDATE_GRACE_MS,
  UPDATE_MARKER_IGNORE_MS,
} from "./heartbeat";
import type { Logger } from "./log";
import { deviceLabelFromHost } from "./transport";

export const DAEMON_LABEL = "sh.anara.leaderboard";
export const WATCHDOG_LABEL = "sh.anara.leaderboard.watchdog";
export const WATCHDOG_INTERVAL_SEC = 120;

// Staleness threshold in watchdog firings. 8 runs at 120s ≈ 16 min awake at
// the default 5-min tick (3× tick + margin); scaled up for longer custom
// tick intervals so a slow-cadence daemon is never punished for its config.
export const STALE_RUNS_MIN = 8;
export function staleRunsFor(tickIntervalSec: number): number {
  return Math.max(STALE_RUNS_MIN, Math.ceil((3 * tickIntervalSec) / WATCHDOG_INTERVAL_SEC));
}
// Update grace: a fresh update marker widens the deadline (single-sourced
// from the marker's own constant so the two sides can't drift).
export const UPDATE_GRACE_RUNS = Math.ceil(UPDATE_GRACE_MS / 1000 / WATCHDOG_INTERVAL_SEC);

// Fuse (respawns, not kills — kill-based fuses are dead code at ≥17-min kill
// spacing): ≥3 unexplained daemon respawns inside 90 min without heartbeat
// recovery latches `degraded`; 30 min of fresh heartbeats unlatches.
export const FUSE_RESPAWNS = 3;
export const FUSE_WINDOW_MS = 90 * 60_000;
export const UNLATCH_FRESH_MS = 30 * 60_000;
// A journal entry within this window of an observed pid change explains it.
const JOURNAL_EXPLAIN_SLOP_MS = 5 * 60_000;

// Rollback backstop: ≥3 crash-classified respawns of a freshly-swapped
// binary (execPath mtime within this window, .prev present) restores .prev.
const FRESH_SWAP_WINDOW_MS = 60 * 60_000;

const SPOOL_DIR = "spool";
const SPOOL_MAX_FILES = 12;
const LOG_TAIL_BYTES = 64 * 1024;
const SAMPLE_SECONDS = 3;
const CURL_ARGS = ["--max-time", "10", "--connect-timeout", "5", "-sS"];
/** Consecutive pid-less firings before the loaded-label kickstart heal fires —
 *  one firing can be a KeepAlive ThrottleInterval respawn race; two (≥240s
 *  apart) cannot. */
export const KICKSTART_NO_PID_RUNS = 2;

export interface WatchdogState {
  schema: 1;
  /** Signature of the last heartbeat observed (tick_seq:wall_ms:pid). */
  lastSig: string | null;
  /** Consecutive firings with an unchanged heartbeat. */
  consecUnchanged: number;
  /** Wall ts when the heartbeat last changed (fresh-streak anchor). */
  freshSince: number | null;
  /** Pid we SIGTERMed while stale; SIGKILL next run if still alive+stale. */
  termedPid: number | null;
  /** Label pid observed last run (respawn detection). */
  lastLabelPid: number | null;
  /** Heartbeat author pid observed last run — respawn evidence that survives
   *  label-pid sampling gaps (every boot writes a heartbeat immediately). */
  lastHbPid: number | null;
  /** Wall ts of our previous firing (anchors the journal-explain window). */
  lastRunAt: number | null;
  /** Timestamps of unexplained respawns (pruned to FUSE_WINDOW_MS). */
  respawns: number[];
  /** Timestamps of our kills (reporting only). */
  kills: number[];
  /** Consecutive firings with no daemon pid (loaded-label kickstart gate). */
  noPidRuns: number;
  degraded: boolean;
  degradedAt: number | null;
  rolledBackAt: number | null;
}

export function emptyWatchdogState(): WatchdogState {
  return {
    schema: 1,
    lastSig: null,
    consecUnchanged: 0,
    freshSince: null,
    termedPid: null,
    lastLabelPid: null,
    lastHbPid: null,
    lastRunAt: null,
    respawns: [],
    kills: [],
    noPidRuns: 0,
    degraded: false,
    degradedAt: null,
    rolledBackAt: null,
  };
}

export const WATCHDOG_STATE_FILE = "watchdog.json";

/** Corrupt state counts as one stale observation already recorded —
 *  fail-closed toward detection, still needing confirming runs. */
export function loadWatchdogState(stateDir: string): { state: WatchdogState; corrupt: boolean } {
  try {
    const raw = readFileSync(path.join(stateDir, WATCHDOG_STATE_FILE), "utf8");
    const v = JSON.parse(raw) as WatchdogState;
    if (v.schema !== 1 || typeof v.consecUnchanged !== "number") throw new Error("schema");
    // Fields added after 0.6.0 ship as absent in older state files — not
    // corruption, just a younger writer.
    v.lastHbPid ??= null;
    v.lastRunAt ??= null;
    v.noPidRuns ??= 0;
    return { state: v, corrupt: false };
  } catch (err: unknown) {
    const missing =
      (err as NodeJS.ErrnoException)?.code === "ENOENT" ||
      String((err as Error)?.message).includes("no such file");
    return { state: emptyWatchdogState(), corrupt: !missing };
  }
}

export function saveWatchdogState(stateDir: string, state: WatchdogState): void {
  const file = path.join(stateDir, WATCHDOG_STATE_FILE);
  try {
    writeFileSync(`${file}.new`, JSON.stringify(state));
    renameSync(`${file}.new`, file);
  } catch {
    // Unpersistable state degrades detection by one run, never operation.
  }
}

// --- seams -------------------------------------------------------------------

export interface Exec {
  (cmd: string, args: string[], timeoutMs?: number): { ok: boolean; stdout: string; err?: string };
}

export function defaultExec(cmd: string, args: string[], timeoutMs = 10_000): ReturnType<Exec> {
  try {
    const r = spawnSync(cmd, args, { timeout: timeoutMs, encoding: "utf8" });
    if (r.error) return { ok: false, stdout: "", err: r.error.message };
    if (r.status !== 0) {
      return {
        ok: false,
        stdout: r.stdout ?? "",
        err: `exit ${r.status}: ${(r.stderr ?? "").slice(0, 300)}`,
      };
    }
    return { ok: true, stdout: r.stdout ?? "" };
  } catch (err: unknown) {
    return { ok: false, stdout: "", err: String((err as Error)?.message ?? err) };
  }
}

export interface WatchdogDeps {
  log: Logger;
  stateDir: string;
  logDir: string;
  home?: string;
  exec?: Exec;
  now?: () => number;
  /** kill(2) seam; default process.kill. */
  kill?: (pid: number, sig: NodeJS.Signals) => void;
  /** Skip the gui-domain assert (tests). */
  skipDomainAssert?: boolean;
  env?: NodeJS.ProcessEnv;
}

// --- context resolution ------------------------------------------------------
// The watchdog's plist carries no identity env: everything resolves from the
// daemon's plist file + the daemon-written override/secret files, mirroring
// the daemon's own boot precedence. A machine where none of that exists is
// an uninstall remnant — see selfCleanIfUninstalled.

/**
 * The watchdog's stateDir mirrors the DAEMON's resolution: its own plist
 * carries no TOKENLEADER_* env, so a custom TOKENLEADER_STATE_DIR in the
 * daemon plist must be honored here too or the two processes would watch
 * different heartbeat files.
 */
export function resolveWatchdogStateDir(env: NodeJS.ProcessEnv, home: string): string {
  if (env.TOKENLEADER_STATE_DIR?.trim()) return env.TOKENLEADER_STATE_DIR.trim();
  try {
    const plist = readFileSync(
      path.join(home, "Library", "LaunchAgents", `${DAEMON_LABEL}.plist`),
      "utf8",
    );
    const fromPlist = parsePlistEnv(plist).TOKENLEADER_STATE_DIR;
    if (fromPlist?.trim()) return fromPlist.trim();
  } catch {
    // no daemon plist — default below
  }
  return path.join(home, ".local", "share", "anara-leaderboard");
}

export interface WatchdogContext {
  user: string | null;
  endpoint: string | null;
  secret: string | null;
  device: string | null;
  execPath: string;
  tickIntervalSec: number;
  daemonPlistPath: string;
}

export function resolveWatchdogContext(deps: WatchdogDeps): WatchdogContext {
  const home = deps.home ?? homedir();
  const daemonPlistPath = path.join(home, "Library", "LaunchAgents", `${DAEMON_LABEL}.plist`);
  let plistEnv: Record<string, string> = {};
  try {
    plistEnv = parsePlistEnv(readFileSync(daemonPlistPath, "utf8"));
  } catch {
    // missing plist — handled by callers
  }
  const env = deps.env ?? process.env;
  const user = env.TOKENLEADER_USER?.trim() || plistEnv.TOKENLEADER_USER || null;
  let endpoint = env.TOKENLEADER_ENDPOINT?.trim() || plistEnv.TOKENLEADER_ENDPOINT || null;
  // Same boot precedence as the daemon: the daemon-written override file wins.
  // Sync read (this process lives for seconds; async buys nothing here).
  try {
    const raw = readFileSync(endpointOverridePath(deps.stateDir), "utf8").trim();
    if (raw && isAcceptableEndpoint(normalizeEndpoint(raw))) endpoint = normalizeEndpoint(raw);
  } catch {
    // no override file
  }
  let secret: string | null = null;
  try {
    secret = readFileSync(path.join(deps.stateDir, "secret"), "utf8").trim() || null;
  } catch {
    // no secret yet (daemon's first sync creates it)
  }
  const execPath = path.join(home, ".local", "bin", "anara-leaderboard");
  const tickIntervalSec = Number.parseInt(plistEnv.TOKENLEADER_INTERVAL_SEC ?? "", 10) || 300;
  const device = deviceLabelFromHost(hostname()) ?? null;
  return {
    user,
    endpoint: endpoint ? endpoint.replace(/\/+$/, "") : null,
    secret,
    device,
    execPath,
    tickIntervalSec,
    daemonPlistPath,
  };
}

// --- launchd introspection ---------------------------------------------------

/** Live pid of a label per launchd, or null when not running/loaded. */
export function labelPid(exec: Exec, uid: number, label: string): number | null {
  const r = exec("launchctl", ["print", `gui/${uid}/${label}`]);
  if (!r.ok) return null;
  const m = r.stdout.match(/^\s*pid = (\d+)\s*$/m);
  return m ? Number.parseInt(m[1]!, 10) : null;
}

export function labelLoaded(exec: Exec, uid: number, label: string): boolean {
  return exec("launchctl", ["print", `gui/${uid}/${label}`]).ok;
}

// --- the run -----------------------------------------------------------------

export interface WatchdogRunResult {
  action: "observe" | "sigterm" | "sigkill" | "degraded" | "rollback" | "self_clean" | "no_daemon";
  staleRuns: number;
  checkinOk: boolean;
}

export async function runWatchdog(deps: WatchdogDeps): Promise<WatchdogRunResult> {
  const exec = deps.exec ?? defaultExec;
  const now = deps.now ?? Date.now;
  const kill = deps.kill ?? ((pid: number, sig: NodeJS.Signals) => process.kill(pid, sig));
  const log = deps.log;
  const uid = process.getuid?.() ?? 501;

  // 0. Domain assert: only the gui-domain instance may act (a user/-domain
  // duplicate from an SSH-driven install must not double-count the ladder).
  if (!deps.skipDomainAssert) {
    const r = exec("launchctl", ["print", `gui/${uid}/${WATCHDOG_LABEL}`]);
    if (r.ok) {
      const m = r.stdout.match(/^\s*pid = (\d+)\s*$/m);
      if (m && Number.parseInt(m[1]!, 10) !== process.pid) {
        log.info("watchdog_domain_mismatch", { labelPid: m[1] });
        return { action: "observe", staleRuns: 0, checkinOk: false };
      }
    }
  }

  const ctx = resolveWatchdogContext(deps);
  const { state, corrupt } = loadWatchdogState(deps.stateDir);
  if (corrupt) log.warn("watchdog_state_corrupt", {});

  // 6 (early). Uninstall remnant: daemon plist AND binary both gone — an old
  // uninstaller removed the daemon but not us. Clean up and boot out our own
  // label as the final act (sanctioned: a one-shot job with no KeepAlive tree
  // cannot strand itself).
  if (!existsSync(ctx.daemonPlistPath) && !existsSync(ctx.execPath)) {
    log.info("watchdog_self_clean", {});
    selfClean(exec, uid, deps.home ?? homedir());
    return { action: "self_clean", staleRuns: 0, checkinOk: false };
  }

  // 1+2. Staleness + identity decision, purely local.
  const hb = readHeartbeat(deps.stateDir);
  const daemonPid = labelPid(exec, uid, DAEMON_LABEL);
  let action: WatchdogRunResult["action"] = "observe";

  // Respawn accounting for the fuse. Evidence comes from BOTH the heartbeat
  // pid (every boot writes one immediately, so this survives sampling gaps —
  // a crash-looper that lives 10s is invisible to 120s label-pid samples but
  // never to its own boot writes) and label-pid changes across two live
  // samples. A journal entry since our previous firing marks it deliberate.
  const journalSince = state.lastRunAt ?? now() - WATCHDOG_INTERVAL_SEC * 1000;
  const explained = readJournal(deps.stateDir).some(
    (e) => e.ts >= journalSince - JOURNAL_EXPLAIN_SLOP_MS,
  );
  const hbPidChanged = hb !== null && state.lastHbPid !== null && hb.pid !== state.lastHbPid;
  const labelPidChanged =
    daemonPid !== null && state.lastLabelPid !== null && daemonPid !== state.lastLabelPid;
  if ((hbPidChanged || labelPidChanged) && !explained) {
    state.respawns.push(now());
  }
  state.lastLabelPid = daemonPid;
  if (hb) state.lastHbPid = hb.pid;
  state.lastRunAt = now();
  state.noPidRuns = daemonPid === null ? state.noPidRuns + 1 : 0;
  state.respawns = state.respawns.filter((t) => now() - t < FUSE_WINDOW_MS);

  const staleThresholdRuns = staleRunsFor(ctx.tickIntervalSec);
  const sig = hb ? `${hb.tick_seq}:${hb.wall_ms}:${hb.pid}` : null;
  if (corrupt && sig !== null) {
    // Fail closed toward detection: a corrupt counter file counts as one
    // stale observation already recorded — the compare below must not run
    // (it would see a "changed" sig and erase the observation).
    state.lastSig = sig;
    state.consecUnchanged = 1;
  } else if (sig === null) {
    // Missing/corrupt heartbeat: observe-only, always.
    state.lastSig = null;
    state.consecUnchanged = 0;
  } else if (sig !== state.lastSig) {
    state.lastSig = sig;
    // freshSince anchors the unlatch clock: re-anchor only when recovering
    // from REAL staleness (>= threshold) — a sub-threshold unchanged streak
    // is the daemon's normal 5-min rhythm, not a freshness break.
    if (state.consecUnchanged >= staleThresholdRuns || state.freshSince === null) {
      state.freshSince = now();
    }
    state.consecUnchanged = 0;
    state.termedPid = null;
    // "Do not recover the heartbeat" (spec, ladder #3): a respawned daemon
    // that completes a healthy tick IS recovered — clear the fuse memory.
    // Crash-loopers die before their first tick, so they never get here.
    if (hb!.tick_seq >= 1 && hb!.consec_failures === 0) {
      state.respawns = [];
    }
  } else {
    state.consecUnchanged += 1;
  }

  // Unlatch: 30 min of fresh heartbeats clears degraded + counters.
  if (
    state.degraded &&
    state.consecUnchanged === 0 &&
    state.freshSince !== null &&
    now() - state.freshSince >= UNLATCH_FRESH_MS
  ) {
    log.info("watchdog_unlatch", {});
    state.degraded = false;
    state.degradedAt = null;
    state.respawns = [];
    state.kills = [];
  }

  // Fuse: repeated unexplained, unrecovered respawns → stop killing, alarm.
  if (!state.degraded && state.respawns.length >= FUSE_RESPAWNS) {
    log.error("watchdog_degraded", { respawns: state.respawns.length });
    state.degraded = true;
    state.degradedAt = now();
    action = "degraded";
    // Rollback backstop: crash-respawns of a freshly swapped binary.
    maybeRollback(deps, exec, ctx, state, now, log);
  }

  const marker = readUpdateMarker(deps.stateDir);
  const updateGrace = marker !== null && now() - marker.started_at < UPDATE_MARKER_IGNORE_MS;
  const threshold = updateGrace ? UPDATE_GRACE_RUNS : staleRunsFor(ctx.tickIntervalSec);

  const stale = hb !== null && state.consecUnchanged >= threshold;
  // Identity anchor: only the heartbeat's author, and only while launchd says
  // that exact pid is the label's live process.
  const killable = stale && hb !== null && daemonPid !== null && daemonPid === hb.pid;

  if (killable && !state.degraded) {
    if (state.termedPid === hb!.pid) {
      log.error("watchdog_sigkill", { pid: hb!.pid, staleRuns: state.consecUnchanged });
      try {
        kill(hb!.pid, "SIGKILL");
      } catch {
        // already gone
      }
      state.kills.push(now());
      state.termedPid = null;
      action = "sigkill";
    } else {
      // Forensics first, then SIGTERM.
      captureForensics(deps, exec, hb!.pid, log);
      log.error("watchdog_sigterm", { pid: hb!.pid, staleRuns: state.consecUnchanged });
      try {
        kill(hb!.pid, "SIGTERM");
      } catch {
        // raced an exit; fine
      }
      state.kills.push(now());
      state.termedPid = hb!.pid;
      action = "sigterm";
    }
  } else if (stale && !killable && daemonPid === null) {
    action = "no_daemon";
  }
  state.kills = state.kills.filter((t) => now() - t < FUSE_WINDOW_MS);

  // 3. Boot heal, local: missing daemon binary → repair download; unloaded
  // daemon job → enable + bootstrap; loaded-but-not-running job → kickstart;
  // missing daemon plist → restore snapshot.
  await healDaemonArtifacts(deps, exec, ctx, uid, daemonPid, state, log);

  saveWatchdogState(deps.stateDir, state);

  // 4+5. Network LAST: checkin (directive piggyback) then spool drain.
  let checkinOk = false;
  if (ctx.endpoint && ctx.user && ctx.secret) {
    const body: WatchdogCheckinBody = {
      watchdog_version: BUILD_VERSION,
      daemon_pid_alive: daemonPid !== null,
      heartbeat_age_runs: state.consecUnchanged,
      kills_recent: state.kills.length,
      degraded: state.degraded,
      spool_pending: spoolFiles(deps.stateDir).length,
      state_corrupt: corrupt,
    };
    const res = curlJson(
      exec,
      "POST",
      `${ctx.endpoint}/watchdog-checkin`,
      {
        "X-Tokenleader-Secret": ctx.secret,
        "X-Tokenleader-User": ctx.user,
        ...(ctx.device ? { "X-Tokenleader-Device": ctx.device } : {}),
        "X-Tokenleader-Version": BUILD_VERSION,
      },
      body,
    );
    checkinOk = res !== null;
    const directive = res?.directive as { id?: number; verb?: string } | undefined;
    if (directive && typeof directive.id === "number" && typeof directive.verb === "string") {
      executeWatchdogDirective(
        deps,
        exec,
        ctx,
        uid,
        directive as { id: number; verb: string },
        log,
      );
    }
    drainSpool(deps, exec, ctx, log);
  }

  return { action, staleRuns: state.consecUnchanged, checkinOk };
}

// --- forensics + spool -------------------------------------------------------

function spoolDir(stateDir: string): string {
  return path.join(stateDir, SPOOL_DIR);
}

function spoolFiles(stateDir: string): string[] {
  try {
    return readdirSync(spoolDir(stateDir))
      .filter((f) => !f.startsWith("."))
      .sort();
  } catch {
    return [];
  }
}

function spoolWrite(stateDir: string, name: string, content: string): void {
  try {
    mkdirSync(spoolDir(stateDir), { recursive: true });
    // Bound the spool: drop oldest beyond the cap so a dead server can't
    // grow forensics without bound.
    const files = spoolFiles(stateDir);
    for (const f of files.slice(0, Math.max(0, files.length - (SPOOL_MAX_FILES - 1)))) {
      try {
        unlinkSync(path.join(spoolDir(stateDir), f));
      } catch {}
    }
    writeFileSync(path.join(spoolDir(stateDir), name), content);
  } catch {
    // forensics are best-effort
  }
}

/** Evidence before the cure: native sample, launchctl snapshot, log tail. */
export function captureForensics(deps: WatchdogDeps, exec: Exec, pid: number, log: Logger): void {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const samplePath = path.join(spoolDir(deps.stateDir), `sample-${ts}.txt`);
  try {
    mkdirSync(spoolDir(deps.stateDir), { recursive: true });
  } catch {}
  // sample writes the report itself via -f; symbolicating a 60MB Mach-O can
  // be slow, so this call gets its own generous timeout.
  const s = exec("sample", [String(pid), String(SAMPLE_SECONDS), "-f", samplePath], 45_000);
  if (!s.ok) log.warn("watchdog_sample_failed", { err: s.err });
  const uid = process.getuid?.() ?? 501;
  const lc = exec("launchctl", ["print", `gui/${uid}/${DAEMON_LABEL}`]);
  spoolWrite(deps.stateDir, `launchctl-${ts}.txt`, lc.stdout || (lc.err ?? ""));
  spoolWrite(deps.stateDir, `logtail-${ts}.txt`, logTail(deps.logDir));
  log.info("watchdog_forensics_captured", { pid });
}

function logTail(logDir: string): string {
  try {
    const p = path.join(logDir, "daemon.jsonl");
    const size = statSync(p).size;
    const start = Math.max(0, size - LOG_TAIL_BYTES);
    const buf = readFileSync(p);
    return buf.subarray(start).toString("utf8");
  } catch (err: unknown) {
    return `log tail unavailable: ${String((err as Error)?.message ?? err)}`;
  }
}

function drainSpool(deps: WatchdogDeps, exec: Exec, ctx: WatchdogContext, log: Logger): void {
  const files = spoolFiles(deps.stateDir);
  if (files.length === 0 || !ctx.endpoint || !ctx.secret || !ctx.user) return;
  // One combined POST, capped to the server's diag limit. Only the files that
  // actually made it into the payload are deleted on 2xx — the remainder
  // drains on subsequent runs instead of being destroyed unsent.
  let combined = "";
  const included: string[] = [];
  for (const f of files) {
    let chunk: string;
    try {
      chunk = `===== ${f} =====\n${readFileSync(path.join(spoolDir(deps.stateDir), f), "utf8")}\n`;
    } catch {
      included.push(f); // unreadable = never uploadable; let the 2xx clear it
      continue;
    }
    if (combined.length + chunk.length > 240 * 1024 && included.length > 0) break;
    combined += chunk;
    included.push(f);
  }
  // Stage the combined payload as a file so curl reads it via @file — keeps
  // the whole network path on the injectable exec seam (no stdin plumbing).
  const payloadPath = path.join(spoolDir(deps.stateDir), ".upload");
  try {
    writeFileSync(payloadPath, combined);
  } catch {
    return;
  }
  const args = [
    ...CURL_ARGS,
    "--fail",
    "-X",
    "POST",
    "-H",
    `X-Tokenleader-Secret: ${ctx.secret}`,
    "-H",
    `X-Tokenleader-User: ${ctx.user}`,
    ...(ctx.device ? ["-H", `X-Tokenleader-Device: ${ctx.device}`] : []),
    "-H",
    "Content-Type: text/plain",
    "--data-binary",
    `@${payloadPath}`,
    `${ctx.endpoint}/diag/logs`,
  ];
  const ok = exec("curl", args, 20_000).ok;
  try {
    unlinkSync(payloadPath);
  } catch {}
  if (ok) {
    for (const f of included) {
      try {
        unlinkSync(path.join(spoolDir(deps.stateDir), f));
      } catch {}
    }
    log.info("watchdog_spool_drained", {
      files: included.length,
      pending: files.length - included.length,
    });
  }
}

// --- heal + rollback + self-clean ---------------------------------------------

async function healDaemonArtifacts(
  deps: WatchdogDeps,
  exec: Exec,
  ctx: WatchdogContext,
  uid: number,
  daemonPid: number | null,
  state: WatchdogState,
  log: Logger,
): Promise<void> {
  // Missing daemon plist with a live binary: restore the snapshot the daemon
  // keeps for us (mutual heal, file-only — effective next login/bootstrap).
  if (!existsSync(ctx.daemonPlistPath)) {
    try {
      const bak = readFileSync(path.join(deps.stateDir, "daemon.plist.bak"), "utf8");
      writeFileSync(ctx.daemonPlistPath, bak, { mode: 0o600 });
      log.info("watchdog_daemon_plist_restored", {});
    } catch {
      // no snapshot — nothing to restore from
    }
  }
  // Missing daemon binary with our own hardlink alive: repair-download.
  // stateDir is deliberately OMITTED: the watchdog must not perform
  // endpoint-override migrations, and its no-op restart would otherwise
  // write a phantom "endpoint_override" journal entry that journal-explains
  // (masks) real crash respawns. The manifest GET rides curl via the
  // fetchImpl seam — Bun fetch stays banned in this process.
  if (!existsSync(ctx.execPath) && ctx.endpoint) {
    log.warn("watchdog_daemon_binary_missing", { execPath: ctx.execPath });
    try {
      const { checkForUpdate } = await import("./update");
      await checkForUpdate({
        log,
        endpoint: ctx.endpoint,
        execPath: ctx.execPath,
        allowMissingExec: true,
        fetchImpl: curlFetchImpl(exec),
        restart: () => {}, // KeepAlive's failing respawn loop picks it up
      });
    } catch (err: unknown) {
      log.warn("watchdog_repair_failed", { err: String((err as Error)?.message ?? err) });
    }
  }
  // Daemon job unloaded (bootout'd, never loaded): enable + bootstrap — a
  // DIFFERENT label, so this is safe from any process.
  if (
    daemonPid === null &&
    existsSync(ctx.daemonPlistPath) &&
    !labelLoaded(exec, uid, DAEMON_LABEL)
  ) {
    exec("launchctl", ["enable", `gui/${uid}/${DAEMON_LABEL}`]);
    const b = exec("launchctl", ["bootstrap", `gui/${uid}`, ctx.daemonPlistPath]);
    log.info("watchdog_daemon_bootstrap", { ok: b.ok, err: b.err });
  } else if (
    // Daemon job loaded but persistently NOT running: launchd's KeepAlive is
    // satisfied and will never respawn it. Reachable when a loaded legacy
    // {SuccessfulExit:false} registration (the plist heal is file-only until
    // next login) sees the daemon exit 0 — e.g. the SIGTERM ladder's graceful
    // shutdown (the 2026-07-09 edi strand). bootstrap EIOs on a loaded label;
    // kickstart is the lever. Two pid-less firings rule out ThrottleInterval
    // respawn races; the degraded latch wins — a fused crash-looper stays down.
    daemonPid === null &&
    !state.degraded &&
    state.noPidRuns >= KICKSTART_NO_PID_RUNS &&
    labelLoaded(exec, uid, DAEMON_LABEL)
  ) {
    const k = exec("launchctl", ["kickstart", `gui/${uid}/${DAEMON_LABEL}`]);
    log.info("watchdog_daemon_kickstart", { ok: k.ok, err: k.err });
  }
}

function maybeRollback(
  deps: WatchdogDeps,
  exec: Exec,
  ctx: WatchdogContext,
  state: WatchdogState,
  now: () => number,
  log: Logger,
): void {
  const prev = `${ctx.execPath}.prev`;
  try {
    const execStat = statSync(ctx.execPath);
    if (now() - execStat.mtimeMs > FRESH_SWAP_WINDOW_MS) return; // not a fresh swap
    if (!existsSync(prev)) return;
    if (state.rolledBackAt && now() - state.rolledBackAt < FRESH_SWAP_WINDOW_MS) return;
    // Copy .prev → tmp, rename over execPath: fresh inode (avoids the sticky
    // codesign-kill class), .prev preserved as the recovery path.
    const tmp = `${ctx.execPath}.rollback`;
    const cp = exec("cp", [prev, tmp], 60_000);
    if (!cp.ok) {
      log.error("watchdog_rollback_copy_failed", { err: cp.err });
      return;
    }
    exec("chmod", ["755", tmp]);
    renameSync(tmp, ctx.execPath);
    state.rolledBackAt = now();
    log.error("watchdog_rolled_back", { to: prev });
  } catch (err: unknown) {
    log.error("watchdog_rollback_failed", { err: String((err as Error)?.message ?? err) });
  }
}

function selfClean(exec: Exec, uid: number, home: string): void {
  const plist = path.join(home, "Library", "LaunchAgents", `${WATCHDOG_LABEL}.plist`);
  try {
    unlinkSync(plist);
  } catch {}
  try {
    unlinkSync(path.join(home, ".local", "bin", "anara-leaderboard.watchdog"));
  } catch {}
  // Final act: this terminates the watchdog job itself.
  exec("launchctl", ["bootout", `gui/${uid}/${WATCHDOG_LABEL}`]);
}

// --- directives ---------------------------------------------------------------

function executeWatchdogDirective(
  deps: WatchdogDeps,
  exec: Exec,
  ctx: WatchdogContext,
  uid: number,
  directive: { id: number; verb: string },
  log: Logger,
): void {
  let result: "ok" | "failed" = "ok";
  let detail = "";
  const kill = deps.kill ?? ((pid: number, sig: NodeJS.Signals) => process.kill(pid, sig));
  const daemonPid = labelPid(exec, uid, DAEMON_LABEL);
  switch (directive.verb) {
    case "restart": {
      if (daemonPid !== null) {
        try {
          kill(daemonPid, "SIGTERM");
          detail = `sigterm ${daemonPid}`;
        } catch (err: unknown) {
          result = "failed";
          detail = String((err as Error)?.message ?? err);
        }
      } else if (labelLoaded(exec, uid, DAEMON_LABEL)) {
        // Loaded but not running: bootstrap EIOs on a loaded label (14
        // consecutive failed restarts on the 2026-07 strand) — kickstart
        // is the call that starts a loaded-but-idle job.
        const k = exec("launchctl", ["kickstart", `gui/${uid}/${DAEMON_LABEL}`]);
        detail = k.ok ? "kickstarted" : `kickstart failed: ${k.err}`;
        if (!k.ok) result = "failed";
      } else {
        exec("launchctl", ["enable", `gui/${uid}/${DAEMON_LABEL}`]);
        const b = exec("launchctl", ["bootstrap", `gui/${uid}`, ctx.daemonPlistPath]);
        detail = b.ok ? "bootstrapped" : `bootstrap failed: ${b.err}`;
        if (!b.ok && !b.err?.includes("already")) result = "failed";
      }
      break;
    }
    case "upload_logs": {
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      spoolWrite(deps.stateDir, `logtail-${ts}.txt`, logTail(deps.logDir));
      break; // drained by the caller right after
    }
    case "sample": {
      if (daemonPid !== null) captureForensics(deps, exec, daemonPid, log);
      else {
        result = "failed";
        detail = "daemon not running";
      }
      break;
    }
    case "upload_state": {
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      let content = "";
      for (const f of ["state.json", "heartbeat.json", "exit-journal.jsonl", WATCHDOG_STATE_FILE]) {
        try {
          content += `===== ${f} =====\n${readFileSync(path.join(deps.stateDir, f), "utf8").slice(0, 60_000)}\n`;
        } catch {}
      }
      const lc = exec("launchctl", ["print", `gui/${uid}/${DAEMON_LABEL}`]);
      content += `===== launchctl =====\n${lc.stdout || lc.err || ""}`;
      spoolWrite(deps.stateDir, `state-${ts}.txt`, content);
      break;
    }
    case "reinstall_watchdog": {
      // Already running here, so "reinstall" = re-assert enable (clears stale
      // disable records); plist/bootstrap re-assert happens at daemon boot.
      exec("launchctl", ["enable", `gui/${uid}/${WATCHDOG_LABEL}`]);
      detail = "enabled";
      break;
    }
    default: {
      log.warn("watchdog_directive_unknown", { verb: directive.verb });
      result = "failed";
      detail = "unknown verb";
    }
  }
  log.info("watchdog_directive_done", { id: directive.id, verb: directive.verb, result, detail });
  if (ctx.endpoint && ctx.secret && ctx.user) {
    curlJson(
      exec,
      "POST",
      `${ctx.endpoint}/directives/ack`,
      {
        "X-Tokenleader-Secret": ctx.secret,
        "X-Tokenleader-User": ctx.user,
        ...(ctx.device ? { "X-Tokenleader-Device": ctx.device } : {}),
      },
      { id: directive.id, result, detail: detail.slice(0, 300), executed_by: "watchdog" },
    );
  }
}

// --- curl helpers (Bun fetch is banned in this process) ------------------------

function curlJson(
  exec: Exec,
  method: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Record<string, unknown> | null {
  // --fail: a 4xx/5xx must read as a FAILED checkin (curl exits 22), never
  // as ok-with-empty-directive — a 403 secret mismatch or an old server's
  // 404 would otherwise report checkinOk=true forever.
  const args = [...CURL_ARGS, "--fail", "-X", method, "-H", "Content-Type: application/json"];
  for (const [k, v] of Object.entries(headers)) args.push("-H", `${k}: ${v}`);
  args.push("--data-binary", JSON.stringify(body), url);
  const r = exec("curl", args, 15_000);
  if (!r.ok) return null;
  try {
    return JSON.parse(r.stdout) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * A minimal GET-only fetch adapter over curl for checkForUpdate's manifest
 * request (the repair path). `-i` captures the status line + headers so the
 * updater's etag/304 handling keeps working; there is no -L, so exactly one
 * header block precedes the body.
 */
export function curlFetchImpl(exec: Exec): typeof fetch {
  return (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const args = [...CURL_ARGS, "-i"];
    const headers = (init?.headers ?? {}) as Record<string, string>;
    for (const [k, v] of Object.entries(headers)) args.push("-H", `${k}: ${v}`);
    args.push(String(url));
    const r = exec("curl", args, 15_000);
    if (!r.ok) throw new Error(`curl: ${r.err ?? "failed"}`);
    const sep = r.stdout.indexOf("\r\n\r\n");
    const rawHead = sep >= 0 ? r.stdout.slice(0, sep) : r.stdout;
    const body = sep >= 0 ? r.stdout.slice(sep + 4) : "";
    const lines = rawHead.split("\r\n");
    const status = Number.parseInt(lines[0]?.split(" ")[1] ?? "0", 10) || 0;
    const h = new Headers();
    for (const line of lines.slice(1)) {
      const i = line.indexOf(":");
      if (i > 0) h.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
    }
    // Response() rejects null-body statuses with a body argument.
    return new Response(status === 204 || status === 304 ? null : body, {
      status,
      headers: h,
    });
  }) as typeof fetch;
}
