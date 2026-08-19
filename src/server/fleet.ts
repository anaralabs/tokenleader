// Fleet classification + the alert sweep — the server half of the v0.6
// "Never Silent" liveness contract (docs/resilience.md).
//
// Two independent channels feed the classifier: the daemon's own traffic
// (/ingest + /checkin → user_devices.last_seen) and the watchdog's 120s
// curl checkin (/watchdog-checkin → watchdog_last_seen). Their disagreement
// is the signal: daemon silent + watchdog reporting = WEDGED (the exact
// failure that motivated v0.6); both silent = DARK; daemon reporting while
// the watchdog swears the heartbeat file is frozen = HEARTBEAT_IO (a disk
// problem — alert, never kill).
//
// CRITICALLY version-aware: watchdog-silence states apply ONLY to devices
// that have EVER sent a watchdog checkin (watchdog_last_seen non-NULL).
// A pre-0.6 daemon has no watchdog — judging it by watchdog silence would
// mark the whole un-migrated fleet WEDGED on deploy day. Those devices
// classify on last_seen alone.

import type { CheckinBody, WatchdogCheckinBody } from "../types.ts";
import type { DeviceInfo, Store } from "./db.ts";

export type FleetState =
  | "HEALTHY"
  | "LATE"
  | "WEDGED"
  | "CRASH_LOOPING"
  | "DEGRADED"
  | "DARK"
  | "UNINSTALLED"
  | "HEARTBEAT_IO";

// --- thresholds --------------------------------------------------------------
// The daemon ticks (and now checks in) every 5 minutes BY DEFAULT — but
// TOKENLEADER_INTERVAL_SEC stretches the cadence up to 24h, so every
// daemon-silence threshold scales per device from the interval_s the daemon
// reports (lateThresholdMs / wedgeThresholdMs / staleHeartbeatRunsFor). The
// watchdog fires every 120s of awake time regardless. Every threshold errs
// toward the daemon's normal rhythms — sleep, slow links, one dropped
// request — never flagging them.

/** Tick cadence (seconds) assumed for daemons that don't report interval_s
 *  (pre-reporting builds) — the TOKENLEADER_INTERVAL_SEC default. */
export const DEFAULT_TICK_INTERVAL_S = 300;
/** The daemon config clamps TOKENLEADER_INTERVAL_SEC to [5s, 24h]; the
 *  sanitizer mirrors it so a lying body can't stretch thresholds further. */
const TICK_INTERVAL_MIN_S = 5;
const TICK_INTERVAL_MAX_S = 24 * 60 * 60;
/** The watchdog's StartInterval (mirrors WATCHDOG_INTERVAL_SEC daemon-side). */
const WATCHDOG_RUN_INTERVAL_S = 120;

/** Daemon silent past 3 missed ticks = worth a second look, not an alarm.
 *  Floor for lateThresholdMs — never judge slower cadences by this. */
export const DAEMON_LATE_MS = 15 * 60 * 1000;
/** Daemon silence that, with a live watchdog still reporting, means the
 *  daemon process is wedged/looping rather than the machine being asleep
 *  (an asleep machine silences BOTH channels). Floor for wedgeThresholdMs. */
export const DAEMON_WEDGE_MS = 30 * 60 * 1000;

/** Per-device late bar: 3 missed ticks at the device's OWN cadence. Without
 *  the scaling, a healthy 24h-interval daemon would sit "late" forever. */
export function lateThresholdMs(intervalS: number): number {
  return Math.max(DAEMON_LATE_MS, 3 * intervalS * 1000);
}

/** Per-device wedge bar: the 3-missed-ticks late bar plus the same
 *  15-minute margin the defaults encode (30m = 15m late + 15m). A healthy
 *  slow-cadence daemon must never classify WEDGED — that state auto-heals
 *  with a restart, and a false positive would restart it forever. */
export function wedgeThresholdMs(intervalS: number): number {
  return Math.max(DAEMON_WEDGE_MS, 3 * intervalS * 1000 + 15 * 60 * 1000);
}

/** A watchdog checkin within this window = the watchdog channel is live. */
export const WATCHDOG_FRESH_MS = 15 * 60 * 1000;
/** Both channels silent this long (machine awake or not) = DARK. */
export const DUAL_DARK_MS = 60 * 60 * 1000;
/** Pre-0.6 devices have only last_seen; overnight sleep must stay LATE, so
 *  single-channel DARK needs a full day. */
