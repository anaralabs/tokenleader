import { Database, type Statement } from "bun:sqlite";
import { timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { TokenEvent } from "../types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user TEXT NOT NULL,
  source TEXT NOT NULL,
  sessionId TEXT NOT NULL,
  messageId TEXT NOT NULL,
  requestId TEXT,
  timestamp INTEGER NOT NULL,
  model TEXT NOT NULL,
  messageType TEXT NOT NULL DEFAULT 'assistant',
  inputTokens INTEGER NOT NULL DEFAULT 0,
  outputTokens INTEGER NOT NULL DEFAULT 0,
  cacheCreationTokens INTEGER NOT NULL DEFAULT 0,
  cacheReadTokens INTEGER NOT NULL DEFAULT 0,
  reasoningTokens INTEGER,
  -- Per-event cost in USD micros for sources that ship one (Cursor).
  -- NULL = derive via PricingCache (Claude Code + Codex); aggregations
  -- SUM(COALESCE(., 0)) so NULL is ignored.
  costUsdMicros INTEGER,
  ingestedAt INTEGER NOT NULL
);
-- events has NO index defined here: the dashboard's covering index
-- (events_user_cover) and the dedup/timestamp indexes reference
-- messageType/costUsdMicros, which may not exist pre-migration, so they
-- are created in the constructor / migrateMessageType AFTER the migrate*
-- calls. events_user_model and events_model_ts used to live here and are
-- dropped post-migration (see the constructor for why).

-- Pre-aggregated dashboard source: one row per (UTC day, user, model,
-- messageType) holding INTEGER partial sums. This is what makes the stats
-- routes cost O(days x users x models-in-use) instead of O(events) — the
-- distinction that matters, because the events table doubles every ~2.5
-- months while the group rate is bounded by team size.
--
-- INVARIANTS, in the order they are easy to break:
--
--  1. It is AUTHORITATIVE. Reads never fall back to scanning events (a
--     staleness check would cost as much as the scan it avoids), so every
--     path that writes or deletes events MUST maintain it. Out-of-band SQL
--     surgery on events (a hand-run "UPDATE events SET user = ...", or
--     scripts/clear-db.sh) must also clear this table — there is no such
--     UPDATE in the codebase, so this is an ops rule. The boot audit is the
--     backstop, and POST /admin/rollup-audit {"rebuild":true} is the
--     unconditional fix for what the audit cannot see (see RollAuditRow).
--     The audit is also the last O(events) cost in the server: every read
--     path is O(days x users x models), that one scan is not.
--  2. Backfills need no watermark. The delta is keyed by the EVENT'S OWN
--     day, never by arrival time, so an event dated last September that
--     arrives today upserts last September's row. There is no
--     "materialised up to X" frontier that a late arrival can invalidate.
--  3. Deletes cannot be a delta, because maxTimestamp is not invertible.
--     They mark (user, day) in events_roll_dirty and the marked cells are
--     recomputed from raw events at the end of the same insertMany — exact
--     by definition, and paid for by the writer rather than the next
--     dashboard reader.
--  4. model stays a KEY rather than being summed away, because the
--     leaderboard's modelCount is a COUNT(DISTINCT model) and is not
--     additively decomposable across days. messageType stays a key for
--     the same reason on the user/assistant message split. maxTimestamp
--     exists because the leaderboard needs MAX(timestamp), which counts
--     cannot reconstruct.
--  5. model is '' for messageType='user' rows (validateEvent permits an
--     empty model only there) — a legal key value, not a sentinel.
CREATE TABLE IF NOT EXISTS events_roll_day (
  day                 INTEGER NOT NULL,
  user                TEXT    NOT NULL,
  model               TEXT    NOT NULL,
  messageType         TEXT    NOT NULL,
  events              INTEGER NOT NULL,
  inputTokens         INTEGER NOT NULL,
  outputTokens        INTEGER NOT NULL,
  cacheCreationTokens INTEGER NOT NULL,
  cacheReadTokens     INTEGER NOT NULL,
  reasoningTokens     INTEGER NOT NULL,
  storedCostMicros    INTEGER NOT NULL,
  maxTimestamp        INTEGER NOT NULL,
  PRIMARY KEY (day, user, model, messageType)
) WITHOUT ROWID;
-- The PK is day-leading (the timeseries access path). This one is
-- user-leading for the per-user routes (/stats?user=, the
-- /stats/leaderboard per-user pass). The whole table is ~0.1 MiB at prod
-- scale, so a second index on it is free.
CREATE INDEX IF NOT EXISTS events_roll_day_user ON events_roll_day (user, day);

