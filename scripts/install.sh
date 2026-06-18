#!/usr/bin/env bash
# Local-clone installer for the tokenleader daemon. Runs on each teammate's
# Mac. Idempotent: safe to re-run.
#
# This is the dev/admin variant of the curl|bash installer served by the
# server (src/server/install-script.ts): same UX, but step 2 builds the
# binary locally instead of downloading it.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=plist-templates.sh
source "$SCRIPT_DIR/plist-templates.sh"

LABEL="sh.anara.leaderboard"
DOMAIN="gui/$(id -u)"
LOG_DIR="$HOME/Library/Logs/anara-leaderboard"
STDERR_LOG="$LOG_DIR/stderr.log"
STDOUT_LOG="$LOG_DIR/stdout.log"
BIN_DST="$HOME/.local/bin/anara-leaderboard"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
BIN_SRC="$REPO_DIR/bin/anara-leaderboard"
TOTAL_STEPS=5

# --- color setup ----------------------------------------------------------
if [ -t 1 ]; then
  C_RESET=$'\033[0m'
  C_BOLD=$'\033[1m'
  C_DIM=$'\033[2m'
  C_GREEN=$'\033[0;32m'
  C_RED=$'\033[0;31m'
  C_YELLOW=$'\033[0;33m'
  C_CYAN=$'\033[0;36m'
else
  C_RESET=""; C_BOLD=""; C_DIM=""
  C_GREEN=""; C_RED=""; C_YELLOW=""; C_CYAN=""
fi

# Immediate "we started" signal so users see something even if the next
# few lines blow up.
printf "%stokenleader installer starting...%s\n" "$C_DIM" "$C_RESET" >&2

# --- platform check -------------------------------------------------------
if [ "$(uname -s)" != "Darwin" ]; then
  printf "%sThis installer only supports macOS. Detected: %s.%s\n" \
    "$C_RED" "$(uname -s)" "$C_RESET" >&2
  exit 1
fi

RAW_ARCH="$(uname -m)"
case "$RAW_ARCH" in
  arm64)  ARCH_LABEL="Apple Silicon (arm64)" ;;
  x86_64) ARCH_LABEL="Intel Mac (x86_64)" ;;
  *)      ARCH_LABEL="$RAW_ARCH (unrecognized; trying anyway)" ;;
esac

# --- need a tty for prompts when piped through bash -----------------------
if [ ! -t 0 ] && [ -r /dev/tty ]; then
  exec </dev/tty
fi

# --- endpoint discovery ---------------------------------------------------
# The local-clone installer needs an endpoint to template into the plist.
# Honor $TOKENLEADER_ENDPOINT (CI/admin) first; otherwise prompt with the
# example as a default.
DEFAULT_ENDPOINT="https://example-mac-mini.tailnet.ts.net"
ENDPOINT="${TOKENLEADER_ENDPOINT:-}"

# --- banner + pre-flight --------------------------------------------------
DIVIDER="${C_DIM}──────────────────────────────────────────────────────────────────${C_RESET}"

print_banner() {
  printf "\n"
  printf "  %stokenleader installer%s  %s(local clone)%s\n" \
    "$C_BOLD" "$C_RESET" "$C_DIM" "$C_RESET"
  printf "  %sanara team token-usage leaderboard%s\n" "$C_DIM" "$C_RESET"
  printf "\n"
  printf "  %srepo%s        %s%s%s\n" \
    "$C_DIM" "$C_RESET" "$C_BOLD" "$REPO_DIR" "$C_RESET"
  printf "  %splatform%s    %s%s%s\n" \
    "$C_DIM" "$C_RESET" "$C_BOLD" "$ARCH_LABEL" "$C_RESET"
  printf "  %shandle%s      %s%s%s  %s(from %s)%s\n" \
    "$C_DIM" "$C_RESET" "$C_BOLD" "$USER_NAME" "$C_RESET" \
    "$C_DIM" "$HANDLE_SOURCE" "$C_RESET"
  printf "  %sinstalling%s  %s~/.local/bin/anara-leaderboard%s  +  %sLaunchAgent%s\n" \
    "$C_DIM" "$C_RESET" "$C_BOLD" "$C_RESET" "$C_BOLD" "$C_RESET"
  printf "\n"
  printf "  %sto use a different handle, re-run with --name=...%s\n" "$C_DIM" "$C_RESET"
  printf "\n"
  printf "%s\n" "$DIVIDER"
  printf "\n"
}

# --- prompt for leaderboard name + endpoint -------------------------------
# Ask for a human name; slugify into a leaderboard handle. Confirm or
# accept an override. TOKENLEADER_USER, if set, is slugified directly.
slugify() {
  printf '%s' "$1" \
    | LC_ALL=C tr '[:upper:]' '[:lower:]' \
    | LC_ALL=C sed -E 's/[^a-z0-9_-]+/-/g; s/-+/-/g; s/^-+//; s/-+$//' \
    | cut -c1-32
}