export const PRE_WATCHDOG_DARK_MS = 24 * 60 * 60 * 1000;
/** Mirror of the watchdog's own staleness fuse: N consecutive firings with
 *  an unchanged heartbeat (8 × 120s ≈ 16 min of awake time). Floor for
 *  staleHeartbeatRunsFor. */
export const STALE_HEARTBEAT_RUNS = 8;

/** Per-device stale-heartbeat bar, mirroring the client watchdog's own
 *  staleRunsFor: a heartbeat only counts as frozen after 3 ticks' worth of
 *  120s watchdog firings at the device's cadence. */
export function staleHeartbeatRunsFor(intervalS: number): number {
  return Math.max(STALE_HEARTBEAT_RUNS, Math.ceil((3 * intervalS) / WATCHDOG_RUN_INTERVAL_S));
}

/** Crash-loop lookback (matches the watchdog's local respawn fuse). */
export const CRASH_LOOP_WINDOW_MS = 90 * 60 * 1000;
/** Unexplained restarts inside the window that constitute a loop. */
export const CRASH_LOOP_THRESHOLD = 3;
/** How close an exit-journal entry must be to a derived boot instant to
 *  explain the restart (journal is written just before exit; KeepAlive
 *  respawn follows within ~30s — the slop absorbs clock skew and a slow
 *  first checkin). */
export const JOURNAL_EXPLAIN_SLOP_MS = 10 * 60 * 1000;

/** A device must hold an alertable state this long before it pages. */
export const ALERT_STATE_MIN_AGE_MS = 60 * 60 * 1000;
/** Never page the same (device, state) twice within this window. */
export const ALERT_DEDUP_MS = 6 * 60 * 60 * 1000;
/** Sweep cadence (server timer — fine here; a missed sweep only delays an
 *  alert, unlike the daemon where timer death was the incident). */
export const ALERT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
/** The states worth a human's attention. LATE is routine (sleep, lunch);
 *  CRASH_LOOPING surfaces in /stats/fleet but pages nobody yet — the local
 *  fuse (degraded marker) escalates it to DEGRADED. HEARTBEAT_IO "alerts
 *  and never kills" (docs/resilience.md): it pages here but must NEVER
 *  trigger the restart auto-heal — that stays gated to WEDGED alone. */
export const ALERT_STATES: ReadonlySet<FleetState> = new Set([
  "WEDGED",
  "DEGRADED",
  "DARK",
  "HEARTBEAT_IO",
]);

/** Convergence check (docs/resilience.md migration step 4): a v0.6+ daemon
 *  reporting fresh with no watchdog checkin this recent gets a
 *  device-targeted reinstall_watchdog queued. */
export const WATCHDOG_REINSTALL_SILENT_MS = 10 * 60 * 1000;

/** Deploy-day storm guard: a pre-watchdog device that was ALREADY past the
 *  DARK bar when the sweep first observed it (dead before we ever saw it
 *  alive) pages exactly ONCE — its (device, DARK) dedup never expires until
 *  a fresh checkin revives it. The slop separates "born dark" from a
 *  watched device crossing the bar between two sweeps. */
export const BORN_DARK_SLOP_MS = 2 * ALERT_SWEEP_INTERVAL_MS;

// --- body sanitizers ---------------------------------------------------------
// Checkin bodies are authenticated but still client-supplied JSON; both
// sanitizers accept anything, keep only fields of the right type (capped),
// and return null for a non-object. A null NEVER fails the request — the
// routes treat the body as garnish on the heartbeat.

const EXIT_JOURNAL_TAIL_MAX = 20;

function finiteNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function nonNegNum(v: unknown): number | null {
  const n = finiteNum(v);
  return n !== null && n >= 0 ? n : null;
}

