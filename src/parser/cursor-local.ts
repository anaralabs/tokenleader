import { statSync } from "node:fs";
import { Database } from "bun:sqlite";
import type { MessageType, TokenEvent } from "../types.ts";

/** Fallback model when Cursor's local DB omits one (PricingCache path). */
export const CURSOR_LOCAL_FALLBACK_MODEL = "cursor";

/** Cap rows per tick so a first-run backfill cannot wedge a single POST. */
export const CURSOR_LOCAL_BATCH_LIMIT = 5000;

export interface ParseCursorLocalOptions {
  dbPath: string;
  lastRowid: number;
  user: string;
  batchLimit?: number;
  /** state.vscdb mtime — final timestamp fallback (never emit 0). */
  dbMtimeMs?: number;
}

export interface ParseCursorLocalResult {
  events: TokenEvent[];
  newRowid: number;
  seenDedupKeys: string[];
}

interface BubbleRecord {
  type?: number;
  role?: string;
  bubbleId?: string;
  usageUuid?: string | null;
  tokenCount?: {
    inputTokens?: number;
    outputTokens?: number;
  };
  text?: string;
  attachedCodeChunks?: unknown;
  codebaseContextChunks?: unknown;
  contextPieces?: unknown;
  attachedFileCodeChunksUris?: unknown;
  unifiedMode?: unknown;
}

interface ComposerTimestamps {
  createdAt?: number;
  lastUpdatedAt?: number;
}

interface BubbleKeyParts {
  composerId: string;
  bubbleId: string;
}

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

function parseBubbleKey(key: string): BubbleKeyParts | null {
  if (!key.startsWith("bubbleId:")) return null;
  const rest = key.slice("bubbleId:".length);
  const lastColon = rest.lastIndexOf(":");
  if (lastColon <= 0) return null;
  const composerId = rest.slice(0, lastColon);
  const bubbleId = rest.slice(lastColon + 1);
  if (composerId.length === 0 || bubbleId.length === 0) return null;
  return { composerId, bubbleId };
}

/** Map Cursor bubble type / role to tokenleader messageType. */
export function messageTypeForBubble(rec: Pick<BubbleRecord, "type" | "role">): MessageType | null {
  if (rec.type === 1) return "user";
  if (rec.type === 2) return "assistant";
  const role = typeof rec.role === "string" ? rec.role.toLowerCase() : "";
  if (role === "user" || role === "human") return "user";
  if (role === "assistant" || role === "agent" || role === "ai") return "assistant";
  return null;
}

function readTokenCount(rec: BubbleRecord): { input: number; output: number } {
  const tc = rec.tokenCount;
  return {
    input:
      typeof tc?.inputTokens === "number" && Number.isFinite(tc.inputTokens) ? tc.inputTokens : 0,
    output:
      typeof tc?.outputTokens === "number" && Number.isFinite(tc.outputTokens)
        ? tc.outputTokens
        : 0,
  };
}

/** Count attached context size in characters — never returned as message content. */
export function estimateContextCharLength(rec: BubbleRecord): number {
  let total = 0;

  const chunkArrays = [rec.attachedCodeChunks, rec.codebaseContextChunks, rec.contextPieces];
  for (const arr of chunkArrays) {
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      if (!item || typeof item !== "object") continue;
      const lines = (item as { lines?: unknown }).lines;
      if (Array.isArray(lines)) {
        for (const line of lines) {
          if (typeof line === "string") total += line.length;
        }
      } else {
        total += JSON.stringify(item).length;
      }
    }
  }

  if (Array.isArray(rec.attachedFileCodeChunksUris)) {
    for (const uri of rec.attachedFileCodeChunksUris) {
      if (typeof uri === "string") total += uri.length;
    }
  }

  return total;
}

/**
 * When Cursor stores zero tokenCount, estimate from context size (input) and
 * text length (output) — never ingest message content, only sizes.
 */
export function estimateCursorTokens(
  rec: BubbleRecord,
  messageType: MessageType,
): { inputTokens: number; outputTokens: number } {
  let { input, output } = readTokenCount(rec);

  if (messageType === "assistant") {
    if (input === 0) {
      const contextChars = estimateContextCharLength(rec);
      if (contextChars > 0) {
        input = Math.ceil(contextChars / 4);
      }
    }
    if (output === 0) {
      const text = typeof rec.text === "string" ? rec.text : "";
      if (text.length > 0) {
        output = Math.ceil(text.length / 4);
      }
    }
  }

  return { inputTokens: input, outputTokens: output };
}

function loadComposerTimestamps(db: Database): Map<string, ComposerTimestamps> {
  const map = new Map<string, ComposerTimestamps>();
  const rows = db
    .query("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'")
    .all() as Array<{ key: string; value: string | Uint8Array }>;

  for (const row of rows) {
    const composerId = row.key.slice("composerData:".length);
    if (composerId.length === 0) continue;
    try {
      const raw = typeof row.value === "string" ? row.value : new TextDecoder().decode(row.value);
      const parsed = JSON.parse(raw) as ComposerTimestamps;
      const meta: ComposerTimestamps = {};
      if (isNum(parsed.createdAt)) meta.createdAt = parsed.createdAt;
      if (isNum(parsed.lastUpdatedAt)) meta.lastUpdatedAt = parsed.lastUpdatedAt;
      if (meta.createdAt !== undefined || meta.lastUpdatedAt !== undefined) {
        map.set(composerId, meta);
      }
    } catch {
      // Skip malformed composer rows.
    }
  }
  return map;
}

