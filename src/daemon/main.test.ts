import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { makeTmpDir as mkTmpDir, makeTokenEvent } from "../test-helpers";
import type { DaemonState, FileState, TokenEvent } from "../types";
import { BUILD_SHA, BUILD_VERSION } from "./build-info";
import { writeEndpointOverride } from "./endpoint-override";
import {
  applyEndpointOverride,
  ConfigError,
  jitterUpdateIntervalMs,
  main,
  resolveConfig,
  runDaemon,
  sleep,
  versionLine,
} from "./main";
import { loadOrCreateSecret } from "./secret";
import {
  applyRescanGeneration,
  emptyState,
  loadState,
  pruneMissingFiles,
  RESCAN_GENERATION,
  saveState,
  upsertFileState,
} from "./state";
import { tick, type TickDeps } from "./tick";
import { chunk, postEvents, USER_AGENT, type TransportOpts } from "./transport";

let tmpCleanups: Array<() => Promise<void>> = [];

async function makeTmpDir(): Promise<string> {
  const { dir, cleanup } = await mkTmpDir("tokenleader-test-");
  tmpCleanups.push(cleanup);
  return dir;
}

afterEach(async () => {
  await Promise.all(tmpCleanups.map((fn) => fn()));
  tmpCleanups = [];
});

const makeEvent = (over: Partial<TokenEvent> = {}): TokenEvent =>
  makeTokenEvent({
    user: "krish",
    model: "claude-sonnet-4",
    inputTokens: 10,
    outputTokens: 20,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    ...over,
  });

// ---------------------------------------------------------------------------
// resolveConfig
// ---------------------------------------------------------------------------