function boolOr(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function strOrNull(v: unknown, cap: number): string | null {
  return typeof v === "string" ? v.slice(0, cap) : null;
}

/** interval_s: finite → integer clamped to the daemon config's own bounds;
 *  anything else (old daemons, junk) → the 5-minute default, so
 *  pre-reporting builds classify exactly as before. */
function intervalSOr(v: unknown): number {
  const n = finiteNum(v);
  if (n === null) return DEFAULT_TICK_INTERVAL_S;
  return Math.min(TICK_INTERVAL_MAX_S, Math.max(TICK_INTERVAL_MIN_S, Math.round(n)));
}

/** The server's view of a daemon checkin: the shared wire CheckinBody plus
 *  interval_s (reported by daemons with a custom TOKENLEADER_INTERVAL_SEC;
 *  defaulted by the sanitizer for everyone else). Kept out of types.ts so
 *  the frozen wire type stays byte-compatible with old builds. */
export interface DaemonCheckinState extends CheckinBody {
  interval_s: number;
}

/** Coerce an untrusted /checkin JSON body into a DaemonCheckinState
 *  (defaults for anything missing or mistyped), or null when it isn't an
 *  object at all. */
export function sanitizeCheckinBody(raw: unknown): DaemonCheckinState | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const tail: CheckinBody["exit_journal_tail"] = [];
  if (Array.isArray(o.exit_journal_tail)) {
    for (const entry of o.exit_journal_tail.slice(0, EXIT_JOURNAL_TAIL_MAX)) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const ts = finiteNum(e.ts);
      const code = finiteNum(e.code);
      if (ts === null || code === null || typeof e.reason !== "string") continue;
      tail.push({ ts, reason: e.reason.slice(0, 128), code });
    }
  }
  return {
    uptime_s: nonNegNum(o.uptime_s) ?? 0,
    tick_seq: nonNegNum(o.tick_seq) ?? 0,
    consec_failures: nonNegNum(o.consec_failures) ?? 0,
    last_error: strOrNull(o.last_error, 512),
    last_update_result: strOrNull(o.last_update_result, 256),
    disk_free_mb: nonNegNum(o.disk_free_mb),
    // Drift may legitimately be negative (clock stepped back) — any finite
    // number is kept.
    drift_ms: finiteNum(o.drift_ms) ?? 0,
    heartbeat_write_failures: nonNegNum(o.heartbeat_write_failures) ?? 0,
    exit_journal_tail: tail,
    watchdog_installed: typeof o.watchdog_installed === "boolean" ? o.watchdog_installed : null,
    interval_s: intervalSOr(o.interval_s),
    ...(strOrNull(o.platform, 32) ? { platform: strOrNull(o.platform, 32) as string } : {}),
  };
}

/** Coerce an untrusted /watchdog-checkin JSON body into a
 *  WatchdogCheckinBody, or null when it isn't an object. */
export function sanitizeWatchdogBody(raw: unknown): WatchdogCheckinBody | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  return {
    watchdog_version: strOrNull(o.watchdog_version, 64) ?? "",
    daemon_pid_alive: boolOr(o.daemon_pid_alive, false),
    heartbeat_age_runs: nonNegNum(o.heartbeat_age_runs) ?? 0,
    kills_recent: nonNegNum(o.kills_recent) ?? 0,
    degraded: boolOr(o.degraded, false),
    spool_pending: nonNegNum(o.spool_pending) ?? 0,
  };
}

// --- classification ----------------------------------------------------------

/** Everything the classifier may consult about one device. Timestamps are
 *  unix-ms; bodies are the latest sanitized checkin payloads (null = never
 *  sent one); daemonHistory is ASCENDING by time. */
export interface DeviceSignals {
  addedAt: number;
  /** Daemon channel: last authenticated /ingest or /checkin. */
  lastSeen: number | null;
  /** Watchdog channel: last /watchdog-checkin. null = NEVER (pre-0.6). */
  watchdogLastSeen: number | null;
  uninstalled: boolean;
  checkin: DaemonCheckinState | null;
  watchdog: WatchdogCheckinBody | null;
  daemonHistory: readonly { ts: number; uptime_s: number | null }[];
}

/** The tick cadence every daemon-silence threshold scales from: the
 *  device's own reported interval, or the 5-minute default when it has
 *  never sent a (v0.6.1+) body. */
function tickIntervalS(s: Pick<DeviceSignals, "checkin">): number {
  return s.checkin?.interval_s ?? DEFAULT_TICK_INTERVAL_S;
}

