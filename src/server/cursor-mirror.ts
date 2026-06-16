import { centsToMicros, cursorMessageId, cursorSessionId } from "../parser/cursor-dedup.ts";
import { CURSOR_WATERMARK_META_KEY } from "./db.ts";
import type { Store } from "./db.ts";
import type { TokenEvent } from "../types.ts";

const DEFAULT_INTERVAL_SEC = 15 * 60; // 15 min — matches BinaryMirror cadence
const INITIAL_FETCH_DELAY_MS = 5_000;
const CURSOR_API_BASE = "https://api.cursor.com";
const PAGE_SIZE = 100;
// Hard per-tick page cap keeps a backfill under Cursor's 20 req/min limit;
// bigger histories drain across ticks via resumePage + the persisted
// watermark.
const MAX_PAGES_PER_TICK = 60;
// server_meta key holding the persisted watermark (see loadWatermark).
const WATERMARK_META_KEY = CURSOR_WATERMARK_META_KEY;

export interface MirrorLogger {
  info: (msg: string, data?: Record<string, unknown>) => void;
  warn: (msg: string, data?: Record<string, unknown>) => void;
  error: (msg: string, data?: Record<string, unknown>) => void;
}
const consoleLogger: MirrorLogger = {
  info: (msg, data) => console.log("[cursor-mirror]", msg, data ?? ""),
  warn: (msg, data) => console.warn("[cursor-mirror]", msg, data ?? ""),
  error: (msg, data) => console.error("[cursor-mirror]", msg, data ?? ""),
};

/**
 * Cursor team-member email → leaderboard username. Unmapped emails are
 * skipped. Keys MUST be lowercase (toTokenEvent lowercases before lookup).
 * Configured via config.ts; the mirror itself never reads env.
 */
export type EmailUserMap = Readonly<Record<string, string>>;

interface CursorUsageEvent {
  timestamp: string; // epoch ms as string
  userEmail: string;
  model: string;
  kind?: string;
  maxMode?: boolean;
  isTokenBasedCall?: boolean;
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    cacheWriteTokens: number;
    cacheReadTokens: number;
    totalCents: number;
  };
}

interface CursorEventsResponse {
  totalUsageEventsCount?: number;
  pagination?: {
    numPages: number;
    currentPage: number;
    pageSize: number;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
  };
  usageEvents?: CursorUsageEvent[];
}

export interface CursorMirrorOpts {
  /** The store to insert into. The mirror owns the source="cursor" rows. */
  store: Store;
  /** Cursor admin API key (the `crsr_*` token). */
  token: string;
  /** Email → leaderboard-user map. Events whose email isn't here are skipped. */
  userMap: EmailUserMap;
  /** Defaults to 15 minutes. */
  intervalSec?: number;
  /** Defaults to 5s after `start()`. Tests can shorten. */
  initialDelayMs?: number;
  /** Inject a fetch impl for tests. */
  fetchImpl?: typeof fetch;
  /** Inject a logger for tests. Defaults to console. */
  log?: MirrorLogger;
  /** Override the API base (tests point this at a mock server). */
  apiBase?: string;
  /** Called after any tick that inserts > 0 rows. See the field doc. */
  onInsert?: () => void;
  /** Pages per tick cap. Test-only injection seam — no env var. */
  maxPagesPerTick?: number;
}

/**
 * Polls Cursor's admin API for team usage events and writes them as
 * source="cursor" rows. Same start/stop/tick lifecycle as BinaryMirror.
 * Dedup: deterministic messageId hash dropped by the UNIQUE events_dedup
 * index. Progress: a watermark persisted in server_meta that advances only
 * on a complete walk (Cursor's `startDate` is inclusive, hence the +1).
 */
export class CursorMirror {
  private readonly store: Store;
  private readonly token: string;
  private readonly userMap: EmailUserMap;
  private readonly intervalMs: number;
  private readonly initialDelayMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly log: MirrorLogger;
  private readonly apiBase: string;
  private readonly maxPagesPerTick: number;

  /**
   * Called after any tick that inserts > 0 rows. Public-mutable: buildApp
   * CHAINS stats-cache invalidation onto this hook, never replaces it.
   */
  onInsert: (() => void) | null = null;

