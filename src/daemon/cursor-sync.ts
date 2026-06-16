import { fetchFilteredUsageEvents } from "../parser/cursor-api";
import type { DaemonState, TokenEvent } from "../types";
import {
  loadCursorCloudAuth,
  loadCursorCredentials,
  saveCursorCredentials,
  saveCursorToken,
} from "./cursor-token";
import { log } from "./log";
import { postEvents, type TransportOpts } from "./transport";

/** Re-fetch this much overlap on incremental syncs to catch late-arriving rows. */
export const CURSOR_SYNC_OVERLAP_MS = 5 * 60 * 1000;
/** Default incremental window when no prior cloud sync exists. */
export const CURSOR_SYNC_DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000;
/** Incremental daemon ticks — small page cap keeps each tick fast. */
export const CURSOR_SYNC_INCREMENTAL_MAX_PAGES = 10;
/** Full backfill via `sync-cursor` — drains large histories across one run. */
export const CURSOR_SYNC_FULL_MAX_PAGES = 500;
/**
 * Background first-run backfill: the daemon pulls all-time history in bounded
 * chunks drained across ticks (resumePage continuation) so a large history
 * never blocks a single tick. ~25 pages ≈ 2,500 events per tick.
 */
export const CURSOR_SYNC_BACKFILL_MAX_PAGES = 25;

export type CursorSyncMode = "incremental" | "full" | "month";

