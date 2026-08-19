import { describe, expect, it } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCodexFile, type SessionTotals } from "./codex.ts";
import { listCodexFiles } from "./index.ts";

async function makeTempJsonl(name: string, lines: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "codex-parser-test-"));
  const file = join(dir, name);
  await writeFile(file, lines.map((l) => l + "\n").join(""));
  return file;
}

interface UsageNums {
  input: number;
  output: number;
  cached: number;
  cacheWrite?: number;
  reasoning: number;
}

function usageJson(u: UsageNums) {
  return {
    input_tokens: u.input,
    cached_input_tokens: u.cached,
    ...(u.cacheWrite !== undefined ? { cache_write_input_tokens: u.cacheWrite } : {}),
    output_tokens: u.output,
    reasoning_output_tokens: u.reasoning,
    total_tokens: u.input + u.output,
  };
}

/**
 * Real Codex shape: `last_token_usage` is the PER-TURN usage and
 * `total_token_usage` the session-cumulative one (each total delta equals
 * that event's last). Pass `total: null` / `last: null` to model partial
 * formats.
 */
function tokenCountEvent(ts: string, last: UsageNums | null, total?: UsageNums | null) {
  return {
    timestamp: ts,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        ...(last ? { last_token_usage: usageJson(last) } : {}),
        ...(total ? { total_token_usage: usageJson(total) } : {}),
      },
    },
  };
}

const turnContextLine = (model: string, ts = "2026-05-01T00:00:00.000Z") => ({
  timestamp: ts,
  type: "turn_context",
  payload: { turn_id: "tc-1", model },
});

const sessionMetaLine = (ts: string, forkedFromId?: string) => ({
  timestamp: ts,
  type: "session_meta",
  payload: {
    id: "child-thread-id",
    ...(forkedFromId ? { forked_from_id: forkedFromId, thread_source: "subagent" } : {}),
  },
});

