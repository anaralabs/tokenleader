#!/usr/bin/env bun
/**
 * One-shot repair: re-label Codex rows that the parser filed under the
 * placeholder model.
 *
 * WHY THESE ROWS ARE WRONG
 * Codex writes `turn_context` (which carries the model) once per TURN, but
 * the daemon reads each rollout incrementally every ~300s. A read that
 * opened mid-turn saw token_count lines with no turn_context in its window,
 * so the parser fell back to LEGACY_FALLBACK_MODEL ("gpt-5") and billed the
 * turn to a model nobody ran — at roughly a quarter of the real rate. The
 * forward fix (FileState.lastModel) stops the bleed; it cannot repair rows
 * already written, and a byte-0 re-parse would be rejected by the ingest
 * dedup index, which does not include the model column. Hence a direct
 * UPDATE.
 *
 * WHAT IT DOES
 * For each (user, sessionId) that contains placeholder rows, find the real
 * models used in that same session and re-point the placeholder rows at the
 * dominant one (most assistant events, ties broken by token volume then
 * name). Sessions with no real model are LEFT ALONE — there is nothing to
 * attribute them to, and guessing would be fabrication.
 *
 * SAFETY
 *   - --dry-run (default) writes nothing and prints the full plan.
 *   - --apply performs the update inside ONE transaction.
 *   - Every touched row is copied to _backup_codex_model_reattr first,
 *     carrying its original model, so the whole thing is reversible.
 *   - --since / --until bound the window (half-open, unix ms) so the old
 *     pre-turn_context era can be excluded.
 *   - Rows are matched on source='codex' only; the Cursor rows that
 *     legitimately carry this model name are never touched.
 *
 * The rollup is derived data, so it is dropped for the affected cells and
 * left for the server's boot audit to rebuild.
 */
import { Database } from "bun:sqlite";

const PLACEHOLDER = "gpt-5";
const BACKUP_TABLE = "_backup_codex_model_reattr";

interface Args {
  db: string;
  apply: boolean;
  since: number;
  until: number;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const db = get("--db") ?? process.env.TOKENLEADER_DB;
  if (!db) {
    console.error(
      "usage: reattribute-codex-model.ts --db <path> [--apply] [--since ms] [--until ms]",
    );
    process.exit(2);
  }
  return {
    db,
    apply: argv.includes("--apply"),
    // Default lower bound: 2026-01-01. Everything earlier predates
    // turn_context in the rollout format, so those rows have no recoverable
    // model and must not be touched.
    since: Number(get("--since") ?? Date.UTC(2026, 0, 1)),
    until: Number(get("--until") ?? Number.MAX_SAFE_INTEGER),
  };
}

const args = parseArgs(process.argv.slice(2));
const db = new Database(args.db, args.apply ? { readwrite: true } : { readonly: true });
db.exec("PRAGMA busy_timeout=15000;");

// Sessions holding placeholder rows, with the real models seen alongside.
// One pass: every codex row in window whose session has >=1 placeholder row.
const rows = db
  .query<
    { sessionId: string; user: string; model: string; n: number; toks: number },
    [number, number, number, number]
  >(
    `SELECT sessionId, user, model,
            COUNT(*) AS n,
            COALESCE(SUM(inputTokens + outputTokens + cacheReadTokens), 0) AS toks
       FROM events
      WHERE source = 'codex'
        AND messageType = 'assistant'
        AND timestamp >= ? AND timestamp < ?
        AND sessionId IN (
              SELECT DISTINCT sessionId FROM events
               WHERE source = 'codex' AND model = '${PLACEHOLDER}'
                 AND timestamp >= ? AND timestamp < ?
            )
      GROUP BY sessionId, user, model`,
  )
  .all(args.since, args.until, args.since, args.until) as Array<{
  sessionId: string;
  user: string;
  model: string;
  n: number;
  toks: number;
}>;