export interface FetchCursorCloudOpts {
  user: string;
  stateDir: string;
  state: DaemonState;
  mode: CursorSyncMode;
  /** Per-call page cap override (e.g. a bounded background-backfill chunk). */
  maxPages?: number;
  signal?: AbortSignal;
  loadCursorCloudAuth?: typeof loadCursorCloudAuth;
  fetchFilteredUsageEvents?: typeof fetchFilteredUsageEvents;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface FetchCursorCloudResult {
  skipped: boolean;
  startDate: number;
  mode: CursorSyncMode;
  events: TokenEvent[];
  totalCount: number;
  pagesFetched: number;
  /** False when the fetch stopped at the page cap with more pages possible. */
  complete: boolean;
  /** 1-based page to resume from next call; present iff complete === false. */
  nextPage?: number;
}

export interface CursorCloudSyncOpts {
  user: string;
  stateDir: string;
  state: DaemonState;
  transport: TransportOpts;
  mode: CursorSyncMode;
  signal?: AbortSignal;
  loadCursorCloudAuth?: typeof loadCursorCloudAuth;
  fetchFilteredUsageEvents?: typeof fetchFilteredUsageEvents;
  fetchImpl?: typeof fetch;
  postEvents?: typeof postEvents;
  now?: () => number;
}

export interface CursorCloudSyncResult {
  state: DaemonState;
  eventsFetched: number;
  eventsPosted: number;
  inserted: number;
  duplicates: number;
  posted: boolean;
  skipped: boolean;
  complete: boolean;
  nextPage?: number;
}

export function currentMonthStartMs(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

export function computeCursorSyncStartDate(
  state: DaemonState,
  mode: CursorSyncMode,
  now: number,
): number {
  if (mode === "full") return 0;
  if (mode === "month") return currentMonthStartMs(now);
  const cloud = state.cursorCloud;
  if (cloud?.lastEventTimestamp && cloud.lastEventTimestamp > 0) {
    return Math.max(0, cloud.lastEventTimestamp - CURSOR_SYNC_OVERLAP_MS);
  }
  if (cloud?.lastSyncAt && cloud.lastSyncAt > 0) {
    return Math.max(0, cloud.lastSyncAt - CURSOR_SYNC_OVERLAP_MS);
  }
  return Math.max(0, now - CURSOR_SYNC_DEFAULT_LOOKBACK_MS);
}

export function computeCursorSyncEndDate(mode: CursorSyncMode, now: number): number | undefined {
  if (mode === "month") return now;
  return undefined;
}

function maxEventTimestamp(events: TokenEvent[]): number {
  let max = 0;
  for (const ev of events) {
    if (ev.timestamp > max) max = ev.timestamp;
  }
  return max;
}

export function nextCursorCloudState(
  state: DaemonState,
  mode: CursorSyncMode,
  events: TokenEvent[],
  now: number,
  complete: boolean,
  nextPage?: number,
  startDate?: number,
): DaemonState {
  const prevCloud = state.cursorCloud;
  // Incremental derives its startDate from the watermark, so on a truncated
  // (newest-first) run the watermark must NOT advance or the older tail is
  // skipped. Full/month use a fixed startDate and can advance the running max
  // freely, resuming the unfetched tail via resumePage.
  const advance = mode === "incremental" ? complete : true;
  const lastEventTimestamp = advance
    ? Math.max(maxEventTimestamp(events), prevCloud?.lastEventTimestamp ?? 0)
    : (prevCloud?.lastEventTimestamp ?? 0);
  return {
    ...state,
    cursorCloud: {
      lastSyncAt: now,
      ...(lastEventTimestamp > 0 ? { lastEventTimestamp } : {}),
      // Latches only when an all-time `full` walk completes — never on a month
      // window or a truncated chunk.
      ...((mode === "full" && complete) || prevCloud?.fullSyncDone ? { fullSyncDone: true } : {}),
      // resumeStartDate tags the window the resume belongs to, so a manual
      // `sync-cursor` can't reuse an incremental resume marker (or vice versa).
      ...(complete
        ? {}
        : {
            resumePage: nextPage,
            ...(startDate !== undefined ? { resumeStartDate: startDate } : {}),
          }),
    },
  };
}

/**
 * Fetch official Cursor dashboard usage events. Does not POST — callers
 * merge into their own batch (daemon tick) or post via runCursorCloudSync.
 */
export async function fetchCursorCloudEvents(
  opts: FetchCursorCloudOpts,
): Promise<FetchCursorCloudResult> {
  const loadAuth = opts.loadCursorCloudAuth ?? loadCursorCloudAuth;
  const fetchEvents = opts.fetchFilteredUsageEvents ?? fetchFilteredUsageEvents;
  const nowFn = opts.now ?? Date.now;
  const syncNow = nowFn();

  const auth = await loadAuth(opts.stateDir);
  if (!auth) {
    return {
      skipped: true,
      startDate: 0,
      mode: opts.mode,
      events: [],
      totalCount: 0,
      pagesFetched: 0,
      complete: true,
    };
  }

  const startDate = computeCursorSyncStartDate(opts.state, opts.mode, syncNow);
  const endDate = computeCursorSyncEndDate(opts.mode, syncNow);
  const maxPages =
    opts.maxPages ??
    (opts.mode === "full" || opts.mode === "month"
      ? CURSOR_SYNC_FULL_MAX_PAGES
      : CURSOR_SYNC_INCREMENTAL_MAX_PAGES);
  // Resume a truncated walk only when this call targets the same window that
  // pinned resumePage; otherwise start fresh at page 1.
  const cloud = opts.state.cursorCloud;
  const startPage =
    cloud?.resumePage !== undefined && cloud.resumeStartDate === startDate ? cloud.resumePage : 1;

  const r = await fetchEvents(opts.user, {
    token: auth.sessionToken,
    startDate,
    ...(endDate !== undefined ? { endDate } : {}),
    maxPages,
    startPage,
    signal: opts.signal,
    ...(auth.refreshToken ? { refreshToken: auth.refreshToken } : {}),
    ...(auth.machineId ? { machineId: auth.machineId } : {}),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });

  if (r.refreshedSessionToken) {
    const creds = await loadCursorCredentials(opts.stateDir);
    if (creds) {
      await saveCursorCredentials(opts.stateDir, {
        ...creds,
        sessionToken: r.refreshedSessionToken,
      });
    } else {
      await saveCursorToken(opts.stateDir, r.refreshedSessionToken);
    }
  }

  log.info("cursor_cloud_fetched", {
    mode: opts.mode,
    startDate,
    events: r.events.length,
    totalCount: r.totalCount,
    pages: r.pagesFetched,
  });

  return {
    skipped: false,
    startDate,
    mode: opts.mode,
    events: r.events,
    totalCount: r.totalCount,
    pagesFetched: r.pagesFetched,
    complete: r.complete,
    ...(r.complete ? {} : { nextPage: r.nextPage }),
  };
}

/**
 * Full cloud sync for `tokenleader sync-cursor`: fetch dashboard history,
 * POST to the leaderboard, and advance the cloud watermark on success.
 */
export async function runCursorCloudSync(
  opts: CursorCloudSyncOpts,
): Promise<CursorCloudSyncResult> {
  const post = opts.postEvents ?? postEvents;
  const now = opts.now ?? Date.now;

  let fetched: FetchCursorCloudResult;
  try {
    fetched = await fetchCursorCloudEvents(opts);
  } catch (err: unknown) {
    log.error("cursor_cloud_fetch_failed", {
      mode: opts.mode,
      err: String((err as Error)?.message ?? err),
    });
    return {
      state: opts.state,
      eventsFetched: 0,
      eventsPosted: 0,
      inserted: 0,
      duplicates: 0,
      posted: false,
      skipped: false,
      complete: false,
    };
  }

  if (fetched.skipped) {
    return {
      state: opts.state,
      eventsFetched: 0,
      eventsPosted: 0,
      inserted: 0,
      duplicates: 0,
      posted: true,
      skipped: true,
      complete: true,
    };
  }

  if (!fetched.complete) {
    log.warn("cursor_cloud_truncated", {
      pagesFetched: fetched.pagesFetched,
      nextPage: fetched.nextPage,
    });
  }

  let inserted = 0;
  let duplicates = 0;
  if (fetched.events.length > 0) {
    const r = await post(fetched.events, opts.transport, opts.signal);
    if (!r.ok) {
      log.error("cursor_cloud_post_failed", {
        mode: opts.mode,
        events: fetched.events.length,
        err: r.error,
      });
      return {
        state: opts.state,
        eventsFetched: fetched.events.length,
        eventsPosted: 0,
        inserted: 0,
        duplicates: 0,
        posted: false,
        skipped: false,
        complete: fetched.complete,
        ...(fetched.complete ? {} : { nextPage: fetched.nextPage }),
      };
    }
    inserted = r.inserted;
    duplicates = r.duplicates;
  }

  return {
    state: nextCursorCloudState(
      opts.state,
      opts.mode,
      fetched.events,
      now(),
      fetched.complete,
      fetched.nextPage,
      fetched.startDate,
    ),
    eventsFetched: fetched.events.length,
    eventsPosted: fetched.events.length,
    inserted,
    duplicates,
    posted: true,
    skipped: false,
    complete: fetched.complete,
    ...(fetched.complete ? {} : { nextPage: fetched.nextPage }),
  };
}
