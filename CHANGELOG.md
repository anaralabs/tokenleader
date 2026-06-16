# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Machine-facing release artifacts (daemon binaries + `manifest.json`) are published on
every tagged release; daemons identify builds by exact version string, not by parsing
semver.

## [Unreleased]

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
- Claude Cowork support: the daemon also parses Claude Desktop "local agent
  mode" sessions (byte-identical JSONL under the Desktop data dir), tagged
  `claude_cowork` so they report separately from CLI usage. On by default;
  `TOKENLEADER_CLAUDE_COWORK=0` disables. Cloud/remote Cowork runs server-side
  and leaves nothing on disk, so it is out of scope.
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

[Unreleased]: https://github.com/anaralabs/tokenleader/commits/main