describe("parseCodexFile (synthetic)", () => {
  it("emits per-turn last_token_usage directly with model from turn_context", async () => {
    const path = await makeTempJsonl("rollout-A.jsonl", [
      JSON.stringify(turnContextLine("gpt-5.5")),
      JSON.stringify(
        tokenCountEvent(
          "2026-05-01T00:00:01.000Z",
          { input: 100, output: 50, cached: 10, reasoning: 5 },
          { input: 100, output: 50, cached: 10, reasoning: 5 },
        ),
      ),
      JSON.stringify(
        tokenCountEvent(
          "2026-05-01T00:00:02.000Z",
          { input: 150, output: 80, cached: 20, reasoning: 7 },
          { input: 250, output: 130, cached: 30, reasoning: 12 },
        ),
      ),
    ]);
    const r = await parseCodexFile({ path, byteOffset: 0, user: "k" });
    expect(r.events.length).toBe(2);
    expect(r.events[0]!.source).toBe("codex");
    expect(r.events[0]!.model).toBe("gpt-5.5");
    expect(r.events[0]!.requestId).toBeNull();
    expect(r.events[0]!.cacheCreationTokens).toBe(0);
    // Codex `input_tokens` is INCLUSIVE of `cached_input_tokens`. The
    // parser subtracts cached so downstream pricing can apply a uniform
    // formula across providers.
    //   Turn 1: input=100, cached=10 → non-cached = 90, cacheRead = 10.
    expect(r.events[0]!.inputTokens).toBe(90);
    expect(r.events[0]!.outputTokens).toBe(50);
    expect(r.events[0]!.cacheReadTokens).toBe(10);
    expect(r.events[0]!.reasoningTokens).toBe(5);
    // Turn 2 is emitted from its own per-turn numbers, NOT a delta of them.
    expect(r.events[1]!.inputTokens).toBe(130);
    expect(r.events[1]!.outputTokens).toBe(80);
    expect(r.events[1]!.cacheReadTokens).toBe(20);
    expect(r.events[1]!.reasoningTokens).toBe(7);
    // sessionTotals still tracks CUMULATIVE raw counts (used for delta
    // bookkeeping across reads); they are not the emitted event values.
    expect(r.sessionTotals.inputTokens).toBe(250);
    expect(r.sessionTotals.outputTokens).toBe(130);
    expect(r.sessionTotals.cachedInputTokens).toBe(30);

    // sessionId derived from filename
    expect(r.events[0]!.sessionId).toBe("rollout-A");
    // messageIds unique within file
    const ids = new Set(r.events.map((e) => e.messageId));
    expect(ids.size).toBe(r.events.length);
  });

  it("splits input into plain / cache-read / cache-write when Codex reports cache_write_input_tokens", async () => {
    // openai/codex `parses_cache_write_token_usage`: input 100 = cached 40 + write 60.
    const path = await makeTempJsonl("rollout-CW.jsonl", [
      JSON.stringify(turnContextLine("gpt-5.6")),
      JSON.stringify(
        tokenCountEvent("2026-05-01T00:00:01.000Z", {
          input: 100,
          output: 10,
          cached: 40,
          cacheWrite: 60,
          reasoning: 5,
        }),
      ),
      JSON.stringify(
        tokenCountEvent("2026-05-01T00:00:02.000Z", {
          input: 200,
          output: 10,
          cached: 120,
          cacheWrite: 30,
          reasoning: 0,
        }),
      ),
      // ChatGPT-backend rollouts carry the field as a literal 0: nothing changes.
      JSON.stringify(
        tokenCountEvent("2026-05-01T00:00:03.000Z", {
          input: 100,
          output: 1,
          cached: 70,
          cacheWrite: 0,
          reasoning: 0,
        }),
      ),
      // Overflowing write is clamped so the three buckets never exceed input.
      JSON.stringify(
        tokenCountEvent("2026-05-01T00:00:04.000Z", {
          input: 100,
          output: 1,
          cached: 70,
          cacheWrite: 50,
          reasoning: 0,
        }),
      ),
    ]);
    const r = await parseCodexFile({ path, byteOffset: 0, user: "k" });
    expect(r.events.length).toBe(4);
    expect(r.events[0]!.inputTokens).toBe(0);
    expect(r.events[0]!.cacheReadTokens).toBe(40);
    expect(r.events[0]!.cacheCreationTokens).toBe(60);
    expect(r.events[1]!.inputTokens).toBe(50);
    expect(r.events[1]!.cacheReadTokens).toBe(120);
    expect(r.events[1]!.cacheCreationTokens).toBe(30);
    expect(r.events[2]!.inputTokens).toBe(30);
    expect(r.events[2]!.cacheReadTokens).toBe(70);
    expect(r.events[2]!.cacheCreationTokens).toBe(0);
    expect(r.events[3]!.inputTokens).toBe(0);
    expect(r.events[3]!.cacheReadTokens).toBe(70);
    expect(r.events[3]!.cacheCreationTokens).toBe(30);
  });

  it("preserves totals bookkeeping across reads via prevSessionTotals", async () => {
    const path = await makeTempJsonl("rollout-B.jsonl", [
      JSON.stringify(turnContextLine("gpt-5.5")),
      JSON.stringify(
        tokenCountEvent(
          "2026-05-01T00:00:01.000Z",
          { input: 100, output: 50, cached: 10, reasoning: 5 },
          { input: 100, output: 50, cached: 10, reasoning: 5 },
        ),
      ),
    ]);
    const r1 = await parseCodexFile({ path, byteOffset: 0, user: "k" });
    expect(r1.events.length).toBe(1);
    // input=100, cached=10 → non-cached = 90.
    expect(r1.events[0]!.inputTokens).toBe(90);
    expect(r1.events[0]!.cacheReadTokens).toBe(10);

    // Append a total-only second event: the fallback delta path must pick
    // up from the persisted cumulative totals of the first read.
    const second =
      JSON.stringify(
        tokenCountEvent("2026-05-01T00:00:02.000Z", null, {
          input: 250,
          output: 130,
          cached: 30,
          reasoning: 12,
        }),
      ) + "\n";
    const existing = await Bun.file(path).text();
    await writeFile(path, existing + second);

    const r2 = await parseCodexFile({
      path,
      byteOffset: r1.newOffset,
      user: "k",
      prevSessionTotals: r1.sessionTotals,
    });
    expect(r2.events.length).toBe(1);
    // raw input delta=150, cached delta=20 → non-cached = 130.
    expect(r2.events[0]!.inputTokens).toBe(130);
    expect(r2.events[0]!.cacheReadTokens).toBe(20);
    expect(r2.events[0]!.outputTokens).toBe(80);
  });

  it("falls back to cumulative deltas of total_token_usage when last is missing", async () => {
    const path = await makeTempJsonl("rollout-C.jsonl", [
      JSON.stringify(turnContextLine("gpt-5.5")),
      JSON.stringify(
        tokenCountEvent("2026-05-01T00:00:01.000Z", null, {
          input: 10,
          output: 5,
          cached: 0,
          reasoning: 0,
        }),
      ),
      JSON.stringify(
        tokenCountEvent("2026-05-01T00:00:02.000Z", null, {
          input: 25,
          output: 12,
          cached: 0,
          reasoning: 0,
        }),
      ),
    ]);
    const r = await parseCodexFile({ path, byteOffset: 0, user: "k" });
    expect(r.events.length).toBe(2);
    expect(r.events[0]!.inputTokens).toBe(10);
    expect(r.events[1]!.inputTokens).toBe(15);
    expect(r.events[1]!.outputTokens).toBe(7);
  });

  it("handles cumulative reset (negative delta) by treating values as new baseline", async () => {
    const path = await makeTempJsonl("rollout-D.jsonl", [
      JSON.stringify(turnContextLine("gpt-5.5")),
      JSON.stringify(
        tokenCountEvent("2026-05-01T00:00:01.000Z", null, {
          input: 100,
          output: 50,
          cached: 0,
          reasoning: 0,
        }),
      ),
      // Server reports lower totals — simulates reset.
      JSON.stringify(
        tokenCountEvent("2026-05-01T00:00:02.000Z", null, {
          input: 30,
          output: 15,
          cached: 0,
          reasoning: 0,
        }),
      ),
    ]);
    const r = await parseCodexFile({ path, byteOffset: 0, user: "k" });
    expect(r.events.length).toBe(2);
    expect(r.events[1]!.inputTokens).toBe(30);
  });

  it("regression: real-shape stream sums to the sum of per-turn last values", async () => {
    // Mirrors a real gpt-5.6-sol rollout: three token_count events whose
    // total deltas equal each event's last, per-turn input hovering around
    // the context size, output fluctuating. The old parser treated `last`
    // as cumulative and swallowed ~half the volume (only the turn-over-turn
    // difference survived when no bucket regressed).
    const turns = [
      { input: 26561, output: 696, cached: 9984, reasoning: 516 },
      { input: 27281, output: 111, cached: 26368, reasoning: 0 },
      { input: 26773, output: 468, cached: 26368, reasoning: 287 },
    ];
    let cum = { input: 0, output: 0, cached: 0, reasoning: 0 };
    const lines = [JSON.stringify(turnContextLine("gpt-5.6-sol"))];
    for (const [i, t] of turns.entries()) {
      cum = {
        input: cum.input + t.input,
        output: cum.output + t.output,
        cached: cum.cached + t.cached,
        reasoning: cum.reasoning + t.reasoning,
      };
      lines.push(JSON.stringify(tokenCountEvent(`2026-07-11T16:34:4${i}.302Z`, t, cum)));
    }
    const path = await makeTempJsonl("rollout-real-shape.jsonl", lines);
    const r = await parseCodexFile({ path, byteOffset: 0, user: "k" });
    expect(r.events.length).toBe(3);
    const sum = r.events.reduce(
      (a, e) => ({
        input: a.input + e.inputTokens + e.cacheReadTokens,
        output: a.output + e.outputTokens,
        cached: a.cached + e.cacheReadTokens,
      }),
      { input: 0, output: 0, cached: 0 },
    );
    expect(sum.input).toBe(26561 + 27281 + 26773);
    expect(sum.output).toBe(696 + 111 + 468);
    expect(sum.cached).toBe(9984 + 26368 + 26368);
  });

  it("uses fallback model when no turn_context yet", async () => {
    const path = await makeTempJsonl("rollout-E.jsonl", [
      JSON.stringify(
        tokenCountEvent("2026-05-01T00:00:01.000Z", {
          input: 10,
          output: 5,
          cached: 0,
          reasoning: 0,
        }),
      ),
    ]);
    const r = await parseCodexFile({ path, byteOffset: 0, user: "k" });
    expect(r.events[0]!.model).toBe("gpt-5");
  });

  it("normalizes Codex cached-as-subset-of-input: input=10 cached=4 → input=6 cacheRead=4", async () => {
    // OpenAI's accounting reports `cached_input_tokens` as a subset of
    // `input_tokens`, not a disjoint bucket (ccusage confirms this in
    // apps/codex/src/token-utils.ts: `nonCached = input - cached`).
    // The parser MUST subtract at the boundary so downstream cost math
    // doesn't double-bill the cached portion (at both full-input and
    // cache-read rates).
    const path = await makeTempJsonl("rollout-cached-subset.jsonl", [
      JSON.stringify(turnContextLine("gpt-5.5")),
      JSON.stringify(
        tokenCountEvent("2026-05-01T00:00:01.000Z", {
          input: 10,
          output: 0,
          cached: 4,
          reasoning: 0,
        }),
      ),
    ]);
    const r = await parseCodexFile({ path, byteOffset: 0, user: "k" });
    expect(r.events.length).toBe(1);
    expect(r.events[0]!.inputTokens).toBe(6);
    expect(r.events[0]!.cacheReadTokens).toBe(4);
    expect(r.events[0]!.cacheCreationTokens).toBe(0);
  });

  it("clamps cached at input when cached delta would exceed input delta", async () => {
    // Defensive: if a buggy/out-of-order log reports cached > input on a
    // delta, we clamp rather than emit negative inputTokens. The bucket
    // becomes cacheRead-only for that event.
    const path = await makeTempJsonl("rollout-cached-overflow.jsonl", [
      JSON.stringify(turnContextLine("gpt-5.5")),
      JSON.stringify(
        tokenCountEvent("2026-05-01T00:00:01.000Z", {
          input: 10,
          output: 5,
          cached: 20,
          reasoning: 0,
        }),
      ),
    ]);
    const r = await parseCodexFile({ path, byteOffset: 0, user: "k" });
    expect(r.events.length).toBe(1);
    expect(r.events[0]!.inputTokens).toBe(0);
    expect(r.events[0]!.cacheReadTokens).toBe(10);
  });

  it("emits user-message events from response_item role=user with zero tokens", async () => {
    // Codex prepends a `response_item` line for the user's prompt. The parser
    // should emit a zero-token user event with messageType='user' and a
    // synthesized messageId that includes ':user:' so it can't collide
    // with the assistant-event id at the same timestamp.
    const path = await makeTempJsonl("rollout-user.jsonl", [
      JSON.stringify(turnContextLine("gpt-5.5")),
      JSON.stringify({
        timestamp: "2026-05-01T00:00:00.500Z",
        type: "response_item",
        payload: { role: "user", content: "please optimize this loop" },
      }),
      JSON.stringify(
        tokenCountEvent("2026-05-01T00:00:01.000Z", {
          input: 100,
          output: 50,
          cached: 10,
          reasoning: 5,
        }),
      ),
    ]);
    const r = await parseCodexFile({ path, byteOffset: 0, user: "k" });
    expect(r.events.length).toBe(2);

    const userEv = r.events.find((e) => e.messageType === "user");
    const asstEv = r.events.find((e) => e.messageType === "assistant");
    expect(userEv).toBeDefined();
    expect(asstEv).toBeDefined();

    expect(userEv!.source).toBe("codex");
    expect(userEv!.inputTokens).toBe(0);
    expect(userEv!.outputTokens).toBe(0);
    expect(userEv!.cacheReadTokens).toBe(0);
    expect(userEv!.cacheCreationTokens).toBe(0);
    expect(userEv!.reasoningTokens).toBeNull();
    expect(userEv!.sessionId).toBe("rollout-user");
    expect(userEv!.messageId).toContain(":user:");
    // The assistant event preserves its full delta accounting.
    expect(asstEv!.inputTokens).toBe(90);
    expect(asstEv!.outputTokens).toBe(50);
    // IDs must be globally unique within the read.
    const ids = new Set(r.events.map((e) => e.messageId));
    expect(ids.size).toBe(r.events.length);
  });

  it("ignores response_item lines without role=user", async () => {
    // Defensive: the response_item path should be tight — assistant/tool
    // role values must not get tagged as user events.
    const path = await makeTempJsonl("rollout-asst-item.jsonl", [
      JSON.stringify(turnContextLine("gpt-5.5")),
      JSON.stringify({
        timestamp: "2026-05-01T00:00:00.500Z",
        type: "response_item",
        payload: { role: "assistant", content: "ok" },
      }),
    ]);
    const r = await parseCodexFile({ path, byteOffset: 0, user: "k" });
    expect(r.events.length).toBe(0);
  });

  it("disambiguates same-timestamp events in messageId", async () => {
    const ts = "2026-05-01T00:00:01.000Z";
    const path = await makeTempJsonl("rollout-F.jsonl", [
      JSON.stringify(turnContextLine("gpt-5.5")),
      JSON.stringify(tokenCountEvent(ts, { input: 10, output: 5, cached: 0, reasoning: 0 })),
      JSON.stringify(tokenCountEvent(ts, { input: 20, output: 10, cached: 0, reasoning: 0 })),
    ]);
    const r = await parseCodexFile({ path, byteOffset: 0, user: "k" });
    const ids = new Set(r.events.map((e) => e.messageId));
    expect(ids.size).toBe(r.events.length);
  });
});