/** Load optional per-composer timestamps from agentKv rows (tertiary fallback). */
function loadAgentKvTimestamps(db: Database): Map<string, number> {
  const map = new Map<string, number>();
  const rows = db
    .query(
      `SELECT key, value FROM cursorDiskKV
       WHERE key LIKE 'agentKv:%' AND key NOT LIKE 'agentKv:blob:%'`,
    )
    .all({}) as Array<{ key: string; value: string | Uint8Array }>;

  for (const row of rows) {
    const segments = row.key.split(":");
    if (segments.length < 3) continue;
    const composerId = segments[1]!;
    if (composerId.length === 0 || composerId === "blob") continue;
    try {
      const raw = typeof row.value === "string" ? row.value : new TextDecoder().decode(row.value);
      const parsed = JSON.parse(raw) as {
        createdAt?: number;
        lastUpdatedAt?: number;
        timestamp?: number;
      };
      const ts = parsed.lastUpdatedAt ?? parsed.createdAt ?? parsed.timestamp;
      if (isNum(ts)) {
        const prev = map.get(composerId);
        if (prev === undefined || ts > prev) map.set(composerId, ts);
      }
    } catch {
      // Skip malformed agentKv rows.
    }
  }
  return map;
}

/** Resolve event timestamp — never returns 0 (1970). */
export function resolveCursorTimestamp(
  composerId: string,
  composerTimes: Map<string, ComposerTimestamps>,
  agentKvTimes: Map<string, number>,
  dbMtimeMs: number,
): number {
  const meta = composerTimes.get(composerId);
  if (meta && isNum(meta.createdAt)) return meta.createdAt;
  if (meta && isNum(meta.lastUpdatedAt)) return meta.lastUpdatedAt;

  const agentTs = agentKvTimes.get(composerId);
  if (isNum(agentTs)) return agentTs;

  if (isNum(dbMtimeMs)) return dbMtimeMs;
  return Date.now();
}

function decodeValue(value: string | Uint8Array): string {
  return typeof value === "string" ? value : new TextDecoder().decode(value);
}

function readDbMtimeMs(dbPath: string, override?: number): number {
  if (override !== undefined && Number.isFinite(override) && override > 0) {
    return override;
  }
  try {
    const st = statSync(dbPath);
    return st.mtimeMs;
  } catch {
    return Date.now();
  }
}

function openCursorDatabase(dbPath: string): Database | null {
  try {
    return new Database(dbPath, { readonly: true });
  } catch {
    return null;
  }
}

/**
 * Read new Cursor composer bubbles from the local state.vscdb SQLite file.
 * Uses rowid watermarking — REPLACE updates get a fresh rowid and are seen
 * again (server dedup keeps the first emission).
 */
export function parseCursorLocal(opts: ParseCursorLocalOptions): ParseCursorLocalResult {
  const { dbPath, lastRowid, user } = opts;
  const batchLimit = opts.batchLimit ?? CURSOR_LOCAL_BATCH_LIMIT;
  const dbMtimeMs = readDbMtimeMs(dbPath, opts.dbMtimeMs);

  const db = openCursorDatabase(dbPath);
  if (!db) {
    return { events: [], newRowid: lastRowid, seenDedupKeys: [] };
  }

  try {
    const composerTimes = loadComposerTimestamps(db);
    const agentKvTimes = loadAgentKvTimestamps(db);
    const rows = db
      .query(
        `SELECT rowid, key, value
         FROM cursorDiskKV
         WHERE key LIKE 'bubbleId:%' AND rowid > $lastRowid
         ORDER BY rowid ASC
         LIMIT $limit`,
      )
      .all({ $lastRowid: lastRowid, $limit: batchLimit }) as Array<{
      rowid: number;
      key: string;
      value: string | Uint8Array;
    }>;

    const events: TokenEvent[] = [];
    const seenDedupKeys: string[] = [];
    const localSeen = new Set<string>();
    let newRowid = lastRowid;

    for (const row of rows) {
      newRowid = row.rowid;
      const parts = parseBubbleKey(row.key);
      if (!parts) continue;

      let rec: BubbleRecord;
      try {
        rec = JSON.parse(decodeValue(row.value)) as BubbleRecord;
      } catch {
        continue;
      }

      const messageType = messageTypeForBubble(rec);
      if (!messageType) continue;

      const bubbleId =
        typeof rec.bubbleId === "string" && rec.bubbleId.length > 0 ? rec.bubbleId : parts.bubbleId;
      const requestId =
        typeof rec.usageUuid === "string" && rec.usageUuid.length > 0 ? rec.usageUuid : null;
      const dedupKey = `${bubbleId}:${requestId ?? ""}`;
      if (localSeen.has(dedupKey)) continue;
      localSeen.add(dedupKey);

      const { inputTokens, outputTokens } = estimateCursorTokens(rec, messageType);

      if (messageType === "assistant" && inputTokens === 0 && outputTokens === 0) {
        continue;
      }

      const timestamp = resolveCursorTimestamp(
        parts.composerId,
        composerTimes,
        agentKvTimes,
        dbMtimeMs,
      );

      events.push({
        user,
        source: "cursor_local",
        sessionId: parts.composerId,
        messageId: bubbleId,
        requestId,
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

    return { events, newRowid, seenDedupKeys };
  } finally {
    db.close();
  }
}
