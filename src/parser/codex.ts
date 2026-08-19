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
  /** Cumulative `cache_write_input_tokens`. Needed for the same reason as
   *  cachedInputTokens: on the total-only fallback path the per-event
   *  cache-write is a DELTA of this running sum, and without it the written
   *  portion silently lands in plain input (billed at the full input rate).
   *  Inert while the source reports the field as a literal 0, which every
   *  rollout seen so far does — this exists so it stays correct the day it
   *  isn't. Persisted in FileState, where a pre-v0.6.5 state file has no
   *  such key; tick.ts reads a missing value as 0. */
  cacheWriteInputTokens: number;
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
  /** Override for the byte-0 look-ahead cap (see LOOKAHEAD_MAX_BYTES).
   *  A test seam: it lets the give-up path (and the pre-fix fallback
   *  behaviour) be exercised without a 16 MiB fixture. Production never
   *  sets it. */
  lookAheadMaxBytes?: number;
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
  /** Replayed token_count records skipped — the same request logged twice
   *  with an unmoved cumulative total. NOT data loss: billing them is the
   *  bug. Surfaced so a noisy CLI version is visible rather than silent. */
  replayedSkipped?: number;
}

interface CodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_write_input_tokens?: number;
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

/**
 * Byte-0 model look-ahead.
 *
 * v0.6.4 carried the model across INCREMENTAL reads (see prevModel), but a
 * byte-0 read deliberately starts blind: the file's own first `turn_context`
 * is the truth for a brand-new file, and trusting a stale carried model there
 * would mislabel a session that legitimately switched models.
 *
 * Some rollouts, though, write lines that need a model BEFORE their first
 * turn_context, so those events had nothing to resolve and fell back to
 * LEGACY_FALLBACK_MODEL — labelled with a model nobody ran, the same class of
 * bug v0.6.4 fixed. The answer is sitting further down the same file, so on a
 * byte-0 read we peek forward for its FIRST turn_context and seed from that.
 *
 * Measured over 1,149 real local rollouts:
 *  - 15 files carry token_count lines (10,176 of them) ahead of their first
 *    turn_context. On THIS machine all 15 are fork-seeded subagent rollouts,
 *    so those lines are the parent's copied ledger and are already dropped by
 *    fork-seed suppression — they were never billed, and the peek does not
 *    resurrect them. Elsewhere the same shape is real usage, and it is that
 *    case the peek is here for.
 *  - 1,118 user-prompt rows across 1,085 of the 1,149 files were labelled
 *    with the fallback and are now labelled correctly: Codex logs the prompt
 *    (`response_item` role=user) BEFORE it opens the turn, so a brand-new
 *    file's first prompt always preceded its first turn_context. Zero-token
 *    rows, so this moves message counts, not dollars.
 *  - No event ever changed from one real model to another, and no event's
 *    id, offset or ledger moved — codex.test.ts re-asserts that invariant
 *    against real local rollouts on every run.
 *
 * The peek is a separate cursor over the same file: it emits nothing,
 * advances no byte offset, and touches neither the fork-seed state machine
 * nor the totals ledger. It runs lazily — only when a billable line actually
 * needs a model we don't have — so the overwhelming majority of rollouts
 * (turn_context first) never pay for it, and it runs at most once per parse.
 *
 * It is also forward-only: it changes the `model` column and nothing else,
 * and messageId is byte-identical before and after. Re-reading an already
 * posted rollout therefore hits the server's dedup and the stored row keeps
 * its old label — history is not repaired, only new/first reads are correct.
 */
const LOOKAHEAD_MAX_BYTES = 32 * 1024 * 1024;

/**
 * Window the peek reads in. A turn_context line is a few hundred bytes, so a
 * record bigger than this window can never be one — the reader reports it as
 * oversize and skips it, which is exactly right here. The main parse pass is
 * unaffected: it reads the same file with the full MAX_READ_BYTES window.
 */
const LOOKAHEAD_WINDOW_BYTES = 1024 * 1024;

/**
 * Scan from byte 0 for the model on the file's first `turn_context`, giving up
 * after LOOKAHEAD_MAX_BYTES. Returns null when there is none within the cap —
 * including rollouts that predate the field entirely (pre-2025-11), which
 * genuinely have no recoverable model and must keep the fallback. Guessing one
 * for them would be fabrication.
 *
 * The cap is enforced by slicing the file, not by checking offsets as they go
 * by: a single record longer than LOOKAHEAD_WINDOW_BYTES is skipped a window
 * at a time and yields nothing while it is being skipped, so an after-the-fact
 * offset check cannot fire until that record ends. Handing the reader a
 * `file.slice(0, cap)` makes it physically unable to read past the cap; the
 * `newOffset` check below is belt-and-braces.
 *
 * Deepest first `turn_context` across 1,149 real local rollouts is 11,741,324
 * bytes in (rollout-2026-08-13T12-29-33-019ffa74…), so 32 MiB is ~2.9x
 * headroom while staying under the reader's own 64 MiB record ceiling. The 30
 * local rollouts with no turn_context at all are ≤1.04 MB each, so the give-up
 * path costs a short read, not a capped one. Past the cap the parse keeps the
 * fallback for the pre-turn_context prefix, exactly as it did before this
 * change — the cap trades a rarer recovery for a bounded read.
 */
