import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createTestApp, jsonOf, makeTmpDirSync, makeTokenEvent } from "../test-helpers.ts";
import type { TokenEvent } from "../types.ts";
import { MAX_TS_MS, Store } from "./db.ts";

/**
 * events_roll_day is AUTHORITATIVE: the stats statements read it and never
 * fall back to scanning `events`, so a maintenance path that forgets to
 * update it serves silently wrong numbers rather than slow ones. These tests
 * exist to make that impossible to ship.
 *
 * The oracle throughout is the PRE-ROLLUP SQL, reproduced verbatim below and
 * run against the raw `events` table. Every assertion is "the rollup-backed
 * statement emits exactly the rows the old statement would have emitted, in
 * exactly that order" — sequence equality, not set equality, because main.ts
 * accumulates costUsd with float `+=` over the emission order and float
 * addition is not associative.
 *
 * ONE DELIBERATE DEPARTURE from verbatim: rawAdminLeaderboard carries the
 * `, user ASC` tiebreak the shipped statement now carries. The pre-rollup
 * SQL had none, and an untiebroken ORDER BY is not a contract — measured, it
 * emits tied users ASCENDING on a 5.1M-row prod-shaped DB and DESCENDING on
 * a nine-row one, from the same code. The oracle encodes the direction prod
 * emits, which is the one byte-parity is protecting. See db.ts.
 */

const DAY = 86_400_000;
/** 2026-03-05T00:00:00Z — an arbitrary UTC midnight to anchor day math on. */
const D0 = Date.UTC(2026, 2, 5);

let dir: string;
let cleanupDir: () => void;
let store: Store;

beforeEach(() => {
  const t = makeTmpDirSync("tokenleader-rollup-");
  dir = t.dir;
  cleanupDir = t.cleanup;
  store = new Store(join(dir, "tl.sqlite"));
});

afterEach(() => {
  try {
    store.close();
  } catch {}
  cleanupDir();
});

