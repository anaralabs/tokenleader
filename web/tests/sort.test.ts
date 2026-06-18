import { describe, expect, test } from "bun:test";
import type { LeaderboardRow } from "../src/api";
import { sortRows } from "../src/components/LeaderboardTable";

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
