// Fleet classification + alert sweep (docs/resilience.md, server half).
// classifyDevice is pure — the matrix below pins every state transition,
// CRITICALLY the version-aware rule: watchdog-silence states (WEDGED,
// dual-channel DARK) apply ONLY to devices that have ever sent a watchdog
// checkin; pre-0.6 devices classify on last_seen alone. The sweep tests
// drive a real Store through the 1h age gate, the 6h dedup, suppression,
// and the WEDGED → device-targeted restart auto-heal.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestApp, jsonOf, makeTokenEvent } from "../test-helpers.ts";
import type { WatchdogCheckinBody } from "../types.ts";
import {
  ALERT_DEDUP_MS,
  ALERT_STATE_MIN_AGE_MS,
  classifyDevice,
  countUnexplainedResets,
  CRASH_LOOP_THRESHOLD,
  devicePlatformHasWatchdog,
  type DaemonCheckinState,
  type DeviceSignals,
  lateThresholdMs,
  PRE_WATCHDOG_DARK_MS,
  sanitizeCheckinBody,
  sanitizeWatchdogBody,
  staleHeartbeatRunsFor,
  sweepFleetAlerts,
  watchdogCapableVersion,
  wedgeThresholdMs,
} from "./fleet.ts";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
// Fixed clock for the pure-classifier matrix.
const NOW = 1_800_000_000_000;

function makeWatchdogBody(overrides: Partial<WatchdogCheckinBody> = {}): WatchdogCheckinBody {
  return {
    watchdog_version: "v0.6.0",
    daemon_pid_alive: true,
    heartbeat_age_runs: 0,
    kills_recent: 0,
    degraded: false,
    spool_pending: 0,
    ...overrides,
  };
}

function makeCheckinBody(overrides: Partial<DaemonCheckinState> = {}): DaemonCheckinState {
  return {
    uptime_s: 3600,
    tick_seq: 12,
    consec_failures: 0,
    last_error: null,
    last_update_result: null,
    disk_free_mb: 50_000,
    drift_ms: 0,
    heartbeat_write_failures: 0,
    exit_journal_tail: [],
    watchdog_installed: true,
    interval_s: 300,
    ...overrides,
  };
}

function signals(overrides: Partial<DeviceSignals> = {}): DeviceSignals {
  return {
    addedAt: NOW - 30 * 24 * HOUR,
    lastSeen: NOW - 2 * MIN,
    watchdogLastSeen: null,
    uninstalled: false,
    checkin: null,
    watchdog: null,
    daemonHistory: [],
    ...overrides,
  };
}

