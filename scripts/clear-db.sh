#!/usr/bin/env bash
# tokenleader server-side DB cleaner. Run on the server host only.
#
# Default DB path:
#   ${TOKENLEADER_DB:-$HOME/Library/Application Support/tokenleader/tokenleader.sqlite}
#
# Modes (mutually exclusive):
#   --all                  wipe events table only (keep user_secrets so existing
#                          daemons keep posting under their claimed handle)
#   --user=NAME            delete only NAME's events
#   --reset-user=NAME      delete NAME's events AND TOFU secret row
#                          (next post from that machine claims fresh)
#   --full                 drop BOTH tables and recreate (nuclear)
#
# Every mode also clears the matching rows from the events_roll_day /
# events_roll_dirty dashboard aggregate, which is authoritative — see the
# comment above the execute block. Restart the server afterwards.
#
# Confirmation:
#   Prompts "Type 'yes' to confirm:" unless --yes or TOKENLEADER_CONFIRM=yes.
#
# Auth:
#   None — this is a local sqlite3 shellout, run by whoever can read the DB
#   file. The HTTP analogue is POST /admin/clear, gated by
#   TOKENLEADER_ADMIN_TOKEN.

set -euo pipefail

DEFAULT_DB="$HOME/Library/Application Support/tokenleader/tokenleader.sqlite"
DB="${TOKENLEADER_DB:-$DEFAULT_DB}"

MODE=""
USERARG=""
ASSUME_YES="${TOKENLEADER_CONFIRM:-}"
[ "$ASSUME_YES" = "yes" ] && ASSUME_YES="1" || ASSUME_YES=""

usage() {
  cat <<USAGE
clear-db.sh — tokenleader sqlite maintenance

Usage:
  TOKENLEADER_DB=path/to.sqlite scripts/clear-db.sh <mode> [--yes]

Modes:
  --all                  wipe events table only (keep user_secrets)
  --user=NAME            wipe events for NAME only
  --reset-user=NAME      wipe NAME's events + remove TOFU claim
  --full                 DROP both tables and recreate (nuclear)
  -h, --help             show this help

Flags:
  --yes                  skip the interactive confirmation prompt
                         (equivalent to TOKENLEADER_CONFIRM=yes)

DB path: $DB
USAGE
}

# --- parse args ------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help)
      usage; exit 0 ;;
    --all)
      [ -n "$MODE" ] && { echo "error: only one mode flag allowed" >&2; exit 2; }
      MODE="all" ;;
    --full)
      [ -n "$MODE" ] && { echo "error: only one mode flag allowed" >&2; exit 2; }
      MODE="full" ;;
    --user=*)
      [ -n "$MODE" ] && { echo "error: only one mode flag allowed" >&2; exit 2; }
      MODE="user"; USERARG="${1#--user=}"
      [ -z "$USERARG" ] && { echo "error: --user requires a value" >&2; exit 2; } ;;
    --reset-user=*)
      [ -n "$MODE" ] && { echo "error: only one mode flag allowed" >&2; exit 2; }
      MODE="reset-user"; USERARG="${1#--reset-user=}"
      [ -z "$USERARG" ] && { echo "error: --reset-user requires a value" >&2; exit 2; } ;;
    --yes)
      ASSUME_YES="1" ;;
    *)
      echo "error: unknown arg: $1" >&2
      usage >&2
      exit 2 ;;
  esac
  shift
done

if [ -z "$MODE" ]; then
  echo "error: no mode specified" >&2
  usage >&2
  exit 2
fi

# --- prerequisites ---------------------------------------------------------
command -v sqlite3 >/dev/null 2>&1 || {
  echo "error: sqlite3 CLI not found (ships with macOS)" >&2
  exit 1
}

if [ ! -f "$DB" ]; then
  echo "error: DB not found at: $DB" >&2
  echo "set TOKENLEADER_DB or run on the server host" >&2
  exit 1
fi

# --- show summary + confirm -----------------------------------------------
case "$MODE" in
  all)        ACTION="DELETE FROM events  (keep user_secrets)" ;;
  user)       ACTION="DELETE FROM events  WHERE user = '$USERARG'" ;;
  reset-user) ACTION="DELETE FROM events  + user_secrets row for '$USERARG'" ;;
  full)       ACTION="DROP both tables and recreate schema" ;;
esac