describe("fork-seed suppression", () => {
  // Codex seeds forked/subagent rollouts with a verbatim copy of the
  // parent's history — token_count lines included — re-stamped to the spawn
  // instant. Structure mirrors a real 0.144.1 subagent file: session_meta
  // with forked_from_id, a millisecond-packed seed burst, then real events
  // seconds later.
  const T0 = "2026-07-11T18:37:42.852Z";
  const seedTs = (ms: number) => `2026-07-11T18:37:42.${String(852 + ms).padStart(3, "0")}Z`;

  it("drops the seeded ledger copy and bills only the child's own turns", async () => {
    const path = await makeTempJsonl("rollout-fork.jsonl", [
      JSON.stringify(sessionMetaLine(T0, "parent-thread-id")),
      JSON.stringify(turnContextLine("gpt-5.6-sol", T0)),
      // copied prompt from the parent's history
      JSON.stringify({ timestamp: T0, type: "response_item", payload: { role: "user" } }),
      // seed burst: parent's ledger replayed within milliseconds
      JSON.stringify(
        tokenCountEvent(
          seedTs(0),
          { input: 24860, output: 697, cached: 9984, reasoning: 516 },
          { input: 24860, output: 697, cached: 9984, reasoning: 516 },
        ),
      ),
      JSON.stringify(
        tokenCountEvent(
          seedTs(1),
          { input: 25581, output: 194, cached: 24320, reasoning: 0 },
          { input: 50441, output: 891, cached: 34304, reasoning: 516 },
        ),
      ),
      // the child's first REAL turn, a model round-trip later
      JSON.stringify(
        tokenCountEvent(
          "2026-07-11T18:37:51.100Z",
          { input: 51000, output: 300, cached: 50000, reasoning: 100 },
          { input: 101441, output: 1191, cached: 84304, reasoning: 616 },
        ),
      ),
      JSON.stringify(
        tokenCountEvent(
          "2026-07-11T18:38:02.000Z",
          { input: 52000, output: 400, cached: 51000, reasoning: 0 },
          { input: 153441, output: 1591, cached: 135304, reasoning: 616 },
        ),
      ),
    ]);
    const r = await parseCodexFile({ path, byteOffset: 0, user: "k" });
    // Only the two real turns are billed; seed + copied prompt vanish.
    expect(r.events.length).toBe(2);
    expect(r.events.every((e) => e.messageType === "assistant")).toBe(true);
    expect(r.events[0]!.inputTokens + r.events[0]!.cacheReadTokens).toBe(51000);
    expect(r.events[1]!.inputTokens + r.events[1]!.cacheReadTokens).toBe(52000);
    // Bookkeeping continued through the seed: totals reflect the final ledger.
    expect(r.sessionTotals.inputTokens).toBe(153441);
  });

  it("a copied parent session_meta inside the seed (depth ≥2) keeps suppression armed", async () => {
    const path = await makeTempJsonl("rollout-fork-depth2.jsonl", [
      JSON.stringify(sessionMetaLine(T0, "parent-thread-id")),
      JSON.stringify(sessionMetaLine(seedTs(0), "grandparent-thread-id")),
      JSON.stringify(turnContextLine("gpt-5.6-sol", seedTs(1))),
      JSON.stringify(
        tokenCountEvent(
          seedTs(2),
          { input: 100, output: 10, cached: 0, reasoning: 0 },
          { input: 100, output: 10, cached: 0, reasoning: 0 },
        ),
      ),
      JSON.stringify(
        tokenCountEvent(
          "2026-07-11T18:37:50.000Z",
          { input: 200, output: 20, cached: 0, reasoning: 0 },
          { input: 300, output: 30, cached: 0, reasoning: 0 },
        ),
      ),
    ]);
    const r = await parseCodexFile({ path, byteOffset: 0, user: "k" });
    expect(r.events.length).toBe(1);
    expect(r.events[0]!.inputTokens).toBe(200);
  });

  it("a session_meta without forked_from_id never suppresses anything", async () => {
    const path = await makeTempJsonl("rollout-root.jsonl", [
      JSON.stringify(sessionMetaLine(T0)),
      JSON.stringify(turnContextLine("gpt-5.6-sol", T0)),
      // same-millisecond burst as a root session (e.g. batched flush) — still real
      JSON.stringify(
        tokenCountEvent(
          seedTs(0),
          { input: 100, output: 10, cached: 0, reasoning: 0 },
          { input: 100, output: 10, cached: 0, reasoning: 0 },
        ),
      ),
      JSON.stringify(
        tokenCountEvent(
          seedTs(1),
          { input: 150, output: 15, cached: 0, reasoning: 0 },
          { input: 250, output: 25, cached: 0, reasoning: 0 },
        ),
      ),
    ]);
    const r = await parseCodexFile({ path, byteOffset: 0, user: "k" });
    expect(r.events.length).toBe(2);
    expect(r.events[0]!.inputTokens).toBe(100);
  });
});