/**
 * Restarts the exit journal does NOT explain, within the crash-loop window.
 * A restart is an uptime_s reset between consecutive daemon checkins; its
 * boot instant is derived (checkin ts − uptime), then matched against the
 * journal tail — update swaps, recycles, and restart directives all journal
 * their exit and must never read as crashes.
 */
export function countUnexplainedResets(
  history: readonly { ts: number; uptime_s: number | null }[],
  journalTail: readonly { ts: number; reason: string; code: number }[],
  now: number,
): number {
  let count = 0;
  let prevUptime: number | null = null;
  for (const row of history) {
    const cur = row.uptime_s;
    if (prevUptime !== null && cur !== null && cur < prevUptime) {
      const bootAt = row.ts - cur * 1000;
      const inWindow = bootAt >= now - CRASH_LOOP_WINDOW_MS;
      const explained = journalTail.some((e) => Math.abs(e.ts - bootAt) <= JOURNAL_EXPLAIN_SLOP_MS);
      if (inWindow && !explained) count++;
    }
    if (cur !== null) prevUptime = cur;
  }
  return count;
}

/** Classify one device. Pure — all clocks and signals come in as args. */
export function classifyDevice(s: DeviceSignals, now: number): FleetState {
  if (s.uninstalled) return "UNINSTALLED";

  const lastDaemon = s.lastSeen ?? s.addedAt;
  const daemonSilenceMs = now - lastDaemon;
  // Silence bars scale with the device's own tick cadence
  // (TOKENLEADER_INTERVAL_SEC can stretch to 24h): fixed thresholds would
  // classify a healthy slow-cadence daemon WEDGED and auto-restart it
  // forever.
  const intervalS = tickIntervalS(s);
  // A never-seen device (lastSeen null) is never HEALTHY — its silence is
  // measured from added_at so a fresh link isn't instantly DARK.
  const daemonFresh = s.lastSeen !== null && daemonSilenceMs <= lateThresholdMs(intervalS);
  const hasWatchdog = s.watchdogLastSeen !== null;
  const watchdogFresh = hasWatchdog && now - (s.watchdogLastSeen as number) <= WATCHDOG_FRESH_MS;
  const staleHeartbeat =
    watchdogFresh && (s.watchdog?.heartbeat_age_runs ?? 0) >= staleHeartbeatRunsFor(intervalS);

  // Daemon checkins arriving over the network while the watchdog swears the
  // heartbeat FILE is frozen: that contradiction is a disk problem, not a
  // wedge — alert a human, never kill (docs/resilience.md).
  if (daemonFresh && staleHeartbeat) return "HEARTBEAT_IO";

  const resets = countUnexplainedResets(s.daemonHistory, s.checkin?.exit_journal_tail ?? [], now);
  if (resets >= CRASH_LOOP_THRESHOLD) return "CRASH_LOOPING";

  // The watchdog's local fuse latched: respawns that neither the exit
  // journal explains nor recover the heartbeat. It stopped killing and is
  // asking for a human.
  if (watchdogFresh && s.watchdog?.degraded === true) return "DEGRADED";

  if (daemonFresh) return "HEALTHY";

  if (hasWatchdog) {
    if (watchdogFresh) {
      // Watchdog reporting + daemon silent: the machine is awake, the
      // daemon isn't talking. Stale heartbeat (the watchdog's own fuse) or
      // long silence = the motivating wedge.
      if (staleHeartbeat || daemonSilenceMs > wedgeThresholdMs(intervalS)) return "WEDGED";
      return "LATE";
    }
    // Both channels silent. Short dual silence is a nap; an hour is DARK
    // (booted-out labels, dead machine, vacation — a human decides).
    const lastAny = Math.max(lastDaemon, s.watchdogLastSeen as number);
    return now - lastAny > DUAL_DARK_MS ? "DARK" : "LATE";
  }

  // One channel only. WHY there is only one decides the bar:
  //   * Linux (and any non-darwin platform): single-channel BY DESIGN —
  //     systemd is the supervisor, there is no watchdog role, and a VPS does
  //     not sleep. Silence means the daemon or the box is gone, so it gets
  //     the same 1h dual-silence bar a v0.6+ Mac gets. The 24h bar would hide
  //     a destroyed VPS for a full day.
  //   * A device that reports NO platform is a pre-v0.7 daemon, i.e. a Mac
  //     without the watchdog: an overnight sleep is indistinguishable from
  //     death there, so it keeps the full-day bar.
  const singleChannelByDesign = !devicePlatformHasWatchdog(s.checkin?.platform ?? null);
  const darkBar = singleChannelByDesign ? DUAL_DARK_MS : PRE_WATCHDOG_DARK_MS;
  return daemonSilenceMs > darkBar ? "DARK" : "LATE";
}

