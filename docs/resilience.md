# Resilience: the "Never Silent" architecture (v0.6.0)

The design goal, stated as an invariant: **a daemon that stops reporting is
always detected, and is healed locally or healable remotely — silence is
never an ambiguous state.**

This document is the frozen v0.6.0 design. It was produced from a five-track
research pass (launchd semantics, Bun runtime forensics, industry agent
architectures, watchdog theory, full codebase failure audit) followed by a
three-lens adversarial review. Every threshold and mechanism below survived
that review; the review's corrections are folded in.

## The motivating incident (2026-07-06)

A production daemon (v0.5.9) went silent for two days while its process stayed
alive: main thread parked in `kevent64`, zero open sockets, 0% CPU, RSS paged
out. The last tick completed cleanly; the 5-minute `setTimeout` scheduling the
next one never fired — across 18+ hours of machine-awake time. The trigger
correlated with a night of macOS DarkWake churn; the process's sleep-excluding
monotonic clock lagged wall time by ~19.5h. SIGTERM still worked instantly.

Conclusion: the Bun runtime's timer subsystem died. Every in-process
`setTimeout` backstop died with it. `KeepAlive` could not help (no exit).
Server directives could not reach it (delivery required the daemon to phone
home). The design axiom that follows:

> **Any liveness mechanism whose firing depends on a Bun timer is inside the
> blast radius and void by construction. The deadline must be enforced by a
> different process on launchd's clock.**

## Architecture: the watchdog pair

Two launchd user agents, one compiled binary:

| Label | Trigger | Role |
|---|---|---|
| `sh.anara.leaderboard` | `KeepAlive: true` | The daemon (unchanged shape) |
| `sh.anara.leaderboard.watchdog` | `StartInterval: 120` + `RunAtLoad` | One-shot checker, alive < 30s per run |

The watchdog is the same binary invoked as `anara-leaderboard watchdog`, but
its plist points at a **hardlink** (`~/.local/bin/anara-leaderboard.watchdog`,
refreshed by the daemon at every boot). The hardlink decouples watchdog
spawnability from the daemon binary: if the daemon binary is deleted or a
manifest rollback installs a pre-watchdog version, the watchdog layer — and
its phone-home channel — survives.

A process alive for seconds cannot accumulate the sleep-churn that kills Bun
timers; launchd guarantees single-instance-per-label and *drops* (never
queues) StartInterval firings that collide with a running instance or occur
during sleep. The supervision recursion terminates at launchd — there is no
watchdog-of-the-watchdog, deliberately.

Rejected alternatives, for the record: an osquery-style long-lived supervisor
would share the wedgeable Bun timer heap (same failure domain); a run-once
tick architecture is the theoretical maximum but requires changing the daemon
plist's *shape* on live machines (the self-bootout stranding trap) — it
remains a v0.7 candidate once the watchdog has field data.

## The liveness contract

**Heartbeat = progress, not aliveness.** The daemon atomically writes
(temp + rename) `<stateDir>/heartbeat.json` at every progress boundary:

- tick start and tick end (success *or* failure),
- every 200 files inside the parse loop,
- after every batch POST,
- bracketing the Cursor-cloud walk (its worst legitimate case, 25 pages x
  30s timeout ≈ 12.5 min, stays inside the 16-min staleness threshold).

Content: `{ pid, wall_ms, tick_seq, version, consec_failures, last_error }`.
Disk writes were empirically alive during the wedge; sockets were not. The
heartbeat is a file, never a self-ping.

**Staleness is counted in watchdog firings, not clock arithmetic.** Because
StartInterval never fires during sleep, "heartbeat unchanged across N
consecutive watchdog runs" is itself a measure of awake time. The watchdog
persists `{ lastHeartbeatSig, consecUnchanged }` in `<stateDir>/watchdog.json`
(temp + rename, schema-versioned). **N = 8 runs at 120s ≈ 16 minutes awake.**
Missed firings (sleep, collisions) under-count awake time — the conservative
direction. No `kern.waketime`, no NTP exposure, no cross-process monotonic
origins. A corrupt state file counts as one stale observation already recorded
(fail-closed toward detection) and is reported in the watchdog checkin.

