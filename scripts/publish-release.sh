#!/usr/bin/env bash
# Build daemon binaries locally + render install/uninstall scripts + publish
# them as a GitHub Release on anaralabs/tokenleader. Same outcome as
# .github/workflows/release-binaries.yml, but driven from your local Mac
# using your own `gh` auth. Useful for:
#
#   * Bootstrapping the first `latest` release before CI ever runs.
#   * Ad-hoc emergency publish if Actions is down.
#   * Testing changes to install-script.ts without round-tripping through CI.
#
# Like the workflow, this creates BOTH releases on every run:
#   1. build-<utc-stamp>-<short-sha>  immutable, one per invocation.
#   2. latest                         mutable rolling pointer; clobbered.
#
# Prereqs:
#   * gh CLI installed + authed (`gh auth status`) with write access to this repo.
#   * bun installed (used to cross-compile all four daemon binaries: darwin
#     arm64/x64 and linux x64/arm64 — the manifest covers all four).
#   * TOKENLEADER_SERVER_URL env var set, or override via --server-url=.
#
# Usage:
#   ./scripts/publish-release.sh
#   TOKENLEADER_SERVER_URL=https://leaderboard.example.com ./scripts/publish-release.sh
#   ./scripts/publish-release.sh --server-url=https://leaderboard.example.com
#   ./scripts/publish-release.sh --skip-build      # reuse existing bin/ outputs
#   ./scripts/publish-release.sh --latest-only     # don't create a build-<sha> tag
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_DIR"

REPO_SLUG="anaralabs/tokenleader"

# --- color helpers --------------------------------------------------------
if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
  C_GREEN=$'\033[0;32m'; C_RED=$'\033[0;31m'; C_YELLOW=$'\033[0;33m'
else
  C_RESET=""; C_BOLD=""; C_DIM=""; C_GREEN=""; C_RED=""; C_YELLOW=""
fi
info() { printf "  %s→%s %s\n" "$C_DIM" "$C_RESET" "$*"; }
ok()   { printf "  %s✓%s %s\n" "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf "  %s!%s %s\n" "$C_YELLOW" "$C_RESET" "$*" >&2; }
err()  { printf "  %s✗%s %s\n" "$C_RED" "$C_RESET" "$*" >&2; }

# --- arg parsing ----------------------------------------------------------
SKIP_BUILD=""
LATEST_ONLY=""
ARG_SERVER_URL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --skip-build)        SKIP_BUILD=1 ;;
    --latest-only)       LATEST_ONLY=1 ;;
    --server-url=*)      ARG_SERVER_URL="${1#--server-url=}" ;;
    --server-url)        ARG_SERVER_URL="${2:-}"; shift ;;
    -h|--help)
      sed -n '1,40p' "$0" | sed -n 's/^# \{0,1\}//p'
      exit 0
      ;;
    *) err "Unknown argument: $1"; exit 1 ;;
  esac
  shift
done

SERVER_URL="${ARG_SERVER_URL:-${TOKENLEADER_SERVER_URL:-}}"
if [ -z "$SERVER_URL" ]; then
  err "TOKENLEADER_SERVER_URL not set. Pass --server-url=... or export it."
  err "  e.g. TOKENLEADER_SERVER_URL=https://leaderboard.example.com"
  exit 1
fi

# --- preflight ------------------------------------------------------------
if ! command -v gh >/dev/null 2>&1; then
  err "gh CLI not on PATH. brew install gh && gh auth login"; exit 1
fi
if ! gh auth status >/dev/null 2>&1; then
  err "gh not authenticated. Run: gh auth login"; exit 1
fi
if ! command -v bun >/dev/null 2>&1; then
  err "bun not on PATH. Install from https://bun.sh"; exit 1
fi

# Verify gh is pointed at a host where we have write access on REPO_SLUG.
if ! gh repo view "$REPO_SLUG" --json viewerPermission -q .viewerPermission \
    >/tmp/.tl-perm 2>/dev/null; then
  err "gh can't see $REPO_SLUG. Check your auth."; exit 1
fi
PERM="$(cat /tmp/.tl-perm)"
rm -f /tmp/.tl-perm
case "$PERM" in
  ADMIN|MAINTAIN|WRITE) ;;
  *) err "Your gh login only has '$PERM' on $REPO_SLUG — need WRITE+."; exit 1 ;;
esac

# --- build ----------------------------------------------------------------
# SHORT_SHA is both the embedded daemon version (via build-daemon.sh's VERSION
# override) and the manifest `version` — the server string-compares the two.
SHORT_SHA="$(git rev-parse --short HEAD)"
if [ -z "$SKIP_BUILD" ]; then
  info "Installing dependencies..."
  bun install --frozen-lockfile >/dev/null 2>&1 || bun install >/dev/null
  info "Building cross-arch daemons (darwin + linux, version=${SHORT_SHA})..."
  VERSION="${SHORT_SHA}" bun run build:daemon-arm64 >/dev/null
  VERSION="${SHORT_SHA}" bun run build:daemon-x64 >/dev/null
  # Linux is NOT optional here: make-manifest.ts hashes all four published
  # platforms and throws on a missing one, so a darwin-only build dies at the
  # manifest step — mid-incident, after the slow part already ran. bun
  # cross-compiles these from the Mac; they are never codesigned (ELF).
  VERSION="${SHORT_SHA}" bun run build:daemon-linux-x64 >/dev/null
  VERSION="${SHORT_SHA}" bun run build:daemon-linux-arm64 >/dev/null
  ok "Built bin/anara-leaderboard-{arm64,x64} + bin/tokenleader-linux-{x64,arm64}"
