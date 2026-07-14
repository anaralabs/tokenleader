# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Machine-facing release artifacts (daemon binaries + `manifest.json`) are published on
every tagged release; daemons identify builds by exact version string, not by parsing
semver.

## [0.6.2] - 2026-07-14

The second half of the Codex accounting audit. Codex CLI (≥0.32; subagent
spawns since 0.107, default-on since 0.123) seeds every forked/subagent
rollout with a verbatim copy of the parent's history — token_count lines
included, re-stamped to the spawn instant. Each spawn therefore re-billed
the parent's entire accumulated ledger under a fresh sessionId that dedup
cannot catch. Measured fleet-wide on the gpt-5.6 era: **86% of stored Codex
volume was such phantom copies** (95% for the heaviest collab users). This
inflation dominated the v0.6.1 under-count — net, the leaderboard
OVER-stated Codex usage.

### Fixed
- **Codex parser: fork-seed suppression.** In rollouts whose session_meta
  carries `forked_from_id`, the seeded history burst (consecutive lines
  milliseconds apart at file birth; a real turn trails by a model
  round-trip) is skipped for billing while cumulative bookkeeping continues.
  Validated against every local fork by prefix-matching the actual parent
  ledger: 47/47 sessions exact, 34 forks, boundary identical in all cases.
  Confirmed against openai/codex source: no per-line replay marker exists;
  the seed is one synchronous write at session construction.

Historical rows (both bugs) remain as ingested; a full Codex backfill
(server-side wipe + fleet re-scan from byte 0) is the path to true history.

## [0.6.1] - 2026-07-14

Codex usage was systematically UNDER-counted (~46% of input and cache-read
tokens, ~24% of output, measured over 47 real gpt-5.6 sessions): the parser
treated `last_token_usage` as session-cumulative when it is per-turn, so
whenever no bucket happened to regress turn-over-turn, only the difference
between two per-turn values survived. Surfaced by the gpt-5.6 launch (thanks
@andrew for the report) but affects all Codex data since at least June.

### Fixed
- **Codex parser: `last_token_usage` is per-turn, not cumulative.** It is now
  emitted directly as that event's usage; cumulative-delta tracking (with
  reset-to-baseline detection) remains as the fallback for total-only formats.
  Validated against 47 real rollouts: parser output now reconciles with the
  files' own `total_token_usage` ledger to the token (was -46% input/cache).
  Historical rows ingested by older daemons remain under-counted; a backfill
  is a separate decision.

### Changed
- **Pricing fallback refreshed** to the current LiteLLM sheet so the gpt-5.6
  family (`-sol`, `-terra`, `-luna`) and other 2026 models price correctly on
  a cold boot before the first upstream refresh.

## [0.6.0] - 2026-07-06

The "Never Silent" release. Root cause: a production daemon spent two days
alive-but-wedged after macOS DarkWake churn killed the Bun runtime's timer
subsystem — no exit for KeepAlive to respawn, no phone-home for directives to
ride. v0.6.0 makes silent death structurally impossible: liveness is now
enforced from OUTSIDE the process, on launchd's clock. Full design, thresholds,
and failure-mode coverage: `docs/resilience.md`.

### Added
- **Watchdog LaunchAgent pair.** A second label
  (`sh.anara.leaderboard.watchdog`, StartInterval 120s, never KeepAlive) runs
  the same binary as a one-shot checker: alive for seconds, structurally
  immune to the timer wedge. It stats a heartbeat file; "unchanged across 8
  consecutive firings" ≈ 16 minutes of awake time (StartInterval never fires
  during sleep — the staleness clock is launchd itself, no clock arithmetic).
  Escalation: forensics (native `sample`, launchctl snapshot, log tail —
  captured BEFORE any signal) → SIGTERM → SIGKILL → KeepAlive respawns.
  Identity-anchored: only the pid recorded in the heartbeat, and only while
  launchd reports that same pid live, is ever signaled — PID reuse and
  rolled-back daemons are unkillable by construction. A respawn-churn fuse
  (≥3 unexplained respawns / 90 min) latches a degraded state that alarms
  instead of kill-looping. The daemon self-installs the watchdog on boot; the
  plist runs a hardlink (`anara-leaderboard.watchdog`) so the watchdog
  survives daemon-binary loss and pre-watchdog rollbacks.
- **Heartbeat + exit journal.** The daemon writes `heartbeat.json` at every
  progress boundary (tick start/end, per 200 files scanned, per batch POST)
  and explains every deliberate exit in `exit-journal.jsonl` — update swaps
  and restarts are never misread as crash loops, and a boot with no journal
  entry exposes the silent-exit class in the next checkin.
- **Second phone-home channel.** Every watchdog run POSTs a ~200B
  `/watchdog-checkin` via curl and executes directives from the response
  (`restart`, `upload_logs`, `sample`, `upload_state`, `reinstall_watchdog`)
  — remote heal no longer requires the patient to be alive.