**Update grace.** Binary downloads legitimately take up to ~30 minutes on slow
links (600s x 3 curl attempts). The daemon writes an `update_in_progress`
marker (with `started_at`) before the download and clears it in a `finally`.
While a fresh marker exists the watchdog extends the deadline to a **45-minute
hard cap**; a marker older than 60 minutes is ignored (crash debris).

**Identity anchoring — who may be killed.** The watchdog resolves the label's
live pid from `launchctl print gui/$UID/sh.anara.leaderboard` (source of
truth) and signals **only when that pid equals `heartbeat.pid`** — the process
that promised heartbeats is the only one condemnable for stopping them. This
single rule eliminates: PID-reuse kills of innocent processes, kills of
rolled-back pre-heartbeat daemons (their pid never appears in a heartbeat),
and kills of a daemon that respawned after the heartbeat was written. A
missing heartbeat file is always observe-only (pre-0.6 daemon, fresh install).

## Escalation ladder

1. **Staleness confirmed** (N consecutive unchanged, identity match) →
   **forensics first, then SIGTERM**: `sample <pid> -f <spool>` (with
   timeout; works same-uid on our ad-hoc-signed binary), `launchctl print`
   snapshot, 64KB log tail — staged to `<stateDir>/spool/` before any signal.
2. **Next run, same pid still alive** → SIGKILL. launchd KeepAlive respawns
   either way (ThrottleInterval 30s bounds the rate).
3. **Fuse — respawns, not kills:** ≥ 3 daemon respawns within 90 minutes that
   are *not explained by the exit journal* and do not recover the heartbeat →
   stop killing, write a `degraded` marker, keep reporting via the watchdog
   checkin. (A kill-based fuse is dead code: SIGTERM-compliant kills space
   ≥ 17 minutes apart.) **Unlatch:** heartbeat fresh for 30 minutes clears
   all counters and the degraded marker.
4. **Rollback backstop:** ≥ 3 *crash-classified* respawns of a freshly
   swapped binary (sha differs from `.prev`) → restore `.prev` by copying to
   a temp file and renaming over execPath (fresh inode; `.prev` preserved).

**Exit journal.** Every deliberate exit (update swap restart, endpoint
override restart, drift exit, recycle, restart directive) appends
`{ts, reason, code}` to `<stateDir>/exit-journal.jsonl` (size-capped) before
exiting. The next boot reports the tail in its first checkin (a boot without a
journal entry = crash/silent-exit, closing the exit(0) blind spot); the
watchdog counts only *unexplained* respawns; the server's crash-loop
classifier ignores journal-explained restarts.

## Watchdog run order and duties

Local decisions first, network last — the kill duty is never hostage to a slow
server. Every network call is `curl --max-time 10 --connect-timeout 5`; Bun
fetch is banned in the watchdog entirely.

