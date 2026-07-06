// Fleet classification + alert sweep (docs/resilience.md, server half).
// classifyDevice is pure — the matrix below pins every state transition,
// CRITICALLY the version-aware rule: watchdog-silence states (WEDGED,
// dual-channel DARK) apply ONLY to devices that have ever sent a watchdog
// checkin; pre-0.6 devices classify on last_seen alone. The sweep tests
// drive a real Store through the 1h age gate, the 6h dedup, suppression,
// and the WEDGED → device-targeted restart auto-heal.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestApp, jsonOf, makeTokenEvent } from "../test-helpers.ts";
import type { CheckinBody, WatchdogCheckinBody } from "../types.ts";
import {
  ALERT_DEDUP_MS,
  ALERT_STATE_MIN_AGE_MS,
  classifyDevice,
  countUnexplainedResets,
  CRASH_LOOP_THRESHOLD,
  type DeviceSignals,
  sanitizeCheckinBody,
  sanitizeWatchdogBody,
  sweepFleetAlerts,
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

function makeCheckinBody(overrides: Partial<CheckinBody> = {}): CheckinBody {
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
});
