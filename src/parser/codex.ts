import { basename } from "node:path";
import type { TokenEvent } from "../types.ts";
import { readNewlineLines } from "./read-slice.ts";

/**
 * Cumulative running totals for one Codex session, kept across reads so we
 * can compute deltas correctly when a file is parsed in multiple passes.
 */
export interface SessionTotals {
  sessionId: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
}

// Back-compat alias for the daemon's existing import.
export type CodexSessionTotals = SessionTotals;

export interface ParseCodexOptions {
  path: string;
  byteOffset: number;
  user: string;
  prevSessionTotals?: SessionTotals;
}

export interface ParseCodexResult {
  events: TokenEvent[];
  newOffset: number;
  sessionTotals: SessionTotals;
  /** Count of records dropped because they exceeded the read window (data
   *  loss — surfaced so the daemon can warn). Absent/0 in the common case. */
  oversizeSkipped?: number;
}

interface CodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

interface CodexLine {
  timestamp?: string;
  type?: string;
  payload?: {
    type?: string;
    model?: string;
    role?: string;
    info?: {
      model?: string;
      model_name?: string;
      metadata?: { model?: string };
      last_token_usage?: CodexUsage;
      total_token_usage?: CodexUsage;
    } | null;
    output?: { model?: string };
    metadata?: { model?: string };
  };
}

const LEGACY_FALLBACK_MODEL = "gpt-5";

function isString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}
function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function extractModel(line: CodexLine): string | null {
  const p = line.payload;
  if (!p) return null;
  // event_msg/token_count: info may carry model in newer formats
  const info = p.info;
  if (info) {
    if (isString(info.model)) return info.model;
    if (isString(info.model_name)) return info.model_name;
    if (info.metadata && isString(info.metadata.model)) return info.metadata.model;
  }
  // turn_context: payload.model — this is the canonical place in the
  // local 0.124+ format. ccusage's data-loader does the same fallback.
  if (isString(p.model)) return p.model;
  if (p.output && isString(p.output.model)) return p.output.model;
  if (p.metadata && isString(p.metadata.model)) return p.metadata.model;
  return null;
}

function pickUsage(info: NonNullable<CodexLine["payload"]>["info"]): CodexUsage | null {
  if (!info) return null;
  if (info.last_token_usage) return info.last_token_usage;
  if (info.total_token_usage) return info.total_token_usage;
  return null;
}

function readNum(...vals: Array<number | undefined>): number {
  for (const v of vals) if (isNum(v)) return v;
  return 0;
}

/**
 * messageId synthesis:
 *   `${sessionId}:${timestampIso}:${ix}`
 *
 * Codex doesn't ship message IDs, so we need a stable key that's also
 * unique across re-reads of the same file. The event timestamp is high
 * resolution (millisecond ISO), and `ix` disambiguates events that share
 * the exact same timestamp inside this read. Combined with the sessionId
 * (filename), the key is globally unique enough for the daemon to dedup,
 * and it's identical across reads because the timestamp is in the line.
 */
function buildMessageId(sessionId: string, timestamp: string, ixForTimestamp: number): string {
  return `${sessionId}:${timestamp}:${ixForTimestamp}`;
}

