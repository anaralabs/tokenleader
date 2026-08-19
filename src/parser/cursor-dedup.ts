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
 * The canonical model string for a source="cursor" row.
 *
 * Two live paths write source="cursor" for the SAME underlying event: the
 * daemon's dashboard sync (parser/cursor-api.ts, `tokenleader login-cursor`)
 * and the team mirror (server/cursor-mirror.ts). cursorMessageId hashes the
 * model into the dedup key, so if the two paths spell the model differently
 * the same event lands twice — and Cursor rows carry stored cost, so that
 * double-counts at full dollar weight. Hence one shared resolver rather than
 * two hand-kept-in-sync ternaries.
 *
 * The SLUG (`model`, e.g. "gpt-5.3-codex") wins: it is stable, it is what the
 * team API reports at all, and it is already the overwhelming majority of
 * stored rows. The dashboard's display name (`modelName`, e.g.
 * "Premium (Codex 5.3)") only fills in when no slug exists.
 *
 * Consequences of adopting this in v0.6.5, none of which rewrite history:
 *  - Existing rows keep their stored model string and their old messageId.
 *    Nothing is migrated in place, so a leaderboard can show both
 *    "Premium (Codex 5.3)" (old daemon rows) and "gpt-5.3-codex" (new ones)
 *    until the old rows age out.
 *  - Because the key changes, a re-walk re-inserts the id-less rows it
 *    covers. Incrementally that is the sync's ~5-minute overlap; a daemon
 *    that never latched `cursorCloud.fullSyncDone`, a `tokenleader
 *    sync-cursor`, or an admin/clear re-walk re-imports ALL history, and
 *    every one of those rows carries stored cost. Rows the dashboard gave an
 *    `id` are unaffected (their messageId is the id, not this hash).
 *  - Mirror events whose team-API model is the empty string now key and
 *    display as "cursor" rather than "". That also removes a
 *    `createHash.update(undefined)` TypeError that a model-less team event
 *    would have thrown out of toTokenEvent, aborting the tick before the
 *    watermark advanced and wedging the mirror in a retry loop.
 */
export function cursorModel(ev: { model?: string; modelName?: string }): string {
  if (typeof ev.model === "string" && ev.model.length > 0) return ev.model;
  if (typeof ev.modelName === "string" && ev.modelName.length > 0) return ev.modelName;
  return "cursor";
}

/**
 * Deterministic messageId for events the API doesn't id — re-fetched events
 * dedupe via events_dedup. Token counts are folded in so same-ms same-model
 * events don't collide. Field order is load-bearing: changing it rewrites
 * every historical dedup key.
 *
 * The counts are normalised HERE, not by the callers. Cursor reports
 * fractional tokens (and the team API omits the cache fields outright), and
 * the two paths that write source="cursor" reached this function with
 * differently-shaped numbers: the mirror passed the raw API values, the
 * dashboard mapper passed values already through `clampToken`. That is the
 * same divergence as the model string — 100.5 hashes differently from 101, so
 * the same event landed twice at full stored-cost weight. Normalising inside
 * the hash means no caller can drift again. Integer inputs are unaffected
 * (`String(clampToken(100)) === String(100)`), so only keys that were already
 * inconsistent change.
 */
export function cursorMessageId(parts: {
  timestamp: number;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
}): string {
  return createHash("sha256")
    .update(String(parts.timestamp))
    .update(":")
    .update(parts.model)
    .update(":")
    .update(String(clampToken(parts.inputTokens)))
    .update(":")
    .update(String(clampToken(parts.outputTokens)))
    .update(":")
    .update(String(clampToken(parts.cacheWriteTokens)))
    .update(":")
    .update(String(clampToken(parts.cacheReadTokens)))
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

/** Coerce a token count to a non-negative integer (the validator's contract).
 *  Accepts undefined because the upstream APIs declare these fields optional
 *  and do omit them — a missing count is 0, not NaN. */
export function clampToken(n: number | undefined): number {
  return Number.isFinite(n) ? Math.max(0, Math.round(n as number)) : 0;
}

/** Clamp a micro-dollar cost into the validator's accepted [0, ceiling]. */
export function clampCostMicros(micros: number): number {
  if (!Number.isFinite(micros)) return 0;
  return Math.min(MAX_COST_USD_MICROS, Math.max(0, Math.round(micros)));
}
