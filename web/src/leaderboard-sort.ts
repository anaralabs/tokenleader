import type { LeaderboardRow } from "./api";

// Pure leaderboard-sort logic, kept OUT of LeaderboardTable.tsx so its tests
// import no React — the root `bun test` recurses into web/tests and would
// otherwise fail to resolve react/jsx-dev-runtime (a web-only dep).

export type SortKey =
  | "user"
  | "messages"
  | "input"
  | "output"
  | "cacheCreate"
  | "cacheRead"
  | "cost"
  | "lastActive";
export type SortDir = "asc" | "desc";
export type Sort = { key: SortKey; dir: SortDir };

// Per-column sort value; numbers compare numerically, the user string A→Z.
const SORT_VALUE: Record<SortKey, (u: LeaderboardRow) => number | string> = {
  user: (u) => u.user.toLowerCase(),
  messages: (u) => (u.userMessages || 0) + (u.assistantMessages || 0),
  input: (u) => u.totalInputTokens,
  output: (u) => u.totalOutputTokens,
  cacheCreate: (u) => u.totalCacheCreationTokens,
  cacheRead: (u) => u.totalCacheReadTokens,
  cost: (u) => u.costUsd ?? 0,
  lastActive: (u) => u.lastEventAt,
};

// First click on a column sorts in its natural direction (biggest/most-recent
// first for numbers; A→Z for the name); clicking the active column flips it.
const DEFAULT_DIR: Record<SortKey, SortDir> = {
  user: "asc",
  messages: "desc",
  input: "desc",
  output: "desc",
  cacheCreate: "desc",
  cacheRead: "desc",
  cost: "desc",
  lastActive: "desc",
};

/** The canonical leaderboard order — also the reset target of the 3-click cycle. */
export const DEFAULT_SORT: Sort = { key: "cost", dir: "desc" };

/**
 * Three-click header cycle:
 *   1st click → sort by the column in its natural direction,
 *   2nd click → flip the direction,
 *   3rd click → reset back to DEFAULT_SORT (cost-desc).
 */
export function nextSort(current: Sort, key: SortKey): Sort {
  if (current.key !== key) return { key, dir: DEFAULT_DIR[key] };
  if (current.dir === DEFAULT_DIR[key]) {
    return { key, dir: current.dir === "asc" ? "desc" : "asc" };
  }
  return { ...DEFAULT_SORT };
}

/** Pure, stable leaderboard sort. Returns a new array; ties break on user. */
export function sortRows(rows: LeaderboardRow[], key: SortKey, dir: SortDir): LeaderboardRow[] {
  const get = SORT_VALUE[key];
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = get(a);
    const vb = get(b);
    const cmp =
      typeof va === "string" && typeof vb === "string"
        ? va.localeCompare(vb)
        : Number(va) - Number(vb);
    return (cmp !== 0 ? cmp * sign : a.user.localeCompare(b.user)) || 0;
  });
}
