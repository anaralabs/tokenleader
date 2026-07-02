# Configuration reference

Every environment variable tokenleader reads: [server](#server) (platform env
UI, compose file, or `.env`), [daemon](#daemon) (written into the LaunchAgent
plist by the installer), and [installer / uninstaller](#installer--uninstaller)
(the rendered `curl | bash` scripts).

Source of truth is [`src/server/config.ts`](../src/server/config.ts); a test
keeps this table, [.env.example](../.env.example), and the code in lockstep.

**Validation (server):** every variable is optional — the server boots with
zero config. Malformed values (non-numeric `PORT`, invalid Cursor-map JSON)
are fatal at boot; out-of-range numerics clamp to the nearest bound and warn.

## Server

### Basics

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `8787` | Listen port. Must be an integer in `[1, 65535]` — anything else is a fatal config error. |
| `TOKENLEADER_HOST` | `0.0.0.0` | Bind address for the HTTP server. |
| `TOKENLEADER_DATA_DIR` | macOS: `~/Library/Application Support/tokenleader` · Linux: `$XDG_DATA_HOME/tokenleader`, else `~/.local/share/tokenleader` · Docker image: `/data` | Root directory for all persistent state (SQLite DB + mirrored binaries). Point this at your volume. |
| `TOKENLEADER_DB` | `<dataDir>/tokenleader.sqlite` | SQLite database path. Rarely needed — derived from `TOKENLEADER_DATA_DIR`. |
| `TOKENLEADER_BINARY_CACHE_DIR` | `<dataDir>/binaries` | On-disk cache for mirrored daemon binaries. Rarely needed. |
| `TOKENLEADER_SERVER_URL` | unset — inferred per request from `X-Forwarded-Proto` / `X-Forwarded-Host` | Canonical public URL of this server, no trailing slash (trailing slashes are stripped). **Strongly recommended in production**: header inference can be spoofed by clients, poisoning the URL baked into rendered `/install` scripts. The server logs a boot warning while unset. |
| `TOKENLEADER_TEAM_NAME` | unset | Display name in the dashboard header and the installer banner. Display-only — never used in paths. |

### Branding

Branding is file-based. `GET /brand/logo.svg` and `GET /brand/favicon.svg`
fall back to a built-in neutral mark; drop replacements into
`<data-dir>/brand/` (e.g. `/data/brand/` on Docker):

```
<data-dir>/brand/logo.svg      # header logo + apple-touch-icon
<data-dir>/brand/favicon.svg   # browser tab icon
```

Served with `cache-control: public, max-age=300` — swaps appear within
5 minutes, no redeploy. Use **theme-agnostic** SVGs (one file serves both
dashboard themes). `/brand/*` is never auth-gated — favicons must load on
`/login`. `TOKENLEADER_TEAM_NAME` is the text half: dashboard header chip
plus page `<title>` / `og:title` (`tokenleader · <team>`).

### Auth

| Variable | Default | What it does |
|---|---|---|
| `TOKENLEADER_DASHBOARD_TOKEN` | unset = dashboard public | Viewer token for `GET /`, `/admin`, `/stats`, `/stats/*`. Browsers get a `/login` form (cookie-based); scripts can send `Authorization: Bearer <token>` or a one-shot `?token=` query param. |
| `TOKENLEADER_API_TOKEN` | unset = follows the dashboard posture | Bearer token for `/api/v1/*`. When unset, `/api/v1/*` **inherits the dashboard token**; when both are unset the API is open. |
| `TOKENLEADER_ADMIN_TOKEN` | unset = admin routes disabled | Gates the destructive `POST /admin/clear` route (timing-safe bearer compare). Unset → the route returns `503` — admin is opted out, it does not fail open. |
| `TOKENLEADER_JOIN_TOKEN` | unset = open TOFU | Join code for **new** leaderboard names: when set, the first `/ingest` claim of an unclaimed username must present it (`X-Tokenleader-Join`, supplied via the installer's `--join` flag) or it is rejected with `403 join_required`. Already-claimed users are untouched — their TOFU secret rules. Unset is fine on a LAN/tailnet; set it on the public internet. |

### Daemon binary mirror

Pulls daemon binaries + `manifest.json` from a GitHub release and serves them
to your fleet at `/manifest.json` and `/bin/*`. Needs **both** the repo and a
token (unauthenticated mirroring of public repos is a planned follow-up);
without them the update routes return `503` and daemon installs/auto-updates
are dark — the boot log says so.

| Variable | Default | What it does |
|---|---|---|
| `TOKENLEADER_GH_REPO` | unset | `owner/repo` to mirror daemon releases from. Point at your fork if you maintain one. |
| `TOKENLEADER_GH_TOKEN` | unset | GitHub token used by the mirror. Read-only access to the repo is all it needs. |
| `TOKENLEADER_MIRROR_INTERVAL_SEC` | `900` (15 min) | Mirror polling cadence. Clamped to `[60, 86400]`. |

### Cursor mirror

Optional, **off by default**. Imports your team's Cursor usage server-side via
the Cursor Teams Admin API — no daemon involved. Cursor rows carry Cursor's
own reported cost, which wins over derived pricing.

| Variable | Default | What it does |
|---|---|---|
| `TOKENLEADER_CURSOR_TOKEN` | unset = mirror off | Cursor Teams admin API key. Setting it **requires** a non-empty user map (below) — token-without-map is a fatal config error. |
| `TOKENLEADER_CURSOR_INTERVAL_SEC` | `900` (15 min) | Cursor polling cadence. Clamped to `[60, 86400]`. |
| `TOKENLEADER_CURSOR_USER_MAP` | unset | Inline JSON object mapping Cursor account emails to leaderboard handles, e.g. `{"alice@example.com":"alice","bob@example.com":"bob"}`. Keys are lowercased; handles must be non-empty, ≤64 chars; characters outside `[A-Za-z0-9._-]` only warn. |
| `TOKENLEADER_CURSOR_USER_MAP_FILE` | unset | Path to a file containing the same JSON. When set, the file **wins entirely** over the inline value (no merge). An unreadable file is a fatal config error. |
| `TOKENLEADER_COMPANY_ALIASES` | unset | Inline JSON of `"from-domain": "to-domain"` rewrites applied to the `X-Tokenleader-Company` header at ingest — fixes a typo'd self-reported affiliation without touching the teammate's machine. Both sides are normalized; non-domain entries are dropped with a warning. |

### Backups (Litestream)

Optional, **off by default**. The Docker image bakes in
[Litestream](https://litestream.io); when configured, the entrypoint restores
a missing database from the replica on boot (lost-volume disaster recovery)
and runs the server under `litestream replicate -exec`, streaming every write
to S3-compatible storage.

| Variable | Default | What it does |
|---|---|---|
| `LITESTREAM_REPLICA_URL` | unset = backups off | Replica URL, e.g. `s3://my-bucket/tokenleader`. For R2/B2/minio append `?endpoint=https://…` (R2 example: `s3://bucket/tokenleader?endpoint=https://<account>.r2.cloudflarestorage.com`). |
| `LITESTREAM_ACCESS_KEY_ID` | unset | Access key for the bucket. |
| `LITESTREAM_SECRET_ACCESS_KEY` | unset | Secret key for the bucket. |

If the DB file is missing and the replica can't be reached, boot fails on
purpose — starting fresh next to a populated replica would bury the good
backup under a new generation; let the supervisor retry instead.

### Per-platform cheat sheet

| Where | How to set |
|---|---|
| Railway | service → **Variables** (the template pre-provisions the volume + tokens) |
| Fly.io | `fly secrets set TOKENLEADER_ADMIN_TOKEN=...` (secrets) or `[env]` in `fly.toml` (non-secrets) |
| Docker Compose | `environment:` block or an `.env` file next to `docker-compose.yml` |
| Bare metal | export in the service unit / launchd plist, or a `.env` file in the working directory (Bun loads it natively) |

## Daemon

Written into the LaunchAgent plist by the installer — documented for debugging
and for [running your own build](daemon.md#building-and-running-your-own-daemon).
Out-of-range numerics clamp; truthy flags accept `1`, `true`, `yes`, `on`.

| Variable | Default | What it does |
|---|---|---|
| `TOKENLEADER_USER` | **required** | Leaderboard handle this daemon reports as. |
| `TOKENLEADER_ENDPOINT` | **required** | Base URL of your server. Note: a persisted `<stateDir>/endpoint` override file, if present, wins over this env (see [Fleet migration](#fleet-migration)). |
| `TOKENLEADER_JOIN` | unset | Join code, sent as `X-Tokenleader-Join` on every ingest POST. The server only consults it on first claim of a handle. |
| `TOKENLEADER_COMPANY` | unset | Company affiliation as a domain or URL (installer `--company` flag), sent as `X-Tokenleader-Company` on ingest POSTs. The server normalizes to a lowercase bare hostname (`https://www.Anara.com/x` → `anara.com`, ≤ 64 chars) and stores it per user (last write wins; absent never clears; invalid values are ignored with a warn). |
| `TOKENLEADER_LINK` | unset | One-time pairing code (installer `--link` flag), sent as `X-Tokenleader-Link` on every ingest POST. The server only consults it when this machine's secret doesn't match an existing device; single-use, so the header is inert after redemption. See [one handle, multiple machines](daemon.md#one-handle-multiple-machines). |
| `TOKENLEADER_INTERVAL_SEC` | `300` (5 min) | Tick cadence — how often local logs are scanned and new events posted. Clamped to `[5, 86400]`. |
| `TOKENLEADER_BATCH_SIZE` | `1000` | Max events per ingest POST. Clamped to `[1, 10000]`. |
| `TOKENLEADER_STATE_DIR` | `~/.local/share/tokenleader` | Holds `secret` (TOFU identity), `state.json` (per-file read offsets), and the optional `endpoint` override. |
| `TOKENLEADER_RUN_ONCE` | off | Run a single tick, then exit. Useful for debugging (see [docs/daemon.md](daemon.md#troubleshooting)). |
| `TOKENLEADER_UPDATE_INTERVAL_SEC` | `3600` (1 h) | Auto-update check cadence (±10% jitter so a fleet doesn't herd downloads). Clamped to `[60, 604800]`. |
| `TOKENLEADER_UPDATE_DISABLED` | off | Disable auto-update entirely. **Required** when running a self-built binary, or the updater swaps it back within the hour. |
| `TOKENLEADER_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error`. |
| `TOKENLEADER_LOG_DIR` | `~/Library/Logs/tokenleader` | Structured JSONL log location (`daemon.jsonl`, rotated at 5 MB, 3 rotations kept). |
| `TOKENLEADER_LOG_FILE_DISABLED` | off | `1` skips the file sink entirely (logs to stdout/stderr only). |
| `TOKENLEADER_CLAUDE_COWORK` | on | Parse Claude Cowork (Claude Desktop "local agent mode") sessions, tagged `claude_cowork`. Set `0` to disable. Cloud/remote Cowork runs server-side and leaves nothing on disk, so it is never tracked regardless. |
| `TOKENLEADER_CLAUDE_COWORK_DIR` | macOS: `~/Library/Application Support/Claude` · Linux: `~/.config/Claude` · Windows: `%APPDATA%/Claude` | Claude Desktop data dir scanned for Cowork session transcripts. Override for non-default installs. |
| `TOKENLEADER_TOKEN` | unset | **Legacy.** A historical shared bearer token. Parsed so old plists don't crash, never sent — the per-user TOFU secret replaced it. |

## Installer / uninstaller

Your server renders these scripts at `GET /install` and `GET /uninstall`.

**Install flags** (after `bash -s --`):

| Flag | Equivalent env | What it does |
|---|---|---|
| `--name=HANDLE` | `TOKENLEADER_USER` | Leaderboard handle (flag wins over env; defaults to `$USER`). |
| `--join=CODE` | `TOKENLEADER_JOIN` | Join code, for servers that set `TOKENLEADER_JOIN_TOKEN`. |
| `--company=DOMAIN` | `TOKENLEADER_COMPANY` | Company affiliation shown on the leaderboard. |
| `--link=CODE` | `TOKENLEADER_LINK` | Pairing code that adds this machine to a handle you already own (mint with `tokenleader link` on the old machine). |

**Script env overrides:**

| Variable | Script | What it does |
|---|---|---|
| `TOKENLEADER_INSTALL_URL` | both | Override the server URL baked into the rendered script (e.g. point at a staging server). |
| `TOKENLEADER_BINARY_URL` | install | Override the binary download base (default `$SERVER_URL/bin`). |
| `TOKENLEADER_PURGE` | uninstall | Pre-answer the "also delete state + logs?" prompt: `y`/`yes` deletes the state dir (including the TOFU secret) and logs; anything else keeps them. Unset → interactive prompt. |

## Fleet migration

Fielded daemons have the old URL in their plists, so moving to a new URL has
a dedicated mechanism:

- The daemon honors an `X-Tokenleader-Canonical-Endpoint` response header (or
  `canonicalEndpoint` field) on `/manifest.json`: when the advertised endpoint
  serves the same binary manifest, it is persisted to `<stateDir>/endpoint`,
  which from then on **wins over `TOKENLEADER_ENDPOINT`** at every boot.
  Release tooling never emits the field — it is reserved for operator-crafted
  transition manifests served from the old host.
- A malformed or unreadable override file loses to the env — it can never
  brick a daemon.
- The daemon logs `endpoint_override_active` (both URLs) while the override is
  in effect; delete `<stateDir>/endpoint` and restart to revert to the plist
  URL.
- Reinstalling (`curl .../install | bash`) clears the override and re-points
  the plist at whichever server rendered the script. The TOFU secret is
  preserved, so history continues under the same handle.
