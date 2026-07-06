#!/usr/bin/env bash
# Client-side uninstaller for the tokenleader daemon.
set -euo pipefail

# --- ANSI helpers ----------------------------------------------------------
if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_GREEN=$'\033[0;32m'; C_YELLOW=$'\033[0;33m'
  C_RED=$'\033[0;31m'; C_BLUE=$'\033[0;34m'
else
  C_RESET=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_BLUE=""
fi
info() { printf "%s>%s %s\n" "$C_BLUE" "$C_RESET" "$*"; }
ok()   { printf "%sOK%s %s\n" "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf "%s!!%s %s\n" "$C_YELLOW" "$C_RESET" "$*" >&2; }
err()  { printf "%sXX%s %s\n" "$C_RED" "$C_RESET" "$*" >&2; }

if [ "$(uname -s)" != "Darwin" ]; then
  err "This uninstaller only supports macOS."
  exit 1
fi

LABEL="sh.anara.leaderboard"
WATCHDOG_LABEL="${LABEL}.watchdog"
DOMAIN="gui/$(id -u)"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
WATCHDOG_PLIST="$HOME/Library/LaunchAgents/${WATCHDOG_LABEL}.plist"
BIN="$HOME/.local/bin/anara-leaderboard"
BIN_WATCHDOG="$BIN.watchdog"
STATE_DIR="$HOME/.local/share/anara-leaderboard"
LOG_DIR="$HOME/Library/Logs/anara-leaderboard"
SECRET_FILE="$STATE_DIR/secret"

# Server URL is needed for the uninstall-event POST. We pull it from the
# plist's EnvironmentVariables.TOKENLEADER_ENDPOINT (set at install time)
# so this script doesn't have to ship a hardcoded URL — the source of
# truth follows whichever server this Mac was installed against.
# Override with TOKENLEADER_ENDPOINT env to point at a different server.
SERVER_URL="${TOKENLEADER_ENDPOINT:-}"

# --- notify the server BEFORE we delete local state ------------------------
# POST $SERVER_URL/events/uninstall with the on-disk secret so the server
# can stamp user_secrets.uninstalled_at and surface this on the dashboard.
# This MUST run before we bootout / rm the plist (we need the plist on
# disk to recover TOKENLEADER_USER) and before we rm $SECRET_FILE.
# --max-time 5 + --fail-with-body + warn-and-continue: a server outage
# must never block local cleanup.
notify_server_uninstall() {
  if [ -z "$SERVER_URL" ] && [ -f "$PLIST" ]; then
    SERVER_URL="$(/usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:TOKENLEADER_ENDPOINT' "$PLIST" 2>/dev/null || true)"
  fi
  if [ -z "$SERVER_URL" ]; then
    info "Skipping server notify (no endpoint in plist or TOKENLEADER_ENDPOINT)."
    return 0
  fi
  local handle=""
  if [ -f "$PLIST" ]; then
    handle="$(/usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:TOKENLEADER_USER' "$PLIST" 2>/dev/null || true)"
  fi
  if [ -z "$handle" ] && [ -f "$PLIST" ]; then
    # Fallback grep: scan the plist for the value pair. PlistBuddy ships
    # with macOS, but the cost of a fallback is nil.
    handle="$(awk '/<key>TOKENLEADER_USER<\/key>/{getline; gsub(/.*<string>|<\/string>.*/, ""); print; exit}' "$PLIST" 2>/dev/null || true)"
  fi
  local secret=""
  if [ -r "$SECRET_FILE" ]; then
    secret="$(tr -d '[:space:]' < "$SECRET_FILE" 2>/dev/null || true)"
  fi
  if [ -z "$handle" ] || [ -z "$secret" ]; then
    info "Skipping server notify (handle/secret not on disk)."
    return 0
  fi
  info "Notifying $SERVER_URL of uninstall for $handle..."
  local body
  body="$(printf '{"user":"%s"}' "$handle")"
  if curl --max-time 5 --fail-with-body -sS \
       -H "Content-Type: application/json" \
       -H "X-Tokenleader-Secret: $secret" \
       -X POST "$SERVER_URL/events/uninstall" \
       --data "$body" >/dev/null 2>&1; then
    ok "Server acknowledged."
  else
    warn "Server notify failed (continuing with local cleanup)."
  fi
}
notify_server_uninstall

# --- stop the agents -------------------------------------------------------
# Watchdog FIRST: its boot-time self-heal re-bootstraps an absent daemon
# label, so booting the daemon out first invites a resurrection race.
# Pre-v0.6.0 installs have no watchdog — absence of each is fine.
info "Stopping watchdog LaunchAgent (if running)..."
if launchctl bootout "$DOMAIN/$WATCHDOG_LABEL" 2>/dev/null; then
  ok  "Booted out $WATCHDOG_LABEL."
else
  info "$WATCHDOG_LABEL was not loaded (pre-v0.6.0 install, or already gone)."
fi

info "Stopping LaunchAgent (if running)..."
if launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null; then
  ok  "Booted out $LABEL."
else
  warn "$LABEL was not loaded (or bootout failed); continuing."
fi

# --- remove plists + binary ------------------------------------------------
if [ -f "$WATCHDOG_PLIST" ]; then
  rm -f "$WATCHDOG_PLIST"
  ok "Removed $WATCHDOG_PLIST"
else
  info "No plist at $WATCHDOG_PLIST"
fi

if [ -f "$PLIST" ]; then
  rm -f "$PLIST"
  ok "Removed $PLIST"
else
  info "No plist at $PLIST"
fi

if [ -f "$BIN" ]; then
  rm -f "$BIN"
  ok "Removed $BIN"
else
  info "No binary at $BIN"
fi

# The .watchdog hardlink shares the daemon binary's inode; remove it too or
# the watchdog's plist would keep a runnable copy alive after uninstall.
if [ -f "$BIN_WATCHDOG" ]; then
  rm -f "$BIN_WATCHDOG"
  ok "Removed $BIN_WATCHDOG"
fi

# The CLI-name symlink the installer (or daemon) created beside the binary.
if [ -L "$HOME/.local/bin/tokenleader" ]; then
  rm -f "$HOME/.local/bin/tokenleader"
  ok "Removed $HOME/.local/bin/tokenleader"
fi

# --- prompt about state/logs ----------------------------------------------
ANSWER="${TOKENLEADER_PURGE:-}"
if [ -z "$ANSWER" ]; then
  printf "Also delete daemon state directory %s and logs %s? [y/N] " \
    "$STATE_DIR" "$LOG_DIR"
  read -r ANSWER || ANSWER=""
fi
case "$ANSWER" in
  y|Y|yes|YES)
    rm -rf "$STATE_DIR" "$LOG_DIR"
    ok "Removed state and logs."
    ;;
  *)
    info "Keeping $STATE_DIR and $LOG_DIR."
    ;;
esac

ok "Uninstall complete."