interface Plan {
  sessionId: string;
  user: string;
  target: string;
  rows: number;
}
const bySession = new Map<string, typeof rows>();
for (const r of rows) {
  const list = bySession.get(r.sessionId) ?? [];
  list.push(r);
  bySession.set(r.sessionId, list);
}

const plans: Plan[] = [];
let skippedNoReal = 0;
let skippedRows = 0;
for (const [sessionId, list] of bySession) {
  const placeholder = list.find((r) => r.model === PLACEHOLDER);
  if (!placeholder) continue;
  const real = list.filter((r) => r.model !== PLACEHOLDER);
  if (real.length === 0) {
    skippedNoReal++;
    skippedRows += placeholder.n;
    continue;
  }
  // Dominant real model: most assistant events, then token volume, then a
  // stable name tiebreak so a rerun produces the identical plan.
  real.sort((a, b) => b.n - a.n || b.toks - a.toks || (a.model < b.model ? -1 : 1));
  plans.push({
    sessionId,
    user: placeholder.user,
    target: real[0]!.model,
    rows: placeholder.n,
  });
}

const totalRows = plans.reduce((s, p) => s + p.rows, 0);
const byUser = new Map<string, number>();
const byTarget = new Map<string, number>();
for (const p of plans) {
  byUser.set(p.user, (byUser.get(p.user) ?? 0) + p.rows);
  byTarget.set(p.target, (byTarget.get(p.target) ?? 0) + p.rows);
}

console.log(`db          ${args.db}`);
console.log(`window      [${args.since}, ${args.until})`);
console.log(`sessions    ${plans.length} reattributable, ${skippedNoReal} skipped (no real model)`);
console.log(`rows        ${totalRows} to relabel, ${skippedRows} left alone`);
console.log("\nby target model:");
for (const [m, n] of [...byTarget].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${m.padEnd(24)} ${n}`);
}
console.log("\nby user:");
for (const [u, n] of [...byUser].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${u.padEnd(20)} ${n}`);
}

if (!args.apply) {
  console.log("\nDRY RUN — nothing written. Re-run with --apply to commit.");
  process.exit(0);
}

db.exec(`CREATE TABLE IF NOT EXISTS ${BACKUP_TABLE} (
  id INTEGER PRIMARY KEY, user TEXT, sessionId TEXT, oldModel TEXT, newModel TEXT, movedAt INTEGER
)`);

const backup = db.prepare(
  `INSERT OR IGNORE INTO ${BACKUP_TABLE} (id, user, sessionId, oldModel, newModel, movedAt)
   SELECT id, user, sessionId, model, ?, ? FROM events
    WHERE source='codex' AND model=? AND sessionId=? AND timestamp>=? AND timestamp<?`,
);
const update = db.prepare(
  `UPDATE events SET model = ?
    WHERE source='codex' AND model=? AND sessionId=? AND timestamp>=? AND timestamp<?`,
);

const now = Date.now();
const tx = db.transaction((ps: Plan[]) => {
  for (const p of ps) {
    backup.run(p.target, now, PLACEHOLDER, p.sessionId, args.since, args.until);
    update.run(p.target, PLACEHOLDER, p.sessionId, args.since, args.until);
  }
  // The rollup is derived; drop it so the server's boot audit rebuilds it
  // from the corrected rows rather than serving stale per-model splits.
  db.exec("DELETE FROM events_roll_day; DELETE FROM events_roll_dirty;");
});
tx(plans);

const left = db
  .query<{ n: number }, [number, number]>(
    `SELECT COUNT(*) AS n FROM events WHERE source='codex' AND model='${PLACEHOLDER}' AND timestamp>=? AND timestamp<?`,
  )
  .get(args.since, args.until);
console.log(
  `\nAPPLIED. ${totalRows} rows relabelled; ${left?.n ?? "?"} placeholder rows remain in window.`,
);
console.log(`Backup in ${BACKUP_TABLE}. Rollup cleared — restart the server to rebuild it.`);
db.close();
