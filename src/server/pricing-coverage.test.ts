import { describe, expect, test } from "bun:test";
import { PricingCache } from "./pricing.ts";

/**
 * Models that have actually appeared in fleet traffic, asserted to be priceable
 * from the VENDORED snapshot alone — no network.
 *
 * The gap this guards: an unpriced model is not a visible failure. lookup()
 * returns null, the row gets costUsd 0, and the name lands in `unknownModels`
 * on a stats payload nobody reads. The dashboard renders a dash and the
 * leaderboard — which ranks purely by cost (see main.ts, byModel ordering) —
 * silently sorts that model's heaviest users to the bottom.
 *
 * `claude-opus-5` shipped in exactly that state: absent from the snapshot under
 * every alias while `claude-fable-5` was present, so the snapshot was vendored
 * in the window between the two landing upstream. On one developer machine that
 * was 193k messages and 50B cache-read tokens reading as $0.
 *
 * The daily refreshFromUpstream() masks this on any server with egress, which is
 * why it went unnoticed — and precisely why the snapshot needs its own guard.
 * An air-gapped self-host never gets the correction.
 *
 * Add a model here when it first shows up in traffic. A failure means
 * `bun run scripts/vendor-pricing.ts`.
 */
const MODELS_SEEN_IN_TRAFFIC = [
  // Claude Code
  "claude-opus-5",
  "claude-fable-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-sonnet-5",
  "claude-haiku-4-5-20251001",
  // Codex CLI
  "gpt-5.6",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5-codex",
  "gpt-5.1-codex-mini",
  // Codex's self-review sub-agent: no published rate, priced by PRICE_ALIASES.
  "codex-auto-review",
] as const;

describe("pricing coverage", () => {
  test("every model seen in traffic prices from the vendored snapshot", () => {
    const cache = new PricingCache();
    const unpriced = MODELS_SEEN_IN_TRAFFIC.filter((m) => cache.lookup(m) === null);
    expect(unpriced).toEqual([]);
  });

  test("every model seen in traffic has non-zero input and output rates", () => {
    const cache = new PricingCache();
    for (const model of MODELS_SEEN_IN_TRAFFIC) {
      const price = cache.lookup(model);
      expect(price).not.toBeNull();
      expect(price!.input).toBeGreaterThan(0);
      expect(price!.output).toBeGreaterThan(0);
    }
  });

  test("claude-opus-5 prices at its published rate", () => {
    // $5.00 in / $0.50 cache read / $6.25 cache write / $25.00 out per 1M.
    const price = new PricingCache().lookup("claude-opus-5");
    expect(price).not.toBeNull();
    expect(price!.input).toBe(5e-6);
    expect(price!.cacheRead).toBe(5e-7);
    expect(price!.cacheCreation).toBe(6.25e-6);
    expect(price!.output).toBe(2.5e-5);
  });

  test("gpt-5.6 bills cache writes; gpt-5.5 does not", () => {
    // 5.6 moved OpenAI to explicit prompt caching, which prices writes at 1.25x
    // input. Older OpenAI models cache automatically and never charge a write.
    // A snapshot that flattens this understates every 5.6 session that sets a
    // cache breakpoint.
    const cache = new PricingCache();
    expect(cache.lookup("gpt-5.6-sol")!.cacheCreation).toBe(6.25e-6);
    expect(cache.lookup("gpt-5.5")!.cacheCreation).toBe(0);
  });

  test("the <synthetic> sentinel stays unpriced", () => {
    // Claude Code stamps locally-generated messages with this in the model
    // field. It is not a model, always carries zero tokens, and must never be
    // aliased to one — a price here would invent spend.
    expect(new PricingCache().lookup("<synthetic>")).toBeNull();
  });
});
