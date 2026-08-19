#!/usr/bin/env bash
# Local tag helper for the tag-driven release pipeline.
#
#   scripts/release.sh <X.Y.Z>
#
# What it does:
#   1. asserts the working tree is clean (tracked AND untracked),
#   2. runs the full local gate (bun test + tsc --noEmit),
#   3. creates the annotated tag vX.Y.Z on HEAD,
#   4. prints the push command — and deliberately does NOT run it.
#
# Pushing the tag is the publication act: .github/workflows/release.yml
# builds the daemons, the manifest, the GitHub release, and the ghcr image
# from the tag. Keeping the push manual gives you one last look.
#
# EVERY release is four-platform. The manifest job needs BOTH the macOS and
# the Linux build jobs, so a wedged Linux runner blocks a macOS-only hotfix
# too — that coupling is deliberate (a darwin-only manifest de-lists Linux
# and freezes every Linux daemon's update channel; see the header of
# .github/workflows/release.yml). If Actions is down or the Linux legs are
# stuck and 23 Macs need a fix now, the break-glass lever is
# scripts/publish-release.sh: it cross-compiles all four binaries locally and
# publishes the same four-platform manifest.
#
# Versioning: TAGS ARE THE VERSION. package.json stays 0.1.0
# forever — this script bumps nothing and asserts nothing about it.
# Stable X.Y.Z only; rc tags are cut by hand when needed:
#   git tag -a v0.2.0-rc.1 -m "tokenleader v0.2.0-rc.1" && git push origin v0.2.0-rc.1
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_DIR"

if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'
  C_GREEN=$'\033[0;32m'; C_RED=$'\033[0;31m'
else
  C_RESET=""; C_BOLD=""; C_GREEN=""; C_RED=""
fi
ok()  { printf "  %s✓%s %s\n" "$C_GREEN" "$C_RESET" "$*"; }
err() { printf "  %s✗%s %s\n" "$C_RED" "$C_RESET" "$*" >&2; }

VER="${1:-}"
if [ -z "$VER" ]; then
  err "usage: scripts/release.sh <X.Y.Z>   (no leading v; the tag becomes v<X.Y.Z>)"
  exit 1
fi
case "$VER" in
  v*) err "pass the bare version (X.Y.Z) — the v prefix is added here"; exit 1 ;;
esac
if ! [[ "$VER" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  err "'$VER' is not a stable X.Y.Z version. This helper cuts stable tags only;"
  err "cut rc/prerelease tags by hand (see the header comment)."
  exit 1
fi
TAG="v${VER}"

# --- preflight --------------------------------------------------------------
if [ -n "$(git status --porcelain)" ]; then
  err "working tree not clean — commit or stash everything first:"
  git status --short >&2
  exit 1
fi
ok "working tree clean"

if git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null; then
  err "tag ${TAG} already exists ($(git rev-parse --short "refs/tags/${TAG}"))"
  exit 1
fi
ok "tag ${TAG} is free"

# --- gate -------------------------------------------------------------------
echo "Running the local gate (bun test + tsc)..."
bun test
bunx tsc --noEmit
ok "tests + typecheck green"

# --- tag --------------------------------------------------------------------
git tag -a "${TAG}" -m "tokenleader ${TAG}"
ok "created annotated tag ${TAG} on $(git rev-parse --short HEAD)"

printf "\n  %sNot pushed.%s Review, then publish with:\n\n" "$C_BOLD" "$C_RESET"
printf "    %sgit push origin %s%s\n\n" "$C_BOLD" "$TAG" "$C_RESET"
printf "  (the tag push triggers .github/workflows/release.yml — darwin AND\n"
printf "   linux daemons, manifest, GitHub release, and the ghcr server image.\n"
printf "   The manifest job needs both build jobs: a wedged linux runner blocks\n"
printf "   the whole tag. Emergency bypass: scripts/publish-release.sh)\n"