describe("classifyDevice", () => {
  test("fresh daemon is HEALTHY (both eras)", () => {
    expect(classifyDevice(signals(), NOW)).toBe("HEALTHY");
    expect(
      classifyDevice(
        signals({ watchdogLastSeen: NOW - 2 * MIN, watchdog: makeWatchdogBody() }),
        NOW,
      ),
    ).toBe("HEALTHY");
  });

  test("uninstalled wins over everything", () => {
    expect(classifyDevice(signals({ uninstalled: true }), NOW)).toBe("UNINSTALLED");
  });

  test("pre-0.6: silence classifies on last_seen alone — LATE until a full day, then DARK", () => {
    expect(classifyDevice(signals({ lastSeen: NOW - 45 * MIN }), NOW)).toBe("LATE");
    expect(classifyDevice(signals({ lastSeen: NOW - 12 * HOUR }), NOW)).toBe("LATE");
    expect(classifyDevice(signals({ lastSeen: NOW - 25 * HOUR }), NOW)).toBe("DARK");
  });

  test("a silent LINUX device goes DARK in an hour, not a day", () => {
    // Linux is single-channel BY DESIGN (systemd is the supervisor; the
    // daemon reports watchdog_installed=null and never sends a watchdog
    // checkin). Treating it like a pre-0.6 Mac hid a destroyed VPS behind a
    // 24h LATE — nobody gets paged for a day. A v0.6+ Mac with both channels
    // silent goes DARK in an hour; so does a Linux box with its one channel
    // silent.
    const linux = { platform: "linux-arm64", watchdog_installed: null };
    const silent = (ms: number): DeviceSignals =>
      signals({
        lastSeen: NOW - ms,
        checkin: makeCheckinBody(linux as Partial<DaemonCheckinState>),
      });
    expect(classifyDevice(silent(45 * MIN), NOW)).toBe("LATE");
    expect(classifyDevice(silent(90 * MIN), NOW)).toBe("DARK");
    // A darwin device that never reported a watchdog is genuinely pre-0.6 —
    // an overnight sleep is indistinguishable from death, so it keeps the
    // full-day bar.
    const mac = signals({
      lastSeen: NOW - 90 * MIN,
      checkin: makeCheckinBody({ platform: "darwin-arm64" } as Partial<DaemonCheckinState>),
    });
    expect(classifyDevice(mac, NOW)).toBe("LATE");
    // …as does a device that reports no platform at all (pre-v0.7 daemon).
    expect(classifyDevice(signals({ lastSeen: NOW - 90 * MIN }), NOW)).toBe("LATE");
  });

  test("version-aware: identical daemon silence is WEDGED with a live watchdog, LATE without one", () => {
    const silent45m = { lastSeen: NOW - 45 * MIN };
    expect(classifyDevice(signals(silent45m), NOW)).toBe("LATE");
    expect(classifyDevice(signals({ ...silent45m, watchdogLastSeen: NOW - 2 * MIN }), NOW)).toBe(
      "WEDGED",
    );
  });

  test("WEDGED via the watchdog's own staleness fuse (heartbeat_age_runs >= 8)", () => {
    expect(
      classifyDevice(
        signals({
          lastSeen: NOW - 20 * MIN,
          watchdogLastSeen: NOW - 2 * MIN,
          watchdog: makeWatchdogBody({ heartbeat_age_runs: 8 }),
        }),
        NOW,
      ),
    ).toBe("WEDGED");
    // Below both wedge triggers: short silence + young heartbeat = LATE.
    expect(
      classifyDevice(
        signals({
          lastSeen: NOW - 20 * MIN,
          watchdogLastSeen: NOW - 2 * MIN,
          watchdog: makeWatchdogBody({ heartbeat_age_runs: 3 }),
        }),
        NOW,
      ),
    ).toBe("LATE");
  });

  test("HEARTBEAT_IO: daemon checkins fresh while the watchdog swears the heartbeat file is stale", () => {
    expect(
      classifyDevice(
        signals({
          lastSeen: NOW - 2 * MIN,
          watchdogLastSeen: NOW - 2 * MIN,
          watchdog: makeWatchdogBody({ heartbeat_age_runs: 9 }),
        }),
        NOW,
      ),
    ).toBe("HEARTBEAT_IO");
  });

  test("DEGRADED: a fresh watchdog reporting its latched fuse outranks WEDGED", () => {
    expect(
      classifyDevice(
        signals({
          lastSeen: NOW - 45 * MIN,
          watchdogLastSeen: NOW - 2 * MIN,
          watchdog: makeWatchdogBody({ degraded: true }),
        }),
        NOW,
      ),
    ).toBe("DEGRADED");
  });

  test("a stale degraded body is NOT trusted (watchdog channel silent)", () => {
    expect(
      classifyDevice(
        signals({
          lastSeen: NOW - 45 * MIN,
          watchdogLastSeen: NOW - 2 * HOUR,
          watchdog: makeWatchdogBody({ degraded: true }),
        }),
        NOW,
      ),
    ).toBe("LATE"); // daemon seen 45m ago → dual silence under the DARK bar
  });

  test("dual-channel DARK: both channels silent past an hour; short dual silence is LATE", () => {
    expect(
      classifyDevice(signals({ lastSeen: NOW - 3 * HOUR, watchdogLastSeen: NOW - 2 * HOUR }), NOW),
    ).toBe("DARK");
    expect(
      classifyDevice(signals({ lastSeen: NOW - 50 * MIN, watchdogLastSeen: NOW - 50 * MIN }), NOW),
    ).toBe("LATE");
  });

  test("a never-seen device is LATE from added_at, aging into DARK", () => {
    expect(classifyDevice(signals({ lastSeen: null, addedAt: NOW - 5 * MIN }), NOW)).toBe("LATE");
    expect(classifyDevice(signals({ lastSeen: null, addedAt: NOW - 25 * HOUR }), NOW)).toBe("DARK");
  });

  // Three uptime resets inside the 90m window (each drop = a restart),
  // with normal uptime growth between them.
  const loopingHistory = [
    { ts: NOW - 85 * MIN, uptime_s: 4000 },
    { ts: NOW - 70 * MIN, uptime_s: 60 }, // reset 1
    { ts: NOW - 55 * MIN, uptime_s: 960 },
    { ts: NOW - 40 * MIN, uptime_s: 120 }, // reset 2
    { ts: NOW - 25 * MIN, uptime_s: 1020 },
    { ts: NOW - 10 * MIN, uptime_s: 30 }, // reset 3
  ];

  test("CRASH_LOOPING: unexplained uptime resets, even while checkins keep arriving", () => {
    expect(
      classifyDevice(signals({ daemonHistory: loopingHistory, checkin: makeCheckinBody() }), NOW),
    ).toBe("CRASH_LOOPING");
  });

  test("journal-explained restarts never read as a crash loop", () => {
    // One journal entry per derived boot instant (ts − uptime).
    const exit_journal_tail = loopingHistory
      .slice(1)
      .map((h) => ({ ts: h.ts - h.uptime_s * 1000, reason: "update_swap", code: 75 }));
    expect(
      classifyDevice(
        signals({
          daemonHistory: loopingHistory,
          checkin: makeCheckinBody({ exit_journal_tail }),
        }),
        NOW,
      ),
    ).toBe("HEALTHY");
  });
});

