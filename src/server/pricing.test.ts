import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeTokenEvent } from "../test-helpers.ts";
import type { TokenEvent } from "../types.ts";
import {
  PricingCache,
  computeCostCents,
  computeRowCostUsd,
  loadPricingFallback,
  roundUsd,
  type ModelPrice,
} from "./pricing.ts";

// Helper for hand-computed assertions on aggregated-row costs.
function approxEqualUsd(actual: number, expected: number, tolerance = 1e-4): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
}

const KNOWN_MODEL = "claude-haiku-4-5-20251001";

const makeEvent = (overrides: Partial<TokenEvent> = {}): TokenEvent =>
  makeTokenEvent({
    requestId: null,
    model: KNOWN_MODEL,
    inputTokens: 1_000_000,
    outputTokens: 500_000,
    cacheCreationTokens: 100_000,
    cacheReadTokens: 200_000,
    ...overrides,
  });

describe("loadPricingFallback", () => {
  test("loads and contains a known model", () => {
    const map = loadPricingFallback();
    const entry = map[KNOWN_MODEL];
    expect(entry).toBeDefined();
    expect(typeof entry!.input).toBe("number");
    expect(typeof entry!.output).toBe("number");
    expect(entry!.input).toBeGreaterThan(0);
    expect(entry!.output).toBeGreaterThan(0);
  });

  test("normalizes the LiteLLM schema into ModelPrice", () => {
    const map = loadPricingFallback();
    const entry = map[KNOWN_MODEL]!;
    expect(typeof entry.input).toBe("number");
    expect(typeof entry.output).toBe("number");
    expect(typeof entry.cacheCreation).toBe("number");
    expect(typeof entry.cacheRead).toBe("number");
    expect(entry.reasoning === null || typeof entry.reasoning === "number").toBe(true);
  });

  test("filters out the sample_spec entry", () => {
    const map = loadPricingFallback();
    expect(map.sample_spec).toBeUndefined();
  });
});

describe("computeCostCents", () => {
  test("computes correct cost for a known event and price", () => {
    const price: ModelPrice = {
      input: 0.000003, // $3 per 1M
      output: 0.000015, // $15 per 1M
      cacheCreation: 0.00000375,
      cacheRead: 0.0000003,
      reasoning: null,
    };
    const ev = makeEvent({
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cacheCreationTokens: 100_000,
      cacheReadTokens: 200_000,
    });
    // 1M*0.000003 + 500K*0.000015 + 100K*0.00000375 + 200K*0.0000003
    // = 3 + 7.5 + 0.375 + 0.06 = 10.935 USD = 1093.5 cents -> 1094 (banker's rounds .5 up here in JS)
    const cents = computeCostCents(ev, price);
    expect(cents).toBe(Math.round(10.935 * 100));
  });

  test("does NOT separately charge reasoning tokens (informational only)", () => {
    // Matches ccusage: reasoning is bundled into output_tokens for Codex,
    // and Claude Code doesn't emit reasoning at all. A separate reasoning
    // charge would double-bill Codex output.
    const price: ModelPrice = {
      input: 0,
      output: 0.00001,
      cacheCreation: 0,
      cacheRead: 0,
      reasoning: 0.00005, // even if a reasoning rate is set, we ignore it
    };
    const ev = makeEvent({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      reasoningTokens: 100_000,
    });
    // Only the four billable buckets contribute; reasoning is dropped.
    expect(computeCostCents(ev, price)).toBe(0);
  });

  test("handles null reasoningTokens as zero", () => {
    const price: ModelPrice = {
      input: 0.00001,
      output: 0,
      cacheCreation: 0,
      cacheRead: 0,
      reasoning: null,
    };
    const ev = makeEvent({
      inputTokens: 100,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      reasoningTokens: null,
    });
    expect(computeCostCents(ev, price)).toBe(Math.round(100 * 0.00001 * 100));
  });

  test("empty zero-event yields zero cost (no NaN, no rounding artifacts)", () => {
    const price: ModelPrice = {
      input: 0.00001,
      output: 0.00002,
      cacheCreation: 0.000005,
      cacheRead: 0.0000005,
      reasoning: null,
    };
    const ev = makeEvent({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      reasoningTokens: null,
    });
    expect(computeCostCents(ev, price)).toBe(0);
  });
});

