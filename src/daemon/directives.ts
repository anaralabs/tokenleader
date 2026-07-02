// Execution side of the directive channel (zero-touch remote recovery).
//
// The server piggybacks a single-shot directive on a /checkin or /ingest
// response; this module runs it. The allowlist is deliberately tiny and
// re-checked here — the server is already trusted enough to ship us
// binaries, but an allowlist keeps the blast radius of a compromised or
// buggy server response to "restart" and "upload a log tail", never
// arbitrary execution.
//
//   restart      exit(RESTART_EXIT_CODE) so launchd respawns us fresh —
//                re-runs plist-heal, retries the update check ~30s in, and
//                clears any wedged in-memory state. The universal fix.
//   upload_logs  POST the tail of daemon.jsonl to the server so an operator
//                can read it from the dashboard instead of SSHing into a
//                teammate's laptop.

import { promises as fsp } from "node:fs";
import type { DaemonDirective } from "../types";
import { LOG_FILE, type Logger } from "./log";
import { RESTART_EXIT_CODE } from "./update";

// Matches the server's DIAG_LOG_MAX_BYTES headroom (256KB cap server-side).
const LOG_TAIL_BYTES = 64 * 1024;
const UPLOAD_TIMEOUT_MS = 30_000;

export interface DirectiveDeps {
  log: Logger;
  endpoint: string;
  secret: string;
  user: string;
  // Test seams. Real callers leave these undefined.
  fetchImpl?: typeof fetch;
  exit?: (code: number) => void;
  logFile?: string;
}

/** Last `maxBytes` of the file, or null when unreadable/empty. */
export async function readLogTail(path: string, maxBytes: number): Promise<string | null> {
  let fh: Awaited<ReturnType<typeof fsp.open>> | undefined;
  try {
    fh = await fsp.open(path, "r");
    const size = (await fh.stat()).size;
    if (size === 0) return null;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    return buf.toString("utf8");
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

async function uploadLogs(deps: DirectiveDeps): Promise<void> {
  const log = deps.log;
  const tail = await readLogTail(deps.logFile ?? LOG_FILE, LOG_TAIL_BYTES);
  if (tail === null) {
    log.warn("directive_upload_logs_empty", { logFile: deps.logFile ?? LOG_FILE });
    return;
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  const url = `${deps.endpoint.replace(/\/+$/, "")}/diag/logs`;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), UPLOAD_TIMEOUT_MS);
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          "X-Tokenleader-Secret": deps.secret,
          "X-Tokenleader-User": deps.user,
        },
        body: tail,
        signal: ac.signal,
      });
      if (res.ok) log.info("directive_logs_uploaded", { bytes: tail.length });
      else log.warn("directive_logs_upload_http", { status: res.status });
    } finally {
      clearTimeout(timer);
    }
  } catch (err: unknown) {
    log.warn("directive_logs_upload_failed", {
      err: String((err as Error)?.message ?? err),
    });
  }
}

/**
 * Run one server-delivered directive. Never throws; unknown verbs are
 * logged and dropped (a newer server must never crash an older daemon).
 */
export async function executeDirective(d: DaemonDirective, deps: DirectiveDeps): Promise<void> {
  const log = deps.log;
  switch (d.verb) {
    case "restart": {
      // Same contract as the post-update restart: a non-zero exit is
      // respawned under both plist generations. Logger is synchronous, so
      // exiting right after the log line is safe.
      log.info("directive_restart", { id: d.id, code: RESTART_EXIT_CODE });
      (deps.exit ?? process.exit)(RESTART_EXIT_CODE);
      return;
    }
    case "upload_logs": {
      log.info("directive_upload_logs", { id: d.id });
      await uploadLogs(deps);
      return;
    }
    default:
      log.warn("directive_unknown_verb", { id: d.id, verb: d.verb });
  }
}