/** Assemble DeviceSignals for one device from the store (latest sanitized
 *  bodies + the daemon history window the crash-loop scan reads). */
export function collectDeviceSignals(
  store: Store,
  device: DeviceInfo,
  uninstalled = false,
): DeviceSignals {
  const parseState = <T>(
    kind: "daemon" | "watchdog",
    sanitize: (raw: unknown) => T | null,
  ): T | null => {
    const stored = store.getDeviceCheckinState(device.id, kind);
    if (!stored) return null;
    try {
      return sanitize(JSON.parse(stored.body));
    } catch {
      return null;
    }
  };
  return {
    addedAt: device.addedAt,
    lastSeen: device.lastSeen,
    watchdogLastSeen: device.watchdogLastSeen,
    uninstalled,
    checkin: parseState("daemon", sanitizeCheckinBody),
    watchdog: parseState("watchdog", sanitizeWatchdogBody),
    daemonHistory: store.recentCheckinHistory(device.id, "daemon"),
  };
}

// --- alert sweep ---------------------------------------------------------

/**
 * Does this device's PLATFORM have a watchdog role at all?
 *
 * The launchd watchdog pair is macOS-only: on Linux systemd is the supervisor
 * (Restart=always + StartLimitIntervalSec=0), the daemon reports
 * watchdog_installed=null, and its watchdog channel is silent forever BY
 * DESIGN. Without this gate the sweep below queued a reinstall_watchdog at
 * every Linux device every dedup window, forever — a fake self-heal loop that
 * also burned the one-directive-per-checkin slot.
 *
 * A missing platform means a pre-v0.7 daemon, all of which are darwin; the
 * default must therefore stay `true` or the whole fielded fleet would stop
 * converging.
 */
export function devicePlatformHasWatchdog(platform: string | null | undefined): boolean {
  if (!platform) return true;
  return platform.startsWith("darwin");
}

/** Does this device's reported daemon build ship the watchdog role
 *  (>= 0.6.0)? Lenient 'vX.Y.Z' parse; unknown/dev/unparseable versions are
 *  NEVER capable — queueing reinstall_watchdog at a dev build would poke
 *  launchd on a developer's machine. */
export function watchdogCapableVersion(version: string | null): boolean {
  const m = version === null ? null : /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > 0 || minor >= 6;
}

/** WATCHDOG_MISSING is not a FleetState (a device can be HEALTHY while its
 *  daemon reports watchdog_installed=false) but pages through the same
 *  webhook path, so decisions carry either. */
export type FleetAlertKey = FleetState | "WATCHDOG_MISSING";

export interface FleetAlertDecision {
  user: string;
  deviceId: number;
  label: string | null;
  state: FleetAlertKey;
  action: "observed" | "alerted" | "deduped" | "no_webhook" | "webhook_failed";
  healQueued: boolean;
}

