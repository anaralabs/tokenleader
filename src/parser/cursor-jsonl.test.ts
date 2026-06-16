import { afterEach, describe, expect, it } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  estimateTranscriptTextLength,
  parseCursorTranscriptFile,
  stableTranscriptMessageId,
} from "./cursor-jsonl.ts";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTranscriptFile(lines: string[]): { path: string; sessionId: string; mtimeMs: number } {
  const root = mkdtempSync(join(tmpdir(), "cursor-jsonl-test-"));
  tmpDirs.push(root);
  const sessionId = "sess-abc-123";
  const dir = join(root, "agent-transcripts", sessionId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  writeFileSync(path, lines.map((l) => `${l}\n`).join(""));
  const mtimeMs = 1_780_100_000_000;
  return { path, sessionId, mtimeMs };
}

describe("parseCursorTranscriptFile", () => {
  it("parses user and assistant transcript lines with file mtime timestamps", async () => {
    const { path, sessionId, mtimeMs } = makeTranscriptFile([
      JSON.stringify({
        role: "user",
        message: { content: [{ type: "text", text: "hello there" }] },
      }),
      JSON.stringify({
        role: "assistant",
        message: { content: [{ type: "text", text: "abcd".repeat(8) }] },
      }),
    ]);

    const r = await parseCursorTranscriptFile({
      path,
      byteOffset: 0,
      user: "alice",
      fileMtimeMs: mtimeMs,
    });

    expect(r.events.length).toBe(2);
    expect(r.events[0]!.messageType).toBe("user");
    expect(r.events[0]!.timestamp).toBe(mtimeMs);
    expect(r.events[0]!.sessionId).toBe(sessionId);
    expect(r.events[0]!.messageId).toBe(stableTranscriptMessageId(path, 1));
    expect(r.events[0]!.inputTokens).toBe(0);
    expect(r.events[0]!.outputTokens).toBe(0);
    expect(r.events[1]!.messageType).toBe("assistant");
    expect(r.events[1]!.inputTokens).toBe(0);
    expect(r.events[1]!.outputTokens).toBe(Math.ceil(32 / 4));
    expect(r.nextLineIndex).toBe(2);
    expect(r.seenDedupKeys).toEqual([
      `${stableTranscriptMessageId(path, 1)}:`,
      `${stableTranscriptMessageId(path, 2)}:`,
    ]);
  });

  it("drops assistant lines with no estimable output tokens", async () => {
    const { path, mtimeMs } = makeTranscriptFile([
      JSON.stringify({
        role: "assistant",
        message: { content: [{ type: "tool_use", text: "x" }] },
      }),
      JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "hi" }] } }),
    ]);

    const r = await parseCursorTranscriptFile({
      path,
      byteOffset: 0,
      user: "carol",
      fileMtimeMs: mtimeMs,
    });

    expect(r.events.length).toBe(1);
    expect(r.events[0]!.messageType).toBe("user");
    expect(r.nextLineIndex).toBe(2);
  });

  it("keeps stable line ids across incremental reads", async () => {
    const { path, mtimeMs } = makeTranscriptFile([
      JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "one" }] } }),
      JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "two" }] } }),
    ]);

    const first = await parseCursorTranscriptFile({
      path,
      byteOffset: 0,
      user: "bob",
      fileMtimeMs: mtimeMs,
    });
    expect(first.events.length).toBe(2);
    expect(first.nextLineIndex).toBe(2);

    appendFileSync(
      path,
      `${JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "three" }] } })}\n`,
    );

    const second = await parseCursorTranscriptFile({
      path,
      byteOffset: first.newOffset,
      user: "bob",
      fileMtimeMs: mtimeMs,
      startingLineIndex: first.nextLineIndex,
    });
    expect(second.events.length).toBe(1);
    expect(second.events[0]!.messageId).toBe(stableTranscriptMessageId(path, 3));
    expect(second.nextLineIndex).toBe(3);
  });
});

describe("estimateTranscriptTextLength", () => {
  it("sums only text parts", () => {
    const len = estimateTranscriptTextLength({
      role: "assistant",
      message: {
        content: [
          { type: "text", text: "hello" },
          { type: "tool_use", text: "ignored" },
        ],
      },
    });
    expect(len).toBe(5);
  });
});
