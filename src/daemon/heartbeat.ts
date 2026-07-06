// The liveness contract's inner half (docs/resilience.md): the daemon proves
// PROGRESS by atomically rewriting a small heartbeat file at every work
// boundary, and explains every deliberate exit in an append-only journal.
// Disk writes survived the 2026-07-06 timer wedge; sockets and timers did
// not — so the heartbeat is a file the out-of-process watchdog stats, never
// a self-ping. Everything here is synchronous and swallow-on-error: liveness
// reporting must never be able to kill the thing it reports on.

import { appendFileSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface Heartbeat {
  pid: number;
  /** Wall-clock ms at write time — forensic context, never a staleness input. */
  wall_ms: number;
  /** Monotonic tick counter across the process lifetime. */
  tick_seq: number;
  version: string;
  consec_failures: number;
  last_error: string | null;
}

export const HEARTBEAT_FILE = "heartbeat.json";
export const EXIT_JOURNAL_FILE = "exit-journal.jsonl";
export const UPDATE_MARKER_FILE = "update-in-progress.json";

// The journal is bounded by rewrite-on-append past this size; entries are
// ~80 bytes, so the cap keeps years of restarts while staying trivially
// readable in one gulp.
const JOURNAL_MAX_BYTES = 64 * 1024;
const JOURNAL_KEEP_TAIL = 100;

export interface ExitJournalEntry {
  ts: number;
  reason: string;
  code: number;
}

export interface HeartbeatWriter {
  /** Bump tick_seq and persist. Called at tick start. */
  tickStart(): void;
  /** Persist current state without bumping the sequence — the mid-tick
   *  progress signal (per-batch, per-N-files, per-cloud-page). */
  progress(): void;
  /** Record the tick outcome and persist. Called at tick end. */
  tickEnd(ok: boolean, err?: string): void;
}

function atomicWriteSync(file: string, data: string): void {
  const tmp = `${file}.new`;
  writeFileSync(tmp, data, { mode: 0o644 });
  renameSync(tmp, file);
}

/**
 * Creates the daemon's heartbeat writer. All writes are best-effort; write
 * failures are counted and surfaced through `writeFailures` so the checkin
 * can report a HEARTBEAT_IO condition (server alerts instead of the watchdog
 * killing a healthy daemon that merely can't write).
 */
export function createHeartbeat(
  stateDir: string,
  version: string,
  pid: number = process.pid,
): HeartbeatWriter & { snapshot(): Heartbeat; writeFailures: number } {
  const file = path.join(stateDir, HEARTBEAT_FILE);
  const hb: Heartbeat = {
    pid,
    wall_ms: Date.now(),
    tick_seq: 0,
    version,
    consec_failures: 0,
    last_error: null,
  };
  const self = {
    writeFailures: 0,
    snapshot: () => ({ ...hb }),
    tickStart() {
      hb.tick_seq += 1;
      write();
    },
    progress() {
      write();
    },
    tickEnd(ok: boolean, err?: string) {
      if (ok) {
        hb.consec_failures = 0;
        hb.last_error = null;
      } else {
        hb.consec_failures += 1;
        hb.last_error = (err ?? "unknown").slice(0, 256);
      }
      write();
    },
  };
  function write(): void {
    hb.wall_ms = Date.now();
    try {
      atomicWriteSync(file, JSON.stringify(hb));
    } catch {
      self.writeFailures += 1;
    }
  }
  return self;
}

/** Reads a heartbeat written by any daemon incarnation; null when missing or
 *  torn (torn is impossible via the atomic write; corrupt = treat as absent
 *  and observe-only, per the missing-heartbeat rule). */
export function readHeartbeat(stateDir: string): Heartbeat | null {
  try {
    const raw = readFileSync(path.join(stateDir, HEARTBEAT_FILE), "utf8");
    const v = JSON.parse(raw) as Heartbeat;
    if (typeof v.pid !== "number" || typeof v.tick_seq !== "number") return null;
    return v;
  } catch {
    return null;
  }
}

/**
 * Append a deliberate-exit record BEFORE calling process.exit. Synchronous
 * by design (nothing may be pending when the process dies). The watchdog
 * counts only respawns NOT explained here; the server's crash-loop
 * classifier ignores journal-explained restarts.
 */
export function journalExit(stateDir: string, reason: string, code: number): void {
  const file = path.join(stateDir, EXIT_JOURNAL_FILE);
  const line = `${JSON.stringify({ ts: Date.now(), reason, code })}\n`;
  try {
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      // no journal yet
    }
    if (size + line.length > JOURNAL_MAX_BYTES) {
      const tail = readJournal(stateDir).slice(-JOURNAL_KEEP_TAIL);
      atomicWriteSync(
        file,
        tail.map((e) => JSON.stringify(e)).join("\n") + (tail.length ? "\n" : ""),
      );
    }
    appendFileSync(file, line);
  } catch {
    // journal loss degrades classification, never operation
  }
}

/** All parseable journal entries, oldest first. */
export function readJournal(stateDir: string): ExitJournalEntry[] {
  try {
    const raw = readFileSync(path.join(stateDir, EXIT_JOURNAL_FILE), "utf8");
    const out: ExitJournalEntry[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const v = JSON.parse(line) as ExitJournalEntry;
        if (typeof v.ts === "number" && typeof v.reason === "string") out.push(v);
      } catch {
        // skip torn line
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Entries newer than `sinceMs`, for checkin payloads and respawn accounting. */
export function journalTail(stateDir: string, sinceMs: number): ExitJournalEntry[] {
  return readJournal(stateDir).filter((e) => e.ts >= sinceMs);
}

// --- update-in-progress marker ---------------------------------------------
// Written before the binary download, cleared in a finally. The watchdog
// extends its deadline to UPDATE_GRACE_MS while a fresh marker exists; a
// marker older than UPDATE_MARKER_IGNORE_MS is crash debris and ignored.

export const UPDATE_GRACE_MS = 45 * 60_000;
export const UPDATE_MARKER_IGNORE_MS = 60 * 60_000;

export function writeUpdateMarker(stateDir: string): void {
  try {
    atomicWriteSync(
      path.join(stateDir, UPDATE_MARKER_FILE),
      JSON.stringify({ started_at: Date.now(), pid: process.pid }),
    );
  } catch {
    // marker loss = shorter watchdog grace, never a failure
  }
}

export function clearUpdateMarker(stateDir: string): void {
  try {
    // Truncate rather than unlink: an unlink of a file the watchdog is mid-stat
    // is fine either way, but an empty file parses as "no marker" everywhere.
    writeFileSync(path.join(stateDir, UPDATE_MARKER_FILE), "");
  } catch {
    // ignored
  }
}

export function readUpdateMarker(stateDir: string): { started_at: number } | null {
  try {
    const raw = readFileSync(path.join(stateDir, UPDATE_MARKER_FILE), "utf8");
    if (!raw.trim()) return null;
    const v = JSON.parse(raw) as { started_at?: unknown };
    if (typeof v.started_at !== "number") return null;
    return { started_at: v.started_at };
  } catch {
    return null;
  }
}
