/**
 * Bounded, newline-aligned line reads for the JSONL session parsers.
 *
 * Both the Claude Code and Codex parsers used to do
 * `file.slice(byteOffset).text()`, materializing the entire unread remainder
 * of a session file as one string. A multi-GB session log (a runaway Codex
 * rollout, say) then exceeds the JS engine's max string length, which the
 * compiled daemon hits as a native abort (EXC_BREAKPOINT / SIGTRAP) that
 * bypasses the parsers' try/catch — so a single oversized file wedges the
 * daemon into a permanent crash loop and no usage ever gets posted.
 *
 * `readNewlineLines` reads the remainder in capped byte windows and yields one
 * decoded line at a time, never holding more than `MAX_READ_BYTES` of bytes
 * (plus one line) at once, while still consuming the whole file in a single
 * pass so the tick loop's mtime gating keeps working.
 */

/** ASCII line feed. A 0x0A byte never occurs inside a multi-byte UTF-8
 *  sequence (continuation/lead bytes are all >= 0x80), so scanning raw bytes
 *  for it splits lines without ever cutting a character. */
const NEWLINE = 0x0a;

const decoder = new TextDecoder();

/**
 * Largest record (line content, excluding the newline) we materialize as one
 * string. Kept well under the ~512 MiB string-length ceiling where the compiled
 * daemon was observed to abort. A record longer than this can't be held safely,
 * so it is discarded (see below) rather than risking the abort; multi-MB
 * tool-result records stay comfortably within it.
 */
export const MAX_READ_BYTES = 64 * 1024 * 1024;

/**
 * One unit of progress from `readNewlineLines`. A discriminated union so an
 * oversized-record drop is an explicit, visible state — never silently folded
 * into a plain offset advance. Callers always adopt `newOffset`.
 *
 *  - `line`:     a decoded JSONL line (no trailing newline) to parse.
 *  - `advance`:  bytes consumed (blank lines / window boundary), nothing to do.
 *  - `oversize`: a record longer than `maxBytes` was dropped (its `bytes` were
 *                skipped). The caller should surface this — it is data loss.
 */
export type LineRead =
  | { kind: "line"; text: string; newOffset: number }
  | { kind: "advance"; newOffset: number }
  | { kind: "oversize"; bytes: number; newOffset: number };

/**
 * Yield the lines of `file` starting at `byteOffset`, reading at most
 * `maxBytes` of raw bytes per window. The caller advances its saved offset to
 * the latest `newOffset` (including for `advance`/`oversize` reads, so progress
 * is never lost).
 *
 * A trailing line with no terminator (a file still being written) is left
 * unconsumed for the next read. A single record longer than `maxBytes` can't be
 * held as one string, so it is discarded through its terminating newline — its
 * bytes are skipped a window at a time (guaranteeing forward progress), its
 * suffix is *not* emitted as a record, and an `oversize` read reports the drop.
 */
export async function* readNewlineLines(
  file: ReturnType<typeof Bun.file>,
  byteOffset: number,
  maxBytes: number = MAX_READ_BYTES,
): AsyncGenerator<LineRead> {
  if (!(maxBytes > 0)) {
    throw new RangeError(`maxBytes must be a positive number, got ${maxBytes}`);
  }

  const totalSize = file.size;
  let offset = byteOffset;
  // Byte offset where an over-window record began, or -1 when not discarding.
  let discardStart = -1;

  while (offset < totalSize) {
    // Read one byte past `maxBytes` so a record whose content is exactly
    // `maxBytes` long still has its terminating newline inside the window
    // (records up to `maxBytes` are kept; only longer ones are discarded).
    const end = Math.min(totalSize, offset + maxBytes + 1);
    const bytes = await file.slice(offset, end).bytes();

    const lastNewline = bytes.lastIndexOf(NEWLINE);
    if (lastNewline === -1) {
      // No line boundary in this window. At EOF it's an unterminated tail —
      // leave it (and do not commit an offset inside it) so the whole record
      // is re-read once it's complete. Otherwise a single record is longer than
      // the window: skip its bytes without committing and stay in discard mode
      // so its continuation isn't mistaken for a new line. The offset only
      // moves forward once that record's terminating newline is found below.
      if (end >= totalSize) return;
      if (discardStart === -1) discardStart = offset;
      offset = end;
      continue;
    }

    let start = 0;
    let nl = bytes.indexOf(NEWLINE);
    while (nl !== -1) {
      const lineEnd = offset + nl + 1;
      if (discardStart !== -1) {
        // This newline closes the oversized record we were discarding. Report
        // the drop so the caller can surface the lost usage.
        yield { kind: "oversize", bytes: lineEnd - discardStart, newOffset: lineEnd };
        discardStart = -1;
      } else if (nl > start) {
        // Decode exactly one line's bytes — a clean range between newlines, so
        // it is always whole UTF-8.
        yield { kind: "line", text: decoder.decode(bytes.subarray(start, nl)), newOffset: lineEnd };
      }
      start = nl + 1;
      if (start > lastNewline) break;
      nl = bytes.indexOf(NEWLINE, start);
    }

    // Advance past the last complete line; any partial tail is re-read next
    // window. The marker syncs the offset even if the final lines were blank.
    offset += lastNewline + 1;
    yield { kind: "advance", newOffset: offset };
  }
}
