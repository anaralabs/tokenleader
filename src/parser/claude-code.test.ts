import { describe, expect, it } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseClaudeCodeFile } from "./claude-code.ts";
import { listClaudeCodeFiles } from "./index.ts";

async function makeTempJsonl(lines: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cc-parser-test-"));
  const file = join(dir, "session.jsonl");
  await writeFile(file, lines.map((l) => l + "\n").join(""));
  return file;
}

const baseAssistant = {
  type: "assistant",
  sessionId: "sess-abc",
  requestId: "req-1",
  timestamp: "2026-05-01T00:00:00.000Z",
  message: {
    id: "msg-001",
    model: "claude-opus-4-7",
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 50,
    },
  },
};

describe("parseClaudeCodeFile (synthetic)", () => {
  it("emits one event per assistant line with full usage fields", async () => {
    const path = await makeTempJsonl([
      JSON.stringify({ type: "user", message: { content: "hi" } }),
      JSON.stringify(baseAssistant),
      JSON.stringify({
        ...baseAssistant,
        message: { ...baseAssistant.message, id: "msg-002" },
        requestId: "req-2",
      }),
    ]);

    const r = await parseClaudeCodeFile({ path, byteOffset: 0, user: "k" });
    expect(r.events.length).toBe(2);
    expect(r.events[0]!.source).toBe("claude_code");
    expect(r.events[0]!.user).toBe("k");
    expect(r.events[0]!.model).toBe("claude-opus-4-7");
    expect(r.events[0]!.inputTokens).toBe(10);
    expect(r.events[0]!.outputTokens).toBe(20);
    expect(r.events[0]!.cacheCreationTokens).toBe(100);
    expect(r.events[0]!.cacheReadTokens).toBe(50);
    expect(r.events[0]!.reasoningTokens).toBeNull();
    expect(r.events[0]!.requestId).toBe("req-1");
    expect(r.events[0]!.sessionId).toBe("sess-abc");
    expect(r.events[0]!.messageId).toBe("msg-001");
    expect(r.seenDedupKeys).toEqual(["msg-001:req-1", "msg-002:req-2"]);
  });

  it("stamps a custom source (claude_cowork) on every event when asked", async () => {
    const path = await makeTempJsonl([
      JSON.stringify({ type: "user", uuid: "u-1", message: { content: "hi" } }),
      JSON.stringify(baseAssistant),
    ]);
    const r = await parseClaudeCodeFile({
      path,
      byteOffset: 0,
      user: "k",
      source: "claude_cowork",
    });
    expect(r.events.length).toBe(2);
    expect(r.events.every((e) => e.source === "claude_cowork")).toBe(true);
    // Token math is unchanged — same parser, different tag only.
    const asst = r.events.find((e) => e.messageType === "assistant")!;
    expect(asst.inputTokens).toBe(10);
    expect(asst.outputTokens).toBe(20);
  });

  it("defaults source to claude_code when none is passed", async () => {
    const path = await makeTempJsonl([JSON.stringify(baseAssistant)]);
    const r = await parseClaudeCodeFile({ path, byteOffset: 0, user: "k" });
    expect(r.events[0]!.source).toBe("claude_code");
  });

  it("dedupes within a single read", async () => {
    const path = await makeTempJsonl([
      JSON.stringify(baseAssistant),
      JSON.stringify(baseAssistant), // same id+request
    ]);
    const r = await parseClaudeCodeFile({ path, byteOffset: 0, user: "k" });
    expect(r.events.length).toBe(1);
  });

  it("skips assistant lines lacking message.id", async () => {
    const path = await makeTempJsonl([
      JSON.stringify({
        ...baseAssistant,
        message: { ...baseAssistant.message, id: undefined },
      }),
    ]);
    const r = await parseClaudeCodeFile({ path, byteOffset: 0, user: "k" });
    expect(r.events.length).toBe(0);
  });

  it("advances offset only to last full line and re-reads partial", async () => {
    const lineA = JSON.stringify(baseAssistant);
    const lineB = JSON.stringify({
      ...baseAssistant,
      message: { ...baseAssistant.message, id: "msg-partial" },
    });
    // No trailing newline on second line — simulates a still-being-written tail.
    const dir = await mkdtemp(join(tmpdir(), "cc-parser-test-"));
    const path = join(dir, "session.jsonl");
    await writeFile(path, lineA + "\n" + lineB);

    const r1 = await parseClaudeCodeFile({ path, byteOffset: 0, user: "k" });
    expect(r1.events.length).toBe(1);
    expect(r1.events[0]!.messageId).toBe("msg-001");
    // offset must point at the start of the partial trailing line.
    expect(r1.newOffset).toBe(Buffer.byteLength(lineA + "\n", "utf8"));

    // Now finish the line and re-parse from the saved offset.
    await writeFile(path, lineA + "\n" + lineB + "\n");
    const r2 = await parseClaudeCodeFile({ path, byteOffset: r1.newOffset, user: "k" });
    expect(r2.events.length).toBe(1);
    expect(r2.events[0]!.messageId).toBe("msg-partial");
  });

  it("emits user-message events alongside assistant events with zero tokens", async () => {
    // Real user lines carry NO message.id (only API responses do) — they're
    // keyed on the line uuid. Pins the bug where the msg.id guard silently
    // dropped every Claude Code user prompt (prod had 809k assistant rows,
    // zero user rows).
    const userLine = {
      type: "user",
      uuid: "uuid-user-001",
      sessionId: "sess-mixed",
      timestamp: "2026-05-01T00:00:00.000Z",
      message: { role: "user", content: "hi please write me a function" },
    };
    const assistantLine = {
      ...baseAssistant,
      sessionId: "sess-mixed",
      message: { ...baseAssistant.message, id: "asst-msg-001" },
      requestId: "req-mix",
    };
    const path = await makeTempJsonl([JSON.stringify(userLine), JSON.stringify(assistantLine)]);

    const r = await parseClaudeCodeFile({ path, byteOffset: 0, user: "k" });
    expect(r.events.length).toBe(2);

    const userEv = r.events.find((e) => e.messageType === "user");
    const asstEv = r.events.find((e) => e.messageType === "assistant");
    expect(userEv).toBeDefined();
    expect(asstEv).toBeDefined();

    // User-message event: zero in every token bucket; messageId = line uuid.
    expect(userEv!.messageId).toBe("uuid-user-001");
    expect(userEv!.requestId).toBeNull();
    expect(userEv!.inputTokens).toBe(0);
    expect(userEv!.outputTokens).toBe(0);
    expect(userEv!.cacheCreationTokens).toBe(0);
    expect(userEv!.cacheReadTokens).toBe(0);
    expect(userEv!.reasoningTokens).toBeNull();
    expect(userEv!.model).toBe(""); // user prompts have no model attribution
    expect(userEv!.sessionId).toBe("sess-mixed");
    expect(userEv!.source).toBe("claude_code");

    // Assistant event keeps its usage numbers as before.
    expect(asstEv!.messageId).toBe("asst-msg-001");
    expect(asstEv!.inputTokens).toBe(10);
    expect(asstEv!.outputTokens).toBe(20);

    expect(new Set(r.seenDedupKeys).size).toBe(r.seenDedupKeys.length);
  });

  it("skips user lines that lack a uuid", async () => {
    const path = await makeTempJsonl([
      JSON.stringify({
        type: "user",
        sessionId: "sess-1",
        timestamp: "2026-05-01T00:00:00.000Z",
        message: { content: "hello" },
      }),
    ]);
    const r = await parseClaudeCodeFile({ path, byteOffset: 0, user: "k" });
    expect(r.events.length).toBe(0);
  });

  it("does not count tool results, meta lines, or sidechain prompts as user messages", async () => {
    // All three arrive as type='user' in the logs; counting them would make
    // "user messages" mostly tool outputs (a real file: 628 of 726 user
    // lines were tool_results).
    const path = await makeTempJsonl([
      JSON.stringify({
        type: "user",
        uuid: "uuid-tool-1",
        sessionId: "s",
        timestamp: "2026-05-01T00:00:00.000Z",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
        },
      }),
      JSON.stringify({
        type: "user",
        uuid: "uuid-meta-1",
        isMeta: true,
        sessionId: "s",
        timestamp: "2026-05-01T00:00:01.000Z",
        message: { role: "user", content: "meta line" },
      }),
      JSON.stringify({
        type: "user",
        uuid: "uuid-side-1",
        isSidechain: true,
        sessionId: "s",
        timestamp: "2026-05-01T00:00:02.000Z",
        message: { role: "user", content: "subagent prompt" },
      }),
      JSON.stringify({
        type: "user",
        uuid: "uuid-real-1",
        sessionId: "s",
        timestamp: "2026-05-01T00:00:03.000Z",
        message: { role: "user", content: "a real human prompt" },
      }),
    ]);
    const r = await parseClaudeCodeFile({ path, byteOffset: 0, user: "k" });
    expect(r.events.length).toBe(1);
    expect(r.events[0]!.messageId).toBe("uuid-real-1");
    expect(r.events[0]!.messageType).toBe("user");
  });

  it("skips zero-usage assistant lines", async () => {
    const path = await makeTempJsonl([
      JSON.stringify({
        ...baseAssistant,
        message: {
          ...baseAssistant.message,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }),
    ]);
    const r = await parseClaudeCodeFile({ path, byteOffset: 0, user: "k" });
    expect(r.events.length).toBe(0);
  });
});

