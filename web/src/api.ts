import { dailyTimeseriesQuery, userStatsQuery } from "./focus";
import { rangeQuery } from "./range";

/**
 * Typed fetchers for the server endpoints; shapes mirror the route handlers
 * in src/server/main.ts. Server-side additions must land here as optional
 * fields so older server payloads never break the page.
 */

export interface ServerInfo {
  uptimeMs: number;
  eventsCount: number;
  dbSizeBytes: number;
  lastEventAt: number | null;
  teamName: string | null;
  /** Server release version (package.json) for the footer strip.
   *  Optional so older server payloads still render. */
  version?: string;
  /** True when TOKENLEADER_JOIN_TOKEN gates first claims: the hero
   *  appends the --join=<code> placeholder to the one-liner. */
  joinRequired?: boolean;
}

export interface LeaderboardRow {
  user: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  totalReasoningTokens: number;
  eventCount: number;
  lastEventAt: number;
  modelCount: number;
  userMessages: number;
  assistantMessages: number;
  costUsd: number;
  /** Normalized company domain ("anara.com") from the daemon's
   *  TOKENLEADER_COMPANY env, or null when never reported. */
  company: string | null;
}

export interface ModelRow {
  model: string;
  count: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  unknownPrice: boolean;
}

export interface RecentEventRow {
  id: number;
  user: string;
  source: string;
  model: string;
  timestamp: number;
  totalTokens: number;
  messageType: string;
}

export interface UninstalledRow {
  user: string;
  uninstalledAt: number;
}

export interface AdminStats {
  server: ServerInfo;
  messages: { userMessages: number; assistantMessages: number };
  leaderboard: LeaderboardRow[];
  byModel: ModelRow[];
  recent: RecentEventRow[];
  uninstalled: UninstalledRow[];
  /** Sorted distinct non-null companies across ALL users — always global,
   *  never narrowed by &company= (the filter pills need the full list).
   *  Optional so older server payloads still render. */
  companies?: string[];
}

export interface FleetDevice {
  label: string | null;
  version: string | null;
  arch: string | null;
  lastSeen: number | null;
  /** Same tri-state contract as FleetEntry.isLatest. */
  isLatest: boolean | null;
}

export interface FleetEntry {
  user: string;
  version: string | null;
  arch: string | null;
  lastSeen: number | null;
  reporting: boolean;
  /** true = on latest, false = stale, null = no published manifest to compare. */
  isLatest: boolean | null;
  /** One row per active machine. Optional so older server payloads render. */
  devices?: FleetDevice[];
}

export interface FleetStats {
  latestVersion: string | null;
  fleet: FleetEntry[];
}

/** Per-user slice of a /stats/timeseries day bucket (present only when no
 *  user filter is in effect — the contribution grid never filters). */
export interface TimeseriesUserSlice {
  user: string;
  events: number;
  costUsd: number;
  userMessages: number;
  assistantMessages: number;
}

export interface TimeseriesRow {
  bucketStart: number;
  /** "YYYY-MM-DD" for bucket=day (strftime, UTC). */
  bucketLabel: string;
  events: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
  costUsd: number;
  userMessages: number;
  assistantMessages: number;
  byUser?: TimeseriesUserSlice[];
}

export interface TimeseriesStats {
  bucket: string;
  rows: TimeseriesRow[];
}

/** Per-model row of GET /stats?user= — SQL column names (input/output/…),
 *  not the dashboard's ModelRow names. focus.ts userModelsToRows adapts. */
export interface UserModelRow {
  model: string;
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  reasoning: number;
  count: number;
  storedCostMicros: number;
  costUsd: number;
}

/** GET /stats?user=<u>&since=&until= — per-user totals for focus mode.
 *  Shape mirrors the route handler in src/server/main.ts. */
export interface UserStats {
  user: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  totalCostUsd: number;
  userMessages: number;
  assistantMessages: number;
  byModel: UserModelRow[];
  /** Models with no LiteLLM price (their byModel costUsd is 0). */
  unknownModels: string[];
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  if (res.status === 401 && typeof window !== "undefined") {
    // Dashboard cookie expired/rotated — bounce to /login. Admin-token
    // flows (postAdminClear) don't use this helper, so no redirect loop.
    window.location.assign("/login");
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** Append company=<c> to a query string that is either "" or "?...".
 *  Pure (bun-testable). The server ignores company= when user= is also
 *  present (user is the narrower scope), so callers never need to strip
 *  one or the other. */
export function withCompany(query: string, company?: string): string {
  if (!company) return query;
  const c = `company=${encodeURIComponent(company)}`;
  return query ? `${query}&${c}` : `?${c}`;
}

export function fetchAdminStats(range: string, company?: string): Promise<AdminStats> {
  return getJson<AdminStats>(`/stats/admin${withCompany(rangeQuery(range), company)}`);
}

export function fetchFleet(): Promise<FleetStats> {
  return getJson<FleetStats>("/stats/fleet");
}

/** Per-user stats for focus mode; `range` is the page's pill value. */
export function fetchUserStats(user: string, range: string): Promise<UserStats> {
  return getJson<UserStats>(`/stats${userStatsQuery(user, range)}`);
}

/** Daily buckets for the contribution grid: [sinceMs, now), UTC. All users
 *  by default; pass `user` in focus mode (server filters on &user=) or
 *  `company` for the ?company= filter. When both are sent the server
 *  ignores company — user is the narrower scope.
 *  Half-open like every server range (src/server/range.ts). */
export function fetchDailyTimeseries(
  sinceMs: number,
  user?: string,
  company?: string,
): Promise<TimeseriesStats> {
  return getJson<TimeseriesStats>(
    `/stats/timeseries${withCompany(dailyTimeseriesQuery(sinceMs, user), company)}`,
  );
}

export type ClearScope = "all" | "user" | "reset-user" | "full";

/** POST /admin/clear response — field names vary per scope. */
export interface ClearResult {
  scope: ClearScope;
  user?: string;
  removed?: number;
  removedEvents?: number;
  removedSecret?: number;
  remaining: number;
}

export class AdminClearError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function postAdminClear(
  token: string,
  scope: ClearScope,
  user?: string,
): Promise<ClearResult> {
  const res = await fetch("/admin/clear", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ scope, ...(user ? { user } : {}) }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new AdminClearError(
      res.status,
      typeof body.error === "string" ? body.error : "request failed",
    );
  }
  return body as unknown as ClearResult;
}
