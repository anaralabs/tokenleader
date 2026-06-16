import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CURSOR_LOCAL_FALLBACK_MODEL,
  estimateContextCharLength,
  estimateCursorTokens,
  messageTypeForBubble,
  parseCursorLocal,
  resolveCursorTimestamp,
} from "./cursor-local.ts";
import {
  getCursorGlobalStorageDir,
  getCursorProjectsDir,
  getCursorStateDbPath,
  isCursorLocalEnabled,
} from "./index.ts";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeCursorDb(rows: Array<{ key: string; value: unknown }>): {
  dbPath: string;
  dir: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "cursor-local-test-"));
  tmpDirs.push(dir);
  const dbPath = join(dir, "state.vscdb");
  const db = new Database(dbPath);
  db.exec("CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
  const insert = db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES ($key, $value)");
  for (const row of rows) {
    insert.run({ $key: row.key, $value: JSON.stringify(row.value) });
  }
  db.close();
  utimesSync(dbPath, new Date(1_780_000_000_000), new Date(1_780_000_000_000));
  return { dbPath, dir };
}

describe("parseCursorLocal", () => {
  it("maps assistant bubbles with tokenCount and composer createdAt", () => {
    const composerId = "comp-1";
    const bubbleId = "bubble-1";
    const { dbPath } = makeCursorDb([
      {
        key: `composerData:${composerId}`,
        value: { createdAt: 1_700_000_000_000 },
      },
      {
        key: `bubbleId:${composerId}:${bubbleId}`,
        value: {
          type: 2,
          bubbleId,
          usageUuid: "usage-1",
          tokenCount: { inputTokens: 100, outputTokens: 25 },
          text: "assistant reply",
        },
      },
    ]);

    const r = parseCursorLocal({
      dbPath,
      lastRowid: 0,
      user: "alice",
      dbMtimeMs: 1_780_000_000_000,
    });
    expect(r.events.length).toBe(1);
    expect(r.events[0]).toEqual({
      user: "alice",
      source: "cursor_local",
      sessionId: composerId,
      messageId: bubbleId,
      requestId: "usage-1",
      timestamp: 1_700_000_000_000,
      model: CURSOR_LOCAL_FALLBACK_MODEL,
      messageType: "assistant",
      inputTokens: 100,
      outputTokens: 25,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      reasoningTokens: null,
    });
    expect(r.seenDedupKeys).toEqual(["bubble-1:usage-1"]);
    expect(r.newRowid).toBeGreaterThan(0);
  });

  it("falls back to lastUpdatedAt when createdAt is missing", () => {
    const composerId = "comp-lu";
    const { dbPath } = makeCursorDb([
      {
        key: `composerData:${composerId}`,
        value: { lastUpdatedAt: 1_780_500_000_000 },
      },
      {
        key: `bubbleId:${composerId}:b1`,
        value: {
          type: 2,
          bubbleId: "b1",
          usageUuid: "u1",
          tokenCount: { inputTokens: 1, outputTokens: 1 },
        },
      },
    ]);

    const r = parseCursorLocal({
      dbPath,
      lastRowid: 0,
      user: "alice",
      dbMtimeMs: 1_780_000_000_000,
    });
    expect(r.events[0]!.timestamp).toBe(1_780_500_000_000);
  });

  it("uses db mtime when composer metadata is missing (never 1970)", () => {
    const { dbPath } = makeCursorDb([
      {
        key: "bubbleId:comp-2:bubble-2",
        value: {
          type: 2,
          bubbleId: "bubble-2",
          usageUuid: "usage-2",
          tokenCount: { inputTokens: 0, outputTokens: 5 },
        },
      },
    ]);

    const r = parseCursorLocal({ dbPath, lastRowid: 0, user: "bob", dbMtimeMs: 1_780_000_000_000 });
    expect(r.events.length).toBe(1);
    expect(r.events[0]!.timestamp).toBe(1_780_000_000_000);
  });

  it("estimates assistant output tokens from text length when tokenCount is zero", () => {
    const composerId = "comp-2";
    const text = "abcd".repeat(10); // 40 chars → 10 tokens
    const { dbPath } = makeCursorDb([
      {
        key: `bubbleId:${composerId}:bubble-2`,
        value: {
          type: 2,
          bubbleId: "bubble-2",
          usageUuid: "usage-2",
          tokenCount: { inputTokens: 0, outputTokens: 0 },
          text,
        },
      },
    ]);

    const r = parseCursorLocal({ dbPath, lastRowid: 0, user: "bob", dbMtimeMs: 1_780_000_000_000 });
    expect(r.events.length).toBe(1);
    expect(r.events[0]!.outputTokens).toBe(10);
    expect(r.events[0]!.inputTokens).toBe(0);
  });

  it("estimates input tokens from attached code chunks", () => {
    const { dbPath } = makeCursorDb([
      {
        key: "bubbleId:comp-ctx:b1",
        value: {
          type: 2,
          bubbleId: "b1",
          usageUuid: "u-ctx",
          tokenCount: { inputTokens: 0, outputTokens: 0 },
          text: "ok",
          attachedCodeChunks: [{ lines: ["abcd", "efgh"] }],
        },
      },
    ]);

    const r = parseCursorLocal({ dbPath, lastRowid: 0, user: "bob", dbMtimeMs: 1_780_000_000_000 });
    expect(r.events[0]!.inputTokens).toBe(2);
    expect(r.events[0]!.outputTokens).toBe(1);
  });

  it("maps role=agent to assistant", () => {
    const { dbPath } = makeCursorDb([
      {
        key: "bubbleId:comp-role:b1",
        value: {
          role: "agent",
          bubbleId: "b1",
          usageUuid: "u-role",
          tokenCount: { inputTokens: 2, outputTokens: 3 },
        },
      },
    ]);

    const r = parseCursorLocal({ dbPath, lastRowid: 0, user: "bob", dbMtimeMs: 1_780_000_000_000 });
    expect(r.events[0]!.messageType).toBe("assistant");
  });

  it("emits zero-token user bubbles", () => {
    const { dbPath } = makeCursorDb([
      {
        key: "bubbleId:comp-3:user-bubble",
        value: {
          type: 1,
          bubbleId: "user-bubble",
          usageUuid: "usage-3",
          tokenCount: { inputTokens: 0, outputTokens: 0 },
          text: "hello",
        },
      },
    ]);

    const r = parseCursorLocal({
      dbPath,
      lastRowid: 0,
      user: "carol",
      dbMtimeMs: 1_780_000_000_000,
    });
    expect(r.events.length).toBe(1);
    expect(r.events[0]!.messageType).toBe("user");
    expect(r.events[0]!.inputTokens).toBe(0);
    expect(r.events[0]!.outputTokens).toBe(0);
    expect(r.events[0]!.model).toBe("");
  });

  it("respects lastRowid watermark and dedupes within a read", () => {
    const composerId = "comp-4";
    const { dbPath } = makeCursorDb([
      {
        key: `bubbleId:${composerId}:first`,
        value: {
          type: 2,
          bubbleId: "first",
          usageUuid: "u1",
          tokenCount: { inputTokens: 1, outputTokens: 1 },
        },
      },
      {
        key: `bubbleId:${composerId}:second`,
        value: {
          type: 2,
          bubbleId: "second",
          usageUuid: "u2",
          tokenCount: { inputTokens: 2, outputTokens: 2 },
        },
      },
    ]);

    const first = parseCursorLocal({
      dbPath,
      lastRowid: 0,
      user: "d",
      batchLimit: 1,
      dbMtimeMs: 1_780_000_000_000,
    });
    expect(first.events.length).toBe(1);
    expect(first.events[0]!.messageId).toBe("first");

    const second = parseCursorLocal({
      dbPath,
      lastRowid: first.newRowid,
      user: "d",
      dbMtimeMs: 1_780_000_000_000,
    });
    expect(second.events.length).toBe(1);
    expect(second.events[0]!.messageId).toBe("second");
  });

  it("returns empty result when the database is missing", () => {
    const r = parseCursorLocal({
      dbPath: join(tmpdir(), "missing-state.vscdb"),
      lastRowid: 0,
      user: "x",
    });
    expect(r.events).toEqual([]);
    expect(r.newRowid).toBe(0);
  });
});

