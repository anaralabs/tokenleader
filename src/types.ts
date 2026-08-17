export type Source = "claude_code" | "claude_cowork" | "codex" | "cursor" | "cursor_local";

export type MessageType = "user" | "assistant";

export interface TokenEvent {
  user: string;
  source: Source;
  sessionId: string;
  messageId: string;
  requestId: string | null;
  timestamp: number;
  model: string;
  /**
   * User-message events carry zero in all token buckets (source logs only
   * attribute tokens to assistant turns). Older daemons omit this field;
   * it defaults to "assistant" so their payloads keep working.
   */
  messageType: MessageType;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number | null;
  /**
   * Pre-computed cost in USD micros (1 USD = 1_000_000), for sources that
   * ship per-event cost (Cursor's totalCents includes max-mode multipliers
   * PricingCache can't replicate). Null/omitted → priced via PricingCache,
   * the Claude Code + Codex path.
   */
  costUsdMicros?: number | null;
}

export interface IngestRequest {
  events: TokenEvent[];
}

export interface IngestResponse {
  inserted: number;
  duplicates: number;
  /** Rows the server skipped as invalid (per-row-tolerant ingest). */
  skipped?: number;
  /** Single-shot remote action for this daemon (zero-touch recovery). */
  directive?: DaemonDirective;
}

/**
 * A remote action delivered to exactly one daemon or watchdog via the
 * /checkin, /ingest, or /watchdog-checkin response. Executors run only verbs
 * on their own allowlist — unknown verbs are logged and dropped. Completion
 * is the executed-ack POST, not the handout: undelivered or un-acked
 * directives re-queue on TTL (docs/resilience.md).
 */
export interface DaemonDirective {
  id: number;
  verb: string;
}

/** Executed-ack POSTed back after a directive runs (or fails). */
export interface DirectiveAck {
  id: number;
  result: "ok" | "failed";
  detail?: string;
  executed_by: "daemon" | "watchdog";
}

/**
 * Optional JSON body on daemon /checkin POSTs (headers alone remain valid —
 * old daemons send none, old servers ignore it). Fields feed the fleet
 * classifier; exit_journal_tail explains deliberate restarts so recycling
 * and update swaps are never misread as crash loops.
 */
export interface CheckinBody {
  uptime_s: number;
  tick_seq: number;
  /** Configured tick cadence — the fleet classifier scales its staleness
   *  thresholds per device so slow-cadence daemons are never misread. */
  interval_s?: number;
  /** Monotonic count of daemon boots on this machine (crash-loop signal). */
  boot_count?: number;
  consec_failures: number;
  last_error: string | null;
  last_update_result: string | null;
  disk_free_mb: number | null;
  drift_ms: number;
  heartbeat_write_failures: number;
  exit_journal_tail: { ts: number; reason: string; code: number }[];
  watchdog_installed: boolean | null;
}

/** Body of the watchdog's ~200B curl checkin to /watchdog-checkin. */
export interface WatchdogCheckinBody {
  watchdog_version: string;
  daemon_pid_alive: boolean;
  /** Consecutive watchdog firings with an unchanged heartbeat (awake-time
   *  staleness in launchd-clock units; 8 ≈ 16 min awake). */
  heartbeat_age_runs: number;
  kills_recent: number;
  degraded: boolean;
  spool_pending: number;
  /** The watchdog's own counter file was unreadable this run. */
  state_corrupt?: boolean;
}

export interface FileState {
  path: string;
  mtimeMs: number;
  byteOffset: number;
  /** Lines fully parsed in a Cursor transcript JSONL (stable message ids). */
  transcriptLineIndex?: number;
  lastSessionTotals?: {
    sessionId: string;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    reasoningTokens: number;
  };
  /** Codex only: model in effect at the end of the last read of this file.
   *  `turn_context` is written once per turn, so an incremental read can
   *  open mid-turn and see token usage with no model line in its window;
   *  without carrying it forward the parser fell back to a placeholder and
   *  billed the turn to a model nobody ran. */
  lastModel?: string;
}

export interface CursorLocalState {
  dbPath: string;
  lastRowid: number;
}

export interface CursorCloudState {
  /** Wall-clock ms when cloud sync last completed successfully. */
  lastSyncAt: number;
  /** Highest event timestamp seen from the dashboard API. */
  lastEventTimestamp?: number;
  /** Set once an all-time `full` backfill walk has completed. */
  fullSyncDone?: boolean;
  /** 1-based page to resume from when a fetch stopped at the page cap. */
  resumePage?: number;
  /** startDate the pending `resumePage` belongs to (guards cross-window reuse). */
  resumeStartDate?: number;
}

export interface DaemonState {
  schemaVersion: 1;
  files: Record<string, FileState>;
  lastFlushAt: number;
  /** Read-only Cursor SQLite watermark (daemon-only bookkeeping). */
  cursorLocal?: CursorLocalState;
  /** Cursor dashboard cloud sync watermark (daemon-only bookkeeping). */
  cursorCloud?: CursorCloudState;
}
