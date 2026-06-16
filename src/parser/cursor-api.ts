import { createHash } from "node:crypto";
import {
  buildWorkosSessionToken,
  refreshCursorAccessToken,
} from "./cursor-auth.ts";
import type { TokenEvent } from "../types.ts";

/** Bare-host canonical URL — www redirects and POST CSRF checks expect this. */
export const CURSOR_ORIGIN = "https://cursor.com";

export const CURSOR_DASHBOARD_API =
  `${CURSOR_ORIGIN}/api/dashboard/get-filtered-usage-events`;

export const CURSOR_USAGE_SUMMARY_API = `${CURSOR_ORIGIN}/api/usage-summary`;

export const DEFAULT_PAGE_SIZE = 100;
export const FETCH_TIMEOUT_MS = 30_000;

export interface CursorApiAuth {
  sessionToken: string;
  refreshToken?: string;
  machineId?: string;
}

function cursorCookieHeader(token: string): string {
  return `WorkosCursorSessionToken=${token.trim()}`;
}

function dashboardHeaders(auth: CursorApiAuth): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Cookie: cursorCookieHeader(auth.sessionToken),
    Origin: CURSOR_ORIGIN,
  };
  if (auth.machineId) headers["x-cursor-client-id"] = auth.machineId;
  return headers;
}

function summaryHeaders(auth: CursorApiAuth): Record<string, string> {
  const headers: Record<string, string> = {
    Cookie: cursorCookieHeader(auth.sessionToken),
  };
  if (auth.machineId) headers["x-cursor-client-id"] = auth.machineId;
  return headers;
}

async function readCursorApiError(res: Response): Promise<string> {
  try {
    const text = await res.text();
    if (!text) return "";
    try {
      const json = JSON.parse(text) as { error?: unknown; message?: unknown };
      const msg = json.error ?? json.message;
      if (typeof msg === "string" && msg.length > 0) return msg;
    } catch {
      // not JSON — fall through to raw text
    }
    return text.slice(0, 200);
  } catch {
    return "";
  }
}

function authFailureMessage(status: number, detail: string): string {
  if (detail.includes("Invalid origin")) {
    return `cursor dashboard rejected the request (${detail})`;
  }
  if (status === 401) {
    return "cursor session token rejected (expired or invalid)";
  }
  if (status === 403) {
    return detail.length > 0
      ? `cursor dashboard access denied: ${detail}`
      : "cursor dashboard access denied (token may be expired or lack usage access)";
  }
  return `cursor dashboard API returned ${status}${detail ? `: ${detail}` : ""}`;
}

async function refreshSessionAuth(
  auth: CursorApiAuth,
  opts: { fetchImpl?: typeof fetch; signal?: AbortSignal },
): Promise<CursorApiAuth> {
  if (!auth.refreshToken) {
    throw new Error("cursor session token rejected (expired or invalid)");
  }
  const accessToken = await refreshCursorAccessToken(auth.refreshToken, opts);
  return {
    ...auth,
    sessionToken: buildWorkosSessionToken(accessToken),
  };
}

export interface FetchFilteredUsageEventsOptions {
  token: string;
  refreshToken?: string;
  machineId?: string;
  /** Inclusive lower bound (epoch ms). Defaults to 0 (all history). */
  startDate?: number;
  /** Exclusive upper bound (epoch ms). Omitted → no upper bound. */
  endDate?: number;
  pageSize?: number;
  /** Max pages to fetch this call (safety cap). Default 100. */
  maxPages?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export interface FetchFilteredUsageEventsResult {
  events: TokenEvent[];
  totalCount: number;
  pagesFetched: number;
  /** Set when a 401 triggered a token refresh during the fetch. */
  refreshedSessionToken?: string;
}

interface CursorDashboardTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
  totalCents?: number;
}

interface CursorDashboardUsageEvent {
  id?: string;
  timestamp?: string | number;
  model?: string;
  modelName?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalCents?: number;
  tokenUsage?: CursorDashboardTokenUsage;
}

interface CursorDashboardUsageResponse {
  totalUsageEventsCount?: number;
  usageEvents?: CursorDashboardUsageEvent[];
  usageEventsDisplay?: CursorDashboardUsageEvent[];
  pagination?: {
    numPages?: number;
    currentPage?: number;
    pageSize?: number;
    hasNextPage?: boolean;
    hasPreviousPage?: boolean;
  };
}