describe("parseCodexFile (real local data)", () => {
  it("parses token_count events from a real session file", async () => {
    const all = await listCodexFiles();
    if (all.length === 0) {
      console.warn("no codex session files on this machine — skipping");
      return;
    }
    // Walk recent files until one yields events. ccusage docs confirm the
    // format; skip silently only if every candidate is empty.
    const recent = all
      .map((p) => ({ p, mt: Bun.file(p).lastModified }))
      .sort((a, b) => b.mt - a.mt)
      .slice(0, 80);

    let parsed: { path: string; events: number; sample: string } | null = null;
    let prev: SessionTotals | undefined;
    for (const { p } of recent) {
      const r = await parseCodexFile({
        path: p,
        byteOffset: 0,
        user: "k",
        prevSessionTotals: prev,
      });
      if (r.events.length > 0) {
        parsed = { path: p, events: r.events.length, sample: r.events[0]!.model };
        // sanity assertions on the first hit
        for (const ev of r.events) {
          expect(ev.source).toBe("codex");
          expect(ev.requestId).toBeNull();
          expect(ev.cacheCreationTokens).toBe(0);
          expect(typeof ev.sessionId).toBe("string");
          expect(ev.sessionId.length).toBeGreaterThan(0);
          expect(typeof ev.model).toBe("string");
          expect(ev.model.length).toBeGreaterThan(0);
          expect(typeof ev.timestamp).toBe("number");
          expect(Number.isFinite(ev.timestamp)).toBe(true);
        }
        const ids = new Set(r.events.map((e) => e.messageId));
        expect(ids.size).toBe(r.events.length);
        expect(r.newOffset).toBeGreaterThan(0);
        expect(r.sessionTotals.sessionId).toBe(r.events[0]!.sessionId);
        break;
      }
    }

    if (!parsed) {
      console.warn(
        `scanned ${recent.length} recent codex files; none had token_count events with usage`,
      );
      return;
    }
    console.log(
      `[codex real] file=${parsed.path} events=${parsed.events} firstModel=${parsed.sample}`,
    );
  });
});

