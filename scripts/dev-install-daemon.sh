#!/usr/bin/env bash
# Install a locally built daemon binary without tripping macOS over a running
# LaunchAgent copy. Use this while developing on a feature branch instead of:
#   cp bin/anara-leaderboard ~/.local/bin/anara-leaderboard
#
# Usage (from repo root):
#   ./scripts/dev-install-daemon.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LABEL="sh.anara.leaderboard"
DOMAIN="gui/$(id -u)"
BIN_SRC="$REPO_DIR/bin/anara-leaderboard"
BIN_DST="$HOME/.local/bin/anara-leaderboard"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "error: macOS only" >&2
  exit 1
fi

mkdir -p "$HOME/.local/bin"

echo "Building daemon..."
( cd "$REPO_DIR" && bun run build:daemon )

if [ ! -x "$BIN_SRC" ]; then
  echo "error: build did not produce $BIN_SRC" >&2
  exit 1
fi

echo "Stopping LaunchAgent (if running)..."
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true

tmp="${BIN_DST}.tmp.$$"
trap 'rm -f "$tmp" 2>/dev/null || true' EXIT
cp "$BIN_SRC" "$tmp"
chmod +x "$tmp"
xattr -cr "$tmp" 2>/dev/null || true
mv -f "$tmp" "$BIN_DST"
xattr -cr "$BIN_DST" 2>/dev/null || true

if [ ! -e "$HOME/.local/bin/tokenleader" ] || [ -L "$HOME/.local/bin/tokenleader" ]; then
  ln -sfn "$BIN_DST" "$HOME/.local/bin/tokenleader"
fi

if [ -f "$PLIST" ]; then
  echo "Restarting LaunchAgent..."
  launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null || true
  launchctl kickstart -k "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
fi

echo "Installed $BIN_DST"
echo "Try: tokenleader --version"
echo "CLI during dev (no install): bun run cli login-cursor --auto"