  private timer: ReturnType<typeof setInterval> | null = null;
  private initialTimer: ReturnType<typeof setTimeout> | null = null;
  /** Guard against overlapping ticks (initial backfill is long). */
  private inflight = false;
  /** The in-flight tick's promise, awaited by stop() before teardown. */
  private inflightPromise: Promise<{
    inserted: number;
    duplicates: number;
    fetched: number;
  }> | null = null;
  /**
   * Watermark: newest event covered by a COMPLETE walk. Restored from
   * server_meta on first tick — Cursor pages are newest-first, so anything
   * else could skip the tail of a truncated backfill forever.
   */
  private maxSeenTimestamp = 0;
  private watermarkLoaded = false;
  /** Next page to request — continuation state across truncated ticks
   *  within one process lifetime (deliberately not persisted). */
  private resumePage = 1;
  /** Max timestamp fetched so far during a multi-tick walk; folded into
   *  the watermark only when the walk completes. */
  private pendingMaxTs = 0;

  constructor(opts: CursorMirrorOpts) {
    this.store = opts.store;
    this.token = opts.token;
    this.userMap = opts.userMap;
    this.intervalMs = (opts.intervalSec ?? DEFAULT_INTERVAL_SEC) * 1000;
    this.initialDelayMs =
      opts.initialDelayMs !== undefined ? opts.initialDelayMs : INITIAL_FETCH_DELAY_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.log = opts.log ?? consoleLogger;
    this.apiBase = opts.apiBase ?? CURSOR_API_BASE;
    this.maxPagesPerTick = opts.maxPagesPerTick ?? MAX_PAGES_PER_TICK;
    this.onInsert = opts.onInsert ?? null;
  }

  async start(): Promise<void> {
    if (this.timer || this.initialTimer) return;
    this.initialTimer = setTimeout(() => {
      this.initialTimer = null;
      void this.tick();
      this.timer = setInterval(() => {
        void this.tick();
      }, this.intervalMs);
      this.timer.unref?.();
    }, this.initialDelayMs);
    this.initialTimer.unref?.();
  }