async function lookAheadFirstTurnModel(
  file: ReturnType<typeof Bun.file>,
  maxBytes: number = LOOKAHEAD_MAX_BYTES,
): Promise<string | null> {
  // Clamp to the real size: a slice longer than the file reports the *slice*
  // length as its size, which would send the reader chasing empty windows past
  // EOF.
  const head = file.slice(0, Math.min(maxBytes, file.size));
  for await (const part of readNewlineLines(head, 0, LOOKAHEAD_WINDOW_BYTES)) {
    if (part.newOffset > maxBytes) return null;
    if (part.kind !== "line") continue;
    // Cheap prefilter: JSON.parse on every line of a multi-MB head is the
    // expensive part of this scan, and only a turn_context can answer the
    // question. A false positive (some other line quoting the string) is
    // rejected by the type check below.
    if (!part.text.includes('"turn_context"')) continue;
    let raw: CodexLine;
    try {
      raw = JSON.parse(part.text) as CodexLine;
    } catch {
      continue;
    }
    if (raw.type !== "turn_context") continue;
    // Stop at the FIRST turn_context whether or not it names a model: it is
    // the nearest turn to the events we're labelling, and a later turn may
    // have switched models. No model there means we don't know.
    return extractModel(raw);
  }
  return null;
}

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
    cacheWrite: readNum(u.cache_write_input_tokens),
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
  const { path, byteOffset, user, prevSessionTotals, prevModel, lookAheadMaxBytes } = opts;

  const sessionId = basename(path, ".jsonl");
  const totals: SessionTotals =
    prevSessionTotals && prevSessionTotals.sessionId === sessionId
      ? // A state file written before v0.6.5 has no cache-write key; a
        // missing cumulative is 0, never undefined (which would poison every
        // delta downstream with NaN). Measuring the first post-upgrade delta
        // from 0 rather than adopting the first observed cumulative is the
        // deliberate choice: the clamps below bound the error to one event's
        // input, and carrying an "unknown yet" sentinel through a persisted
        // state file is a worse trade for a field that is 0 in every rollout
        // seen to date.
        {
          ...prevSessionTotals,
          cacheWriteInputTokens: prevSessionTotals.cacheWriteInputTokens ?? 0,
        }
      : {
          sessionId,
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          reasoningTokens: 0,
        };

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
  // Byte-0 look-ahead (see LOOKAHEAD_MAX_BYTES): resolved lazily and at most
  // once, only when a billable line needs a model this read hasn't seen yet.
  // An incremental read never peeks — it has prevModel, and its window
  // legitimately starts mid-file.
  let peeked = byteOffset > 0;
  const resolveModel = async (): Promise<string> => {
    if (currentModel === null && !peeked) {
      peeked = true;
      currentModel = await lookAheadFirstTurnModel(file, lookAheadMaxBytes);
    }
    return currentModel ?? LEGACY_FALLBACK_MODEL;
  };
  // Track how many events share an identical timestamp so messageIds stay unique.
  let lastTs = "";
  let ixForTs = 0;
  let oversizeSkipped = 0;
  // Replayed token_count records dropped this read (see the flat-cumulative
  // guard below). Surfaced so the daemon can see how noisy a CLI version is.
  let replayedSkipped = 0;
  // Only compare against `totals` once this read (or a previous one) has
  // established a cumulative baseline: a fresh session legitimately starts
  // at zero, and the first record must never be mistaken for a replay.
  let seenCumulative = prevSessionTotals?.sessionId === sessionId;
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
        model: await resolveModel(),
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

    // REPLAYED RECORD. `total_token_usage` is monotonically cumulative, so a
    // real API call ALWAYS advances it — it cannot bill zero input. Codex
    // nonetheless logs the same request twice in some versions, seconds
    // apart, with a byte-identical `last_token_usage` AND an unmoved total.
    // Because `last` is used directly as the per-turn delta (see below), the
    // replay bills its full input a second time.
    //
    // Measured over 1,149 local rollouts: 5,051 of 56,822 token_count events
    // (8.89%) are replays carrying 439,435,954 input tokens — a 6.64%
    // over-count. Strongly version-dependent: near-total on 0.63.0/0.98.0,
    // ~74% on 0.110.0, under 4% on 0.145.0+.
    //
    // A flat cumulative is the reliable signal, and it is strictly safer
    // than comparing `last`: the 248 flat records whose `last` DIFFERED all
    // carried zero tokens, so nothing billable is ever dropped by this test.
    // It also survives a read boundary for free, because `totals` is
    // persisted across ticks in FileState.lastSessionTotals — a replay split
    // across two reads is still caught.
    if (
      cumTotal !== null &&
      seenCumulative &&
      cumTotal.input === totals.inputTokens &&
      cumTotal.output === totals.outputTokens &&
      cumTotal.cached === totals.cachedInputTokens &&
      cumTotal.reasoning === totals.reasoningTokens
    ) {
      replayedSkipped++;
      continue;
    }
    if (cumTotal !== null) seenCumulative = true;

    // `last_token_usage` is the PER-TURN usage — exactly what this event
    // should emit, no delta bookkeeping needed. `total_token_usage` is the
    // session-cumulative counterpart (verified against real rollouts: each
    // total delta equals that event's last). Treating `last` as cumulative
    // swallowed ~half of all input/cache tokens, so it is used directly and
    // the delta path below only serves total-only formats.
    let dInput: number;
    let dOutput: number;
    let dCached: number;
    let dCacheWrite = 0;
    let dReasoning: number;
    if (last) {
      ({
        input: dInput,
        output: dOutput,
        cached: dCached,
        cacheWrite: dCacheWrite,
        reasoning: dReasoning,
      } = usageNums(last));
    } else {
      dInput = cumTotal!.input - totals.inputTokens;
      dOutput = cumTotal!.output - totals.outputTokens;
      dCached = cumTotal!.cached - totals.cachedInputTokens;
      dCacheWrite = cumTotal!.cacheWrite - totals.cacheWriteInputTokens;
      dReasoning = cumTotal!.reasoning - totals.reasoningTokens;

      // Reset detection: if any cumulative bucket regressed, treat current
      // numbers as a fresh baseline (new sub-session, log rotation, etc.).
      if (dInput < 0 || dOutput < 0 || dCached < 0 || dReasoning < 0) {
        dInput = cumTotal!.input;
        dOutput = cumTotal!.output;
        dCached = cumTotal!.cached;
        dCacheWrite = cumTotal!.cacheWrite;
        dReasoning = cumTotal!.reasoning;
      } else if (dCacheWrite < 0) {
        // Cache-write regressed on its own. It gets the same fresh-baseline
        // treatment (a negative delta must never reach the clamps below), but
        // deliberately does NOT rebase the other four: no build has ever been
        // observed reporting this field non-zero, let alone monotonically, and
        // letting an unproven bucket re-bill a whole session's input/output as
        // one event is a much worse failure than under-attributing this one.
        dCacheWrite = cumTotal!.cacheWrite;
      }
    }

    // Keep the cumulative bookkeeping coherent either way so a later
    // total-only event (or the next incremental read) deltas correctly.
    if (cumTotal) {
      totals.inputTokens = cumTotal.input;
      totals.outputTokens = cumTotal.output;
      totals.cachedInputTokens = cumTotal.cached;
      totals.cacheWriteInputTokens = cumTotal.cacheWrite;
      totals.reasoningTokens = cumTotal.reasoning;
    } else {
      totals.inputTokens += dInput;
      totals.outputTokens += dOutput;
      totals.cachedInputTokens += dCached;
      totals.cacheWriteInputTokens += dCacheWrite;
      totals.reasoningTokens += dReasoning;
    }

    // Seeded copy of the parent's ledger: bookkeeping above stays (the
    // child's cumulative continues the parent's), but nothing is billed.
    if (seedActive) continue;

    if (dInput === 0 && dOutput === 0 && dCached === 0 && dCacheWrite === 0 && dReasoning === 0) {
      continue;
    }

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
    const model = await resolveModel();

    // Codex reports `input_tokens` INCLUSIVE of both `cached_input_tokens`
    // and `cache_write_input_tokens` (openai/codex parses_cache_write_token_usage:
    // input 100 = cached 40 + write 60). Normalize at the parse boundary so
    // downstream cost math stays uniform:
    //   inputTokens         := plain portion   (paid at full input rate)
    //   cacheReadTokens     := cached portion  (paid at cache-read rate)
    //   cacheCreationTokens := written portion (paid at cache-write rate)
    // Clamp both at input to defend against out-of-order delta noise. The
    // ChatGPT-backend rollouts seen so far carry the field as a literal 0,
    // so cacheCreation stays 0 there — the dashboard renders that as "—".
    const cappedCached = Math.min(dCached, dInput);
    const cappedWrite = Math.min(dCacheWrite, Math.max(0, dInput - cappedCached));
    const nonCachedInput = Math.max(0, dInput - cappedCached - cappedWrite);

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
      cacheCreationTokens: cappedWrite,
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
    replayedSkipped,
  };
}
