import { describe, expect, test } from "bun:test";
import { makeTokenEvent } from "../test-helpers.ts";
import type { TokenEvent } from "../types.ts";
import {
  computeCursorSyncStartDate,
  currentMonthStartMs,
  CURSOR_SYNC_DEFAULT_LOOKBACK_MS,
  CURSOR_SYNC_OVERLAP_MS,
  fetchCursorCloudEvents,
  nextCursorCloudState,
  runCursorCloudSync,
} from "./cursor-sync.ts";
import { emptyState } from "./state.ts";

describe("computeCursorSyncStartDate", () => {
  test("full mode starts at 0", () => {
    expect(computeCursorSyncStartDate(emptyState(), "full", 2_000_000)).toBe(0);
  });

  test("incremental uses lastEventTimestamp minus overlap", () => {
    const state = {
      ...emptyState(),
      cursorCloud: { lastSyncAt: 10_000_000, lastEventTimestamp: 9_500_000 },
    };
    expect(computeCursorSyncStartDate(state, "incremental", 20_000_000)).toBe(
      9_500_000 - CURSOR_SYNC_OVERLAP_MS,
    );
  });

  test("incremental falls back to lastSyncAt when no event watermark exists", () => {
    const state = {
      ...emptyState(),
      cursorCloud: { lastSyncAt: 10_000_000 },
    };
    expect(computeCursorSyncStartDate(state, "incremental", 20_000_000)).toBe(
      10_000_000 - CURSOR_SYNC_OVERLAP_MS,
    );
  });

  test("first incremental sync looks back 24h", () => {
    const now = 100_000_000;
    expect(computeCursorSyncStartDate(emptyState(), "incremental", now)).toBe(
      now - CURSOR_SYNC_DEFAULT_LOOKBACK_MS,
    );
  });

  test("a pending resume pins resumeStartDate so the window can't drift with lastSyncAt", () => {
    const state = {
      ...emptyState(),
      // No event watermark, so the basis would otherwise be lastSyncAt (which
      // advances every tick) — the resume must stay anchored to its window.
      cursorCloud: { lastSyncAt: 50_000_000, resumePage: 7, resumeStartDate: 1_234_000 },
    };
    expect(computeCursorSyncStartDate(state, "incremental", 99_000_000)).toBe(1_234_000);
  });

  test("month mode starts at the first day of the current UTC month", () => {
    const now = Date.UTC(2026, 5, 15, 12, 0, 0);
    expect(computeCursorSyncStartDate(emptyState(), "month", now)).toBe(currentMonthStartMs(now));
    expect(currentMonthStartMs(now)).toBe(Date.UTC(2026, 5, 1));
  });
});

describe("fetchCursorCloudEvents", () => {
  test("skips when no token is configured", async () => {
    const r = await fetchCursorCloudEvents({
      user: "alice",
      stateDir: "/no/token/dir",
      state: emptyState(),
      mode: "incremental",
      loadCursorCloudAuth: async () => null,
    });
    expect(r.skipped).toBe(true);
    expect(r.events).toEqual([]);
  });

  test("returns mapped dashboard events", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          usageEventsDisplay: [
            {
              timestamp: "1704067200000",
              model: "claude-4.5-sonnet",
              tokenUsage: { inputTokens: 1, outputTokens: 2, totalCents: 0.1 },
            },
          ],
        }),
        { headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;

    const r = await fetchCursorCloudEvents({
      user: "alice",
      stateDir: "/tmp",
      state: emptyState(),
      mode: "full",
      loadCursorCloudAuth: async () => ({ sessionToken: "tok" }),
      fetchImpl,
    });
    expect(r.skipped).toBe(false);
    expect(r.events.length).toBe(1);
    expect(r.events[0]!.source).toBe("cursor");
    expect(r.events[0]!.user).toBe("alice");
    // A short final page means the API signalled no more data.
    expect(r.complete).toBe(true);
    expect(r.nextPage).toBeUndefined();
  });

  test("incremental resumes from the persisted resumePage", async () => {
    let seenStartPage = -1;
    const r = await fetchCursorCloudEvents({
      user: "alice",
      stateDir: "/tmp",
      state: {
        ...emptyState(),
        // lastEventTimestamp 2 < overlap → incremental startDate is 0, so the
        // resume marker (tagged to window 0) matches and is honoured.
        cursorCloud: { lastSyncAt: 1, lastEventTimestamp: 2, resumePage: 4, resumeStartDate: 0 },
      },
      mode: "incremental",
      loadCursorCloudAuth: async () => ({ sessionToken: "tok" }),
      fetchFilteredUsageEvents: async (_user, opts) => {
        seenStartPage = opts.startPage ?? 1;
        return { events: [], totalCount: 0, pagesFetched: 0, complete: true };
      },
    });
    expect(seenStartPage).toBe(4);
    expect(r.complete).toBe(true);
  });

  test("propagates a truncated fetch (complete=false, nextPage)", async () => {
    const r = await fetchCursorCloudEvents({
      user: "alice",
      stateDir: "/tmp",
      state: emptyState(),
      mode: "incremental",
      loadCursorCloudAuth: async () => ({ sessionToken: "tok" }),
      fetchFilteredUsageEvents: async () => ({
        events: [],
        totalCount: 0,
        pagesFetched: 10,
        complete: false,
        nextPage: 11,
      }),
    });
    expect(r.complete).toBe(false);
    expect(r.nextPage).toBe(11);
  });
});

