// Tiny structured JSON-line logger. Writes to stdout (captured by the
// LaunchAgent's StandardOutPath) AND to a bounded, rotating local file so a
// misbehaving daemon can be debugged after the fact without the log growing
// without bound. No external deps.

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function envMinLevel(): LogLevel {
  const raw = (process.env.TOKENLEADER_LOG_LEVEL ?? "info").toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  return "info";
}

// --- bounded rotating file sink ------------------------------------------
// Default dir matches the service definition's stdout/stderr dir so all daemon
// logs live in one place: on macOS the LaunchAgent's StandardOutPath dir; on
// Linux `~/.local/state` (a systemd unit sends stderr to the journal, but the
// `upload_logs` directive reads THIS file, so it must land somewhere a Linux
// operator would look — the daemon used to create a literal ~/Library/Logs on
// Linux boxes). Override with TOKENLEADER_LOG_DIR (tests/dev). Set
// TOKENLEADER_LOG_FILE_DISABLED=1 to skip the file sink entirely.
//
// DELIBERATELY homedir-only, NOT $XDG_STATE_HOME: the state dir
// (src/daemon/main.ts) resolves from the home directory alone, and the
// installer and uninstaller both hardcode ~/.local/state. Honouring
// XDG_STATE_HOME here — it IS inherited by `systemd --user` units on distros
// whose environment.d sets it — put daemon.jsonl somewhere the installer had
// not announced and `TOKENLEADER_PURGE=y` would not delete.
export function defaultLogDir(
  platform: string = process.platform,
  home: string = homedir(),
): string {
  if (platform === "darwin") return path.join(home, "Library", "Logs", "anara-leaderboard");
  return path.join(home, ".local", "state", "anara-leaderboard");
}

export const LOG_DIR =
  process.env.TOKENLEADER_LOG_DIR && process.env.TOKENLEADER_LOG_DIR.length > 0
    ? process.env.TOKENLEADER_LOG_DIR
    : defaultLogDir();
export const LOG_FILE = path.join(LOG_DIR, "daemon.jsonl");
const MAX_LOG_BYTES = 5 * 1024 * 1024; // 5 MB per file
const KEEP_ROTATIONS = 3; // daemon.jsonl + .1 + .2 + .3 => <= 20 MB total
const FILE_SINK_ENABLED = process.env.TOKENLEADER_LOG_FILE_DISABLED !== "1";
let dirEnsured = false;

function rotateIfNeeded(): void {
  try {
    if (statSync(LOG_FILE).size < MAX_LOG_BYTES) return;
  } catch {
    return; // no file yet -> nothing to rotate
  }
  try {
    // drop the oldest, shift the rest up, then move current -> .1
    for (let i = KEEP_ROTATIONS - 1; i >= 1; i--) {
      const src = `${LOG_FILE}.${i}`;
      if (existsSync(src)) renameSync(src, `${LOG_FILE}.${i + 1}`);
    }
    renameSync(LOG_FILE, `${LOG_FILE}.1`);
  } catch {
    // best-effort; never let rotation throw into the daemon
  }
}

function appendToFile(line: string): void {
  if (!FILE_SINK_ENABLED) return;
  try {
    if (!dirEnsured) {
      mkdirSync(LOG_DIR, { recursive: true });
      dirEnsured = true;
    }
    rotateIfNeeded();
    appendFileSync(LOG_FILE, line);
  } catch {
    // disk full / perms / etc. — logging must never crash the daemon.
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ unserializable: String(value) });
  }
}

function emit(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
  const min = LEVELS[envMinLevel()];
  if (LEVELS[level] < min) return;
  const record = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(fields ?? {}),
  };
  // One JSON object per line. stdout for live/LaunchAgent capture; file sink
  // for bounded persistent history.
  const line = safeStringify(record) + "\n";
  process.stdout.write(line);
  appendToFile(line);
}

export const log: Logger = {
  debug: (m, f) => emit("debug", m, f),
  info: (m, f) => emit("info", m, f),
  warn: (m, f) => emit("warn", m, f),
  error: (m, f) => emit("error", m, f),
};