- **Unconditional status checkins.** `/checkin` now fires after every tick
  (success, quiet, or failure) with a status body: uptime, tick sequence,
  consecutive failures, last error, last update result, drift, exit-journal
  tail. Sick-but-alive daemons (403 loops, parse loops) are no longer
  server-dark exactly when it matters.
- **Directive lifecycle.** Directives are per-device and complete on an
  executed-ack, not at handout — un-acked directives re-queue, closing the
  "update swap eats the directive" hole. Fleet classification
  (healthy / late / wedged / crash-looping / degraded / dark / uninstalled),
  per-device forensics storage, failed-auth traces, and optional Slack
  alerting (`TOKENLEADER_ALERT_WEBHOOK`) land server-side.
- **In-process hardening.** Clock-drift exit (a grossly late inter-tick sleep
  is the wedge precursor → journaled exit(75), fresh process), 7-day
  jittered process recycling, first update check moved before the first tick
  (a boot-crasher gets a self-update window).

### Changed
- Updates keep `<execPath>.prev` via hardlink (created before the single
  atomic rename — there is never a moment without a complete binary) and
  write an `update_in_progress` marker that widens the watchdog's deadline
  to 45 minutes so slow-link downloads are never killed mid-transfer.
- Installer registers both labels with the same enable → bootstrap → verify
  ladder; uninstaller (including the server-rendered one) tears down both.
- CI's release guard runs with `TOKENLEADER_WATCHDOG_DISABLED=1` — the gate
  exercises the update path, never the runner's launchd.

### Fixed
- The 2026-07-06 incident class: a wedged daemon is now detected in ≤ ~18
  minutes and revived automatically, with the forensic evidence (the same
  `sample` output that diagnosed the original incident) captured and shipped
  to the server before the kill.

## [0.5.9] - 2026-07-02

The stability release: observable, remotely recoverable, and unlosable.

### Added
- **Heartbeat check-ins.** A tick with no events now POSTs `/checkin` (headers
  only), stamping the device's `last_seen`/version — an idle-but-alive daemon
  is finally distinguishable from a dead one, the observability gap behind the
  v0.5.x "stale fleet" misdiagnosis. Auth is existing devices only; identity
  claims stay exclusively on `/ingest`. Old servers 404 it harmlessly.
- **Directive channel (zero-touch remote recovery).** An operator enqueues a
  verb via `POST /admin/directives`; the user's next `/checkin` or `/ingest`
  response delivers it exactly once and the daemon executes from its own
  allowlist: `restart` (exit 75 → launchd respawns fresh) and `upload_logs`
  (POST the `daemon.jsonl` tail to `/diag/logs`, readable via
  `/admin/diag/logs`). Unknown verbs are logged and dropped.
- **Litestream replication (opt-in).** Set `LITESTREAM_REPLICA_URL` (+
  standard Litestream credential env vars) and the container restores a
  missing DB from the replica on boot and runs the server under
  `litestream replicate -exec`. Unset = no behavior change.
- **Release guard (f).** CI now executes the actual arm64 release artifact
  through a complete self-update cycle (manifest → curl download → sha verify
  → smoke test → swap → exit 75) against a local server — compiled-runtime
  landmines can no longer ship through a green unit-test suite.

### Changed
- The installer requires an explicit handle (`--name=` or `TOKENLEADER_USER`)
  and aborts with the exact command otherwise. The `$USER` fallback silently
  registered junk identities whenever the classic `VAR=… curl … | bash`
  misfire dropped the env var on `curl`; the installer's own hint used to
  teach that broken form.

## [0.5.8] - 2026-07-02

### Fixed
- **The fleet-stuck root cause.** The compiled daemon's Bun `fetch` of the
  release binary could kill the whole process with a silent, clean `exit(0)`
  — reproduced against production and against a local plain-HTTP identity
  proxy (ruling out gzip/TLS/HTTP2/the server). Under the legacy launchd
  plists that clean exit *was* the stranding event. Binary downloads now
  shell out to `curl` (same tool the installer uses), keep the gzip
  transfer, sha-verify as before, and enforce the 600s budget across the
  whole transfer (the fetch path left body streaming unbounded).

## [0.5.7] - 2026-07-01

### Changed
- **Restart from first principles.** The post-update restart no longer shells
  out to `launchctl kickstart -k` and no longer exits 0 — it exits **75**
  (EX_TEMPFAIL) and lets `KeepAlive` respawn the swapped binary. A non-zero
  exit respawns under both plist generations, closing the race that could
  strand a daemon mid-update while the old plist was still in effect.

### Added
- Pre-swap smoke test: the updater runs the downloaded binary with
  `--version` and refuses the swap unless it exits 0 — a boot-crashing
  published binary can no longer brick the fleet beyond the reach of its own
  updater.

### Fixed
- `TOKENLEADER_BATCH_SIZE` is clamped to the server's 1,000-events-per-POST
  cap; larger values drew a non-retriable 413 and wedged the daemon
  resending the same batch forever.

