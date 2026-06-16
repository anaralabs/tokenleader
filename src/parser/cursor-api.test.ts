import { describe, expect, test } from "bun:test";
import {
  CURSOR_DASHBOARD_API,
  CURSOR_ORIGIN,
  CURSOR_USAGE_SUMMARY_API,
  fetchFilteredUsageEvents,
  mapCursorDashboardEvent,
  validateCursorToken,
} from "./cursor-api.ts";

function fakeDashboardApi(
  events: Array<Record<string, unknown>>,
  opts: { failStatus?: number } = {},
) {
  const calls: Array<{ body: Record<string, unknown> }> = [];
  const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ body });
    if (opts.failStatus) {
      return new Response("unauthorized", { status: opts.failStatus });
    }
    const page = Number(body.page ?? 1);
    const pageSize = Number(body.pageSize ?? 100);
    const start = (page - 1) * pageSize;
    const pageEvents = events.slice(start, start + pageSize);
    const numPages = Math.max(1, Math.ceil(events.length / pageSize));
    return new Response(
      JSON.stringify({
        totalUsageEventsCount: events.length,
        usageEventsDisplay: pageEvents,
        pagination: {
          numPages,
          currentPage: page,
          pageSize,
          hasNextPage: page < numPages,
          hasPreviousPage: page > 1,
        },
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("mapCursorDashboardEvent", () => {
  test("maps modelName, id, and totalCents to TokenEvent fields", () => {
    const ev = mapCursorDashboardEvent(
      {
        id: "evt-123",
        timestamp: "1704067200000",
        modelName: "claude-4.5-sonnet",
        inputTokens: 100,
        outputTokens: 50,
        totalCents: 1.23,
      },
      "alice",
    );
    expect(ev).not.toBeNull();
    expect(ev!.source).toBe("cursor");
    expect(ev!.model).toBe("claude-4.5-sonnet");
    expect(ev!.messageId).toBe("evt-123");
    expect(ev!.requestId).toBe("evt-123");
    expect(ev!.inputTokens).toBe(100);
    expect(ev!.outputTokens).toBe(50);
    expect(ev!.costUsdMicros).toBe(12_300);
    expect(ev!.sessionId).toBe("cursor:alice:2024-01-01");
  });

  test("reads nested tokenUsage when top-level fields are absent", () => {
    const ev = mapCursorDashboardEvent(
      {
        id: "evt-456",
        timestamp: 1_700_000_000_000,
        model: "gpt-4.1",
        tokenUsage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheWriteTokens: 2,
          cacheReadTokens: 3,
          totalCents: 0.5,
        },
      },
      "bob",
    );
    expect(ev!.inputTokens).toBe(10);
    expect(ev!.outputTokens).toBe(5);
    expect(ev!.cacheCreationTokens).toBe(2);
    expect(ev!.cacheReadTokens).toBe(3);
    expect(ev!.costUsdMicros).toBe(5_000);
  });

  test("returns null for missing timestamp", () => {
    expect(mapCursorDashboardEvent({ id: "x", modelName: "m" }, "alice")).toBeNull();
  });
});

describe("validateCursorToken", () => {
  test("accepts a 200 JSON response from usage-summary", async () => {
    const fetchImpl = (async (input: unknown) => {
      expect(String(input)).toBe(CURSOR_USAGE_SUMMARY_API);
      return new Response(JSON.stringify({ membershipType: "pro" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    await expect(validateCursorToken("good-token", { fetchImpl })).resolves.toBeUndefined();
  });

  test("rejects 401/403", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: "not_authenticated" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
    await expect(validateCursorToken("bad-token", { fetchImpl })).rejects.toThrow(
      "session token rejected",
    );
  });
});

describe("fetchFilteredUsageEvents", () => {
  test("paginates and maps events", async () => {
    const rows = Array.from({ length: 150 }, (_, i) => ({
      id: `evt-${i}`,
      timestamp: String(1_700_000_000_000 + i),
      modelName: "claude-4.5-sonnet",
      inputTokens: 1,
      outputTokens: 1,
      totalCents: 0.01,
    }));
    const { fetchImpl, calls } = fakeDashboardApi(rows);
    const r = await fetchFilteredUsageEvents("alice", {
      token: "tok",
      pageSize: 100,
      fetchImpl,
    });
    expect(r.events.length).toBe(150);
    expect(r.pagesFetched).toBe(2);
    expect(r.complete).toBe(true);
    expect(r.nextPage).toBeUndefined();
    expect(calls[0]!.body.pageSize).toBe(100);
    expect(calls[0]!.body.page).toBe(1);
    expect(r.events[0]!.user).toBe("alice");
    expect(r.events[0]!.source).toBe("cursor");
  });

  test("hitting the maxPages cap returns complete=false with the resume page", async () => {
    // A fake that always returns a full page (hasNextPage omitted) so the
    // loop never sees a termination signal and exhausts the cap.
    const calls: Array<{ body: Record<string, unknown> }> = [];
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ body });
      const pageSize = Number(body.pageSize ?? 100);
      const page = Number(body.page ?? 1);
      const pageEvents = Array.from({ length: pageSize }, (_, i) => ({
        id: `evt-${page}-${i}`,
        timestamp: String(1_700_000_000_000 + page * 1000 + i),
        modelName: "claude-4.5-sonnet",
        inputTokens: 1,
        outputTokens: 1,
        totalCents: 0.01,
      }));
      return new Response(JSON.stringify({ usageEventsDisplay: pageEvents }), {
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const maxPages = 3;
    const r = await fetchFilteredUsageEvents("alice", {
      token: "tok",
      pageSize: 100,
      maxPages,
      fetchImpl,
    });
    expect(r.complete).toBe(false);
    expect(r.nextPage).toBe(maxPages + 1);
    expect(r.pagesFetched).toBe(maxPages);
    expect(calls).toHaveLength(maxPages);
    expect(calls[0]!.body.page).toBe(1);
    expect(calls[maxPages - 1]!.body.page).toBe(maxPages);
  });

  test("startPage resumes pagination from the given page", async () => {
    const rows = Array.from({ length: 250 }, (_, i) => ({
      id: `evt-${i}`,
      timestamp: String(1_700_000_000_000 + i),
      modelName: "claude-4.5-sonnet",
      inputTokens: 1,
      outputTokens: 1,
      totalCents: 0.01,
    }));
    const { fetchImpl, calls } = fakeDashboardApi(rows);
    const r = await fetchFilteredUsageEvents("alice", {
      token: "tok",
      pageSize: 100,
      startPage: 3,
      fetchImpl,
    });
    // Page 3 is the short final page (50 rows) → complete walk.
    expect(calls[0]!.body.page).toBe(3);
    expect(r.events.length).toBe(50);
    expect(r.pagesFetched).toBe(1);
    expect(r.complete).toBe(true);
  });

  test("sends Cookie header, Origin, and x-cursor-client-id to the dashboard endpoint", async () => {
    let seenCookie = "";
    let seenOrigin = "";
    let seenClientId = "";
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      seenCookie = String(headers.Cookie);
      seenOrigin = String(headers.Origin);
      seenClientId = String(headers["x-cursor-client-id"] ?? "");
      return new Response(JSON.stringify({ usageEventsDisplay: [] }), {
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await fetchFilteredUsageEvents("alice", {
      token: "my-session",
      machineId: "machine-123",
      fetchImpl,
    });
    expect(seenCookie).toBe("WorkosCursorSessionToken=my-session");
    expect(seenOrigin).toBe(CURSOR_ORIGIN);
    expect(seenClientId).toBe("machine-123");
  });

  test("uses the bare-host dashboard URL", () => {
    expect(CURSOR_DASHBOARD_API).toBe("https://cursor.com/api/dashboard/get-filtered-usage-events");
  });
});