let seq = 0;
function ev(overrides: Partial<TokenEvent> = {}): TokenEvent {
  seq += 1;
  return makeTokenEvent({
    sessionId: `s${seq}`,
    messageId: `m${seq}`,
    requestId: `r${seq}`,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// The oracle: the exact SQL these routes ran before the rollup existed.
// ---------------------------------------------------------------------------

const BUCKET_EXPR = {
  day: `strftime('%Y-%m-%d', timestamp/1000, 'unixepoch')`,
  week: `strftime('%G-W%V',   timestamp/1000, 'unixepoch')`,
  month: `strftime('%Y-%m',    timestamp/1000, 'unixepoch')`,
} as const;

function rawTimeseriesByUser(
  s: Store,
  bucket: keyof typeof BUCKET_EXPR,
  since: number,
  until: number,
) {
  return s.db
    .prepare<{ bucketKey: string }, [number, number]>(
      `SELECT ${BUCKET_EXPR[bucket]} AS bucketKey, user, model,
              COUNT(*)                              AS events,
              COALESCE(SUM(inputTokens), 0)         AS inputTokens,
              COALESCE(SUM(outputTokens), 0)        AS outputTokens,
              COALESCE(SUM(cacheCreationTokens), 0) AS cacheCreationTokens,
              COALESCE(SUM(cacheReadTokens), 0)     AS cacheReadTokens,
              COALESCE(SUM(reasoningTokens), 0)     AS reasoningTokens,
              COALESCE(SUM(costUsdMicros), 0)       AS storedCostMicros
         FROM events
        WHERE timestamp >= ? AND timestamp < ? AND messageType = 'assistant'
        GROUP BY bucketKey, user, model
        ORDER BY bucketKey ASC, user ASC, model ASC`,
    )
    .all(since, until);
}

function rawTimeseriesCountsByUser(
  s: Store,
  bucket: keyof typeof BUCKET_EXPR,
  since: number,
  until: number,
) {
  return s.db
    .prepare(
      `SELECT ${BUCKET_EXPR[bucket]} AS bucketKey, user,
              SUM(CASE WHEN messageType='user'      THEN 1 ELSE 0 END) AS userMessages,
              SUM(CASE WHEN messageType='assistant' THEN 1 ELSE 0 END) AS assistantMessages
         FROM events
        WHERE timestamp >= ? AND timestamp < ?
        GROUP BY bucketKey, user
        ORDER BY bucketKey ASC, user ASC`,
    )
    .all(since, until);
}

function rawAdminUserModel(s: Store, since: number, until: number) {
  return s.db
    .prepare(
      `SELECT user, model,
              COUNT(*)                              AS count,
              COALESCE(SUM(inputTokens), 0)         AS inputTokens,
              COALESCE(SUM(outputTokens), 0)        AS outputTokens,
              COALESCE(SUM(cacheCreationTokens), 0) AS cacheCreationTokens,
              COALESCE(SUM(cacheReadTokens), 0)     AS cacheReadTokens,
              COALESCE(SUM(reasoningTokens), 0)     AS reasoningTokens,
              COALESCE(SUM(costUsdMicros), 0)       AS storedCostMicros,
              COALESCE(SUM(CASE WHEN COALESCE(costUsdMicros,0)=0 THEN inputTokens         ELSE 0 END), 0) AS derivedInputTokens,
              COALESCE(SUM(CASE WHEN COALESCE(costUsdMicros,0)=0 THEN outputTokens        ELSE 0 END), 0) AS derivedOutputTokens,
              COALESCE(SUM(CASE WHEN COALESCE(costUsdMicros,0)=0 THEN cacheCreationTokens ELSE 0 END), 0) AS derivedCacheCreationTokens,
              COALESCE(SUM(CASE WHEN COALESCE(costUsdMicros,0)=0 THEN cacheReadTokens     ELSE 0 END), 0) AS derivedCacheReadTokens,
              COALESCE(SUM(CASE WHEN COALESCE(costUsdMicros,0)=0 THEN reasoningTokens     ELSE 0 END), 0) AS derivedReasoningTokens
         FROM events
        WHERE timestamp >= ? AND timestamp < ? AND messageType = 'assistant'
        GROUP BY user, model
        ORDER BY user ASC, model ASC`,
    )
    .all(since, until);
}

function rawAdminLeaderboard(s: Store, since: number, until: number) {
  return s.db
    .prepare(
      `SELECT user,
              COALESCE(SUM(CASE WHEN messageType='assistant' THEN inputTokens         ELSE 0 END), 0) AS totalInputTokens,
              COALESCE(SUM(CASE WHEN messageType='assistant' THEN outputTokens        ELSE 0 END), 0) AS totalOutputTokens,
              COALESCE(SUM(CASE WHEN messageType='assistant' THEN cacheCreationTokens ELSE 0 END), 0) AS totalCacheCreationTokens,
              COALESCE(SUM(CASE WHEN messageType='assistant' THEN cacheReadTokens     ELSE 0 END), 0) AS totalCacheReadTokens,
              COALESCE(SUM(CASE WHEN messageType='assistant' THEN reasoningTokens     ELSE 0 END), 0) AS totalReasoningTokens,
              SUM(CASE WHEN messageType='assistant' THEN 1 ELSE 0 END)                                AS eventCount,
              SUM(CASE WHEN messageType='user'      THEN 1 ELSE 0 END)                                AS userMessages,
              SUM(CASE WHEN messageType='assistant' THEN 1 ELSE 0 END)                                AS assistantMessages,
              COALESCE(MAX(timestamp), 0)                                                             AS lastEventAt,
              COUNT(DISTINCT CASE WHEN messageType='assistant' THEN model END)                        AS modelCount
         FROM events
        WHERE timestamp >= ? AND timestamp < ?
        GROUP BY user
        ORDER BY (totalInputTokens + totalOutputTokens
                  + totalCacheCreationTokens + totalCacheReadTokens) DESC, user ASC`,
    )
    .all(since, until);
}

function rawApiUsage(s: Store, since: number, until: number) {
  return s.db
    .prepare(
      `SELECT user, model,
              COALESCE(SUM(inputTokens), 0)         AS input,
              COALESCE(SUM(outputTokens), 0)        AS output,
              COALESCE(SUM(cacheCreationTokens), 0) AS cacheCreation,
              COALESCE(SUM(cacheReadTokens), 0)     AS cacheRead,
              COALESCE(SUM(reasoningTokens), 0)     AS reasoning,
              COALESCE(SUM(costUsdMicros), 0)       AS storedCostMicros
         FROM events
        WHERE timestamp >= ? AND timestamp < ? AND messageType = 'assistant'
        GROUP BY user, model
        ORDER BY user ASC, model ASC`,
    )
    .all(since, until);
}

/**
 * Every rollup-backed read, compared against the oracle over a spread of
 * windows: all-time, day-aligned (zero slivers — the shape every expensive
 * dashboard view uses), and deliberately non-aligned (both slivers live).
 */
function expectParity(s: Store, label: string): void {
  const windows: Array<[string, number, number]> = [
    ["all-time", 0, MAX_TS_MS],
    ["day-aligned", D0, D0 + 3 * DAY],
    ["sliver-heavy", D0 + 5 * 3_600_000, D0 + 3 * DAY + 7 * 3_600_000],
    ["inside-one-day", D0 + 3_600_000, D0 + 7_200_000],
    ["empty", D0, D0],
    ["from-negative", -7 * DAY, MAX_TS_MS],
  ];
  for (const [wname, since, until] of windows) {
    const where = `${label} / ${wname}`;
    for (const bucket of ["day", "week", "month"] as const) {
      // `s`, not the module-level `store`: the reopen/rebuild cases pass a
      // different Store, and comparing that one's oracle against the
      // module-level store would assert nothing.
      expect(s.timeseriesByUser(bucket, since, until), `${where} tsByUser ${bucket}`).toEqual(
        rawTimeseriesByUser(s, bucket, since, until) as never,
      );
      expect(
        s.timeseriesCountsByUser(bucket, since, until),
        `${where} tsCountsByUser ${bucket}`,
      ).toEqual(rawTimeseriesCountsByUser(s, bucket, since, until) as never);
    }
    expect(s.adminUserModel(since, until), `${where} adminUserModel`).toEqual(
      rawAdminUserModel(s, since, until) as never,
    );
    expect(s.apiUsageRange(since, until), `${where} apiUsageRange`).toEqual(
      rawApiUsage(s, since, until) as never,
    );
    // adminLeaderboard carries LEFT JOIN columns the oracle omits; compare
    // the aggregate columns it does produce, in emitted order.
    const got = s.adminLeaderboard(since, until).map((r) => ({
      user: r.user,
      totalInputTokens: r.totalInputTokens,
      totalOutputTokens: r.totalOutputTokens,
      totalCacheCreationTokens: r.totalCacheCreationTokens,
      totalCacheReadTokens: r.totalCacheReadTokens,
      totalReasoningTokens: r.totalReasoningTokens,
      eventCount: r.eventCount,
      userMessages: r.userMessages,
      assistantMessages: r.assistantMessages,
      lastEventAt: r.lastEventAt,
      modelCount: r.modelCount,
    }));
    expect(got, `${where} adminLeaderboard`).toEqual(rawAdminLeaderboard(s, since, until) as never);
  }
  // And the invariant the boot audit checks: the two tables agree on all
  // seven integer sums.
  expect(s.auditRollup({ repair: false }).ok, `${label} audit`).toBe(true);
}

/** A spread of users/models/kinds across four days, with cost and reasoning
 *  columns populated so the nullable-column COALESCEs are exercised — plus
 *  two deliberate TIE classes, because sort ties were the one thing this
 *  fixture was accidentally free of, and therefore the one class the parity
 *  sweep silently did not cover:
 *
 *    tieA/tieB   identical assistant traffic, so their token sums are equal
 *    idleA/idleB only messageType='user' rows, so every sum is 0 — not a
 *                contrivance, it is what any user who asked questions but
 *                got no billable completion in the window looks like.
 */
function seed(s: Store): void {
  const batch: TokenEvent[] = [];
  for (let d = 0; d < 4; d++) {
    for (const user of ["tieA", "tieB"]) {
      batch.push(
        ev({
          user,
          model: "claude-sonnet-4-5",
          timestamp: D0 + d * DAY + 3_600_000 + batch.length * 1000,
          inputTokens: 11,
          outputTokens: 22,
          cacheCreationTokens: 33,
          cacheReadTokens: 44,
        }),
      );
    }
    for (const user of ["idleA", "idleB"]) {
      batch.push(
        ev({
          user,
          model: "",
          messageType: "user",
          timestamp: D0 + d * DAY + 3_600_000 + batch.length * 1000,
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        }),
      );
    }
    for (const user of ["alice", "bob", "carol"]) {
      for (const model of ["claude-sonnet-4-5", "gpt-5"]) {
        batch.push(
          ev({
            user,
            model,
            timestamp: D0 + d * DAY + 3_600_000 + batch.length * 1000,
            inputTokens: 100 + d,
            outputTokens: 50 + d,
            cacheCreationTokens: 10,
            cacheReadTokens: 20,
            reasoningTokens: model === "gpt-5" ? 7 : null,
            costUsdMicros: user === "carol" ? 1234 : null,
          }),
        );
      }
      batch.push(
        ev({
          user,
          model: "",
          messageType: "user",
          timestamp: D0 + d * DAY + 3_600_000 + batch.length * 1000,
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        }),
      );
    }
  }
  s.insertMany(batch);
}

describe("events_roll_day", () => {
  test("matches the pre-rollup SQL row-for-row after a plain forward ingest", () => {
    seed(store);
    expectParity(store, "forward ingest");
  });

  test("an out-of-order BACKFILL into an already-materialised day is exact", () => {
    seed(store);
    // Read first, so any watermark/caching that a naive design would have
    // established is established before the late arrival lands.
    expectParity(store, "pre-backfill");

    // Dated inside day 1 of the seeded range, i.e. a day the rollup already
    // holds a row for, arriving long after that day was materialised. The
    // delta is keyed by the EVENT'S day, not by arrival, so this must land
    // in day 1's cell with no invalidation step.
    store.insertMany([
      ev({
        user: "alice",
        model: "claude-sonnet-4-5",
        timestamp: D0 + DAY + 60_000,
        inputTokens: 9_000,
        outputTokens: 900,
        cacheCreationTokens: 90,
        cacheReadTokens: 9,
      }),
    ]);
    expectParity(store, "after backfill");

    // A backfill that predates every existing row creates a brand-new,
    // out-of-order day cell.
    store.insertMany([
      ev({
        user: "dave",
        model: "gpt-5",
        timestamp: D0 - 90 * DAY,
        inputTokens: 5,
        outputTokens: 5,
        cacheCreationTokens: 5,
        cacheReadTokens: 5,
      }),
    ]);
    expectParity(store, "after ancient backfill");
  });

  test("re-posting the same batch (dedup) does not double-count", () => {
    const batch = [
      ev({ user: "alice", timestamp: D0 + 1000 }),
      ev({ user: "bob", timestamp: D0 + 2000 }),
    ];
    expect(store.insertMany(batch).inserted).toBe(2);
    const before = store.adminUserModel(0, MAX_TS_MS);
    expect(store.insertMany(batch).inserted).toBe(0);
    expect(store.adminUserModel(0, MAX_TS_MS)).toEqual(before);
    expectParity(store, "after duplicate post");
  });

  test("the cursor_local reconcile DELETE inside insertMany is repaired exactly", () => {
    // The reconcile drops a user's cursor_local assistant rows inside the
    // incoming cloud batch's timestamp span. That delete hides in the hot
    // write path, and no delta can undo it (maxTimestamp is a MAX), so it
    // must mark (user, day) dirty and be recomputed on the next read.
    store.insertMany([
      ev({ user: "alice", source: "cursor_local", timestamp: D0 + 1_000, model: "cursor-fast" }),
      ev({ user: "alice", source: "cursor_local", timestamp: D0 + 2_000, model: "cursor-fast" }),
      ev({
        user: "alice",
        source: "cursor_local",
        timestamp: D0 + DAY + 1_000,
        model: "cursor-fast",
      }),
      ev({ user: "bob", source: "cursor_local", timestamp: D0 + 1_500, model: "cursor-fast" }),
    ]);
    expectParity(store, "cursor_local only");

    // Cloud rows spanning two days for alice: her two day-0 local rows and
    // her day-1 local row all go; bob's stays.
    store.insertMany([
      ev({ user: "alice", source: "cursor", timestamp: D0 + 500, model: "claude-sonnet-4-5" }),
      ev({
        user: "alice",
        source: "cursor",
        timestamp: D0 + DAY + 5_000,
        model: "claude-sonnet-4-5",
      }),
    ]);
    expect(
      store.db.prepare("SELECT COUNT(*) AS c FROM events WHERE source='cursor_local'").get(),
    ).toEqual({ c: 1 } as never);
    expectParity(store, "after cursor reconcile");
  });

  test("an ALL-TIME-span cursor reconcile (the cloud backfill drain) stays exact", () => {
    seed(store);
    store.insertMany([
      ev({ user: "alice", source: "cursor_local", timestamp: D0 + 2 * DAY, model: "cursor-fast" }),
    ]);
    const cells = () =>
      new Map(
        store.db
          .prepare<{ k: string; v: string }, []>(
            `SELECT day || '/' || user || '/' || model || '/' || messageType AS k,
                    events || ':' || inputTokens || ':' || maxTimestamp      AS v
               FROM events_roll_day`,
          )
          .all()
          .map((r) => [r.k, r.v]),
      );
    const before = cells();

    // One batch spanning 40 days of the user's history. The delete marks
    // (user, day) from the rows it actually removed, so exactly ONE day is
    // recomputed, not the 41 the span covers — the difference between a
    // bounded repair and re-deriving a user's whole history every time a
    // Cursor cloud sync drains an all-time backfill.
    store.insertMany([
      ev({ user: "alice", source: "cursor", timestamp: D0 - 30 * DAY, model: "claude-sonnet-4-5" }),
      ev({ user: "alice", source: "cursor", timestamp: D0 + 10 * DAY, model: "claude-sonnet-4-5" }),
    ]);
    // The writer drained its own queue; nothing is left for the next reader.
    expect(store.db.prepare("SELECT user, day FROM events_roll_dirty").all()).toEqual([] as never);

    // Only the day that actually lost a row changed, plus the two days the
    // new cloud rows landed on. Every other cell is byte-identical.
    const after = cells();
    const touched = new Set<string>();
    for (const [k, v] of after) if (before.get(k) !== v) touched.add(k.split("/")[1] ?? "");
    for (const k of before.keys()) if (!after.has(k)) touched.add(k.split("/")[1] ?? "");
    expect([...touched].sort()).toEqual(["alice"]);
    const changedDays = new Set<string>();
    for (const [k, v] of after) if (before.get(k) !== v) changedDays.add(k.split("/")[0] ?? "");
    for (const k of before.keys()) if (!after.has(k)) changedDays.add(k.split("/")[0] ?? "");
    expect([...changedDays].map(Number).sort((a, b) => a - b)).toEqual([
      Math.floor((D0 - 30 * DAY) / DAY),
      Math.floor((D0 + 2 * DAY) / DAY),
      Math.floor((D0 + 10 * DAY) / DAY),
    ]);
    expectParity(store, "after all-time reconcile");
  });

  test("clearUserEvents removes exactly one user's rollup rows, and re-ingest works", () => {
    seed(store);
    expect(store.clearUserEvents("bob")).toBeGreaterThan(0);
    expect(
      store.db.prepare("SELECT COUNT(*) AS c FROM events_roll_day WHERE user='bob'").get(),
    ).toEqual({ c: 0 } as never);
    expectParity(store, "after clearUserEvents");

    store.insertMany([ev({ user: "bob", timestamp: D0 + 2 * DAY + 500 })]);
    expectParity(store, "after clearUserEvents + re-ingest");
  });

  test("clearAllEvents truncates the rollup, and re-ingest works", () => {
    seed(store);
    store.clearAllEvents();
    expect(store.db.prepare("SELECT COUNT(*) AS c FROM events_roll_day").get()).toEqual({
      c: 0,
    } as never);
    expect(store.adminUserModel(0, MAX_TS_MS)).toEqual([]);
    seed(store);
    expectParity(store, "after clearAllEvents + re-ingest");
  });

  test("clearFull drops the rollup tables rather than leaving them behind", () => {
    seed(store);
    store.clearFull();
    // If clearFull forgot the rollup, the DROP of `events` would leave a
    // populated events_roll_day serving aggregates for deleted data.
    expect(store.db.prepare("SELECT COUNT(*) AS c FROM events_roll_day").get()).toEqual({
      c: 0,
    } as never);
    expect(store.adminUserModel(0, MAX_TS_MS)).toEqual([]);
    seed(store);
    expectParity(store, "after clearFull + re-ingest");
  });

  test("negative timestamps floor to the same day in SQL and in JS", () => {
    // validateEvent gates timestamp with isFiniteInt, not isNonNegInt, so
    // /ingest accepts pre-epoch timestamps. SQLite integer division
    // truncates toward zero and Math.floor rounds toward -inf: if the two
    // day expressions disagree, the delta lands in a different cell than a
    // rebuild would produce — and a row-COUNT audit would not notice,
    // because the counts still match.
    store.insertMany([
      ev({ user: "alice", timestamp: -1 }),
      ev({ user: "alice", timestamp: -DAY }),
      ev({ user: "alice", timestamp: -DAY - 1 }),
      ev({ user: "alice", timestamp: -3 * DAY + 12_345 }),
      ev({ user: "bob", timestamp: 0 }),
    ]);
    const incremental = store.db
      .prepare("SELECT day, user, events FROM events_roll_day ORDER BY day, user")
      .all();
    expect(incremental).toEqual([
      { day: -3, user: "alice", events: 1 },
      { day: -2, user: "alice", events: 1 },
      { day: -1, user: "alice", events: 2 },
      { day: 0, user: "bob", events: 1 },
    ] as never);
    // The rebuild computes the day in SQL; it must agree with the deltas.
    store.rebuildRollup();
    expect(
      store.db.prepare("SELECT day, user, events FROM events_roll_day ORDER BY day, user").all(),
    ).toEqual(incremental as never);
    expect(store.auditRollup({ repair: false }).ok).toBe(true);
  });

  test("half-open [since, until): ts === since is IN, ts === until is OUT", () => {
    const at = D0 + 6 * 3_600_000;
    store.insertMany([ev({ user: "alice", timestamp: at })]);
    // Window boundaries land mid-day, so this is decided by the sliver
    // predicates rather than by the day bounds.
    expect(store.adminUserModel(at, at + 1)[0]?.count).toBe(1);
    expect(store.adminUserModel(at - 1, at)).toEqual([]);
    expect(store.adminUserModel(at + 1, at + 2)).toEqual([]);
    // Same at an exact UTC-midnight boundary, where the interior day range
    // decides instead.
    const mid = D0 + DAY;
    store.insertMany([ev({ user: "bob", timestamp: mid })]);
    expect(store.adminUserModel(mid, mid + DAY).map((r) => r.user)).toEqual(["bob"]);
    expect(store.adminUserModel(mid - DAY, mid).map((r) => r.user)).toEqual(["alice"]);
  });

  test("day-grain rollup produces the same week and month labels as raw events", () => {
    // Day grain can serve week/month only because a UTC day lies wholly
    // inside one ISO week and one calendar month. Span a year boundary,
    // where %G-W%V and %Y-%m disagree about which year a day belongs to.
    const batch: TokenEvent[] = [];
    for (let d = -400; d <= 0; d += 1) {
      batch.push(ev({ user: "alice", timestamp: D0 + d * DAY + 43_200_000 }));
    }
    store.insertMany(batch);
    for (const bucket of ["day", "week", "month"] as const) {
      expect(
        store.timeseriesByUser(bucket, 0, MAX_TS_MS).map((r) => r.bucketKey),
        `labels ${bucket}`,
      ).toEqual(rawTimeseriesByUser(store, bucket, 0, MAX_TS_MS).map((r) => r.bucketKey));
    }
  });

  test("the boot audit detects drift the row count alone would miss, and rebuilds", () => {
    seed(store);
    // Corrupt one cell's token sum while leaving `events` (the row count)
    // untouched: exactly the class a COUNT-only audit cannot see.
    store.db.prepare("UPDATE events_roll_day SET inputTokens = inputTokens + 1").run();
    expect(store.auditRollup({ repair: false }).ok).toBe(false);
    const audit = store.auditRollup({ repair: true });
    expect(audit.rebuilt).toBe(true);
    expect(store.auditRollup({ repair: false }).ok).toBe(true);
    expectParity(store, "after audit rebuild");
  });

  test("a reopened Store rebuilds a rollup that is missing or empty", () => {
    seed(store);
    const path = join(dir, "tl.sqlite");
    store.close();
    // Simulate an upgrade from a pre-rollup DB.
    const raw = new Store(path);
    raw.db.exec("DROP TABLE events_roll_day");
    raw.close();
    store = new Store(path);
    expect(store.auditRollup({ repair: false }).ok).toBe(true);
    expectParity(store, "after reopen rebuild");
  });
});

describe("emergent sort orders the rollup must preserve", () => {
  // None of these rules is written anywhere in the route handlers: each
  // falls out of SQL emission order plus a stable JS sort. They are part of
  // the payload contract all the same — /stats/leaderboard and /stats/admin
  // accumulate `usd +=` over these rows in emission order, and float
  // addition is not associative.
  //
  // The four sorts below are now PINNED in SQL rather than inherited from a
  // query plan, because the plan is what this change replaced. The pinned
  // directions were measured against `main` on a 5,099,335-row prod-shaped
  // fixture with tied users injected, which is what byte-parity is
  // protecting; see the tie-order comment in db.ts, including why `main`'s
  // own answer differs between that fixture and a nine-row test DB.
  const tie = (user: string, model: string) =>
    makeTokenEvent({
      user,
      model,
      sessionId: `${user}-${model}`,
      messageId: `${user}-${model}`,
      requestId: `${user}-${model}`,
      timestamp: D0 + 1000,
      inputTokens: 100,
      outputTokens: 100,
      cacheCreationTokens: 100,
      cacheReadTokens: 100,
    });
  const TIED_USERS = ["zoe", "mallory", "alice", "bob", "yan"];
  const ASCENDING = ["alice", "bob", "mallory", "yan", "zoe"];

  test("adminLeaderboard emits cost ties in ASCENDING user order", () => {
    store.insertMany(TIED_USERS.map((u) => tie(u, "claude-sonnet-4-5")));
    expect(store.adminLeaderboard(0, MAX_TS_MS).map((r) => r.user)).toEqual(ASCENDING);
  });

  test("leaderboard emits cost ties in ASCENDING user order", () => {
    store.insertMany(TIED_USERS.map((u) => tie(u, "claude-sonnet-4-5")));
    expect(store.leaderboard(0, MAX_TS_MS).map((r) => r.user)).toEqual(ASCENDING);
  });

  // The all-zero tie is not a contrivance: a user whose only in-window rows
  // are messageType='user' totals zero tokens, so the 7D/30D pills produce
  // these constantly. This is the case that actually diverged.
  test("adminLeaderboard ties users with no assistant rows ASCENDING", () => {
    store.insertMany(
      TIED_USERS.map((u) =>
        makeTokenEvent({
          user: u,
          model: "",
          messageType: "user",
          sessionId: `idle-${u}`,
          messageId: `idle-${u}`,
          requestId: `idle-${u}`,
          timestamp: D0 + 1000,
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        }),
      ),
    );
    expect(store.adminLeaderboard(0, MAX_TS_MS).map((r) => r.user)).toEqual(ASCENDING);
  });

  test("userByModel emits token ties in DESCENDING model order", () => {
    const models = ["m-a", "m-b", "m-c", "m-d"];
    store.insertMany(models.map((m) => tie("alice", m)));
    expect(store.userByModel("alice", 0, MAX_TS_MS).map((r) => r.model)).toEqual([
      "m-d",
      "m-c",
      "m-b",
      "m-a",
    ]);
  });

  test("timeseriesByUser emits ties in ASCENDING user order", () => {
    store.insertMany(
      ["zoe", "mallory", "alice", "bob", "yan"].map((u) => tie(u, "claude-sonnet-4-5")),
    );
    expect(store.timeseriesByUser("day", 0, MAX_TS_MS).map((r) => r.user)).toEqual([
      "alice",
      "bob",
      "mallory",
      "yan",
      "zoe",
    ]);
  });

  test("adminUserModel emits (user, model) ascending", () => {
    store.insertMany([
      tie("bob", "gpt-5"),
      tie("alice", "gpt-5"),
      tie("bob", "claude-sonnet-4-5"),
      tie("alice", "claude-sonnet-4-5"),
    ]);
    expect(store.adminUserModel(0, MAX_TS_MS).map((r) => `${r.user}/${r.model}`)).toEqual([
      "alice/claude-sonnet-4-5",
      "alice/gpt-5",
      "bob/claude-sonnet-4-5",
      "bob/gpt-5",
    ]);
  });
});

describe("POST /admin/rollup-audit", () => {
  const auditReq = (token?: string) =>
    new Request("http://x/admin/rollup-audit", {
      method: "POST",
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });

  test("is admin-gated", async () => {
    const built = createTestApp({ adminToken: "topsecret-xyz" });
    try {
      expect((await built.app.request(auditReq())).status).toBe(401);
      expect((await built.app.request(auditReq("wrong"))).status).toBe(403);
    } finally {
      await built.cleanup();
    }
  });

  test("reports agreement, and rebuilds after out-of-band surgery on events", async () => {
    const built = createTestApp({ adminToken: "topsecret-xyz" });
    try {
      built.store.insertMany([ev({ user: "alice", timestamp: D0 + 1000 })]);
      const clean = await jsonOf(await built.app.request(auditReq("topsecret-xyz")));
      expect(clean.ok).toBe(true);
      expect(clean.rebuilt).toBe(false);

      // The ops rule the rollup DDL documents: a hand-run UPDATE on events
      // bypasses every maintenance path, and this endpoint is the fix.
      built.store.db.prepare("UPDATE events SET user = 'renamed'").run();
      const dirty = await jsonOf(await built.app.request(auditReq("topsecret-xyz")));
      expect(dirty.rebuilt).toBe(true);
      expect(built.store.adminUserModel(0, MAX_TS_MS).map((r) => r.user)).toEqual(["renamed"]);
    } finally {
      await built.cleanup();
    }
  });

  // Each of these hand edits preserves EVERY per-user token sum and row
  // count, so a per-user-totals-only audit reports ok and the dashboard
  // serves the pre-edit answer forever — across restarts, because boot runs
  // the same comparison. They are the likeliest hand edits there are (a
  // model-id normalisation, a timestamp-import correction, a messageType
  // fix), which is why the audit key carries dsum/asst/mfp.
  describe("catches edits that preserve per-user totals", () => {
    const seedOne = (s: Store) => {
      s.insertMany([
        ev({ user: "alice", model: "claude-opus-4-5", timestamp: D0 + 1000 }),
        ev({ user: "alice", model: "claude-opus-4-5", timestamp: D0 + 2000 }),
        ev({ user: "alice", model: "gpt-5.6", timestamp: D0 + 3000 }),
      ]);
    };
    const cases: Array<[string, string]> = [
      // Same length, same first character — only the last byte moves.
      ["model rename", "UPDATE events SET model='claude-opus-4-6' WHERE model='claude-opus-4-5'"],
      ["model truncation", "UPDATE events SET model='opus' WHERE model='claude-opus-4-5'"],
      ["timestamp shift", `UPDATE events SET timestamp = timestamp + ${10 * DAY}`],
      ["messageType flip", "UPDATE events SET messageType='user', model='' WHERE model='gpt-5.6'"],
    ];
    for (const [label, sql] of cases) {
      test(label, () => {
        seedOne(store);
        expect(store.auditRollup({ repair: false }).ok).toBe(true);
        store.db.prepare(sql).run();
        expect(store.auditRollup({ repair: false }).ok, `${label} undetected`).toBe(false);
        // And repairing converges on what a from-scratch rebuild would say.
        store.auditRollup({ repair: true });
        const repaired = JSON.stringify(store.adminUserModel(0, MAX_TS_MS));
        store.rebuildRollup();
        expect(repaired).toBe(JSON.stringify(store.adminUserModel(0, MAX_TS_MS)));
      });
    }
  });

  test('{"rebuild":true} rebuilds unconditionally', async () => {
    const built = createTestApp({ adminToken: "topsecret-xyz" });
    try {
      built.store.insertMany([ev({ user: "alice", timestamp: D0 + 1000 })]);
      // No divergence at all: the audit would report ok and do nothing. The
      // forced path exists for the divergences the audit cannot see, so it
      // must rebuild even when the audit is happy.
      const res = await built.app.request(
        new Request("http://x/admin/rollup-audit", {
          method: "POST",
          headers: {
            authorization: "Bearer topsecret-xyz",
            "content-type": "application/json",
          },
          body: JSON.stringify({ rebuild: true }),
        }),
      );
      const forced = await jsonOf(res);
      expect(forced.rebuilt).toBe(true);
      expect(forced.ok).toBe(true);
      expect(built.store.auditRollup({ repair: false }).ok).toBe(true);
    } finally {
      await built.cleanup();
    }
  });
});

describe("the dirty queue is drained by the writer, not the reader", () => {
  // A cloud `cursor` tick whose [min, max] spans a user's whole history
  // reconciles away every cursor_local row in that span, dirtying one cell
  // per day. Draining that on the next read charges a public GET /stats/*
  // for a daemon's backfill, in a WRITE transaction that blocks the event
  // loop — a smaller copy of the problem the rollup exists to remove.
  test("insertMany leaves events_roll_dirty empty after a reconcile", () => {
    const days = 40;
    const local: TokenEvent[] = [];
    for (let d = 0; d < days; d++) {
      local.push(
        ev({
          user: "alice",
          source: "cursor_local",
          model: "claude-sonnet-4-5",
          timestamp: D0 + d * DAY + 3_600_000,
        }),
      );
    }
    store.insertMany(local);
    const pending = () =>
      (
        store.db.prepare("SELECT COUNT(*) AS c FROM events_roll_dirty").get() as {
          c: number;
        }
      ).c;
    expect(pending()).toBe(0);

    store.insertMany([
      ev({ user: "alice", source: "cursor", timestamp: D0 + 3_600_000 }),
      ev({ user: "alice", source: "cursor", timestamp: D0 + (days - 1) * DAY + 3_600_000 }),
    ]);
    // Every cell the reconcile invalidated is already recomputed: nothing is
    // left for the next reader to pay for.
    expect(pending()).toBe(0);
    expectParity(store, "after span-wide reconcile");
  });
});

/**
 * The mixed-source cost bug, end to end.
 *
 * Cursor is the only source that reports its own cost, and Cursor uses BARE
 * OpenAI model names — the same strings the Codex parser writes. When the
 * cost branch asked "does this bucket contain ANY stored cost?", a handful
 * of Cursor rows answered yes for the whole model and every Codex row under
 * that name priced at $0. On prod that was 944 Cursor rows silencing
 * 571,006 Codex rows, showing $109 where ~$13,500 was owed.
 */
describe("mixed stored-cost and derived rows under one model name", () => {
  let s: Store;
  let cleanup: () => void;
  beforeEach(() => {
    const t = makeTmpDirSync("tokenleader-mixed-");
    cleanup = t.cleanup;
    s = new Store(join(t.dir, "tl.sqlite"));
  });
  afterEach(() => {
    s.close();
    cleanup();
  });

  const TS = Date.UTC(2026, 7, 1);

  test("a cell is never a mix — stored and derived rows land in separate rows", () => {
    s.insertMany([
      makeTokenEvent({
        user: "u",
        model: "gpt-5",
        source: "cursor",
        messageId: "c1",
        timestamp: TS,
        inputTokens: 10,
        costUsdMicros: 5_000,
      }),
      makeTokenEvent({
        user: "u",
        model: "gpt-5",
        source: "codex",
        messageId: "k1",
        timestamp: TS,
        inputTokens: 1000,
      }),
    ]);
    const cells = s.db
      .prepare<{ hasStored: number; inputTokens: number }, []>(
        "SELECT hasStored, inputTokens FROM events_roll_day WHERE model='gpt-5' ORDER BY hasStored",
      )
      .all();
    expect(cells.length).toBe(2);
    expect(cells[0]).toMatchObject({ hasStored: 0, inputTokens: 1000 });
    expect(cells[1]).toMatchObject({ hasStored: 1, inputTokens: 10 });
  });

  test("the derived tokens survive alongside the stored cost", () => {
    s.insertMany([
      makeTokenEvent({
        user: "u",
        model: "gpt-5",
        source: "cursor",
        messageId: "c1",
        timestamp: TS,
        inputTokens: 10,
        costUsdMicros: 5_000,
      }),
      makeTokenEvent({
        user: "u",
        model: "gpt-5",
        source: "codex",
        messageId: "k1",
        timestamp: TS,
        inputTokens: 1_000_000,
        cacheReadTokens: 9_000_000,
      }),
    ]);
    const [row] = s.adminUserModel(0, MAX_TS_MS);
    expect(row).toBeDefined();
    // Stored cost is preserved for the row that reported one...
    expect(row!.storedCostMicros).toBe(5_000);
    // ...and the Codex tokens are still there to be priced, NOT swallowed.
    expect(row!.derivedInputTokens).toBe(1_000_000);
    expect(row!.derivedCacheReadTokens).toBe(9_000_000);
    // The stored row's own tokens are excluded from the derived sums, so
    // nothing is counted twice when the two are summed downstream.
    expect(row!.inputTokens).toBe(1_000_010);
    expect(row!.derivedInputTokens).toBe(row!.inputTokens - 10);
  });

  test("a model with only stored-cost rows reports zero derived tokens", () => {
    s.insertMany([
      makeTokenEvent({
        user: "u",
        model: "cursor-only",
        source: "cursor",
        messageId: "c1",
        timestamp: TS,
        inputTokens: 42,
        costUsdMicros: 7_000,
      }),
    ]);
    const [row] = s.adminUserModel(0, MAX_TS_MS);
    expect(row!.storedCostMicros).toBe(7_000);
    expect(row!.derivedInputTokens).toBe(0);
  });
});

/**
 * Prod already holds an events_roll_day WITHOUT hasStored. The column is in
 * the PRIMARY KEY, so ALTER TABLE cannot add it — and must not, since an
 * existing cell may already be a mix of stored and derived rows that cannot
 * be split after the fact. Reopening has to drop and rebuild, or the first
 * query after deploy fails with "no such column".
 */
describe("migration from a pre-hasStored rollup", () => {
  test("reopening an old-shape DB rebuilds the rollup and serves correct numbers", () => {
    const t = makeTmpDirSync("tokenleader-migrate-");
    const path = join(t.dir, "tl.sqlite");
    const TS = Date.UTC(2026, 7, 1);

    const first = new Store(path);
    first.insertMany([
      makeTokenEvent({
        user: "u",
        model: "gpt-5",
        source: "cursor",
        messageId: "c1",
        timestamp: TS,
        inputTokens: 10,
        costUsdMicros: 5_000,
      }),
      makeTokenEvent({
        user: "u",
        model: "gpt-5",
        source: "codex",
        messageId: "k1",
        timestamp: TS,
        inputTokens: 1_000_000,
      }),
    ]);
    // Recreate the OLD shape: no hasStored, and the two rows collapsed into
    // one mixed cell exactly as the previous release would have stored them.
    first.db.exec(`
      DROP TABLE events_roll_day;
      CREATE TABLE events_roll_day (
        day INTEGER NOT NULL, user TEXT NOT NULL, model TEXT NOT NULL,
        messageType TEXT NOT NULL, events INTEGER NOT NULL,
        inputTokens INTEGER NOT NULL, outputTokens INTEGER NOT NULL,
        cacheCreationTokens INTEGER NOT NULL, cacheReadTokens INTEGER NOT NULL,
        reasoningTokens INTEGER NOT NULL, storedCostMicros INTEGER NOT NULL,
        maxTimestamp INTEGER NOT NULL,
        PRIMARY KEY (day, user, model, messageType)
      ) WITHOUT ROWID;
      INSERT INTO events_roll_day VALUES
        (0, 'u', 'gpt-5', 'assistant', 2, 1000010, 0, 0, 0, 0, 5000, ${TS});
    `);
    first.close();

    const reopened = new Store(path);
    try {
      const cols = reopened.db
        .prepare<{ name: string }, []>("PRAGMA table_info(events_roll_day)")
        .all();
      expect(cols.some((c) => c.name === "hasStored")).toBe(true);

      // Rebuilt from raw events, so the mixed cell is now split and the
      // Codex tokens are recoverable rather than fused to a Cursor price.
      const [row] = reopened.adminUserModel(0, MAX_TS_MS);
      expect(row!.storedCostMicros).toBe(5_000);
      expect(row!.derivedInputTokens).toBe(1_000_000);
      expect(row!.inputTokens).toBe(1_000_010);
    } finally {
      reopened.close();
      t.cleanup();
    }
  });
});
