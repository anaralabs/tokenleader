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
    expect(r.state.cursorCloud?.lastSyncAt).toBe(1_700_000_100_000);
    expect(r.state.cursorCloud?.fullSyncDone).toBe(true);
    expect(r.state.cursorCloud?.lastEventTimestamp).toBe(1_700_000_000_000);
  });
});

describe("nextCursorCloudState", () => {
  test("preserves fullSyncDone once set", () => {
    const state = {
      ...emptyState(),
      cursorCloud: { lastSyncAt: 1, fullSyncDone: true },
    };
    const next = nextCursorCloudState(state, "incremental", [], 2);
    expect(next.cursorCloud?.fullSyncDone).toBe(true);
  });
});