export async function parseCodexFile(opts: ParseCodexOptions): Promise<ParseCodexResult> {
  const { path, byteOffset, user, prevSessionTotals } = opts;

  const sessionId = basename(path, ".jsonl");
  const totals: SessionTotals =
    prevSessionTotals && prevSessionTotals.sessionId === sessionId
      ? { ...prevSessionTotals }
      : { sessionId, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 };

  const file = Bun.file(path);
  const totalSize = file.size;
  if (byteOffset >= totalSize) {
    return { events: [], newOffset: totalSize, sessionTotals: totals };
  }

  const events: TokenEvent[] = [];
  // Advance only past fully-terminated lines; a partial trailing line keeps
  // the offset put so the next read re-consumes it once it's complete.
  let newOffset = byteOffset;

  let currentModel: string | null = null;
  // Track how many events share an identical timestamp so messageIds stay unique.
  let lastTs = "";
  let ixForTs = 0;
  let oversizeSkipped = 0;

  // Read line-by-line in capped windows so an oversized file never lands as
  // one string and we never build a giant per-chunk line array.
  for await (const part of readNewlineLines(file, byteOffset)) {
    newOffset = part.newOffset;
    if (part.kind === "oversize") {
      oversizeSkipped++;
      continue;
    }
    if (part.kind !== "line") continue;
    const line = part.text;

    let raw: CodexLine;
    try {
      raw = JSON.parse(line) as CodexLine;
    } catch {
      continue;
    }

    // Track most-recent model from turn_context lines.
    if (raw.type === "turn_context") {
      const m = extractModel(raw);
      if (m) currentModel = m;
      continue;
    }

    // Codex logs user prompts as `response_item` lines with role="user".
    // Emit a zero-token user event per occurrence so the server can compute
    // user-vs-assistant message counts. The messageId is synthesized the
    // same way as token-count events but tagged with `:user:` so it can
    // never collide with an assistant-event id at the same timestamp.
    if (raw.type === "response_item" && raw.payload?.role === "user") {
      const tsStr = isString(raw.timestamp) ? raw.timestamp : new Date().toISOString();
      const tsMs = Date.parse(tsStr);
      const timestamp = Number.isFinite(tsMs) ? tsMs : Date.now();
      if (tsStr === lastTs) ixForTs += 1;
      else {
        lastTs = tsStr;
        ixForTs = 0;
      }
      events.push({
        user,
        source: "codex",
        sessionId,
        messageId: `${sessionId}:${tsStr}:user:${ixForTs}`,
        requestId: null,
        timestamp,
        model: currentModel ?? LEGACY_FALLBACK_MODEL,
        messageType: "user",
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        reasoningTokens: null,
      });
      continue;
    }

    if (raw.type !== "event_msg") continue;
    const payload = raw.payload;
    if (!payload || payload.type !== "token_count") continue;
    const info = payload.info;
    if (!info) continue;

    const usage = pickUsage(info);
    if (!usage) continue;

    const cumInput = readNum(usage.input_tokens);
    const cumOutput = readNum(usage.output_tokens);
    const cumCached = readNum(usage.cached_input_tokens, usage.cache_read_input_tokens);
    const cumReasoning = readNum(usage.reasoning_output_tokens);

    let dInput = cumInput - totals.inputTokens;
    let dOutput = cumOutput - totals.outputTokens;
    let dCached = cumCached - totals.cachedInputTokens;
    let dReasoning = cumReasoning - totals.reasoningTokens;

    // Reset detection: if any cumulative bucket regressed, treat current
    // numbers as a fresh baseline (new sub-session, log rotation, etc.).
    if (dInput < 0 || dOutput < 0 || dCached < 0 || dReasoning < 0) {
      dInput = cumInput;
      dOutput = cumOutput;
      dCached = cumCached;
      dReasoning = cumReasoning;
    }

    totals.inputTokens = cumInput;
    totals.outputTokens = cumOutput;
    totals.cachedInputTokens = cumCached;
    totals.reasoningTokens = cumReasoning;

    if (dInput === 0 && dOutput === 0 && dCached === 0 && dReasoning === 0) continue;

    const tsStr = isString(raw.timestamp) ? raw.timestamp : new Date().toISOString();
    const tsMs = Date.parse(tsStr);
    const timestamp = Number.isFinite(tsMs) ? tsMs : Date.now();

    if (tsStr === lastTs) ixForTs += 1;
    else {
      lastTs = tsStr;
      ixForTs = 0;
    }

    const eventModel = extractModel(raw);
    if (eventModel) currentModel = eventModel;
    const model = currentModel ?? LEGACY_FALLBACK_MODEL;

    // Codex reports `input_tokens` INCLUSIVE of `cached_input_tokens`.
    // Normalize at the parse boundary so downstream cost math stays uniform:
    //   inputTokens     := non-cached portion (paid at full input rate)
    //   cacheReadTokens := cached portion     (paid at cache-read rate)
    // Clamp cached at input to defend against out-of-order delta noise.
    const cappedCached = Math.min(dCached, dInput);
    const nonCachedInput = Math.max(0, dInput - cappedCached);

    events.push({
      user,
      source: "codex",
      sessionId,
      messageId: buildMessageId(sessionId, tsStr, ixForTs),
      requestId: null,
      timestamp,
      model,
      messageType: "assistant",
      inputTokens: nonCachedInput,
      outputTokens: dOutput,
      cacheCreationTokens: 0,
      cacheReadTokens: cappedCached,
      reasoningTokens: dReasoning,
    });
  }

  return { events, newOffset, sessionTotals: totals, oversizeSkipped };
}
