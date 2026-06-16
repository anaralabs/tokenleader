#!/usr/bin/env bash
# End-to-end production simulation (local server + real daemon/CLI).
# Runs against an ISOLATED state dir so it never touches the user's real
# daemon state. Cursor credentials are copied in read-only; the localhost
# endpoint override is written into the throwaway dir and discarded on exit.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REAL_STATE_DIR="${TOKENLEADER_STATE_DIR:-$HOME/.local/share/anara-leaderboard}"
E2E_DB="${E2E_DB:-/tmp/tokenleader-e2e-prod/db.sqlite}"
SERVER_PORT="${SERVER_PORT:-8787}"
SERVER_PID=""

# Isolated state dir — exported so the daemon/CLI never read or write the real
# one ($HOME/.local/share/anara-leaderboard).
STATE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/tokenleader-e2e.XXXXXX")"
export TOKENLEADER_STATE_DIR="$STATE_DIR"
# Same user for sync-cursor, the tick, and the verify query.
export TOKENLEADER_USER="${TOKENLEADER_USER:-tavi}"

cleanup() {
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$STATE_DIR"
}
trap cleanup EXIT

mkdir -p "$(dirname "$E2E_DB")"
rm -f "$E2E_DB"

# Seed Cursor credentials from the real state dir (read-only copy) so
# sync-cursor can authenticate without us touching the real dir.
for f in cursor_token cursor_credentials.json; do
  if [[ -f "$REAL_STATE_DIR/$f" ]]; then
    cp "$REAL_STATE_DIR/$f" "$STATE_DIR/$f"
  fi
done

# Endpoint override (must be http://localhost — daemon security rule). Lives in
# the throwaway dir, so the real daemon is never repointed.
printf 'http://localhost:%s\n' "$SERVER_PORT" > "$STATE_DIR/endpoint"

echo "==> Starting production-like server on http://localhost:${SERVER_PORT}"
PORT="$SERVER_PORT" TOKENLEADER_DB="$E2E_DB" bun run "$ROOT/src/server/main.ts" &
SERVER_PID=$!
for _ in $(seq 1 30); do
  if curl -sf "http://localhost:${SERVER_PORT}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done
curl -sf "http://localhost:${SERVER_PORT}/health" >/dev/null

if [[ ! -f "$STATE_DIR/cursor_token" && ! -f "$STATE_DIR/cursor_credentials.json" ]]; then
  echo "ERROR: no Cursor credentials in $REAL_STATE_DIR — run: tokenleader login-cursor --auto (macOS) or tokenleader login-cursor '<token>'"
  exit 1
fi

BIN="$ROOT/bin/anara-leaderboard"
if [[ ! -x "$BIN" ]]; then
  echo "ERROR: build the daemon first: cd $ROOT && bun run build:daemon"
  exit 1
fi

echo "==> Full backfill (sync-cursor)"
"$BIN" sync-cursor

echo "==> Daemon single tick (TOKENLEADER_RUN_ONCE=1)"
TOKENLEADER_ENDPOINT="http://localhost:${SERVER_PORT}" \
TOKENLEADER_RUN_ONCE=1 \
"$BIN"

echo ""
echo "==> Dashboard: http://localhost:${SERVER_PORT}/"
curl -sf "http://localhost:${SERVER_PORT}/stats?user=${TOKENLEADER_USER}" | bun -e "
const j = await Bun.stdin.json();
console.log('User:', j.user);
console.log('Events:', (j.byModel||[]).reduce((s,r)=>s+r.count,0));
console.log('Total cost: \$' + (j.totalCostUsd?.toFixed(2) ?? '0'));
"
echo ""
echo "Done. Isolated state dir removed on exit."