// The mislabelling bug: `turn_context` is written once per TURN, but the
// daemon reads incrementally every 300s. A read that opens after the
// turn_context line saw usage with no model in its window and billed it to
// LEGACY_FALLBACK_MODEL — a model nobody ran. On prod this swallowed 41.5%
// of all Codex volume (71.6% in its worst month) and priced it at a quarter
// of the real rate, because the placeholder is cheaper than the models it
// was standing in for.
describe("model carries across incremental reads", () => {
  async function writeSession(lines: unknown[]): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "codex-model-"));
    const path = join(dir, "rollout-2026-08-01T00-00-00-model-carry.jsonl");
    await writeFile(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    return path;
  }

  it("a second read that opens mid-turn keeps the model instead of falling back", async () => {
    const path = await writeSession([
      turnContextLine("gpt-5.6-sol", "2026-08-01T00:00:00.000Z"),
      tokenCountEvent(
        "2026-08-01T00:00:01.000Z",
        { input: 100, cached: 40, output: 10, reasoning: 0 },
        { input: 100, cached: 40, output: 10, reasoning: 0 },
      ),
    ]);
    const first = await parseCodexFile({ path, byteOffset: 0, user: "u" });
    expect(first.events[0]?.model).toBe("gpt-5.6-sol");
    expect(first.lastModel).toBe("gpt-5.6-sol");

    // The next turn's usage lands with NO turn_context in the window --
    // exactly what a 300s incremental read sees mid-conversation.
    await writeFile(
      path,
      `${[
        turnContextLine("gpt-5.6-sol", "2026-08-01T00:00:00.000Z"),
        tokenCountEvent(
          "2026-08-01T00:00:01.000Z",
          { input: 100, cached: 40, output: 10, reasoning: 0 },
          { input: 100, cached: 40, output: 10, reasoning: 0 },
        ),
        tokenCountEvent(
          "2026-08-01T00:05:00.000Z",
          { input: 200, cached: 80, output: 20, reasoning: 0 },
          { input: 300, cached: 120, output: 30, reasoning: 0 },
        ),
      ]
        .map((l) => JSON.stringify(l))
        .join("\n")}\n`,
    );

    const second = await parseCodexFile({
      path,
      byteOffset: first.newOffset,
      user: "u",
      prevSessionTotals: first.sessionTotals,
      prevModel: first.lastModel,
    });
    expect(second.events.length).toBe(1);
    expect(second.events[0]?.model).toBe("gpt-5.6-sol");
  });

  it("without the carried model the same read mislabels (regression guard)", async () => {
    const path = await writeSession([
      tokenCountEvent(
        "2026-08-01T00:05:00.000Z",
        { input: 200, cached: 80, output: 20, reasoning: 0 },
        { input: 200, cached: 80, output: 20, reasoning: 0 },
      ),
    ]);
    // byteOffset > 0 with no prevModel is the pre-fix situation.
    const r = await parseCodexFile({ path, byteOffset: 0, user: "u" });
    expect(r.events[0]?.model).toBe("gpt-5");
    expect(r.lastModel).toBeUndefined();
  });

  it("a read with no turn_context does not erase the carried model", async () => {
    const path = await writeSession([
      tokenCountEvent(
        "2026-08-01T00:05:00.000Z",
        { input: 10, cached: 0, output: 1, reasoning: 0 },
        { input: 10, cached: 0, output: 1, reasoning: 0 },
      ),
    ]);
    const r = await parseCodexFile({ path, byteOffset: 0, user: "u", prevModel: "gpt-5.5" });
    // byteOffset 0 starts blind on purpose: a byte-0 read sees the file's
    // own first turn_context, so trusting a stale carried model there would
    // mislabel a session that legitimately changed models.
    expect(r.events[0]?.model).toBe("gpt-5");
  });

  it("a later turn_context overrides the carried model", async () => {
    const path = await writeSession([
      turnContextLine("gpt-5.5", "2026-08-01T00:00:00.000Z"),
      tokenCountEvent(
        "2026-08-01T00:00:01.000Z",
        { input: 100, cached: 0, output: 10, reasoning: 0 },
        { input: 100, cached: 0, output: 10, reasoning: 0 },
      ),
    ]);
    const r = await parseCodexFile({ path, byteOffset: 0, user: "u", prevModel: "gpt-5.6-sol" });
    expect(r.events[0]?.model).toBe("gpt-5.5");
    expect(r.lastModel).toBe("gpt-5.5");
  });
});