else
  info "Skipping build (--skip-build); reusing bin/anara-leaderboard-* + bin/tokenleader-linux-*"
  warn "Reused binaries must have been built with VERSION=${SHORT_SHA} or the fleet will read as stale."
fi

for f in bin/anara-leaderboard-arm64 bin/anara-leaderboard-x64 \
         bin/tokenleader-linux-x64 bin/tokenleader-linux-arm64; do
  if [ ! -s "$f" ]; then
    err "$f missing or empty. Drop --skip-build or run \`bun run build:all\`."
    exit 1
  fi
done

# --- render install.sh + uninstall.sh ------------------------------------
info "Rendering install.sh + uninstall.sh with SERVER_URL=$SERVER_URL"
bun -e "import('./src/server/install-script.ts').then(m => process.stdout.write(m.renderInstallScript('$SERVER_URL')))" > bin/install.sh
bun -e "import('./src/server/install-script.ts').then(m => process.stdout.write(m.renderUninstallScript('$SERVER_URL')))" > bin/uninstall.sh
chmod +x bin/install.sh bin/uninstall.sh
bash -n bin/install.sh
bash -n bin/uninstall.sh
ok "Rendered install.sh + uninstall.sh (bash -n clean)"

# --- manifest.json --------------------------------------------------------
# Dual-shape manifest via the shared generator (scripts/make-manifest.ts —
# same code release.yml uses). It deliberately emits NO `url` fields —
# daemons fetch from their server's /bin/<arch> route, not directly from
# GitHub, so a stale or hostile manifest can't redirect them elsewhere.
# Version stays the bare short SHA on this emergency path (same string the
# binaries above were built with); tag-driven releases use the tag instead.
info "Computing manifest.json (dual shape via scripts/make-manifest.ts)"
bun scripts/make-manifest.ts --version "${SHORT_SHA}" --bin-dir bin \
  --out bin/manifest.json --build-sha "${SHORT_SHA}" >/dev/null
cat bin/manifest.json
ok "Wrote bin/manifest.json"

# --- publish --------------------------------------------------------------
# The mirror looks these names up verbatim (GH_ASSET_NAME in
# src/server/binary-mirror.ts): darwin keeps the legacy fleet names, linux
# ships under its canonical name.
ASSETS=(
  bin/install.sh
  bin/uninstall.sh
  bin/anara-leaderboard-arm64
  bin/anara-leaderboard-x64
  bin/tokenleader-linux-x64
  bin/tokenleader-linux-arm64
  bin/manifest.json
)

CURRENT_SHA="$(git rev-parse HEAD)"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
BUILD_TAG="build-${STAMP}-${SHORT_SHA}"

if [ -z "$LATEST_ONLY" ]; then
  info "Creating immutable build release ${BUILD_TAG}..."
  if gh release view "$BUILD_TAG" --repo "$REPO_SLUG" >/dev/null 2>&1; then
    warn "Release ${BUILD_TAG} already exists — clobbering its assets."
    gh release upload "$BUILD_TAG" --repo "$REPO_SLUG" --clobber "${ASSETS[@]}"
  else
    # --latest=false so GH's "Latest" badge stays on the `latest` tag below,
    # not on whichever build-<sha> is newest by date.
    gh release create "$BUILD_TAG" \
      --repo "$REPO_SLUG" \
      --title "Build ${SHORT_SHA} (${STAMP} UTC, local)" \
      --target "$CURRENT_SHA" \
      --latest=false \
      --notes "Locally published from ${CURRENT_SHA} via scripts/publish-release.sh." \
      "${ASSETS[@]}"
  fi
  ok "Published ${BUILD_TAG}"
else
  info "Skipping immutable build release (--latest-only)"
fi

info "Upserting rolling 'latest' release..."
if gh release view latest --repo "$REPO_SLUG" >/dev/null 2>&1; then
  gh release edit latest --repo "$REPO_SLUG" \
    --target "$CURRENT_SHA" \
    --latest \
    --notes "Tracks ${BUILD_TAG} — locally published from ${CURRENT_SHA}."
  gh release upload latest --repo "$REPO_SLUG" --clobber "${ASSETS[@]}"
  ok "Updated existing 'latest' release"
else
  gh release create latest \
    --repo "$REPO_SLUG" \
    --title "Latest" \
    --target "$CURRENT_SHA" \
    --latest \
    --notes "Tracks ${BUILD_TAG} — locally published from ${CURRENT_SHA}." \
    "${ASSETS[@]}"
  ok "Created 'latest' release"
fi

printf "\n  %sDone.%s Teammates can install with:\n\n" "$C_GREEN" "$C_RESET"
printf "    %sgh release download latest -R %s -p install.sh -O - | bash -s -- --name=YOU%s\n\n" \
  "$C_BOLD" "$REPO_SLUG" "$C_RESET"
