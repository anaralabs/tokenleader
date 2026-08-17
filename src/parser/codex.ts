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
  /** Model in effect at the end of the PREVIOUS read of this same file.
   *  `turn_context` appears once per turn, not once per token_count line, so
   *  an incremental read that starts mid-turn sees usage with no model in
   *  its window. Without this the model resolved to LEGACY_FALLBACK_MODEL
   *  and the turn was billed to a model nobody ran — the dominant source of
   *  mislabelled Codex volume. Persisted across ticks in FileState.lastModel
   *  exactly like lastSessionTotals. */
  prevModel?: string;
}

export interface ParseCodexResult {
  events: TokenEvent[];
  newOffset: number;
  sessionTotals: SessionTotals;
  /** Model in effect at the end of this read, to carry into the next one.
   *  Undefined only when no turn_context has EVER been seen for this file
   *  (pre-2025-11 rollouts predate the field entirely — those genuinely
   *  have no recoverable model and keep the fallback). */
  lastModel?: string;
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
    /** session_meta only: this rollout was seeded with a verbatim copy of
     *  that thread's history (subagent spawn / fork / resume --fork). */
    forked_from_id?: string;
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

/**
 * Fork-seed suppression. When Codex spawns a subagent or forks/resumes a
 * thread (CLI ≥0.32; subagent spawns ≥0.107), the child rollout is seeded
 * with a verbatim COPY of the parent's history — including every token_count
 * line — re-stamped with spawn-time timestamps. Counting those re-bills the
 * parent's entire ledger once per fork (measured: 86% of stored gpt-5.6
 * volume fleet-wide was such copies).
 *
 * There is no per-line replay marker upstream. The reliable structural
 * signals (confirmed against openai/codex source) are: the child's
 * session_meta carries `forked_from_id`, and the seed is written in one
 * synchronous burst at file birth — consecutive lines milliseconds apart —
 * while the child's first REAL event trails by at least a model round-trip.
 * So: in a file whose session_meta has forked_from_id, suppress emission
 * until a line's timestamp jumps more than SEED_GAP_MS past the previous
 * line's. Totals bookkeeping still runs during the seed (the child's
 * cumulative ledger continues from the parent's).
 *
 * Seed handling is only needed when parsing from byte 0: the seed is flushed
 * at file creation, so the first read of a new file always contains it whole.
 */
const SEED_GAP_MS = 1500;

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

function usageNums(u: CodexUsage) {
  return {
    input: readNum(u.input_tokens),
    output: readNum(u.output_tokens),
    cached: readNum(u.cached_input_tokens, u.cache_read_input_tokens),
    reasoning: readNum(u.reasoning_output_tokens),
  };
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
  const { path, byteOffset, user, prevSessionTotals, prevModel } = opts;

  const sessionId = basename(path, ".jsonl");
  const totals: SessionTotals =
    prevSessionTotals && prevSessionTotals.sessionId === sessionId
      ? { ...prevSessionTotals }
      : { sessionId, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 };

  const file = Bun.file(path);
  const totalSize = file.size;
  if (byteOffset >= totalSize) {
    // Nothing new to read — echo the model back so a no-op tick doesn't
    // drop it and re-blind the next real read.
    return {
      events: [],
      newOffset: totalSize,
      sessionTotals: totals,
      ...(prevModel !== undefined ? { lastModel: prevModel } : {}),
    };
  }

  const events: TokenEvent[] = [];
  // Advance only past fully-terminated lines; a partial trailing line keeps
  // the offset put so the next read re-consumes it once it's complete.
  let newOffset = byteOffset;

  // Seeded from the previous read so a window that opens mid-turn (no
  // turn_context inside it) still knows what is running. Only a byte-0 read
  // starts blind, and a byte-0 read sees the file's own first turn_context.
  let currentModel: string | null = byteOffset > 0 ? (prevModel ?? null) : null;
  // Track how many events share an identical timestamp so messageIds stay unique.
  let lastTs = "";
  let ixForTs = 0;
  let oversizeSkipped = 0;
  // Fork-seed suppression (see SEED_GAP_MS doc). Armed by a session_meta
  // carrying forked_from_id; disarmed by the first inter-line timestamp gap.
  let seedActive = false;
  let prevLineTsMs: number | null = null;

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

    // Seed-burst tracking: a real event after the seed arrives at least a
    // model round-trip later; seed lines are written milliseconds apart.
    const lineTsMs = isString(raw.timestamp) ? Date.parse(raw.timestamp) : NaN;
    if (
      seedActive &&
      prevLineTsMs !== null &&
      Number.isFinite(lineTsMs) &&
      lineTsMs - prevLineTsMs > SEED_GAP_MS
    ) {
      seedActive = false;
    }
    if (Number.isFinite(lineTsMs)) prevLineTsMs = lineTsMs;

    if (byteOffset === 0 && raw.type === "session_meta" && isString(raw.payload?.forked_from_id)) {
      seedActive = true;
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
      if (seedActive) continue; // copied prompt from the parent's history
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

    const last = info.last_token_usage;
    const cumTotal = info.total_token_usage ? usageNums(info.total_token_usage) : null;
    if (!last && !cumTotal) continue;

    // `last_token_usage` is the PER-TURN usage — exactly what this event
    // should emit, no delta bookkeeping needed. `total_token_usage` is the
    // session-cumulative counterpart (verified against real rollouts: each
    // total delta equals that event's last). Treating `last` as cumulative
    // swallowed ~half of all input/cache tokens, so it is used directly and
    // the delta path below only serves total-only formats.
    let dInput: number;
    let dOutput: number;
    let dCached: number;
    let dReasoning: number;
    if (last) {
      ({
        input: dInput,
        output: dOutput,
        cached: dCached,
        reasoning: dReasoning,
      } = usageNums(last));
    } else {
      dInput = cumTotal!.input - totals.inputTokens;
      dOutput = cumTotal!.output - totals.outputTokens;
      dCached = cumTotal!.cached - totals.cachedInputTokens;
      dReasoning = cumTotal!.reasoning - totals.reasoningTokens;

      // Reset detection: if any cumulative bucket regressed, treat current
      // numbers as a fresh baseline (new sub-session, log rotation, etc.).
      if (dInput < 0 || dOutput < 0 || dCached < 0 || dReasoning < 0) {
        dInput = cumTotal!.input;
        dOutput = cumTotal!.output;
        dCached = cumTotal!.cached;
        dReasoning = cumTotal!.reasoning;
      }
    }

    // Keep the cumulative bookkeeping coherent either way so a later
    // total-only event (or the next incremental read) deltas correctly.
    if (cumTotal) {
      totals.inputTokens = cumTotal.input;
      totals.outputTokens = cumTotal.output;
      totals.cachedInputTokens = cumTotal.cached;
      totals.reasoningTokens = cumTotal.reasoning;
    } else {
      totals.inputTokens += dInput;
      totals.outputTokens += dOutput;
      totals.cachedInputTokens += dCached;
      totals.reasoningTokens += dReasoning;
    }

    // Seeded copy of the parent's ledger: bookkeeping above stays (the
    // child's cumulative continues the parent's), but nothing is billed.
    if (seedActive) continue;

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

  return {
    events,
    newOffset,
    sessionTotals: totals,
    ...(currentModel !== null ? { lastModel: currentModel } : {}),
    oversizeSkipped,
  };
}