## [0.5.6] - 2026-07-01

### Fixed
- `cursor_local` events could carry fractional millisecond timestamps (file
  mtime / composer time), which the server's integer validation rejected —
  an all-invalid batch 400s and froze the flush. Both paths now
  `Math.round(…)`. Contributed by @wing-anara (#16).

## [0.5.5] - 2026-07-01

### Fixed
- **Daemon liveness (the fleet-stuck incident).** The LaunchAgent plist
  shipped `KeepAlive={Crashed:true, SuccessfulExit:false}`, which never
  respawns a clean exit — any `exit(0)` stranded the daemon until the next
  login. Both plist templates now use unconditional `KeepAlive: true`, and a
  boot-time self-heal (`plist-heal.ts`) rewrites a drifted stanza on
  already-installed machines so the fix arrives via a normal binary update.
- Binary-download timeout raised 120s → 600s (#15); the server serves
  `/bin` gzip-compressed (~24MB instead of ~63MB) to clients that accept it
  (#14).

### Changed
- The fleet panel reports **health** (active / idle / no daemon, by posting
  recency) instead of version compliance; being behind `latestVersion` is an
  informational "update pending" note, never a red state.

## [0.5.4] - 2026-06-19

### Fixed
- Sticky-header corner clip: `.card-scroll { overflow: clip }` clips children
  to the card's rounded corners **without** becoming a scroll container, so
  the sticky header keeps pinning to the page.

## [0.5.3] - 2026-06-19

### Fixed
- Sticky table headers actually pin now: `overflow-x: auto` made
  `.card-scroll` a scroll container, so `position: sticky` pinned inside it
  (invisibly) instead of to the page. Horizontal scroll is scoped to the
  ≤720px breakpoint where sticky is inert anyway.

## [0.5.2] - 2026-06-19

### Added
- Sticky table headers on the leaderboard, models, and fleet tables.
  Contributed by @alexapvl (#10).

## [0.5.1] - 2026-06-18

### Fixed
- The daemon is code-signed as `tokenleader` instead of inheriting Bun's own
  Developer ID — macOS background-activity notifications no longer attribute
  the LaunchAgent to "Jarred Sumner". Daemon compile pin bumped to Bun
  1.3.14 (1.1.x output could not be re-signed at all).

## [0.5.0] - 2026-06-17

### Fixed
- **Per-row tolerant `/ingest`.** One malformed event used to 400 the whole
  1000-event batch, freezing the daemon in a permanent retry loop; the
  server now inserts the valid rows and reports `skipped`. Parser fallbacks
  for empty `sessionId` (session UUID from the filename) and empty assistant
  `model` ("unknown") remove the known trigger.
- `/install` works on Macs without python3: the sed fallback now parses the
  pretty-printed manifest.
- Cursor cloud cost/token fields are clamped server-side (no negatives,
  fractions, or absurd ceilings) on both the ingest and mirror paths.

### Added
- Admin-defined **categories** (Engineering, Growth, …): CRUD + per-user
  assignment endpoints, leaderboard chips, and a `?category=` filter.

## [0.4.0] - 2026-06-17

Claude Cowork usage now counts on the leaderboard.

### Added
- Claude Cowork tracking via a new `claude_cowork` source. The daemon discovers
  Claude Desktop "local agent mode" (Cowork) session transcripts under the
  Desktop app's data dir — macOS `~/Library/Application Support/Claude/`, Linux
  `~/.config/Claude/`, Windows `%APPDATA%/Claude/`, scanning both the
  `local-agent-mode-sessions` and migrated `claude-code-sessions` layouts — and
  parses them through the **same** Claude Code parser: full input/output/cache
  token counts, per model, with the same de-duplication. The distinct
  `claude_cowork` tag keeps Cowork usage reportable separately from CLI usage,
  since its sandbox project paths would otherwise mislabel the per-project view.
  On by default; `TOKENLEADER_CLAUDE_COWORK=0` disables and
  `TOKENLEADER_CLAUDE_COWORK_DIR` overrides the Desktop data dir.

### Notes
- Server and daemon ship together: the server accepts `source: "claude_cowork"`
  only from this release onward, and the production server has already been
  updated.
- On by default means a daemon backfills historical Cowork sessions from byte 0
  on its first tick after upgrade — intended and de-dup-safe (keyed on message
  IDs), so re-reading never double-counts.
- Cloud/remote Cowork runs server-side and leaves nothing on disk, so it cannot
  be tracked locally and is out of scope; only local Cowork is captured. Privacy
  is unchanged: token counts, model names, and timestamps — never message
  content.

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
[0.4.0]: https://github.com/anaralabs/tokenleader/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/anaralabs/tokenleader/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/anaralabs/tokenleader/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/anaralabs/tokenleader/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/anaralabs/tokenleader/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/anaralabs/tokenleader/releases/tag/v0.1.0