describe("resolveConfig", () => {
  test("defaults are applied for optional vars", () => {
    const cfg = resolveConfig({
      TOKENLEADER_USER: "krish",
      TOKENLEADER_ENDPOINT: "https://example.com",
      HOME: "/home/x",
    } as NodeJS.ProcessEnv);
    expect(cfg.user).toBe("krish");
    expect(cfg.endpoint).toBe("https://example.com");
    expect(cfg.intervalSec).toBe(300);
    expect(cfg.batchSize).toBe(1000);
    expect(cfg.runOnce).toBe(false);
    // TOKENLEADER_TOKEN is no longer required and is undefined when absent.
    expect(cfg.token).toBeUndefined();
  });

  test("missing required env throws ConfigError listing the missing names (TOKEN no longer required)", () => {
    expect(() =>
      resolveConfig({
        TOKENLEADER_ENDPOINT: "https://x",
      } as NodeJS.ProcessEnv),
    ).toThrow(ConfigError);
    try {
      resolveConfig({} as NodeJS.ProcessEnv);
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).missing.sort()).toEqual([
        "TOKENLEADER_ENDPOINT",
        "TOKENLEADER_USER",
      ]);
    }
  });

  test("legacy TOKENLEADER_TOKEN is parsed as optional (never sent over the wire)", () => {
    const cfg = resolveConfig({
      TOKENLEADER_USER: "krish",
      TOKENLEADER_ENDPOINT: "https://x",
      TOKENLEADER_TOKEN: "legacy-shared-bearer",
    } as NodeJS.ProcessEnv);
    expect(cfg.token).toBe("legacy-shared-bearer");
  });

  test("interval and batch are clamped to safe ranges", () => {
    const cfg = resolveConfig({
      TOKENLEADER_USER: "krish",
      TOKENLEADER_ENDPOINT: "https://x",
      TOKENLEADER_INTERVAL_SEC: "1", // below floor
      TOKENLEADER_BATCH_SIZE: "999999", // above ceiling
    } as NodeJS.ProcessEnv);
    expect(cfg.intervalSec).toBe(5);
    expect(cfg.batchSize).toBe(10_000);
  });

  test("runOnce parses truthy values", () => {
    for (const v of ["1", "true", "TRUE", "yes", "on"]) {
      const cfg = resolveConfig({
        TOKENLEADER_USER: "u",
        TOKENLEADER_ENDPOINT: "e",
        TOKENLEADER_RUN_ONCE: v,
      } as NodeJS.ProcessEnv);
      expect(cfg.runOnce).toBe(true);
    }
    const cfg = resolveConfig({
      TOKENLEADER_USER: "u",
      TOKENLEADER_ENDPOINT: "e",
      TOKENLEADER_RUN_ONCE: "false",
    } as NodeJS.ProcessEnv);
    expect(cfg.runOnce).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

describe("state", () => {
  test("load on missing dir returns empty state", async () => {
    const dir = path.join(await makeTmpDir(), "missing");
    const st = await loadState(dir);
    expect(st).toEqual(emptyState());
  });

  test("save then load roundtrips", async () => {
    const dir = await makeTmpDir();
    const st: DaemonState = {
      schemaVersion: 1,
      lastFlushAt: 123,
      files: {
        "/a.jsonl": { path: "/a.jsonl", mtimeMs: 9, byteOffset: 4 },
      },
    };
    await saveState(dir, st);
    const got = await loadState(dir);
    expect(got).toEqual(st);
  });

  test("save is atomic (no partial state.json on rename)", async () => {
    const dir = await makeTmpDir();
    const st = emptyState();
    await saveState(dir, st);
    const entries = await fsp.readdir(dir);
    expect(entries).toContain("state.json");
    expect(entries).not.toContain("state.json.tmp");
  });

  test("corrupt state file falls back to empty", async () => {
    const dir = await makeTmpDir();
    await fsp.writeFile(path.join(dir, "state.json"), "{not json", "utf8");
    const got = await loadState(dir);
    expect(got).toEqual(emptyState());
  });

  test("upsertFileState replaces existing entry without mutating input", () => {
    const a: FileState = { path: "/x", mtimeMs: 1, byteOffset: 0 };
    const b: FileState = { path: "/x", mtimeMs: 2, byteOffset: 50 };
    const s0 = upsertFileState(emptyState(), a);
    const s1 = upsertFileState(s0, b);
    expect(s0.files["/x"]).toEqual(a);
    expect(s1.files["/x"]).toEqual(b);
  });

  test("applyRescanGeneration resets offsets + mtimes and stamps the generation", () => {
    const st: DaemonState = {
      schemaVersion: 1,
      lastFlushAt: 123,
      files: {
        "/a.jsonl": { path: "/a.jsonl", mtimeMs: 100, byteOffset: 4096 },
        "/b.jsonl": {
          path: "/b.jsonl",
          mtimeMs: 200,
          byteOffset: 8192,
          lastSessionTotals: {
            sessionId: "b",
            inputTokens: 1,
            outputTokens: 2,
            cachedInputTokens: 0,
            reasoningTokens: 0,
          },
        },
      },
    };
    const { state: next, changed } = applyRescanGeneration(st);
    expect(changed).toBe(true);
    expect(next.rescanGeneration).toBe(RESCAN_GENERATION);
    // Every file: offset 0 and mtime 0 (dormant files must re-qualify), and
    // stale codex session totals are dropped (no deltas vs EOF totals).
    expect(next.files["/a.jsonl"]).toEqual({ path: "/a.jsonl", mtimeMs: 0, byteOffset: 0 });
    expect(next.files["/b.jsonl"]).toEqual({ path: "/b.jsonl", mtimeMs: 0, byteOffset: 0 });
    // Input untouched.
    expect(st.files["/a.jsonl"]!.byteOffset).toBe(4096);
    expect(st.rescanGeneration).toBeUndefined();
  });

  test("applyRescanGeneration is idempotent at the current generation", () => {
    const st: DaemonState = {
      schemaVersion: 1,
      lastFlushAt: 123,
      rescanGeneration: RESCAN_GENERATION,
      files: { "/a.jsonl": { path: "/a.jsonl", mtimeMs: 100, byteOffset: 4096 } },
    };
    const { state: next, changed } = applyRescanGeneration(st);
    expect(changed).toBe(false);
    expect(next).toBe(st);
  });

  test("pruneMissingFiles drops gone paths", () => {
    const s0 = upsertFileState(emptyState(), {
      path: "/x",
      mtimeMs: 1,
      byteOffset: 0,
    });
    const s1 = upsertFileState(s0, {
      path: "/y",
      mtimeMs: 1,
      byteOffset: 0,
    });
    const pruned = pruneMissingFiles(s1, new Set(["/x"]));
    expect(Object.keys(pruned.files)).toEqual(["/x"]);
  });
});

// ---------------------------------------------------------------------------
// transport
// ---------------------------------------------------------------------------

describe("transport", () => {
  test("chunk splits into batches of given size", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 10)).toEqual([]);
    expect(chunk([1], 0)).toEqual([[1]]);
  });

  test("postEvents returns ok-no-op for empty list", async () => {
    let called = 0;
    const r = await postEvents(
      [],
      mkTransport({
        fetchImpl: ((..._a: unknown[]) => {
          called++;
          return Promise.resolve(new Response("{}"));
        }) as unknown as typeof fetch,
      }),
    );
    expect(r.ok).toBe(true);
    expect(called).toBe(0);
  });

  test("postEvents posts a single batch with X-Tokenleader-Secret + UA headers", async () => {
    let captured: Request | null = null;
    const r = await postEvents(
      [makeEvent()],
      mkTransport({
        fetchImpl: (async (input: unknown, init?: unknown) => {
          captured = new Request(input as string, init as RequestInit | undefined);
          return new Response(JSON.stringify({ inserted: 1, duplicates: 0 }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }) as unknown as typeof fetch,
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.inserted).toBe(1);
    expect(captured).not.toBeNull();
    expect(captured!.url).toBe("https://example.com/ingest");
    expect(captured!.headers.get("X-Tokenleader-Secret")).toBe("test-secret");
    expect(captured!.headers.get("Authorization")).toBeNull();
    expect(captured!.headers.get("User-Agent")).toBe(USER_AGENT);
    expect(captured!.method).toBe("POST");
  });

  test("postEvents stamps X-Tokenleader-Version + X-Tokenleader-Arch (fleet visibility)", async () => {
    let captured: Request | null = null;
    const capture = (async (input: unknown, init?: unknown) => {
      captured = new Request(input as string, init as RequestInit | undefined);
      return new Response(JSON.stringify({ inserted: 1, duplicates: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    // Explicit version/arch are forwarded verbatim.
    await postEvents(
      [makeEvent()],
      mkTransport({ fetchImpl: capture, version: "abc1234", arch: "arm64" }),
    );
    expect(captured!.headers.get("X-Tokenleader-Version")).toBe("abc1234");
    expect(captured!.headers.get("X-Tokenleader-Arch")).toBe("arm64");

    // Unset → safe defaults ("dev" / "") so old callers compile and the
    // server's "dev" guard skips them cleanly.
    captured = null;
    await postEvents([makeEvent()], mkTransport({ fetchImpl: capture }));
    expect(captured!.headers.get("X-Tokenleader-Version")).toBe("dev");
    expect(captured!.headers.get("X-Tokenleader-Arch")).toBe("");
  });

  test("postEvents treats 403 'secret mismatch' as non-retriable", async () => {
    let calls = 0;
    const r = await postEvents(
      [makeEvent()],
      mkTransport({
        sleepMs: async () => {},
        fetchImpl: (async () => {
          calls++;
          return new Response(JSON.stringify({ error: "secret mismatch for user 'krish'" }), {
            status: 403,
            headers: { "Content-Type": "application/json" },
          });
        }) as unknown as typeof fetch,
      }),
    );
    expect(r.ok).toBe(false);
    expect(calls).toBe(1);
    expect(r.error).toBe("secret_mismatch");
  });

  test("postEvents splits into multiple batches when above batchSize", async () => {
    let calls = 0;
    const events = Array.from({ length: 7 }, (_, i) => makeEvent({ messageId: `m${i}` }));
    const r = await postEvents(
      events,
      mkTransport({
        batchSize: 3,
        fetchImpl: (async () => {
          calls++;
          return new Response(JSON.stringify({ inserted: 3, duplicates: 0 }), {
            status: 200,
          });
        }) as unknown as typeof fetch,
      }),
    );
    expect(r.ok).toBe(true);
    // 7 / 3 = 3 batches
    expect(calls).toBe(3);
  });

  test("postEvents retries on 500 then succeeds", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const r = await postEvents(
      [makeEvent()],
      mkTransport({
        sleepMs: async (ms) => {
          sleeps.push(ms);
        },
        random: () => 0.5,
        fetchImpl: (async () => {
          calls++;
          if (calls < 3) return new Response("oops", { status: 503 });
          return new Response(JSON.stringify({ inserted: 1, duplicates: 0 }), {
            status: 200,
          });
        }) as unknown as typeof fetch,
      }),
    );
    expect(r.ok).toBe(true);
    expect(calls).toBe(3);
    // 2 sleeps between 3 attempts. With random=0.5, factor=1.0.
    expect(sleeps).toEqual([1000, 4000]);
  });

  test("postEvents fails fast on 4xx (non-retriable)", async () => {
    let calls = 0;
    const r = await postEvents(
      [makeEvent()],
      mkTransport({
        sleepMs: async () => {},
        fetchImpl: (async () => {
          calls++;
          return new Response("forbidden", { status: 403 });
        }) as unknown as typeof fetch,
      }),
    );
    expect(r.ok).toBe(false);
    expect(calls).toBe(1);
    expect(r.error).toBe("http_403");
  });

  test("postEvents retries 429 (rate-limit) up to 3 times", async () => {
    let calls = 0;
    const r = await postEvents(
      [makeEvent()],
      mkTransport({
        sleepMs: async () => {},
        fetchImpl: (async () => {
          calls++;
          return new Response("slow", { status: 429 });
        }) as unknown as typeof fetch,
      }),
    );
    expect(r.ok).toBe(false);
    expect(calls).toBe(3);
    expect(r.error).toBe("http_429");
  });

  test("postEvents stops after first batch failure", async () => {
    let calls = 0;
    const events = Array.from({ length: 6 }, (_, i) => makeEvent({ messageId: `m${i}` }));
    const r = await postEvents(
      events,
      mkTransport({
        batchSize: 2,
        sleepMs: async () => {},
        fetchImpl: (async () => {
          calls++;
          return new Response("nope", { status: 400 });
        }) as unknown as typeof fetch,
      }),
    );
    expect(r.ok).toBe(false);
    // Just 1 batch attempted (one call, non-retriable 400)
    expect(calls).toBe(1);
  });
});

function mkTransport(over: Partial<TransportOpts> = {}): TransportOpts {
  return {
    endpoint: "https://example.com",
    secret: "test-secret",
    sleepMs: async () => {},
    random: () => 0.5,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// tick
// ---------------------------------------------------------------------------

describe("tick", () => {
  test("posts new events from a brand-new file and advances offset", async () => {
    const dir = await makeTmpDir();
    const initial = emptyState();
    const events = [makeEvent({ messageId: "m1" })];
    const posted: TokenEvent[] = [];
    const out = await tick(
      initial,
      mkTickDeps(dir, {
        listClaudeCodeFiles: async () => ["/a.jsonl"],
        listCodexFiles: async () => [],
        statFile: async () => ({ mtimeMs: 100 }),
        parseClaudeCodeFile: async (input) => ({
          events,
          newOffset: 4096,
          seenDedupKeys: ["m1:r1"],
        }),
        postEvents: async (evs) => {
          for (const e of evs) posted.push(e);
          return { ok: true, inserted: evs.length, duplicates: 0 };
        },
      }),
    );
    expect(out.result.eventsPosted).toBe(1);
    expect(out.result.posted).toBe(true);
    expect(out.result.newFiles).toBe(1);
    expect(posted).toEqual(events);
    expect(out.state.files["/a.jsonl"]).toEqual({
      path: "/a.jsonl",
      mtimeMs: 100,
      byteOffset: 4096,
    });
    expect(out.state.lastFlushAt).toBeGreaterThan(0);
    // State persisted to disk
    const onDisk = await loadState(dir);
    expect(onDisk.files["/a.jsonl"]).toEqual(out.state.files["/a.jsonl"]!);
  });

  test("does not advance state on POST failure", async () => {
    const dir = await makeTmpDir();
    const initial = emptyState();
    const events = [makeEvent({ messageId: "m1" })];
    let parseCalls = 0;
    const out = await tick(
      initial,
      mkTickDeps(dir, {
        listClaudeCodeFiles: async () => ["/a.jsonl"],
        listCodexFiles: async () => [],
        statFile: async () => ({ mtimeMs: 100 }),
        parseClaudeCodeFile: async () => {
          parseCalls++;
          return { events, newOffset: 4096, seenDedupKeys: ["m1:r1"] };
        },
        postEvents: async () => ({
          ok: false,
          inserted: 0,
          duplicates: 0,
          error: "boom",
        }),
      }),
    );
    expect(out.result.posted).toBe(false);
    expect(out.state.files["/a.jsonl"]).toBeUndefined();
    // Disk unchanged
    const onDisk = await loadState(dir);
    expect(onDisk).toEqual(emptyState());
    expect(parseCalls).toBe(1);
  });

  test("skips files whose mtime hasn't advanced", async () => {
    const dir = await makeTmpDir();
    const prev: FileState = { path: "/a.jsonl", mtimeMs: 100, byteOffset: 4096 };
    const initial: DaemonState = {
      schemaVersion: 1,
      lastFlushAt: 0,
      files: { "/a.jsonl": prev },
    };
    let parseCalled = false;
    const out = await tick(
      initial,
      mkTickDeps(dir, {
        listClaudeCodeFiles: async () => ["/a.jsonl"],
        listCodexFiles: async () => [],
        statFile: async () => ({ mtimeMs: 100 }),
        parseClaudeCodeFile: async () => {
          parseCalled = true;
          return { events: [], newOffset: 0, seenDedupKeys: [] };
        },
        postEvents: async () => ({ ok: true, inserted: 0, duplicates: 0 }),
      }),
    );
    expect(parseCalled).toBe(false);
    expect(out.result.eligibleFiles).toBe(0);
    // mtimeMs preserved
    expect(out.state.files["/a.jsonl"]).toEqual(prev);
  });

  test("re-parses when mtime advanced, resuming at byteOffset", async () => {
    const dir = await makeTmpDir();
    const prev: FileState = { path: "/a.jsonl", mtimeMs: 100, byteOffset: 4096 };
    const initial: DaemonState = {
      schemaVersion: 1,
      lastFlushAt: 0,
      files: { "/a.jsonl": prev },
    };
    let receivedOffset = -1;
    const out = await tick(
      initial,
      mkTickDeps(dir, {
        listClaudeCodeFiles: async () => ["/a.jsonl"],
        listCodexFiles: async () => [],
        statFile: async () => ({ mtimeMs: 200 }),
        parseClaudeCodeFile: async (input) => {
          receivedOffset = input.byteOffset;
          return {
            events: [makeEvent({ messageId: "m2" })],
            newOffset: 8192,
            seenDedupKeys: ["m2:r1"],
          };
        },
        postEvents: async () => ({ ok: true, inserted: 1, duplicates: 0 }),
      }),
    );
    expect(receivedOffset).toBe(4096);
    expect(out.state.files["/a.jsonl"]).toEqual({
      path: "/a.jsonl",
      mtimeMs: 200,
      byteOffset: 8192,
    });
  });

  test("dedupes events whose key already appeared this tick", async () => {
    const dir = await makeTmpDir();
    const ev1 = makeEvent({ messageId: "shared" });
    const ev2 = makeEvent({ messageId: "shared" }); // duplicate
    const out = await tick(
      emptyState(),
      mkTickDeps(dir, {
        listClaudeCodeFiles: async () => ["/a.jsonl", "/b.jsonl"],
        listCodexFiles: async () => [],
        statFile: async () => ({ mtimeMs: 1 }),
        parseClaudeCodeFile: async (input) => ({
          events: input.path === "/a.jsonl" ? [ev1] : [ev2],
          newOffset: 100,
          seenDedupKeys: ["shared:r1"],
        }),
        postEvents: async (evs) => ({
          ok: true,
          inserted: evs.length,
          duplicates: 0,
        }),
      }),
    );
    expect(out.result.eventsPosted).toBe(1);
  });

  test("prunes files that disappear from disk", async () => {
    const dir = await makeTmpDir();
    const initial: DaemonState = {
      schemaVersion: 1,
      lastFlushAt: 0,
      files: {
        "/gone.jsonl": { path: "/gone.jsonl", mtimeMs: 1, byteOffset: 0 },
        "/keep.jsonl": { path: "/keep.jsonl", mtimeMs: 1, byteOffset: 0 },
      },
    };
    const out = await tick(
      initial,
      mkTickDeps(dir, {
        listClaudeCodeFiles: async () => ["/keep.jsonl"],
        listCodexFiles: async () => [],
        statFile: async () => ({ mtimeMs: 1 }),
        parseClaudeCodeFile: async () => ({
          events: [],
          newOffset: 0,
          seenDedupKeys: [],
        }),
        postEvents: async () => ({ ok: true, inserted: 0, duplicates: 0 }),
      }),
    );
    expect(Object.keys(out.state.files)).toEqual(["/keep.jsonl"]);
  });

  test("processes both claude_code and codex files in one tick", async () => {
    const dir = await makeTmpDir();
    const ccEv = makeEvent({ messageId: "cc1", source: "claude_code" });
    const cxEv = makeEvent({ messageId: "cx1", source: "codex" });
    const collected: TokenEvent[] = [];
    const out = await tick(
      emptyState(),
      mkTickDeps(dir, {
        listClaudeCodeFiles: async () => ["/a.jsonl"],
        listCodexFiles: async () => ["/b.jsonl"],
        statFile: async () => ({ mtimeMs: 1 }),
        parseClaudeCodeFile: async () => ({
          events: [ccEv],
          newOffset: 100,
          seenDedupKeys: ["cc1:r1"],
        }),
        parseCodexFile: async () => ({
          events: [cxEv],
          newOffset: 200,
          sessionTotals: {
            sessionId: "b",
            inputTokens: 10,
            outputTokens: 20,
            cachedInputTokens: 0,
            reasoningTokens: 0,
          },
        }),
        postEvents: async (evs) => {
          for (const e of evs) collected.push(e);
          return { ok: true, inserted: evs.length, duplicates: 0 };
        },
      }),
    );
    expect(out.result.eventsPosted).toBe(2);
    expect(collected.map((e) => e.source).sort()).toEqual(["claude_code", "codex"]);
    // codex file gets sessionTotals stored in state for next tick
    expect(out.state.files["/b.jsonl"]?.lastSessionTotals).toEqual({
      sessionId: "b",
      inputTokens: 10,
      outputTokens: 20,
      cachedInputTokens: 0,
      reasoningTokens: 0,
    });
  });

  test("processes cursor_local SQLite in one tick and persists rowid watermark", async () => {
    const dir = await makeTmpDir();
    const curEv = makeEvent({ messageId: "cur1", source: "cursor_local", model: "cursor" });
    const dbPath = "/tmp/cursor/state.vscdb";
    const out = await tick(
      emptyState(),
      mkTickDeps(dir, {
        listClaudeCodeFiles: async () => [],
        listCodexFiles: async () => [],
        getCursorStateDbPath: () => dbPath,
        isCursorLocalEnabled: () => true,
        statFile: async (path) => (path === dbPath ? { mtimeMs: 1 } : { mtimeMs: 1 }),
        parseCursorLocal: (input) => ({
          events: [curEv],
          newRowid: 42,
          seenDedupKeys: ["cur1:"],
        }),
        postEvents: async (evs) => ({
          ok: true,
          inserted: evs.length,
          duplicates: 0,
        }),
      }),
    );
    expect(out.result.eventsPosted).toBe(1);
    expect(out.state.cursorLocal).toEqual({ dbPath, lastRowid: 42 });
  });

  test("parser exception on one file does not poison others", async () => {
    const dir = await makeTmpDir();
    const out = await tick(
      emptyState(),
      mkTickDeps(dir, {
        listClaudeCodeFiles: async () => ["/bad.jsonl", "/good.jsonl"],
        listCodexFiles: async () => [],
        statFile: async () => ({ mtimeMs: 1 }),
        parseClaudeCodeFile: async (input) => {
          if (input.path === "/bad.jsonl") throw new Error("kaboom");
          return {
            events: [makeEvent({ messageId: "ok" })],
            newOffset: 100,
            seenDedupKeys: ["ok:r1"],
          };
        },
        postEvents: async (evs) => ({
          ok: true,
          inserted: evs.length,
          duplicates: 0,
        }),
      }),
    );
    expect(out.result.eventsPosted).toBe(1);
    // Bad file got no entry, good file did.
    expect(out.state.files["/bad.jsonl"]).toBeUndefined();
    expect(out.state.files["/good.jsonl"]).toBeDefined();
  });

  test("empty event collection still persists state (mtime updates)", async () => {
    const dir = await makeTmpDir();
    const out = await tick(
      emptyState(),
      mkTickDeps(dir, {
        listClaudeCodeFiles: async () => ["/a.jsonl"],
        listCodexFiles: async () => [],
        statFile: async () => ({ mtimeMs: 99 }),
        parseClaudeCodeFile: async () => ({
          events: [],
          newOffset: 256,
          seenDedupKeys: [],
        }),
        postEvents: async () => {
          throw new Error("should not be called for empty events");
        },
      }),
    );
    expect(out.result.posted).toBe(true);
    expect(out.state.files["/a.jsonl"]).toEqual({
      path: "/a.jsonl",
      mtimeMs: 99,
      byteOffset: 256,
    });
  });
});

function mkTickDeps(stateDir: string, over: Partial<TickDeps>): TickDeps {
  return {
    user: "krish",
    stateDir,
    transport: {
      endpoint: "https://example.com",
      secret: "test-secret",
    },
    listClaudeCodeFiles: async () => [],
    listCodexFiles: async () => [],
    listCursorTranscriptFiles: async () => [],
    parseClaudeCodeFile: async (input) => ({
      events: [],
      newOffset: input.byteOffset,
      seenDedupKeys: [],
    }),
    parseCodexFile: async (input) => ({
      events: [],
      newOffset: input.byteOffset,
      sessionTotals: undefined as unknown as never,
    }),
    parseCursorLocal: (input) => ({
      events: [],
      newRowid: input.lastRowid,
      seenDedupKeys: [],
    }),
    parseCursorTranscriptFile: async (input) => ({
      events: [],
      newOffset: input.byteOffset,
      seenDedupKeys: [],
    }),
    getCursorStateDbPath: () => "/tmp/cursor/state.vscdb",
    isCursorLocalEnabled: () => false,
    postEvents: async () => ({ ok: true, inserted: 0, duplicates: 0 }),
    statFile: async () => ({ mtimeMs: 1 }),
    saveState,
    now: () => 42,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// runDaemon (loop)
// ---------------------------------------------------------------------------

describe("runDaemon", () => {
  test("RUN_ONCE runs exactly one tick and returns", async () => {
    const dir = await makeTmpDir();
    let ticks = 0;
    await runDaemon(
      {
        user: "krish",
        endpoint: "https://example.com",
        intervalSec: 300,
        stateDir: dir,
        batchSize: 500,
        runOnce: true,
        updateIntervalSec: 60 * 60,
        updateDisabled: true,
      },
      {
        tickImpl: async (state) => {
          ticks++;
          return {
            state,
            result: {
              scannedFiles: 0,
              eligibleFiles: 0,
              eventsPosted: 0,
              inserted: 0,
              duplicates: 0,
              posted: true,
              newFiles: 0,
            },
          };
        },
      },
    );
    expect(ticks).toBe(1);
  });

  test("loop runs ticks until abort signal fires", async () => {
    const dir = await makeTmpDir();
    let ticks = 0;
    const ac = new AbortController();
    const p = runDaemon(
      {
        user: "krish",
        endpoint: "https://example.com",
        intervalSec: 1, // clamped at config layer; here we pass directly
        stateDir: dir,
        batchSize: 500,
        runOnce: false,
        updateIntervalSec: 60 * 60,
        updateDisabled: true,
      },
      {
        signal: ac.signal,
        tickImpl: async (state) => {
          ticks++;
          if (ticks >= 3) ac.abort();
          return {
            state,
            result: {
              scannedFiles: 0,
              eligibleFiles: 0,
              eventsPosted: 0,
              inserted: 0,
              duplicates: 0,
              posted: true,
              newFiles: 0,
            },
          };
        },
      },
    );
    await p;
    expect(ticks).toBeGreaterThanOrEqual(3);
  });

  test("boot applies the one-time rescan (offsets reset, generation stamped, saved BEFORE the first tick)", async () => {
    const dir = await makeTmpDir();
    // A pre-backfill state: real offsets, no rescanGeneration.
    await saveState(dir, {
      schemaVersion: 1,
      lastFlushAt: 123,
      files: {
        "/a.jsonl": { path: "/a.jsonl", mtimeMs: 100, byteOffset: 4096 },
        "/b.jsonl": {
          path: "/b.jsonl",
          mtimeMs: 200,
          byteOffset: 8192,
          lastSessionTotals: {
            sessionId: "b",
            inputTokens: 1,
            outputTokens: 2,
            cachedInputTokens: 0,
            reasoningTokens: 0,
          },
        },
      },
    });
    const calls: string[] = [];
    let stateSeenByTick: DaemonState | null = null;
    await runDaemon(
      {
        user: "krish",
        endpoint: "https://example.com",
        intervalSec: 300,
        stateDir: dir,
        batchSize: 500,
        runOnce: true,
        updateIntervalSec: 60 * 60,
        updateDisabled: true,
      },
      {
        saveStateImpl: async (sd, st) => {
          calls.push("save");
          await saveState(sd, st);
        },
        tickImpl: async (state) => {
          calls.push("tick");
          stateSeenByTick = state;
          return {
            state,
            result: {
              scannedFiles: 0,
              eligibleFiles: 0,
              eventsPosted: 0,
              inserted: 0,
              duplicates: 0,
              posted: true,
              newFiles: 0,
            },
          };
        },
      },
    );
    // Reset is persisted BEFORE the first tick runs.
    expect(calls).toEqual(["save", "tick"]);
    expect(stateSeenByTick!.rescanGeneration).toBe(RESCAN_GENERATION);
    expect(stateSeenByTick!.files["/a.jsonl"]).toEqual({
      path: "/a.jsonl",
      mtimeMs: 0,
      byteOffset: 0,
    });
    expect(stateSeenByTick!.files["/b.jsonl"]).toEqual({
      path: "/b.jsonl",
      mtimeMs: 0,
      byteOffset: 0,
    });
    const onDisk = await loadState(dir);
    expect(onDisk.rescanGeneration).toBe(RESCAN_GENERATION);
    expect(onDisk.files["/a.jsonl"]!.byteOffset).toBe(0);
  });

  test("boot at the current rescan generation is a no-op (second boot does nothing)", async () => {
    const dir = await makeTmpDir();
    const prior: DaemonState = {
      schemaVersion: 1,
      lastFlushAt: 123,
      rescanGeneration: RESCAN_GENERATION,
      files: { "/a.jsonl": { path: "/a.jsonl", mtimeMs: 100, byteOffset: 4096 } },
    };
    await saveState(dir, prior);
    const calls: string[] = [];
    let stateSeenByTick: DaemonState | null = null;
    await runDaemon(
      {
        user: "krish",
        endpoint: "https://example.com",
        intervalSec: 300,
        stateDir: dir,
        batchSize: 500,
        runOnce: true,
        updateIntervalSec: 60 * 60,
        updateDisabled: true,
      },
      {
        saveStateImpl: async (sd, st) => {
          calls.push("save");
          await saveState(sd, st);
        },
        tickImpl: async (state) => {
          calls.push("tick");
          stateSeenByTick = state;
          return {
            state,
            result: {
              scannedFiles: 0,
              eligibleFiles: 0,
              eventsPosted: 0,
              inserted: 0,
              duplicates: 0,
              posted: true,
              newFiles: 0,
            },
          };
        },
      },
    );
    // No boot-time save; offsets untouched.
    expect(calls).toEqual(["tick"]);
    expect(stateSeenByTick as DaemonState | null).toEqual(prior);
  });

  test("tick exception is caught; loop continues", async () => {
    const dir = await makeTmpDir();
    let ticks = 0;
    const ac = new AbortController();
    const p = runDaemon(
      {
        user: "krish",
        endpoint: "https://example.com",
        intervalSec: 1,
        stateDir: dir,
        batchSize: 500,
        runOnce: false,
        updateIntervalSec: 60 * 60,
        updateDisabled: true,
      },
      {
        signal: ac.signal,
        tickImpl: async (state) => {
          ticks++;
          if (ticks === 1) throw new Error("boom");
          if (ticks >= 2) ac.abort();
          return {
            state,
            result: {
              scannedFiles: 0,
              eligibleFiles: 0,
              eventsPosted: 0,
              inserted: 0,
              duplicates: 0,
              posted: true,
              newFiles: 0,
            },
          };
        },
      },
    );
    await p;
    expect(ticks).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// secret
// ---------------------------------------------------------------------------

describe("secret", () => {
  test("loadOrCreateSecret generates a 32-byte hex secret on first call", async () => {
    const dir = await makeTmpDir();
    const s = await loadOrCreateSecret(dir);
    expect(typeof s).toBe("string");
    expect(s).toMatch(/^[0-9a-f]{64}$/);
    const p = path.join(dir, "secret");
    const onDisk = (await fsp.readFile(p, "utf8")).trim();
    expect(onDisk).toBe(s);
  });

  test("loadOrCreateSecret is idempotent — reused on second call", async () => {
    const dir = await makeTmpDir();
    const a = await loadOrCreateSecret(dir);
    const b = await loadOrCreateSecret(dir);
    expect(a).toBe(b);
  });

  test("loadOrCreateSecret writes the secret with mode 0600", async () => {
    const dir = await makeTmpDir();
    await loadOrCreateSecret(dir);
    const st = await fsp.stat(path.join(dir, "secret"));
    // Only the bottom 9 perm bits.
    expect(st.mode & 0o777).toBe(0o600);
  });

  test("runDaemon auto-creates the secret file on first tick", async () => {
    const dir = await makeTmpDir();
    let ticks = 0;
    await runDaemon(
      {
        user: "krish",
        endpoint: "https://example.com",
        intervalSec: 300,
        stateDir: dir,
        batchSize: 500,
        runOnce: true,
        updateIntervalSec: 60 * 60,
        updateDisabled: true,
      },
      {
        tickImpl: async (state) => {
          ticks++;
          return {
            state,
            result: {
              scannedFiles: 0,
              eligibleFiles: 0,
              eventsPosted: 0,
              inserted: 0,
              duplicates: 0,
              posted: true,
              newFiles: 0,
            },
          };
        },
      },
    );
    expect(ticks).toBe(1);
    const secret = (await fsp.readFile(path.join(dir, "secret"), "utf8")).trim();
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// --version flag
// ---------------------------------------------------------------------------

describe("--version flag", () => {
  test("versionLine is '<version> <sha> darwin-<arch>'", () => {
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    expect(versionLine()).toBe(`${BUILD_VERSION} ${BUILD_SHA} darwin-${arch}`);
    // Machine-parseable: field 1 is the bare version tag (CI relies on it).
    expect(versionLine()).toMatch(/^\S+ \S+ darwin-(arm64|x64)$/);
  });

  test("main(['--version'] / ['-v']) prints the line and exits 0 with no env", async () => {
    const orig = console.log;
    const lines: string[] = [];
    console.log = (...args: unknown[]) => {
      lines.push(args.join(" "));
    };
    try {
      // No TOKENLEADER_* env is consulted: resolveConfig would throw
      // ConfigError (exit 1) if the flag didn't short-circuit first.
      expect(await main(["--version"])).toBe(0);
      expect(await main(["-v"])).toBe(0);
    } finally {
      console.log = orig;
    }
    expect(lines).toEqual([versionLine(), versionLine()]);
  });

  test("bare `main([])` with no daemon env prints usage and exits 0 (not a config error)", async () => {
    const origLog = console.log;
    const origUser = process.env.TOKENLEADER_USER;
    const lines: string[] = [];
    console.log = (...args: unknown[]) => {
      lines.push(args.join(" "));
    };
    delete process.env.TOKENLEADER_USER;
    try {
      // launchd always sets TOKENLEADER_USER; without it a bare run is a
      // human who typed `tokenleader` → friendly usage, not exit 1.
      expect(await main([])).toBe(0);
    } finally {
      console.log = origLog;
      if (origUser !== undefined) process.env.TOKENLEADER_USER = origUser;
    }
    const text = lines.join("\n");
    expect(text).toContain("Usage:");
    expect(text).toContain("link");
    expect(text).toContain("devices");
    expect(text).toContain("revoke");
  });

  test("`main(['help'])` / `--help` print usage and exit 0", async () => {
    const origLog = console.log;
    const lines: string[] = [];
    console.log = (...args: unknown[]) => lines.push(args.join(" "));
    try {
      expect(await main(["help"])).toBe(0);
      expect(await main(["--help"])).toBe(0);
    } finally {
      console.log = origLog;
    }
    expect(lines.filter((l) => l.includes("Usage:")).length).toBe(2);
  });

  test("an unknown command prints an error to stderr and exits 1", async () => {
    const origErr = console.error;
    const origLog = console.log;
    const errs: string[] = [];
    console.error = (...args: unknown[]) => errs.push(args.join(" "));
    console.log = () => {};
    try {
      expect(await main(["frobnicate"])).toBe(1);
    } finally {
      console.error = origErr;
      console.log = origLog;
    }
    expect(errs.join("\n")).toContain("unknown command: frobnicate");
  });
});

// ---------------------------------------------------------------------------
// update-interval jitter
// ---------------------------------------------------------------------------

describe("jitterUpdateIntervalMs", () => {
  test("stays within ±10% of the interval", () => {
    const ms = 3_600_000;
    expect(jitterUpdateIntervalMs(ms, () => 0)).toBe(ms * 0.9);
    expect(jitterUpdateIntervalMs(ms, () => 0.5)).toBe(ms);
    expect(jitterUpdateIntervalMs(ms, () => 0.9999999)).toBeLessThanOrEqual(ms * 1.1);
    for (let i = 0; i < 1_000; i++) {
      const v = jitterUpdateIntervalMs(ms);
      expect(v).toBeGreaterThanOrEqual(ms * 0.9);
      expect(v).toBeLessThanOrEqual(ms * 1.1);
    }
  });
});

// ---------------------------------------------------------------------------
// endpoint override precedence (boot)
// ---------------------------------------------------------------------------

describe("applyEndpointOverride", () => {
  function mkCfg(stateDir: string, endpoint = "https://env.example.com") {
    return {
      user: "krish",
      endpoint,
      intervalSec: 300,
      stateDir,
      batchSize: 500,
      runOnce: false,
      updateIntervalSec: 3600,
      updateDisabled: true,
    };
  }

  test("no override file → env endpoint unchanged", async () => {
    const dir = await makeTmpDir();
    const cfg = await applyEndpointOverride(mkCfg(dir));
    expect(cfg.endpoint).toBe("https://env.example.com");
  });

  test("override file wins over the env endpoint", async () => {
    const dir = await makeTmpDir();
    await writeEndpointOverride(dir, "https://override.example.com");
    const cfg = await applyEndpointOverride(mkCfg(dir));
    expect(cfg.endpoint).toBe("https://override.example.com");
  });

  test("override equal to env (modulo trailing slash) keeps the env value", async () => {
    const dir = await makeTmpDir();
    await writeEndpointOverride(dir, "https://env.example.com/");
    const cfg = await applyEndpointOverride(mkCfg(dir));
    expect(cfg.endpoint).toBe("https://env.example.com");
  });

  test("malformed override content loses to env", async () => {
    const dir = await makeTmpDir();
    await fsp.writeFile(path.join(dir, "endpoint"), "http://evil.example.com\n");
    const cfg = await applyEndpointOverride(mkCfg(dir));
    expect(cfg.endpoint).toBe("https://env.example.com");
  });
});

// ---------------------------------------------------------------------------
// join code plumbing
// ---------------------------------------------------------------------------

describe("join code", () => {
  test("TOKENLEADER_JOIN is parsed, trimmed, optional", () => {
    const base = {
      TOKENLEADER_USER: "u",
      TOKENLEADER_ENDPOINT: "https://x",
    };
    const cfg = resolveConfig({
      ...base,
      TOKENLEADER_JOIN: "  code-1  ",
    } as NodeJS.ProcessEnv);
    expect(cfg.join).toBe("code-1");
    expect(resolveConfig(base as NodeJS.ProcessEnv).join).toBeUndefined();
    expect(
      resolveConfig({ ...base, TOKENLEADER_JOIN: "   " } as NodeJS.ProcessEnv).join,
    ).toBeUndefined();
  });

  test("postEvents sends X-Tokenleader-Join only when join is configured", async () => {
    let captured: Request | null = null;
    const capture = (async (input: unknown, init?: unknown) => {
      captured = new Request(input as string, init as RequestInit | undefined);
      return new Response(JSON.stringify({ inserted: 1, duplicates: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await postEvents([makeEvent()], mkTransport({ fetchImpl: capture, join: "team-code-42" }));
    expect(captured!.headers.get("X-Tokenleader-Join")).toBe("team-code-42");

    captured = null;
    await postEvents([makeEvent()], mkTransport({ fetchImpl: capture }));
    expect(captured!.headers.get("X-Tokenleader-Join")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// company affiliation plumbing
// ---------------------------------------------------------------------------

describe("company affiliation", () => {
  test("TOKENLEADER_COMPANY is parsed, trimmed, optional", () => {
    const base = {
      TOKENLEADER_USER: "u",
      TOKENLEADER_ENDPOINT: "https://x",
    };
    const cfg = resolveConfig({
      ...base,
      TOKENLEADER_COMPANY: "  Anara.com  ",
    } as NodeJS.ProcessEnv);
    // Passed raw (trimmed) — the server owns normalization.
    expect(cfg.company).toBe("Anara.com");
    expect(resolveConfig(base as NodeJS.ProcessEnv).company).toBeUndefined();
    expect(
      resolveConfig({ ...base, TOKENLEADER_COMPANY: "   " } as NodeJS.ProcessEnv).company,
    ).toBeUndefined();
  });

  test("postEvents sends X-Tokenleader-Company only when company is configured", async () => {
    let captured: Request | null = null;
    const capture = (async (input: unknown, init?: unknown) => {
      captured = new Request(input as string, init as RequestInit | undefined);
      return new Response(JSON.stringify({ inserted: 1, duplicates: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await postEvents([makeEvent()], mkTransport({ fetchImpl: capture, company: "anara.com" }));
    expect(captured!.headers.get("X-Tokenleader-Company")).toBe("anara.com");

    captured = null;
    await postEvents([makeEvent()], mkTransport({ fetchImpl: capture }));
    expect(captured!.headers.get("X-Tokenleader-Company")).toBeNull();
  });

  test("runDaemon threads cfg.company into the tick transport", async () => {
    const dir = await makeTmpDir();
    const seen: Array<string | undefined> = [];
    const zero = {
      scannedFiles: 0,
      eligibleFiles: 0,
      eventsPosted: 0,
      inserted: 0,
      duplicates: 0,
      posted: true,
      newFiles: 0,
    };
    const cfg = {
      user: "krish",
      endpoint: "https://example.com",
      intervalSec: 300,
      stateDir: dir,
      batchSize: 500,
      runOnce: true,
      updateIntervalSec: 60 * 60,
      updateDisabled: true,
    };
    await runDaemon(
      { ...cfg, company: "Anara.com" },
      {
        tickImpl: async (state, deps) => {
          seen.push(deps.transport.company);
          return { state, result: zero };
        },
      },
    );
    await runDaemon(cfg, {
      tickImpl: async (state, deps) => {
        seen.push(deps.transport.company);
        return { state, result: zero };
      },
    });
    expect(seen).toEqual(["Anara.com", undefined]);
  });
});

describe("sleep", () => {
  test("resolves immediately when ms <= 0", async () => {
    const t0 = Date.now();
    await sleep(0);
    expect(Date.now() - t0).toBeLessThan(50);
  });

  test("resolves immediately when signal already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const t0 = Date.now();
    await sleep(10_000, ac.signal);
    expect(Date.now() - t0).toBeLessThan(50);
  });

  test("interrupts on abort before timeout fires", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    const t0 = Date.now();
    await sleep(5_000, ac.signal);
    expect(Date.now() - t0).toBeLessThan(500);
  });
});

// ---------------------------------------------------------------------------
// device-link plumbing
// ---------------------------------------------------------------------------

describe("device link", () => {
  test("TOKENLEADER_LINK is parsed, trimmed, optional", () => {
    const base = {
      TOKENLEADER_USER: "u",
      TOKENLEADER_ENDPOINT: "https://x",
    };
    const cfg = resolveConfig({
      ...base,
      TOKENLEADER_LINK: "  ABCD-2345  ",
    } as NodeJS.ProcessEnv);
    expect(cfg.link).toBe("ABCD-2345");
    expect(resolveConfig(base as NodeJS.ProcessEnv).link).toBeUndefined();
    expect(
      resolveConfig({ ...base, TOKENLEADER_LINK: "   " } as NodeJS.ProcessEnv).link,
    ).toBeUndefined();
  });

  test("postEvents sends X-Tokenleader-Link + X-Tokenleader-Device only when set", async () => {
    let captured: Request | null = null;
    const capture = (async (input: unknown, init?: unknown) => {
      captured = new Request(input as string, init as RequestInit | undefined);
      return new Response(JSON.stringify({ inserted: 1, duplicates: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await postEvents(
      [makeEvent()],
      mkTransport({ fetchImpl: capture, link: "ABCD-2345", device: "krishs-mbp" }),
    );
    expect(captured!.headers.get("X-Tokenleader-Link")).toBe("ABCD-2345");
    expect(captured!.headers.get("X-Tokenleader-Device")).toBe("krishs-mbp");

    captured = null;
    await postEvents([makeEvent()], mkTransport({ fetchImpl: capture }));
    expect(captured!.headers.get("X-Tokenleader-Link")).toBeNull();
    expect(captured!.headers.get("X-Tokenleader-Device")).toBeNull();
  });

  test("postEvents treats 403 'link code invalid' as non-retriable link_invalid", async () => {
    let calls = 0;
    const r = await postEvents(
      [makeEvent()],
      mkTransport({
        sleepMs: async () => {},
        fetchImpl: (async () => {
          calls++;
          return new Response(
            JSON.stringify({ error: "link code invalid or expired for user 'krish'" }),
            { status: 403, headers: { "Content-Type": "application/json" } },
          );
        }) as unknown as typeof fetch,
      }),
    );
    expect(r.ok).toBe(false);
    expect(calls).toBe(1);
    expect(r.error).toBe("link_invalid");
  });
});
