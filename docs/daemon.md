# The daemon

A single compiled binary per teammate Mac, installed by your server's
`/install` script, kept current by its own auto-updater. It parses the local
session logs of Claude Code (`~/.claude/projects/`), Codex CLI
(`~/.codex/sessions/`), and Cursor personal usage (read-only parse of
`state.vscdb` under Cursor's `globalStorage`) and POSTs **token counts, model
names, and timestamps — never message content** — to your server every 5 minutes.

## Install

```bash
curl -fsSL https://leaderboard.example.com/install | bash -s -- --name=alice
```

If the server sets `TOKENLEADER_JOIN_TOKEN`, claiming a **new** name also
needs the join code (the dashboard renders the full command):

```bash
curl -fsSL https://leaderboard.example.com/install | bash -s -- --name=alice --join=<code>
```

Optional: `--company=anara.com` tags the handle with a company affiliation
(stored as `TOKENLEADER_COMPANY` in the LaunchAgent, sent as
`X-Tokenleader-Company` on ingest; the server normalizes the domain).

The script:

1. Detects your arch (Apple Silicon or Intel) and downloads the matching
   daemon binary **from your server's own `/bin` route** — teammate machines
   never talk to GitHub.
2. Verifies the binary's sha256 against your server's `/manifest.json`
   (transport integrity only — trust model in
   [updating.md](updating.md#how-updates-reach-your-team)).
3. Installs the binary, registers a per-user LaunchAgent
   (`launchctl bootstrap gui/$UID`), and kickstarts it. The first tick replays
   your existing local history — the dashboard fills within minutes.

Idempotent: a reinstall keeps your state dir (and TOFU secret), so history
continues under the same handle.

## What it touches on disk

| Path | What |
|---|---|
| `~/.local/bin/tokenleader` | the daemon binary |
| `~/Library/LaunchAgents/com.tokenleader.daemon.plist` | the LaunchAgent (env config lives here — see [configuration.md](configuration.md#daemon)) |
| `~/.local/share/tokenleader/` | state dir: `secret` (TOFU identity), `state.json` (per-file read offsets), optional `endpoint` (server-migration override) |
| `~/Library/Logs/tokenleader/` | structured logs (`daemon.jsonl`, rotated at 5 MB ×3) |

Nothing else: it reads `~/.claude/projects/`, `~/.codex/sessions/`, Cursor's
local SQLite store (`state.vscdb`), and agent transcript JSONL files under
`~/.cursor/projects/*/agent-transcripts/`, writes only the four locations above.

Local Cursor parsing is on by default. Disable with `TOKENLEADER_CURSOR_LOCAL=0`
in the LaunchAgent env. Override the DB location with `CURSOR_DATA_DIR` pointing
at Cursor's `User/globalStorage` directory (same shape as `CLAUDE_CONFIG_DIR`).

### Cursor cloud sync (recommended)

For accurate models, token counts, and costs, authenticate against Cursor's
dashboard API instead of relying on local heuristics:

```bash
# macOS — reads your signed-in Cursor IDE session automatically
tokenleader login-cursor --auto

# manual fallback (any platform with a browser session cookie)
tokenleader login-cursor '<WorkosCursorSessionToken>'

# backfill ALL dashboard history immediately (optional — see below)
tokenleader sync-cursor
```

`login-cursor --auto` saves credentials to `<stateDir>/cursor_credentials.json`
(session token, refresh token, machine id) and `cursor_token`, then posts the
**current month** right away for instant feedback. Requires the server build that
accepts `source: "cursor"` on `/ingest` — deploy server and daemon together.

Once a token is saved, the daemon backfills your **full** dashboard history
automatically in the background: until the one-time all-time backfill finishes it
pulls history in bounded chunks (~2,500 events per tick) so a large back-catalogue
never blocks a tick, then settles into a cheap incremental window. `sync-cursor`
just does that same full backfill immediately in the foreground — handy if you
don't want to wait for the daemon to drain it across a few ticks.

## Identity: how TOFU works

On first run the daemon generates a random secret at `<stateDir>/secret` and
sends it as `X-Tokenleader-Secret` on every POST. The server stores a hash on
the **first claim** of a username (trust-on-first-use) and from then on only
accepts that machine's secret for that name — or another machine explicitly
linked to it (next section). Nobody posts as you without compromising one of
your machines or a pairing code you minted.

- **`403 join_required`** — the server gates new names with a join token;
  re-run the installer with `--join=<code>`.
- **`403 secret mismatch for user '<name>'`** — the name is claimed under a
  different secret than yours. Link the machine (below) or see
  [fixing a 403](#fixing-a-403-secret-mismatch).

## One handle, multiple machines

Each machine keeps its own secret; the server keeps one **device** row per
machine. To add a second machine to your handle:

```bash
# on a machine that already posts as you:
tokenleader link
# → Link code for 'alice': ABCD-2345   (valid 10 minutes, single use)

# on the new machine, paste the command `link` printed:
curl -fsSL https://leaderboard.example.com/install | bash -s -- --name=alice --link=ABCD-2345
```

The new machine's first sync redeems the code and registers its own secret as
an additional device; from then on both machines post and their counts merge
under your name (dedup is per message id, so nothing double-counts). Codes
can only be minted from a machine that already holds your secret, expire
after 10 minutes, and die on first use — treat one like a password while
it's live.

Manage your machines from any of them:

```bash
tokenleader devices       # list, with ids + labels
tokenleader revoke <id>   # lock a machine out (lost/stolen/retired)
```

Uninstalling one machine only removes that device; your handle stays active
while any machine remains. If your **only** machine is gone, an admin can
mint a code for you (see below) — no history is lost.

### Fixing a 403 secret mismatch

Typical cause: a deleted state dir (new laptop, manual cleanup) — fresh
secret, but the server holds the old hash. Three ways out:

1. **If another linked machine still works**, mint a code there
   (`tokenleader link`) and reinstall here with `--link=<code>`.
2. **If the previous install was uninstalled properly** (`/uninstall` ran),
   the name is re-claimable — just reinstall.
3. **Otherwise, an admin mints a link code** (requires
   `TOKENLEADER_ADMIN_TOKEN` on the server):

   ```bash
   curl -X POST https://leaderboard.example.com/admin/link \
     -H "Authorization: Bearer $TOKENLEADER_ADMIN_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"user":"alice"}'
   ```

   then reinstall with `--link=<code>`. The history-destroying fallback
   (`/admin/clear` with `{"scope":"reset-user"}`) still exists, but the link
   code keeps the user's events intact.

## Uninstall

```bash
curl -fsSL https://leaderboard.example.com/uninstall | bash
```

Stops and removes the LaunchAgent and binary, and notifies the server
(`POST /events/uninstall`, authenticated with the on-disk secret) so the name
becomes re-claimable. You'll be asked whether to also delete state + logs;
pre-answer with `TOKENLEADER_PURGE=y` (deletes the TOFU secret too) or
`TOKENLEADER_PURGE=n` (keeps it for a seamless reinstall).

## Auto-update

The daemon polls your server's `/manifest.json` about hourly (first check
~30 s after boot, never overlapping a tick). On a sha256 difference for its
platform it downloads from `/bin/*`, verifies, atomically renames over its own
binary, and restarts via `launchctl kickstart -k`. Propagation timing, trust
model, rollback: [updating.md](updating.md).

## Building and running your own daemon

```bash
git clone https://github.com/anaralabs/tokenleader && cd tokenleader
bun install
# Apple Silicon (use bun-darwin-x64 / -x64 for Intel):
bash scripts/build-daemon.sh bun-darwin-arm64 bin/tokenleader-darwin-arm64
cp bin/tokenleader-darwin-arm64 ~/.local/bin/tokenleader
```

**The crucial step is disabling auto-update**: the updater compares hashes for
*inequality*, so a self-built binary left on the update path is swapped back
to the server-supplied build within about an hour. Add this to the
`EnvironmentVariables` dict in
`~/Library/LaunchAgents/com.tokenleader.daemon.plist`:

```xml
<key>TOKENLEADER_UPDATE_DISABLED</key>
<string>1</string>
```

and restart:

```bash
launchctl kickstart -k gui/$(id -u)/com.tokenleader.daemon
```

This opts out of fleet updates entirely — you own keeping the binary current.

## Troubleshooting

| Symptom | Check |
|---|---|
| What version am I running? | `~/.local/bin/tokenleader --version` → `<version> <build-sha> <platform>`. Alternates: the fleet panel on your dashboard, or the `daemon_start` line at the top of the newest `~/Library/Logs/tokenleader/daemon.jsonl`. |
| Not on the leaderboard | `tail -5 ~/Library/Logs/tokenleader/daemon.jsonl` — look for `tick_done` (posting fine), `403` errors (see [secret mismatch](#fixing-a-403-secret-mismatch)), or `network_error`. |
| Is the LaunchAgent alive? | `launchctl print gui/$(id -u)/com.tokenleader.daemon \| grep state` |
| Run one tick by hand, watching everything | `TOKENLEADER_USER=alice TOKENLEADER_ENDPOINT=https://leaderboard.example.com TOKENLEADER_RUN_ONCE=1 TOKENLEADER_LOG_LEVEL=debug ~/.local/bin/tokenleader` |
| Daemon updates never arrive | `curl -s https://leaderboard.example.com/manifest.json` — a 503 means the **server's** mirror is dark (admin: see [self-hosting.md](self-hosting.md#operations)). |
| Missing from the fleet panel >24 h after a server migration | Check `~/.local/share/tokenleader/endpoint` exists and contains the new URL — that override file is the only thing keeping migrated daemons off the dead hostname baked into their plist. Grep the log for `endpoint_override_active`. Fastest fix either way: re-run the installer from the new server. |
| Reporting to a server I don't expect | Same file: `<stateDir>/endpoint` wins over the plist's `TOKENLEADER_ENDPOINT`. Delete it and kickstart to revert to the plist URL. |

## Platform support

macOS (Apple Silicon + Intel) today; Linux (x64/arm64, systemd user unit,
covers WSL) is next; native Windows later. The update manifest already carries
the OS dimension, so new platforms arrive without breaking existing daemons.