describe("computeRowCostUsd", () => {
  test("returns float USD without rounding", () => {
    const price: ModelPrice = {
      input: 0.000003,
      output: 0.000015,
      cacheCreation: 0,
      cacheRead: 0,
      reasoning: null,
    };
    const row = {
      input: 100,
      output: 50,
      cacheCreation: 0,
      cacheRead: 0,
      reasoning: 0,
    };
    // 100 * 0.000003 + 50 * 0.000015 = 0.0003 + 0.00075 = 0.00105
    expect(computeRowCostUsd(row, price)).toBeCloseTo(0.00105, 10);
  });

  test("reasoning field on row is IGNORED in cost calculation", () => {
    // Defends against accidental re-introduction of a reasoning charge.
    // ccusage doesn't add one; we don't either.
    const price: ModelPrice = {
      input: 0,
      output: 0,
      cacheCreation: 0,
      cacheRead: 0,
      reasoning: 0.0001,
    };
    const row = {
      input: 0,
      output: 0,
      cacheCreation: 0,
      cacheRead: 0,
      reasoning: 1_000_000, // 1M reasoning tokens — would be $100 if billed
    };
    expect(computeRowCostUsd(row, price)).toBe(0);
  });

  test("Claude Opus 4.7: hand-computed full-bucket scenario matches within $0.0001", () => {
    // Real Opus 4.7 prices from src/server/pricing-fallback.json:
    //   input_cost_per_token              = 5e-6   ($5 / 1M)
    //   output_cost_per_token             = 2.5e-5 ($25 / 1M)
    //   cache_creation_input_token_cost   = 6.25e-6 ($6.25 / 1M, 5m TTL)
    //   cache_read_input_token_cost       = 5e-7   ($0.50 / 1M)
    const cache = new PricingCache();
    const price = cache.lookup("claude-opus-4-7")!;
    expect(price).not.toBeNull();
    expect(price.input).toBe(5e-6);
    expect(price.output).toBe(2.5e-5);
    expect(price.cacheCreation).toBe(6.25e-6);
    expect(price.cacheRead).toBe(5e-7);

    const row = {
      input: 1_000,
      output: 500,
      cacheCreation: 200,
      cacheRead: 8_000,
      reasoning: 0,
    };
    // By hand:
    //   1000   * 5e-6    = 0.005
    //    500   * 2.5e-5  = 0.0125
    //    200   * 6.25e-6 = 0.00125
    //   8000   * 5e-7    = 0.004
    //   total           = 0.02275 USD
    const expected = 0.005 + 0.0125 + 0.00125 + 0.004;
    const actual = computeRowCostUsd(row, price);
    approxEqualUsd(actual, expected);
    approxEqualUsd(actual, 0.02275);
  });

  test("Codex gpt-5.5: hand-computed scenario with non-cached input + cached + output", () => {
    // Real gpt-5.5 prices from src/server/pricing-fallback.json:
    //   input_cost_per_token              = 5e-6   ($5 / 1M)
    //   cache_read_input_token_cost       = 5e-7   ($0.50 / 1M)
    //   output_cost_per_token             = 3e-5   ($30 / 1M)
    //   (no cache_creation for OpenAI — Codex parser sets it to 0)
    //
    // The Codex parser emits a raw token_count of
    //   input=10000, cached=8000, output=2000, reasoning=500
    // is emitted as:
    //   inputTokens=2000 (non-cached), cacheReadTokens=8000,
    //   outputTokens=2000, reasoningTokens=500
    // and the cost formula is:
    //   2000 * 5e-6  = 0.01
    //   8000 * 5e-7  = 0.004
    //   2000 * 3e-5  = 0.06
    //   reasoning is informational only — NOT added.
    const cache = new PricingCache();
    const price = cache.lookup("gpt-5.5")!;
    expect(price).not.toBeNull();
    expect(price.input).toBe(5e-6);
    expect(price.cacheRead).toBe(5e-7);
    expect(price.output).toBe(3e-5);

    const row = {
      input: 2_000, // non-cached portion (parser already subtracted)
      output: 2_000,
      cacheCreation: 0,
      cacheRead: 8_000,
      reasoning: 500, // ignored by formula
    };
    const expected = 0.01 + 0.004 + 0.06;
    const actual = computeRowCostUsd(row, price);
    approxEqualUsd(actual, expected);
    approxEqualUsd(actual, 0.074);
  });

  test("aggregate-zero row yields zero cost", () => {
    const cache = new PricingCache();
    const price = cache.lookup("claude-opus-4-7")!;
    const row = {
      input: 0,
      output: 0,
      cacheCreation: 0,
      cacheRead: 0,
      reasoning: 0,
    };
    expect(computeRowCostUsd(row, price)).toBe(0);
  });

  test("unknown model: lookup returns null and records the unknown name", () => {
    const cache = new PricingCache();
    const price = cache.lookup("totally-made-up-2099");
    expect(price).toBeNull();
    expect(cache.unknownModels().has("totally-made-up-2099")).toBe(true);
  });
});

