import { describe, expect, test } from "bun:test";
import type { UserStats } from "../src/api";
import {
  dailyTimeseriesQuery,
  parseDashboardSearch,
  toggleCategory,
  toggleCompany,
  toggleFocus,
  userModelsToRows,
  userStatsQuery,
} from "../src/focus";

describe("parseDashboardSearch (?user= & ?range= validation)", () => {
  test("keeps a well-formed user + range", () => {
    expect(parseDashboardSearch({ user: "alice", range: "2026-06" })).toEqual({
      user: "alice",
      range: "2026-06",
    });
    expect(parseDashboardSearch({ range: "7" })).toEqual({ range: "7" });
    expect(parseDashboardSearch({ range: "all" })).toEqual({ range: "all" });
  });

  test("drops empty / non-string user values", () => {
    expect(parseDashboardSearch({ user: "" })).toEqual({});
    expect(parseDashboardSearch({ user: 42 })).toEqual({});
    expect(parseDashboardSearch({ user: ["a"] })).toEqual({});
    expect(parseDashboardSearch({})).toEqual({});
  });

  test("drops malformed ranges but keeps a valid user (and vice versa)", () => {
    expect(parseDashboardSearch({ user: "bob", range: "2026-13" })).toEqual({
      user: "bob",
    });
    expect(parseDashboardSearch({ user: "bob", range: "yesterday" })).toEqual({
      user: "bob",
    });
    expect(parseDashboardSearch({ user: 0, range: "30" })).toEqual({
      range: "30",
    });
  });

  test("ignores unrelated params", () => {
    expect(parseDashboardSearch({ utm_source: "x", user: "alice" })).toEqual({
      user: "alice",
    });
  });

  test("keeps a company param, lowercased", () => {
    expect(parseDashboardSearch({ company: "anara.com" })).toEqual({
      company: "anara.com",
    });
    expect(parseDashboardSearch({ company: "Anara.COM" })).toEqual({
      company: "anara.com",
    });
  });

  test("drops empty / non-string company values", () => {
    expect(parseDashboardSearch({ company: "" })).toEqual({});
    expect(parseDashboardSearch({ company: 42 })).toEqual({});
    expect(parseDashboardSearch({ company: ["anara.com"] })).toEqual({});
  });

  test("company composes with user and range", () => {
    expect(parseDashboardSearch({ user: "alice", range: "7", company: "anara.com" })).toEqual({
      user: "alice",
      range: "7",
      company: "anara.com",
    });
    expect(parseDashboardSearch({ range: "bogus", company: "anara.com" })).toEqual({
      company: "anara.com",
    });
  });
});

describe("toggleFocus (row click semantics)", () => {
  test("clicking with no focus selects", () => {
    expect(toggleFocus(undefined, "alice")).toBe("alice");
  });

  test("clicking the focused user clears", () => {
    expect(toggleFocus("alice", "alice")).toBeUndefined();
  });

  test("clicking another user moves the focus", () => {
    expect(toggleFocus("alice", "bob")).toBe("bob");
  });
});

describe("toggleCompany (filter chip semantics)", () => {
  test("clicking with no filter selects", () => {
    expect(toggleCompany(undefined, "anara.com")).toBe("anara.com");
  });

  test("clicking the active company clears", () => {
    expect(toggleCompany("anara.com", "anara.com")).toBeUndefined();
  });

  test("clicking another company moves the filter", () => {
    expect(toggleCompany("anara.com", "linear.app")).toBe("linear.app");
  });
});

describe("toggleCategory (filter pill semantics, over ids)", () => {
  test("clicking with no filter selects", () => {
    expect(toggleCategory(undefined, 3)).toBe(3);
  });

  test("clicking the active category clears", () => {
    expect(toggleCategory(3, 3)).toBeUndefined();
  });

  test("clicking another category moves the filter", () => {
    expect(toggleCategory(3, 7)).toBe(7);
  });
});

