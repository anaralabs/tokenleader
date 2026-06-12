import { promises as fsp } from "node:fs";
import type { DaemonState, FileState, TokenEvent } from "../types";
import { log } from "./log";
import { pruneMissingFiles, saveState } from "./state";
import { postEvents, type TransportOpts } from "./transport";

import { listClaudeCodeFiles, listCodexFiles } from "../parser/index";
import { parseClaudeCodeFile } from "../parser/claude-code";
import { parseCodexFile, type CodexSessionTotals } from "../parser/codex";

export interface TickDeps {
  user: string;
  stateDir: string;
  transport: TransportOpts;
  signal?: AbortSignal;

  // Test seams. Real callers leave these undefined.
  listClaudeCodeFiles?: typeof listClaudeCodeFiles;
  listCodexFiles?: typeof listCodexFiles;
  parseClaudeCodeFile?: typeof parseClaudeCodeFile;
  parseCodexFile?: typeof parseCodexFile;
  postEvents?: typeof postEvents;
  // stat returns mtimeMs. We override in tests.
  statFile?: (path: string) => Promise<{ mtimeMs: number } | null>;
  saveState?: typeof saveState;
  now?: () => number;
}

export interface TickResult {
  scannedFiles: number;
  eligibleFiles: number;
  eventsPosted: number;
  inserted: number;
  duplicates: number;
  posted: boolean;
  // Files newly observed this tick.
  newFiles: number;
}

async function defaultStat(path: string): Promise<{ mtimeMs: number } | null> {
  try {
    const s = await fsp.stat(path);
    return { mtimeMs: s.mtimeMs };
  } catch {
    return null;
  }
}

function dedupKey(ev: TokenEvent): string {
  // Mirrors what the CC parser produces (`messageId:requestId`). Codex events
  // get a synthetic key — collisions across files for codex are extremely
  // unlikely because codex sessionId+messageId are unique per message.
  return `${ev.messageId}:${ev.requestId ?? ""}`;
}

/**
 * One poll iteration:
 *   1. List all current Claude Code + Codex files.
 *   2. For each, if mtime > recorded mtime (or unknown), parse from offset.
 *   3. Dedupe events across files via dedup keys (CC reports them; codex we
 *      synthesize). Reject events whose key was already seen this tick.
 *   4. POST batched events.
 *   5. On success, write updated state. On failure, return without advancing.
 *
 * Mutates nothing; takes a state in, returns a new state out.
 */
