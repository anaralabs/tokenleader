import { createHash } from "node:crypto";

/** Synthesize a session id per (user, UTC day) — Cursor has no session concept. */
export function cursorSessionId(user: string, tsMs: number): string {
  const d = new Date(tsMs);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `cursor:${user}:${yyyy}-${mm}-${dd}`;
}

/**
 * Deterministic messageId for events the API doesn't id — re-fetched events
 * dedupe via events_dedup. Token counts are folded in so same-ms same-model
 * events don't collide. Field order is load-bearing: changing it rewrites
 * every historical dedup key.
 */
export function cursorMessageId(parts: {
  timestamp: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
}): string {
  return createHash("sha256")
    .update(String(parts.timestamp))
    .update(":")
    .update(parts.model)
    .update(":")
    .update(String(parts.inputTokens))
    .update(":")
    .update(String(parts.outputTokens))
    .update(":")
    .update(String(parts.cacheWriteTokens))
    .update(":")
    .update(String(parts.cacheReadTokens))
    .digest("hex")
    .slice(0, 24);
}

/** totalCents is fractional cents; 1 cent = 10_000 micros. */
export function centsToMicros(cents: number): number {
  return Math.round(cents * 10_000);
}

// The server /ingest validator rejects negative/fractional tokens and a
// costUsdMicros that is negative or above this ceiling ($100). Cursor-cloud
// rows (both the daemon login-cursor path and the team mirror) can carry
// fractional tokens, refunds (negative cents), or a single big-spend event —
// clamp at the source so a row is never dropped, and never stored bad on the
// mirror path (which bypasses validateEvent). A refund clamps to 0, not a
// rejected/negative row.
export const MAX_COST_USD_MICROS = 100_000_000;

/** Coerce a token count to a non-negative integer (the validator's contract). */
export function clampToken(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}

/** Clamp a micro-dollar cost into the validator's accepted [0, ceiling]. */
export function clampCostMicros(micros: number): number {
  if (!Number.isFinite(micros)) return 0;
  return Math.min(MAX_COST_USD_MICROS, Math.max(0, Math.round(micros)));
}