describe("classifyDevice scales its bars with the device's own interval_s", () => {
  // TOKENLEADER_INTERVAL_SEC stretches to 24h; a fixed 30-minute wedge bar
  // would classify a healthy hourly-cadence daemon WEDGED and auto-restart
  // it forever. Bars: late = 3 ticks, wedge = 3 ticks + 15 min, both
  // floored at the default-cadence values.
  const hourly = makeCheckinBody({ interval_s: 3600 });

  test("threshold helpers: scaled for slow cadences, floored for fast ones", () => {
    expect(lateThresholdMs(300)).toBe(15 * MIN);
    expect(wedgeThresholdMs(300)).toBe(30 * MIN);
    expect(lateThresholdMs(5)).toBe(15 * MIN); // floor, never below default
    expect(wedgeThresholdMs(5)).toBe(30 * MIN);
    expect(lateThresholdMs(3600)).toBe(3 * HOUR);
    expect(wedgeThresholdMs(3600)).toBe(3 * HOUR + 15 * MIN);
    expect(staleHeartbeatRunsFor(300)).toBe(8); // the client fuse's floor
    expect(staleHeartbeatRunsFor(3600)).toBe(90); // 3 ticks in 120s firings
  });

  test("45min of silence WEDGES a default-cadence daemon but is HEALTHY at interval_s=3600", () => {
    const silent45m = { lastSeen: NOW - 45 * MIN, watchdogLastSeen: NOW - 2 * MIN };
    expect(classifyDevice(signals(silent45m), NOW)).toBe("WEDGED");
    expect(classifyDevice(signals({ ...silent45m, checkin: hourly }), NOW)).toBe("HEALTHY");
  });

  test("the scaled ladder: LATE past 3 ticks, WEDGED only past 3 ticks + 15min", () => {
    const live = { watchdogLastSeen: NOW - 2 * MIN, checkin: hourly };
    expect(classifyDevice(signals({ ...live, lastSeen: NOW - 190 * MIN }), NOW)).toBe("LATE");
    expect(classifyDevice(signals({ ...live, lastSeen: NOW - 200 * MIN }), NOW)).toBe("WEDGED");
  });

  test("stale-heartbeat runs mirror the client watchdog's staleRunsFor", () => {
    // 50 unchanged 120s firings is a frozen heartbeat at the default
    // cadence but routine for an hourly tick (heartbeats move on progress).
    const fresh = { lastSeen: NOW - 2 * MIN, watchdogLastSeen: NOW - 2 * MIN, checkin: hourly };
    expect(
      classifyDevice(
        signals({ ...fresh, watchdog: makeWatchdogBody({ heartbeat_age_runs: 50 }) }),
        NOW,
      ),
    ).toBe("HEALTHY");
    expect(
      classifyDevice(
        signals({ ...fresh, watchdog: makeWatchdogBody({ heartbeat_age_runs: 90 }) }),
        NOW,
      ),
    ).toBe("HEARTBEAT_IO");
  });
});

describe("watchdogCapableVersion", () => {
  test("v0.6.0+ ships the watchdog; dev/unknown/older builds never do", () => {
    expect(watchdogCapableVersion("v0.6.0")).toBe(true);
    expect(watchdogCapableVersion("0.6.1")).toBe(true);
    expect(watchdogCapableVersion("v1.0.0")).toBe(true);
    expect(watchdogCapableVersion("v0.5.9")).toBe(false);
    expect(watchdogCapableVersion("dev")).toBe(false);
    expect(watchdogCapableVersion("")).toBe(false);
    expect(watchdogCapableVersion(null)).toBe(false);
  });
});

describe("countUnexplainedResets", () => {
  const history = [
    { ts: NOW - 200 * MIN, uptime_s: 900 },
    { ts: NOW - 190 * MIN, uptime_s: 30 }, // reset OUTSIDE the 90m window
    { ts: NOW - 60 * MIN, uptime_s: 7000 },
    { ts: NOW - 40 * MIN, uptime_s: 120 }, // reset inside
    { ts: NOW - 20 * MIN, uptime_s: 60 }, // reset inside
  ];

  test("old resets fall out of the window; in-window unexplained ones count", () => {
    expect(countUnexplainedResets(history, [], NOW)).toBe(2);
    expect(2).toBeLessThan(CRASH_LOOP_THRESHOLD);
  });

  test("a journal entry near the derived boot instant explains the reset", () => {
    const journal = [{ ts: NOW - 40 * MIN - 120_000, reason: "recycle", code: 75 }];
    expect(countUnexplainedResets(history, journal, NOW)).toBe(1);
  });

  test("null-uptime rows (header-only checkins) never fabricate a reset", () => {
    const mixed = [
      { ts: NOW - 30 * MIN, uptime_s: 500 },
      { ts: NOW - 20 * MIN, uptime_s: null },
      { ts: NOW - 10 * MIN, uptime_s: 600 },
    ];
    expect(countUnexplainedResets(mixed, [], NOW)).toBe(0);
  });
});

