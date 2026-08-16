// Anonymous dashboard traffic counting — "how much is this thing actually
// looked at", and nothing more.
//
// EXPLICITLY NOT ANALYTICS-AS-USUAL. There is no cookie (not even an
// anonymous UUID), no visitor id, no session, no IP column, no stored
// user-agent. A row is `{ts, path}`; two loads by the same person are
// indistinguishable from two loads by two people, and that is the intended
// resolution. The user-agent header IS read — once, in memory, purely to
// decide bot-vs-human — and then dropped on the floor.
//
// Buffered, never inline. bun:sqlite is synchronous and shares the event
// loop: an INSERT inside the document-load handler puts an fsync in front
// of every other in-flight request (a slow query here once made a
// concurrent /health take 11.66s). So loads accumulate in an array and one
// interval flushes them in a single transaction. Losing the tail of the
// buffer to a `kill -9` is fine — these are page views, not money.

import type { PageViewRow, Store } from "./db.ts";

/** Flush cadence. Long enough that a burst costs one transaction, short
 *  enough that the admin read is never meaningfully behind (and it flushes
 *  before reading anyway). */
export const PAGE_VIEW_FLUSH_MS = 60_000;

/** Buffer ceiling. At ~40 loads/day a 60s window holds single digits; four
 *  figures means something pathological (a flood, or a wedged timer), and
 *  dropping counts is strictly better than growing an unbounded array in a
 *  server whose real job is the leaderboard. */
export const PAGE_VIEW_BUFFER_MAX = 5_000;

/** Floor between dropped-load warnings from `record()`. A full buffer means
 *  every subsequent load is discarded, so the log line must not become the
 *  flood. */
export const PAGE_VIEW_DROP_WARN_MS = 60_000;

/**
 * Non-human clients we do NOT count. ~5% of real traffic is link unfurls and
 * scanners (Slackbot, WhatsApp, Palo Alto's Cortex Xpanse, python-requests,
 * Claude-User); counting those as views would inflate the only number this
 * table exists to report. Matched case-insensitively as substrings, which is
 * deliberately blunt: a mislabelled bot costs one uncounted view, while the
 * alternative (an allow-list of browsers) silently drops real people.
 */
const BOT_UA_MARKERS = [
  "bot", // Slackbot, Googlebot, Twitterbot, bingbot, …
  "crawl",
  "spider",
  "slurp",
  "preview",
  "unfurl",
  "whatsapp", // WhatsApp/x.y.z — link preview fetcher
  "facebookexternalhit",
  "embedly",
  "fetch",
  "monitor",
  "scanner",
  "expanse", // Palo Alto Cortex Xpanse
  "python-requests",
  "curl/",
  "wget",
  "httpie",
  "okhttp",
  "go-http-client",
  "java/",
  "headless",
  "phantomjs",
  "claude-user", // agentic fetchers, incl. our own
  "gptbot",
  "chatgpt-user",
  "perplexity",
];

/**
 * Is this user-agent a bot/unfurl/scanner rather than a person's browser?
 * A missing or empty UA counts as a bot: every real browser sends one, so
 * an absent header means a script (or something deliberately hiding), and
 * we would rather under-count than report scripts as readers.
 */
export function isBotUserAgent(ua: string | null | undefined): boolean {
  const s = (ua ?? "").trim().toLowerCase();
  if (s.length === 0) return true;
  return BOT_UA_MARKERS.some((m) => s.includes(m));
}

export interface PageViewRecorderOptions {
  /** Only `recordPageViews` is used — the narrow type keeps tests honest. */
  store: Pick<Store, "recordPageViews">;
  /** Flush cadence in ms. Defaults to PAGE_VIEW_FLUSH_MS. */
  flushIntervalMs?: number;
  /** Injectable clock (tests pin timestamps to a known day). */
  now?: () => number;
}

/**
 * In-memory buffer of anonymous page views plus the interval that drains it.
 * `record` is the only thing on the request path and it is a push onto an
 * array — no SQLite, no allocation beyond the row, no way to throw into the
 * response.
 */
export class PageViewRecorder {
  private readonly store: Pick<Store, "recordPageViews">;
  private readonly flushIntervalMs: number;
  private readonly now: () => number;
  private buffer: PageViewRow[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Loads dropped at the buffer ceiling since the last time we said so. */
  private dropped = 0;
  /** When the last drop warning went out (null = never). The warning is emitted
   *  from `record()`, NOT only from `flush()`, because the scenario that
   *  fills the buffer is the one where flush may never run again: this repo
   *  has a documented Bun-timer wedge class (docs/resilience.md — the v0.6.0
   *  watchdog exists because of it), and a wedged interval means a full
   *  buffer, silently discarded loads, and counts that simply stop. A
   *  warning that only fires on the next flush would never fire at all. */
  private lastDropWarnAt: number | null = null;

  constructor(opts: PageViewRecorderOptions) {
    this.store = opts.store;
    this.flushIntervalMs = opts.flushIntervalMs ?? PAGE_VIEW_FLUSH_MS;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Buffer one human document load. `path` must be a PATHNAME — never the
   * full URL: the dashboard's one-shot `?token=` auth rides in the query
   * string, and this table is not where a dashboard token is going to end
   * up in plaintext.
   */
  record(path: string): void {
    if (this.buffer.length >= PAGE_VIEW_BUFFER_MAX) {
      this.dropped += 1;
      this.warnDropped();
      return;
    }
    this.buffer.push({ ts: this.now(), path });
  }

  /** Say so when loads are being discarded — at most once a minute, and from
   *  whichever of record()/flush() gets there first. */
  private warnDropped(): void {
    if (this.dropped === 0) return;
    const at = this.now();
    if (this.lastDropWarnAt !== null && at - this.lastDropWarnAt < PAGE_VIEW_DROP_WARN_MS) return;
    this.lastDropWarnAt = at;
    const n = this.dropped;
    this.dropped = 0;
    console.warn(
      `[tokenleader] page views: dropped ${n} load(s) at the ${PAGE_VIEW_BUFFER_MAX}-row buffer cap — the flush interval may be wedged`,
    );
  }

  /** Start the flush interval. Unref'd — a pending page-view flush must
   *  never be the reason a process refuses to exit. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.flush(), this.flushIntervalMs);
    if (typeof this.timer === "object" && this.timer && "unref" in this.timer) {
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  /**
   * Write everything buffered. Swallows write errors on purpose: a failed
   * page-view flush must not take down the interval or a shutdown path, and
   * the batch is dropped rather than retried forever (a retry loop against a
   * broken DB just grows the buffer). Returns the rows written.
   */
  flush(): number {
    this.warnDropped();
    if (this.buffer.length === 0) return 0;
    // Swap first: a throw below must not re-queue rows we already gave up on.
    const batch = this.buffer;
    this.buffer = [];
    try {
      return this.store.recordPageViews(batch);
    } catch (err) {
      console.warn(
        `[tokenleader] page view flush failed: ${String((err as Error)?.message ?? err)}`,
      );
      return 0;
    }
  }

  /** Stop the interval and flush what's left (graceful shutdown). */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.flush();
  }

  /** Buffered-but-unwritten count. Tests and nothing else. */
  pending(): number {
    return this.buffer.length;
  }
}
