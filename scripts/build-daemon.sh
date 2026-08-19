#!/usr/bin/env bash
#
# Compile the daemon with its build version baked in.
#
# Usage: build-daemon.sh <bun-target|''> <outfile>
#   build-daemon.sh ''                 bin/anara-leaderboard          # native
#   build-daemon.sh bun-darwin-arm64   bin/anara-leaderboard-arm64
#   build-daemon.sh bun-darwin-x64     bin/anara-leaderboard-x64
#   build-daemon.sh bun-linux-arm64            bin/tokenleader-linux-arm64
#   build-daemon.sh bun-linux-x64-baseline     bin/tokenleader-linux-x64
#
# Linux x64 is built from bun's BASELINE target on purpose: the non-baseline
# runtime uses AVX2, and cheap/virtualised VPS hosts (Proxmox/QEMU default
# `kvm64`/`qemu64` CPU models mask AVX2 even on new silicon) then SIGILL with
# no diagnostic — a crash loop under systemd Restart=always. Shipping one
# x64 artifact keeps the install-time choice and the forever-after
# auto-update choice from ever drifting apart.
#
# Two values are injected via `bun build --define`. Bun 1.1.38 only honors
# the SPACE form (`--define K=V`); the esbuild colon form (`--define:K=V`)
# silently no-ops, so don't "simplify" this. Verified by running compiled
# arm64 + x64 binaries.
#
#   __TOKENLEADER_BUILD_SHA__      bare git short SHA, matching manifest.json
#                                  `buildSha`. Diagnostics only — logged,
#                                  never compared.
#   __TOKENLEADER_BUILD_VERSION__  semver tag when HEAD sits exactly on one;
#                                  else "v0.0.0-dev+<sha>". Override with
#                                  VERSION=... . The server compares this
#                                  string exactly to the manifest `version`,
#                                  so a divergence would false-flag the whole
#                                  fleet as stale.
#
# package.json's build:daemon* scripts call this, so CI and
# scripts/publish-release.sh both inject the values with no extra wiring.
set -euo pipefail

TARGET="${1:-}"
OUT="${2:?usage: build-daemon.sh <bun-target|''> <outfile>}"

SHA="$(git rev-parse --short HEAD 2>/dev/null || echo dev)"

VERSION="${VERSION:-}"
if [ -z "${VERSION}" ]; then
  VERSION="$(git describe --tags --exact-match 2>/dev/null || true)"
fi
if [ -z "${VERSION}" ]; then
  VERSION="v0.0.0-dev+${SHA}"
fi

ARGS=(build src/daemon/main.ts --compile \
  --define "__TOKENLEADER_BUILD_SHA__=\"${SHA}\"" \
  --define "__TOKENLEADER_BUILD_VERSION__=\"${VERSION}\"" \
  --outfile "${OUT}")
if [ -n "${TARGET}" ]; then
  ARGS+=(--target="${TARGET}")
fi

echo "build-daemon: ${OUT} (version=${VERSION}, sha=${SHA}${TARGET:+, target=${TARGET}})" >&2
bun "${ARGS[@]}"

# Stamp OUR identity onto the compiled binary. `bun build --compile` output
# inherits a code signature from the bun runtime it bundles: a cross-target
# build (--target) embeds bun's OFFICIAL release runtime, which is Developer-ID
# signed by "Jarred Sumner" (Bun's author). macOS Background Task Management
# attributes a LaunchAgent to its executable's signing identity, so teammates
# saw "Software from 'Jarred Sumner' can run in the background". Re-sign ad-hoc
# under our own identifier so the daemon is attributed to itself.
#
# Requires bun >= 1.3: bun 1.1.x `--compile` output failed codesign strict
# validation and couldn't be re-signed (or even stripped) — that's why the
# release workflows build on 1.3.x. set -e aborts the build if re-signing
# fails, so a stale bun can never silently ship the Jarred Sumner identity.
# Gated on the TARGET, not the build host: codesign is meaningless against an
# ELF (it lands in xattrs, leaves the file bytes untouched, and every
# follow-up assertion passes vacuously), and `codesign` does not exist at all
# on the ubuntu runners that build the linux artifacts — under `set -e` that
# would hard-fail the linux build. Empty target = the native mac build.
case "${TARGET}" in
  ''|bun-darwin-*) NEEDS_CODESIGN=1 ;;
  *)               NEEDS_CODESIGN=0 ;;
esac
if [ "${NEEDS_CODESIGN}" = "1" ] && [ "$(uname -s)" = "Darwin" ]; then
  IDENTIFIER="${CODESIGN_IDENTIFIER:-tokenleader}"
  codesign --force --sign - --identifier "${IDENTIFIER}" "${OUT}" >&2
  if codesign -dvvv "${OUT}" 2>&1 | grep -q "Authority=Developer ID"; then
    echo "build-daemon: ${OUT} still carries a Developer ID after re-sign; refusing to ship" >&2
    exit 1
  fi
  codesign --verify --strict "${OUT}"
  echo "build-daemon: re-signed ${OUT} ad-hoc as '${IDENTIFIER}'" >&2
fi