describe("body sanitizers", () => {
  test("devicePlatformHasWatchdog: darwin yes, linux no, ABSENT yes (pre-v0.7 is all darwin)", () => {
    expect(devicePlatformHasWatchdog("darwin-arm64")).toBe(true);
    expect(devicePlatformHasWatchdog("darwin-x64")).toBe(true);
    expect(devicePlatformHasWatchdog("linux-x64")).toBe(false);
    expect(devicePlatformHasWatchdog("linux-arm64")).toBe(false);
    // The default MUST stay true: every fielded daemon before v0.7 sends no
    // platform at all, and every one of them is a Mac that still needs to
    // converge onto the watchdog.
    expect(devicePlatformHasWatchdog(null)).toBe(true);
    expect(devicePlatformHasWatchdog(undefined)).toBe(true);
    expect(devicePlatformHasWatchdog("")).toBe(true);
  });

  test("sanitizeCheckinBody keeps a platform token and drops a junk one", () => {
    expect(sanitizeCheckinBody({ platform: "linux-arm64" })?.platform).toBe("linux-arm64");
    expect(sanitizeCheckinBody({ platform: 42 })?.platform).toBeUndefined();
    expect(sanitizeCheckinBody({})?.platform).toBeUndefined();
  });

  test("sanitizeCheckinBody: non-objects are null; junk fields fall to defaults; tail is filtered + capped", () => {
    expect(sanitizeCheckinBody("nope")).toBeNull();
    expect(sanitizeCheckinBody(null)).toBeNull();
    expect(sanitizeCheckinBody([1, 2])).toBeNull();

    const out = sanitizeCheckinBody({
      uptime_s: -5, // negative → default
      tick_seq: "9", // wrong type → default
      consec_failures: 2,
      last_error: 42, // wrong type → null
      drift_ms: -1500, // negative drift is legitimate
      exit_journal_tail: [
        { ts: 1, reason: "ok", code: 0 },
        { ts: "bad", reason: "x", code: 0 }, // dropped
        "junk", // dropped
        { ts: 2, reason: "y".repeat(500), code: 75 }, // reason capped
      ],
      extra_field: "ignored",
    });
    expect(out).not.toBeNull();
    expect(out!.uptime_s).toBe(0);
    expect(out!.tick_seq).toBe(0);
    expect(out!.consec_failures).toBe(2);
    expect(out!.last_error).toBeNull();
    expect(out!.drift_ms).toBe(-1500);
    expect(out!.exit_journal_tail.length).toBe(2);
    expect(out!.exit_journal_tail[1]!.reason.length).toBe(128);
  });

  test("sanitizeCheckinBody: interval_s is clamped to the daemon's own config bounds", () => {
    // Absent/mistyped → the 5-minute default (pre-reporting daemons must
    // classify exactly as before).
    expect(sanitizeCheckinBody({})!.interval_s).toBe(300);
    expect(sanitizeCheckinBody({ interval_s: "3600" })!.interval_s).toBe(300);
    expect(sanitizeCheckinBody({ interval_s: Number.NaN })!.interval_s).toBe(300);
    expect(sanitizeCheckinBody({ interval_s: 3600 })!.interval_s).toBe(3600);
    // A lying body can't stretch thresholds past the config clamp [5, 86400].
    expect(sanitizeCheckinBody({ interval_s: 1 })!.interval_s).toBe(5);
    expect(sanitizeCheckinBody({ interval_s: 1e9 })!.interval_s).toBe(86400);
    expect(sanitizeCheckinBody({ interval_s: 600.4 })!.interval_s).toBe(600);
  });

  test("sanitizeWatchdogBody: coerces a partial body, rejects non-objects", () => {
    expect(sanitizeWatchdogBody(7)).toBeNull();
    const out = sanitizeWatchdogBody({ heartbeat_age_runs: 9, degraded: "yes" });
    expect(out).not.toBeNull();
    expect(out!.heartbeat_age_runs).toBe(9);
    expect(out!.degraded).toBe(false); // wrong type → default
    expect(out!.watchdog_version).toBe("");
  });
});

// --- alert sweep -------------------------------------------------------------

