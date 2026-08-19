import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { makeTmpDirSync } from "../test-helpers.ts";
import { Store } from "./db.ts";
import { CursorMirror, type CursorMirrorOpts } from "./cursor-mirror.ts";
import { mapCursorDashboardEvent } from "../parser/cursor-api.ts";
import { buildApp } from "./main.ts";

// A logger that swallows output so test runs stay clean. We can grab
// captured records by checking `recorded` after the fact.
function silentLogger() {
  const recorded: Array<{ level: string; msg: string; data: unknown }> = [];
  return {
    recorded,
    log: {
      info: (msg: string, data?: Record<string, unknown>) =>
        recorded.push({ level: "info", msg, data }),
      warn: (msg: string, data?: Record<string, unknown>) =>
        recorded.push({ level: "warn", msg, data }),
      error: (msg: string, data?: Record<string, unknown>) =>
        recorded.push({ level: "error", msg, data }),
    },
  };
}

/**
 * Build a fake fetch that serves a fixed set of Cursor usage events
 * with proper pagination. Returns the fetch impl + a `calls` array so
 * tests can assert how many requests were made.
 */
function fakeCursorApi(events: Array<Record<string, unknown>>) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const pageSize = 100;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const f = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ url, body });

    // Filter by startDate if given.
    const startDate = typeof body.startDate === "number" ? body.startDate : 0;
    const filtered = events.filter((e) => Number(e.timestamp) > startDate);
    // API in production returns newest-first; mirror that here.
    filtered.sort((a, b) => Number(b.timestamp) - Number(a.timestamp));

    const page = Number(body.page ?? 1);
    const start = (page - 1) * pageSize;
    const pageEvents = filtered.slice(start, start + pageSize);
    const numPages = Math.max(1, Math.ceil(filtered.length / pageSize));

    return new Response(
      JSON.stringify({
        totalUsageEventsCount: filtered.length,
        pagination: {
          numPages,
          currentPage: page,
          pageSize,
          hasNextPage: page < numPages,
          hasPreviousPage: page > 1,
        },
        usageEvents: pageEvents,
      }),
      { headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}

function mkEvent(
  ts: number,
  email: string,
  opts: {
    model?: string;
    input?: number;
    output?: number;
    cents?: number;
    /** Replaces the whole tokenUsage object — for fractional or absent counts. */
    tokenUsage?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  return {
    timestamp: String(ts),
    userEmail: email,
    model: opts.model ?? "claude-opus-4-7",
    kind: "Free",
    maxMode: false,
    isTokenBasedCall: true,
    tokenUsage: opts.tokenUsage ?? {
      inputTokens: opts.input ?? 100,
      outputTokens: opts.output ?? 50,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      totalCents: opts.cents ?? 12.34,
    },
    chargedCents: 0,
  };
}

const USER_MAP = {
  "alice@example.com": "alice",
  "bob@example.com": "bob",
} as const;

describe("CursorMirror", () => {
  let tmpDir: string;
  let rmTmpDir: () => void;
  let dbPath: string;
  let store: Store;

  beforeEach(() => {
    ({ dir: tmpDir, cleanup: rmTmpDir } = makeTmpDirSync("cursor-mirror-test-"));
    dbPath = join(tmpDir, "test.sqlite");
    store = new Store(dbPath);
  });
  afterEach(() => {
    store.close();
    rmTmpDir();
  });

  function build(
    events: Array<Record<string, unknown>>,
    extra: Partial<CursorMirrorOpts> = {},
  ): { mirror: CursorMirror; calls: { url: string; body: unknown }[] } {
    const { fetch: f, calls } = fakeCursorApi(events);
    const { log } = silentLogger();
    const mirror = new CursorMirror({
      store,
      token: "crsr_test",
      userMap: USER_MAP,
      fetchImpl: f,
      log,
      ...extra,
    });
    return { mirror, calls };
  }

  test("happy path: maps emails to users, inserts with tokens + cost", async () => {
    const events = [
      mkEvent(1_700_000_000_000, "alice@example.com", {
        input: 100,
        output: 200,
        cents: 12.34,
      }),
      mkEvent(1_700_000_500_000, "bob@example.com", {
        input: 300,
        output: 400,
        cents: 99.99,
      }),
    ];
    const { mirror } = build(events);
    const r = await mirror.tick();

    expect(r.fetched).toBe(2);
    expect(r.inserted).toBe(2);
    expect(r.duplicates).toBe(0);

    const lb = store.adminLeaderboard(0, Number.MAX_SAFE_INTEGER);
    const alice = lb.find((r) => r.user === "alice");
    const bob = lb.find((r) => r.user === "bob");
    expect(alice?.totalInputTokens).toBe(100);
    expect(alice?.totalOutputTokens).toBe(200);
    expect(bob?.totalInputTokens).toBe(300);

    // Cost was stored: query directly.
    const rows = store.db
      .prepare<{ user: string; tokens: number; costUsdMicros: number }, []>(
        "SELECT user, inputTokens+outputTokens AS tokens, costUsdMicros FROM events ORDER BY user",
      )
      .all();
    expect(rows).toHaveLength(2);
    // 12.34 cents = 123_400 micros, 99.99 cents = 999_900 micros.
    expect(rows.find((r) => r.user === "alice")?.costUsdMicros).toBe(123_400);
    expect(rows.find((r) => r.user === "bob")?.costUsdMicros).toBe(999_900);
  });

  test("dedup: a second tick over the same events inserts zero new rows", async () => {
    const events = [
      mkEvent(1_700_000_000_000, "alice@example.com"),
      mkEvent(1_700_000_500_000, "bob@example.com"),
    ];
    const { mirror } = build(events);
    await mirror.tick();
    // The watermark now sits at the max timestamp, so the second tick asks
    // startDate=max+1 and the fake API returns zero events.
    const r2 = await mirror.tick();
    expect(r2.inserted).toBe(0);
    expect(store.count()).toBe(2);
  });

  test("dedup on re-fetch of the same events from a cold start", async () => {
    const events = [
      mkEvent(1_700_000_000_000, "alice@example.com"),
      mkEvent(1_700_000_500_000, "bob@example.com"),
    ];
    // First mirror inserts.
    const m1 = build(events).mirror;
    await m1.tick();
    expect(store.count()).toBe(2);
    // Second mirror, fresh state, restored watermark via loadWatermark.
    // It asks startDate=maxTs+1 and the fake API returns zero — but to
    // prove dedup itself works, force the watermark to 0 so the API
    // returns BOTH events and they collide on UNIQUE events_dedup.
    const { fetch: f, calls } = fakeCursorApi(events);
    const { log } = silentLogger();
    const m2 = new CursorMirror({
      store,
      token: "crsr_test",
      userMap: USER_MAP,
      fetchImpl: f,
      log,
    });
    // Patch the private field via a typed escape hatch.
    (m2 as unknown as { watermarkLoaded: boolean; maxSeenTimestamp: number }).watermarkLoaded =
      true;
    (m2 as unknown as { watermarkLoaded: boolean; maxSeenTimestamp: number }).maxSeenTimestamp = 0;
    const r = await m2.tick();
    expect(r.inserted).toBe(0);
    expect(r.duplicates).toBe(2);
    expect(calls.length).toBeGreaterThan(0);
  });

  test("the daemon dashboard path dedups against a mirrored row for the same event", async () => {
    // A user can be on BOTH paths at once: mapped into the team mirror here
    // AND running `tokenleader login-cursor` on their laptop. Both write
    // source="cursor" rows carrying stored cost, so a dedup key that differs
    // between the paths double-counts real dollars. The keys agree only while
    // both spell the model the same way (cursorModel), which is why the
    // daemon path stores the slug and not the dashboard's display name.
    const ts = 1_700_000_000_000;
    const { mirror } = build([
      mkEvent(ts, "alice@example.com", { model: "gpt-5.3-codex", input: 100, output: 50 }),
    ]);
    expect((await mirror.tick()).inserted).toBe(1);

    // The same event as the personal dashboard returns it: same tokens, same
    // millisecond, slug plus a display name, and no event id.
    const viaDaemon = mapCursorDashboardEvent(
      {
        timestamp: ts,
        model: "gpt-5.3-codex",
        modelName: "Premium (Codex 5.3)",
        tokenUsage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
          totalCents: 12.34,
        },
      },
      "alice",
    );
    const r = store.insertMany([viaDaemon!]);
    expect(r.inserted).toBe(0);
    expect(r.duplicates).toBe(1);
  });

  test("dedups across paths when Cursor reports fractional or absent counts", async () => {
    // The counts are hashed into the key too, and Cursor reports fractional
    // tokens (and the team API omits the cache fields entirely). The mirror
    // used to hash the raw values while the daemon hashed clamped ones, so
    // 100.5 vs 101 — and "undefined" vs "0" — split the same event into two
    // rows, each carrying stored cost. cursorMessageId now normalises inside
    // the hash so neither caller can drift.
    const ts = 1_700_000_000_000;
    const { mirror } = build([
      mkEvent(ts, "alice@example.com", {
        model: "gpt-5.3-codex",
        tokenUsage: { inputTokens: 100.5, outputTokens: 5.5, totalCents: 12.34 },
      }),
    ]);
    expect((await mirror.tick()).inserted).toBe(1);

    const viaDaemon = mapCursorDashboardEvent(
      {
        timestamp: ts,
        model: "gpt-5.3-codex",
        tokenUsage: {
          inputTokens: 100.5,
          outputTokens: 5.5,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
          totalCents: 12.34,
        },
      },
      "alice",
    );
    const r = store.insertMany([viaDaemon!]);
    expect(r.inserted).toBe(0);
    expect(r.duplicates).toBe(1);
  });

  test("skips events whose email isn't in userMap", async () => {
    const events = [
      mkEvent(1_700_000_000_000, "alice@example.com"),
      mkEvent(1_700_000_500_000, "mallory@example.com"), // not mapped
      mkEvent(1_700_001_000_000, "bob@example.com"),
    ];
    const { mirror } = build(events);
    const r = await mirror.tick();
    expect(r.fetched).toBe(3);
    expect(r.inserted).toBe(2);
    expect(store.count()).toBe(2);
    const users = store.db
      .prepare<{ user: string }, []>("SELECT DISTINCT user FROM events ORDER BY user")
      .all()
      .map((r) => r.user);
    expect(users).toEqual(["alice", "bob"]);
  });

  test("complete tick persists the watermark; a fresh mirror resumes from it", async () => {
    const events = [
      mkEvent(1_700_000_000_000, "alice@example.com"),
      mkEvent(1_700_000_000_500, "alice@example.com"),
    ];
    const m1 = build(events).mirror;
    const r1 = await m1.tick();
    expect(r1.inserted).toBe(2);
    // Complete walk → watermark persisted to server_meta.
    expect(store.getMeta("cursor_watermark_ms")).toBe("1700000000500");

    // A fresh mirror (simulated restart) reloads the persisted watermark
    // and asks startDate = watermark+1, so nothing is refetched.
    const { mirror: m2, calls } = build(events);
    const r2 = await m2.tick();
    expect(calls[0]?.body).toMatchObject({ startDate: 1_700_000_000_501 });
    expect(r2.fetched).toBe(0);
    expect(store.count()).toBe(2);
  });

  test("pre-meta DB (cursor rows, no watermark key) re-walks from 0 and self-heals", async () => {
    // Rows exist (merged/migrated DB) but server_meta was never written.
    // The first tick must NOT trust MAX(timestamp) — it re-paginates from
    // sinceMs=0, dedups, and writes the key.
    const events = [
      mkEvent(1_700_000_000_000, "alice@example.com"),
      mkEvent(1_700_000_000_500, "alice@example.com"),
    ];
    const m1 = build(events).mirror;
    await m1.tick();
    store.db.prepare("DELETE FROM server_meta WHERE key = 'cursor_watermark_ms'").run();

    const { mirror: m2, calls } = build(events);
    const r = await m2.tick();
    // No startDate on the request (full-history walk)…
    expect((calls[0]?.body as { startDate?: number }).startDate).toBeUndefined();
    // …every row dedups, and the complete walk restores the key.
    expect(r.fetched).toBe(2);
    expect(r.inserted).toBe(0);
    expect(r.duplicates).toBe(2);
    expect(store.getMeta("cursor_watermark_ms")).toBe("1700000000500");
  });

  test("timestamps are stored as numbers and queryable by range", async () => {
    const events = [
      mkEvent(1_700_000_300_000, "alice@example.com"),
      mkEvent(1_700_000_100_000, "alice@example.com"),
      mkEvent(1_700_000_200_000, "alice@example.com"),
    ];
    const { mirror } = build(events);
    await mirror.tick();

    // Range query that should hit the (timestamp) index.
    const inRange = store.db
      .prepare<{ timestamp: number }, [number, number]>(
        "SELECT timestamp FROM events WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC",
      )
      .all(1_700_000_150_000, 1_700_000_250_000);
    expect(inRange.map((r) => r.timestamp)).toEqual([1_700_000_200_000]);

    // All events present, sortable.
    const all = store.db
      .prepare<{ timestamp: number }, []>("SELECT timestamp FROM events ORDER BY timestamp ASC")
      .all();
    expect(all.map((r) => r.timestamp)).toEqual([
      1_700_000_100_000, 1_700_000_200_000, 1_700_000_300_000,
    ]);
  });

  test("skips events with missing tokenUsage", async () => {
    const events = [
      mkEvent(1_700_000_000_000, "alice@example.com"),
      // synthetic non-token event
      {
        timestamp: "1700000100000",
        userEmail: "alice@example.com",
        model: "weird-model",
        kind: "Free",
        // no tokenUsage
      },
    ];
    const { mirror } = build(events);
    const r = await mirror.tick();
    expect(r.fetched).toBe(2);
    expect(r.inserted).toBe(1);
  });

  test("emails are matched case-insensitively", async () => {
    const events = [mkEvent(1_700_000_000_000, "Alice@Example.COM")];
    const { mirror } = build(events);
    const r = await mirror.tick();
    expect(r.inserted).toBe(1);
    const lb = store.adminLeaderboard(0, Number.MAX_SAFE_INTEGER);
    expect(lb[0]?.user).toBe("alice");
  });

  test("truncated backfill: watermark advances only on a complete walk", async () => {
    const BASE = 1_700_000_000_000;
    // 250 events = 3 pages at pageSize 100; cap the mirror at 2 pages/tick.
    const events = Array.from({ length: 250 }, (_, i) =>
      mkEvent(BASE + i * 1000, "alice@example.com"),
    );
    const globalMax = BASE + 249 * 1000;
    const { mirror } = build(events, { maxPagesPerTick: 2 });
    const priv = mirror as unknown as { maxSeenTimestamp: number; resumePage: number };

    // Tick 1 walks pages 1-2 (the NEWEST 200, pages are newest-first) and
    // is truncated: nothing persisted, watermark untouched, resume at 3.
    const r1 = await mirror.tick();
    expect(r1.fetched).toBe(200);
    expect(r1.inserted).toBe(200);
    expect(store.getMeta("cursor_watermark_ms")).toBeNull();
    expect(priv.maxSeenTimestamp).toBe(0);
    expect(priv.resumePage).toBe(3);

    // Tick 2 finishes page 3 (oldest 50) → complete walk persists the
    // global max and resets the resume page.
    const r2 = await mirror.tick();
    expect(r2.fetched).toBe(50);
    expect(r2.inserted).toBe(50);
    expect(store.count()).toBe(250);
    expect(priv.maxSeenTimestamp).toBe(globalMax);
    expect(store.getMeta("cursor_watermark_ms")).toBe(String(globalMax));
    expect(priv.resumePage).toBe(1);
  });

  test("fetch error mid-walk leaves both watermarks unchanged and resumes", async () => {
    const BASE = 1_700_000_000_000;
    const events = Array.from({ length: 150 }, (_, i) =>
      mkEvent(BASE + i * 1000, "alice@example.com"),
    );
    const { fetch: real } = fakeCursorApi(events);
    let failPage2 = true;
    const flaky = (async (input: any, init?: any) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (failPage2 && Number(body.page) === 2) {
        failPage2 = false;
        throw new Error("synthetic network error");
      }
      return real(input, init);
    }) as unknown as typeof fetch;
    const { log } = silentLogger();
    const mirror = new CursorMirror({
      store,
      token: "crsr_test",
      userMap: USER_MAP,
      fetchImpl: flaky,
      log,
    });

    const r1 = await mirror.tick(); // page 1 ok, page 2 errors → truncated
    expect(r1.fetched).toBe(100);
    expect(store.getMeta("cursor_watermark_ms")).toBeNull();

    const r2 = await mirror.tick(); // resumes at page 2, completes
    expect(r2.fetched).toBe(50);
    expect(store.count()).toBe(150);
    expect(store.getMeta("cursor_watermark_ms")).toBe(String(BASE + 149_000));
  });

  test("restart mid-backfill: fresh mirror re-walks the same sinceMs, no jump to ~now", async () => {
    const BASE = 1_700_000_000_000;
    const events = Array.from({ length: 250 }, (_, i) =>
      mkEvent(BASE + i * 1000, "alice@example.com"),
    );
    const globalMax = BASE + 249 * 1000;

    // Tick 1 (truncated) inserts the NEWEST 200 events. Under the old
    // MAX(timestamp) fallback a restart here would seed the watermark at
    // ~globalMax and skip the oldest 50 forever.
    const m1 = build(events, { maxPagesPerTick: 2 }).mirror;
    await m1.tick();
    expect(store.getMeta("cursor_watermark_ms")).toBeNull();
    expect(store.count()).toBe(200);

    // Simulated process restart: fresh Store connection + fresh mirror.
    const store2 = new Store(dbPath);
    const { fetch: f, calls } = fakeCursorApi(events);
    const { log } = silentLogger();
    const m2 = new CursorMirror({
      store: store2,
      token: "crsr_test",
      userMap: USER_MAP,
      fetchImpl: f,
      log,
    });
    try {
      const r = await m2.tick();
      // Watermark reloaded as 0 → the first request has NO startDate.
      expect((calls[0]?.body as { startDate?: number }).startDate).toBeUndefined();
      // Complete walk: every event present, including the oldest…
      expect(r.fetched).toBe(250);
      expect(store2.count()).toBe(250);
      const oldest = store2.db
        .prepare<{ ts: number }, []>("SELECT MIN(timestamp) AS ts FROM events")
        .get();
      expect(oldest?.ts).toBe(BASE);
      // …and the persisted watermark lands on the global max.
      expect(store2.getMeta("cursor_watermark_ms")).toBe(String(globalMax));
    } finally {
      store2.close();
    }
  });

  test("full clear resets the watermark; cleared Cursor history re-imports", async () => {
    const events = [
      mkEvent(1_700_000_000_000, "alice@example.com"),
      mkEvent(1_700_000_000_500, "alice@example.com"),
    ];
    const { fetch: f } = fakeCursorApi(events);
    const { log } = silentLogger();
    const mirror = new CursorMirror({
      store,
      token: "crsr_test",
      userMap: USER_MAP,
      fetchImpl: f,
      log,
    });
    const built = buildApp({
      dbPath,
      adminToken: "admin-tok",
      cursorMirror: mirror,
      scheduleCursorMirror: false,
      schedulePricingRefresh: false,
      scheduleBinaryMirror: false,
    });
    try {
      const r1 = await mirror.tick();
      expect(r1.inserted).toBe(2);
      expect(store.getMeta("cursor_watermark_ms")).toBe("1700000000500");

      const res = await built.app.request(
        new Request("http://x/admin/clear", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer admin-tok",
          },
          body: JSON.stringify({ scope: "full" }),
        }),
      );
      expect(res.status).toBe(200);
      // Persisted key gone + in-memory seed reset…
      expect(store.getMeta("cursor_watermark_ms")).toBeNull();
      // …so the next tick re-walks from 0 (no startDate) and re-imports
      // the now-cleared old events.
      const r2 = await mirror.tick();
      expect(r2.fetched).toBe(2);
      expect(r2.inserted).toBe(2);
      expect(store.getMeta("cursor_watermark_ms")).toBe("1700000000500");
    } finally {
      await built.stop();
      built.store.close();
    }
  });

  test("a tick that inserts rows invalidates buildApp's frozen stats cache; onInsert composes", async () => {
    const DAY = 86_400_000;
    const pastTs = Date.now() - 40 * DAY;
    const since = pastTs - DAY;
    const until = pastTs + DAY; // window ends in the past → frozen (24h TTL) entry
    const { fetch: f } = fakeCursorApi([mkEvent(pastTs, "alice@example.com", { cents: 50 })]);
    const { log } = silentLogger();
    let optsFired = 0;
    const mirror = new CursorMirror({
      store, // second connection onto the same WAL file buildApp opens below
      token: "crsr_test",
      userMap: USER_MAP,
      fetchImpl: f,
      log,
      onInsert: () => {
        optsFired += 1;
      },
    });
    const built = buildApp({
      dbPath,
      cursorMirror: mirror,
      scheduleCursorMirror: false,
      schedulePricingRefresh: false,
      scheduleBinaryMirror: false,
    });
    try {
      const url = `http://x/stats/admin?since=${since}&until=${until}`;
      const before = (await (await built.app.request(new Request(url))).json()) as {
        leaderboard: Array<{ user: string }>;
      };
      expect(before.leaderboard).toEqual([]);

      const r = await mirror.tick();
      expect(r.inserted).toBe(1);
      // buildApp CHAINED invalidation onto the injected hook — both fired:
      expect(optsFired).toBe(1);
      const after = (await (await built.app.request(new Request(url))).json()) as {
        leaderboard: Array<{ user: string }>;
      };
      expect(after.leaderboard.map((r) => r.user)).toEqual(["alice"]);

      // A tick that inserts nothing (pure dedup) must NOT fire the hook.
      const priv = mirror as unknown as {
        watermarkLoaded: boolean;
        maxSeenTimestamp: number;
      };
      priv.watermarkLoaded = true;
      priv.maxSeenTimestamp = 0;
      const r2 = await mirror.tick();
      expect(r2.inserted).toBe(0);
      expect(r2.duplicates).toBe(1);
      expect(optsFired).toBe(1);
    } finally {
      await built.stop();
      built.store.close();
    }
  });
});