resolve_handle() {
  local raw="${ARG_NAME:-}"
  local source="--name"
  if [ -z "$raw" ]; then
    raw="${TOKENLEADER_USER:-}"
    source="TOKENLEADER_USER"
  fi
  if [ -z "$raw" ]; then
    raw="${USER:-$(id -un 2>/dev/null || echo)}"
    source="\$USER"
  fi
  USER_NAME="$(slugify "$raw")"
  if [ -z "$USER_NAME" ]; then
    USER_NAME="tokenleader-user"
    source="fallback"
  fi
  HANDLE_SOURCE="$source"
  HANDLE_RAW="$raw"
}

prompt_endpoint() {
  if [ -n "$ENDPOINT" ]; then
    if [[ "$ENDPOINT" =~ ^https?://[^[:space:]]+$ ]]; then
      printf "  %sendpoint from \$TOKENLEADER_ENDPOINT:%s %s%s%s\n\n" \
        "$C_DIM" "$C_RESET" "$C_BOLD" "$ENDPOINT" "$C_RESET"
      return 0
    fi
    printf "  %s✗ \$TOKENLEADER_ENDPOINT=%s is not http(s); falling back to prompt.%s\n" \
      "$C_YELLOW" "$ENDPOINT" "$C_RESET" >&2
    ENDPOINT=""
  fi

  printf "  Server endpoint URL  %s[%s]%s\n\n" \
    "$C_DIM" "$DEFAULT_ENDPOINT" "$C_RESET"
  read -r -p "  > " ENDPOINT || ENDPOINT=""
  ENDPOINT="${ENDPOINT:-$DEFAULT_ENDPOINT}"
  if ! [[ "$ENDPOINT" =~ ^https?://[^[:space:]]+$ ]]; then
    printf "\n  %s✗ '%s' does not parse as an http(s) URL.%s\n" \
      "$C_RED" "$ENDPOINT" "$C_RESET" >&2
    exit 1
  fi
  printf "\n"
}

# --- spinner + step line --------------------------------------------------
SPINNER_PID=""
CUR_STEP_N=""
CUR_STEP_LABEL=""

cleanup_spinner() {
  if [ -n "$SPINNER_PID" ] && kill -0 "$SPINNER_PID" 2>/dev/null; then
    kill "$SPINNER_PID" 2>/dev/null || true
    wait "$SPINNER_PID" 2>/dev/null || true
  fi
  SPINNER_PID=""
}
trap 'cleanup_spinner; tput cnorm 2>/dev/null || true; rm -f "${tmp:-}" 2>/dev/null || true' EXIT INT TERM

step_start() {
  CUR_STEP_N="$1"
  CUR_STEP_LABEL="$2"
  if [ -t 1 ]; then
    tput civis 2>/dev/null || true
    (
      local frames='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
      local i=0
      while :; do
        local frame="${frames:$i:1}"
        printf "\r  %s[%d/%d]%s %s %s…………%s %s%s%s" \
          "$C_BOLD" "$CUR_STEP_N" "$TOTAL_STEPS" "$C_RESET" \
          "$CUR_STEP_LABEL" "$C_DIM" "$C_RESET" \
          "$C_CYAN" "$frame" "$C_RESET"
        i=$(( (i + 1) % 10 ))
        sleep 0.08
      done
    ) &
    SPINNER_PID=$!
    disown "$SPINNER_PID" 2>/dev/null || true
  else
    printf "  [%d/%d] %s … " "$CUR_STEP_N" "$TOTAL_STEPS" "$CUR_STEP_LABEL"
  fi
}

step_ok() {
  cleanup_spinner
  if [ -t 1 ]; then
    tput cnorm 2>/dev/null || true
    printf "\r\033[K  %s[%d/%d]%s %s %s…………%s %s✓%s" \
      "$C_BOLD" "$CUR_STEP_N" "$TOTAL_STEPS" "$C_RESET" \
      "$CUR_STEP_LABEL" "$C_DIM" "$C_RESET" \
      "$C_GREEN" "$C_RESET"
    if [ "$#" -gt 0 ] && [ -n "$1" ]; then
      printf "  %s%s%s" "$C_DIM" "$1" "$C_RESET"
    fi
    printf "\n"
  else
    printf "ok"
    if [ "$#" -gt 0 ] && [ -n "$1" ]; then printf " (%s)" "$1"; fi
    printf "\n"
  fi
}

step_warn() {
  cleanup_spinner
  if [ -t 1 ]; then
    tput cnorm 2>/dev/null || true
    printf "\r\033[K  %s[%d/%d]%s %s %s…………%s %s!%s" \
      "$C_BOLD" "$CUR_STEP_N" "$TOTAL_STEPS" "$C_RESET" \
      "$CUR_STEP_LABEL" "$C_DIM" "$C_RESET" \
      "$C_YELLOW" "$C_RESET"
    if [ "$#" -gt 0 ] && [ -n "$1" ]; then
      printf "  %s%s%s" "$C_YELLOW" "$1" "$C_RESET"
    fi
    printf "\n"
  else
    printf "warn\n"
  fi
}

step_fail() {
  cleanup_spinner
  if [ -t 1 ]; then
    tput cnorm 2>/dev/null || true
    printf "\r\033[K  %s[%d/%d]%s %s %s…………%s %s✗%s\n" \
      "$C_BOLD" "$CUR_STEP_N" "$TOTAL_STEPS" "$C_RESET" \
      "$CUR_STEP_LABEL" "$C_DIM" "$C_RESET" \
      "$C_RED" "$C_RESET"
  else
    printf "fail\n"
  fi
  if [ "$#" -gt 0 ] && [ -n "$1" ]; then
    printf "        %s↳ %s%s\n" "$C_RED" "$1" "$C_RESET" >&2
  fi
  exit 1
}

ensure_dirs() {
  mkdir -p "$HOME/.local/bin" \
           "$HOME/Library/LaunchAgents" \
           "$LOG_DIR" \
           "$HOME/.local/share/anara-leaderboard"
}

# --- step 2: build local binary -------------------------------------------
# Differs from the curl|bash variant: we run `bun run build:daemon` against
# the local clone instead of downloading. If bin/anara-leaderboard is already
# fresh we skip the build to keep re-runs fast.
do_build() {
  step_start 2 "Building local binary"
  if [ -x "$BIN_SRC" ]; then
    # Already built. Atomically replace the installed copy.
    tmp="${BIN_DST}.tmp.$$"
    if ! cp "$BIN_SRC" "$tmp" 2>/dev/null; then
      step_fail "could not copy $BIN_SRC -> $tmp"
    fi
    chmod +x "$tmp"
    # Stop the daemon only now, right before the swap: booting it out earlier
    # would leave it down if a build below failed. launchd has the old Mach-O
    # mapped, so overwriting in place risks a SIGKILL — bootout, then mv.
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    mv -f "$tmp" "$BIN_DST"
    step_ok "reused $BIN_SRC"
    return 0
  fi
  if ! command -v bun >/dev/null 2>&1; then
    step_fail "bun not found. Install it from https://bun.sh and rerun."
  fi
  # Build (stop the spinner first so bun's output isn't garbled by \r writes).
  cleanup_spinner
  if [ -t 1 ]; then
    tput cnorm 2>/dev/null || true
    printf "\r\033[K  %s[2/%d]%s Building local binary  %s(bun build:daemon)%s\n" \
      "$C_BOLD" "$TOTAL_STEPS" "$C_RESET" "$C_DIM" "$C_RESET"
  fi
  if ! ( cd "$REPO_DIR" && bun install >/dev/null 2>&1 && bun run build:daemon >/dev/null 2>&1 ); then
    CUR_STEP_N=2
    CUR_STEP_LABEL="Building local binary"
    step_fail "bun build:daemon failed; run 'bun run build:daemon' manually for the error"
  fi
  if [ ! -x "$BIN_SRC" ]; then
    CUR_STEP_N=2
    CUR_STEP_LABEL="Building local binary"
    step_fail "build did not produce $BIN_SRC"
  fi
  tmp="${BIN_DST}.tmp.$$"
  cp "$BIN_SRC" "$tmp"
  chmod +x "$tmp"
  # Build succeeded — now stop the daemon and swap the binary atomically.
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  mv -f "$tmp" "$BIN_DST"
  CUR_STEP_N=2
  CUR_STEP_LABEL="Built local binary"
  if [ -t 1 ]; then
    printf "  %s[2/%d]%s Built local binary  %s…………%s %s✓%s\n" \
      "$C_BOLD" "$TOTAL_STEPS" "$C_RESET" \
      "$C_DIM" "$C_RESET" "$C_GREEN" "$C_RESET"
  else
    printf "  [2/%d] built\n" "$TOTAL_STEPS"
  fi
}

# --- step 3: prepare binary -----------------------------------------------
# The binary is ad-hoc signed under our own identifier at build time
# (scripts/build-daemon.sh), so macOS attributes the LaunchAgent to us rather
# than to bun's author. All we need here is to strip the quarantine xattr.
do_codesign() {
  step_start 3 "Preparing binary"
  xattr -cr "$BIN_DST" 2>/dev/null || true
  step_ok
}

# --- step 4: launchagent --------------------------------------------------
write_plist_and_register() {
  step_start 4 "Registering LaunchAgent"
  render_daemon_plist "$USER_NAME" "$ENDPOINT" "$HOME" > "$PLIST"
  chmod 600 "$PLIST"
  if ! plutil -lint "$PLIST" >/dev/null 2>&1; then
    step_fail "generated plist failed plutil -lint (see $PLIST)"
  fi
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  launchctl enable "$DOMAIN/$LABEL" 2>/dev/null || true
  if ! launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null; then
    step_fail "launchctl bootstrap failed (run 'launchctl bootstrap $DOMAIN $PLIST' for the error)"
  fi
  launchctl kickstart -k "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
  step_ok
}

# --- step 5: start daemon -------------------------------------------------
# Confirm the daemon process is running; don't block on the first sync.
# A heavy CC user with 100k+ historical events takes 10-60s to scan and
# POST — fine to do in background. The dashboard fills in within seconds.
wait_for_first_tick() {
  step_start 5 "Starting daemon"
  launchctl kickstart -k "$DOMAIN/$LABEL" >/dev/null 2>&1 || true

  local deadline=$(( $(date +%s) + 5 ))
  local state=""
  while [ "$(date +%s)" -lt "$deadline" ]; do
    state="$(launchctl print "$DOMAIN/$LABEL" 2>/dev/null | awk -F'= *' '/^[[:space:]]*state /{print $2; exit}' | tr -d ' ')"
    if [ "$state" = "running" ]; then
      step_ok "running (first sync in progress in background)"
      return 0
    fi
    sleep 0.25
  done
  state="${state:-spawn-pending}"
  step_warn "daemon state: $state (it'll keep retrying; check logs at $STDERR_LOG)"
}

verify_on_server() {
  local body
  body="$(curl -fsS --max-time 5 "$ENDPOINT/stats/admin" 2>/dev/null || true)"
  if [ -z "$body" ]; then
    printf "        %s↳ server check skipped (couldn't reach %s)%s\n" \
      "$C_DIM" "$ENDPOINT/stats/admin" "$C_RESET"
    return 0
  fi
  if printf "%s" "$body" | grep -q "\"user\":\"$USER_NAME\""; then
    printf "        %s↳ %sserver saw your batch%s%s\n" \
      "$C_DIM" "$C_GREEN" "$C_RESET" "$C_DIM"
  else
    printf "        %s↳ server reachable; your batch hasn't landed yet%s\n" \
      "$C_DIM" "$C_RESET"
  fi
}

# --- summary --------------------------------------------------------------
print_summary() {
  printf "\n%s\n\n" "$DIVIDER"
  printf "  %sinstalled as%s     %s%s%s\n" \
    "$C_DIM" "$C_RESET" "$C_BOLD" "$USER_NAME" "$C_RESET"
  printf "  %sendpoint%s         %s%s%s\n" \
    "$C_DIM" "$C_RESET" "$C_BOLD" "$ENDPOINT" "$C_RESET"
  printf "  %slogs%s             %s%s%s\n" \
    "$C_DIM" "$C_RESET" "$C_BOLD" "$STDERR_LOG" "$C_RESET"
  printf "  %suninstall%s        %sbash %s%s\n" \
    "$C_DIM" "$C_RESET" "$C_BOLD" "$(printf '%q' "$SCRIPT_DIR/uninstall.sh")" "$C_RESET"
  printf "\n  %sYour usage will appear on the leaderboard within a minute.%s\n\n" \
    "$C_GREEN" "$C_RESET"
}

# --- parse args -----------------------------------------------------------
ARG_NAME=""
ARG_ENDPOINT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --name=*)      ARG_NAME="${1#--name=}" ;;
    --name)        ARG_NAME="${2:-}"; shift ;;
    --endpoint=*)  ARG_ENDPOINT="${1#--endpoint=}" ;;
    --endpoint)    ARG_ENDPOINT="${2:-}"; shift ;;
    -h|--help)
      printf "tokenleader local installer (build from this repo + register LaunchAgent)\n\n"
      printf "Usage: bash scripts/install.sh [--name=HANDLE] [--endpoint=URL]\n\n"
      printf "Options:\n"
      printf "  --name=HANDLE     leaderboard handle (default: slugified \$USER)\n"
      printf "  --endpoint=URL    server URL (default: %s)\n" "$DEFAULT_ENDPOINT"
      printf "\nEnv overrides: TOKENLEADER_USER, TOKENLEADER_ENDPOINT\n"
      exit 0
      ;;
    *) printf "Unknown argument: %s\nRun with --help for usage.\n" "$1" >&2; exit 1 ;;
  esac
  shift
done
if [ -n "$ARG_ENDPOINT" ]; then ENDPOINT="$ARG_ENDPOINT"; fi

# --- main -----------------------------------------------------------------
resolve_handle
print_banner
ensure_dirs
prompt_endpoint
do_build
do_codesign
write_plist_and_register
wait_for_first_tick
print_summary
