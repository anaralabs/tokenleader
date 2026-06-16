# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Machine-facing release artifacts (daemon binaries + `manifest.json`) are published on
every tagged release; daemons identify builds by exact version string, not by parsing
semver.

## [Unreleased]

### Added
- Claude Cowork support: the daemon also parses Claude Desktop "local agent
  mode" sessions (byte-identical JSONL under the Desktop data dir), tagged
  `claude_cowork` so they report separately from CLI usage. On by default;
  `TOKENLEADER_CLAUDE_COWORK=0` disables. Cloud/remote Cowork runs server-side
  and leaves nothing on disk, so it is out of scope.

## [0.3.0] - 2026-06-17

Cursor cloud sync, contributed by @octavi42 (#2).

### Added
- Cursor cloud sync via the official dashboard API as the `cursor` source —
  accurate model names, token counts, and per-event cost. `tokenleader
  login-cursor --auto` (macOS) reads the signed-in Cursor IDE session and stores
  credentials for refresh; manual `tokenleader login-cursor <token>` or
  `login-cursor -` (token from stdin) works on any platform. Once a token is
  saved the daemon backfills the full dashboard history in bounded chunks across
  ticks (never blocking a tick), then settles into a cheap incremental window;
  `tokenleader sync-cursor` runs the full backfill in the foreground.
- Local Cursor fallback (`cursor_local`, parsed from `state.vscdb`) when cloud
  sync is unavailable; the server reconciles cloud and local rows so the same
  usage is never double-counted.

### Notes
- Server and daemon ship together: the server accepts `source: "cursor"` only
  from this release onward.

## [0.2.2] - 2026-06-13

### Fixed
- First external contribution (PR #1, @wing-anara): bounded, newline-aligned
  windowed reads (`src/parser/read-slice.ts`, 64 MiB cap) replace a
  full-remainder read that tripped the JS string-length ceiling as a native
  abort and crash-looped the daemon on multi-GB session files. Oversized records
  (> 64 MiB) are dropped and reported (`oversize_record_skipped`); an off-by-one
  so a record exactly `maxBytes` long isn't dropped is fixed.

## [0.2.1] - 2026-06-13

### Fixed
- Bare `tokenleader` (no subcommand) prints CLI usage instead of the daemon's
  `config_error`. The single binary is both the launchd daemon and the CLI,
  disambiguated by the presence of `TOKENLEADER_USER` (set by launchd).

## [0.2.0] - 2026-06-13

### Added
- Multi-device: one handle, many machines (`user_devices`; `/ingest`
  authenticates against any active device). Link codes (`tokenleader link` /
  install `--link=CODE`), device management (`tokenleader devices|revoke`,
  `GET /devices`, `POST /devices/revoke`), and a per-device fleet view.
- `TOKENLEADER_COMPANY_ALIASES`: operator rewrites for self-reported company
  headers at ingest.

### Security
- Server-side handle charset validation (`/^[a-z0-9._-]{1,64}$/`); durable
  revocation (a revoked secret is barred from auto-reclaim); rollback-drift
  reconciliation on auth-success and at boot.

### Fixed
- Guarded `tokenleader` -> `anara-leaderboard` symlink dropped by the installer
  and self-healed by the daemon on boot, so the CLI name resolves without a
  reinstall; removed by the uninstaller.

## [0.1.0] - 2026-06-12

First public release of tokenleader: a self-hosted token-usage leaderboard for
Claude Code, Codex CLI, and Cursor. Token counts, model names, and timestamps —
never message content.

### Added
- Server: Bun + Hono + bun:sqlite (single file, WAL). Typed env configuration
  with **zero required variables** (`src/server/config.ts` owns the full
  contract, mirrored in `.env.example` and enforced by a parity test).
- macOS daemon (Apple Silicon + Intel) that parses local Claude Code / Codex CLI
  session logs and posts token counts with sha256-verified, atomically-swapped
  auto-update (cryptographic release signing lands in a future release).
- One-command daemon install served by each team's own server (`/install`),
  matching self-serve `/uninstall`.
- Dashboard: React SPA (Vite + TanStack Router/Query) served by the same
  container; optional viewer token (`TOKENLEADER_DASHBOARD_TOKEN`) with a
  cookie-based `/login` flow.
- Stable external API: `GET /api/v1/usage` with uniform **half-open UTC
  ranges** `[since, until)` (unix-ms or strict ISO-8601 input), optional bearer
  auth.
- Per-user TOFU ingest identity, plus an optional join code
  (`TOKENLEADER_JOIN_TOKEN`) gating first claims of new leaderboard names.
- Optional Cursor mirror: server-side usage import via the Cursor Teams Admin
  API (off by default; requires an explicit email→handle map).
- GitHub-release binary mirror: the server caches daemon binaries and
  `manifest.json` locally so teammate machines never call GitHub.
- Deploy targets: Dockerfile + docker-compose (ghcr.io image), Railway
  template config, fly.toml; Litestream backup profile.
- Tag-driven release pipeline: one `vX.Y.Z` tag builds the daemons, emits the
  dual-shape manifest (v2 `platforms` map + frozen v1 keys), publishes release
  assets, and pushes the multi-arch server image.
- Docs set: self-hosting, configuration reference, daemon guide, API
  reference, update/rollback runbook.

[Unreleased]: https://github.com/anaralabs/tokenleader/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/anaralabs/tokenleader/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/anaralabs/tokenleader/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/anaralabs/tokenleader/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/anaralabs/tokenleader/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/anaralabs/tokenleader/releases/tag/v0.1.0