describe("parseDashboardSearch (?category= validation)", () => {
  test("keeps a valid positive-integer id (from string or number)", () => {
    expect(parseDashboardSearch({ categoryId: "3" })).toEqual({ categoryId: 3 });
    expect(parseDashboardSearch({ categoryId: 5 })).toEqual({ categoryId: 5 });
  });

  test("drops empty / non-numeric / zero / negative / non-integer / array", () => {
    expect(parseDashboardSearch({ categoryId: "" })).toEqual({});
    expect(parseDashboardSearch({ categoryId: "abc" })).toEqual({});
    expect(parseDashboardSearch({ categoryId: "0" })).toEqual({});
    expect(parseDashboardSearch({ categoryId: -1 })).toEqual({});
    expect(parseDashboardSearch({ categoryId: 1.5 })).toEqual({});
    expect(parseDashboardSearch({ categoryId: ["3"] })).toEqual({});
  });

  test("composes with user + range", () => {
    expect(parseDashboardSearch({ user: "alice", range: "7", categoryId: "2" })).toEqual({
      user: "alice",
      range: "7",
      categoryId: 2,
    });
  });
});

describe("userStatsQuery (focus + range compose)", () => {
  test("lifetime: just the user param", () => {
    expect(userStatsQuery("alice", "all")).toBe("?user=alice");
  });

  test("rolling windows ride along as range=<N>d", () => {
    expect(userStatsQuery("alice", "7")).toBe("?range=7d&user=alice");
    expect(userStatsQuery("alice", "30")).toBe("?range=30d&user=alice");
  });

  test("months send explicit half-open since/until plus the user", () => {
    expect(userStatsQuery("alice", "2026-06")).toBe(
      `?since=${Date.UTC(2026, 5, 1)}&until=${Date.UTC(2026, 6, 1)}&user=alice`,
    );
  });

  test("user is URL-encoded", () => {
    expect(userStatsQuery("a b&c", "all")).toBe("?user=a%20b%26c");
  });
});

describe("dailyTimeseriesQuery (contribution grid)", () => {
  const since = Date.UTC(2026, 0, 1);

  test("team view: day buckets since Jan 1, no user filter", () => {
    expect(dailyTimeseriesQuery(since)).toBe(`?bucket=day&since=${since}`);
  });

  test("focus view appends the encoded user", () => {
    expect(dailyTimeseriesQuery(since, "a/b")).toBe(`?bucket=day&since=${since}&user=a%2Fb`);
  });
});

describe("userModelsToRows (GET /stats byModel → ModelRow)", () => {
  const stats: UserStats = {
    user: "alice",
    totalInputTokens: 300,
    totalOutputTokens: 150,
    totalCacheCreationTokens: 30,
    totalCacheReadTokens: 60,
    totalCostUsd: 1.5,
    userMessages: 4,
    assistantMessages: 6,
    byModel: [
      {
        model: "claude-sonnet-4-5",
        input: 200,
        output: 100,
        cacheCreation: 20,
        cacheRead: 40,
        reasoning: 0,
        count: 2,
        storedCostMicros: 0,
        costUsd: 1.5,
      },
      {
        model: "mystery-model",
        input: 100,
        output: 50,
        cacheCreation: 10,
        cacheRead: 20,
        reasoning: 0,
        count: 1,
        storedCostMicros: 0,
        costUsd: 0,
      },
    ],
    unknownModels: ["mystery-model"],
  };

  test("maps SQL column names onto the dashboard ModelRow shape", () => {
    const rows = userModelsToRows(stats);
    expect(rows[0]).toEqual({
      model: "claude-sonnet-4-5",
      count: 2,
      inputTokens: 200,
      outputTokens: 100,
      cacheCreationTokens: 20,
      cacheReadTokens: 40,
      costUsd: 1.5,
      unknownPrice: false,
    });
  });

  test("flags unknown-price models so the table renders — not $0", () => {
    const rows = userModelsToRows(stats);
    expect(rows[1]!.unknownPrice).toBe(true);
    expect(rows[1]!.costUsd).toBe(0);
  });
});
