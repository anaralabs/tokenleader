import { promises as fs } from "node:fs";
import path from "node:path";
import type { DaemonState, FileState } from "../types";

export const STATE_FILENAME = "state.json";
export const TMP_FILENAME = "state.json.tmp";

// The daemon-only rescan marker is declared here (not in ../types) because
// it is purely daemon bookkeeping; the parser/server layers never see it.
declare module "../types" {
  interface DaemonState {
    /**
     * One-time full-rescan generation. Daemons below RESCAN_GENERATION get
     * every stored byte offset reset on boot (user-prompt backfill: older
     * builds never sent user-prompt events). See applyRescanGeneration.
     */
    rescanGeneration?: number;
  }
}

/** Bump to force the fleet through another one-time full rescan. */
export const RESCAN_GENERATION = 1;

export function emptyState(): DaemonState {
  return {
    schemaVersion: 1,
    files: {},
    lastFlushAt: 0,
  };
}

function statePath(stateDir: string): string {
  return path.join(stateDir, STATE_FILENAME);
}

function tmpPath(stateDir: string): string {
  return path.join(stateDir, TMP_FILENAME);
}

export async function ensureStateDir(stateDir: string): Promise<void> {
  await fs.mkdir(stateDir, { recursive: true });
}

function isDaemonState(value: unknown): value is DaemonState {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.schemaVersion !== 1) return false;
  if (typeof v.lastFlushAt !== "number") return false;
  if (!v.files || typeof v.files !== "object") return false;
  if (v.rescanGeneration !== undefined && typeof v.rescanGeneration !== "number") return false;
  if (v.cursorLocal !== undefined) {
    if (!v.cursorLocal || typeof v.cursorLocal !== "object") return false;
    const c = v.cursorLocal as Record<string, unknown>;
    if (typeof c.dbPath !== "string") return false;
    if (typeof c.lastRowid !== "number") return false;
  }
  if (v.cursorCloud !== undefined) {
    if (!v.cursorCloud || typeof v.cursorCloud !== "object") return false;
    const c = v.cursorCloud as Record<string, unknown>;
    if (typeof c.lastSyncAt !== "number") return false;
    if (c.lastEventTimestamp !== undefined && typeof c.lastEventTimestamp !== "number") {
      return false;
    }
    if (c.fullSyncDone !== undefined && typeof c.fullSyncDone !== "boolean") return false;
    if (c.resumePage !== undefined && typeof c.resumePage !== "number") return false;
    if (c.resumeStartDate !== undefined && typeof c.resumeStartDate !== "number") return false;
  }
  for (const fs of Object.values(v.files as Record<string, unknown>)) {
    if (!fs || typeof fs !== "object") return false;
    const f = fs as Record<string, unknown>;
    if (typeof f.path !== "string") return false;
    if (typeof f.mtimeMs !== "number") return false;
    if (typeof f.byteOffset !== "number") return false;
  }
  return true;
}

/**
 * One-time full rescan (the user-prompt backfill): states below
 * RESCAN_GENERATION get every stored file reset to byteOffset 0 — and
 * mtimeMs 0 so even dormant files (whose mtime will never advance again)
 * are eligible for a re-parse next tick. Stale codex `lastSessionTotals`
 * are dropped: a from-zero re-parse must not compute deltas against
 * end-of-file totals. Everything else (including any persisted dedup keys)
 * is kept, so already-sent events are filtered and only never-sent events
 * actually POST (the server is idempotent regardless).
 *
 * Idempotent: a state already at RESCAN_GENERATION is returned unchanged.
 */
export function applyRescanGeneration(state: DaemonState): {
  state: DaemonState;
  changed: boolean;
} {
  if ((state.rescanGeneration ?? 0) >= RESCAN_GENERATION) {
    return { state, changed: false };
  }
  const files: Record<string, FileState> = {};
  for (const [k, v] of Object.entries(state.files)) {
    const { lastSessionTotals: _stale, ...rest } = v;
    files[k] = { ...rest, mtimeMs: 0, byteOffset: 0 };
  }
  return {
    state: { ...state, files, rescanGeneration: RESCAN_GENERATION },
    changed: true,
  };
}

/**
 * Load `state.json`. Returns an empty state if the file is missing or
 * corrupt. The daemon never blocks on a corrupt state file — we'd rather
 * re-emit a few duplicates (the server is idempotent) than wedge.
 */
export async function loadState(stateDir: string): Promise<DaemonState> {
  const p = statePath(stateDir);
  try {
    const text = await fs.readFile(p, "utf8");
    const parsed = JSON.parse(text);
    if (!isDaemonState(parsed)) {
      return emptyState();
    }
    return parsed;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      return emptyState();
    }
    // Corrupt JSON / read failure: start fresh. Logging is the caller's job.
    return emptyState();
  }
}

/**
 * Atomic save: write to `state.json.tmp` then `rename` over `state.json`.
 * `rename` on the same filesystem is atomic on macOS / Linux.
 */
export async function saveState(stateDir: string, state: DaemonState): Promise<void> {
  await ensureStateDir(stateDir);
  const tp = tmpPath(stateDir);
  const fp = statePath(stateDir);
  const body = JSON.stringify(state, null, 2);
  await fs.writeFile(tp, body, "utf8");
  await fs.rename(tp, fp);
}

export function upsertFileState(state: DaemonState, next: FileState): DaemonState {
  return {
    ...state,
    files: { ...state.files, [next.path]: next },
  };
}

export function pruneMissingFiles(
  state: DaemonState,
  presentPaths: ReadonlySet<string>,
): DaemonState {
  const files: Record<string, FileState> = {};
  for (const [k, v] of Object.entries(state.files)) {
    if (presentPaths.has(k)) files[k] = v;
  }
  return { ...state, files };
}
