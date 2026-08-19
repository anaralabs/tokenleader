# Updates, releases, and rollback

## How a release happens

Releases are maintainer-cut **git tags** (`vX.Y.Z`). One tag push drives the
whole pipeline (`.github/workflows/release.yml`):

1. Builds the daemon binaries on **native runners per platform** —
   `tokenleader-darwin-{arm64,x64}` on macOS, `tokenleader-linux-{x64,arm64}`
   on Ubuntu — so the guards can actually execute what they check. A guard
   asserts every built binary's `--version` reports exactly the tag, and the
   linux binaries additionally complete a real update cycle (guard `f`) and,
   for x64, run under a pre-AVX2 CPU mask (guard `b2`) to prove the baseline
   target hasn't been silently swapped out.
2. Emits `manifest.json` from ONE job that hashes all four artifacts, with the
   version, publish timestamp, and per-platform sha256 entries (a `platforms`
   map keyed `darwin-arm64`/`darwin-x64`/`linux-x64`/`linux-arm64`; schema v2,
   with byte-equal legacy mirror keys — always DARWIN — so older daemons keep
   parsing it). A darwin daemon resolves the legacy keys and never looks at the
   linux entries; every other platform resolves `platforms["${os}-${arch}"]`.
3. Creates the GitHub release as a **draft, uploads everything, then flips it
   live** — "latest" never points at a half-uploaded release. Tags containing
   `-` (e.g. `v0.2.0-rc.1`) publish as prereleases and never take the latest
   marker, so release-candidates can't roll a fleet.
4. Builds and pushes the multi-arch server image to
   `ghcr.io/anaralabs/tokenleader:<tag>` (and `:latest` for stable tags).

The manifest contains **no URLs** — daemons always fetch binaries from their
own server's `/bin` route, so a stale or hostile manifest cannot redirect a
fleet elsewhere.

## How updates reach your team

Two hops, both automatic:

```
GitHub release ──(server mirror, every 15 min)──► your server's cache
your server ──(daemon poll, every ~60 min)──► every teammate's machine
```

1. **Server mirror.** Polls the configured repo (`TOKENLEADER_GH_REPO` +
   `TOKENLEADER_GH_TOKEN`) every `TOKENLEADER_MIRROR_INTERVAL_SEC` (default
   15 min) and atomically swaps the cached `manifest.json` + binaries served
   at `/manifest.json` and `/bin/*`.
2. **Daemon self-update.** Each daemon checks `/manifest.json` about hourly
   (±10% jitter so a fleet doesn't herd downloads). If the manifest sha256 for
   its platform differs from the running binary, it downloads, verifies the
   sha256, smoke-tests `--version` on the new bytes, atomically renames over
   its own binary, and exits `75` so **the supervisor** respawns it — launchd's
   `KeepAlive` on macOS, systemd's `Restart=always` + `SuccessExitStatus=75` on
   Linux. It never restarts itself. State and read-offsets live in a separate
   directory, so a swap never loses or double-counts events.

**Worst-case propagation: ~75 minutes** (15 min mirror + 60 min daemon poll).
Verify with the fleet panel on your dashboard, or per-machine with
`~/.local/bin/tokenleader --version`.

Trust model: updates are **sha256-verified** against the manifest, which
daemons fetch from the same server as the binary — that protects against
corruption and torn downloads, not against whoever controls the server or the
upstream release. Cryptographic release signing with a pinned public key is
planned.

## Updating the server

| How you deployed | How you update |
|---|---|
| Railway template | Railway surfaces the new image version; redeploy from the dashboard. |
| Docker / Compose | `docker compose pull && docker compose up -d` if you track `:latest`; bump the tag and redeploy if you pin (recommended for the cautious). |
| Fly.io | `fly deploy` (rebuilds from the repo Dockerfile at your checkout). |
| From source | `git pull`, rebuild, restart. |

Server restarts are cheap: in-flight requests drain (up to 8 s), daemons
buffer and retry. The DB schema migrates forward automatically on boot —
**take a backup before major-version upgrades**
([self-hosting.md](self-hosting.md#backups)).

### Upgrading a pre-OSS deployment

Three behavior changes to check before restarting onto an open-source build:

- **`TOKENLEADER_GH_REPO` and `TOKENLEADER_GH_TOKEN` must now be set
  explicitly.** The gh-CLI token fallback and the default repo were removed —
  leave them unset and the update/install routes stay dark (boot warns).
- **`TOKENLEADER_CURSOR_TOKEN` alone no longer enables the Cursor mirror.**
  The built-in email→user map was removed; also set
  `TOKENLEADER_CURSOR_USER_MAP` (or `TOKENLEADER_CURSOR_USER_MAP_FILE`), or
  the mirror stays off (boot warns).
- **The default DB path moved** from `./tokenleader.sqlite` to the data
  directory. Deployments that pin `TOKENLEADER_DB` are unaffected; otherwise
  point `TOKENLEADER_DB` at the old file (or move it) before first boot.

## Rolling back

### Server

Pin the previous image tag and redeploy:

```sh
# compose: set image: ghcr.io/anaralabs/tokenleader:v0.1.0, then
docker compose up -d
```

Newer-schema DBs are not guaranteed to open under older servers — if the bad
version migrated the schema, restore the pre-upgrade backup with the
`.import` mechanism ([self-hosting.md](self-hosting.md#importing-an-existing-database)).

### Daemon fleet

Daemons follow the **latest stable release** of the mirrored repo — they
compare for *difference*, not direction, so a rollback propagates exactly like
an upgrade (same ~75 min worst case). As the repo maintainer (or on your
fork):

```sh
# Re-point "latest" at the known-good release:
gh release edit v0.1.1 --latest
# Optionally mark the bad one as a prerelease so nothing re-mirrors it:
gh release edit v0.1.2 --prerelease
```

To **freeze** a fleet during an incident instead, stop the mirror from
advancing — point `TOKENLEADER_GH_REPO` at a fork whose latest release you
control.

## Forks

Renamed or private forks work out of the box: set
`TOKENLEADER_GH_REPO=yourorg/yourfork` (with a token that can read it) and
cut releases with the same tag-driven workflow — daemons key on asset names
and manifest shape, and the release workflow derives image/repo names from
the repository it runs in.

## Version identity

- Daemon: `~/.local/bin/tokenleader --version` →
  `<version> <build-sha> <platform>`; also in the dashboard's fleet panel and
  the `daemon_start` line in the daemon log.
- Server: the boot log; images are tagged with the release version.
- Manifest: `version` field of `GET /manifest.json` — what the fleet panel
  compares daemons against to flag stale machines.
