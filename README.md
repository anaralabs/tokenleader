# tokenleader

**Self-hosted token-usage leaderboard for AI coding tools — Claude Code, Codex CLI, and Cursor.**

A tiny daemon on each teammate's machine reports token counts to a server your team runs.
The dashboard shows who's burning the most tokens, what it costs, and which models everyone uses.

[![Release](https://img.shields.io/github/v/release/anaralabs/tokenleader)](https://github.com/anaralabs/tokenleader/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/anaralabs/tokenleader/actions/workflows/ci.yml/badge.svg)](https://github.com/anaralabs/tokenleader/actions)

<!-- SCREENSHOT PLACEHOLDER — uncomment once docs/assets/dashboard-dark.png exists.

![tokenleader dashboard](docs/assets/dashboard-dark.png)

     Capture dashboard-dark.png + dashboard-light.png at a 1280px viewport, 2x retina,
     from a database seeded with FICTIONAL users (alice/bob/carol, ~3 months of plausible
     fake history). NEVER screenshot a production instance. Capture only after the
     frontend polish items land (fluid width, range-switch race, first-run empty state).
     Optionally record docs/assets/demo.gif (<5 MB, ~10 s): month-pill switch →
     leaderboard reorder → grid hover. Link the GIF below the static screenshot. -->

## Privacy first

tokenleader ships **token counts, model names, and timestamps — never message content.**

- The daemon reads only the local session logs of your coding tools
  (`~/.claude/projects/`, `~/.codex/sessions/`). No keylogger, no clipboard, no network
  sniffing.
- Each report also carries opaque session/message IDs — used purely for de-duplication,
  so re-posting an event can never double-count.
- Want certainty? The daemon source is in this repo. Read it and build it yourself
  ([docs/daemon.md](docs/daemon.md#building-and-running-your-own-daemon)), or watch a
  single tick's traffic with `TOKENLEADER_LOG_LEVEL=debug TOKENLEADER_RUN_ONCE=1`.

## How it works

```
 teammate laptops                          your server (Railway / Docker / Fly / any box)
┌───────────────────────────┐             ┌─────────────────────────────────────────────┐
│ tokenleader daemon        │             │ tokenleader server                          │
│                           │   HTTPS     │  Bun + Hono + bun:sqlite (one file, WAL)    │
│ parses local session logs │ ──────────► │                                             │
│  ~/.claude/projects       │  POST       │  /            dashboard                     │
│  ~/.codex/sessions        │  /ingest    │  /ingest      token counts in               │
│                           │             │  /install     daemon installer out          │
│ posts only token counts   │ ◄────────── │  /manifest.json + /bin/*   daemon updates   │
│ + metadata, never content │  GET        │  /api/v1/usage             totals for bots  │
│                           │  hourly     │                                             │
└───────────────────────────┘             └───────────────┬─────────────────────────────┘
                                                          │ mirrors releases every 15 min
                                                          │ (GitHub API, read-only)
                                                          ▼
                                            GitHub Releases (this repo or your fork)
                                            daemon binaries + manifest.json
```

Daemons only ever talk to **your** server. The server mirrors daemon binaries from this
repo's releases, so your teammates' machines never call GitHub.

## Quick start

### 1. Deploy the server

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/T3RB43?referralCode=aRX70I&utm_medium=integration&utm_source=template&utm_campaign=generic)

One click, ~$5/mo, volume included. The template generates a **private dashboard token**
for you — when the dashboard asks for it, find it under your Railway service's
**Variables** as `TOKENLEADER_DASHBOARD_TOKEN`. Or run it anywhere Docker runs:

```yaml
# docker-compose.yml
services:
  tokenleader:
    image: ghcr.io/anaralabs/tokenleader:latest
    restart: unless-stopped
    ports:
      - "8787:8787"
    volumes:
      - tokenleader-data:/data
    environment:
      TOKENLEADER_TEAM_NAME: acme   # shows up in the dashboard header
      # The binary mirror powers daemon installs + auto-updates. Any GitHub
      # token with public read access works (unauthenticated mirroring is a
      # planned follow-up):
      TOKENLEADER_GH_REPO: anaralabs/tokenleader
      TOKENLEADER_GH_TOKEN: ${TOKENLEADER_GH_TOKEN}
      # Recommended once you have a public URL (hardens the rendered /install command):
      # TOKENLEADER_SERVER_URL: https://leaderboard.example.com

volumes:
  tokenleader-data:
```

```bash
docker compose up -d
```

Also supported: Fly.io (~$2–3/mo), a Mac on your desk inside a tailnet, Coolify, or any
VPS. Full guide with backups and HTTPS notes: [docs/self-hosting.md](docs/self-hosting.md).
(Vercel is **not** supported — tokenleader needs a long-running process and a SQLite file
on disk.)

### 2. Teammates install the daemon

Each teammate runs one command on their Mac (pick your own leaderboard name):

```bash
curl -fsSL https://leaderboard.example.com/install | bash -s -- --name=alice
```

If your server sets `TOKENLEADER_JOIN_TOKEN`, new names also pass the join code (the
dashboard renders the full command for you):

```bash
curl -fsSL https://leaderboard.example.com/install | bash -s -- --name=alice --join=<code>
```

That's it. The installer registers a LaunchAgent, posts every 5 minutes, and the daemon
auto-updates itself from your server. The dashboard fills up within minutes.

Got two Macs? Run `tokenleader link` on the first to mint a one-time pairing code, then
install on the second with `--link=<code>` — both machines count under one name, and
nobody can claim a handle they don't hold a secret (or a live code) for. Details:
[docs/daemon.md](docs/daemon.md#one-handle-multiple-machines).

> The daemon is macOS-only today (Apple Silicon + Intel). Linux + WSL support is the
> headline item of the next release — the update manifest already carries the OS
> dimension, so it lands without breaking anything.

### Uninstall

```bash
curl -fsSL https://leaderboard.example.com/uninstall | bash
```

## Supported sources

| Source      | How                                                        | Default |
|-------------|------------------------------------------------------------|---------|
| Claude Code | daemon parses `~/.claude/projects/` locally                | on      |
| Codex CLI   | daemon parses `~/.codex/sessions/` locally                 | on      |
| Cursor      | server-side mirror via Cursor Teams Admin API (no daemon)  | off — needs an admin key, see [docs/configuration.md](docs/configuration.md#cursor-mirror) |

## API

`GET /api/v1/usage` — stable per-user totals for any date range. Half-open ranges
`[since, until)`, unix-ms UTC, optional bearer auth.

```bash
curl 'https://leaderboard.example.com/api/v1/usage?period=2026-05'
```

```json
{
  "users": [
    { "user": "alice", "inputTokens": 1234567890, "outputTokens": 12345678, "totalTokens": 1246913568, "costUsd": 1234.56 },
    { "user": "bob",   "inputTokens": 987654321,  "outputTokens": 8765432,  "totalTokens": 996419753,  "costUsd": 876.54 }
  ],
  "totals": { "inputTokens": 2222222211, "outputTokens": 21111110, "totalTokens": 2243333321, "costUsd": 2111.10 }
}
```

Full reference (range forms, errors, field semantics): [docs/api.md](docs/api.md).

## Configuration

The server boots with **zero required env vars**. The ones you'll actually touch:

| Var                           | Default            | What it does                                  |
|-------------------------------|--------------------|-----------------------------------------------|
| `TOKENLEADER_TEAM_NAME`       | (unset)            | name shown in the dashboard header + installer banner |
| `TOKENLEADER_DATA_DIR`        | platform data dir (`/data` in Docker) | where the SQLite DB + binary cache live |
| `TOKENLEADER_DASHBOARD_TOKEN` | unset = public     | set to require a token to view the dashboard  |
| `TOKENLEADER_API_TOKEN`       | unset = inherits the dashboard token | bearer token for `/api/v1/*` |
| `TOKENLEADER_ADMIN_TOKEN`     | unset = admin routes disabled | gates destructive admin routes (`POST /admin/clear`) |
| `TOKENLEADER_JOIN_TOKEN`      | unset = open TOFU  | join code required to claim NEW leaderboard names |
| `TOKENLEADER_GH_REPO` + `TOKENLEADER_GH_TOKEN` | unset = mirror off | which GitHub repo to mirror daemon binaries from |
| `TOKENLEADER_CURSOR_TOKEN`    | unset = off        | Cursor Teams admin key — enables the mirror   |

Every variable (server, daemon, installer): [docs/configuration.md](docs/configuration.md)
and [.env.example](.env.example).

## Contributing & security

PRs welcome — `bun test` and `bunx tsc --noEmit` must pass, and `/api/v1` +
released manifest fields are additive-only (fielded daemons parse them).
Security reports via GitHub's private vulnerability reporting, please.

## License

[MIT](LICENSE)