describe("parseClaudeCodeFile (real local data)", () => {
  it("parses assistant events from a real session file", async () => {
    const all = await listClaudeCodeFiles();
    if (all.length === 0) {
      console.warn("no claude-code session files on this machine — skipping");
      return;
    }
    // Pick the largest file we can find: most likely to have many events.
    let best: { path: string; size: number } | null = null;
    for (const p of all.slice(0, 200)) {
      const sz = Bun.file(p).size;
      if (!best || sz > best.size) best = { path: p, size: sz };
    }
    if (!best) return;

    const r = await parseClaudeCodeFile({ path: best.path, byteOffset: 0, user: "k" });
    if (r.events.length === 0) {
      console.warn(`no assistant events in ${best.path}`);
      return;
    }

    expect(r.events.length).toBeGreaterThan(0);
    for (const ev of r.events) {
      expect(ev.source).toBe("claude_code");
      expect(typeof ev.sessionId).toBe("string");
      expect(ev.sessionId.length).toBeGreaterThan(0);
      expect(typeof ev.messageId).toBe("string");
      expect(ev.messageId.length).toBeGreaterThan(0);
      expect(typeof ev.timestamp).toBe("number");
      expect(Number.isFinite(ev.timestamp)).toBe(true);
      expect(ev.reasoningTokens).toBeNull();
      if (ev.messageType === "assistant") {
        expect(ev.model.length).toBeGreaterThan(0);
      } else {
        // User prompts: no model, zero tokens in every bucket.
        expect(ev.model).toBe("");
        expect(ev.inputTokens + ev.outputTokens + ev.cacheCreationTokens + ev.cacheReadTokens).toBe(
          0,
        );
      }
    }
    // Dedup keys should be unique within the file.
    const keys = new Set(r.seenDedupKeys);
    expect(keys.size).toBe(r.seenDedupKeys.length);
    // Offset should advance.
    expect(r.newOffset).toBeGreaterThan(0);
    const nUser = r.events.filter((e) => e.messageType === "user").length;
    const nAsst = r.events.length - nUser;
    console.log(`[cc real] file=${best.path} size=${best.size} user=${nUser} assistant=${nAsst}`);
  });
});