export async function tick(
  initial: DaemonState,
  deps: TickDeps,
): Promise<{ state: DaemonState; result: TickResult }> {
  const listCC = deps.listClaudeCodeFiles ?? listClaudeCodeFiles;
  const listCx = deps.listCodexFiles ?? listCodexFiles;
  const parseCC = deps.parseClaudeCodeFile ?? parseClaudeCodeFile;
  const parseCx = deps.parseCodexFile ?? parseCodexFile;
  const post = deps.postEvents ?? postEvents;
  const stat = deps.statFile ?? defaultStat;
  const persist = deps.saveState ?? saveState;
  const now = deps.now ?? Date.now;

  const [ccPaths, cxPaths] = await Promise.all([
    safeList(listCC, "claude_code"),
    safeList(listCx, "codex"),
  ]);

  const allPaths = [
    ...ccPaths.map((p) => ({ path: p, kind: "claude_code" as const })),
    ...cxPaths.map((p) => ({ path: p, kind: "codex" as const })),
  ];

  const presentSet = new Set(allPaths.map((x) => x.path));

  let newFiles = 0;
  let eligible = 0;
  const collected: TokenEvent[] = [];
  const seenThisTick = new Set<string>();
  // Pending file updates we will write only after a successful POST.
  const pendingUpdates: FileState[] = [];

  for (const item of allPaths) {
    if (deps.signal?.aborted) break;

    const prev = initial.files[item.path];
    if (!prev) newFiles++;

    const st = await stat(item.path);
    if (!st) {
      // File vanished between list and stat. Skip; pruneMissingFiles will
      // drop stale entries at end of tick.
      continue;
    }

    // Only re-parse if mtime advanced or we've never seen the file.
    const shouldParse =
      !prev ||
      st.mtimeMs > prev.mtimeMs ||
      // Growth without an mtime bump is missed until the next bump;
      // Claude Code/Codex always update mtime on append, so this is fine.
      false;

    if (!shouldParse) continue;
    eligible++;

    const byteOffset = prev?.byteOffset ?? 0;

    try {
      if (item.kind === "claude_code") {
        const r = await parseCC({
          path: item.path,
          byteOffset,
          user: deps.user,
        });
        const accepted: TokenEvent[] = [];
        for (let i = 0; i < r.events.length; i++) {
          const ev = r.events[i]!;
          const k = r.seenDedupKeys[i] ?? dedupKey(ev);
          if (seenThisTick.has(k)) continue;
          seenThisTick.add(k);
          accepted.push(ev);
        }
        for (const ev of accepted) collected.push(ev);
        if (r.oversizeSkipped) {
          log.warn("oversize_record_skipped", {
            path: item.path,
            kind: item.kind,
            count: r.oversizeSkipped,
          });
        }
        pendingUpdates.push({
          path: item.path,
          mtimeMs: st.mtimeMs,
          byteOffset: r.newOffset,
          ...(prev?.lastSessionTotals ? { lastSessionTotals: prev.lastSessionTotals } : {}),
        });
      } else {
        const prevTotals = toCodexTotals(prev?.lastSessionTotals);
        const r = await parseCx({
          path: item.path,
          byteOffset,
          user: deps.user,
          ...(prevTotals ? { prevSessionTotals: prevTotals } : {}),
        });
        for (const ev of r.events) {
          const k = dedupKey(ev);
          if (seenThisTick.has(k)) continue;
          seenThisTick.add(k);
          collected.push(ev);
        }
        if (r.oversizeSkipped) {
          log.warn("oversize_record_skipped", {
            path: item.path,
            kind: item.kind,
            count: r.oversizeSkipped,
          });
        }
        pendingUpdates.push({
          path: item.path,
          mtimeMs: st.mtimeMs,
          byteOffset: r.newOffset,
          ...(r.sessionTotals
            ? { lastSessionTotals: r.sessionTotals }
            : prev?.lastSessionTotals
              ? { lastSessionTotals: prev.lastSessionTotals }
              : {}),
        });
      }
    } catch (err: unknown) {
      log.error("parse_failed", {
        path: item.path,
        kind: item.kind,
        err: String((err as Error)?.message ?? err),
      });
      // Don't advance offset for this file. Continue with others.
    }
  }

  log.info("tick_collected", {
    scanned: allPaths.length,
    eligible,
    events: collected.length,
    newFiles,
  });

  // POST events first — only persist state on success.
  let posted = false;
  let inserted = 0;
  let duplicates = 0;

  if (collected.length === 0) {
    // Nothing to send, but file mtimes may have advanced (e.g. user just
    // opened a new session that produced no usage events yet). Persist
    // pending offsets anyway so we don't keep re-reading.
    posted = true;
  } else {
    const r = await post(collected, deps.transport, deps.signal);
    posted = r.ok;
    inserted = r.inserted;
    duplicates = r.duplicates;
    if (!r.ok) {
      log.error("tick_post_failed", { err: r.error, events: collected.length });
    }
  }

  let nextState = initial;
  if (posted) {
    // Apply pending updates and prune missing files.
    let merged = initial;
    for (const u of pendingUpdates) {
      merged = {
        ...merged,
        files: { ...merged.files, [u.path]: u },
      };
    }
    merged = pruneMissingFiles(merged, presentSet);
    merged = { ...merged, lastFlushAt: now() };
    try {
      await persist(deps.stateDir, merged);
      nextState = merged;
    } catch (err: unknown) {
      log.error("state_save_failed", {
        err: String((err as Error)?.message ?? err),
      });
      // Keep the in-memory advance even if persist failed; next tick will
      // re-attempt. But we don't poison nextState — return merged so
      // in-memory caller has it.
      nextState = merged;
    }
  }

  return {
    state: nextState,
    result: {
      scannedFiles: allPaths.length,
      eligibleFiles: eligible,
      eventsPosted: collected.length,
      inserted,
      duplicates,
      posted,
      newFiles,
    },
  };
}

async function safeList(fn: () => Promise<string[]>, label: string): Promise<string[]> {
  try {
    return await fn();
  } catch (err: unknown) {
    log.error("list_failed", {
      source: label,
      err: String((err as Error)?.message ?? err),
    });
    return [];
  }
}

function toCodexTotals(v: FileState["lastSessionTotals"]): CodexSessionTotals | undefined {
  if (!v) return undefined;
  return {
    sessionId: v.sessionId,
    inputTokens: v.inputTokens,
    outputTokens: v.outputTokens,
    cachedInputTokens: v.cachedInputTokens,
    reasoningTokens: v.reasoningTokens,
  };
}
