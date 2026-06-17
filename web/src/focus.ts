import type { ModelRow, UserStats } from "./api";
import { isValidRange, rangeQuery } from "./range";

/**
 * User focus mode — pure logic, no DOM (bun-testable). The focused user
 * lives in the route's search params (?user=alice) so a focus is shareable
 * and survives refresh; the range pill rides along as ?range=.
 */

export interface DashboardSearch {
  /** Focused leaderboard user. Absent = team view. */
  user?: string;
  /** Range pill value ("7" | "30" | "all" | "YYYY-MM"). Absent = the
   *  localStorage-persisted default. */
  range?: string;
  /** Company filter (?company=anara.com). Absent = all companies. Domains
   *  are stored lowercase server-side, so the param is lowercased here. */
  company?: string;
  /** Category filter (?category=3) — an admin-defined-category id, NOT a
   *  string. Absent = all categories. Validated as a positive integer; a
   *  dangling/unknown id is self-healed (dropped) in the index route. */
  categoryId?: number;
}

/** validateSearch for the index route: keep only well-formed values so a
 *  hand-edited URL can never wedge the dashboard. */
export function parseDashboardSearch(search: Record<string, unknown>): DashboardSearch {
  const out: DashboardSearch = {};
  if (typeof search.user === "string" && search.user.length > 0) {
    out.user = search.user;
  }
  if (typeof search.range === "string" && isValidRange(search.range)) {
    out.range = search.range;
  }
  if (typeof search.company === "string" && search.company.length > 0) {
    out.company = search.company.toLowerCase();
  }
  // Accept a string or number; keep only a positive integer. Existence is NOT
  // checked here — a dangling/unknown id is self-healed in the index route.
  if (typeof search.categoryId === "string" || typeof search.categoryId === "number") {
    const n = Number(search.categoryId);
    if (Number.isInteger(n) && n > 0) out.categoryId = n;
  }
  return out;
}

/** Clicking a row toggles: same user clears the focus, any other user
 *  moves it. undefined = no focus. */
export function toggleFocus(current: string | undefined, clicked: string): string | undefined {
  return current === clicked ? undefined : clicked;
}

/** Clicking a company chip toggles the same way: the active company clears
 *  the filter, any other company moves it. undefined = no filter. */
export function toggleCompany(current: string | undefined, clicked: string): string | undefined {
  return current === clicked ? undefined : clicked;
}

/** Clicking a category pill toggles over ids: the active category clears the
 *  filter, any other moves it. undefined = no filter. */
export function toggleCategory(current: number | undefined, clicked: number): number | undefined {
  return current === clicked ? undefined : clicked;
}

/** Query string for GET /stats (per-user totals + byModel). Composes the
 *  page's range selection with the user filter — same half-open
 *  [since, until) contract as rangeQuery. Always has a leading "?". */
export function userStatsQuery(user: string, range: string): string {
  const r = rangeQuery(range); // "?..." or "" (lifetime)
  const u = `user=${encodeURIComponent(user)}`;
  return r ? `${r}&${u}` : `?${u}`;
}

/** Query string for GET /stats/timeseries day buckets, optionally scoped
 *  to the focused user (the server filters when &user= is present). */
export function dailyTimeseriesQuery(sinceMs: number, user?: string): string {
  const base = `?bucket=day&since=${sinceMs}`;
  return user ? `${base}&user=${encodeURIComponent(user)}` : base;
}

/**
 * Adapt GET /stats byModel rows (SQL column names: input/output/...) onto
 * the dashboard's ModelRow shape so the focused view reuses ModelsTable
 * unchanged. unknownPrice mirrors the server's unknownModels list (those
 * rows come back with costUsd 0 and should render "—", not "$0.0000").
 */
export function userModelsToRows(stats: UserStats): ModelRow[] {
  const unknown = new Set(stats.unknownModels);
  return stats.byModel.map((m) => ({
    model: m.model,
    count: m.count,
    inputTokens: m.input,
    outputTokens: m.output,
    cacheCreationTokens: m.cacheCreation,
    cacheReadTokens: m.cacheRead,
    costUsd: m.costUsd,
    unknownPrice: unknown.has(m.model),
  }));
}