describe("roundUsd", () => {
  test("rounds to 4 decimal places", () => {
    expect(roundUsd(0.12345)).toBe(0.1235);
    expect(roundUsd(0.12344)).toBe(0.1234);
    expect(roundUsd(10.935)).toBe(10.935);
    expect(roundUsd(0)).toBe(0);
  });
});

describe("PricingCache.lookup", () => {
  let cache: PricingCache;

  beforeEach(() => {
    cache = new PricingCache();
  });

  test("exact match returns price", () => {
    const p = cache.lookup(KNOWN_MODEL);
    expect(p).not.toBeNull();
    expect(p!.input).toBeGreaterThan(0);
  });

  test("case-insensitive match", () => {
    const lower = cache.lookup("claude-opus-4-7");
    const upper = cache.lookup("Claude-Opus-4-7");
    const mixed = cache.lookup("CLAUDE-OPUS-4-7");
    expect(lower).not.toBeNull();
    expect(upper).toEqual(lower!);
    expect(mixed).toEqual(lower!);
  });

  test("strips anthropic/ prefix", () => {
    const direct = cache.lookup("claude-opus-4-7");
    const prefixed = cache.lookup("anthropic/claude-opus-4-7");
    expect(prefixed).not.toBeNull();
    expect(prefixed).toEqual(direct!);
  });

  test("strips openai/ prefix", () => {
    const direct = cache.lookup("gpt-5.5");
    if (direct) {
      const prefixed = cache.lookup("openai/gpt-5.5");
      expect(prefixed).toEqual(direct);
    }
  });

  test("unknown model returns null and is recorded", () => {
    expect(cache.lookup("totally-fake-model-xyz")).toBeNull();
    expect(cache.unknownModels().has("totally-fake-model-xyz")).toBe(true);
  });

  test("unknown set tracks distinct entries", () => {
    cache.lookup("fake-a");
    cache.lookup("fake-b");
    cache.lookup("fake-a"); // dup
    const unknown = cache.unknownModels();
    expect(unknown.size).toBe(2);
    expect(unknown.has("fake-a")).toBe(true);
    expect(unknown.has("fake-b")).toBe(true);
  });

  test("known model is NOT added to unknown set", () => {
    cache.lookup(KNOWN_MODEL);
    expect(cache.unknownModels().has(KNOWN_MODEL)).toBe(false);
  });

  test("returns the unknown set as a copy (mutation does not leak)", () => {
    cache.lookup("fake-leak");
    const set = cache.unknownModels();
    set.add("injected");
    // Re-fetch — the original should be unchanged.
    const set2 = cache.unknownModels();
    expect(set2.has("injected")).toBe(false);
    expect(set2.has("fake-leak")).toBe(true);
  });

  test("real target models from local data are all resolvable", () => {
    const targets = [
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-haiku-4-5-20251001",
      "claude-sonnet-4-5",
      "claude-sonnet-4-6",
      "gpt-5.5",
      "gpt-5.3-codex",
      "gpt-5-codex",
    ];
    const missing: string[] = [];
    for (const t of targets) {
      if (cache.lookup(t) === null) missing.push(t);
    }
    expect(missing).toEqual([]);
  });
});