describe("estimateCursorTokens", () => {
  it("does not estimate user messages", () => {
    expect(
      estimateCursorTokens(
        { type: 1, text: "hello world", tokenCount: { inputTokens: 0, outputTokens: 0 } },
        "user",
      ),
    ).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it("counts attached context char length", () => {
    expect(
      estimateContextCharLength({
        attachedCodeChunks: [{ lines: ["abc", "de"] }],
        attachedFileCodeChunksUris: ["file:///tmp/foo.ts"],
      }),
    ).toBe(23);
  });
});

describe("resolveCursorTimestamp", () => {
  it("never returns 0", () => {
    const ts = resolveCursorTimestamp("missing", new Map(), new Map(), 0);
    expect(ts).toBeGreaterThan(0);
  });
});

describe("messageTypeForBubble", () => {
  it("accepts agent role", () => {
    expect(messageTypeForBubble({ role: "agent" })).toBe("assistant");
  });
});

describe("cursor path helpers", () => {
  it("isCursorLocalEnabled defaults to on", () => {
    const prev = process.env.TOKENLEADER_CURSOR_LOCAL;
    delete process.env.TOKENLEADER_CURSOR_LOCAL;
    expect(isCursorLocalEnabled()).toBe(true);
    process.env.TOKENLEADER_CURSOR_LOCAL = "0";
    expect(isCursorLocalEnabled()).toBe(false);
    if (prev === undefined) delete process.env.TOKENLEADER_CURSOR_LOCAL;
    else process.env.TOKENLEADER_CURSOR_LOCAL = prev;
  });

  it("getCursorStateDbPath joins state.vscdb under globalStorage", () => {
    const prevData = process.env.CURSOR_DATA_DIR;
    const prevProjects = process.env.CURSOR_PROJECTS_DIR;
    process.env.CURSOR_DATA_DIR = "/tmp/cursor-global";
    process.env.CURSOR_PROJECTS_DIR = "/tmp/cursor-projects";
    expect(getCursorGlobalStorageDir()).toBe("/tmp/cursor-global");
    expect(getCursorStateDbPath()).toBe("/tmp/cursor-global/state.vscdb");
    expect(getCursorProjectsDir()).toBe("/tmp/cursor-projects");
    if (prevData === undefined) delete process.env.CURSOR_DATA_DIR;
    else process.env.CURSOR_DATA_DIR = prevData;
    if (prevProjects === undefined) delete process.env.CURSOR_PROJECTS_DIR;
    else process.env.CURSOR_PROJECTS_DIR = prevProjects;
  });
});