describe("sweepFleetAlerts", () => {
  const SECRET = "sweep-machine-secret";
  let harness: ReturnType<typeof createTestApp>;
  let app: ReturnType<typeof createTestApp>["app"];
  let store: ReturnType<typeof createTestApp>["store"];

  beforeAll(() => {
    harness = createTestApp({ scheduleAlertSweep: false });
    app = harness.app;
    store = harness.store;
  });

  afterAll(async () => {
    await harness.cleanup();
  });

  let msgCounter = 0;
  async function claim(user: string, label: string): Promise<number> {
    const res = await app.request(
      new Request("http://x/ingest", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-tokenleader-secret": SECRET,
          "x-tokenleader-device": label,
        },
        body: JSON.stringify({
          events: [makeTokenEvent({ user, messageId: `sweep-${msgCounter++}` })],
        }),
      }),
    );
    expect(res.status).toBe(200);
    return store.listUserDevices(user)[0]!.id;
  }

  function setTimes(user: string, lastSeen: number | null, watchdogLastSeen: number | null): void {
    store.db
      .prepare("UPDATE user_devices SET last_seen = ?, watchdog_last_seen = ? WHERE username = ?")
      .run(lastSeen, watchdogLastSeen, user);
  }

  function webhookStub(): { calls: { url: string; text: string }[]; fetchImpl: typeof fetch } {
    const calls: { url: string; text: string }[] = [];
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      calls.push({
        url: String(url),
        text: (JSON.parse(String(init?.body)) as { text: string }).text,
      });
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  const quiet = (): void => {}; // silence sweep logs in test output

  test("WEDGED: 1h age gate, then one alert + device-targeted restart, deduped afterwards", async () => {
    const deviceId = await claim("sam", "mbp");
    const t0 = Date.now();
    setTimes("sam", t0 - 45 * MIN, t0 - 2 * MIN);
    const hook = webhookStub();

    // First observation: state just entered tracking — under the age gate.
    const first = await sweepFleetAlerts({
      store,
      webhookUrl: "https://hooks.example/x",
      suppressed: false,
      now: t0,
      fetchImpl: hook.fetchImpl,
      log: quiet,
    });
    expect(first.length).toBe(1);
    expect(first[0]!.state).toBe("WEDGED");
    expect(first[0]!.action).toBe("observed");
    expect(hook.calls.length).toBe(0);

    // An hour later (watchdog still checking in): alert + heal.
    const t1 = t0 + ALERT_STATE_MIN_AGE_MS + MIN;
    setTimes("sam", t0 - 45 * MIN, t1 - 2 * MIN);
    const second = await sweepFleetAlerts({
      store,
      webhookUrl: "https://hooks.example/x",
      suppressed: false,
      now: t1,
      fetchImpl: hook.fetchImpl,
      log: quiet,
    });
    expect(second[0]!.action).toBe("alerted");
    expect(second[0]!.healQueued).toBe(true);
    expect(hook.calls.length).toBe(1);
    expect(hook.calls[0]!.text).toContain("sam/mbp");
    expect(hook.calls[0]!.text).toContain("WEDGED");
    const queued = store.listDirectives("sam")[0]!;
    expect(queued.verb).toBe("restart");
    expect(queued.device_id).toBe(deviceId);

    // Five minutes later: same state — deduped, and no second restart.
    const t2 = t1 + 5 * MIN;
    setTimes("sam", t0 - 45 * MIN, t2 - 2 * MIN);
    const third = await sweepFleetAlerts({
      store,
      webhookUrl: "https://hooks.example/x",
      suppressed: false,
      now: t2,
      fetchImpl: hook.fetchImpl,
      log: quiet,
    });
    expect(third[0]!.action).toBe("deduped");
    expect(third[0]!.healQueued).toBe(false);
    expect(hook.calls.length).toBe(1);
    expect(store.listDirectives("sam").filter((d) => d.verb === "restart").length).toBe(1);

    // Past the dedup window: pages again.
    const t3 = t1 + ALERT_DEDUP_MS + MIN;
    setTimes("sam", t0 - 45 * MIN, t3 - 2 * MIN);
    const fourth = await sweepFleetAlerts({
      store,
      webhookUrl: "https://hooks.example/x",
      suppressed: false,
      now: t3,
      fetchImpl: hook.fetchImpl,
      log: quiet,
    });
    expect(fourth[0]!.action).toBe("alerted");
    expect(hook.calls.length).toBe(2);
  });

  test("suppressed: the entire sweep is skipped — no pages, no heals, no state tracking", async () => {
    await claim("tess", "air");
    const t0 = Date.now();
    setTimes("tess", t0 - 45 * MIN, t0 - 2 * MIN);
    const hook = webhookStub();
    const out = await sweepFleetAlerts({
      store,
      webhookUrl: "https://hooks.example/x",
      suppressed: true,
      now: t0,
      fetchImpl: hook.fetchImpl,
      log: quiet,
    });
    expect(out).toEqual([]);
    expect(hook.calls.length).toBe(0);
    expect(store.listDirectives("tess").length).toBe(0);
  });

  test("no webhook: heal still queues, nothing is pushed", async () => {
    const deviceId = await claim("ugo", "mini");
    const t0 = Date.now();
    setTimes("ugo", t0 - 45 * MIN, t0 - 2 * MIN);
    await sweepFleetAlerts({ store, webhookUrl: null, suppressed: false, now: t0, log: quiet });
    const t1 = t0 + ALERT_STATE_MIN_AGE_MS + MIN;
    setTimes("ugo", t0 - 45 * MIN, t1 - 2 * MIN);
    const out = await sweepFleetAlerts({
      store,
      webhookUrl: null,
      suppressed: false,
      now: t1,
      log: quiet,
    });
    const ugo = out.find((d) => d.user === "ugo")!;
    expect(ugo.action).toBe("no_webhook");
    expect(ugo.healQueued).toBe(true);
    expect(store.listDirectives("ugo")[0]!.device_id).toBe(deviceId);
  });

  test("webhook failure is not recorded — the next sweep retries instead of deduping", async () => {
    await claim("vera", "imac");
    const t0 = Date.now();
    // Park earlier tests' devices in HEALTHY so this test's webhook call
    // counts are exact.
    for (const u of ["sam", "tess", "ugo"]) setTimes(u, t0, null);
    // Pre-0.6 DARK device (no watchdog ever): alerts, but never heals.
    setTimes("vera", t0 - 26 * 60 * MIN, null);
    await sweepFleetAlerts({
      store,
      webhookUrl: "https://hooks.example/x",
      suppressed: false,
      now: t0,
      fetchImpl: webhookStub().fetchImpl,
      log: quiet,
    });

    const t1 = t0 + ALERT_STATE_MIN_AGE_MS + MIN;
    let failCalls = 0;
    const failing = (async () => {
      failCalls++;
      throw new Error("socket reset");
    }) as unknown as typeof fetch;
    const failed = await sweepFleetAlerts({
      store,
      webhookUrl: "https://hooks.example/x",
      suppressed: false,
      now: t1,
      fetchImpl: failing,
      log: quiet,
    });
    const vera = failed.find((d) => d.user === "vera")!;
    expect(vera.state).toBe("DARK");
    expect(vera.action).toBe("webhook_failed");
    expect(vera.healQueued).toBe(false); // only WEDGED heals
    expect(failCalls).toBe(1);

    // Next sweep, webhook recovered: the alert goes out (no false dedup).
    const hook = webhookStub();
    const t2 = t1 + 5 * MIN;
    const retried = await sweepFleetAlerts({
      store,
      webhookUrl: "https://hooks.example/x",
      suppressed: false,
      now: t2,
      fetchImpl: hook.fetchImpl,
      log: quiet,
    });
    expect(retried.find((d) => d.user === "vera")!.action).toBe("alerted");
    expect(hook.calls.some((c) => c.text.includes("vera/imac"))).toBe(true);
    expect(store.listDirectives("vera").length).toBe(0);
  });

  // Park every user claimed by an earlier test in HEALTHY so cross-test
  // sweeps stay quiet (fresh lastSeen, no watchdog, version null).
  const PRIOR_USERS = ["sam", "tess", "ugo", "vera"];
  function park(users: string[], t: number): void {
    for (const u of users) setTimes(u, t, null);
  }

  test("HEARTBEAT_IO pages after the 1h gate but NEVER queues a restart", async () => {
    const deviceId = await claim("wanda", "studio");
    const t0 = Date.now();
    park(PRIOR_USERS, t0);
    // Daemon checkins fresh while a fresh watchdog swears the heartbeat
    // file is frozen — the disk contradiction that alerts and never kills.
    const setIo = (now: number): void => {
      setTimes("wanda", now - 2 * MIN, now - 2 * MIN);
      store.saveDeviceCheckinState(
        "wanda",
        deviceId,
        "watchdog",
        JSON.stringify(makeWatchdogBody({ heartbeat_age_runs: 9 })),
        now,
      );
    };
    setIo(t0);
    const hook = webhookStub();
    const sweep = (now: number) =>
      sweepFleetAlerts({
        store,
        webhookUrl: "https://hooks.example/x",
        suppressed: false,
        now,
        fetchImpl: hook.fetchImpl,
        log: quiet,
      });

    const first = await sweep(t0);
    const w0 = first.find((d) => d.user === "wanda")!;
    expect(w0.state).toBe("HEARTBEAT_IO");
    expect(w0.action).toBe("observed");

    const t1 = t0 + ALERT_STATE_MIN_AGE_MS + MIN;
    setIo(t1);
    const second = await sweep(t1);
    const w1 = second.find((d) => d.user === "wanda")!;
    expect(w1.action).toBe("alerted");
    expect(w1.healQueued).toBe(false);
    expect(hook.calls.some((c) => c.text.includes("HEARTBEAT_IO"))).toBe(true);
    // "Alerts and never kills": no restart directive, ever.
    expect(store.listDirectives("wanda").filter((d) => d.verb === "restart").length).toBe(0);
  });

  test("convergence: a fresh v0.6 daemon with a silent watchdog gets ONE reinstall_watchdog", async () => {
    const deviceId = await claim("yves", "mbp14");
    const t0 = Date.now();
    park([...PRIOR_USERS, "wanda"], t0);
    store.db
      .prepare("UPDATE user_devices SET version = ? WHERE username = ?")
      .run("v0.6.0", "yves");
    setTimes("yves", t0 - 2 * MIN, null); // daemon fresh, watchdog NEVER
    const sweep = (now: number) =>
      sweepFleetAlerts({ store, webhookUrl: null, suppressed: false, now, log: quiet });
    const reinstalls = () =>
      store.listDirectives("yves").filter((d) => d.verb === "reinstall_watchdog");

    await sweep(t0);
    expect(reinstalls().length).toBe(1);
    expect(reinstalls()[0]!.device_id).toBe(deviceId);
    // Next sweep: the live directive dedups — nudged, not spammed.
    await sweep(t0 + 5 * MIN);
    expect(reinstalls().length).toBe(1);
    // A watchdog checkin inside the 10-min window ends the nudging even
    // past the directive-dedup horizon.
    store.db
      .prepare("UPDATE pending_directives SET executed_at = ?, result = 'ok' WHERE username = ?")
      .run(t0, "yves");
    const t1 = t0 + ALERT_DEDUP_MS + MIN;
    setTimes("yves", t1 - 2 * MIN, t1 - 5 * MIN);
    await sweep(t1);
    expect(reinstalls().length).toBe(1);

    // Pre-0.6 and unknown builds are NEVER queued (no poking a dev build).
    await claim("zola", "old-imac");
    store.db
      .prepare("UPDATE user_devices SET version = ? WHERE username = ?")
      .run("v0.5.9", "zola");
    setTimes("zola", t0 - 2 * MIN, null);
    await sweep(t0 + 10 * MIN);
    expect(store.listDirectives("zola").length).toBe(0);
  });

  test("convergence: a LINUX device is never nudged — it has no watchdog by design", async () => {
    // systemd is the supervisor on Linux (Restart=always +
    // StartLimitIntervalSec=0), so the watchdog channel is silent FOREVER by
    // design. Without this gate the sweep queued a reinstall_watchdog at
    // every Linux device every dedup window: a fake self-heal loop that also
    // burned the one-directive-per-checkin slot. Verified in Docker: a real
    // Linux daemon checks in with platform="linux-arm64",
    // watchdog_installed=null, and classifies HEALTHY.
    const deviceId = await claim("linus", "vps01");
    const t0 = Date.now();
    park([...PRIOR_USERS, "wanda", "yves", "zola", "noor"], t0);
    store.db
      .prepare("UPDATE user_devices SET version = ? WHERE username = ?")
      .run("v0.7.0", "linus");
    setTimes("linus", t0 - 2 * MIN, null); // daemon fresh, watchdog NEVER
    store.saveDeviceCheckinState(
      "linus",
      deviceId,
      "daemon",
      JSON.stringify(makeCheckinBody({ watchdog_installed: null, platform: "linux-arm64" })),
      t0,
    );
    const sweep = (now: number) =>
      sweepFleetAlerts({ store, webhookUrl: null, suppressed: false, now, log: quiet });

    const rows = await sweep(t0);
    expect(store.listDirectives("linus").length).toBe(0);
    // …and a missing watchdog must not make it look broken either.
    expect(rows.find((d) => d.user === "linus")).toBeUndefined();

    // Still quiet a full dedup window later — this is the "forever" part.
    await sweep(t0 + ALERT_DEDUP_MS + MIN);
    expect(store.listDirectives("linus").length).toBe(0);
  });

  test("convergence: a DARWIN device that reports its platform is still nudged", async () => {
    // The gate must not accidentally silence macOS. v0.7+ darwin daemons send
    // platform="darwin-*"; every daemon before v0.7 sends nothing at all, and
    // all of those are darwin — so an ABSENT platform must keep converging or
    // the whole fielded fleet would stop.
    const deviceId = await claim("dana", "mbp16");
    const t0 = Date.now();
    park([...PRIOR_USERS, "wanda", "yves", "zola", "noor", "linus"], t0);
    store.db
      .prepare("UPDATE user_devices SET version = ? WHERE username = ?")
      .run("v0.7.0", "dana");
    setTimes("dana", t0 - 2 * MIN, null);
    store.saveDeviceCheckinState(
      "dana",
      deviceId,
      "daemon",
      JSON.stringify(makeCheckinBody({ watchdog_installed: null, platform: "darwin-arm64" })),
      t0,
    );
    await sweepFleetAlerts({ store, webhookUrl: null, suppressed: false, now: t0, log: quiet });
    expect(store.listDirectives("dana").filter((d) => d.verb === "reinstall_watchdog").length).toBe(
      1,
    );
  });

  test("WATCHDOG_MISSING: watchdog_installed=false pages after 1h, dedups, resets on recovery", async () => {
    const deviceId = await claim("noor", "air13");
    const t0 = Date.now();
    park([...PRIOR_USERS, "wanda", "yves", "zola"], t0);
    const report = (now: number): void => {
      setTimes("noor", now - 2 * MIN, null);
      store.saveDeviceCheckinState(
        "noor",
        deviceId,
        "daemon",
        JSON.stringify(makeCheckinBody({ watchdog_installed: false })),
        now,
      );
    };
    const hook = webhookStub();
    const sweep = (now: number) =>
      sweepFleetAlerts({
        store,
        webhookUrl: "https://hooks.example/x",
        suppressed: false,
        now,
        fetchImpl: hook.fetchImpl,
        log: quiet,
      });
    const noorCalls = () => hook.calls.filter((c) => c.text.includes("noor/air13"));

    report(t0);
    const first = await sweep(t0);
    const n0 = first.find((d) => d.user === "noor")!;
    expect(n0.state).toBe("WATCHDOG_MISSING"); // the device itself is HEALTHY
    expect(n0.action).toBe("observed");
    expect(noorCalls().length).toBe(0);

    // Held past the 1h gate: pages once, then dedups.
    const t1 = t0 + ALERT_STATE_MIN_AGE_MS + MIN;
    report(t1);
    const second = await sweep(t1);
    expect(second.find((d) => d.user === "noor")!.action).toBe("alerted");
    expect(noorCalls().length).toBe(1);
    expect(noorCalls()[0]!.text).toContain("watchdog_installed=false");
    const t2 = t1 + 5 * MIN;
    report(t2);
    expect((await sweep(t2)).find((d) => d.user === "noor")!.action).toBe("deduped");
    expect(noorCalls().length).toBe(1);

    // The watchdog comes alive: the flag clears entirely...
    const t3 = t2 + 5 * MIN;
    report(t3);
    setTimes("noor", t3 - 2 * MIN, t3 - 2 * MIN);
    expect((await sweep(t3)).find((d) => d.user === "noor")).toBeUndefined();
    // ...and a relapse (watchdog silent again, past its 15-min freshness)
    // starts a FRESH 1h clock instead of paging at once.
    const t4 = t3 + 20 * MIN;
    report(t4);
    expect((await sweep(t4)).find((d) => d.user === "noor")!.action).toBe("observed");
  });

  test("born-dark pre-watchdog devices page ONCE, forever deduped until revived", async () => {
    await claim("odin", "relic");
    const t0 = Date.now();
    const others = [...PRIOR_USERS, "wanda", "yves", "zola", "noor"];
    // Dead a month before the sweep ever observed it (the deploy-day case).
    setTimes("odin", t0 - 30 * 24 * HOUR, null);
    const hook = webhookStub();
    const sweep = (now: number) => {
      park(others, now);
      return sweepFleetAlerts({
        store,
        webhookUrl: "https://hooks.example/x",
        suppressed: false,
        now,
        fetchImpl: hook.fetchImpl,
        log: quiet,
      });
    };
    const odinCalls = () => hook.calls.filter((c) => c.text.includes("odin/relic"));

    const first = await sweep(t0);
    expect(first.find((d) => d.user === "odin")!.action).toBe("observed"); // 1h gate
    const t1 = t0 + ALERT_STATE_MIN_AGE_MS + MIN;
    const second = await sweep(t1);
    expect(second.find((d) => d.user === "odin")!.action).toBe("alerted");
    expect(odinCalls().length).toBe(1);
    expect(odinCalls()[0]!.text).toContain("will not re-page");
    // Way past the 6h dedup window: STILL deduped — no deploy-day storm.
    const t2 = t1 + 2 * ALERT_DEDUP_MS;
    const third = await sweep(t2);
    expect(third.find((d) => d.user === "odin")!.action).toBe("deduped");
    expect(odinCalls().length).toBe(1);

    // Revival: one fresh checkin resets the streak.
    const t3 = t2 + 5 * MIN;
    setTimes("odin", t3 - 2 * MIN, null);
    expect((await sweep(t3)).find((d) => d.user === "odin")).toBeUndefined(); // HEALTHY

    // Dying AGAIN under our watch is a WATCHED crossing (the sweep sees the
    // DARK transition as it happens) — normal 6h dedup, it re-pages.
    const died = t3 - 2 * MIN;
    const t4 = died + PRE_WATCHDOG_DARK_MS + 5 * MIN; // first sweep past the bar
    const darkAgain = await sweep(t4);
    expect(darkAgain.find((d) => d.user === "odin")!.state).toBe("DARK");
    expect(darkAgain.find((d) => d.user === "odin")!.action).toBe("observed");
    const t5 = t4 + ALERT_STATE_MIN_AGE_MS + MIN;
    const paged = await sweep(t5);
    expect(paged.find((d) => d.user === "odin")!.action).toBe("alerted");
    expect(odinCalls().length).toBe(2);
    expect(odinCalls()[1]!.text).not.toContain("will not re-page");
  });
});
