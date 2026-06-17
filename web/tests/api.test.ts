import { describe, expect, test } from "bun:test";
import { withCategory, withCompany } from "../src/api";
import { dailyTimeseriesQuery, userStatsQuery } from "../src/focus";
import { rangeQuery } from "../src/range";

describe("withCompany (?company= appended to existing query strings)", () => {
  test("no company: query passes through untouched", () => {
    expect(withCompany("")).toBe("");
    expect(withCompany("?range=7d")).toBe("?range=7d");
    expect(withCompany("?range=7d", undefined)).toBe("?range=7d");
  });

  test("empty query starts one", () => {
    expect(withCompany("", "anara.com")).toBe("?company=anara.com");
  });

  test("existing query gets &company=", () => {
    expect(withCompany("?range=30d", "anara.com")).toBe("?range=30d&company=anara.com");
  });

  test("company is URL-encoded", () => {
    expect(withCompany("", "a b&c.com")).toBe("?company=a%20b%26c.com");
  });

  test("composes with rangeQuery exactly as fetchAdminStats does", () => {
    // Lifetime ("all") yields "" — company must still produce a valid query.
    expect(withCompany(rangeQuery("all"), "anara.com")).toBe("?company=anara.com");
    expect(withCompany(rangeQuery("7"), "anara.com")).toBe("?range=7d&company=anara.com");
    const since = Date.UTC(2026, 5, 1);
    const until = Date.UTC(2026, 6, 1);
    expect(withCompany(rangeQuery("2026-06"), "anara.com")).toBe(
      `?since=${since}&until=${until}&company=anara.com`,
    );
  });

  test("composes with dailyTimeseriesQuery as fetchDailyTimeseries does", () => {
    const since = Date.UTC(2026, 0, 1);
    expect(withCompany(dailyTimeseriesQuery(since), "anara.com")).toBe(
      `?bucket=day&since=${since}&company=anara.com`,
    );
    // Both user= and company=: legal to send — the server ignores company
    // (user is the narrower scope) — though the grid never does.
    expect(withCompany(dailyTimeseriesQuery(since, "alice"), "anara.com")).toBe(
      `?bucket=day&since=${since}&user=alice&company=anara.com`,
    );
  });

  test("composes with userStatsQuery (focus fetch never sends company)", () => {
    expect(withCompany(userStatsQuery("alice", "all"))).toBe("?user=alice");
  });
});

describe("withCategory (?category= appended to existing query strings)", () => {
  test("no id: query passes through untouched", () => {
    expect(withCategory("")).toBe("");
    expect(withCategory("?range=7d")).toBe("?range=7d");
    expect(withCategory("?range=7d", undefined)).toBe("?range=7d");
  });

  test("empty query starts one", () => {
    expect(withCategory("", 3)).toBe("?category=3");
  });

  test("existing query gets &category=", () => {
    expect(withCategory("?range=30d", 7)).toBe("?range=30d&category=7");
  });

  test("composes after withCompany exactly as fetchAdminStats does", () => {
    // Both helpers compose; category and company are mutually exclusive in the
    // UI, but the chaining must produce a valid query either way.
    expect(withCategory(withCompany(rangeQuery("7")), 2)).toBe("?range=7d&category=2");
    expect(withCategory(withCompany(rangeQuery("all")), 5)).toBe("?category=5");
  });
});