function parseTimestamp(raw: string | number | undefined): number | null {
  if (raw === undefined) return null;
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function readTokenFields(ev: CursorDashboardUsageEvent): {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalCents: number;
} {
  const tu = ev.tokenUsage;
  const inputTokens =
    typeof ev.inputTokens === "number"
      ? ev.inputTokens
      : typeof tu?.inputTokens === "number"
        ? tu.inputTokens
        : 0;
  const outputTokens =
    typeof ev.outputTokens === "number"
      ? ev.outputTokens
      : typeof tu?.outputTokens === "number"
        ? tu.outputTokens
        : 0;
  const cacheCreationTokens =
    typeof tu?.cacheWriteTokens === "number" ? tu.cacheWriteTokens : 0;
  const cacheReadTokens = typeof tu?.cacheReadTokens === "number" ? tu.cacheReadTokens : 0;
  const totalCents =
    typeof ev.totalCents === "number"
      ? ev.totalCents
      : typeof tu?.totalCents === "number"
        ? tu.totalCents
        : 0;
  return {
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    totalCents,
  };
}

function cursorSessionId(user: string, tsMs: number): string {
  const d = new Date(tsMs);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `cursor:${user}:${yyyy}-${mm}-${dd}`;
}

/**
 * Map one Cursor dashboard usage event onto tokenleader's TokenEvent shape.
 * Returns null when required fields are missing.
 */
export function mapCursorDashboardEvent(
  ev: CursorDashboardUsageEvent,
  user: string,
): TokenEvent | null {
  const timestamp = parseTimestamp(ev.timestamp);
  if (timestamp === null) return null;

  const model =
    (typeof ev.modelName === "string" && ev.modelName.length > 0
      ? ev.modelName
      : typeof ev.model === "string" && ev.model.length > 0
        ? ev.model
        : "") || "cursor";

  const id = typeof ev.id === "string" && ev.id.length > 0 ? ev.id : null;
  const tokens = readTokenFields(ev);

  // Deterministic messageId when the dashboard omits id — matches team mirror.
  const messageId =
    id ??
    createHash("sha256")
      .update(String(timestamp))
      .update(":")
      .update(model)
      .update(":")
      .update(String(tokens.inputTokens))
      .update(":")
      .update(String(tokens.outputTokens))
      .update(":")
      .update(String(tokens.cacheCreationTokens))
      .update(":")
      .update(String(tokens.cacheReadTokens))
      .digest("hex")
      .slice(0, 24);

  // totalCents is fractional cents; 1 cent = 10_000 micros.
  const costUsdMicros = Math.round(tokens.totalCents * 10_000);

  return {
    user,
    source: "cursor",
    sessionId: cursorSessionId(user, timestamp),
    messageId,
    requestId: id,
    timestamp,
    model,
    messageType: "assistant",
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    cacheCreationTokens: tokens.cacheCreationTokens,
    cacheReadTokens: tokens.cacheReadTokens,
    reasoningTokens: null,
    costUsdMicros,
  };
}

function eventsFromResponse(body: CursorDashboardUsageResponse): CursorDashboardUsageEvent[] {
  if (Array.isArray(body.usageEvents) && body.usageEvents.length > 0) {
    return body.usageEvents;
  }
  if (Array.isArray(body.usageEventsDisplay) && body.usageEventsDisplay.length > 0) {
    return body.usageEventsDisplay;
  }
  return body.usageEvents ?? body.usageEventsDisplay ?? [];
}

/**
 * Verify a WorkosCursorSessionToken by hitting the dashboard usage summary.
 * GET avoids the POST CSRF Origin check while still proving the cookie works.
 */
export async function validateCursorToken(
  token: string,
  opts: {
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
    refreshToken?: string;
    machineId?: string;
  } = {},
): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let auth: CursorApiAuth = {
    sessionToken: token,
    refreshToken: opts.refreshToken,
    machineId: opts.machineId,
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetchImpl(CURSOR_USAGE_SUMMARY_API, {
      method: "GET",
      headers: summaryHeaders(auth),
      signal: opts.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (res.status === 401 && attempt === 0 && auth.refreshToken) {
      auth = await refreshSessionAuth(auth, { fetchImpl, signal: opts.signal });
      continue;
    }

    if (res.status === 401 || res.status === 403) {
      const detail = await readCursorApiError(res);
      throw new Error(authFailureMessage(res.status, detail));
    }
    if (!res.ok) {
      const detail = await readCursorApiError(res);
      throw new Error(authFailureMessage(res.status, detail));
    }

    try {
      await res.json();
    } catch {
      throw new Error("cursor dashboard API returned a non-JSON response");
    }
    return;
  }
}

/**
 * Fetch usage events from Cursor's personal dashboard API, paginating until
 * `maxPages` or the API reports no further pages.
 */
export async function fetchFilteredUsageEvents(
  user: string,
  opts: FetchFilteredUsageEventsOptions,
): Promise<FetchFilteredUsageEventsResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxPages = opts.maxPages ?? 100;
  const startDate = opts.startDate ?? 0;

  let auth: CursorApiAuth = {
    sessionToken: opts.token,
    refreshToken: opts.refreshToken,
    machineId: opts.machineId,
  };
  let refreshedSessionToken: string | undefined;

  const events: TokenEvent[] = [];
  let totalCount = 0;
  let pagesFetched = 0;

  for (let page = 1; page <= maxPages; page++) {
    const body: Record<string, unknown> = {
      pageSize,
      page,
      startDate,
    };
    if (opts.endDate !== undefined) body.endDate = opts.endDate;

    let res = await fetchImpl(CURSOR_DASHBOARD_API, {
      method: "POST",
      headers: dashboardHeaders(auth),
      body: JSON.stringify(body),
      signal: opts.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (res.status === 401 && auth.refreshToken) {
      auth = await refreshSessionAuth(auth, { fetchImpl, signal: opts.signal });
      refreshedSessionToken = auth.sessionToken;
      res = await fetchImpl(CURSOR_DASHBOARD_API, {
        method: "POST",
        headers: dashboardHeaders(auth),
        body: JSON.stringify(body),
        signal: opts.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    }

    if (res.status === 401 || res.status === 403 || !res.ok) {
      const detail = await readCursorApiError(res);
      throw new Error(authFailureMessage(res.status, detail));
    }

    const json = (await res.json()) as CursorDashboardUsageResponse;
    pagesFetched += 1;
    totalCount = json.totalUsageEventsCount ?? totalCount;

    for (const raw of eventsFromResponse(json)) {
      const mapped = mapCursorDashboardEvent(raw, user);
      if (mapped) events.push(mapped);
    }

    const pageEvents = eventsFromResponse(json);
    if (pageEvents.length === 0) break;
    if (json.pagination?.hasNextPage === false) break;
    // Personal dashboard responses often omit pagination; keep going while
    // pages come back full.
    if (json.pagination?.hasNextPage !== true && pageEvents.length < pageSize) break;
  }

  return { events, totalCount, pagesFetched, refreshedSessionToken };
}
