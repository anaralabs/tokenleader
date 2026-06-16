import { createHash } from "node:crypto";
import { basename, dirname } from "node:path";
import type { MessageType, TokenEvent } from "../types.ts";
import { readNewlineLines } from "./read-slice.ts";
import { CURSOR_LOCAL_FALLBACK_MODEL } from "./cursor-local.ts";

export interface ParseCursorTranscriptOptions {
  path: string;
  byteOffset: number;
  user: string;
  /** File mtime used as event timestamp for newly read lines. */
  fileMtimeMs: number;
  /** Absolute 0-based line index already ingested from this file. */
  startingLineIndex?: number;
}

export interface ParseCursorTranscriptResult {
  events: TokenEvent[];
  newOffset: number;
  seenDedupKeys: string[];
  /** Next absolute line index after this parse (persist in FileState). */
  nextLineIndex: number;
  oversizeSkipped?: number;
}

interface TranscriptContentPart {
  type?: string;
  text?: string;
}

interface TranscriptLine {
  role?: string;
  message?: {
    content?: TranscriptContentPart[];
  };
}

function isString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function messageTypeForRole(role: unknown): MessageType | null {
  if (!isString(role)) return null;
  const r = role.toLowerCase();
  if (r === "user" || r === "human") return "user";
  if (r === "assistant" || r === "agent" || r === "ai") return "assistant";
  return null;
}

/** Sum text-part lengths only — never ingest transcript body content. */
export function estimateTranscriptTextLength(line: TranscriptLine): number {
  const parts = line.message?.content;
  if (!Array.isArray(parts)) return 0;
  let total = 0;
  for (const part of parts) {
    if (part?.type === "text" && typeof part.text === "string") {
      total += part.text.length;
    }
  }
  return total;
}

function sessionIdFromPath(path: string): string {
  const file = basename(path, ".jsonl");
  const parent = basename(dirname(path));
  return parent.length > 0 ? parent : file;
}

/** Stable per-line id that survives incremental byte-offset reads. */
export function stableTranscriptMessageId(filePath: string, lineIndex: number): string {
  return createHash("sha256").update(`${filePath}:${lineIndex}`).digest("hex").slice(0, 24);
}

/**
 * Parse Cursor agent transcript JSONL files under
 * ~/.cursor/projects/.../agent-transcripts/. These survive SQLite pruning.
 */
export async function parseCursorTranscriptFile(
  opts: ParseCursorTranscriptOptions,
): Promise<ParseCursorTranscriptResult> {
  const { path, byteOffset, user, fileMtimeMs } = opts;
  const file = Bun.file(path);
  const totalSize = file.size;
  if (byteOffset >= totalSize) {
    const lineIndex = opts.startingLineIndex ?? 0;
    return { events: [], newOffset: totalSize, seenDedupKeys: [], nextLineIndex: lineIndex };
  }

  const sessionId = sessionIdFromPath(path);
  const timestamp = fileMtimeMs > 0 ? fileMtimeMs : Date.now();

  const events: TokenEvent[] = [];
  const seenDedupKeys: string[] = [];
  const localSeen = new Set<string>();
  let newOffset = byteOffset;
  let oversizeSkipped = 0;
  let lineIndex = opts.startingLineIndex ?? 0;

  for await (const part of readNewlineLines(file, byteOffset)) {
    newOffset = part.newOffset;
    if (part.kind === "oversize") {
      oversizeSkipped++;
      continue;
    }
    if (part.kind !== "line") continue;

    lineIndex++;
    let raw: TranscriptLine;
    try {
      raw = JSON.parse(part.text) as TranscriptLine;
    } catch {
      continue;
    }

    const messageType = messageTypeForRole(raw.role);
    if (!messageType) continue;

    const messageId = stableTranscriptMessageId(path, lineIndex);
    const dedupKey = `${messageId}:`;
    if (localSeen.has(dedupKey)) continue;
    localSeen.add(dedupKey);

    const textLen = estimateTranscriptTextLength(raw);
    const inputTokens = 0;
    const outputTokens = messageType === "assistant" ? Math.ceil(textLen / 4) : 0;

    if (messageType === "assistant" && outputTokens === 0) {
      continue;
    }

    events.push({
      user,
      source: "cursor_local",
      sessionId,
      messageId,
      requestId: null,
      timestamp,
      model: messageType === "assistant" ? CURSOR_LOCAL_FALLBACK_MODEL : "",
      messageType,
      inputTokens,
      outputTokens,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      reasoningTokens: null,
    });
    seenDedupKeys.push(dedupKey);
  }

  return {
    events,
    newOffset,
    seenDedupKeys,
    nextLineIndex: lineIndex,
    ...(oversizeSkipped > 0 ? { oversizeSkipped } : {}),
  };
}