describe("runCursorCloudSync", () => {
  test("posts events and advances cursorCloud state", async () => {
    const events: TokenEvent[] = [
      makeTokenEvent({
        user: "alice",
        source: "cursor",
        messageId: "c1",
        timestamp: 1_700_000_000_000,
        costUsdMicros: 5000,
      }),
    ];
    const posted: TokenEvent[][] = [];
    const r = await runCursorCloudSync({
      user: "alice",
      stateDir: "/tmp",
      state: emptyState(),
      mode: "full",
      transport: { endpoint: "https://x", secret: "s" },
      loadCursorCloudAuth: async () => ({ sessionToken: "tok" }),
      fetchFilteredUsageEvents: async () => ({
        events,
        totalCount: 1,
        pagesFetched: 1,
        complete: true,
      }),
      postEvents: async (batch) => {
        posted.push(batch);
        return { ok: true, inserted: 1, duplicates: 0 };
      },
      now: () => 1_700_000_100_000,
    });

    expect(posted.length).toBe(1);
    expect(r.posted).toBe(true);
    expect(r.inserted).toBe(1);
    expect(r.complete).toBe(true);
    expect(r.state.cursorCloud?.lastSyncAt).toBe(1_700_000_100_000);
    expect(r.state.cursorCloud?.fullSyncDone).toBe(true);
    expect(r.state.cursorCloud?.lastEventTimestamp).toBe(1_700_000_000_000);
    expect(r.state.cursorCloud?.resumePage).toBeUndefined();
  });

  test("truncated fetch posts, pins resumePage, and does not advance the watermark", async () => {
    const events: TokenEvent[] = [
      makeTokenEvent({
        user: "alice",
        source: "cursor",
        messageId: "c1",
        timestamp: 1_700_000_000_000,
        costUsdMicros: 5000,
      }),
    ];
    const r = await runCursorCloudSync({
      user: "alice",
      stateDir: "/tmp",
      state: {
        ...emptyState(),
        cursorCloud: { lastSyncAt: 1, lastEventTimestamp: 1_600_000_000_000 },
      },
      mode: "incremental",
      transport: { endpoint: "https://x", secret: "s" },
      loadCursorCloudAuth: async () => ({ sessionToken: "tok" }),
      fetchFilteredUsageEvents: async () => ({
        events,
        totalCount: 50,
        pagesFetched: 10,
        complete: false,
        nextPage: 11,
      }),
      postEvents: async () => ({ ok: true, inserted: 1, duplicates: 0 }),
      now: () => 1_700_000_100_000,
    });

    expect(r.posted).toBe(true);
    expect(r.complete).toBe(false);
    expect(r.nextPage).toBe(11);
    // Watermark stays put (newest-first pages → advancing would skip the tail).
    expect(r.state.cursorCloud?.lastEventTimestamp).toBe(1_600_000_000_000);
    expect(r.state.cursorCloud?.resumePage).toBe(11);
  });
});

