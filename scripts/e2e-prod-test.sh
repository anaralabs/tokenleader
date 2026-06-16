#!/usr/bin/env bash
# End-to-end production simulation (local server + real daemon/CLI).
# Temporarily repoints the daemon at http://localhost:8787 via the same
# endpoint-override file production migrations use.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE_DIR="${TOKENLEADER_STATE_DIR:-$HOME/.local/share/anara-leaderboard}"
E2E_DB="${E2E_DB:-/tmp/tokenleader-e2e-prod/db.sqlite}"
SERVER_PORT="${SERVER_PORT:-8787}"
SERVER_PID=""
ENDPOINT_BACKUP=""

cleanup() {
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [[ -n "$ENDPOINT_BACKUP" ]]; then
    if [[ -f "$ENDPOINT_BACKUP" ]]; then
      mv "$ENDPOINT_BACKUP" "$STATE_DIR/endpoint"
    elif [[ -f "$STATE_DIR/endpoint" ]]; then
      rm -f "$STATE_DIR/endpoint"
    fi
  fi
}
trap cleanup EXIT

mkdir -p "$(dirname "$E2E_DB")"
rm -f "$E2E_DB"

# Save / replace endpoint override (must be http://localhost — daemon security rule).
if [[ -f "$STATE_DIR/endpoint" ]]; then
  ENDPOINT_BACKUP="$STATE_DIR/endpoint.e2e-backup.$$"
  mv "$STATE_DIR/endpoint" "$ENDPOINT_BACKUP"
fi
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

if [[ ! -f "$STATE_DIR/cursor_token" ]]; then
  echo "ERROR: no cursor_token — run: tokenleader login-cursor '<token>'"
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
TOKENLEADER_USER="${TOKENLEADER_USER:-tavi}" \
TOKENLEADER_ENDPOINT="https://tokenleader-production.up.railway.app" \
TOKENLEADER_STATE_DIR="$STATE_DIR" \
TOKENLEADER_RUN_ONCE=1 \
"$BIN"

echo ""
echo "==> Dashboard: http://localhost:${SERVER_PORT}/"
curl -sf "http://localhost:${SERVER_PORT}/stats?user=${TOKENLEADER_USER:-tavi}" | bun -e "
const j = await Bun.stdin.json();
console.log('User:', j.user);
console.log('Events:', (j.byModel||[]).reduce((s,r)=>s+r.count,0));
console.log('Total cost: \$' + (j.totalCostUsd?.toFixed(2) ?? '0'));
"
echo ""
echo "Done. Endpoint override restored on exit."