-- (user, day) pairs whose rollup rows a DELETE invalidated. Recomputed from
-- raw events by Store.repairRollup, at the end of the insertMany that
-- deleted them. A queue, not a cache: an entry here means events_roll_day is
-- WRONG for that cell, so it must be drained before any read (which is why
-- the reads drain it too, as a backstop), it is never drained partially, and
-- it must be written in the same transaction as the delete that caused it.
CREATE TABLE IF NOT EXISTS events_roll_dirty (
  user TEXT    NOT NULL,
  day  INTEGER NOT NULL,
  PRIMARY KEY (user, day)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS user_secrets (
  username       TEXT PRIMARY KEY,
  secret_hash    TEXT NOT NULL,
  claimed_at     INTEGER NOT NULL,
  uninstalled_at INTEGER,
  company        TEXT
);

-- Admin-defined groups (Engineering, Growth, …). NOT seeded with constants —
-- a self-hoster starts with zero rows and the whole feature stays invisible
-- until they create one via the admin UI. name is the display label (case
-- PRESERVED; the UNIQUE index is COLLATE NOCASE so "Growth"/"growth" can't
-- both exist). color is an optional "#rrggbb" chip accent; sort_order drives
-- pill ordering; created_at is unix-ms. The per-user assignment lives on
-- user_secrets.category_id (added by migrateCategoryId, NOT here, so the
-- clearFull recreate re-adds it via the migration like company).
CREATE TABLE IF NOT EXISTS categories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  color      TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- Legacy per-user daemon build table. Superseded by user_devices (which
-- carries version/arch/last_seen per machine); kept so a server rollback
-- finds its table. No longer read or written.
CREATE TABLE IF NOT EXISTS daemon_status (
  username   TEXT PRIMARY KEY,
  version    TEXT NOT NULL,
  arch       TEXT,
  last_seen  INTEGER NOT NULL
);

-- One row per machine authorized to post as a user. secret_hash is the
-- sha256 of that machine's TOFU secret; /ingest auth passes when the
-- presented hash matches ANY non-revoked row. user_secrets.secret_hash
-- stays mirrored to a SURVIVING active device's hash so a server rollback
-- keeps authenticating. version/arch/last_seen power the per-device fleet
-- view (replacing daemon_status). barred=1 marks a device kicked via the
-- deliberate /devices/revoke path (vs left via uninstall) — its secret can
-- never auto-reclaim the handle, so a revoked machine's still-running
-- daemon can't resurrect itself.
-- watchdog_last_seen is the SECOND liveness channel (docs/resilience.md):
-- stamped only by /watchdog-checkin, never by daemon traffic, so the fleet
-- classifier can tell "daemon wedged, watchdog alive" from "machine dark".
-- NULL = this device never ran a v0.6 watchdog; pre-existing DBs get the
-- column via migrateWatchdogLastSeen.
CREATE TABLE IF NOT EXISTS user_devices (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  username           TEXT NOT NULL,
  secret_hash        TEXT NOT NULL,
  label              TEXT,
  version            TEXT,
  arch               TEXT,
  added_at           INTEGER NOT NULL,
  last_seen          INTEGER,
  revoked_at         INTEGER,
  barred             INTEGER NOT NULL DEFAULT 0,
  watchdog_last_seen INTEGER
);
CREATE INDEX IF NOT EXISTS user_devices_user ON user_devices (username);

-- Tiny KV for server state that must survive restarts
-- (e.g. cursor_watermark_ms, the CursorMirror backfill watermark).
CREATE TABLE IF NOT EXISTS server_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Single-shot remote directives (the zero-touch recovery channel — no MDM,
-- no SSH). An operator enqueues a verb via /admin/directives; the next
-- /checkin, /ingest, or /watchdog-checkin response for that user carries it
-- (delivered_at stamped atomically, so exactly one executor ever receives
-- it) and the executor runs an allowlisted action client-side.
-- v0.6 lifecycle (docs/resilience.md): delivery no longer completes a
-- directive — the executed-ack (POST /directives/ack) does, stamping
-- executed_at/result/executed_by. A delivered-but-never-acked directive
-- re-queues ONCE after DIRECTIVE_TTL_MS (requeued_at records the second
-- eligibility window), then expires. device_id NULL = any of the user's
-- devices may take it; non-NULL pins delivery to one machine. Pre-existing
-- DBs get the new columns via migrateDirectiveLifecycle.
CREATE TABLE IF NOT EXISTS pending_directives (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  username     TEXT NOT NULL,
  verb         TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  delivered_at INTEGER,
  device_id    INTEGER,
  executed_at  INTEGER,
  result       TEXT,
  detail       TEXT,
  executed_by  TEXT,
  requeued_at  INTEGER
);
CREATE INDEX IF NOT EXISTS pending_directives_user
  ON pending_directives (username, delivered_at);

-- Legacy per-user diagnostic log tail. Superseded by diag_logs_v2 (keyed by
-- device, so two laptops no longer overwrite each other); kept so a server
-- rollback finds its table. No longer written; read only as a fallback for
-- pre-migration uploads.
CREATE TABLE IF NOT EXISTS diag_logs (
  username    TEXT PRIMARY KEY,
  uploaded_at INTEGER NOT NULL,
  content     TEXT NOT NULL
);

-- Latest diagnostic log tail per (user, device) — payload of the
-- upload_logs directive. One row per device (a new upload replaces the
-- old) and the route caps the size, so the table never grows past
-- devices × cap.
CREATE TABLE IF NOT EXISTS diag_logs_v2 (
  username    TEXT NOT NULL,
  device_id   INTEGER NOT NULL,
  uploaded_at INTEGER NOT NULL,
  content     TEXT NOT NULL,
  PRIMARY KEY (username, device_id)
);

-- Append-only checkin cadence journal, one row per /checkin ('daemon') or
-- /watchdog-checkin ('watchdog') — cadence gaps are diagnosable after the
-- fact instead of being overwritten by the latest stamp. Capped at
-- CHECKIN_HISTORY_PER_DEVICE rows per device (pruned on insert). uptime_s
-- rides along from CheckinBody so the fleet classifier can spot restarts
-- (uptime resets) without extra columns.
CREATE TABLE IF NOT EXISTS checkin_history (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  username  TEXT NOT NULL,
  device_id INTEGER NOT NULL,
  ts        INTEGER NOT NULL,
  kind      TEXT NOT NULL,
  version   TEXT,
  uptime_s  INTEGER
);
CREATE INDEX IF NOT EXISTS checkin_history_device ON checkin_history (device_id, id);

-- Latest structured checkin body per (device, channel): kind 'daemon'
-- stores a sanitized CheckinBody, kind 'watchdog' a sanitized
-- WatchdogCheckinBody, both as JSON. One row per pair — the fleet
-- classifier only ever needs the newest observation; cadence lives in
-- checkin_history.
CREATE TABLE IF NOT EXISTS device_checkin_state (
  device_id  INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  username   TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  body       TEXT NOT NULL,
  PRIMARY KEY (device_id, kind)
);

-- Failed device-auth attempts (403s on /ingest, /checkin,
-- /watchdog-checkin, /diag/logs). TOFU-secret loss previously vanished
-- without a trace — the daemon retried forever and the server logged
-- nothing durable. Capped at AUTH_FAILURES_MAX rows (pruned on insert);
-- username is the CLAIMED handle (unauthenticated input), never proof.
CREATE TABLE IF NOT EXISTS auth_failures (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  username     TEXT NOT NULL,
  device_label TEXT,
  route        TEXT NOT NULL,
  ts           INTEGER NOT NULL
);

-- One row per fleet alert actually pushed to the operator webhook — the
-- dedup source ("don't re-alert the same device+state within 6h") must
-- survive server restarts or every deploy re-pages the whole dark fleet.
CREATE TABLE IF NOT EXISTS fleet_alerts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id  INTEGER NOT NULL,
  username   TEXT NOT NULL,
  state      TEXT NOT NULL,
  alerted_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS fleet_alerts_device ON fleet_alerts (device_id, state, alerted_at);

-- Sweep-observed classification per device: since = when the current
-- state was first observed, giving the alert sweep its "in state > 1h"
-- gate without re-deriving state history. Updated only by the sweep.
CREATE TABLE IF NOT EXISTS device_fleet_state (
  device_id  INTEGER PRIMARY KEY,
  username   TEXT NOT NULL,
  state      TEXT NOT NULL,
  since      INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Sweep-observed boolean conditions ORTHOGONAL to the FleetState machine
-- (a device can be HEALTHY yet report watchdog_installed=false — the
-- WATCHDOG_MISSING flag). since = first observation of the current streak;
-- the row is deleted the moment the condition clears, so a recurrence
-- starts a fresh "held > 1h" clock. Updated only by the sweep.
CREATE TABLE IF NOT EXISTS device_flag_state (
  device_id  INTEGER NOT NULL,
  flag       TEXT NOT NULL,
  username   TEXT NOT NULL,
  since      INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, flag)
);

-- Anonymous dashboard traffic: one row per HUMAN document load of '/' or
-- '/admin'. Deliberately identity-FREE — no cookie, no visitor id, no IP,
-- no user-agent — so there is nothing here to leak, correlate, or hand back
-- under a subject-access request; ts and path are the whole record.
-- Bot/unfurl loads (Slackbot, WhatsApp, scanners, python-requests) are
-- classified in memory from the UA header, which is then DISCARDED, and are
-- never inserted at all — a bot column would be a persisted claim we could
-- never re-derive or correct once the UA is gone, and every consumer wants
-- the human number anyway, so plain COUNT(*) is the answer.
-- Written in buffered batches by PageViewRecorder (page-views.ts), NEVER
-- inline on the request path: bun:sqlite is synchronous and shares the event
-- loop, so a per-request INSERT would put fsync latency in front of every
-- other in-flight request.
-- Capped at PAGE_VIEWS_MAX rows (pruned once per flush, oldest first) for
-- the same reason auth_failures is: this is the other table whose row count
-- is driven by UNAUTHENTICATED internet traffic. TOKENLEADER_DASHBOARD_TOKEN
-- is optional, so on a default self-host GET / is open to the world, and a
-- scraper sending a browser UA would otherwise append rows without limit to
-- the one file Litestream replicates on every write. Real traffic is ~40
-- loads/day, so the cap is more than a decade of history and no operator
-- will ever meet it; a flood meets it and stops there instead of taking the
-- database (and the admin aggregate's scan time) with it.
CREATE TABLE IF NOT EXISTS page_views (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  ts   INTEGER NOT NULL,
  path TEXT NOT NULL
);
-- Every read is a [since, until) window, so the range predicate should not
-- degrade into a full scan once the table has years in it.
CREATE INDEX IF NOT EXISTS page_views_ts ON page_views (ts);
`;

/**
 * Migration: add `messageType` and key the dedup index by (user, source,
 * messageId, requestId, messageType). Idempotent. The dedup index is
 * rebuilt unconditionally — the old definition lacks messageType and would
 * collide user/assistant rows that share ids.
 */
function migrateMessageType(db: Database): void {
  const cols = db.prepare<{ name: string }, []>("PRAGMA table_info(events)").all();
  const hasCol = cols.some((c) => c.name === "messageType");
  if (!hasCol) {
    // SQLite ALTER TABLE has no IF NOT EXISTS; gated by the PRAGMA check.
    // Default 'assistant' back-fills pre-migration rows correctly.
    db.exec("ALTER TABLE events ADD COLUMN messageType TEXT NOT NULL DEFAULT 'assistant'");
  }
  db.exec("DROP INDEX IF EXISTS events_dedup");
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS events_dedup " +
      "ON events (user, source, messageId, COALESCE(requestId, ''), messageType)",
  );
  // Covers the assistant-only timestamp-range scans on every poll. Lives
  // here (not SCHEMA) because messageType may not exist until the ALTER.
  db.exec("CREATE INDEX IF NOT EXISTS events_ts_type ON events (timestamp, messageType)");
}

/**
 * Migration: add `uninstalled_at` to user_secrets. Idempotent. Non-NULL
 * means the user signaled /events/uninstall: shown as "Recently
 * uninstalled" and eligible for TOFU re-claim on the next /ingest.
 */
function migrateUninstalledAt(db: Database): void {
  const cols = db.prepare<{ name: string }, []>("PRAGMA table_info(user_secrets)").all();
  const hasCol = cols.some((c) => c.name === "uninstalled_at");
  if (!hasCol) {
    db.exec("ALTER TABLE user_secrets ADD COLUMN uninstalled_at INTEGER");
  }
}

/**
 * Migration: add `company` to user_secrets. Idempotent. Nullable —
 * NULL means the user's daemon never sent X-Tokenleader-Company; an
 * absent header never clears a stored value.
 */
function migrateCompany(db: Database): void {
  const cols = db.prepare<{ name: string }, []>("PRAGMA table_info(user_secrets)").all();
  const hasCol = cols.some((c) => c.name === "company");
  if (!hasCol) {
    db.exec("ALTER TABLE user_secrets ADD COLUMN company TEXT");
  }
}

/**
 * Migration: add `category_id` to user_secrets. Idempotent. Nullable —
 * NULL = unassigned. Admin-assigned via POST /admin/users/category; never set
 * from an ingest header (unlike `company`). Bare INTEGER, no REFERENCES (FKs
 * are off); orphan cleanup is manual in deleteCategory. Lives in a migration,
 * not SCHEMA, so the clearFull → exec(SCHEMA) recreate re-adds it here.
 */
function migrateCategoryId(db: Database): void {
  const cols = db.prepare<{ name: string }, []>("PRAGMA table_info(user_secrets)").all();
  const hasCol = cols.some((c) => c.name === "category_id");
  if (!hasCol) {
    db.exec("ALTER TABLE user_secrets ADD COLUMN category_id INTEGER");
  }
}

/**
 * Migration: seed `user_devices` from pre-multi-device rows. Idempotent —
 * only users with ZERO device rows are seeded, so post-migration rotations
 * are never clobbered. The seed device inherits the user's TOFU hash, the
 * legacy daemon_status build info, and (for uninstalled users) a revoked_at
 * matching uninstalled_at — preserving the invariant that an uninstalled
 * user has no active devices.
 */
function migrateUserDevices(db: Database): void {
  db.exec(
    `INSERT INTO user_devices (username, secret_hash, label, version, arch, added_at, last_seen, revoked_at)
     SELECT us.username, us.secret_hash, NULL, ds.version, ds.arch, us.claimed_at, ds.last_seen, us.uninstalled_at
       FROM user_secrets us
       LEFT JOIN daemon_status ds ON ds.username = us.username
      WHERE NOT EXISTS (SELECT 1 FROM user_devices d WHERE d.username = us.username)`,
  );
  // Roll-forward reconcile: if a rollback-window reclaim (old code rotated
  // user_secrets.secret_hash without touching user_devices) left the live
  // device hash absent from this user's rows, re-register it as an active
  // device so the daemon isn't stranded on a 403. Matching ANY row by hash
  // (active OR revoked) keeps a deliberately-revoked secret from being
  // resurrected; no-op for forward-only users (claim/reclaim always wrote a
  // matching row).
  db.exec(
    `INSERT INTO user_devices (username, secret_hash, added_at)
     SELECT us.username, us.secret_hash, us.claimed_at
       FROM user_secrets us
      WHERE us.uninstalled_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM user_devices d
           WHERE d.username = us.username AND d.secret_hash = us.secret_hash)`,
  );
}

/**
 * Migration: add `costUsdMicros` to events. Idempotent. Preserves
 * Cursor-provided cost verbatim; NULL falls back to PricingCache.
 */
function migrateCostUsdMicros(db: Database): void {
  const cols = db.prepare<{ name: string }, []>("PRAGMA table_info(events)").all();
  if (!cols.some((c) => c.name === "costUsdMicros")) {
    db.exec("ALTER TABLE events ADD COLUMN costUsdMicros INTEGER");
  }
}

/**
 * Migration: add `watchdog_last_seen` to user_devices (the second liveness
 * channel, stamped only by /watchdog-checkin). Idempotent. NULL back-fills
 * pre-migration rows correctly: those devices have never sent a watchdog
 * checkin, which is exactly what NULL means to the fleet classifier.
 */
function migrateWatchdogLastSeen(db: Database): void {
  const cols = db.prepare<{ name: string }, []>("PRAGMA table_info(user_devices)").all();
  if (!cols.some((c) => c.name === "watchdog_last_seen")) {
    db.exec("ALTER TABLE user_devices ADD COLUMN watchdog_last_seen INTEGER");
  }
}

/**
 * Migration: add the v0.6 lifecycle columns to pending_directives
 * (device targeting + executed-ack + one-shot re-queue). Idempotent; all
 * nullable, so pre-migration rows keep their exact delivery semantics
 * until acked or expired.
 */
function migrateDirectiveLifecycle(db: Database): void {
  const cols = db.prepare<{ name: string }, []>("PRAGMA table_info(pending_directives)").all();
  const have = new Set(cols.map((c) => c.name));
  const wanted: Array<[string, string]> = [
    ["device_id", "INTEGER"],
    ["executed_at", "INTEGER"],
    ["result", "TEXT"],
    ["detail", "TEXT"],
    ["executed_by", "TEXT"],
    ["requeued_at", "INTEGER"],
  ];
  for (const [name, type] of wanted) {
    if (!have.has(name)) {
      db.exec(`ALTER TABLE pending_directives ADD COLUMN ${name} ${type}`);
    }
  }
}

export interface ModelRow {
  model: string;
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  reasoning: number;
  count: number;
  /**
   * SUM(costUsdMicros) for this model bucket. 0 → no stored cost, callers
   * price via PricingCache; non-zero → use the stored value and skip
   * PricingCache for this bucket.
   */
  storedCostMicros: number;
}

export interface UserTotalsRow {
  user: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  totalReasoningTokens: number;
}

export interface LeaderboardAdminRow extends UserTotalsRow {
  eventCount: number;
  lastEventAt: number;
  modelCount: number;
  userMessages: number;
  assistantMessages: number;
  /** Normalized company domain from user_secrets; null = never reported. */
  company: string | null;
  /** Assigned category (admin-defined); null when unassigned or undefined. */
  categoryId: number | null;
  categoryName: string | null;
  categoryColor: string | null;
}

/** Per-user message counts (assistant + user) — the user-row counts the
 *  token aggregates exclude. */
export interface UserMessageCountsRow {
  user: string;
  userMessages: number;
  assistantMessages: number;
}

export interface ModelAggRow {
  model: string;
  count: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
  /** See ModelRow.storedCostMicros for semantics. */
  storedCostMicros: number;
}

/** One (user, model) aggregate group — the single-pass replacement for the
 *  admin route's former per-user userByModel loop + adminByModel scan. */
export interface UserModelAggRow extends ModelAggRow {
  user: string;
}

export interface RecentEventRow {
  id: number;
  user: string;
  source: string;
  model: string;
  timestamp: number;
  totalTokens: number;
  messageType: string;
}

/** Per-(bucket, model) aggregate used by /stats/timeseries.
 *  Restricted to assistant rows so token totals stay meaningful. */
export interface TimeseriesModelRow {
  bucketKey: string; // strftime output, e.g. "2026-05-11" / "2026-W19" / "2026-05"
  model: string;
  events: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
  storedCostMicros: number;
}

/** Per-(bucket, user, model) aggregate for the byUser timeseries breakdown.
 *  Assistant rows only. */
export interface TimeseriesUserModelRow {
  bucketKey: string;
  user: string;
  model: string;
  events: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
  storedCostMicros: number;
}

/**
 * Per-bucket message-count aggregate (counts only, no tokens). Includes both
 * user and assistant rows so the dashboard can plot user-vs-assistant.
 */
export interface TimeseriesBucketCountsRow {
  bucketKey: string;
  userMessages: number;
  assistantMessages: number;
}

/** Per-(bucket, user) message-count aggregate. */
export interface TimeseriesUserCountsRow {
  bucketKey: string;
  user: string;
  userMessages: number;
  assistantMessages: number;
}

export type Bucket = "day" | "week" | "month";

export interface DbSizeRow {
  page_count: number;
  page_size: number;
}

export interface LastEventRow {
  ts: number | null;
}

export interface UserSecretRow {
  secret_hash: string;
  uninstalled_at: number | null;
}

export interface ClaimedUserRow {
  username: string;
  claimed_at: number;
}

/** A category definition row joined with its live assignment count. The
 *  COUNT comes from a LEFT JOIN so a zero-assignment category still appears
 *  (assigned_count 0); the UI gates filter pills on assigned_count >= 1. */
export interface CategoryRow {
  id: number;
  name: string;
  color: string | null;
  sort_order: number;
  assigned_count: number;
}

/** Roster row for GET /admin/users: every claimed user plus their current
 *  category_id (seeds the assignment dropdown's defaultValue). Never carries
 *  secret_hash, so the roster cannot leak a credential. */
export interface ClaimedUserWithCategoryRow {
  username: string;
  claimed_at: number;
  category_id: number | null;
}

export interface UninstalledUserRow {
  username: string;
  uninstalled_at: number;
}

export interface UserDeviceRow {
  id: number;
  username: string;
  secret_hash: string;
  label: string | null;
  version: string | null;
  arch: string | null;
  added_at: number;
  last_seen: number | null;
  revoked_at: number | null;
  barred: number;
  watchdog_last_seen: number | null;
}

interface DirectiveRow {
  id: number;
  verb: string;
}

export interface DirectiveListRow {
  id: number;
  verb: string;
  device_id: number | null;
  device_label: string | null;
  created_at: number;
  delivered_at: number | null;
  executed_at: number | null;
  result: string | null;
  detail: string | null;
  executed_by: string | null;
  requeued_at: number | null;
}

/** Directive lifecycle: executed (acked) > delivered (awaiting ack) >
 *  expired (aged out of its eligibility window, incl. the one re-queue) >
 *  pending. Derived, never stored — the timestamps are the truth. */
export function directiveState(
  row: Pick<DirectiveListRow, "created_at" | "delivered_at" | "executed_at" | "requeued_at">,
  now: number,
): "pending" | "delivered" | "executed" | "expired" {
  if (row.executed_at !== null) return "executed";
  if (row.delivered_at !== null) return "delivered";
  if ((row.requeued_at ?? row.created_at) <= now - DIRECTIVE_TTL_MS) return "expired";
  return "pending";
}

interface DiagLogRow {
  uploaded_at: number;
  content: string;
}

interface DiagLogV2Row {
  device_id: number;
  uploaded_at: number;
  content: string;
}

export interface CheckinHistoryRow {
  ts: number;
  kind: string;
  version: string | null;
  uptime_s: number | null;
}

export interface AuthFailureRow {
  username: string;
  device_label: string | null;
  route: string;
  ts: number;
}

/** One buffered document load on its way to `page_views`. Carries no
 *  viewer identity by construction — there is nowhere to put one. */
export interface PageViewRow {
  ts: number;
  path: string;
}

/** Page views per UTC day, ascending ("YYYY-MM-DD"). */
export interface PageViewDayRow {
  day: string;
  views: number;
}

/** Page views per path, busiest first. */
export interface PageViewPathRow {
  path: string;
  views: number;
}

// A directive older than this is stale — the machine it targeted was
// offline the whole window, so silently running it days later would be a
// surprise, not a recovery. Undelivered + expired rows are simply skipped.
// A DELIVERED directive that was never acked re-queues once after the same
// window (requeued_at restarts eligibility), then expires for good.
export const DIRECTIVE_TTL_MS = 24 * 60 * 60 * 1000;

/** checkin_history cap, per device (prune-on-insert). 500 daemon rows ≈
 *   41h of 5-min ticks; watchdog rows share the same cap per device. */
const CHECKIN_HISTORY_PER_DEVICE = 500;

/** auth_failures cap, global (prune-on-insert). Forensics, not analytics —
 *  the recent trace is what matters. */
const AUTH_FAILURES_MAX = 1000;

/** page_views cap, global (pruned once per FLUSH, not per row — the flush is
 *  already the one transaction, so the cap is free). ~200k rows is ~7 MB with
 *  the ts index and, at the ~40 loads/day this table actually sees, more than
 *  a decade of history; it exists only so an open instance being crawled
 *  cannot grow the replicated DB without bound. Oldest rows go first, which
 *  is also the right trade under a flood: recent counts stay truthful. */
export const PAGE_VIEWS_MAX = 200_000;

/** Actions an operator may enqueue. Enforced at the /admin route AND
 *  re-checked by each executor's own allowlist before running: the daemon
 *  handles restart/upload_logs; the v0.6 watchdog additionally executes
 *  reinstall_watchdog, sample, and upload_state (docs/resilience.md) —
 *  the server only validates membership here. */
export const DIRECTIVE_VERBS = [
  "restart",
  "upload_logs",
  "reinstall_watchdog",
  "sample",
  "upload_state",
] as const;
export type DirectiveVerb = (typeof DIRECTIVE_VERBS)[number];

/** Verbs ONLY the watchdog executor can run (`sample` needs a live process
 *  outside the wedged daemon; `upload_state` reads the watchdog's own state
 *  file). A daemon handed one would terminally ack it 'failed: unknown
 *  verb' before the watchdog ever saw it — takeDirective keeps them off
 *  daemon channels. Everything else is available to BOTH executors: the
 *  watchdog can restart/upload_logs too, and reinstall_watchdog from the
 *  watchdog harmlessly re-enables its own label. */
export const WATCHDOG_ONLY_VERBS = ["sample", "upload_state"] as const;

/** Camel-cased device row for API surfaces; never carries the hash. */
export interface DeviceInfo {
  id: number;
  label: string | null;
  version: string | null;
  arch: string | null;
  addedAt: number;
  lastSeen: number | null;
  /** Last /watchdog-checkin stamp; null = never (pre-0.6 device). */
  watchdogLastSeen: number | null;
}

/** Default exclusive upper bound for "lifetime" ranges. 2^53-1 ms ≈ year
 *  287,396 — effectively +infinity. */
export const MAX_TS_MS = Number.MAX_SAFE_INTEGER;

/** server_meta key for the CursorMirror backfill watermark (the only
 *  cursor-owned key); clearFull deletes it so cleared history re-imports. */
export const CURSOR_WATERMARK_META_KEY = "cursor_watermark_ms";

function deviceInfo(r: UserDeviceRow): DeviceInfo {
  return {
    id: r.id,
    label: r.label,
    version: r.version,
    arch: r.arch,
    addedAt: r.added_at,
    lastSeen: r.last_seen,
    watchdogLastSeen: r.watchdog_last_seen,
  };
}

/** Company scope: restrict to events whose user is claimed under the given
 *  company (user_secrets.company, from X-Tokenleader-Company). A fixed
 *  string spliced into the *ForCompany statement variants — never user
 *  input, so this is splice-safe. */
const COMPANY_SCOPE = "AND user IN (SELECT username FROM user_secrets WHERE company = ?)";
/** Restrict to users assigned to a given category id (peer of COMPANY_SCOPE). */
const CATEGORY_SCOPE = "AND user IN (SELECT username FROM user_secrets WHERE category_id = ?)";

/**
 * The INTEGER sums the rollup audit compares between events and
 * events_roll_day, PER USER. `n` is COUNT(*) vs SUM(events).
 *
 * The first seven are the token/cost totals. The last three exist because
 * those seven alone are blind to any edit that moves rows between rollup
 * CELLS without changing a user's totals — and those are the likeliest hand
 * edits of all:
 *
 *   dsum  SUM(day)          catches a timestamp correction that moves rows
 *                           to other day buckets (and the negative-timestamp
 *                           truncation class rollDayOf exists to prevent).
 *   asst  assistant rows    catches a messageType flip, which rewrites the
 *                           user/assistant split while summing to the same
 *                           tokens (user rows carry zero of everything).
 *   mfp   model fingerprint catches a model-id rename — a real thing this
 *                           repo has done — which otherwise leaves the
 *                           dashboard serving the OLD name, priced by
 *                           whatever that string resolves to, forever.
 *
 * All three are plain aggregates over the same single covering-index scan
 * (GROUP BY user rides events_user_cover, no temp b-tree), which is why they
 * are affordable where a real cell-level comparison is not: an exhaustive
 * two-way EXCEPT against events_roll_day measures ~10s at 5M rows, i.e.
 * dearer than simply rebuilding.
 *
 * mfp is a FINGERPRINT, not a proof: three cheap features of the model
 * string (length, first codepoint, last codepoint). It catches every
 * realistic rename, including same-length version bumps, but two different
 * model ids can collide. The honest recovery for anything the audit cannot
 * see is the unconditional rebuild — see POST /admin/rollup-audit.
 */
interface RollAuditRow {
  user: string;
  n: number;
  i: number;
  o: number;
  cc: number;
  cr: number;
  rt: number;
  cost: number;
  dsum: number;
  asst: number;
  mfp: number;
}

/** Per-raw-row model fingerprint. On the rollup side each cell stands for
 *  `events` identical rows, so that side multiplies by `events`. Bounded by
 *  a few thousand per row, so the SUM stays far inside 2^53 even at 100M
 *  rows. `unicode('')` is NULL (user rows carry model=''), hence COALESCE. */
const MODEL_FP_SQL =
  "(length(model) * 131 + COALESCE(unicode(model), 0) * 17 + COALESCE(unicode(substr(model, -1)), 0))";

/** The connection's steady-state temp_store. Every window aggregation is
 *  bounded by the rollup's row count now, so keeping its scratch in RAM is
 *  cheap. rebuildRollup() is the one exception and flips to FILE around
 *  itself — see there for the OOM this avoids. */
const TEMP_STORE = "MEMORY";

/** Result of Store.auditRollup(). `mismatched` names the users whose sums
 *  disagree (or that exist on only one side) — the useful thing to log.
 *  `auditMs` is the compare pass; `rebuildMs` is the (much dearer) repair. */
export interface RollAudit {
  ok: boolean;
  rebuilt: boolean;
  auditMs: number;
  rebuildMs: number;
  users: number;
  mismatched: string[];
}

const DAY_MS = 86_400_000;

/**
 * UTC day index of an epoch-ms timestamp — FLOOR division, deliberately.
 *
 * validateEvent gates `timestamp` with isFiniteInt, not isNonNegInt, so
 * /ingest accepts negative timestamps today. SQLite's integer division
 * truncates TOWARD ZERO while JS's Math.floor rounds toward -inf, so the
 * obvious `timestamp / 86400000` in SQL disagrees with this function for
 * every negative timestamp — and the boot audit would NOT catch it, because
 * putting a row in the wrong DAY cell leaves every per-user total intact.
 * Both sides floor, and both go through these two definitions.
 */
const rollDayOf = (tsMs: number): number => Math.floor(tsMs / DAY_MS);
/** SQL peer of rollDayOf(). Splices a column/expression, never user input. */
const rollDaySql = (col: string): string =>
  `((${col} - ((${col} % ${DAY_MS}) + ${DAY_MS}) % ${DAY_MS}) / ${DAY_MS})`;

/**
 * Split a half-open `[since, until)` ms window into the whole UTC days the
 * rollup already holds plus at most two partial-day slivers read from raw
 * events, as the six positional parameters every rollup statement takes:
 *
 *   ?1 dayLo, ?2 dayHi    interior, `day >= ?1 AND day < ?2`
 *   ?3 .. ?4              leading sliver,  `timestamp >= ?3 AND < ?4`
 *   ?5 .. ?6              trailing sliver, `timestamp >= ?5 AND < ?6`
 *
 * The half-open contract (an event at ts===since is IN, at ts===until is
 * OUT) is decided entirely here: by the exact `>= / <` predicates on the
 * slivers and by the integer day bounds on the interior.
 *
 * Every view that is actually slow is day-aligned and therefore costs ZERO
 * sliver rows: all-time (since=0), the SPA's contribution grid
 * (since = Date.UTC(year, 0, 1)) and the month pills. `range=Nd` snaps
 * `since` to the minute, so it pays exactly one leading partial day.
 *
 * THE KNOWN RESIDUAL, recorded so the next person does not rediscover it as
 * "the rollup regressed": that leading sliver is the only surviving O(events)
 * term on a read path, and it is read through events_ts_type, which is NOT
 * covering for the token columns, so each matched row costs a rowid lookup
 * into the ~950 MB table. Measured at ~8us/row (12,914 rows in 102ms cold on
 * a 10M-row fixture). At prod's ~67k events/day a full-day sliver is ~0.5s,
 * and unlike everything else here it grows with the INGEST rate. It is
 * confined to the 7D/30D pills. If it ever becomes the bottleneck the two
 * cheap moves are to add the summed token columns to events_ts_type (making
 * the sliver covering, at index-size cost) or to keep an hour-grain rollup
 * for the current day.
 */
function rollWindow(
  sinceMs: number,
  untilMs: number,
): [number, number, number, number, number, number] {
  // `+ 0` normalises Math.ceil's -0 (e.g. sinceMs = -1000) to a plain 0,
  // so the bound parameter is an integer.
  const dayLo = Math.ceil(sinceMs / DAY_MS) + 0;
  const dayHi = Math.floor(untilMs / DAY_MS) + 0;
  if (dayHi <= dayLo) {
    // Degenerate (until <= since) or wholly inside one UTC day: no day is
    // fully covered, so the interior is empty and there is exactly ONE
    // sliver — never two overlapping ones double-counting the window.
    return [0, 0, sinceMs, Math.max(untilMs, sinceMs), 0, 0];
  }
  return [dayLo, dayHi, sinceMs, dayLo * DAY_MS, dayHi * DAY_MS, untilMs];
}

/** strftime formats for the three bucket grains. UTC ('unixepoch'), so
 *  labels never shift with the server's timezone. Weeks are ISO 8601
 *  (%G-W%V, Monday start): %W has a week-zero edge case and %U is
 *  Sunday-based. */
const BUCKET_FMT: Record<Bucket, string> = {
  day: "%Y-%m-%d",
  week: "%G-W%V",
  month: "%Y-%m",
};

/**
 * The rollup-backed FROM clause: the pre-aggregated interior plus the two
 * raw-event slivers, normalised to one column shape
 * `(bucketKey?, user, model, messageType, events, <5 token sums>,
 *   storedCostMicros, maxTimestamp)`.
 *
 * `bucket` non-null adds a bucketKey column. Day grain rolls up to week and
 * month EXACTLY because a UTC day lies wholly inside one ISO week and one
 * calendar month — that is the whole reason a single day-grain table can
 * serve all three. Both branches derive the label from the same floored day
 * (rollDaySql), so interior and sliver agree on every timestamp.
 *
 * That is a deliberate behaviour change for PRE-EPOCH timestamps: the old
 * statements bucketed by `strftime(fmt, timestamp/1000)`, and SQLite's
 * truncating division pushed an event in the last 999ms before a pre-1970
 * UTC midnight into the FOLLOWING day's label. It is unreachable through
 * the API — parseStatsRange rejects a negative `since`, and the default
 * window starts at 0 — but the rollup has to pick one answer for both
 * branches, and the correct one is the true UTC day.
 *
 * `where` is an extra predicate pushed into BOTH branches (not applied
 * outside the union) so the raw-events branch keeps an index-seek plan on
 * `user`, and so the rollup branch can use events_roll_day_user.
 *
 * Every argument is a compile-time constant from this file — never user
 * input — so the splicing is safe.
 */
function rollSource(bucket: Bucket | null, where = ""): string {
  const key = (secondsExpr: string) =>
    bucket === null
      ? ""
      : `strftime('${BUCKET_FMT[bucket]}', ${secondsExpr}, 'unixepoch') AS bucketKey,\n              `;
  // events=1 per raw row; the two nullable columns COALESCE to the rollup's
  // NOT NULL shape; timestamp is that row's own maxTimestamp.
  const sliver = (
    from: string,
    to: string,
  ) => `SELECT ${key(`${rollDaySql("timestamp")} * 86400`)}user, model, messageType,
              1 AS events, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens,
              COALESCE(reasoningTokens, 0) AS reasoningTokens,
              COALESCE(costUsdMicros, 0)   AS storedCostMicros,
              timestamp                    AS maxTimestamp
         FROM events
        WHERE timestamp >= ${from} AND timestamp < ${to} ${where}`;
  return `SELECT ${key("day * 86400")}user, model, messageType,
              events, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens,
              reasoningTokens, storedCostMicros, maxTimestamp
         FROM events_roll_day
        WHERE day >= ?1 AND day < ?2 ${where}
        UNION ALL
       ${sliver("?3", "?4")}
        UNION ALL
       ${sliver("?5", "?6")}`;
}

/** Peers of COMPANY_SCOPE / CATEGORY_SCOPE for rollup statements, which
 *  bind positionally (?1..?6 are the window) so the scope value is ?7. */
const COMPANY_SCOPE_7 = "AND user IN (SELECT username FROM user_secrets WHERE company = ?7)";
const CATEGORY_SCOPE_7 = "AND user IN (SELECT username FROM user_secrets WHERE category_id = ?7)";
const USER_SCOPE_7 = "AND user = ?7";
/** Restrict to assistant rows, pushed into both union branches. */
const ASSISTANT_ONLY = "AND messageType = 'assistant'";

/** The six positional window parameters rollWindow() produces. */
type RollWindowArgs = [number, number, number, number, number, number];

/**
 * Per-(user, model) aggregate over `[since, until)` for `/api/v1`.
 * Assistant rows only — user-message rows have zero tokens and no model.
 */
export interface ApiUsageRow {
  user: string;
  model: string;
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  reasoning: number;
  storedCostMicros: number;
}

/**
 * SQLite-backed event store.
 *
 * Range contract: all `(sinceMs, untilMs)` parameters are half-open
 * `[since, until)` unix-ms UTC — an event at `timestamp === since` is in,
 * an event at `timestamp === until` is out. `untilMs` defaults to MAX_TS_MS.
 */
export class Store {
  readonly db: Database;
  private readonly insertStmt: Statement;
  private readonly deleteCursorLocalInSpanStmt: Statement<
    { day: number },
    [Record<string, string | number>]
  >;
  private readonly countStmt: Statement<{ c: number }>;
  private readonly userTotalsStmt: Statement<UserTotalsRow, [...RollWindowArgs, string]>;
  private readonly userByModelStmt: Statement<ModelRow, [...RollWindowArgs, string]>;
  private readonly leaderboardStmt: Statement<UserTotalsRow, RollWindowArgs>;
  private readonly adminLeaderboardStmt: Statement<LeaderboardAdminRow, RollWindowArgs>;
  private readonly adminLeaderboardForCompanyStmt: Statement<
    LeaderboardAdminRow,
    [...RollWindowArgs, string]
  >;
  private readonly adminLeaderboardForCategoryStmt: Statement<
    LeaderboardAdminRow,
    [...RollWindowArgs, number]
  >;
  private readonly adminUserModelStmt: Statement<UserModelAggRow, RollWindowArgs>;
  private readonly adminRecentStmt: Statement<RecentEventRow>;
  private readonly adminRecentForCompanyStmt: Statement<RecentEventRow, [string, number]>;
  private readonly adminRecentForCategoryStmt: Statement<RecentEventRow, [number, number]>;
  private readonly listCompaniesStmt: Statement<{ company: string }, []>;
  // --- categories CRUD + per-user assignment + roster ---
  private readonly listCategoriesStmt: Statement<CategoryRow, []>;
  private readonly createCategoryStmt: Statement;
  private readonly renameCategoryStmt: Statement;
  private readonly deleteCategoryStmt: Statement;
  private readonly clearCategoryAssignmentsStmt: Statement;
  private readonly getCategoryByIdStmt: Statement<{ id: number }, [number]>;
  private readonly setUserCategoryStmt: Statement;
  private readonly getUserCategoryStmt: Statement<{ category_id: number | null }, [string]>;
  private readonly listClaimedUsersWithCategoryStmt: Statement<ClaimedUserWithCategoryRow, []>;
  private readonly dbSizeStmt: Statement<DbSizeRow>;
  private readonly lastEventStmt: Statement<LastEventRow>;
  private readonly getUserSecretStmt: Statement<UserSecretRow>;
  private readonly claimUserSecretStmt: Statement;
  private readonly listClaimedUsersStmt: Statement<ClaimedUserRow>;
  private readonly markUserUninstalledStmt: Statement;
  private readonly clearUninstalledAtStmt: Statement;
  private readonly updateUserSecretHashStmt: Statement;
  private readonly repointUserSecretHashStmt: Statement;
  private readonly listUninstalledUsersStmt: Statement<UninstalledUserRow>;
  private readonly listUserDevicesStmt: Statement<UserDeviceRow, [string]>;
  private readonly listUserDevicesAllStmt: Statement<UserDeviceRow, [string]>;
  private readonly listFleetDevicesStmt: Statement<UserDeviceRow, []>;
  private readonly insertDeviceStmt: Statement;
  private readonly revokeDeviceStmt: Statement;
  private readonly revokeAllDevicesStmt: Statement;
  private readonly deviceCheckInStmt: Statement;
  private readonly setDeviceLabelStmt: Statement;
  private readonly watchdogCheckInStmt: Statement;
  private readonly enqueueDirectiveStmt: Statement;
  private readonly requeueDirectivesStmt: Statement;
  private readonly takeDirectiveStmt: Statement<DirectiveRow, [Record<string, string | number>]>;
  private readonly ackDirectiveStmt: Statement;
  private readonly directiveOwnerStmt: Statement<{ id: number }, [number, string]>;
  private readonly hasRecentDirectiveStmt: Statement<
    { id: number },
    [Record<string, string | number>]
  >;
  private readonly listDirectivesStmt: Statement<DirectiveListRow, [string, number]>;
  private readonly getDiagLogStmt: Statement<DiagLogRow, [string]>;
  private readonly saveDiagLogV2Stmt: Statement;
  private readonly getDiagLogV2Stmt: Statement<DiagLogV2Row, [string, number]>;
  private readonly latestDiagLogV2Stmt: Statement<DiagLogV2Row, [string]>;
  private readonly appendCheckinHistoryStmt: Statement;
  private readonly pruneCheckinHistoryStmt: Statement;
  private readonly recentCheckinHistoryStmt: Statement<CheckinHistoryRow, [number, string, number]>;
  private readonly saveDeviceCheckinStateStmt: Statement;
  private readonly getDeviceCheckinStateStmt: Statement<
    { updated_at: number; body: string },
    [number, string]
  >;
  private readonly insertAuthFailureStmt: Statement;
  private readonly pruneAuthFailuresStmt: Statement;
  private readonly listAuthFailuresStmt: Statement<AuthFailureRow, [number]>;
  private readonly listAuthFailuresForUserStmt: Statement<AuthFailureRow, [string, number]>;
  private readonly insertPageViewStmt: Statement;
  private readonly prunePageViewsStmt: Statement;
  private readonly countPageViewsStmt: Statement<{ views: number }, [number, number]>;
  private readonly pageViewsByDayStmt: Statement<PageViewDayRow, [number, number]>;
  private readonly pageViewsByPathStmt: Statement<PageViewPathRow, [number, number]>;
  private readonly lastFleetAlertStmt: Statement<{ alerted_at: number }, [number, string]>;
  private readonly insertFleetAlertStmt: Statement;
  private readonly getDeviceFleetStateStmt: Statement<{ state: string; since: number }, [number]>;
  private readonly upsertDeviceFleetStateStmt: Statement;
  private readonly getDeviceFlagStmt: Statement<{ since: number }, [number, string]>;
  private readonly upsertDeviceFlagStmt: Statement;
  private readonly clearDeviceFlagStmt: Statement;
  private readonly setUserCompanyStmt: Statement;
  private readonly getUserCompanyStmt: Statement<{ company: string | null }, [string]>;
  private readonly userMessageCountsAllStmt: Statement<UserMessageCountsRow, RollWindowArgs>;
  private readonly userMessageCountsForUserStmt: Statement<
    UserMessageCountsRow,
    [...RollWindowArgs, string]
  >;
  // Timeseries: one prepared statement per (bucket × user-filter) shape.
  // The strftime() format string and the scope clause are spliced in from
  // fixed allow-lists (never user input), so this is splice-safe. Every one
  // takes the six rollWindow() parameters, plus the scope value as ?7 where
  // the shape has one.
  private readonly tsByModelStmts: Record<Bucket, Statement<TimeseriesModelRow, RollWindowArgs>>;
  private readonly tsByModelForUserStmts: Record<
    Bucket,
    Statement<TimeseriesModelRow, [...RollWindowArgs, string]>
  >;
  private readonly tsByModelForCompanyStmts: Record<
    Bucket,
    Statement<TimeseriesModelRow, [...RollWindowArgs, string]>
  >;
  private readonly tsByUserStmts: Record<Bucket, Statement<TimeseriesUserModelRow, RollWindowArgs>>;
  private readonly tsByUserForCompanyStmts: Record<
    Bucket,
    Statement<TimeseriesUserModelRow, [...RollWindowArgs, string]>
  >;
  private readonly tsCountsByBucketStmts: Record<
    Bucket,
    Statement<TimeseriesBucketCountsRow, RollWindowArgs>
  >;
  private readonly tsCountsByBucketForUserStmts: Record<
    Bucket,
    Statement<TimeseriesBucketCountsRow, [...RollWindowArgs, string]>
  >;
  private readonly tsCountsByBucketForCompanyStmts: Record<
    Bucket,
    Statement<TimeseriesBucketCountsRow, [...RollWindowArgs, string]>
  >;
  private readonly tsCountsByUserStmts: Record<
    Bucket,
    Statement<TimeseriesUserCountsRow, RollWindowArgs>
  >;
  private readonly tsCountsByUserForCompanyStmts: Record<
    Bucket,
    Statement<TimeseriesUserCountsRow, [...RollWindowArgs, string]>
  >;
  private readonly apiUsageRangeStmt: Statement<ApiUsageRow, RollWindowArgs>;
  private readonly getMetaStmt: Statement<{ value: string }, [string]>;
  private readonly setMetaStmt: Statement;
  // --- events_roll_day maintenance ---
  private readonly rollUpsertStmt: Statement;
  private readonly rollMarkDirtyStmt: Statement;
  private readonly rollListDirtyStmt: Statement<{ user: string; day: number }, []>;
  private readonly rollClearDirtyStmt: Statement;
  private readonly rollDropCellStmt: Statement;
  private readonly rollRebuildCellStmt: Statement;
  private readonly rollDistinctUsersStmt: Statement<{ user: string }, []>;
  private readonly rollRebuildUserStmt: Statement;
  private readonly rollAuditEventsStmt: Statement<RollAuditRow, []>;
  private readonly rollAuditRollupStmt: Statement<RollAuditRow, []>;

  constructor(path: string) {
    const abs = resolve(path);
    mkdirSync(dirname(abs), { recursive: true });
    this.db = new Database(abs, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    // cache_size is negative-KiB (~64 MB hot pages); mmap lets cold reads
    // skip the page-cache copy; temp_store=MEMORY keeps GROUP BY / ORDER BY
    // scratch out of temp files.
    this.db.exec("PRAGMA cache_size = -65536;");
    // bun's bundled SQLite clamps mmap_size at 1 GiB (a larger request
    // reads back 1073741824) — ask for exactly the cap.
    this.db.exec("PRAGMA mmap_size = 1073741824;");
    this.db.exec(`PRAGMA temp_store = ${TEMP_STORE};`);
    this.db.exec(SCHEMA);
    migrateMessageType(this.db);
    migrateUninstalledAt(this.db);
    migrateCompany(this.db);
    migrateCategoryId(this.db);
    migrateCostUsdMicros(this.db);
    migrateWatchdogLastSeen(this.db);
    migrateUserDevices(this.db);
    migrateDirectiveLifecycle(this.db);
    // Covering index for the dashboard aggregations (admin leaderboard's
    // per-user cost pass, /stats?user=, the grouped user-model pass):
    // every column those sums touch lives in the index, so the planner
    // never does rowid lookups back into the wide rows. Created here (not
    // in SCHEMA) because messageType/costUsdMicros may not exist until the
    // migrations above have run. ~12% of the events table on disk; one-time
    // multi-second build on first boot after upgrade.
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS events_user_cover ON events (user, timestamp, messageType, model,
         inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, reasoningTokens, costUsdMicros);`,
    );
    // Retire indexes superseded by events_user_cover / events_ts_type.
    // Their CREATE lines are gone from SCHEMA, so this never fights a
    // rebuild on the next boot.
    this.db.exec("DROP INDEX IF EXISTS events_user_ts;");
    this.db.exec("DROP INDEX IF EXISTS events_ts;");
    // events_model_ts is dead: no statement in db.ts / main.ts / api-v1.ts
    // has a model-leading access path (/stats/admin?model= scopes in JS off
    // the grouped user-model pass), and dropping it leaves every EXPLAIN
    // QUERY PLAN byte-identical.
    //
    // events_user_model is *nearly* dead: it is never used as (user, model)
    // — only as a cheap user-leading index by clearUserEvents and the
    // company-scoped adminRecent, which fall back to the equally
    // user-leading events_dedup (measured 23.1ms -> 25.0ms on the latter, a
    // once-per-filtered-admin-call statement). That is worth paying: on a
    // 5M-row DB the pair costs ~306 MB of index against ~950 MB of table
    // and 36% of the /ingest write path (8.4us -> 5.4us per row), which is
    // the headroom the rollup maintenance below spends.
    //
    // The freed pages go on the sqlite FREELIST; the file is NOT truncated,
    // so /stats/admin's dbSizeBytes (page_count * page_size) does not move —
    // measured 2020.3 MiB before and after on a 5.1M-row fixture. What is
    // bought is ~306 MB of future writes landing in reclaimed pages instead
    // of growing the volume. An operator who wants the space back has to
    // VACUUM, which needs ~2x free disk and minutes at this size.
    this.db.exec("DROP INDEX IF EXISTS events_model_ts;");
    this.db.exec("DROP INDEX IF EXISTS events_user_model;");
    // Planner statistics are mandatory for the covering index: without a
    // sqlite_stat1 row the planner stays on timestamp-leading indexes
    // (measured 4.9s vs 2.1s on 3.6M rows). analysis_limit bounds the
    // per-index sample so this adds ~1-2s to boot, not a full scan.
    this.db.exec("PRAGMA analysis_limit = 1000;");
    this.db.exec("ANALYZE;");

    // --- events_roll_day maintenance (see the DDL in SCHEMA) ---
    // One UPSERT per (day, user, model, messageType) group of an /ingest
    // batch, run inside insertMany's transaction so the rollup is atomic
    // with the events it summarises — and rides Litestream for free,
    // because it lives in the one replicated file.
    this.rollUpsertStmt = this.db.prepare(
      `INSERT INTO events_roll_day (day, user, model, messageType, events, inputTokens,
            outputTokens, cacheCreationTokens, cacheReadTokens, reasoningTokens,
            storedCostMicros, maxTimestamp)
       VALUES ($day, $user, $model, $messageType, $events, $inputTokens,
               $outputTokens, $cacheCreationTokens, $cacheReadTokens, $reasoningTokens,
               $storedCostMicros, $maxTimestamp)
       ON CONFLICT (day, user, model, messageType) DO UPDATE SET
         events              = events              + excluded.events,
         inputTokens         = inputTokens         + excluded.inputTokens,
         outputTokens        = outputTokens        + excluded.outputTokens,
         cacheCreationTokens = cacheCreationTokens + excluded.cacheCreationTokens,
         cacheReadTokens     = cacheReadTokens     + excluded.cacheReadTokens,
         reasoningTokens     = reasoningTokens     + excluded.reasoningTokens,
         storedCostMicros    = storedCostMicros    + excluded.storedCostMicros,
         maxTimestamp        = MAX(maxTimestamp, excluded.maxTimestamp)`,
    );
    this.rollMarkDirtyStmt = this.db.prepare(
      "INSERT OR IGNORE INTO events_roll_dirty (user, day) VALUES (?, ?)",
    );
    this.rollListDirtyStmt = this.db.prepare<{ user: string; day: number }, []>(
      "SELECT user, day FROM events_roll_dirty ORDER BY user, day",
    );
    this.rollClearDirtyStmt = this.db.prepare(
      "DELETE FROM events_roll_dirty WHERE user = ? AND day = ?",
    );
    this.rollDropCellStmt = this.db.prepare(
      "DELETE FROM events_roll_day WHERE user = ? AND day = ?",
    );
    // Recompute one (user, day) cell from raw events. Bounded by one user's
    // traffic on one day; rides events_user_cover, so no rowid lookups.
    this.rollRebuildCellStmt = this.db.prepare(
      `INSERT INTO events_roll_day
       SELECT ${rollDaySql("timestamp")}, user, model, messageType, COUNT(*),
              SUM(inputTokens), SUM(outputTokens), SUM(cacheCreationTokens),
              SUM(cacheReadTokens), SUM(COALESCE(reasoningTokens, 0)),
              SUM(COALESCE(costUsdMicros, 0)), MAX(timestamp)
         FROM events
        WHERE user = ? AND timestamp >= ? AND timestamp < ?
        GROUP BY 1, 2, 3, 4`,
    );
    // The two halves of the chunked rebuild (see rebuildRollup for why it is
    // chunked at all). DISTINCT over the leading column of events_user_cover
    // is one covering scan with no sort; the per-user INSERT is the same
    // shape as rollRebuildCellStmt without the day bound.
    this.rollDistinctUsersStmt = this.db.prepare<{ user: string }, []>(
      "SELECT DISTINCT user FROM events ORDER BY user",
    );
    this.rollRebuildUserStmt = this.db.prepare(
      `INSERT INTO events_roll_day
       SELECT ${rollDaySql("timestamp")}, user, model, messageType, COUNT(*),
              SUM(inputTokens), SUM(outputTokens), SUM(cacheCreationTokens),
              SUM(cacheReadTokens), SUM(COALESCE(reasoningTokens, 0)),
              SUM(COALESCE(costUsdMicros, 0)), MAX(timestamp)
         FROM events
        WHERE user = ?
        GROUP BY 1, 2, 3, 4`,
    );
    // The audit: the RollAuditRow columns PER USER, which must agree between
    // the two tables. Per-user rather than grand totals, because the
    // divergence worth catching — a hand-run `UPDATE events SET user = ...`
    // merge — preserves every grand total while moving rows between users.
    // Grouping by user is nearly free anyway: events_user_cover is
    // user-leading, so the scan emits groups in order with no temp B-tree,
    // and dsum/asst/mfp ride that same scan (see RollAuditRow for what each
    // buys, and for what the audit still cannot see).
    //
    // COUNT(*) alone would not be enough either: it misses any divergence
    // that preserves row counts, including the negative-timestamp
    // truncation class that a wrong day expression would produce.
    this.rollAuditEventsStmt = this.db.prepare<RollAuditRow, []>(
      `SELECT user, COUNT(*) AS n,
              COALESCE(SUM(inputTokens),0)         AS i,
              COALESCE(SUM(outputTokens),0)        AS o,
              COALESCE(SUM(cacheCreationTokens),0) AS cc,
              COALESCE(SUM(cacheReadTokens),0)     AS cr,
              COALESCE(SUM(reasoningTokens),0)     AS rt,
              COALESCE(SUM(costUsdMicros),0)       AS cost,
              COALESCE(SUM(${rollDaySql("timestamp")}),0)                        AS dsum,
              COALESCE(SUM(CASE WHEN messageType='assistant' THEN 1 ELSE 0 END),0) AS asst,
              COALESCE(SUM(${MODEL_FP_SQL}),0)                                   AS mfp
         FROM events GROUP BY user ORDER BY user`,
    );
    this.rollAuditRollupStmt = this.db.prepare<RollAuditRow, []>(
      `SELECT user, COALESCE(SUM(events),0)           AS n,
              COALESCE(SUM(inputTokens),0)            AS i,
              COALESCE(SUM(outputTokens),0)           AS o,
              COALESCE(SUM(cacheCreationTokens),0)    AS cc,
              COALESCE(SUM(cacheReadTokens),0)        AS cr,
              COALESCE(SUM(reasoningTokens),0)        AS rt,
              COALESCE(SUM(storedCostMicros),0)       AS cost,
              COALESCE(SUM(day * events),0)                                            AS dsum,
              COALESCE(SUM(CASE WHEN messageType='assistant' THEN events ELSE 0 END),0) AS asst,
              COALESCE(SUM(${MODEL_FP_SQL} * events),0)                                AS mfp
         FROM events_roll_day GROUP BY user ORDER BY user`,
    );
    // Boot audit. The rollup is authoritative, so a maintenance path that
    // silently stopped maintaining it would serve wrong numbers forever;
    // this is the only thing that catches that. It costs one covering-index
    // scan — measured as +1.8s on a 5.1M-row boot that already takes 7.5s
    // in migrations and ANALYZE — and it must NEVER be put on a timer,
    // because bun:sqlite is synchronous and would block the event loop.
    //
    // This scan is now the ONLY O(events) cost left in the system: every
    // read path is O(days x users x models). It therefore doubles with the
    // events table like the old aggregations did, which is why its elapsed
    // ms is logged (see auditRollup) rather than left to be rediscovered.
    this.auditRollup({ repair: true });

    this.insertStmt = this.db.prepare(
      `INSERT INTO events (user, source, sessionId, messageId, requestId, timestamp,
                           model, messageType, inputTokens, outputTokens, cacheCreationTokens,
                           cacheReadTokens, reasoningTokens, costUsdMicros, ingestedAt)
       VALUES ($user, $source, $sessionId, $messageId, $requestId, $timestamp,
               $model, $messageType, $inputTokens, $outputTokens, $cacheCreationTokens,
               $cacheReadTokens, $reasoningTokens, $costUsdMicros, $ingestedAt)
       ON CONFLICT DO NOTHING`,
    );
    // Cloud `cursor` timestamps (per-request epoch-ms) and `cursor_local`
    // timestamps (composer createdAt / DB mtime) are never byte-equal, so the
    // reconcile keys on a coarser span: drop a user's cursor_local assistant
    // rows that fall inside the [min, max] timestamp span of that user's
    // incoming cloud `cursor` events. Inclusive bounds — a local row exactly
    // at an edge is covered by the cloud data.
    // RETURNING the deleted rows' UTC day is what keeps the repair cheap:
    // the rollup must be invalidated for exactly the (user, day) cells that
    // lost rows, and those are only knowable from the rows themselves. The
    // obvious alternative — dirty every day in [min, max] — is correct but
    // degenerates when a cloud Cursor sync drains an all-time backfill and
    // the span becomes the user's entire history.
    this.deleteCursorLocalInSpanStmt = this.db.prepare<
      { day: number },
      [Record<string, string | number>]
    >(
      `DELETE FROM events
       WHERE user = $user AND source = 'cursor_local' AND messageType = 'assistant'
         AND timestamp BETWEEN $min AND $max
       RETURNING ${rollDaySql("timestamp")} AS day`,
    );
    this.countStmt = this.db.prepare<{ c: number }, []>("SELECT COUNT(*) AS c FROM events");
    // Token-aggregation queries restrict to messageType='assistant': user
    // rows carry zero tokens and no model, and would inflate event/model
    // counts. User-vs-assistant counts come from the message-count queries.
    //
    // From here down every window-scoped aggregation reads events_roll_day
    // (plus the two partial-day slivers) instead of events. The transform is
    // mechanical — COUNT(*) becomes SUM(events), SUM(col) stays SUM(col),
    // MAX(timestamp) becomes MAX(maxTimestamp) — and it is EXACT because
    // every summed column is an INTEGER, so pre-adding them changes no
    // float. The float pricing in main.ts runs unchanged on top, at the same
    // granularity, in the same order.
    this.userTotalsStmt = this.db.prepare<UserTotalsRow, [...RollWindowArgs, string]>(
      `SELECT user,
              COALESCE(SUM(inputTokens), 0)         AS totalInputTokens,
              COALESCE(SUM(outputTokens), 0)        AS totalOutputTokens,
              COALESCE(SUM(cacheCreationTokens), 0) AS totalCacheCreationTokens,
              COALESCE(SUM(cacheReadTokens), 0)     AS totalCacheReadTokens,
              COALESCE(SUM(reasoningTokens), 0)     AS totalReasoningTokens
         FROM (${rollSource(null, `${USER_SCOPE_7} ${ASSISTANT_ONLY}`)})
        GROUP BY user`,
    );
    // TIE ORDER, and why these two suffixes are what they are.
    //
    // A token-sum tie is not exotic: any two users whose in-window rows are
    // all messageType='user' both total 0, and the 7d/30d pills produce
    // those constantly. The old statements left the tie to the plan, and the
    // plan is exactly what this change replaced (one index scan became a
    // three-branch UNION ALL feeding a temp b-tree), so the emitted order
    // moved with it. Measured on the 5,099,335-row prod-shaped fixture with
    // nine tied users injected: `main` emits them ASCENDING, the rerouted
    // statement emitted them DESCENDING — a real payload divergence on the
    // same data, on /stats/admin's default view.
    //
    // So the tie keys below are not a preference, they are transcriptions of
    // what prod emits today: `user ASC` for the two per-user sorts, and
    // `model DESC` for the per-model one (both trees already agree there, at
    // both fixture scales). They also matter beyond array order —
    // /stats/leaderboard and /stats/admin accumulate `usd +=` over these
    // rows in emission order, and float addition is not associative.
    //
    // Note `main`'s own order here is plan-dependent (the same nine users
    // come out DESCENDING on a nine-row test DB and ASCENDING on the
    // prod-shaped one), so byte-parity with `main` at every scale is not a
    // thing that exists. Prod's order is the one the constraint protects,
    // and it is now pinned rather than emergent. rollup.test.ts pins it.
    this.userByModelStmt = this.db.prepare<ModelRow, [...RollWindowArgs, string]>(
      `SELECT model,
              COALESCE(SUM(inputTokens), 0)         AS input,
              COALESCE(SUM(outputTokens), 0)        AS output,
              COALESCE(SUM(cacheCreationTokens), 0) AS cacheCreation,
              COALESCE(SUM(cacheReadTokens), 0)     AS cacheRead,
              COALESCE(SUM(reasoningTokens), 0)     AS reasoning,
              COALESCE(SUM(events), 0)              AS count,
              COALESCE(SUM(storedCostMicros), 0)    AS storedCostMicros
         FROM (${rollSource(null, `${USER_SCOPE_7} ${ASSISTANT_ONLY}`)})
        GROUP BY model
        ORDER BY (input + output + cacheCreation + cacheRead) DESC, model DESC`,
    );
    this.leaderboardStmt = this.db.prepare<UserTotalsRow, RollWindowArgs>(
      `SELECT user,
              COALESCE(SUM(inputTokens), 0)         AS totalInputTokens,
              COALESCE(SUM(outputTokens), 0)        AS totalOutputTokens,
              COALESCE(SUM(cacheCreationTokens), 0) AS totalCacheCreationTokens,
              COALESCE(SUM(cacheReadTokens), 0)     AS totalCacheReadTokens,
              COALESCE(SUM(reasoningTokens), 0)     AS totalReasoningTokens
         FROM (${rollSource(null, ASSISTANT_ONLY)})
        GROUP BY user
        ORDER BY (totalInputTokens + totalOutputTokens
                  + totalCacheCreationTokens + totalCacheReadTokens) DESC, user ASC`,
    );
    // Token sums + counts restricted to assistant rows via CASE in one
    // scan; lastEventAt spans both kinds ("last seen" = any activity).
    // LEFT JOIN user_secrets (PK lookup per group) carries the company
    // affiliation; users without a claim row read company NULL.
    // One SELECT body, three scoped variants (base / company / category). The
    // LEFT JOINs carry company + the assigned category (id/name/color) per
    // row; an optional scope clause narrows to one company or one category.
    // modelCount stays exact under pre-aggregation only because `model` is
    // a KEY of the rollup, never summed away: COUNT(DISTINCT model) is not
    // additively decomposable, so summing per-day distinct counts would
    // over-count any model a user touched on more than one day.
    // lastEventAt likewise needs MAX(maxTimestamp) — counts cannot rebuild
    // it — and spans BOTH message kinds ("last seen" = any activity).
    const adminLeaderboardSql = (scope: string): string =>
      `SELECT user,
              COALESCE(SUM(CASE WHEN messageType='assistant' THEN inputTokens         ELSE 0 END), 0) AS totalInputTokens,
              COALESCE(SUM(CASE WHEN messageType='assistant' THEN outputTokens        ELSE 0 END), 0) AS totalOutputTokens,
              COALESCE(SUM(CASE WHEN messageType='assistant' THEN cacheCreationTokens ELSE 0 END), 0) AS totalCacheCreationTokens,
              COALESCE(SUM(CASE WHEN messageType='assistant' THEN cacheReadTokens     ELSE 0 END), 0) AS totalCacheReadTokens,
              COALESCE(SUM(CASE WHEN messageType='assistant' THEN reasoningTokens     ELSE 0 END), 0) AS totalReasoningTokens,
              SUM(CASE WHEN messageType='assistant' THEN events ELSE 0 END)                           AS eventCount,
              SUM(CASE WHEN messageType='user'      THEN events ELSE 0 END)                           AS userMessages,
              SUM(CASE WHEN messageType='assistant' THEN events ELSE 0 END)                           AS assistantMessages,
              COALESCE(MAX(maxTimestamp), 0)                                                          AS lastEventAt,
              COUNT(DISTINCT CASE WHEN messageType='assistant' THEN model END)                        AS modelCount,
              us.company                                                                              AS company,
              us.category_id                                                                          AS categoryId,
              cat.name                                                                                AS categoryName,
              cat.color                                                                               AS categoryColor
         FROM (${rollSource(null, scope)}) AS src
         LEFT JOIN user_secrets us ON us.username = src.user
         LEFT JOIN categories cat ON cat.id = us.category_id
        GROUP BY user
        ORDER BY (totalInputTokens + totalOutputTokens
                  + totalCacheCreationTokens + totalCacheReadTokens) DESC, user ASC`;
    this.adminLeaderboardStmt = this.db.prepare<LeaderboardAdminRow, RollWindowArgs>(
      adminLeaderboardSql(""),
    );
    // Scoped variants: the six window params plus the scope value as ?7.
    this.adminLeaderboardForCompanyStmt = this.db.prepare<
      LeaderboardAdminRow,
      [...RollWindowArgs, string]
    >(adminLeaderboardSql(COMPANY_SCOPE_7));
    this.adminLeaderboardForCategoryStmt = this.db.prepare<
      LeaderboardAdminRow,
      [...RollWindowArgs, number]
    >(adminLeaderboardSql(CATEGORY_SCOPE_7));
    // One pass over (user, model) groups feeds BOTH the admin leaderboard's
    // per-user cost and the byModel aggregate (summed across users in JS) —
    // replaces the former per-leaderboard-row userByModel N+1 plus a
    // separate adminByModel scan. Company/category scoping happens in JS by
    // intersecting with the scoped adminLeaderboard user set (equivalent:
    // any user with in-window events appears in that set).
    // ORDER BY user, model is explicit here (the old statement had none and
    // relied on SQLite's GROUP BY temp b-tree emitting in group-key order).
    // main.ts accumulates `usdByUser` and `modelAgg` in emission order with
    // `+=` on floats, and float addition is not associative — so the order
    // is part of the payload contract, and it should be written down rather
    // than inherited from a plan that a future index could change.
    this.adminUserModelStmt = this.db.prepare<UserModelAggRow, RollWindowArgs>(
      `SELECT user, model,
              COALESCE(SUM(events), 0)              AS count,
              COALESCE(SUM(inputTokens), 0)         AS inputTokens,
              COALESCE(SUM(outputTokens), 0)        AS outputTokens,
              COALESCE(SUM(cacheCreationTokens), 0) AS cacheCreationTokens,
              COALESCE(SUM(cacheReadTokens), 0)     AS cacheReadTokens,
              COALESCE(SUM(reasoningTokens), 0)     AS reasoningTokens,
              COALESCE(SUM(storedCostMicros), 0)    AS storedCostMicros
         FROM (${rollSource(null, ASSISTANT_ONLY)})
        GROUP BY user, model
        ORDER BY user ASC, model ASC`,
    );
    // Message-count queries — both kinds; no token sums.
    this.userMessageCountsAllStmt = this.db.prepare<UserMessageCountsRow, RollWindowArgs>(
      `SELECT user,
              SUM(CASE WHEN messageType='user'      THEN events ELSE 0 END) AS userMessages,
              SUM(CASE WHEN messageType='assistant' THEN events ELSE 0 END) AS assistantMessages
         FROM (${rollSource(null)})
        GROUP BY user`,
    );
    this.userMessageCountsForUserStmt = this.db.prepare<
      UserMessageCountsRow,
      [...RollWindowArgs, string]
    >(
      `SELECT user,
              SUM(CASE WHEN messageType='user'      THEN events ELSE 0 END) AS userMessages,
              SUM(CASE WHEN messageType='assistant' THEN events ELSE 0 END) AS assistantMessages
         FROM (${rollSource(null, USER_SCOPE_7)})
        GROUP BY user`,
    );
    this.adminRecentStmt = this.db.prepare<RecentEventRow, [number]>(
      `SELECT id, user, source, model, timestamp, messageType,
              (inputTokens + outputTokens + cacheCreationTokens
                + cacheReadTokens + COALESCE(reasoningTokens, 0)) AS totalTokens
         FROM events
        ORDER BY id DESC
        LIMIT ?`,
    );
    // Company variant has no range predicate, so the scope clause opens the
    // WHERE itself (strip the leading "AND ").
    this.adminRecentForCompanyStmt = this.db.prepare<RecentEventRow, [string, number]>(
      `SELECT id, user, source, model, timestamp, messageType,
              (inputTokens + outputTokens + cacheCreationTokens
                + cacheReadTokens + COALESCE(reasoningTokens, 0)) AS totalTokens
         FROM events
        WHERE ${COMPANY_SCOPE.slice("AND ".length)}
        ORDER BY id DESC
        LIMIT ?`,
    );
    // Category variant has no range predicate either, so the scope clause
    // opens the WHERE itself (strip the leading "AND "). (categoryId, limit).
    this.adminRecentForCategoryStmt = this.db.prepare<RecentEventRow, [number, number]>(
      `SELECT id, user, source, model, timestamp, messageType,
              (inputTokens + outputTokens + cacheCreationTokens
                + cacheReadTokens + COALESCE(reasoningTokens, 0)) AS totalTokens
         FROM events
        WHERE ${CATEGORY_SCOPE.slice("AND ".length)}
        ORDER BY id DESC
        LIMIT ?`,
    );
    // The dashboard's company-filter pills: every distinct non-null company
    // across ALL users — deliberately never filtered by the company param.
    this.listCompaniesStmt = this.db.prepare<{ company: string }, []>(
      "SELECT DISTINCT company FROM user_secrets WHERE company IS NOT NULL ORDER BY company",
    );
    // --- categories CRUD ---
    // listCategories carries assigned_count (LEFT JOIN so a zero-assignment
    // category still appears, count 0) — drives pill-gating in the UI.
    this.listCategoriesStmt = this.db.prepare<CategoryRow, []>(
      `SELECT c.id, c.name, c.color, c.sort_order,
              COUNT(us.username) AS assigned_count
         FROM categories c
         LEFT JOIN user_secrets us ON us.category_id = c.id
        GROUP BY c.id
        ORDER BY c.sort_order ASC, c.name ASC`,
    );
    this.createCategoryStmt = this.db.prepare(
      "INSERT INTO categories (name, color, sort_order, created_at) VALUES ($name, $color, $sort, $created_at)",
    );
    this.renameCategoryStmt = this.db.prepare(
      "UPDATE categories SET name = $name, color = $color WHERE id = $id",
    );
    this.deleteCategoryStmt = this.db.prepare("DELETE FROM categories WHERE id = ?");
    this.clearCategoryAssignmentsStmt = this.db.prepare(
      "UPDATE user_secrets SET category_id = NULL WHERE category_id = ?",
    );
    this.getCategoryByIdStmt = this.db.prepare<{ id: number }, [number]>(
      "SELECT id FROM categories WHERE id = ?",
    );
    // --- per-user assignment (UPDATE-only; NO upsert — the row must already
    // exist, and the route 404s unknown users) ---
    this.setUserCategoryStmt = this.db.prepare(
      "UPDATE user_secrets SET category_id = $cid WHERE username = $u",
    );
    this.getUserCategoryStmt = this.db.prepare<{ category_id: number | null }, [string]>(
      "SELECT category_id FROM user_secrets WHERE username = ?",
    );
    // --- roster for the assignment table (carries category_id; never selects
    // secret_hash) ---
    this.listClaimedUsersWithCategoryStmt = this.db.prepare<ClaimedUserWithCategoryRow, []>(
      "SELECT username, claimed_at, category_id FROM user_secrets ORDER BY claimed_at ASC",
    );
    this.dbSizeStmt = this.db.prepare<DbSizeRow, []>(
      "SELECT (SELECT page_count FROM pragma_page_count) AS page_count, " +
        "(SELECT page_size FROM pragma_page_size) AS page_size",
    );
    this.lastEventStmt = this.db.prepare<LastEventRow, []>(
      "SELECT MAX(timestamp) AS ts FROM events",
    );
    this.getUserSecretStmt = this.db.prepare<UserSecretRow, [string]>(
      "SELECT secret_hash, uninstalled_at FROM user_secrets WHERE username = ?",
    );
    this.claimUserSecretStmt = this.db.prepare(
      `INSERT OR IGNORE INTO user_secrets (username, secret_hash, claimed_at)
       VALUES ($username, $secret_hash, $claimed_at)`,
    );
    this.listClaimedUsersStmt = this.db.prepare<ClaimedUserRow, []>(
      "SELECT username, claimed_at FROM user_secrets ORDER BY claimed_at ASC",
    );
    this.markUserUninstalledStmt = this.db.prepare(
      `UPDATE user_secrets SET uninstalled_at = $uninstalled_at
        WHERE username = $username`,
    );
    this.clearUninstalledAtStmt = this.db.prepare(
      "UPDATE user_secrets SET uninstalled_at = NULL WHERE username = $username",
    );
    // /ingest re-claim path: rotate the stored hash + clear uninstalled_at
    // in a single update.
    this.updateUserSecretHashStmt = this.db.prepare(
      `UPDATE user_secrets
          SET secret_hash    = $secret_hash,
              claimed_at     = $claimed_at,
              uninstalled_at = NULL
        WHERE username = $username`,
    );
    // Re-point the rollback mirror to a surviving device's hash (no
    // claimed_at / uninstalled_at change) when the mirrored device is
    // revoked but others remain.
    this.repointUserSecretHashStmt = this.db.prepare(
      "UPDATE user_secrets SET secret_hash = $secret_hash WHERE username = $username",
    );
    this.listUninstalledUsersStmt = this.db.prepare<UninstalledUserRow, []>(
      `SELECT username, uninstalled_at FROM user_secrets
        WHERE uninstalled_at IS NOT NULL
        ORDER BY uninstalled_at DESC`,
    );
    this.listUserDevicesStmt = this.db.prepare<UserDeviceRow, [string]>(
      `SELECT * FROM user_devices
        WHERE username = ? AND revoked_at IS NULL
        ORDER BY added_at ASC, id ASC`,
    );
    this.listUserDevicesAllStmt = this.db.prepare<UserDeviceRow, [string]>(
      "SELECT * FROM user_devices WHERE username = ? ORDER BY added_at ASC, id ASC",
    );
    this.listFleetDevicesStmt = this.db.prepare<UserDeviceRow, []>(
      `SELECT * FROM user_devices
        WHERE revoked_at IS NULL
        ORDER BY username ASC, added_at ASC, id ASC`,
    );
    this.insertDeviceStmt = this.db.prepare(
      `INSERT INTO user_devices (username, secret_hash, label, added_at)
       VALUES ($username, $secret_hash, $label, $added_at)`,
    );
    this.revokeDeviceStmt = this.db.prepare(
      `UPDATE user_devices SET revoked_at = $revoked_at
        WHERE id = $id AND username = $username AND revoked_at IS NULL`,
    );
    this.revokeAllDevicesStmt = this.db.prepare(
      `UPDATE user_devices SET revoked_at = $revoked_at
        WHERE username = $username AND revoked_at IS NULL`,
    );
    // Every authed ingest stamps last_seen; version/arch only overwrite
    // with real values (old daemons omit the headers).
    this.deviceCheckInStmt = this.db.prepare(
      `UPDATE user_devices
          SET last_seen = $last_seen,
              version   = COALESCE($version, version),
              arch      = COALESCE($arch, arch)
        WHERE id = $id`,
    );
    this.setDeviceLabelStmt = this.db.prepare(
      "UPDATE user_devices SET label = $label WHERE id = $id AND label IS NULL",
    );
    // The watchdog channel stamps ONLY watchdog_last_seen — never last_seen,
    // version, or arch: those describe the daemon, and blending the channels
    // would blind the "daemon silent, watchdog alive" (WEDGED) classifier.
    this.watchdogCheckInStmt = this.db.prepare(
      "UPDATE user_devices SET watchdog_last_seen = $now WHERE id = $id",
    );
    this.enqueueDirectiveStmt = this.db.prepare(
      `INSERT INTO pending_directives (username, verb, created_at, device_id)
       VALUES ($username, $verb, $created_at, $device_id)`,
    );
    // The one-shot re-queue: delivered but never acked for a full TTL →
    // eligible again exactly once (requeued_at both restarts the
    // eligibility window and marks the retry as spent).
    this.requeueDirectivesStmt = this.db.prepare(
      `UPDATE pending_directives
          SET delivered_at = NULL, requeued_at = $now
        WHERE username = $username
          AND delivered_at IS NOT NULL
          AND executed_at IS NULL
          AND requeued_at IS NULL
          AND delivered_at <= $expired`,
    );
    // Single-statement claim: the subquery + UPDATE…RETURNING is atomic in
    // SQLite, so with several devices posting under one handle exactly one
    // of them receives each directive. device_id NULL = any device may
    // take; non-NULL rows are only handed to the targeted device. The
    // channel dimension keeps watchdog-only verbs off daemon handouts —
    // the daemon would terminally ack them before the watchdog ever saw
    // them; the watchdog itself may take ANY verb. WATCHDOG_ONLY_VERBS is
    // a fixed const list — never user input, so the splice is safe.
    this.takeDirectiveStmt = this.db.prepare(
      `UPDATE pending_directives
          SET delivered_at = $now
        WHERE id = (SELECT id FROM pending_directives
                     WHERE username = $username
                       AND delivered_at IS NULL
                       AND executed_at IS NULL
                       AND (device_id IS NULL OR device_id = $device_id)
                       AND (verb NOT IN (${WATCHDOG_ONLY_VERBS.map((v) => `'${v}'`).join(", ")})
                            OR $channel = 'watchdog')
                       AND COALESCE(requeued_at, created_at) > $cutoff
                     ORDER BY id
                     LIMIT 1)
        RETURNING id, verb`,
    );
    // First ack wins (executed_at IS NULL guard); replays are reported as
    // duplicates by ackDirective, never overwrites.
    this.ackDirectiveStmt = this.db.prepare(
      `UPDATE pending_directives
          SET executed_at = $now, result = $result, detail = $detail,
              executed_by = $executed_by
        WHERE id = $id AND username = $username AND executed_at IS NULL`,
    );
    this.directiveOwnerStmt = this.db.prepare(
      "SELECT id FROM pending_directives WHERE id = ? AND username = ?",
    );
    // Heal-loop guard for the alert sweep: is there already a live (or
    // recently executed) directive of this verb aimed at this device?
    this.hasRecentDirectiveStmt = this.db.prepare(
      `SELECT id FROM pending_directives
        WHERE username = $username
          AND verb = $verb
          AND (device_id IS NULL OR device_id = $device_id)
          AND ((executed_at IS NULL AND COALESCE(requeued_at, created_at) > $cutoff)
               OR executed_at > $recent)
        LIMIT 1`,
    );
    this.listDirectivesStmt = this.db.prepare(
      `SELECT p.id, p.verb, p.device_id, d.label AS device_label, p.created_at,
              p.delivered_at, p.executed_at, p.result, p.detail, p.executed_by,
              p.requeued_at
         FROM pending_directives p
         LEFT JOIN user_devices d ON d.id = p.device_id
        WHERE p.username = ?
        ORDER BY p.id DESC
        LIMIT ?`,
    );
    this.getDiagLogStmt = this.db.prepare(
      "SELECT uploaded_at, content FROM diag_logs WHERE username = ?",
    );
    this.saveDiagLogV2Stmt = this.db.prepare(
      `INSERT INTO diag_logs_v2 (username, device_id, uploaded_at, content)
       VALUES ($username, $device_id, $uploaded_at, $content)
       ON CONFLICT (username, device_id) DO UPDATE
         SET uploaded_at = excluded.uploaded_at, content = excluded.content`,
    );
    this.getDiagLogV2Stmt = this.db.prepare(
      "SELECT device_id, uploaded_at, content FROM diag_logs_v2 WHERE username = ? AND device_id = ?",
    );
    this.latestDiagLogV2Stmt = this.db.prepare(
      `SELECT device_id, uploaded_at, content FROM diag_logs_v2
        WHERE username = ?
        ORDER BY uploaded_at DESC, rowid DESC
        LIMIT 1`,
    );
    this.appendCheckinHistoryStmt = this.db.prepare(
      `INSERT INTO checkin_history (username, device_id, ts, kind, version, uptime_s)
       VALUES ($username, $device_id, $ts, $kind, $version, $uptime_s)`,
    );
    this.pruneCheckinHistoryStmt = this.db.prepare(
      `DELETE FROM checkin_history
        WHERE device_id = $device_id
          AND id NOT IN (SELECT id FROM checkin_history
                          WHERE device_id = $device_id
                          ORDER BY id DESC
                          LIMIT $keep)`,
    );
    this.recentCheckinHistoryStmt = this.db.prepare(
      `SELECT ts, kind, version, uptime_s FROM checkin_history
        WHERE device_id = ? AND kind = ?
        ORDER BY id DESC
        LIMIT ?`,
    );
    this.saveDeviceCheckinStateStmt = this.db.prepare(
      `INSERT INTO device_checkin_state (device_id, kind, username, updated_at, body)
       VALUES ($device_id, $kind, $username, $updated_at, $body)
       ON CONFLICT (device_id, kind) DO UPDATE
         SET username = excluded.username, updated_at = excluded.updated_at,
             body = excluded.body`,
    );
    this.getDeviceCheckinStateStmt = this.db.prepare(
      "SELECT updated_at, body FROM device_checkin_state WHERE device_id = ? AND kind = ?",
    );
    this.insertAuthFailureStmt = this.db.prepare(
      `INSERT INTO auth_failures (username, device_label, route, ts)
       VALUES ($username, $device_label, $route, $ts)`,
    );
    this.pruneAuthFailuresStmt = this.db.prepare(
      `DELETE FROM auth_failures
        WHERE id NOT IN (SELECT id FROM auth_failures ORDER BY id DESC LIMIT $keep)`,
    );
    this.listAuthFailuresStmt = this.db.prepare(
      `SELECT username, device_label, route, ts FROM auth_failures
        ORDER BY id DESC
        LIMIT ?`,
    );
    this.listAuthFailuresForUserStmt = this.db.prepare(
      `SELECT username, device_label, route, ts FROM auth_failures
        WHERE username = ?
        ORDER BY id DESC
        LIMIT ?`,
    );
    this.insertPageViewStmt = this.db.prepare(
      "INSERT INTO page_views (ts, path) VALUES ($ts, $path)",
    );
    // Same job as pruneAuthFailuresStmt, different shape on purpose: at a
    // 200k cap the `id NOT IN (SELECT … LIMIT $keep)` form would materialize
    // 200k ids on every flush. This walks the PK index backwards to the
    // cap'th row and deletes everything at or below it — the cost is one
    // index seek when the table is under cap (i.e. always, in practice),
    // and the subquery yields NULL then, so nothing matches and nothing is
    // deleted. AUTOINCREMENT guarantees id order == insertion order.
    this.prunePageViewsStmt = this.db.prepare(
      `DELETE FROM page_views
        WHERE id <= (SELECT id FROM page_views ORDER BY id DESC LIMIT 1 OFFSET $keep)`,
    );
    this.countPageViewsStmt = this.db.prepare(
      "SELECT COUNT(*) AS views FROM page_views WHERE ts >= ? AND ts < ?",
    );
    // strftime over 'unixepoch' is UTC, matching the events timeseries
    // buckets below — a day label must not shift with the server's local
    // timezone.
    this.pageViewsByDayStmt = this.db.prepare(
      `SELECT strftime('%Y-%m-%d', ts/1000, 'unixepoch') AS day, COUNT(*) AS views
         FROM page_views
        WHERE ts >= ? AND ts < ?
        GROUP BY day
        ORDER BY day ASC`,
    );
    this.pageViewsByPathStmt = this.db.prepare(
      `SELECT path, COUNT(*) AS views
         FROM page_views
        WHERE ts >= ? AND ts < ?
        GROUP BY path
        ORDER BY views DESC, path ASC`,
    );
    this.lastFleetAlertStmt = this.db.prepare(
      `SELECT alerted_at FROM fleet_alerts
        WHERE device_id = ? AND state = ?
        ORDER BY alerted_at DESC
        LIMIT 1`,
    );
    this.insertFleetAlertStmt = this.db.prepare(
      `INSERT INTO fleet_alerts (device_id, username, state, alerted_at)
       VALUES ($device_id, $username, $state, $alerted_at)`,
    );
    this.getDeviceFleetStateStmt = this.db.prepare(
      "SELECT state, since FROM device_fleet_state WHERE device_id = ?",
    );
    this.upsertDeviceFleetStateStmt = this.db.prepare(
      `INSERT INTO device_fleet_state (device_id, username, state, since, updated_at)
       VALUES ($device_id, $username, $state, $since, $updated_at)
       ON CONFLICT (device_id) DO UPDATE
         SET username = excluded.username, state = excluded.state,
             since = excluded.since, updated_at = excluded.updated_at`,
    );
    this.getDeviceFlagStmt = this.db.prepare(
      "SELECT since FROM device_flag_state WHERE device_id = ? AND flag = ?",
    );
    this.upsertDeviceFlagStmt = this.db.prepare(
      `INSERT INTO device_flag_state (device_id, flag, username, since, updated_at)
       VALUES ($device_id, $flag, $username, $since, $updated_at)
       ON CONFLICT (device_id, flag) DO UPDATE
         SET username = excluded.username, since = excluded.since,
             updated_at = excluded.updated_at`,
    );
    this.clearDeviceFlagStmt = this.db.prepare(
      "DELETE FROM device_flag_state WHERE device_id = ? AND flag = ?",
    );
    // UPDATE (not upsert): /ingest only calls this after a successful
    // claim/auth, so the user_secrets row always exists.
    this.setUserCompanyStmt = this.db.prepare(
      "UPDATE user_secrets SET company = $company WHERE username = $username",
    );
    this.getUserCompanyStmt = this.db.prepare<{ company: string | null }, [string]>(
      "SELECT company FROM user_secrets WHERE username = ?",
    );

    // Timeseries. All four shapes read the rollup; the bucket label comes
    // from strftime over the floored day (rollSource), so day grain serves
    // week and month too — a UTC day lies wholly inside one ISO week and
    // one calendar month, which is exactly why one day-grain table is
    // enough. This is also why `bucket=month`, previously the single
    // slowest endpoint, is now no dearer than `bucket=day`: cost tracks
    // rollup rows scanned, not events.
    const byModelSql = (b: Bucket, scope: string) =>
      `SELECT bucketKey,
              model,
              COALESCE(SUM(events), 0)              AS events,
              COALESCE(SUM(inputTokens), 0)         AS inputTokens,
              COALESCE(SUM(outputTokens), 0)        AS outputTokens,
              COALESCE(SUM(cacheCreationTokens), 0) AS cacheCreationTokens,
              COALESCE(SUM(cacheReadTokens), 0)     AS cacheReadTokens,
              COALESCE(SUM(reasoningTokens), 0)     AS reasoningTokens,
              COALESCE(SUM(storedCostMicros), 0)    AS storedCostMicros
         FROM (${rollSource(b, `${scope} ${ASSISTANT_ONLY}`)})
        GROUP BY bucketKey, model
        ORDER BY bucketKey ASC, model ASC`;
    // `ORDER BY ..., model ASC` is explicit here (the old statement stopped
    // at `user`): main.ts sums costUsd per (bucket, user) with `+=` over
    // this stream, so its float total depends on the emission order of the
    // model rows inside each group. Inherited-from-the-plan is not a
    // contract; written down is.
    const byUserSql = (b: Bucket, scope: string) =>
      `SELECT bucketKey,
              user,
              model,
              COALESCE(SUM(events), 0)              AS events,
              COALESCE(SUM(inputTokens), 0)         AS inputTokens,
              COALESCE(SUM(outputTokens), 0)        AS outputTokens,
              COALESCE(SUM(cacheCreationTokens), 0) AS cacheCreationTokens,
              COALESCE(SUM(cacheReadTokens), 0)     AS cacheReadTokens,
              COALESCE(SUM(reasoningTokens), 0)     AS reasoningTokens,
              COALESCE(SUM(storedCostMicros), 0)    AS storedCostMicros
         FROM (${rollSource(b, `${scope} ${ASSISTANT_ONLY}`)})
        GROUP BY bucketKey, user, model
        ORDER BY bucketKey ASC, user ASC, model ASC`;
    // Message-count timeseries (both kinds; no token sums).
    const countsByBucketSql = (b: Bucket, scope: string) =>
      `SELECT bucketKey,
              SUM(CASE WHEN messageType='user'      THEN events ELSE 0 END) AS userMessages,
              SUM(CASE WHEN messageType='assistant' THEN events ELSE 0 END) AS assistantMessages
         FROM (${rollSource(b, scope)})
        GROUP BY bucketKey
        ORDER BY bucketKey ASC`;
    const countsByUserSql = (b: Bucket, scope: string) =>
      `SELECT bucketKey,
              user,
              SUM(CASE WHEN messageType='user'      THEN events ELSE 0 END) AS userMessages,
              SUM(CASE WHEN messageType='assistant' THEN events ELSE 0 END) AS assistantMessages
         FROM (${rollSource(b, scope)})
        GROUP BY bucketKey, user
        ORDER BY bucketKey ASC, user ASC`;

    const byBucket = <T>(mk: (b: Bucket) => T): Record<Bucket, T> => ({
      day: mk("day"),
      week: mk("week"),
      month: mk("month"),
    });
    /** Unscoped variant: rollWindow()'s six params, nothing else. */
    const plain = <R>(sql: (b: Bucket) => string) =>
      byBucket((b) => this.db.prepare<R, RollWindowArgs>(sql(b)));
    /** Scoped variant: the same six, plus the scope value as ?7. */
    const scoped = <R>(sql: (b: Bucket) => string) =>
      byBucket((b) => this.db.prepare<R, [...RollWindowArgs, string]>(sql(b)));

    this.tsByModelStmts = plain<TimeseriesModelRow>((b) => byModelSql(b, ""));
    this.tsByModelForUserStmts = scoped<TimeseriesModelRow>((b) => byModelSql(b, USER_SCOPE_7));
    this.tsByModelForCompanyStmts = scoped<TimeseriesModelRow>((b) =>
      byModelSql(b, COMPANY_SCOPE_7),
    );
    this.tsByUserStmts = plain<TimeseriesUserModelRow>((b) => byUserSql(b, ""));
    this.tsByUserForCompanyStmts = scoped<TimeseriesUserModelRow>((b) =>
      byUserSql(b, COMPANY_SCOPE_7),
    );
    this.tsCountsByBucketStmts = plain<TimeseriesBucketCountsRow>((b) => countsByBucketSql(b, ""));
    this.tsCountsByBucketForUserStmts = scoped<TimeseriesBucketCountsRow>((b) =>
      countsByBucketSql(b, USER_SCOPE_7),
    );
    this.tsCountsByBucketForCompanyStmts = scoped<TimeseriesBucketCountsRow>((b) =>
      countsByBucketSql(b, COMPANY_SCOPE_7),
    );
    this.tsCountsByUserStmts = plain<TimeseriesUserCountsRow>((b) => countsByUserSql(b, ""));
    this.tsCountsByUserForCompanyStmts = scoped<TimeseriesUserCountsRow>((b) =>
      countsByUserSql(b, COMPANY_SCOPE_7),
    );

    // Per-(user, model) aggregate for /api/v1/usage; same half-open
    // contract as every other range query here. /api/v1 sorts users
    // explicitly (localeCompare) so it does not depend on emission order,
    // but the GROUP BY key order is pinned anyway for the same reason as
    // adminUserModel: cost accumulates with float `+=`.
    this.apiUsageRangeStmt = this.db.prepare<ApiUsageRow, RollWindowArgs>(
      `SELECT user, model,
              COALESCE(SUM(inputTokens), 0)         AS input,
              COALESCE(SUM(outputTokens), 0)        AS output,
              COALESCE(SUM(cacheCreationTokens), 0) AS cacheCreation,
              COALESCE(SUM(cacheReadTokens), 0)     AS cacheRead,
              COALESCE(SUM(reasoningTokens), 0)     AS reasoning,
              COALESCE(SUM(storedCostMicros), 0)    AS storedCostMicros
         FROM (${rollSource(null, ASSISTANT_ONLY)})
        GROUP BY user, model
        ORDER BY user ASC, model ASC`,
    );

    this.getMetaStmt = this.db.prepare<{ value: string }, [string]>(
      "SELECT value FROM server_meta WHERE key = ?",
    );
    this.setMetaStmt = this.db.prepare(
      `INSERT INTO server_meta (key, value) VALUES ($key, $value)
       ON CONFLICT(key) DO UPDATE SET value = $value`,
    );

    // Prime the count cache once at open so /health never touches SQLite
    // (the field initializer ran to null before this body executed).
    this.cachedCount = this.countStmt.get()?.c ?? 0;
  }

  /**
   * Cached lifetime row count so count() does zero SQLite work on the
   * /health hot path. insertMany increments it; the clear paths null it
   * so the next count() re-derives from SQL.
   */
  private cachedCount: number | null = null;

  /**
   * Rebuild events_roll_day from scratch. O(rows) — the one operation here
   * that is — but it runs at boot, off the request path: ~5s at 5M rows.
   * Also the recovery path after a staged import or any out-of-band surgery
   * on events.
   *
   * PEAK MEMORY is the thing to be careful about here, and it is why this is
   * not one `INSERT ... SELECT ... GROUP BY`. That form sorts the whole
   * events table, and the connection runs `temp_store = MEMORY`, so its peak
   * RSS is O(rows): measured 478 MB at 5.1M rows and 864 MB at 10.2M —
   * linear, doubling with the table. docs/self-hosting.md advertises
   * 256-512 MB, and this runs in the CONSTRUCTOR, before the server listens,
   * so an operator upgrading a 512 MB machine against an existing DB would
   * be OOM-killed before /health ever answered, restart, find an empty
   * rollup, rebuild, and OOM again — a deterministic crash loop that
   * railway.json's restartPolicyMaxRetries:10 turns into a dead deploy.
   *
   * Two changes bound it, and they cover different worst cases, so both are
   * here. Partitioning by user bounds each sort to one person's traffic
   * rather than the whole table (exact: every row has exactly one user) —
   * but it does nothing for the SOLO self-hoster, whose one user IS the
   * whole table, and that is the shape docs/self-hosting.md is written for.
   * `temp_store = FILE` for the duration covers that case by spilling the
   * sorter to disk. Measured peak RSS, external sampler, mmap off:
   *
   *                                  5.1M rows   10.2M rows
   *   one GROUP BY, temp MEMORY       478 MB       864 MB     (was: O(rows))
   *   one GROUP BY, temp FILE         220 MB       220 MB     (solo worst case)
   *   per-user + temp FILE            203 MB       220 MB     (shipped)
   *
   * — flat instead of doubling, and not slower: shipped vs the old one-shot
   * form, 5.7s vs 5.6s at 5.1M rows and 12.0s vs 13.1s at 10.2M.
   *
   * If the temp directory is not writable the spill throws, and this runs in
   * the constructor, so failing hard here would trade an OOM crash-loop for a
   * boot crash-loop. Hence the retry in memory: worse peak on a pathological
   * DB beats not starting.
   */
  rebuildRollup(): number {
    const t0 = Date.now();
    const run = () =>
      this.db.transaction(() => {
        this.db.exec("DELETE FROM events_roll_day; DELETE FROM events_roll_dirty;");
        for (const { user } of this.rollDistinctUsersStmt.all()) {
          this.rollRebuildUserStmt.run(user);
        }
      })();
    try {
      this.db.exec("PRAGMA temp_store = FILE;");
      run();
    } catch (err) {
      console.warn(
        `[tokenleader] events_roll_day rebuild could not spill to disk (${String(err)}) — retrying in memory`,
      );
      this.db.exec(`PRAGMA temp_store = ${TEMP_STORE};`);
      run();
    } finally {
      this.db.exec(`PRAGMA temp_store = ${TEMP_STORE};`);
    }
    return Date.now() - t0;
  }

  /**
   * Compare, PER USER, the RollAuditRow aggregates events_roll_day exists to
   * pre-compute against the same aggregates over raw events. With `repair`,
   * rebuilds on any mismatch and logs loudly — a silent rebuild hides the
   * bug that caused it. Blocks the event loop for one covering-index scan,
   * so it is boot-time and admin-triggered only, never scheduled.
   *
   * `force` skips the comparison and rebuilds unconditionally. That is the
   * supported recovery for the divergences the comparison CANNOT see (see
   * RollAuditRow): the rollup is authoritative with no read-time fallback,
   * so an operator who knows they edited `events` needs a way to say so that
   * does not depend on the audit agreeing with them.
   */
  auditRollup(opts: { repair: boolean; force?: boolean }): RollAudit {
    if (opts.force) {
      console.warn("[tokenleader] events_roll_day rebuild forced — rebuilding from events");
      // No repairRollup() first: rebuildRollup empties the dirty queue too,
      // so draining it would be recomputing cells about to be recomputed.
      const rebuildMs = this.rebuildRollup();
      console.warn(`[tokenleader] events_roll_day rebuilt in ${rebuildMs}ms`);
      return {
        ok: true,
        rebuilt: true,
        auditMs: 0,
        rebuildMs,
        users: this.rollAuditRollupStmt.all().length,
        mismatched: [],
      };
    }
    const t0 = Date.now();
    // Drain pending repairs first: a dirty cell is a KNOWN divergence, and
    // auditing through it would trigger a needless full rebuild.
    this.repairRollup();
    const ev = this.rollAuditEventsStmt.all();
    const rl = this.rollAuditRollupStmt.all();
    const byUser = new Map(rl.map((r) => [r.user, r]));
    const mismatched: string[] = [];
    for (const e of ev) {
      const r = byUser.get(e.user);
      byUser.delete(e.user);
      if (
        r === undefined ||
        r.n !== e.n ||
        r.i !== e.i ||
        r.o !== e.o ||
        r.cc !== e.cc ||
        r.cr !== e.cr ||
        r.rt !== e.rt ||
        r.cost !== e.cost ||
        r.dsum !== e.dsum ||
        r.asst !== e.asst ||
        r.mfp !== e.mfp
      ) {
        mismatched.push(e.user);
      }
    }
    // Whatever is left has rollup rows but no events — also a divergence.
    for (const user of byUser.keys()) mismatched.push(user);
    mismatched.sort();
    const auditMs = Date.now() - t0;

    const ok = mismatched.length === 0;
    let rebuildMs = 0;
    if (!ok && opts.repair) {
      // rl empty + ev non-empty is the expected first boot on a DB from
      // before the rollup existed, not a bug — say so, so the loud version
      // stays meaningful.
      console.warn(
        rl.length === 0
          ? "[tokenleader] events_roll_day is empty — building it from events"
          : `[tokenleader] events_roll_day disagrees with events for ${mismatched.length} user(s) ` +
              `(${mismatched.slice(0, 5).join(", ")}${mismatched.length > 5 ? ", ..." : ""}) — rebuilding`,
      );
      rebuildMs = this.rebuildRollup();
      console.warn(`[tokenleader] events_roll_day rebuilt in ${rebuildMs}ms`);
    }
    // Reported separately from the rebuild, because this scan is the last
    // O(events) cost in the system and so doubles with the table the way
    // ae88cca's gain did. A number in the boot log is what makes that
    // visible before it becomes a problem. Thresholded so it stays silent on
    // small installs (and in tests) but always prints at prod scale, where
    // it measures ~1.8s at 5M rows.
    if (auditMs >= 250 || rebuildMs > 0) {
      console.log(`[tokenleader] events_roll_day audit ${auditMs}ms (${ev.length} users)`);
    }
    return { ok, rebuilt: !ok && opts.repair, auditMs, rebuildMs, users: ev.length, mismatched };
  }

  /**
   * Drain events_roll_dirty: recompute each marked (user, day) cell from
   * raw events. Deletes cannot be applied to the rollup as a delta —
   * maxTimestamp is MAX(), which is not invertible from the deleted rows —
   * so the delete side marks and this recomputes. Exact by definition, and
   * bounded at one user-day per entry (~28ms for a user-day holding 34k
   * events), which is why no worker thread is needed.
   *
   * WHO PAYS. The queue is drained at the end of insertMany, in the same
   * transaction as the delete that filled it, so the daemon POST that caused
   * the work is the request that absorbs it. It is drained again at the top
   * of every rollup-backed read, but by then it is a no-op — that call is
   * the structural backstop for a crash between the delete and the drain,
   * not the normal path.
   *
   * That distinction is the whole point. The number of ENTRIES is not
   * bounded: a Cursor cloud tick reconciles per user across the batch's
   * whole [min, max] span, and a from-zero backfill accumulates
   * maxPagesPerTick pages into ONE insertMany, so a single tick can dirty
   * every day that user has ever used cursor_local. Draining that on the
   * next read means an unauthenticated public GET /stats/* pays it —
   * measured at 846-905ms on an 864k-row fixture with 3,200 cells queued,
   * scaling with the affected user's history, in a WRITE transaction that
   * blocks /health for everyone. That is a smaller copy of the exact problem
   * this rollup exists to remove, so it belongs on the writer.
   *
   * The drain is never capped. An entry here means events_roll_day is WRONG
   * for that cell, so a partial drain would serve knowingly-stale
   * aggregates — worse than paying for the full recompute.
   */
  private repairRollup(): void {
    if (this.rollListDirtyStmt.all().length === 0) return;
    this.db.transaction(() => this.repairRollupInTx())();
  }

  /** repairRollup's body, for callers that already hold a transaction. */
  private repairRollupInTx(): void {
    for (const d of this.rollListDirtyStmt.all()) {
      this.rollDropCellStmt.run(d.user, d.day);
      this.rollRebuildCellStmt.run(d.user, d.day * DAY_MS, (d.day + 1) * DAY_MS);
      this.rollClearDirtyStmt.run(d.user, d.day);
    }
  }

  insertMany(events: TokenEvent[]): { inserted: number; duplicates: number } {
    const now = Date.now();
    let inserted = 0;
    const tx = this.db.transaction((batch: TokenEvent[]) => {
      // Per-user [min, max] timestamp span of this batch's cloud `cursor`
      // events. Reconcile deletes the user's overlapping cursor_local rows
      // before the inserts below, so the transition off the local fallback
      // doesn't double-count.
      const reconcileSpans = new Map<string, { min: number; max: number }>();
      for (const e of batch) {
        if (e.source !== "cursor") continue;
        const span = reconcileSpans.get(e.user);
        if (!span) {
          reconcileSpans.set(e.user, { min: e.timestamp, max: e.timestamp });
        } else {
          if (e.timestamp < span.min) span.min = e.timestamp;
          if (e.timestamp > span.max) span.max = e.timestamp;
        }
      }
      for (const [user, span] of reconcileSpans) {
        // A DELETE hides inside the hot write path, and no delta can undo it
        // (maxTimestamp is a MAX, which is not invertible from the rows that
        // went). Queue the (user, day) cells it touched for recomputation
        // instead; the next read drains the queue.
        const dirtyDays = new Set<number>();
        for (const row of this.deleteCursorLocalInSpanStmt.all({
          $user: user,
          $min: span.min,
          $max: span.max,
        })) {
          dirtyDays.add(row.day);
        }
        for (const day of dirtyDays) this.rollMarkDirtyStmt.run(user, day);
      }
      // Per-(day, user, model, messageType) deltas for this batch, flushed
      // as one UPSERT per group after the insert loop — a 1000-row batch
      // yields ~18 groups. Accumulated only for rows the INSERT actually
      // took (res.changes > 0), so a re-posted batch adds nothing and
      // dedup-exactness costs zero extra work.
      const deltas = new Map<
        string,
        {
          $day: number;
          $user: string;
          $model: string;
          $messageType: string;
          $events: number;
          $inputTokens: number;
          $outputTokens: number;
          $cacheCreationTokens: number;
          $cacheReadTokens: number;
          $reasoningTokens: number;
          $storedCostMicros: number;
          $maxTimestamp: number;
        }
      >();
      for (const e of batch) {
        const res = this.insertStmt.run({
          $user: e.user,
          $source: e.source,
          $sessionId: e.sessionId,
          $messageId: e.messageId,
          $requestId: e.requestId,
          $timestamp: e.timestamp,
          $model: e.model,
          // Back-compat default for daemons predating the user/assistant
          // split; set explicitly so the statement needs no NULL placeholder.
          $messageType: e.messageType ?? "assistant",
          $inputTokens: e.inputTokens,
          $outputTokens: e.outputTokens,
          $cacheCreationTokens: e.cacheCreationTokens,
          $cacheReadTokens: e.cacheReadTokens,
          $reasoningTokens: e.reasoningTokens,
          $costUsdMicros: e.costUsdMicros ?? null,
          $ingestedAt: now,
        });
        if (res.changes > 0) {
          inserted += 1;
          // Keyed by the EVENT'S OWN day, never by arrival time — that is
          // what makes backfills correct with no watermark and no cache
          // invalidation: a row dated last September upserts last
          // September's cell.
          const day = rollDayOf(e.timestamp);
          const messageType = e.messageType ?? "assistant";
          // NUL-separated: user and model are free-form, and a printable
          // delimiter could be forged to collide two distinct groups.
          const key = `${day}\u0000${e.user}\u0000${e.model}\u0000${messageType}`;
          let g = deltas.get(key);
          if (g === undefined) {
            g = {
              $day: day,
              $user: e.user,
              $model: e.model,
              $messageType: messageType,
              $events: 0,
              $inputTokens: 0,
              $outputTokens: 0,
              $cacheCreationTokens: 0,
              $cacheReadTokens: 0,
              $reasoningTokens: 0,
              $storedCostMicros: 0,
              $maxTimestamp: e.timestamp,
            };
            deltas.set(key, g);
          }
          g.$events += 1;
          g.$inputTokens += e.inputTokens;
          g.$outputTokens += e.outputTokens;
          g.$cacheCreationTokens += e.cacheCreationTokens;
          g.$cacheReadTokens += e.cacheReadTokens;
          g.$reasoningTokens += e.reasoningTokens ?? 0;
          g.$storedCostMicros += e.costUsdMicros ?? 0;
          if (e.timestamp > g.$maxTimestamp) g.$maxTimestamp = e.timestamp;
        }
      }
      for (const g of deltas.values()) this.rollUpsertStmt.run(g);
      // Pay for our own deletes. Empty (and free) unless the reconcile above
      // dirtied cells; when it did, this is the ingest that caused them, not
      // the next visitor to open the dashboard. See repairRollup.
      this.repairRollupInTx();
    });
    tx(events);
    if (this.cachedCount !== null) this.cachedCount += inserted;
    return { inserted, duplicates: events.length - inserted };
  }

  count(): number {
    if (this.cachedCount === null) {
      this.cachedCount = this.countStmt.get()?.c ?? 0;
    }
    return this.cachedCount;
  }

  /**
   * The six window parameters for a rollup-backed statement — and the one
   * place the read side answers "did I remember to repair before reading?",
   * structurally rather than per call site.
   *
   * The drain here is a BACKSTOP, not the normal path: insertMany drains the
   * queue in the same transaction as the delete that filled it, so by the
   * time a reader gets here the queue is empty except after a crash between
   * those two points. Keeping the call means a reader can never observe a
   * cell the queue says is wrong; moving the cost to the writer means a
   * public GET never pays for a daemon's backfill. See repairRollup.
   */
  private rollArgs(sinceMs: number, untilMs: number): RollWindowArgs {
    this.repairRollup();
    return rollWindow(sinceMs, untilMs);
  }

  userTotals(user: string, sinceMs: number, untilMs: number = MAX_TS_MS): UserTotalsRow | null {
    return this.userTotalsStmt.get(...this.rollArgs(sinceMs, untilMs), user);
  }

  userByModel(user: string, sinceMs: number, untilMs: number = MAX_TS_MS): ModelRow[] {
    return this.userByModelStmt.all(...this.rollArgs(sinceMs, untilMs), user);
  }

  leaderboard(sinceMs: number, untilMs: number = MAX_TS_MS): UserTotalsRow[] {
    return this.leaderboardStmt.all(...this.rollArgs(sinceMs, untilMs));
  }

  // category and company are mutually exclusive at the store layer: the UI
  // only ever sends one, and combined filtering + group-by are out of v1
  // scope. categoryId wins over company when both are (mis)passed.
  adminLeaderboard(
    sinceMs: number = 0,
    untilMs: number = MAX_TS_MS,
    company?: string,
    categoryId?: number,
  ): LeaderboardAdminRow[] {
    if (categoryId !== undefined) {
      return this.adminLeaderboardForCategoryStmt.all(
        ...this.rollArgs(sinceMs, untilMs),
        categoryId,
      );
    }
    if (company && company.length > 0) {
      return this.adminLeaderboardForCompanyStmt.all(...this.rollArgs(sinceMs, untilMs), company);
    }
    return this.adminLeaderboardStmt.all(...this.rollArgs(sinceMs, untilMs));
  }

  /** Per-(user, model) aggregates over the window, assistant rows only.
   *  Unscoped by design — the admin route intersects with its (scoped)
   *  leaderboard user set in JS. */
  adminUserModel(sinceMs: number = 0, untilMs: number = MAX_TS_MS): UserModelAggRow[] {
    return this.adminUserModelStmt.all(...this.rollArgs(sinceMs, untilMs));
  }

  adminRecent(limit: number, company?: string, categoryId?: number): RecentEventRow[] {
    if (categoryId !== undefined) {
      return this.adminRecentForCategoryStmt.all(categoryId, limit);
    }
    if (company && company.length > 0) {
      return this.adminRecentForCompanyStmt.all(company, limit);
    }
    return this.adminRecentStmt.all(limit);
  }

  /** Sorted distinct non-null companies across ALL users — the dashboard's
   *  filter pick-list, never narrowed by an active company filter. */
  listCompanies(): string[] {
    return this.listCompaniesStmt.all().map((r) => r.company);
  }

  /** All category definitions with their live assignment count (count 0 for
   *  defined-but-unassigned). Always global — never narrowed by a filter. */
  listCategories(): Array<{
    id: number;
    name: string;
    color: string | null;
    sortOrder: number;
    assignedCount: number;
  }> {
    return this.listCategoriesStmt.all().map((r) => ({
      id: r.id,
      name: r.name,
      color: r.color,
      sortOrder: r.sort_order,
      assignedCount: r.assigned_count,
    }));
  }

  /** Create a category. `ok:false` on a (COLLATE NOCASE) duplicate name —
   *  categories.name is the only unique constraint the INSERT can violate. */
  createCategory(
    name: string,
    color: string | null,
    now: number,
  ): { ok: true; id: number } | { ok: false; error: "duplicate" } {
    try {
      const r = this.createCategoryStmt.run({
        $name: name,
        $color: color,
        $sort: 0,
        $created_at: now,
      });
      return { ok: true, id: Number(r.lastInsertRowid) };
    } catch (e) {
      if (String(e).includes("UNIQUE")) return { ok: false, error: "duplicate" };
      throw e;
    }
  }

  /** Rename / recolor a category. False when no row matched (unknown id). */
  renameCategory(id: number, name: string, color: string | null): boolean {
    return Number(this.renameCategoryStmt.run({ $id: id, $name: name, $color: color }).changes) > 0;
  }

  /** Delete a category and null out every assignment in one transaction
   *  (manual orphan cleanup — FKs are off; mirrors clearUserSecret). False
   *  when no category row matched. */
  deleteCategory(id: number): boolean {
    const tx = this.db.transaction((catId: number): boolean => {
      this.clearCategoryAssignmentsStmt.run(catId);
      return Number(this.deleteCategoryStmt.run(catId).changes) > 0;
    });
    return tx(id);
  }

  /** Whether a category id exists. */
  categoryExists(id: number): boolean {
    return this.getCategoryByIdStmt.get(id) !== null;
  }

  /** Assign (id) or clear (null) a user's category. UPDATE-only: the
   *  user_secrets row must already exist (caller 404s unknown users).
   *  False when no row matched. */
  setUserCategory(user: string, categoryId: number | null): boolean {
    return Number(this.setUserCategoryStmt.run({ $cid: categoryId, $u: user }).changes) > 0;
  }

  /** A user's assigned category id; null = unassigned / unknown user. */
  getUserCategory(user: string): number | null {
    return this.getUserCategoryStmt.get(user)?.category_id ?? null;
  }

  /** Authoritative roster for the assignment table: every claimed user (even
   *  those with no events in the active range) plus their current category_id,
   *  so the dropdown can seed its defaultValue. Never selects secret_hash. */
  listClaimedUsersWithCategory(): Array<{
    username: string;
    claimedAt: number;
    categoryId: number | null;
  }> {
    return this.listClaimedUsersWithCategoryStmt.all().map((r) => ({
      username: r.username,
      claimedAt: r.claimed_at,
      categoryId: r.category_id,
    }));
  }

  /** Per-user (userMessages, assistantMessages) counts in the window.
   *  No token sums — see `adminLeaderboard` / `userTotals`. */
  userMessageCounts(sinceMs: number = 0, untilMs: number = MAX_TS_MS): UserMessageCountsRow[] {
    return this.userMessageCountsAllStmt.all(...this.rollArgs(sinceMs, untilMs));
  }

  /** Single-user message counts; returns zeros (not null) when the user
   *  has no rows in the window. */
  userMessageCountsForUser(
    user: string,
    sinceMs: number = 0,
    untilMs: number = MAX_TS_MS,
  ): { userMessages: number; assistantMessages: number } {
    const row = this.userMessageCountsForUserStmt.get(...this.rollArgs(sinceMs, untilMs), user);
    return {
      userMessages: row?.userMessages ?? 0,
      assistantMessages: row?.assistantMessages ?? 0,
    };
  }

  /** Per-bucket (userMessages, assistantMessages), optionally filtered to
   *  one user or one company (user wins when both are passed — it is the
   *  narrower scope). Composed with the token queries by /stats/timeseries. */
  timeseriesCountsByBucket(
    bucket: Bucket,
    sinceMs: number,
    untilMs: number,
    user?: string,
    company?: string,
  ): TimeseriesBucketCountsRow[] {
    if (user && user.length > 0) {
      return this.tsCountsByBucketForUserStmts[bucket].all(
        ...this.rollArgs(sinceMs, untilMs),
        user,
      );
    }
    if (company && company.length > 0) {
      return this.tsCountsByBucketForCompanyStmts[bucket].all(
        ...this.rollArgs(sinceMs, untilMs),
        company,
      );
    }
    return this.tsCountsByBucketStmts[bucket].all(...this.rollArgs(sinceMs, untilMs));
  }

  timeseriesCountsByUser(
    bucket: Bucket,
    sinceMs: number,
    untilMs: number,
    company?: string,
  ): TimeseriesUserCountsRow[] {
    if (company && company.length > 0) {
      return this.tsCountsByUserForCompanyStmts[bucket].all(
        ...this.rollArgs(sinceMs, untilMs),
        company,
      );
    }
    return this.tsCountsByUserStmts[bucket].all(...this.rollArgs(sinceMs, untilMs));
  }

  timeseriesByModel(
    bucket: Bucket,
    sinceMs: number,
    untilMs: number,
    user?: string,
    company?: string,
  ): TimeseriesModelRow[] {
    if (user && user.length > 0) {
      return this.tsByModelForUserStmts[bucket].all(...this.rollArgs(sinceMs, untilMs), user);
    }
    if (company && company.length > 0) {
      return this.tsByModelForCompanyStmts[bucket].all(...this.rollArgs(sinceMs, untilMs), company);
    }
    return this.tsByModelStmts[bucket].all(...this.rollArgs(sinceMs, untilMs));
  }

  timeseriesByUser(
    bucket: Bucket,
    sinceMs: number,
    untilMs: number,
    company?: string,
  ): TimeseriesUserModelRow[] {
    if (company && company.length > 0) {
      return this.tsByUserForCompanyStmts[bucket].all(...this.rollArgs(sinceMs, untilMs), company);
    }
    return this.tsByUserStmts[bucket].all(...this.rollArgs(sinceMs, untilMs));
  }

  /** Per-(user, model) token sums over `[since, until)`, assistant rows
   *  only. Callers price each pair and aggregate to per-user totals. */
  apiUsageRange(sinceMs: number, untilMs: number): ApiUsageRow[] {
    return this.apiUsageRangeStmt.all(...this.rollArgs(sinceMs, untilMs));
  }

  /** Wipe the events table (keep user_secrets). Returns rows removed. */
  clearAllEvents(): number {
    // Truncating the rollup alongside is exact and cheaper than marking
    // every cell dirty; same transaction, so a crash can't leave the
    // rollup describing deleted events.
    const tx = this.db.transaction(() => {
      this.db.exec("DELETE FROM events_roll_day; DELETE FROM events_roll_dirty;");
      return Number(this.db.prepare("DELETE FROM events").run().changes);
    });
    const removed = tx();
    this.cachedCount = null;
    return removed;
  }

  /** Wipe events for one user. Returns rows removed. */
  clearUserEvents(user: string): number {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM events_roll_day WHERE user = ?").run(user);
      this.db.prepare("DELETE FROM events_roll_dirty WHERE user = ?").run(user);
      return Number(this.db.prepare("DELETE FROM events WHERE user = ?").run(user).changes);
    });
    const removed = tx();
    this.cachedCount = null;
    return removed;
  }

  /** Remove the TOFU claim + every device row for a user (so the next
   *  post claims fresh), plus the per-device forensics keyed to those
   *  rows — orphaned device ids would mis-attach to a future device. */
  clearUserSecret(user: string): number {
    for (const table of [
      "user_devices",
      "checkin_history",
      "device_checkin_state",
      "diag_logs_v2",
      "fleet_alerts",
      "device_fleet_state",
    ]) {
      this.db.prepare(`DELETE FROM ${table} WHERE username = ?`).run(user);
    }
    const r = this.db.prepare("DELETE FROM user_secrets WHERE username = ?").run(user);
    return Number(r.changes);
  }

  /** Nuclear: drop and recreate all tables. The device-keyed forensics
   *  tables go with user_devices — their device ids die with it. */
  clearFull(): void {
    this.cachedCount = null;
    this.db.exec(
      // events_roll_day/events_roll_dirty go with events. This drop list is
      // a curated contract with deliberate survivors (page_views,
      // server_meta) — leaving the rollup out would let it survive the nuke
      // and keep serving aggregates for deleted events. SCHEMA below
      // recreates both.
      "DROP TABLE IF EXISTS events_roll_day; DROP TABLE IF EXISTS events_roll_dirty; " +
        "DROP TABLE IF EXISTS events; DROP TABLE IF EXISTS user_secrets; DROP TABLE IF EXISTS daemon_status; DROP TABLE IF EXISTS user_devices; DROP TABLE IF EXISTS categories; " +
        "DROP TABLE IF EXISTS checkin_history; DROP TABLE IF EXISTS device_checkin_state; DROP TABLE IF EXISTS diag_logs_v2; DROP TABLE IF EXISTS fleet_alerts; DROP TABLE IF EXISTS device_fleet_state; DROP TABLE IF EXISTS auth_failures;",
    );
    // page_views survives too: it holds no user data (no handle, no
    // identity of any kind), so wiping the leaderboard is not a reason to
    // lose the operator's traffic history. It cannot grow without bound
    // either — PAGE_VIEWS_MAX prunes it on every flush — so sparing it here
    // costs nothing. Drop the table by hand if you really want it gone.
    //
    // server_meta survives (other keys may be unrelated state), but the
    // cursor watermark must go or cleared Cursor history never re-imports.
    this.deleteMeta(CURSOR_WATERMARK_META_KEY);
    this.db.exec(SCHEMA);
    // The dedup index is canonically defined in migrateMessageType.
    migrateMessageType(this.db);
    migrateUninstalledAt(this.db);
    migrateCompany(this.db);
    // Re-add category_id to the recreated user_secrets (categories defs and
    // assignments share one lifecycle — both wiped above, recreated here).
    migrateCategoryId(this.db);
  }

  dbSizeBytes(): number {
    const row = this.dbSizeStmt.get();
    if (!row) return 0;
    return row.page_count * row.page_size;
  }

  lastEventAt(): number | null {
    const row = this.lastEventStmt.get();
    return row?.ts ?? null;
  }

  getUserSecretHash(user: string): string | null {
    const row = this.getUserSecretStmt.get(user);
    return row?.secret_hash ?? null;
  }

  /** Full `user_secrets` row (secret hash + uninstall marker), camelCased. */
  getUserSecretRow(user: string): { secretHash: string; uninstalledAt: number | null } | null {
    const row = this.getUserSecretStmt.get(user);
    if (!row) return null;
    return {
      secretHash: row.secret_hash,
      uninstalledAt: row.uninstalled_at,
    };
  }

  /**
   * First claim of an unclaimed username: the user_secrets row and the
   * machine's device row are created in one transaction. Returns the new
   * device id, or null when another machine won the claim race first —
   * the caller must treat null as a secret mismatch.
   */
  claimUserSecret(
    user: string,
    secretHash: string,
    now: number,
    label: string | null = null,
  ): number | null {
    const tx = this.db.transaction((): number | null => {
      const res = this.claimUserSecretStmt.run({
        $username: user,
        $secret_hash: secretHash,
        $claimed_at: now,
      });
      if (res.changes === 0) return null;
      return this.insertDevice(user, secretHash, label, now);
    });
    return tx();
  }

  /**
   * Re-claim of an uninstalled username: rotate the user_secrets hash,
   * clear `uninstalled_at`, revoke any leftover device rows, and register
   * the new machine as the sole device. Returns the new device id.
   */
  reclaimUserSecret(
    user: string,
    secretHash: string,
    now: number,
    label: string | null = null,
  ): number {
    const tx = this.db.transaction((): number => {
      this.updateUserSecretHashStmt.run({
        $username: user,
        $secret_hash: secretHash,
        $claimed_at: now,
      });
      this.revokeAllDevicesStmt.run({ $username: user, $revoked_at: now });
      return this.insertDevice(user, secretHash, label, now);
    });
    return tx();
  }

  /** Add a machine to an already-claimed username (link-code redemption).
   *  Returns the new device id. */
  linkUserDevice(user: string, secretHash: string, now: number, label: string | null): number {
    return this.insertDevice(user, secretHash, label, now);
  }

  private insertDevice(
    user: string,
    secretHash: string,
    label: string | null,
    now: number,
  ): number {
    const res = this.insertDeviceStmt.run({
      $username: user,
      $secret_hash: secretHash,
      $label: this.dedupedLabel(user, label),
      $added_at: now,
    });
    return Number(res.lastInsertRowid);
  }

  /** "mbp" → "mbp-2" when an active sibling already holds the label. */
  private dedupedLabel(user: string, label: string | null): string | null {
    if (!label) return null;
    const taken = new Set(this.listUserDevicesStmt.all(user).map((d) => d.label));
    if (!taken.has(label)) return label;
    for (let i = 2; ; i++) {
      const candidate = `${label}-${i}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  /** Active devices for a user, oldest first. Never exposes hashes. */
  listUserDevices(user: string): DeviceInfo[] {
    return this.listUserDevicesStmt.all(user).map(deviceInfo);
  }

  /** Every user's active devices, (username, added_at)-sorted, for the
   *  fleet view. */
  listFleetDevices(): Array<{ user: string; device: DeviceInfo }> {
    return this.listFleetDevicesStmt
      .all()
      .map((r) => ({ user: r.username, device: deviceInfo(r) }));
  }

  /**
   * Timing-safe device auth: does the presented sha256 hash match any
   * active device? Every row is compared (no early exit) so response
   * timing doesn't reveal which device matched.
   */
  authenticateDevice(user: string, presentedHash: string): { deviceId: number } | null {
    const presented = Buffer.from(presentedHash, "hex");
    let matched: number | null = null;
    for (const row of this.listUserDevicesStmt.all(user)) {
      const stored = Buffer.from(row.secret_hash, "hex");
      if (
        stored.length === presented.length &&
        timingSafeEqual(stored, presented) &&
        matched === null
      ) {
        matched = row.id;
      }
    }
    return matched === null ? null : { deviceId: matched };
  }

  /**
   * Revoke one device. `barred` = the deliberate /devices/revoke path: the
   * device's secret is marked so it can never auto-reclaim the handle (a
   * kicked machine's still-running daemon can't resurrect itself). The
   * uninstall path passes barred=false — that secret may seamlessly
   * reinstall. When the last active device goes, the user is marked
   * uninstalled (re-claim invariant: no active devices ⇒ uninstalled_at set
   * ⇒ a NON-barred secret may re-claim). When devices remain, the rollback
   * mirror is re-pointed off the revoked device so a rollback keeps
   * authenticating a survivor.
   */
  revokeUserDevice(
    user: string,
    deviceId: number,
    now: number,
    barred = false,
  ): { revoked: boolean; uninstalled: boolean } {
    const tx = this.db.transaction((): { revoked: boolean; uninstalled: boolean } => {
      const before = this.listUserDevicesStmt.all(user);
      const target = before.find((d) => d.id === deviceId);
      const res = this.revokeDeviceStmt.run({
        $id: deviceId,
        $username: user,
        $revoked_at: now,
      });
      if (res.changes === 0) return { revoked: false, uninstalled: false };
      if (barred) {
        this.db.prepare("UPDATE user_devices SET barred = 1 WHERE id = ?").run(deviceId);
      }
      const remaining = this.listUserDevicesStmt.all(user);
      if (remaining.length === 0) {
        this.markUserUninstalledStmt.run({ $username: user, $uninstalled_at: now });
        return { revoked: true, uninstalled: true };
      }
      // If the revoked device's hash was the rollback mirror, re-point it
      // to the oldest survivor so an old server keeps authenticating.
      if (target && this.getUserSecretStmt.get(user)?.secret_hash === target.secret_hash) {
        this.repointUserSecretHashStmt.run({
          $username: user,
          $secret_hash: remaining[0]!.secret_hash,
        });
      }
      return { revoked: true, uninstalled: false };
    });
    return tx();
  }

  /** Has this secret been barred (kicked via /devices/revoke) for the user?
   *  Timing-safe; gates the /ingest reclaim branch so a revoked machine
   *  can't resurrect its handle. */
  isSecretBarred(user: string, presentedHash: string): boolean {
    const presented = Buffer.from(presentedHash, "hex");
    let barred = false;
    for (const row of this.listUserDevicesAllStmt.all(user)) {
      if (row.barred !== 1) continue;
      const stored = Buffer.from(row.secret_hash, "hex");
      if (stored.length === presented.length && timingSafeEqual(stored, presented)) {
        barred = true;
      }
    }
    return barred;
  }

  /** Clear the uninstalled marker (no-op when already null). Used to
   *  reconcile rollback drift on a successful device auth. */
  clearUninstalledMark(user: string): void {
    this.clearUninstalledAtStmt.run({ $username: user });
  }

  /**
   * Stamp a device's check-in: last_seen always; version/arch only when
   * the daemon sent real values; label adopted only while NULL (an
   * existing label is never renamed by a later header).
   */
  recordDeviceCheckIn(
    user: string,
    deviceId: number,
    version: string | null,
    arch: string | null,
    label: string | null,
    now: number,
  ): void {
    this.deviceCheckInStmt.run({
      $id: deviceId,
      $last_seen: now,
      $version: version,
      $arch: arch,
    });
    if (!label) return;
    const self = this.listUserDevicesStmt.all(user).find((d) => d.id === deviceId);
    if (!self || self.label !== null) return;
    this.setDeviceLabelStmt.run({ $id: deviceId, $label: this.dedupedLabel(user, label) });
  }

  /** Queue a directive for the user's next check-in. deviceId pins delivery
   *  to one machine; null = any of the user's devices. Returns its id. */
  enqueueDirective(
    username: string,
    verb: DirectiveVerb,
    now: number,
    deviceId: number | null = null,
  ): number {
    this.enqueueDirectiveStmt.run({
      $username: username,
      $verb: verb,
      $created_at: now,
      $device_id: deviceId,
    });
    return Number(
      this.db.prepare<{ id: number }, []>("SELECT last_insert_rowid() AS id").get()?.id ?? 0,
    );
  }

  /**
   * Claim the oldest eligible directive for (user, device) — stamping
   * delivered_at — or null. A directive is eligible when undelivered,
   * un-acked, unexpired, and either untargeted (device_id NULL) or aimed
   * at this device. Delivered-but-never-acked rows past the TTL are first
   * re-queued (once). `channel` names the executor asking: /checkin and
   * /ingest pass 'daemon', /watchdog-checkin 'watchdog' — watchdog-only
   * verbs (WATCHDOG_ONLY_VERBS) are invisible to daemon channels so they
   * can never be terminally acked 'unknown verb' by the wrong executor.
   */
  takeDirective(
    username: string,
    deviceId: number,
    channel: "daemon" | "watchdog",
    now: number,
  ): { id: number; verb: string } | null {
    const tx = this.db.transaction((): DirectiveRow | null => {
      this.requeueDirectivesStmt.run({
        $username: username,
        $now: now,
        $expired: now - DIRECTIVE_TTL_MS,
      });
      return this.takeDirectiveStmt.get({
        $username: username,
        $device_id: deviceId,
        $channel: channel,
        $now: now,
        $cutoff: now - DIRECTIVE_TTL_MS,
      });
    });
    const row = tx();
    return row ? { id: row.id, verb: row.verb } : null;
  }

  /**
   * Executed-ack: what actually completes a directive (delivery alone never
   * does). First ack wins; a replay reports "duplicate" without overwriting;
   * an id that doesn't belong to this user is null (the route 404s).
   */
  ackDirective(
    username: string,
    id: number,
    ack: { result: "ok" | "failed"; detail: string | null; executedBy: "daemon" | "watchdog" },
    now: number,
  ): "acked" | "duplicate" | null {
    const res = this.ackDirectiveStmt.run({
      $id: id,
      $username: username,
      $now: now,
      $result: ack.result,
      $detail: ack.detail,
      $executed_by: ack.executedBy,
    });
    if (res.changes > 0) return "acked";
    return this.directiveOwnerStmt.get(id, username) ? "duplicate" : null;
  }

  /** Is a directive of this verb already live for (user, device) — pending,
   *  in flight, or executed within `recentMs`? The alert sweep's guard
   *  against stacking heal directives on a machine that isn't recovering. */
  hasRecentDirective(
    username: string,
    deviceId: number,
    verb: DirectiveVerb,
    now: number,
    recentMs: number,
  ): boolean {
    return Boolean(
      this.hasRecentDirectiveStmt.get({
        $username: username,
        $device_id: deviceId,
        $verb: verb,
        $cutoff: now - DIRECTIVE_TTL_MS,
        $recent: now - recentMs,
      }),
    );
  }

  /** Recent directives for a user, newest first (admin visibility). */
  listDirectives(username: string, limit = 20): DirectiveListRow[] {
    return this.listDirectivesStmt.all(username, limit);
  }

  /** Store (replace) a device's uploaded log tail. Caller caps the size. */
  saveDiagLog(username: string, deviceId: number, content: string, now: number): void {
    this.saveDiagLogV2Stmt.run({
      $username: username,
      $device_id: deviceId,
      $uploaded_at: now,
      $content: content,
    });
  }

  /** One device's log tail, or null. */
  getDiagLogForDevice(
    username: string,
    deviceId: number,
  ): { deviceId: number; uploadedAt: number; content: string } | null {
    const row = this.getDiagLogV2Stmt.get(username, deviceId);
    return row
      ? { deviceId: row.device_id, uploadedAt: row.uploaded_at, content: row.content }
      : null;
  }

  /** A user's most recent log tail across devices, falling back to the
   *  legacy single-row diag_logs table for pre-v0.6 uploads (deviceId null). */
  getDiagLog(
    username: string,
  ): { deviceId: number | null; uploadedAt: number; content: string } | null {
    const v2 = this.latestDiagLogV2Stmt.get(username);
    if (v2) return { deviceId: v2.device_id, uploadedAt: v2.uploaded_at, content: v2.content };
    const row = this.getDiagLogStmt.get(username);
    return row ? { deviceId: null, uploadedAt: row.uploaded_at, content: row.content } : null;
  }

  /** Stamp a watchdog checkin (the second liveness channel). Deliberately
   *  never touches last_seen/version/arch — those belong to the daemon. */
  recordWatchdogCheckIn(deviceId: number, now: number): void {
    this.watchdogCheckInStmt.run({ $id: deviceId, $now: now });
  }

  /** Append one checkin observation (kind 'daemon' | 'watchdog') and prune
   *  the device's journal to the per-device cap. */
  appendCheckinHistory(
    username: string,
    deviceId: number,
    kind: "daemon" | "watchdog",
    version: string | null,
    uptimeS: number | null,
    ts: number,
  ): void {
    this.appendCheckinHistoryStmt.run({
      $username: username,
      $device_id: deviceId,
      $ts: ts,
      $kind: kind,
      $version: version,
      $uptime_s: uptimeS,
    });
    this.pruneCheckinHistoryStmt.run({
      $device_id: deviceId,
      $keep: CHECKIN_HISTORY_PER_DEVICE,
    });
  }

  /** A device's newest history rows for one channel, ASCENDING by time (the
   *  order the crash-loop scan wants). */
  recentCheckinHistory(
    deviceId: number,
    kind: "daemon" | "watchdog",
    limit = 50,
  ): CheckinHistoryRow[] {
    return this.recentCheckinHistoryStmt.all(deviceId, kind, limit).reverse();
  }

  /** Upsert the latest sanitized checkin body for (device, channel). */
  saveDeviceCheckinState(
    username: string,
    deviceId: number,
    kind: "daemon" | "watchdog",
    body: string,
    now: number,
  ): void {
    this.saveDeviceCheckinStateStmt.run({
      $device_id: deviceId,
      $kind: kind,
      $username: username,
      $updated_at: now,
      $body: body,
    });
  }

  /** The latest stored body for (device, channel), or null. */
  getDeviceCheckinState(
    deviceId: number,
    kind: "daemon" | "watchdog",
  ): { updatedAt: number; body: string } | null {
    const row = this.getDeviceCheckinStateStmt.get(deviceId, kind);
    return row ? { updatedAt: row.updated_at, body: row.body } : null;
  }

  /** Record a failed device auth (403 trace). username is the CLAIMED
   *  handle from the request — unauthenticated input, kept for forensics. */
  recordAuthFailure(route: string, username: string, deviceLabel: string | null, ts: number): void {
    this.insertAuthFailureStmt.run({
      $username: username,
      $device_label: deviceLabel,
      $route: route,
      $ts: ts,
    });
    this.pruneAuthFailuresStmt.run({ $keep: AUTH_FAILURES_MAX });
  }

  /** Recent auth failures, newest first; user narrows to one handle. */
  listAuthFailures(user: string | null, limit = 100): AuthFailureRow[] {
    return user === null
      ? this.listAuthFailuresStmt.all(limit)
      : this.listAuthFailuresForUserStmt.all(user, limit);
  }

  /** Insert a batch of anonymous page views in ONE transaction — the flush
   *  side of PageViewRecorder's buffer. One transaction per flush (not per
   *  row) keeps the event-loop stall to a single fsync no matter how many
   *  loads accumulated, and the PAGE_VIEWS_MAX prune rides inside the same
   *  transaction so the cap costs no extra commit. Returns rows written. */
  recordPageViews(rows: readonly PageViewRow[]): number {
    if (rows.length === 0) return 0;
    const tx = this.db.transaction((batch: readonly PageViewRow[]) => {
      for (const r of batch) {
        this.insertPageViewStmt.run({ $ts: r.ts, $path: r.path });
      }
      this.prunePageViewsStmt.run({ $keep: PAGE_VIEWS_MAX });
    });
    tx(rows);
    return rows.length;
  }

  /** Human page views in `[since, until)`. Bots never made it into the
   *  table, so this needs no filter. */
  countPageViews(since: number, until: number): number {
    return this.countPageViewsStmt.get(since, until)?.views ?? 0;
  }

  /** Page views per UTC day in `[since, until)`, oldest first. Days with
   *  zero loads are absent (no gap filling — callers render what happened). */
  pageViewsByDay(since: number, until: number): PageViewDayRow[] {
    return this.pageViewsByDayStmt.all(since, until);
  }

  /** Page views per path in `[since, until)`, busiest first. */
  pageViewsByPath(since: number, until: number): PageViewPathRow[] {
    return this.pageViewsByPathStmt.all(since, until);
  }

  /** When was this (device, state) last alerted? null = never. */
  lastFleetAlertAt(deviceId: number, state: string): number | null {
    return this.lastFleetAlertStmt.get(deviceId, state)?.alerted_at ?? null;
  }

  /** Record a delivered fleet alert (the 6h dedup source). */
  recordFleetAlert(deviceId: number, username: string, state: string, now: number): void {
    this.insertFleetAlertStmt.run({
      $device_id: deviceId,
      $username: username,
      $state: state,
      $alerted_at: now,
    });
  }

  /**
   * Sweep bookkeeping: record the device's current classification and
   * return when that state was FIRST observed (`since`). A state change
   * resets the clock; a repeat observation keeps it — giving the alert
   * sweep its "in state > 1h" gate.
   */
  observeDeviceFleetState(deviceId: number, username: string, state: string, now: number): number {
    const tx = this.db.transaction((): number => {
      const prior = this.getDeviceFleetStateStmt.get(deviceId);
      const since = prior && prior.state === state ? prior.since : now;
      this.upsertDeviceFleetStateStmt.run({
        $device_id: deviceId,
        $username: username,
        $state: state,
        $since: since,
        $updated_at: now,
      });
      return since;
    });
    return tx();
  }

  /**
   * Sweep bookkeeping for boolean conditions ORTHOGONAL to the FleetState
   * machine (e.g. WATCHDOG_MISSING — a device can be HEALTHY yet report
   * watchdog_installed=false). Present: keep the streak's original `since`
   * and return it (the "held > 1h" gate). Absent: drop the row and return
   * null, so the next occurrence starts a fresh clock.
   */
  observeDeviceFlag(
    deviceId: number,
    username: string,
    flag: string,
    present: boolean,
    now: number,
  ): number | null {
    const tx = this.db.transaction((): number | null => {
      if (!present) {
        this.clearDeviceFlagStmt.run(deviceId, flag);
        return null;
      }
      const since = this.getDeviceFlagStmt.get(deviceId, flag)?.since ?? now;
      this.upsertDeviceFlagStmt.run({
        $device_id: deviceId,
        $flag: flag,
        $username: username,
        $since: since,
        $updated_at: now,
      });
      return since;
    });
    return tx();
  }

  /**
   * Admin escape hatch (POST /admin/mark-uninstalled): a machine that was
   * wiped without running the uninstall script leaves an eternally-stale
   * fleet row. Revokes every active device (barred=false — the same secret
   * may seamlessly reinstall) and sets uninstalled_at, i.e. exactly the
   * state the uninstall script would have left. False = unknown user.
   */
  adminMarkUninstalled(user: string, now: number): boolean {
    const tx = this.db.transaction((): boolean => {
      if (!this.getUserSecretStmt.get(user)) return false;
      this.revokeAllDevicesStmt.run({ $username: user, $revoked_at: now });
      this.markUserUninstalledStmt.run({ $username: user, $uninstalled_at: now });
      return true;
    });
    return tx();
  }

  listClaimedUsers(): Array<{ user: string; claimedAt: number }> {
    return this.listClaimedUsersStmt
      .all()
      .map((r) => ({ user: r.username, claimedAt: r.claimed_at }));
  }

  /**
   * /events/uninstall: authenticate the presented hash against the user's
   * devices and revoke the matching one. `uninstalledAt` is non-null only
   * when that was the last active device — a user whose other machines are
   * still posting stays on the board. Idempotent: a repeat call (secret
   * matches an already-revoked device) reports the stored state without
   * changing anything.
   */
  markUserUninstalled(
    user: string,
    secretHash: string,
    now: number,
  ): { matched: boolean; uninstalledAt: number | null } {
    const auth = this.authenticateDevice(user, secretHash);
    if (auth) {
      const r = this.revokeUserDevice(user, auth.deviceId, now);
      return { matched: true, uninstalledAt: r.uninstalled ? now : null };
    }
    const presented = Buffer.from(secretHash, "hex");
    for (const row of this.listUserDevicesAllStmt.all(user)) {
      const stored = Buffer.from(row.secret_hash, "hex");
      if (stored.length === presented.length && timingSafeEqual(stored, presented)) {
        return {
          matched: true,
          uninstalledAt: this.getUserSecretStmt.get(user)?.uninstalled_at ?? null,
        };
      }
    }
    return { matched: false, uninstalledAt: null };
  }

  /** Users with `uninstalled_at` set, newest first. */
  listUninstalledUsers(): Array<{ user: string; uninstalledAt: number }> {
    return this.listUninstalledUsersStmt
      .all()
      .map((r) => ({ user: r.username, uninstalledAt: r.uninstalled_at }));
  }

  /**
   * Upsert the normalized company a user's daemon reported via
   * X-Tokenleader-Company (last write wins). Only called with a valid
   * normalized domain — an absent or invalid header never clears the
   * stored value. No-op for unclaimed users.
   */
  setUserCompany(user: string, company: string): boolean {
    const prev = this.getUserCompany(user);
    this.setUserCompanyStmt.run({ $username: user, $company: company });
    // Signal an actual change so the caller can invalidate company-scoped
    // caches — frozen entries otherwise serve the OLD company grouping for
    // up to 24h after an alias/header fix.
    return this.getUserCompany(user) !== prev;
  }

  /** A user's stored company affiliation; null = never reported. */
  getUserCompany(user: string): string | null {
    return this.getUserCompanyStmt.get(user)?.company ?? null;
  }

  /** Read a server_meta value. null when the key was never written. */
  getMeta(key: string): string | null {
    return this.getMetaStmt.get(key)?.value ?? null;
  }

  /** Upsert a server_meta value. */
  setMeta(key: string, value: string): void {
    this.setMetaStmt.run({ $key: key, $value: value });
  }

  /** Delete one server_meta key (no-op if absent). */
  deleteMeta(key: string): void {
    this.db.prepare("DELETE FROM server_meta WHERE key = ?").run(key);
  }

  close(): void {
    try {
      // Refresh planner stats if the data distribution drifted since boot;
      // near-free when nothing changed.
      this.db.exec("PRAGMA optimize;");
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    } catch {
      // best-effort: WAL + synchronous=NORMAL is crash-safe regardless
    }
    this.db.close();
  }
}
