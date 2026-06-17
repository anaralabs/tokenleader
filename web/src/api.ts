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
  /** Assigned category (admin-defined). Optional/nullable so older server
   *  payloads — which never carried these fields — still render. */
  categoryId?: number | null;
  categoryName?: string | null;
  categoryColor?: string | null;
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

/** Admin-defined category (Engineering, Growth, …). `assignedCount` is the
 *  live number of users assigned to it — the dashboard gates filter pills on
 *  `assignedCount >= 1`. */
export interface Category {
  id: number;
  name: string;
  color: string | null;
  sortOrder: number;
  assignedCount: number;
}

/** A claimed user + their current category assignment, for the admin
 *  assignment table (GET /admin/users). */
export interface ClaimedUser {
  username: string;
  claimedAt: number;
  categoryId: number | null;
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
  /** Admin-defined categories, always global (never narrowed by &category=).
   *  Optional so older server payloads still render. */
  categories?: Category[];
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

/** Append category=<id> to a query string ("" or "?..."). Pure (bun-testable).
 *  Category and company are mutually exclusive in the UI, but both helpers
 *  compose so callers don't special-case the empty-query base. */
export function withCategory(query: string, categoryId?: number): string {
  if (categoryId === undefined) return query;
  const c = `category=${categoryId}`;
  return query ? `${query}&${c}` : `?${c}`;
}

export function fetchAdminStats(
  range: string,
  company?: string,
  categoryId?: number,
): Promise<AdminStats> {
  return getJson<AdminStats>(
    `/stats/admin${withCategory(withCompany(rangeQuery(range), company), categoryId)}`,
  );
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

// --- categories admin (all requireAdmin-gated → bearer header, NOT the
// dashboard cookie, so these cannot use getJson; written like postAdminClear
// and surfacing the same AdminClearError on a non-2xx). ----------------------

/** Shared bearer fetch for the admin category/user routes. Throws
 *  AdminClearError(status, body.error) on a non-2xx (401/403 → token problem,
 *  409 → duplicate, 404 → unknown), so callers reuse the DangerZone handling. */
async function adminFetch(
  token: string,
  path: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  body?: unknown,
): Promise<Record<string, unknown>> {
  const res = await fetch(path, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      authorization: `Bearer ${token}`,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new AdminClearError(
      res.status,
      typeof parsed.error === "string" ? parsed.error : "request failed",
    );
  }
  return parsed;
}

export async function fetchCategories(token: string): Promise<Category[]> {
  const body = await adminFetch(token, "/admin/categories", "GET");
  return (body.categories as Category[]) ?? [];
}

export async function fetchClaimedUsers(token: string): Promise<ClaimedUser[]> {
  const body = await adminFetch(token, "/admin/users", "GET");
  return (body.users as ClaimedUser[]) ?? [];
}

export async function createCategory(
  token: string,
  name: string,
  color: string | null,
): Promise<{ id: number }> {
  const body = await adminFetch(token, "/admin/categories", "POST", { name, color });
  return { id: body.id as number };
}

export async function updateCategory(
  token: string,
  id: number,
  name: string,
  color: string | null,
): Promise<void> {
  await adminFetch(token, `/admin/categories/${id}`, "PATCH", { name, color });
}

export async function deleteCategoryApi(token: string, id: number): Promise<void> {
  await adminFetch(token, `/admin/categories/${id}`, "DELETE");
}

export async function assignUserCategory(
  token: string,
  user: string,
  categoryId: number | null,
): Promise<void> {
  await adminFetch(token, "/admin/users/category", "POST", { user, categoryId });
}
