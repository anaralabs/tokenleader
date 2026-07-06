import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Exercises the plist-extraction logic in scripts/uninstall.sh without
// running the destructive bootout/rm tail: fixture plist + secret under a
// temp HOME, driven through the awk-only fallback (the path taken when
// /usr/libexec/PlistBuddy is missing — the only surface portable to CI).

const SCRIPT = resolve(import.meta.dir, "uninstall.sh");

const FIXTURE_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTD/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>sh.anara.leaderboard</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>TOKENLEADER_USER</key>
        <string>krish-fixture</string>
        <key>TOKENLEADER_ENDPOINT</key>
        <string>https://leaderboard.example.com</string>
    </dict>
</dict>
</plist>
`;

describe("scripts/uninstall.sh", () => {
  let tmpHome: string;
  let plistPath: string;
  let secretPath: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "tokenleader-uninst-script-"));
    mkdirSync(join(tmpHome, "Library", "LaunchAgents"), { recursive: true });
    mkdirSync(join(tmpHome, ".local", "share", "anara-leaderboard"), { recursive: true });
    plistPath = join(tmpHome, "Library", "LaunchAgents", "sh.anara.leaderboard.plist");
    secretPath = join(tmpHome, ".local", "share", "anara-leaderboard", "secret");
    writeFileSync(plistPath, FIXTURE_PLIST);
    writeFileSync(secretPath, "fixture-secret-deadbeef\n");
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test("awk fallback extracts TOKENLEADER_USER from the plist", () => {
    // Mirrors the exact awk one-liner used inside notify_server_uninstall().
    // If this regex ever drifts, the script silently falls back to "no
    // handle" and the dashboard never sees the uninstall event.
    const r = spawnSync(
      "awk",
      [
        '/<key>TOKENLEADER_USER<\\/key>/{getline; gsub(/.*<string>|<\\/string>.*/, ""); print; exit}',
        plistPath,
      ],
      { encoding: "utf8" },
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("krish-fixture");
  });

  test("script is valid bash syntax", () => {
    const r = spawnSync("bash", ["-n", SCRIPT], { encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  // Static assertions only for the launchctl/rm tail: executing it would
  // bootout the REAL labels in the developer's gui/$UID domain.
  test("boots out the watchdog label first, then the daemon", () => {
    // Watchdog first: its boot-time self-heal re-bootstraps an absent
    // daemon label — daemon-first invites a resurrection race. Must also
    // tolerate pre-v0.6.0 machines where no watchdog exists at all.
    const body = readFileSync(SCRIPT, "utf8");
    expect(body).toContain('WATCHDOG_LABEL="${LABEL}.watchdog"');
    const wdBootout = body.indexOf('launchctl bootout "$DOMAIN/$WATCHDOG_LABEL"');
    const daemonBootout = body.indexOf('launchctl bootout "$DOMAIN/$LABEL"');
    expect(wdBootout).toBeGreaterThan(0);
    expect(daemonBootout).toBeGreaterThan(wdBootout);
    expect(body).toContain("pre-v0.6.0 install, or already gone");
  });

  test("removes both plists, the .watchdog hardlink and the tokenleader symlink", () => {
    const body = readFileSync(SCRIPT, "utf8");
    expect(body).toContain('WATCHDOG_PLIST="$HOME/Library/LaunchAgents/${WATCHDOG_LABEL}.plist"');
    expect(body).toContain('BIN_WATCHDOG="$BIN.watchdog"');
    expect(body).toContain('rm -f "$WATCHDOG_PLIST"');
    expect(body).toContain('rm -f "$PLIST"');
    expect(body).toContain('rm -f "$BIN"');
    expect(body).toContain('rm -f "$BIN_WATCHDOG"');
    // Symlink removal is guarded: only ever an actual symlink, never a
    // real file that owns the name.
    expect(body).toContain('if [ -L "$HOME/.local/bin/tokenleader" ]; then');
    expect(body).toContain('rm -f "$HOME/.local/bin/tokenleader"');
  });
});