// v0.6.4 carried the model across incremental reads, but a byte-0 read still
// started blind — and some rollouts write token_count / user-prompt lines
// BEFORE their first `turn_context`, so that prefix kept billing to
// LEGACY_FALLBACK_MODEL. The answer is sitting further down the same file, so
// a bounded look-ahead recovers it (see LOOKAHEAD_MAX_BYTES in codex.ts).
describe("byte-0 model look-ahead", () => {
  const userLine = (ts: string) => ({
    timestamp: ts,
    type: "response_item",
    payload: { role: "user", content: "please optimize this loop" },
  });

  it("labels usage that precedes the first turn_context with that turn's model", async () => {
    const path = await makeTempJsonl("rollout-lookahead.jsonl", [
      JSON.stringify(
        tokenCountEvent(
          "2026-08-01T00:00:01.000Z",
          { input: 100, output: 10, cached: 40, reasoning: 0 },
          { input: 100, output: 10, cached: 40, reasoning: 0 },
        ),
      ),
      JSON.stringify(turnContextLine("gpt-5.6-sol", "2026-08-01T00:00:02.000Z")),
      JSON.stringify(
        tokenCountEvent(
          "2026-08-01T00:00:03.000Z",
          { input: 200, output: 20, cached: 80, reasoning: 0 },
          { input: 300, output: 30, cached: 120, reasoning: 0 },
        ),
      ),
    ]);
    const r = await parseCodexFile({ path, byteOffset: 0, user: "k" });
    expect(r.events.map((e) => e.model)).toEqual(["gpt-5.6-sol", "gpt-5.6-sol"]);
    expect(r.lastModel).toBe("gpt-5.6-sol");
  });

  it("gives up cleanly when the look-ahead is disabled", async () => {
    // The peek is the only thing labelling this prefix (test 1 above is the
    // pre-v0.6.5 regression guard — it fails against the v0.6.4 parser).
    // Turning it off must fall back rather than misbehave.
    const path = await makeTempJsonl("rollout-lookahead-prefix.jsonl", [
      JSON.stringify(
        tokenCountEvent(
          "2026-08-01T00:00:01.000Z",
          { input: 100, output: 10, cached: 40, reasoning: 0 },
          { input: 100, output: 10, cached: 40, reasoning: 0 },
        ),
      ),
      JSON.stringify(turnContextLine("gpt-5.6-sol", "2026-08-01T00:00:02.000Z")),
    ]);
    const r = await parseCodexFile({ path, byteOffset: 0, user: "k", lookAheadMaxBytes: 0 });
    expect(r.events[0]!.model).toBe("gpt-5");
  });

  it("gives up at the cap instead of scanning an unbounded file", async () => {
    const path = await makeTempJsonl("rollout-lookahead-cap.jsonl", [
      JSON.stringify(
        tokenCountEvent(
          "2026-08-01T00:00:01.000Z",
          { input: 100, output: 10, cached: 0, reasoning: 0 },
          { input: 100, output: 10, cached: 0, reasoning: 0 },
        ),
      ),
      // Padding that pushes the turn_context past the (tiny) cap below.
      JSON.stringify({
        timestamp: "2026-08-01T00:00:01.500Z",
        type: "response_item",
        payload: { role: "assistant", content: "x".repeat(2000) },
      }),
      JSON.stringify(turnContextLine("gpt-5.6-sol", "2026-08-01T00:00:02.000Z")),
    ]);
    const capped = await parseCodexFile({ path, byteOffset: 0, user: "k", lookAheadMaxBytes: 512 });
    // Past the cap we keep the fallback rather than invent a model...
    expect(capped.events[0]!.model).toBe("gpt-5");
    // ...and the turn_context still lands normally once the parse reaches it.
    expect(capped.lastModel).toBe("gpt-5.6-sol");
    const uncapped = await parseCodexFile({ path, byteOffset: 0, user: "k" });
    expect(uncapped.events[0]!.model).toBe("gpt-5.6-sol");
  });

  it("takes the FIRST turn_context, not a later one that switched models", async () => {
    // The peek stops at the first turn_context on purpose: it is the turn the
    // prefix actually belongs to, and it is what keeps the scan bounded. A
    // refactor that dropped the early return would relabel the prefix with
    // whatever model the session switched to hours later, and would scan to
    // the cap on every byte-0 read.
    const path = await makeTempJsonl("rollout-lookahead-first-wins.jsonl", [
      JSON.stringify(
        tokenCountEvent(
          "2026-08-01T00:00:01.000Z",
          { input: 100, output: 10, cached: 0, reasoning: 0 },
          { input: 100, output: 10, cached: 0, reasoning: 0 },
        ),
      ),
      JSON.stringify(turnContextLine("gpt-5.5", "2026-08-01T00:00:02.000Z")),
      JSON.stringify(
        tokenCountEvent(
          "2026-08-01T00:00:03.000Z",
          { input: 20, output: 5, cached: 0, reasoning: 0 },
          { input: 120, output: 15, cached: 0, reasoning: 0 },
        ),
      ),
      JSON.stringify(turnContextLine("gpt-5.6-sol", "2026-08-01T00:00:04.000Z")),
      JSON.stringify(
        tokenCountEvent(
          "2026-08-01T00:00:05.000Z",
          { input: 30, output: 7, cached: 0, reasoning: 0 },
          { input: 150, output: 22, cached: 0, reasoning: 0 },
        ),
      ),
    ]);
    const r = await parseCodexFile({ path, byteOffset: 0, user: "k" });
    expect(r.events.map((e) => e.model)).toEqual(["gpt-5.5", "gpt-5.5", "gpt-5.6-sol"]);
    expect(r.lastModel).toBe("gpt-5.6-sol");
  });

  it("never invents a model for a rollout with no turn_context anywhere", async () => {
    // Pre-2025-11 rollouts predate the field. Relabelling them would be
    // fabrication, so they keep the fallback and report no lastModel.
    const path = await makeTempJsonl("rollout-lookahead-legacy.jsonl", [
      JSON.stringify(userLine("2026-08-01T00:00:00.000Z")),
      JSON.stringify(
        tokenCountEvent(
          "2026-08-01T00:00:01.000Z",
          { input: 100, output: 10, cached: 0, reasoning: 0 },
          { input: 100, output: 10, cached: 0, reasoning: 0 },
        ),
      ),
    ]);
    const r = await parseCodexFile({ path, byteOffset: 0, user: "k" });
    expect(r.events.map((e) => e.model)).toEqual(["gpt-5", "gpt-5"]);
    expect(r.lastModel).toBeUndefined();
  });

  it("labels a user prompt written before the first turn_context", async () => {
    // The dominant real-world shape: Codex logs the prompt, then opens the
    // turn. Measured locally, this alone mislabelled 1,118 user rows across
    // 1,085 of 1,149 rollouts.
    const path = await makeTempJsonl("rollout-lookahead-user.jsonl", [
      JSON.stringify(userLine("2026-08-01T00:00:00.000Z")),
      JSON.stringify(turnContextLine("gpt-5.6-sol", "2026-08-01T00:00:01.000Z")),
      JSON.stringify(
        tokenCountEvent(
          "2026-08-01T00:00:02.000Z",
          { input: 100, output: 10, cached: 0, reasoning: 0 },
          { input: 100, output: 10, cached: 0, reasoning: 0 },
        ),
      ),
    ]);
    const r = await parseCodexFile({ path, byteOffset: 0, user: "k" });
    const userEv = r.events.find((e) => e.messageType === "user");
    expect(userEv!.model).toBe("gpt-5.6-sol");
  });

  it("does not disturb fork-seed suppression, ids, offsets or totals", async () => {
    const T0 = "2026-07-11T18:37:42.852Z";
    const path = await makeTempJsonl("rollout-lookahead-fork.jsonl", [
      JSON.stringify(sessionMetaLine(T0, "parent-thread-id")),
      // Seed burst copied from the parent, with no turn_context of its own.
      JSON.stringify({ timestamp: T0, type: "response_item", payload: { role: "user" } }),
      JSON.stringify(
        tokenCountEvent(
          "2026-07-11T18:37:42.853Z",
          { input: 24860, output: 697, cached: 9984, reasoning: 516 },
          { input: 24860, output: 697, cached: 9984, reasoning: 516 },
        ),
      ),
      // The child's own first turn, a model round-trip later — still ahead of
      // the file's first turn_context.
      JSON.stringify(
        tokenCountEvent(
          "2026-07-11T18:37:51.100Z",
          { input: 51000, output: 300, cached: 50000, reasoning: 100 },
          { input: 75860, output: 997, cached: 59984, reasoning: 616 },
        ),
      ),
      JSON.stringify(turnContextLine("gpt-5.6-sol", "2026-07-11T18:37:52.000Z")),
    ]);
    const withPeek = await parseCodexFile({ path, byteOffset: 0, user: "k" });
    const noPeek = await parseCodexFile({ path, byteOffset: 0, user: "k", lookAheadMaxBytes: 0 });

    // The seed is still dropped: only the child's own turn is billed.
    expect(withPeek.events.length).toBe(1);
    expect(withPeek.events[0]!.inputTokens + withPeek.events[0]!.cacheReadTokens).toBe(51000);
    // The peek changes the label and nothing else.
    expect(withPeek.events[0]!.model).toBe("gpt-5.6-sol");
    expect(noPeek.events[0]!.model).toBe("gpt-5");
    expect(withPeek.events.map((e) => e.messageId)).toEqual(noPeek.events.map((e) => e.messageId));
    expect(withPeek.newOffset).toBe(noPeek.newOffset);
    expect(withPeek.sessionTotals).toEqual(noPeek.sessionTotals);
  });

  it("only ever replaces the fallback on real local rollouts", async () => {
    const all = await listCodexFiles();
    if (all.length === 0) {
      console.warn("no codex session files on this machine — skipping");
      return;
    }
    // Bounded so the suite stays fast: newest files first, up to ~150 MB.
    const BUDGET_BYTES = 150 * 1024 * 1024;
    const recent = all
      .map((p) => ({ p, mt: Bun.file(p).lastModified, size: Bun.file(p).size }))
      .sort((a, b) => b.mt - a.mt);

    let scanned = 0;
    let bytes = 0;
    let relabelled = 0;
    for (const { p, size } of recent) {
      if (bytes + size > BUDGET_BYTES) continue;
      bytes += size;
      scanned++;
      const withPeek = await parseCodexFile({ path: p, byteOffset: 0, user: "k" });
      if (withPeek.events.length === 0) continue;
      const noPeek = await parseCodexFile({
        path: p,
        byteOffset: 0,
        user: "k",
        lookAheadMaxBytes: 0,
      });
      // A live Codex session can append between the two parses, which would
      // make them legitimately disagree. Compare only files that held still.
      if (Bun.file(p).size !== size) continue;
      // Same events, same ids, same ledger — only labels may move.
      expect(withPeek.events.map((e) => e.messageId)).toEqual(
        noPeek.events.map((e) => e.messageId),
      );
      expect(withPeek.newOffset).toBe(noPeek.newOffset);
      expect(withPeek.sessionTotals).toEqual(noPeek.sessionTotals);
      for (let i = 0; i < withPeek.events.length; i++) {
        const a = withPeek.events[i]!;
        const b = noPeek.events[i]!;
        if (a.model === b.model) continue;
        // The peek may only turn the fallback into a real model, never the
        // other way round and never one real model into another.
        expect(b.model).toBe("gpt-5");
        expect(a.model).not.toBe("gpt-5");
        relabelled++;
      }
    }
    console.log(`[codex look-ahead] files=${scanned} relabelledEvents=${relabelled}`);
  });
});

