import { mkdtempSync, promises as fsp, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type BuildOptions } from "./server/main.ts";
import type { TokenEvent } from "./types.ts";

/** Canonical TokenEvent fixture; test files layer their own defaults on top. */
export function makeTokenEvent(overrides: Partial<TokenEvent> = {}): TokenEvent {
  return {
    user: "alice",
    source: "claude_code",
    sessionId: "s1",
    messageId: "m1",
    requestId: "r1",
    timestamp: 1_700_000_000_000,
    model: "claude-sonnet-4-5",
    messageType: "assistant",
    inputTokens: 1000,
    outputTokens: 500,
    cacheCreationTokens: 100,
    cacheReadTokens: 200,
    reasoningTokens: null,
    ...overrides,
  };
}

/** Parse a Response body as JSON, typed. */
export async function jsonOf<T = any>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** Fresh temp dir + cleanup (sync flavor). */
export function makeTmpDirSync(prefix: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Fresh temp dir + cleanup (async flavor, daemon tests). */
export async function makeTmpDir(
  prefix: string,
): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await fsp.mkdtemp(join(tmpdir(), prefix));
  return { dir, cleanup: () => fsp.rm(dir, { recursive: true, force: true }) };
}

/** buildApp on a fresh tmp DB; cleanup stops the app, closes the store, removes the dir. */
export function createTestApp(opts: Partial<Omit<BuildOptions, "dbPath">> = {}) {
  const { dir, cleanup: rmDir } = makeTmpDirSync("tokenleader-test-");
  const built = buildApp({
    dbPath: join(dir, "tl.sqlite"),
    schedulePricingRefresh: false,
    // Tests assert read-after-write freshness: live entries are uncached
    // (TTL 0) so every GET recomputes. Frozen (past-window) entries still
    // cache, and test ingests carry past timestamps, so the backfill
    // invalidation path stays exercised. Cache-behavior tests override.
    statsCacheTtlMs: 0,
    ...opts,
  });
  return {
    ...built,
    cleanup: async () => {
      try {
        await built.stop();
      } catch {}
      try {
        built.store.close();
      } catch {}
      rmDir();
    },
  };
}