describe("PricingCache.refreshFromUpstream", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("falls back gracefully when fetch fails", async () => {
    let attempted = false;
    globalThis.fetch = (async () => {
      attempted = true;
      throw new Error("simulated network failure");
    }) as unknown as typeof fetch;

    const cache = new PricingCache();
    const baselineSize = cache.size();
    const baselinePrice = cache.lookup(KNOWN_MODEL);
    expect(baselinePrice).not.toBeNull();

    const result = await cache.refreshFromUpstream();
    expect(attempted).toBe(true);
    expect(result.failed).toBe(true);
    // Existing data stays usable.
    expect(cache.size()).toBe(baselineSize);
    expect(cache.lookup(KNOWN_MODEL)).toEqual(baselinePrice!);
  });

  test("falls back gracefully when fetch returns non-OK", async () => {
    globalThis.fetch = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch;

    const cache = new PricingCache();
    const result = await cache.refreshFromUpstream();
    expect(result.failed).toBe(true);
  });

  test("swaps map when fetch succeeds with valid JSON", async () => {
    let urlSeen = "";
    globalThis.fetch = (async (url: string) => {
      urlSeen = url;
      return new Response(
        JSON.stringify({
          "fake-test-model-9000": {
            input_cost_per_token: 1,
            output_cost_per_token: 2,
            cache_creation_input_token_cost: 0.5,
            cache_read_input_token_cost: 0.1,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const cache = new PricingCache();
    const result = await cache.refreshFromUpstream();
    expect(result.failed).toBe(false);
    expect(result.updated).toBe(1);
    expect(urlSeen).toContain("BerriAI/litellm");
    const p = cache.lookup("fake-test-model-9000");
    expect(p).toEqual({
      input: 1,
      output: 2,
      cacheCreation: 0.5,
      cacheRead: 0.1,
      reasoning: null,
    });
    // Old entry is gone.
    expect(cache.lookup(KNOWN_MODEL)).toBeNull();
  });

  test("keeps old map if upstream returns empty", async () => {
    globalThis.fetch = (async () =>
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    const cache = new PricingCache();
    const baseline = cache.size();
    const result = await cache.refreshFromUpstream();
    expect(result.failed).toBe(true);
    expect(cache.size()).toBe(baseline);
  });

  test("clears unknownModels on successful refresh", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          x: { input_cost_per_token: 0, output_cost_per_token: 0 },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const cache = new PricingCache();
    cache.lookup("not-a-real-model");
    expect(cache.unknownModels().size).toBe(1);
    await cache.refreshFromUpstream();
    expect(cache.unknownModels().size).toBe(0);
  });
});

describe("price aliases for models LiteLLM does not publish", () => {
  test("codex-auto-review prices as gpt-5-codex instead of silently $0", () => {
    const tbl = loadPricingFallback();
    const alias = tbl["codex-auto-review"];
    const target = tbl["gpt-5-codex"];
    expect(target).toBeDefined();
    expect(alias).toEqual(target!);
  });

  test("an alias never shadows a real upstream price", () => {
    // gpt-5-codex is published; the alias machinery must not overwrite it.
    const tbl = loadPricingFallback();
    expect(tbl["gpt-5-codex"]!.input).toBeGreaterThan(0);
  });
});