// FileState is persisted, so the cumulative ledger has to carry cache-write
// the same way it carries cache-read. Inert while Codex reports the field as
// a literal 0 — this keeps the total-only path honest the day it doesn't.
describe("cumulative cache-write on the totals path", () => {
  it("deltas cache-write out of the cumulative totals when last_token_usage is absent", async () => {
    const path = await makeTempJsonl("rollout-cw-total.jsonl", [
      JSON.stringify(turnContextLine("gpt-5.5")),
      JSON.stringify(
        tokenCountEvent("2026-05-01T00:00:01.000Z", null, {
          input: 100,
          output: 10,
          cached: 40,
          cacheWrite: 60,
          reasoning: 0,
        }),
      ),
      JSON.stringify(
        tokenCountEvent("2026-05-01T00:00:02.000Z", null, {
          input: 250,
          output: 30,
          cached: 100,
          cacheWrite: 100,
          reasoning: 0,
        }),
      ),
    ]);
    const r = await parseCodexFile({ path, byteOffset: 0, user: "k" });
    expect(r.events.length).toBe(2);
    // input is inclusive of both cached and written portions.
    expect(r.events[0]).toMatchObject({
      inputTokens: 0,
      cacheReadTokens: 40,
      cacheCreationTokens: 60,
    });
    expect(r.events[1]).toMatchObject({
      inputTokens: 50,
      cacheReadTokens: 60,
      cacheCreationTokens: 40,
    });
    expect(r.sessionTotals.cacheWriteInputTokens).toBe(100);
  });

  it("carries the cumulative cache-write across reads via prevSessionTotals", async () => {
    const first = [
      JSON.stringify(turnContextLine("gpt-5.5")),
      JSON.stringify(
        tokenCountEvent("2026-05-01T00:00:01.000Z", null, {
          input: 100,
          output: 10,
          cached: 0,
          cacheWrite: 60,
          reasoning: 0,
        }),
      ),
    ];
    const path = await makeTempJsonl("rollout-cw-carry.jsonl", first);
    const r1 = await parseCodexFile({ path, byteOffset: 0, user: "k" });
    expect(r1.events[0]!.cacheCreationTokens).toBe(60);

    await writeFile(
      path,
      `${[
        ...first,
        JSON.stringify(
          tokenCountEvent("2026-05-01T00:00:02.000Z", null, {
            input: 200,
            output: 20,
            cached: 0,
            cacheWrite: 90,
            reasoning: 0,
          }),
        ),
      ].join("\n")}\n`,
    );
    const r2 = await parseCodexFile({
      path,
      byteOffset: r1.newOffset,
      user: "k",
      prevSessionTotals: r1.sessionTotals,
      prevModel: r1.lastModel,
    });
    // Only the 30 newly-written tokens, not the 90 cumulative.
    expect(r2.events.length).toBe(1);
    expect(r2.events[0]!.cacheCreationTokens).toBe(30);
    expect(r2.sessionTotals.cacheWriteInputTokens).toBe(90);
  });

  it("treats a pre-v0.6.5 state file with no cache-write field as 0", async () => {
    const path = await makeTempJsonl("rollout-cw-legacy-state.jsonl", [
      JSON.stringify(turnContextLine("gpt-5.5")),
      JSON.stringify(
        tokenCountEvent("2026-05-01T00:00:02.000Z", null, {
          input: 200,
          output: 20,
          cached: 0,
          cacheWrite: 60,
          reasoning: 0,
        }),
      ),
    ]);
    // Exactly what an older daemon persisted: no cacheWriteInputTokens key.
    const legacy = {
      sessionId: "rollout-cw-legacy-state",
      inputTokens: 100,
      outputTokens: 10,
      cachedInputTokens: 0,
      reasoningTokens: 0,
    } as unknown as SessionTotals;
    const r = await parseCodexFile({
      path,
      byteOffset: 0,
      user: "k",
      prevSessionTotals: legacy,
    });
    expect(r.events[0]!.cacheCreationTokens).toBe(60);
    expect(Number.isFinite(r.events[0]!.inputTokens)).toBe(true);
    expect(r.sessionTotals.cacheWriteInputTokens).toBe(60);
  });

  it("rebaselines cache-write alone without re-billing the other buckets", async () => {
    // Cache-write regresses while input/output/cached keep climbing. The
    // bucket must self-heal (never emit a negative delta) WITHOUT tripping the
    // shared reset, which would re-bill the whole session cumulative as one
    // event on the strength of a field no build has been observed populating.
    const path = await makeTempJsonl("rollout-cw-only-reset.jsonl", [
      JSON.stringify(turnContextLine("gpt-5.5")),
      JSON.stringify(
        tokenCountEvent("2026-05-01T00:00:01.000Z", null, {
          input: 100,
          output: 10,
          cached: 0,
          cacheWrite: 80,
          reasoning: 0,
        }),
      ),
      JSON.stringify(
        tokenCountEvent("2026-05-01T00:00:02.000Z", null, {
          input: 200,
          output: 30,
          cached: 0,
          cacheWrite: 50,
          reasoning: 0,
        }),
      ),
    ]);
    const r = await parseCodexFile({ path, byteOffset: 0, user: "k" });
    expect(r.events.length).toBe(2);
    // outputTokens 20 (the delta), NOT 30 (the cumulative): the other buckets
    // kept deltaing normally.
    expect(r.events[1]).toMatchObject({
      inputTokens: 50,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheCreationTokens: 50,
    });
    expect(r.events[1]!.cacheCreationTokens).toBeGreaterThanOrEqual(0);
    expect(r.sessionTotals.cacheWriteInputTokens).toBe(50);
  });

  it("treats a regressed cumulative cache-write as a fresh baseline", async () => {
    const path = await makeTempJsonl("rollout-cw-reset.jsonl", [
      JSON.stringify(turnContextLine("gpt-5.5")),
      JSON.stringify(
        tokenCountEvent("2026-05-01T00:00:01.000Z", null, {
          input: 100,
          output: 10,
          cached: 0,
          cacheWrite: 80,
          reasoning: 0,
        }),
      ),
      // Cumulatives regress (new sub-session / rotation): the numbers on this
      // line ARE the new baseline, not a negative delta.
      JSON.stringify(
        tokenCountEvent("2026-05-01T00:00:02.000Z", null, {
          input: 90,
          output: 5,
          cached: 0,
          cacheWrite: 30,
          reasoning: 0,
        }),
      ),
    ]);
    const r = await parseCodexFile({ path, byteOffset: 0, user: "k" });
    expect(r.events[1]).toMatchObject({
      inputTokens: 60,
      cacheCreationTokens: 30,
      outputTokens: 5,
    });
    expect(r.sessionTotals.cacheWriteInputTokens).toBe(30);
  });
});

