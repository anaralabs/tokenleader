import pricingFallbackRaw from "./pricing-fallback.json" with { type: "json" };
import type { TokenEvent } from "../types.ts";

export interface ModelPrice {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  reasoning: number | null;
}

const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

// Provider prefixes commonly seen on model names ("anthropic/claude-...",
// "openai/gpt-...", etc.). LiteLLM mostly keys by bare model name, so
// stripping these and re-looking-up handles a fair number of edge cases.
const COMMON_PREFIXES = [
  "anthropic/",
  "openai/",
  "google/",
  "vertex_ai/",
  "vercel_ai_gateway/",
  "bedrock/",
  "azure/",
  "azure_ai/",
];

interface RawEntry {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_creation_input_token_cost?: number;
  cache_read_input_token_cost?: number;
  output_cost_per_reasoning_token?: number;
  mode?: string;
  litellm_provider?: string;
}

function normalizeEntry(raw: RawEntry): ModelPrice | null {
  const input = raw.input_cost_per_token;
  const output = raw.output_cost_per_token;
  // Only models with at least input+output token pricing are usable.
  if (typeof input !== "number" || typeof output !== "number") return null;
  return {
    input,
    output,
    cacheCreation: raw.cache_creation_input_token_cost ?? 0,
    cacheRead: raw.cache_read_input_token_cost ?? 0,
    reasoning:
      typeof raw.output_cost_per_reasoning_token === "number"
        ? raw.output_cost_per_reasoning_token
        : null,
  };
}

/**
 * Models that show up in real traffic but that LiteLLM does not publish a
 * price for. Without an entry the model prices at $0 with `unknownPrice`,
 * and a silent $0 understates a total far more misleadingly than a close
 * approximation does — `codex-auto-review` alone carries ~4B cache-read
 * tokens across the fleet.
 *
 * Each alias maps to the nearest PUBLISHED model, and each is a deliberate
 * approximation, not a discovered rate:
 *   codex-auto-review — the review sub-agent Codex spawns to check its own
 *     diffs. Real inference on a real model, but OpenAI publishes no
 *     separate rate for it. Mapped to gpt-5-codex (the cheaper of the two
 *     plausible codex tiers) so the estimate errs low rather than
 *     inventing spend.
 *
 * Applied inside buildMap so an upstream refresh cannot drop them, and only
 * when upstream has no real entry — the moment LiteLLM publishes one, the
 * real price wins.
 */
const PRICE_ALIASES: Record<string, string> = {
  "codex-auto-review": "gpt-5-codex",
};

function buildMap(rawJson: Record<string, RawEntry>): Map<string, ModelPrice> {
  const out = new Map<string, ModelPrice>();
  for (const [name, entry] of Object.entries(rawJson)) {
    if (name === "sample_spec") continue;
    if (!entry || typeof entry !== "object") continue;
    const price = normalizeEntry(entry);
    if (!price) continue;
    out.set(name.toLowerCase(), price);
  }
  for (const [alias, target] of Object.entries(PRICE_ALIASES)) {
    if (out.has(alias)) continue;
    const price = out.get(target);
    if (price) out.set(alias, price);
  }
  return out;
}

const FALLBACK_RAW = pricingFallbackRaw as Record<string, RawEntry>;

export function loadPricingFallback(): Record<string, ModelPrice> {
  return Object.fromEntries(buildMap(FALLBACK_RAW));
}

export class PricingCache {
  private map: Map<string, ModelPrice>;
  private unknown: Set<string> = new Set();

  constructor() {
    this.map = buildMap(FALLBACK_RAW);
  }

  size(): number {
    return this.map.size;
  }

  unknownModels(): Set<string> {
    return new Set(this.unknown);
  }

  async refreshFromUpstream(): Promise<{ updated: number; failed: boolean }> {
    try {
      const res = await fetch(LITELLM_URL);
      if (!res.ok) return { updated: this.map.size, failed: true };
      const json = (await res.json()) as Record<string, RawEntry>;
      const next = buildMap(json);
      if (next.size === 0) return { updated: this.map.size, failed: true };
      // Atomic swap.
      this.map = next;
      this.unknown.clear();
      return { updated: next.size, failed: false };
    } catch {
      return { updated: this.map.size, failed: true };
    }
  }

  lookup(model: string): ModelPrice | null {
    if (!model) return null;
    const key = model.toLowerCase();
    const direct = this.map.get(key);
    if (direct) return direct;
    // Strip a single common provider prefix and retry.
    for (const p of COMMON_PREFIXES) {
      if (key.startsWith(p)) {
        const stripped = key.slice(p.length);
        const hit = this.map.get(stripped);
        if (hit) return hit;
      }
    }
    // As a last resort, try looking up just the trailing segment after a
    // slash (handles e.g. "vercel_ai_gateway/anthropic/claude-...").
    const slash = key.lastIndexOf("/");
    if (slash >= 0 && slash < key.length - 1) {
      const tail = key.slice(slash + 1);
      const hit = this.map.get(tail);
      if (hit) return hit;
    }
    this.unknown.add(model);
    return null;
  }
}

/**
 * USD cost in integer cents for one TokenEvent (matches ccusage).
 * Reasoning tokens are not a separate line item — Codex folds them into
 * outputTokens and Anthropic doesn't bill them; adding them would
 * double-count. `reasoningTokens` is display/audit-only.
 */
export function computeCostCents(event: TokenEvent, price: ModelPrice): number {
  const dollars =
    event.inputTokens * price.input +
    event.outputTokens * price.output +
    event.cacheCreationTokens * price.cacheCreation +
    event.cacheReadTokens * price.cacheRead;
  return Math.round(dollars * 100);
}

/**
 * Sum-of-tokens variant for SQL-aggregated rows. Returns unrounded USD so
 * callers round once after summing (per-event rounding drifts on big
 * totals). `row.reasoning` is accepted but unused — see computeCostCents.
 */
export function computeRowCostUsd(
  row: {
    input: number;
    output: number;
    cacheCreation: number;
    cacheRead: number;
    reasoning: number;
  },
  price: ModelPrice,
): number {
  void row.reasoning;
  return (
    row.input * price.input +
    row.output * price.output +
    row.cacheCreation * price.cacheCreation +
    row.cacheRead * price.cacheRead
  );
}

/** Round a USD float to 4 decimal places. */
export function roundUsd(usd: number): number {
  return Math.round(usd * 10_000) / 10_000;
}