1. Assert own domain (`gui/$UID`); exit quietly otherwise.
2. Read heartbeat + own state → staleness/identity decision → ladder.
3. Boot-time self-heal: daemon binary missing → re-download via manifest
   (curl + sha256, reusing the update path — the manifest GET rides a
   curl-backed fetch adapter, and the repair call omits the state dir: the
   watchdog never performs endpoint-override migrations and never writes
   journal entries for restarts that didn't happen); daemon plist missing →
   rewrite (file-only); daemon job absent from launchd → `launchctl enable`
   then `bootstrap` (a *different* label — safe).
4. Checkin: POST ~200B to `/watchdog-checkin` — `{device, daemon_pid_alive,
   heartbeat_age_runs, kills_recent, degraded, spool_pending}` — and execute
   any directive in the response (`restart`, `upload_logs`, `sample`,
   `upload_state`, `reinstall_watchdog`). Directives now reach machines whose
   daemon is wedged, crash-looping, or rolled back.
5. Drain the forensic spool (upload, then delete).
6. Self-cleanup: daemon plist AND daemon binary both gone (uninstalled by an
   old uninstaller) → remove own plist and bootout own label as the final
   act. This is the one sanctioned self-bootout: a one-shot job with no
   KeepAlive tree cannot strand itself.

Any non-200 on watchdog network calls is benign (old server, offline) — log
and continue.

## In-process layers (kept, demoted, cut)

- **Drift detector (kept):** each tick compares wall-elapsed vs expected
  sleep; overshoot past max(3x interval, 30 min) → log `clock_skew`, flush
  heartbeat, exit(75) with journal entry. (The 30-min floor keeps short naps
  from restarting the daemon at every wake; a long sleep DOES trigger it,
  deliberately — a fresh process at wake is the churn-reset that prevents
  the wedge from ever accumulating.) Catches *late-but-alive* timers, which
  the watchdog cannot see (a late tick still refreshes the heartbeat).
- **Lifetime recycling (demoted):** exit(75) after **7 days + 0–24h
  persisted per-machine jitter**, checked between ticks only, suppressed
  while `update_in_progress`, always journal-explained. (Directives cannot
  race it: they execute at the end of the iteration, before the next
  recycle check runs.) Hygiene against slow runtime rot; the watchdog is the
  actual wedge-killer.
- **Unconditional checkin (kept):** `/checkin` fires after *every* tick —
  success, quiet, or failure (previously only quiet ticks). Expanded body:
  `{uptime_s, tick_seq, boot_count, consec_failures, last_error,
  last_update_result, disk_free_mb, drift_ms, exit_journal_tail}`. Old
  servers ignore unknown fields; the body stays optional for old daemons.
- **In-process watchdog threads / self-ping servers (cut):** observability
  theater — same failure domain, rejected on principle.

## Server: fleet classification and remote heal

- **`/watchdog-checkin`** (new): authenticated like `/checkin` (existing
  device secrets), records `watchdog_last_seen` per device, returns pending
  directives.
- **Per-device directives:** `pending_directives` gains a nullable
  `device_id`; handout matches `(username, device_id-or-NULL)`. An
  **executed-ack** (directive id + result + device) is what completes a
  directive; `delivered_at` alone no longer counts — undelivered or un-acked
  directives re-queue on TTL. New daemon verb: `reinstall_watchdog`
  (enable → bootstrap, idempotent).
- **Checkin history:** append table (capped per device) rather than
  overwritten columns — cadence is diagnosable after the fact.
- **Classification (version-aware):** HEALTHY / LATE / WEDGED /
  CRASH-LOOPING / DEGRADED / DARK / UNINSTALLED. Watchdog-silence states
  (WEDGED, dual-channel DARK) apply **only** to devices that have ever sent a
  watchdog checkin; pre-0.6 devices classify on `last_seen` alone. A
  `HEARTBEAT_IO` state (daemon checkins fresh + watchdog reports stale
  heartbeat) alerts and never kills — that contradiction is a disk problem,
  not a wedge. Crash-loop detection consumes the exit journal.
- **Alerting:** staleness sweep flags WEDGED/DEGRADED/DARK > 1h; pushes to a
  Slack webhook when `TOKENLEADER_ALERT_WEBHOOK` is set; auto-queues the
  appropriate heal directive. A fleet-wide suppression toggle
  (`TOKENLEADER_ALERT_SUPPRESS=1`) exists for planned rollbacks.
- **Forensics per device:** `diag_logs` keyed by (user, device) — two
  laptops no longer overwrite each other. Failed-auth (403) attempts are
  logged per device so TOFU-secret loss leaves a trace.
- **Admin:** `mark-uninstalled` route ends eternal-stale-row noise.

## Update-path hardening

- `.prev` is created by **hardlinking the old inode before the single atomic
  rename** — there is never a moment without a complete binary at execPath.
- The `.watchdog` hardlink is refreshed (ln -f, argv array, same filesystem)
  at every daemon boot.
- First update check runs **before** the first tick — a boot-crasher gets a
  self-update window.
- The `swapping` marker is an advisory breadcrumb only (feeds forensics);
  no automated recovery keys off it. The swap itself is atomic; the only
  debris is a partial `<execPath>.new`, unlinked at boot.
- Binary downloads stay on curl permanently (Bun #11761). Daemon plist gains
  `StandardOutPath: /dev/null` via file-only heal (the jsonl sink is the
  durable copy; stdout.log previously grew unbounded).

## Migration (v0.5.x → v0.6.0)

Iron rules: **the daemon never boots out its own label; plist rewrites of a
loaded label are file-only (effective next login); all bootstraps are
`launchctl enable` first, argv arrays, "already loaded" treated as success,
pinned to `gui/$UID`.**

1. **Server deploys first** (backward compatible), *including both
   uninstaller fixes* — the served uninstall script must bootout both labels
   before any v0.6.0 daemon exists in the wild.
2. v0.6.0 publishes; healthy machines arrive via the normal swap →
   exit(75) → KeepAlive respawn.
3. **First boot (main() only — never runDaemon(), so tests and the CI gate
   can't touch launchd; skipped entirely under
   `TOKENLEADER_WATCHDOG_DISABLED=1`, which the update-gate sets):** write
   heartbeat → refresh `.watchdog` hardlink → write watchdog plist →
   `enable` → `bootstrap` (single attempt, < 2s, non-blocking, failure
   reported in checkin and retried next boot) → verify via `launchctl list`.
   A verified-absent watchdog after a successful-looking bootstrap+enable is
   reported as `watchdog_btm_disabled` (macOS Background Task Management
   toggle) — a human is alerted; there is no local heal for a user-disabled
   login item.
4. Server convergence check: any device with v0.6.0 checkins but no watchdog
   checkin within 10 min gets a `reinstall_watchdog` directive (per-device).
5. The 11 dead ≤ v0.5.4 machines get the one-liner **after** v0.6.0
   publishes (installs the final shape once; must run in a local Terminal,
   not SSH — `gui/$UID` needs a GUI session). The installer registers both
   labels with the same enable → bootstrap → verify ladder and single-sourced
   plist content.
6. **Rollback = roll forward.** Any emergency downgrade must be a 0.6.x build
   (old tick logic + watchdog role intact). Repointing the manifest to a
   pre-watchdog tag would exit-1 the watchdog every 120s fleet-wide and
   darken the second channel; if ever unavoidable, set the alert-suppression
   toggle first. Note: v0.6.0's arrival will show one "Background items
   added" notification per machine (BTM) — announced in the release notes.

## Known residual gaps (accepted, documented)

- **Hard-dead endpoint** (server URL gone): both channels ride the same URL.
  Non-goal for v0.6.0; would need a baked secondary well-known URL and its
  trust design.
- **Both labels booted out live** while the user stays logged in: nothing
  local revives until next login; the server alerts a human within ~1h.
- **TOFU secret loss** becomes visible (403 trace) but still ends in a human
  reinstall. Remote rebind is future work.
- **Machine off / user on vacation** is DARK until it returns — fundamental;
  the checkin history makes triage cheap, not automatic.
- **Hardened-runtime signing** (if ever adopted for notarization) breaks
  same-uid `sample` forensics — mutually exclusive; revisit then.

## Upstream

Our wedge signature is novel (nearest Bun issues are a 100%-CPU spin and two
Windows crashes). A full report goes to oven-sh/bun with the native sample
(kevent64 park, empty timer set, zero sockets), pmset DarkWake logs spanning
the death window, and the 19.5h monotonic-vs-wall delta, pointing at the
sleep-blind `CLOCK_MONOTONIC` timer deadlines (their in-flight timer refactor
keeps that clock and will not fix this). We do not bump the Bun build (1.3.14
is current stable); any future bump is gated on a release note naming a
sleep-aware timer fix.