/**
 * Replayed token_count records. `total_token_usage` is monotonically
 * cumulative, so a real API call always advances it — yet some Codex
 * versions log the same request twice, seconds apart, with a byte-identical
 * `last_token_usage` and an unmoved total. Since `last` is used directly as
 * the per-turn delta, the replay billed its full input a second time:
 * measured 6.64% of all Codex input on one machine.
 */
describe("replayed token_count records", () => {
  async function writeSession(lines: unknown[]): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "codex-replay-"));
    const path = join(dir, "rollout-2026-08-01T00-00-00-replay.jsonl");
    await writeFile(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    return path;
  }
  const u = (i: number, o: number) => ({ input: i, cached: 0, output: o, reasoning: 0 });

  it("bills a replayed record once, not twice", async () => {
    const path = await writeSession([
      turnContextLine("gpt-5.6-sol", "2026-08-01T00:00:00.000Z"),
      tokenCountEvent("2026-08-01T00:00:01.000Z", u(100, 10), u(100, 10)),
      // same request logged again ~1s later: identical last, UNMOVED total
      tokenCountEvent("2026-08-01T00:00:02.000Z", u(100, 10), u(100, 10)),
      // a genuine next turn: the cumulative advances
      tokenCountEvent("2026-08-01T00:00:30.000Z", u(50, 5), u(150, 15)),
    ]);
    const r = await parseCodexFile({ path, byteOffset: 0, user: "u" });
    expect(r.events.length).toBe(2);
    expect(r.replayedSkipped).toBe(1);
    expect(r.events.reduce((s, e) => s + e.inputTokens, 0)).toBe(150);
  });

  it("regression: without the guard the replay would double the input", async () => {
    // Same fixture, but the replay carries an ADVANCED total — i.e. it is a
    // real second call that happens to have identical per-turn usage. That
    // must still be billed, or the guard would eat legitimate traffic.
    const path = await writeSession([
      turnContextLine("gpt-5.6-sol", "2026-08-01T00:00:00.000Z"),
      tokenCountEvent("2026-08-01T00:00:01.000Z", u(100, 10), u(100, 10)),
      tokenCountEvent("2026-08-01T00:00:02.000Z", u(100, 10), u(200, 20)),
    ]);
    const r = await parseCodexFile({ path, byteOffset: 0, user: "u" });
    expect(r.events.length).toBe(2);
    expect(r.replayedSkipped ?? 0).toBe(0);
    expect(r.events.reduce((s, e) => s + e.inputTokens, 0)).toBe(200);
  });

  it("the first record of a session is never mistaken for a replay", async () => {
    const path = await writeSession([
      turnContextLine("gpt-5.6-sol", "2026-08-01T00:00:00.000Z"),
      tokenCountEvent("2026-08-01T00:00:01.000Z", u(100, 10), u(100, 10)),
    ]);
    const r = await parseCodexFile({ path, byteOffset: 0, user: "u" });
    expect(r.events.length).toBe(1);
    expect(r.replayedSkipped ?? 0).toBe(0);
  });

  it("catches a replay split across an incremental read boundary", async () => {
    const first = [
      turnContextLine("gpt-5.6-sol", "2026-08-01T00:00:00.000Z"),
      tokenCountEvent("2026-08-01T00:00:01.000Z", u(100, 10), u(100, 10)),
    ];
    const path = await writeSession(first);
    const a = await parseCodexFile({ path, byteOffset: 0, user: "u" });
    expect(a.events.length).toBe(1);

    // The replay lands in the NEXT read. The cumulative baseline survives
    // only because sessionTotals is threaded back in.
    await writeFile(
      path,
      `${[...first, tokenCountEvent("2026-08-01T00:00:02.000Z", u(100, 10), u(100, 10))]
        .map((l) => JSON.stringify(l))
        .join("\n")}\n`,
    );
    const b = await parseCodexFile({
      path,
      byteOffset: a.newOffset,
      user: "u",
      prevSessionTotals: a.sessionTotals,
      prevModel: a.lastModel,
    });
    expect(b.events.length).toBe(0);
    expect(b.replayedSkipped).toBe(1);
  });

  it("a zero-token record with an unmoved total is dropped without loss", async () => {
    const path = await writeSession([
      turnContextLine("gpt-5.6-sol", "2026-08-01T00:00:00.000Z"),
      tokenCountEvent("2026-08-01T00:00:01.000Z", u(100, 10), u(100, 10)),
      // the 248 real-world cases: flat cumulative, different last, all zeros
      tokenCountEvent("2026-08-01T00:00:02.000Z", u(0, 0), u(100, 10)),
    ]);
    const r = await parseCodexFile({ path, byteOffset: 0, user: "u" });
    expect(r.events.length).toBe(1);
    expect(r.replayedSkipped).toBe(1);
  });
});