describe("nextCursorCloudState", () => {
  test("preserves fullSyncDone once set", () => {
    const state = {
      ...emptyState(),
      cursorCloud: { lastSyncAt: 1, fullSyncDone: true },
    };
    const next = nextCursorCloudState(state, "incremental", [], 2, true);
    expect(next.cursorCloud?.fullSyncDone).toBe(true);
  });

  test("complete advances the watermark and clears resumePage", () => {
    const state = {
      ...emptyState(),
      cursorCloud: { lastSyncAt: 1, lastEventTimestamp: 100, resumePage: 5 },
    };
    const events = [makeTokenEvent({ source: "cursor", timestamp: 200 })];
    const next = nextCursorCloudState(state, "incremental", events, 2, true);
    expect(next.cursorCloud?.lastEventTimestamp).toBe(200);
    expect(next.cursorCloud?.resumePage).toBeUndefined();
  });

  test("incomplete pins resumePage and freezes the watermark", () => {
    const state = {
      ...emptyState(),
      cursorCloud: { lastSyncAt: 1, lastEventTimestamp: 100 },
    };
    const events = [makeTokenEvent({ source: "cursor", timestamp: 200 })];
    const next = nextCursorCloudState(state, "incremental", events, 2, false, 7);
    expect(next.cursorCloud?.lastEventTimestamp).toBe(100);
    expect(next.cursorCloud?.resumePage).toBe(7);
  });

  test("full backfill advances the running max but defers fullSyncDone until complete", () => {
    const state = {
      ...emptyState(),
      cursorCloud: { lastSyncAt: 1, lastEventTimestamp: 100 },
    };
    // Truncated full chunk: the newest page came first, so advance the running
    // max even though older pages remain; resume is window-tagged; not yet done.
    const events = [makeTokenEvent({ source: "cursor", timestamp: 5_000 })];
    const mid = nextCursorCloudState(state, "full", events, 2, false, 4, 0);
    expect(mid.cursorCloud?.lastEventTimestamp).toBe(5_000);
    expect(mid.cursorCloud?.resumePage).toBe(4);
    expect(mid.cursorCloud?.resumeStartDate).toBe(0);
    expect(mid.cursorCloud?.fullSyncDone).toBeUndefined();

    // Final chunk completes the all-time walk: fullSyncDone latches, resume clears.
    const done = nextCursorCloudState(mid, "full", [], 3, true, undefined, 0);
    expect(done.cursorCloud?.fullSyncDone).toBe(true);
    expect(done.cursorCloud?.resumePage).toBeUndefined();
    expect(done.cursorCloud?.lastEventTimestamp).toBe(5_000);
  });
});

describe("fetchCursorCloudEvents resume window", () => {
  test("resumes at the pinned page (matching window) and honours maxPages", async () => {
    let seen: { startPage?: number; maxPages?: number } | null = null;
    const r = await fetchCursorCloudEvents({
      user: "alice",
      stateDir: "/tmp",
      mode: "full", // full → startDate 0, which matches resumeStartDate below
      maxPages: 25,
      state: {
        ...emptyState(),
        cursorCloud: { lastSyncAt: 1, resumePage: 26, resumeStartDate: 0 },
      },
      loadCursorCloudAuth: async () => ({ sessionToken: "tok" }),
      fetchFilteredUsageEvents: async (_user, opts) => {
        seen = { startPage: opts.startPage, maxPages: opts.maxPages };
        return { events: [], totalCount: 0, pagesFetched: 0, complete: true };
      },
    });
    expect(r.skipped).toBe(false);
    expect(seen!.startPage).toBe(26);
    expect(seen!.maxPages).toBe(25);
  });

  test("ignores a resume marker pinned to a different window", async () => {
    let startPage: number | undefined;
    await fetchCursorCloudEvents({
      user: "alice",
      stateDir: "/tmp",
      mode: "full", // startDate 0, but the marker belongs to startDate 9_999
      state: {
        ...emptyState(),
        cursorCloud: { lastSyncAt: 1, resumePage: 26, resumeStartDate: 9_999 },
      },
      loadCursorCloudAuth: async () => ({ sessionToken: "tok" }),
      fetchFilteredUsageEvents: async (_user, opts) => {
        startPage = opts.startPage;
        return { events: [], totalCount: 0, pagesFetched: 0, complete: true };
      },
    });
    expect(startPage).toBe(1);
  });
});