  /**
   * Clears the timers AND awaits any in-flight tick: a tick can be
   * mid-insertMany when SIGTERM lands, and closing the store under it
   * would throw on a closed DB.
   */
  async stop(): Promise<void> {
    if (this.initialTimer) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.inflightPromise) await this.inflightPromise;
  }

  /** Run one polling cycle. NEVER rejects — errors are logged and the
   *  next tick retries. */
  tick(): Promise<{ inserted: number; duplicates: number; fetched: number }> {
    if (this.inflight) {
      this.log.warn("tick_skipped_inflight");
      return Promise.resolve({ inserted: 0, duplicates: 0, fetched: 0 });
    }
    this.inflight = true;
    const p = this.runTick();
    this.inflightPromise = p;
    return p;
  }

  private async runTick(): Promise<{
    inserted: number;
    duplicates: number;
    fetched: number;
  }> {
    try {
      if (!this.watermarkLoaded) {
        this.maxSeenTimestamp = this.loadWatermark();
        this.watermarkLoaded = true;
      }

      // startDate filters server-side to events strictly newer than the
      // last complete walk; sinceMs=0 walks the full history.
      const sinceMs = this.maxSeenTimestamp > 0 ? this.maxSeenTimestamp + 1 : 0;
      const events: TokenEvent[] = [];
      let totalFetched = 0;
      let complete = false;
      const firstPage = this.resumePage;
      let lastPage = firstPage - 1;

      // No early break on stale timestamps: events_dedup makes re-insertion
      // harmless and we don't rely on within-page ordering. maxPagesPerTick
      // is the hard cap that respects Cursor's rate limit.
      for (let page = firstPage; page < firstPage + this.maxPagesPerTick; page++) {
        const resp = await this.fetchPage(sinceMs, page);
        if (!resp) break; // fetch error → truncated; resume here next tick
        lastPage = page;
        const usage = resp.usageEvents ?? [];
        totalFetched += usage.length;
        for (const ev of usage) {
          const tsMs = Number(ev.timestamp);
          if (!Number.isFinite(tsMs) || tsMs <= 0) continue;
          if (tsMs > this.pendingMaxTs) this.pendingMaxTs = tsMs;
          const mapped = this.toTokenEvent(ev, tsMs);
          if (mapped) events.push(mapped);
        }
        if (!resp.pagination?.hasNextPage) {
          complete = true;
          break;
        }
      }

      // Insert oldest-first so a fresh backfill fills the dashboard in
      // chronological order.
      events.sort((a, b) => a.timestamp - b.timestamp);

      let result = { inserted: 0, duplicates: 0 };
      if (events.length > 0) {
        result = this.store.insertMany(events);
        this.log.info("tick_done", {
          fetched: totalFetched,
          inserted: result.inserted,
          duplicates: result.duplicates,
          maxTs: Math.max(this.maxSeenTimestamp, this.pendingMaxTs),
        });
        if (result.inserted > 0) {
          try {
            this.onInsert?.();
          } catch {
            // invalidation hooks must never fail a tick
          }
        }
      }

      // Watermark advances only on a complete walk — pages are newest-first,
      // so advancing after a truncated tick would skip the older tail.
      if (complete) {
        if (this.pendingMaxTs > this.maxSeenTimestamp) {
          this.maxSeenTimestamp = this.pendingMaxTs;
        }
        this.store.setMeta(WATERMARK_META_KEY, String(this.maxSeenTimestamp));
        this.pendingMaxTs = 0;
        this.resumePage = 1;
      } else {
        this.resumePage = lastPage + 1;
        this.log.warn("tick_truncated", {
          pages: lastPage - firstPage + 1,
          resumePage: this.resumePage,
          watermark: this.maxSeenTimestamp,
        });
      }
      return { ...result, fetched: totalFetched };
    } catch (err) {
      this.log.error("tick_failed", {
        err: String((err as Error)?.message ?? err),
      });
      return { inserted: 0, duplicates: 0, fetched: 0 };
    } finally {
      this.inflight = false;
      this.inflightPromise = null;
    }
  }

  /** Forget all progress (in-memory + persisted): the next tick re-walks
   *  the full history. Called by /admin/clear full/all — dedup makes the
   *  re-import harmless. */
  resetWatermark(): void {
    this.maxSeenTimestamp = 0;
    this.pendingMaxTs = 0;
    this.resumePage = 1;
    this.watermarkLoaded = true;
    this.store.deleteMeta(WATERMARK_META_KEY);
  }

  /**
   * Seed maxSeenTimestamp from server_meta ONLY — a MAX(timestamp) fallback
   * after a truncated tick + restart would skip older history forever.
   * Missing key → full re-walk; every row dedups, so it self-heals.
   */
  private loadWatermark(): number {
    const v = Number(this.store.getMeta(WATERMARK_META_KEY) ?? 0);
    return Number.isFinite(v) && v > 0 ? v : 0;
  }

  private async fetchPage(sinceMs: number, page: number): Promise<CursorEventsResponse | null> {
    const url = `${this.apiBase}/teams/filtered-usage-events`;
    const body: Record<string, unknown> = { page, pageSize: PAGE_SIZE };
    if (sinceMs > 0) body.startDate = sinceMs;
    const auth = Buffer.from(`${this.token}:`).toString("base64");
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Basic ${auth}`,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      this.log.warn("fetch_network_error", {
        page,
        err: String((err as Error)?.message ?? err),
      });
      return null;
    }
    if (!res.ok) {
      this.log.warn("fetch_http_error", { page, status: res.status });
      return null;
    }
    try {
      return (await res.json()) as CursorEventsResponse;
    } catch (err) {
      this.log.warn("fetch_parse_error", {
        page,
        err: String((err as Error)?.message ?? err),
      });
      return null;
    }
  }

  /**
   * Map a Cursor event onto TokenEvent. Returns null for unmapped emails
   * and for non-token-based events (dropped rather than zeroed in).
   */
  private toTokenEvent(ev: CursorUsageEvent, tsMs: number): TokenEvent | null {
    // Cursor occasionally omits userEmail; guard before .toLowerCase() so
    // one malformed event can't abort the whole tick.
    const email = ev.userEmail;
    if (typeof email !== "string" || email.length === 0) return null;
    const user = this.userMap[email.toLowerCase()];
    if (!user) return null;
    const tu = ev.tokenUsage;
    if (!tu) return null;

    // Deterministic messageId → re-fetched events dedupe via events_dedup.
    // Token counts included so same-ms same-model events don't collide.
    const messageId = cursorMessageId({
      timestamp: tsMs,
      model: ev.model,
      inputTokens: tu.inputTokens,
      outputTokens: tu.outputTokens,
      cacheWriteTokens: tu.cacheWriteTokens,
      cacheReadTokens: tu.cacheReadTokens,
    });

    const costUsdMicros = centsToMicros(tu.totalCents ?? 0);

    return {
      user,
      source: "cursor",
      // Cursor has no session concept; synthesize one per (user, UTC day).
      sessionId: cursorSessionId(user, tsMs),
      messageId,
      requestId: null,
      timestamp: tsMs,
      model: ev.model,
      messageType: "assistant",
      inputTokens: tu.inputTokens | 0,
      outputTokens: tu.outputTokens | 0,
      cacheCreationTokens: tu.cacheWriteTokens | 0,
      cacheReadTokens: tu.cacheReadTokens | 0,
      reasoningTokens: null,
      costUsdMicros,
    };
  }
}
