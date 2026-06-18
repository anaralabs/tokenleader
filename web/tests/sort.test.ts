import { describe, expect, test } from "bun:test";
import type { LeaderboardRow } from "../src/api";
import { DEFAULT_SORT, nextSort, sortRows } from "../src/leaderboard-sort";

function row(over: Partial<LeaderboardRow>): LeaderboardRow {
  return {
    user: "x",
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    totalReasoningTokens: 0,
    eventCount: 0,
    lastEventAt: 0,
    modelCount: 0,
    userMessages: 0,
    assistantMessages: 0,
    costUsd: 0,
    company: null,
    ...over,
  };
}

describe("sortRows", () => {
  test("cost desc is the default leaderboard order", () => {
    const rows = [
      row({ user: "a", costUsd: 10 }),
      row({ user: "b", costUsd: 30 }),
      row({ user: "c", costUsd: 20 }),
    ];
    expect(sortRows(rows, "cost", "desc").map((r) => r.user)).toEqual(["b", "c", "a"]);
  });

  test("flipping direction reverses (cost asc)", () => {
    const rows = [row({ user: "a", costUsd: 10 }), row({ user: "b", costUsd: 30 })];
    expect(sortRows(rows, "cost", "asc").map((r) => r.user)).toEqual(["a", "b"]);
  });

  test("user sorts A→Z", () => {
    const rows = [row({ user: "charlie" }), row({ user: "alice" }), row({ user: "bob" })];
    expect(sortRows(rows, "user", "asc").map((r) => r.user)).toEqual(["alice", "bob", "charlie"]);
  });

  test("messages sums user + assistant", () => {
    const rows = [
      row({ user: "a", userMessages: 1, assistantMessages: 1 }),
      row({ user: "b", userMessages: 5, assistantMessages: 5 }),
    ];
    expect(sortRows(rows, "messages", "desc").map((r) => r.user)).toEqual(["b", "a"]);
  });

  test("ties break on user for a stable order", () => {
    const rows = [row({ user: "z", costUsd: 5 }), row({ user: "a", costUsd: 5 })];
    expect(sortRows(rows, "cost", "desc").map((r) => r.user)).toEqual(["a", "z"]);
  });

  test("does not mutate the input array", () => {
    const rows = [row({ user: "a", costUsd: 1 }), row({ user: "b", costUsd: 2 })];
    const before = [...rows];
    sortRows(rows, "cost", "desc");
    expect(rows).toEqual(before);
  });
});

describe("nextSort (3-click cycle)", () => {
  test("1st click on a fresh column sorts it in its natural direction", () => {
    expect(nextSort(DEFAULT_SORT, "output")).toEqual({ key: "output", dir: "desc" });
    expect(nextSort(DEFAULT_SORT, "user")).toEqual({ key: "user", dir: "asc" });
  });

  test("2nd click flips the active column's direction", () => {
    expect(nextSort({ key: "output", dir: "desc" }, "output")).toEqual({
      key: "output",
      dir: "asc",
    });
    expect(nextSort({ key: "user", dir: "asc" }, "user")).toEqual({ key: "user", dir: "desc" });
  });

  test("3rd click resets back to the default (cost-desc)", () => {
    expect(nextSort({ key: "output", dir: "asc" }, "output")).toEqual(DEFAULT_SORT);
    expect(nextSort({ key: "user", dir: "desc" }, "user")).toEqual(DEFAULT_SORT);
  });

  test("a full 3-click cycle returns to the starting state", () => {
    let s = DEFAULT_SORT;
    s = nextSort(s, "input"); // input desc
    s = nextSort(s, "input"); // input asc
    s = nextSort(s, "input"); // reset -> cost desc
    expect(s).toEqual(DEFAULT_SORT);
  });
});
