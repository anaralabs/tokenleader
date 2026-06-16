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