EVENTS_BEFORE="$(sqlite3 "$DB" 'SELECT COUNT(*) FROM events' 2>/dev/null || echo 0)"

printf 'DB:     %s\n' "$DB"
printf 'Mode:   %s\n' "$MODE"
printf 'Action: %s\n' "$ACTION"
printf 'Events table size (before): %s rows\n' "$EVENTS_BEFORE"

if [ -z "$ASSUME_YES" ]; then
  printf "Type 'yes' to confirm: "
  read -r REPLY
  if [ "$REPLY" != "yes" ]; then
    echo "aborted (no changes made)" >&2
    exit 1
  fi
fi

# --- execute ---------------------------------------------------------------
# events_roll_day is the dashboard's pre-aggregated source and it is
# AUTHORITATIVE — the stats routes read it and never fall back to scanning
# events. Deleting rows out of band here without clearing it leaves a running
# server reporting the deleted users' totals indefinitely: nothing in the
# server observes this script, so no cache TTL and no restart-free path
# corrects it. So every mode below clears the rollup for the same scope in the
# SAME sqlite3 invocation (one implicit transaction), which keeps the two
# tables consistent for the NEXT process to open the file. A server that was
# already running still holds a warm stats cache — hence the closing notice.
case "$MODE" in
  all)
    sqlite3 "$DB" 'DELETE FROM events; DELETE FROM events_roll_day; DELETE FROM events_roll_dirty;'
    ;;
  user)
    SAFE="$(printf '%s' "$USERARG" | sed "s/'/''/g")"
    sqlite3 "$DB" "DELETE FROM events WHERE user = '$SAFE';
                   DELETE FROM events_roll_day WHERE user = '$SAFE';
                   DELETE FROM events_roll_dirty WHERE user = '$SAFE';"
    ;;
  reset-user)
    SAFE="$(printf '%s' "$USERARG" | sed "s/'/''/g")"
    sqlite3 "$DB" "DELETE FROM events WHERE user = '$SAFE';
                   DELETE FROM events_roll_day WHERE user = '$SAFE';
                   DELETE FROM events_roll_dirty WHERE user = '$SAFE';
                   DELETE FROM user_secrets WHERE username = '$SAFE';"
    ;;
  full)
    sqlite3 "$DB" 'DROP TABLE IF EXISTS events; DROP TABLE IF EXISTS user_secrets;
                   DROP TABLE IF EXISTS events_roll_day; DROP TABLE IF EXISTS events_roll_dirty;'
    sqlite3 "$DB" <<'SQL'
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user TEXT NOT NULL,
  source TEXT NOT NULL,
  sessionId TEXT NOT NULL,
  messageId TEXT NOT NULL,
  requestId TEXT,
  timestamp INTEGER NOT NULL,
  model TEXT NOT NULL,
  inputTokens INTEGER NOT NULL DEFAULT 0,
  outputTokens INTEGER NOT NULL DEFAULT 0,
  cacheCreationTokens INTEGER NOT NULL DEFAULT 0,
  cacheReadTokens INTEGER NOT NULL DEFAULT 0,
  reasoningTokens INTEGER,
  ingestedAt INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS events_dedup
  ON events (user, source, messageId, COALESCE(requestId, ''));
CREATE INDEX IF NOT EXISTS events_user_ts ON events (user, timestamp DESC);
CREATE INDEX IF NOT EXISTS events_user_model ON events (user, model);
CREATE TABLE IF NOT EXISTS user_secrets (
  username    TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL,
  claimed_at  INTEGER NOT NULL
);
SQL
    ;;
esac

EVENTS_AFTER="$(sqlite3 "$DB" 'SELECT COUNT(*) FROM events' 2>/dev/null || echo 0)"
SECRETS_AFTER="$(sqlite3 "$DB" 'SELECT COUNT(*) FROM user_secrets' 2>/dev/null || echo 0)"

printf 'done.\n'
printf 'Events table size (after):  %s rows\n' "$EVENTS_AFTER"
printf 'user_secrets size (after):  %s rows\n' "$SECRETS_AFTER"
printf '\nNOTE: a server process that was ALREADY RUNNING when this ran still\n'
printf '      holds prepared statements and a warm stats cache. Restart it, or\n'
printf '      POST /admin/rollup-audit with {"rebuild":true}, before trusting\n'
printf '      the dashboard.\n'
