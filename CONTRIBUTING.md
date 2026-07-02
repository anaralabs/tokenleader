# Contributing to tokenleader

Thanks for helping out! This is a small, sharp codebase — one Bun workspace
holding a macOS daemon, an HTTP server, and a React dashboard — and it tries
hard to stay that way.

## Dev setup

```bash
bun install
bun test               # 650+ tests, a few seconds
bunx tsc --noEmit      # typecheck
bunx biome check src   # lint + format (biome check --write to fix)
cd web && bun install && bun run dev   # dashboard against a local server
```

Run a local server with `bun src/server/main.ts` (SQLite lands in `./data/`).
Run the daemon against it with:

```bash
TOKENLEADER_USER=you TOKENLEADER_ENDPOINT=http://127.0.0.1:8787 \
TOKENLEADER_UPDATE_DISABLED=1 bun src/daemon/main.ts
```

## Repo layout

| Path | What lives there |
|---|---|
| `src/daemon/` | The launchd daemon: tick loop, parsers glue, transport, self-update, directives |
| `src/parser/` | Per-source transcript parsers (Claude Code, Cowork, Codex, Cursor) |
| `src/server/` | Hono server: ingest, stats, fleet, admin, binary mirror, installer rendering |
| `web/` | React/Vite dashboard SPA (built into the server image) |
| `scripts/` | Build, release, and CI-gate scripts |

Two conventions worth knowing before a PR:

- **Per-source dispatch stays explicit.** `tick.ts` dispatches to each parser
  with plain branches on purpose — the parse shapes are irreducibly divergent,
  and a registry abstraction has been evaluated and rejected. Add a new source
  as a new explicit branch.
- **The daemon must never be able to wedge or die from bad data.** Ingest is
  per-row tolerant server-side; parsers fall back rather than throw; the
  updater sha-verifies and smoke-runs binaries before swapping. Keep that bar.

## Tests

Every behavior change needs a test. The suite runs under `bun test` with
dependency-injection seams (`fetchImpl`, `restart`, `downloadBinary`, …) —
no network, no real launchd, no real `$HOME`. If your change touches the
update path, note that CI *additionally* drives the real compiled binary
through a full update cycle (`scripts/update-gate.ts`), because the compiled
runtime is a different surface than `bun test`.

## Releases (maintainers)

Tags are the version — `package.json` stays at `0.1.0` forever.

```bash
scripts/release.sh X.Y.Z   # gate (tests + tsc) + annotated tag, no push
git push origin vX.Y.Z     # THE publication act: CI builds daemons,
                           # manifest, GitHub release, ghcr image
```

`release.yml` runs guards (a)–(f) — version stamps, manifest shape, codesign
identity, and a live update-cycle run of the built artifact. Server/web-only
changes deploy from `main` directly (no tag): don't cut daemon releases for
dashboard CSS.

## PRs

Keep them focused. CI must be green (`format`, `scrub-gate`, `test` ×2
timezones, `web`). Write the PR body for a reviewer who wasn't in the room:
what breaks without this, and how you verified it.