export interface SweepOptions {
  store: Store;
  /** Slack-style webhook ({text} POST). null = log-only (heal still runs). */
  webhookUrl: string | null;
  /** TOKENLEADER_ALERT_SUPPRESS=1 — skips the ENTIRE sweep (planned
   *  rollbacks must not page and must not queue heals against machines
   *  that are down on purpose). */
  suppressed: boolean;
  now?: number;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

function fmtAgo(now: number, ts: number | null): string {
  if (ts === null) return "never";
  const mins = Math.max(0, Math.round((now - ts) / 60_000));
  if (mins < 60) return `${mins}m ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / (24 * 60))}d ago`;
}

/**
 * One pass of the fleet alert sweep: classify every active device, track
 * how long it has held its state, and for alertable states held > 1h,
 * queue the heal (WEDGED → device-targeted restart, deduped so a
 * non-recovering machine isn't restart-stormed; HEARTBEAT_IO pages but
 * NEVER restarts) and page the webhook (6h dedup per device+state,
 * persisted so a redeploy doesn't re-page the fleet). A pre-watchdog
 * device that was already long dead at its first observation pages once,
 * then stays deduped until a fresh checkin revives it — deploy day must
 * not re-page the known-dead forever. The same pass runs the migration
 * convergence check (fresh v0.6+ daemon, silent watchdog → queue
 * reinstall_watchdog) and pages WATCHDOG_MISSING when a daemon reports
 * watchdog_installed=false for over an hour. Every decision is logged;
 * failures never throw.
 */
export async function sweepFleetAlerts(opts: SweepOptions): Promise<FleetAlertDecision[]> {
  const log = opts.log ?? ((line: string) => console.log(line));
  if (opts.suppressed) {
    log("[tokenleader] fleet sweep: suppressed (TOKENLEADER_ALERT_SUPPRESS=1) — skipping");
    return [];
  }
  const now = opts.now ?? Date.now();
  const doFetch = opts.fetchImpl ?? fetch;
  const decisions: FleetAlertDecision[] = [];
  for (const { user, device } of opts.store.listFleetDevices()) {
    const signals = collectDeviceSignals(opts.store, device);
    const state = classifyDevice(signals, now);
    // Track state age even for quiet states so a later transition into an
    // alertable state starts its 1h clock from the actual transition.
    const since = opts.store.observeDeviceFleetState(device.id, user, state, now);
    const name = `${user}/${device.label ?? `device-${device.id}`}`;

    const push = (
      key: FleetAlertKey,
      action: FleetAlertDecision["action"],
      healQueued: boolean,
    ): void => {
      decisions.push({
        user,
        deviceId: device.id,
        label: device.label,
        state: key,
        action,
        healQueued,
      });
    };

    // Deliver one page through the webhook, honoring the per-(device, key)
    // dedup window; the alert is recorded only on success so a transient
    // webhook failure retries next sweep instead of being silently deduped.
    const page = async (key: FleetAlertKey, text: string, healQueued: boolean, dedupMs: number) => {
      if (!opts.webhookUrl) {
        log(
          `[tokenleader] fleet sweep: ${name} is ${key} — no TOKENLEADER_ALERT_WEBHOOK, not paging`,
        );
        push(key, "no_webhook", healQueued);
        return;
      }
      const lastAlert = opts.store.lastFleetAlertAt(device.id, key);
      if (lastAlert !== null && now - lastAlert < dedupMs) {
        log(
          `[tokenleader] fleet sweep: ${name} still ${key} — already alerted ${fmtAgo(now, lastAlert)}, deduped`,
        );
        push(key, "deduped", healQueued);
        return;
      }
      let delivered = false;
      try {
        const res = await doFetch(opts.webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }),
        });
        delivered = res.ok;
        if (!res.ok) {
          log(`[tokenleader] fleet sweep: webhook returned ${res.status} for ${name} ${key}`);
        }
      } catch (err) {
        log(`[tokenleader] fleet sweep: webhook POST failed for ${name} ${key}: ${err}`);
      }
      if (delivered) {
        opts.store.recordFleetAlert(device.id, user, key, now);
        log(`[tokenleader] fleet sweep: alerted ${name} ${key}`);
        push(key, "alerted", healQueued);
      } else {
        push(key, "webhook_failed", healQueued);
      }
    };

    // Freshness on the device's own cadence — shared by the convergence
    // check and the WATCHDOG_MISSING flag below.
    const daemonFresh =
      device.lastSeen !== null && now - device.lastSeen <= lateThresholdMs(tickIntervalS(signals));
    const watchdogFresh =
      device.watchdogLastSeen !== null && now - device.watchdogLastSeen <= WATCHDOG_FRESH_MS;

    // Migration convergence (docs/resilience.md step 4): a daemon fresh on
    // a watchdog-capable build whose watchdog channel is silent gets a
    // device-targeted reinstall_watchdog — deduped against live/recent
    // copies so a non-converging machine is nudged, not spammed.
    let reinstallQueued = false;
    if (
      daemonFresh &&
      devicePlatformHasWatchdog(signals.checkin?.platform ?? null) &&
      watchdogCapableVersion(device.version) &&
      (device.watchdogLastSeen === null ||
        now - device.watchdogLastSeen > WATCHDOG_REINSTALL_SILENT_MS) &&
      !opts.store.hasRecentDirective(user, device.id, "reinstall_watchdog", now, ALERT_DEDUP_MS)
    ) {
      opts.store.enqueueDirective(user, "reinstall_watchdog", now, device.id);
      reinstallQueued = true;
      log(
        `[tokenleader] fleet sweep: ${name} runs ${device.version} but its watchdog is silent — queued reinstall_watchdog`,
      );
    }

    // WATCHDOG_MISSING: the daemon itself keeps reporting
    // watchdog_installed=false (BTM toggle, bootstrap failure) while its
    // watchdog channel stays quiet. Persistence-gated like the states: the
    // flag must hold for an hour of sweep observations before it pages. A
    // fresh watchdog checkin or a body saying true clears the streak.
    const missing = daemonFresh && !watchdogFresh && signals.checkin?.watchdog_installed === false;
    const missingSince = opts.store.observeDeviceFlag(
      device.id,
      user,
      "WATCHDOG_MISSING",
      missing,
      now,
    );
    if (missingSince !== null) {
      if (now - missingSince < ALERT_STATE_MIN_AGE_MS) {
        log(
          `[tokenleader] fleet sweep: ${name} reports watchdog_installed=false (${fmtAgo(now, missingSince)}) — under the 1h alert gate`,
        );
        push("WATCHDOG_MISSING", "observed", reinstallQueued);
      } else {
        const text =
          `[tokenleader] ${name} daemon reports watchdog_installed=false ` +
          `(since ${fmtAgo(now, missingSince)}; daemon last seen ${fmtAgo(now, device.lastSeen)}, ` +
          `watchdog ${fmtAgo(now, device.watchdogLastSeen)})` +
          (reinstallQueued ? " — reinstall_watchdog queued" : "");
        await page("WATCHDOG_MISSING", text, reinstallQueued, ALERT_DEDUP_MS);
      }
    }

    if (!ALERT_STATES.has(state)) continue;

    if (now - since < ALERT_STATE_MIN_AGE_MS) {
      log(
        `[tokenleader] fleet sweep: ${name} is ${state} (${fmtAgo(now, since)}) — under the 1h alert gate`,
      );
      push(state, "observed", false);
      continue;
    }

    // Auto-heal: a wedge is exactly what the watchdog's restart directive
    // fixes — the daemon can't hear us, the watchdog can. Deduped against
    // pending AND recently executed restarts so a machine that restarts
    // without recovering isn't hammered every sweep. Gated to WEDGED
    // ALONE: HEARTBEAT_IO is a disk contradiction that "alerts and never
    // kills" (docs/resilience.md) — restarting it would be a kill.
    let healQueued = false;
    if (
      state === "WEDGED" &&
      !opts.store.hasRecentDirective(user, device.id, "restart", now, ALERT_DEDUP_MS)
    ) {
      opts.store.enqueueDirective(user, "restart", now, device.id);
      healQueued = true;
      log(`[tokenleader] fleet sweep: ${name} WEDGED — queued device-targeted restart`);
    }

    // A pre-watchdog device already past the DARK bar when its DARK streak
    // began was dead before this sweep ever saw it alive (the 11 known-dead
    // pre-0.6 machines at deploy): page ONCE, then dedup forever — any
    // fresh checkin resets the streak and with it the dedup choice.
    const bornDark =
      state === "DARK" &&
      device.watchdogLastSeen === null &&
      since - (device.lastSeen ?? device.addedAt) > PRE_WATCHDOG_DARK_MS + BORN_DARK_SLOP_MS;

    const text =
      `[tokenleader] ${name} is ${state} (since ${fmtAgo(now, since)}; ` +
      `daemon last seen ${fmtAgo(now, device.lastSeen)}, ` +
      `watchdog ${fmtAgo(now, device.watchdogLastSeen)})` +
      (healQueued ? " — restart directive queued" : "") +
      (bornDark ? " — dead since before first observation; will not re-page" : "");
    await page(state, text, healQueued, bornDark ? Number.POSITIVE_INFINITY : ALERT_DEDUP_MS);
  }
  return decisions;
}
