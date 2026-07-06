// Daemon-side install of the watchdog pair (docs/resilience.md, migration
// step 3). Called from main() ONLY — never runDaemon() — so unit tests and
// the CI update-gate (TOKENLEADER_WATCHDOG_DISABLED=1) can never touch a
// real launchd. Split from watchdog.ts: that file is the one-shot RUN side;
// this one is the installer the daemon executes at boot.

import {
  copyFileSync,
  existsSync,
  linkSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Logger } from "./log";
import {
  DAEMON_LABEL,
  defaultExec,
  type Exec,
  labelLoaded,
  WATCHDOG_INTERVAL_SEC,
  WATCHDOG_LABEL,
} from "./watchdog";

// --- daemon-side install (called from main() only — never runDaemon(), so
// tests and the CI update-gate can never touch a real launchd) ------------------

/**
 * Renders the watchdog LaunchAgent plist. MUST stay byte-converged with
 * render_watchdog_plist in scripts/plist-templates.sh (single-sourced shape;
 * the installer and this renderer write identical bytes so the mutual
 * missing/corrupt heal never fights the installer's copy).
 */
export function renderWatchdogPlist(home: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTD/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${WATCHDOG_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${home}/.local/bin/anara-leaderboard.watchdog</string>
        <string>watchdog</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>${home}</string>
        <key>PATH</key>
        <string>${home}/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
    <!-- One-shot checker on launchd's clock: StartInterval fires while awake
         (collided/asleep firings are dropped, never queued) and RunAtLoad
         covers login. Deliberately NO KeepAlive - the watchdog must stay a
         short-lived one-shot; a resident copy would share the daemon's
         wedgeable-runtime failure domain. -->
    <key>RunAtLoad</key>
    <true/>
    <key>StartInterval</key>
    <integer>${WATCHDOG_INTERVAL_SEC}</integer>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>${home}/Library/Logs/anara-leaderboard/watchdog.log</string>
    <key>StandardErrorPath</key>
    <string>${home}/Library/Logs/anara-leaderboard/watchdog.log</string>
</dict>
</plist>
`;
}

export type WatchdogInstallStatus = "installed" | "already" | "failed" | "btm_disabled" | "skipped";

export interface EnsureDeps {
  home?: string;
  exec?: Exec;
  execPath?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * First-boot duties from the daemon (idempotent, best-effort, hard-capped —
 * each launchctl call has a short timeout and one attempt; a failure is
 * reported in the next checkin and retried next boot):
 *   refresh the .watchdog hardlink → snapshot our plist for mutual heal →
 *   write the watchdog plist → enable → bootstrap → verify.
 * Skipped entirely under TOKENLEADER_WATCHDOG_DISABLED=1 (CI update-gate,
 * tests) and when the daemon plist doesn't exist (dev / env-run daemons).
 */
export function ensureWatchdogInstalled(
  log: Logger,
  stateDir: string,
  deps: EnsureDeps = {},
): WatchdogInstallStatus {
  const env = deps.env ?? process.env;
  if (env.TOKENLEADER_WATCHDOG_DISABLED === "1") return "skipped";
  if (process.platform !== "darwin" && !deps.exec) return "skipped";
  const home = deps.home ?? homedir();
  const exec = deps.exec ?? defaultExec;
  const daemonPlist = path.join(home, "Library", "LaunchAgents", `${DAEMON_LABEL}.plist`);
  if (!existsSync(daemonPlist)) return "skipped";

  const uid = process.getuid?.() ?? 501;
  const execPath = deps.execPath ?? process.execPath;
  const binDir = path.join(home, ".local", "bin");
  const hardlink = path.join(binDir, "anara-leaderboard.watchdog");

  // 1. Hardlink refresh: the watchdog's spawnability must not share fate with
  // the daemon binary (deletion, rollback to a pre-watchdog version).
  try {
    // Exact-path equality, not basename: a manually-run compiled dev build
    // elsewhere on disk must never hijack the production watchdog hardlink.
    if (execPath === path.join(binDir, "anara-leaderboard")) {
      try {
        unlinkSync(hardlink);
      } catch {}
      linkSync(execPath, hardlink);
    }
  } catch (err: unknown) {
    log.warn("watchdog_hardlink_failed", { err: String((err as Error)?.message ?? err) });
  }

  // 2. Snapshot our own plist so the watchdog can restore it if it vanishes.
  try {
    copyFileSync(daemonPlist, path.join(stateDir, "daemon.plist.bak"));
  } catch {
    // mutual heal loses its source; non-fatal
  }

  // 3. Plist write (only when content drifted — keeps mtime stable).
  const plistPath = path.join(home, "Library", "LaunchAgents", `${WATCHDOG_LABEL}.plist`);
  const want = renderWatchdogPlist(home);
  let drifted = true;
  try {
    drifted = readFileSync(plistPath, "utf8") !== want;
  } catch {
    // missing — write below
  }
  if (drifted) {
    try {
      writeFileSync(`${plistPath}.new`, want, { mode: 0o600 });
      renameSync(`${plistPath}.new`, plistPath);
    } catch (err: unknown) {
      log.warn("watchdog_plist_write_failed", { err: String((err as Error)?.message ?? err) });
      return "failed";
    }
  }

  // 4. enable (clears stale disable records — the phantom-record lesson from
  // the installer) then bootstrap; "already bootstrapped" is success.
  exec("launchctl", ["enable", `gui/${uid}/${WATCHDOG_LABEL}`], 2_000);
  const alreadyLoaded = labelLoaded(exec, uid, WATCHDOG_LABEL);
  if (!alreadyLoaded) {
    const b = exec("launchctl", ["bootstrap", `gui/${uid}`, plistPath], 2_000);
    if (!b.ok && !/already|in progress|37/.test(b.err ?? "")) {
      // 5. Verify: a bootstrap that "succeeded" but left no registration is
      // the Background Task Management disable toggle — no local heal exists;
      // report so a human gets alerted.
      if (!labelLoaded(exec, uid, WATCHDOG_LABEL)) {
        log.warn("watchdog_bootstrap_failed", { err: b.err });
        return "failed";
      }
    }
  }
  if (!labelLoaded(exec, uid, WATCHDOG_LABEL)) {
    log.warn("watchdog_btm_disabled", {});
    return "btm_disabled";
  }
  log.info("watchdog_installed", { plist: plistPath, alreadyLoaded });
  return alreadyLoaded ? "already" : "installed";
}
