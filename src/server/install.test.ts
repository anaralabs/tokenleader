import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { makeTmpDirSync } from "../test-helpers.ts";
import { renderInstallScript, renderUninstallScript } from "./install-script.ts";

// These tests cover the installer renderer + the uninstaller:
//   * renderInstallScript   — server-self-hosted; served at /install and
//                             baked into the install.sh release asset.
//                             curl-fetches manifest.json + the binary off
//                             the server's own BinaryMirror cache and
//                             verifies the sha256 before swapping.
//   * renderUninstallScript — same uninstall flow regardless of install path.

const SERVER_URL = "https://leaderboard.example.com";

let tmpDir: string;
let rmTmpDir: () => void;

beforeAll(() => {
  ({ dir: tmpDir, cleanup: rmTmpDir } = makeTmpDirSync("tokenleader-install-test-"));
});

afterAll(() => {
  rmTmpDir();
});

/** Pull one shell function out of the rendered script so a test can RUN it
 *  with stubs, instead of grepping for the strings it contains. */
function extractFn(body: string, name: string): string {
  const start = body.indexOf(`${name}() {`);
  expect(start).toBeGreaterThan(0);
  const end = body.indexOf("\n}\n", start);
  expect(end).toBeGreaterThan(start);
  return body.slice(start, end + 2);
}

/** Run the shipped register_systemd_unit (+ its rollback) against real files,
 *  with systemctl stubbed. `enableStatus` is what `enable --now` returns. */
function runSystemdRegister(opts: {
  otherUnitPath: string;
  unitPath: string;
  enableStatus: number;
}): { status: number; stdout: string; calls: string } {
  const body = renderInstallScript(SERVER_URL);
  // The stubs log to a FILE, not stdout: the shipped code redirects
  // systemctl output to /dev/null, and a test that can't see the rollback
  // calls is the test that let the crash-loop ship.
  const callLog = join(mkdtempSync(join(tmpDir, "calls-")), "systemctl.log");
  const script = [
    `CALL_LOG=${JSON.stringify(callLog)}`,
    "set -uo pipefail",
    "step_start(){ :; }",
    "step_ok(){ :; }",
    `step_fail(){ printf 'STEP_FAIL: %s\\n' "$1"; exit 17; }`,
    `user_systemctl(){ printf 'user_systemctl %s\\n' "$*" >>"$CALL_LOG"; return 0; }`,
    `systemctl_do(){ printf 'systemctl_do %s\\n' "$*" >>"$CALL_LOG"; case "$*" in "enable --now "*) return ${opts.enableStatus} ;; esac; return 0; }`,
    'SUDO=""',
    "SERVICE_SCOPE=user",
    "SERVICE_USER=wing",
    "UNIT=tokenleader.service",
    `OTHER_UNIT_PATH=${JSON.stringify(opts.otherUnitPath)}`,
    `UNIT_PATH=${JSON.stringify(opts.unitPath)}`,
    `SERVER_URL=${JSON.stringify(SERVER_URL)}`,
    'BIN_DST="/home/wing/.local/bin/anara-leaderboard"',
    extractFn(body, "register_systemd_unit"),
    extractFn(body, "rollback_systemd_unit"),
    "register_systemd_unit",
  ].join("\n");
  const r = spawnSync("bash", ["-c", script], { encoding: "utf8" });
  return {
    status: r.status ?? -1,
    stdout: `${r.stdout}${r.stderr}`,
    calls: existsSync(callLog) ? readFileSync(callLog, "utf8") : "",
  };
}

describe("renderInstallScript", () => {
  test("starts with #!/usr/bin/env bash and contains the server URL", () => {
    const body = renderInstallScript(SERVER_URL);
    expect(body.startsWith("#!/usr/bin/env bash")).toBe(true);
    expect(body).toContain(SERVER_URL);
  });

  test("does NOT require gh CLI at runtime", () => {
    const body = renderInstallScript(SERVER_URL);
    // The script may mention gh in a comment, but it must never invoke
    // `command -v gh` / `gh auth status` / `gh release download`. Strip
    // comments first to verify.
    const noComments = body
      .split("\n")
      .map((line) => line.replace(/(^|\s)#.*$/, ""))
      .join("\n");
    expect(noComments).not.toMatch(/\bcommand\s+-v\s+gh\b/);
    expect(noComments).not.toMatch(/\bgh\s+auth\s+status\b/);
    expect(noComments).not.toMatch(/\bgh\s+release\s+download\b/);
    expect(noComments).not.toContain("brew install gh");
  });

  test("sed fallback parses a PRETTY-PRINTED manifest without python3 (Laia repro)", () => {
    // Regression: macOS without Xcode CLT has no python3, so the install
    // falls to the sed parse. The server serves a pretty-printed manifest
    // ("sha256": "…" with a space), which the old compact-only regex missed,
    // yielding "couldn't parse sha256 for arm64 out of manifest.json".
    const body = renderInstallScript(SERVER_URL);
    expect(body).toContain("[[:space:]]*:[[:space:]]*");

    // Pull the actual sed expression the script ships and run it against a
    // pretty-printed manifest, exactly as the python3-less path would.
    const m = body.match(/\| sed -E "(.+?)" /);
    expect(m).not.toBeNull();
    const sedExpr = m![1]!;
    const sha = "a".repeat(64);
    const prettyManifest = JSON.stringify(
      {
        schemaVersion: 2,
        version: "v9.9.9",
        platforms: { "darwin-arm64": { sha256: sha } },
        arm64: { sha256: sha },
        x64: { sha256: "b".repeat(64) },
      },
      null,
      2,
    );
    const mPath = join(tmpDir, "pretty-manifest.json");
    writeFileSync(mPath, prettyManifest);
    const harness =
      "ASSET_KEY=arm64\n" +
      `expected_sha="$(tr -d '\\n\\r' < "${mPath}" | sed -E "${sedExpr}" | grep -E '^[0-9a-fA-F]{64}$' || true)"\n` +
      'printf "%s" "$expected_sha"';
    const r = spawnSync("bash", ["-c", harness], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(sha);
  });

  test("downloads the binary from the server's own /bin route via curl", () => {
    const body = renderInstallScript(SERVER_URL);
    expect(body).toContain('BINARY_BASE_URL="${TOKENLEADER_BINARY_URL:-$SERVER_URL/bin}"');
    expect(body).toContain('arch_asset="anara-leaderboard-$ASSET_KEY"');
    expect(body).toContain('"$BINARY_BASE_URL/$arch_asset"');
    expect(body).toMatch(/curl\s+-#fL/);
    // No external CDN / R2 bucket baked in.
    expect(body).not.toContain("r2.dev");
  });

  test("verifies the binary sha256 against the server's manifest.json", () => {
    const body = renderInstallScript(SERVER_URL);
    expect(body).toContain('"$SERVER_URL/manifest.json"');
    expect(body).toContain("shasum -a 256");
    expect(body).toContain("sha256 mismatch");
    // Manifest fetch must come before the binary download so a sha is in
    // hand before any bytes are trusted.
    const manifestIdx = body.indexOf("$SERVER_URL/manifest.json");
    const binIdx = body.indexOf("curl -#fL");
    expect(manifestIdx).toBeGreaterThan(0);
    expect(binIdx).toBeGreaterThan(manifestIdx);
  });

  test("Intel maps to the x64 manifest key / asset suffix", () => {
    const body = renderInstallScript(SERVER_URL);
    // The manifest's keys are arm64/x64 (NOT x86_64); ASSET_KEY doubles
    // as the manifest key, so the x86_64 uname must map to "x64".
    expect(body).toContain('x86_64) ASSET_KEY="x64"');
  });

  test("does NOT mention TOKENLEADER_TOKEN or any bearer-token wording", () => {
    const body = renderInstallScript(SERVER_URL);
    expect(body).not.toContain("TOKENLEADER_TOKEN");
    expect(body.toLowerCase()).not.toContain("bearer token");
  });

  test("rendered script is valid bash syntax", () => {
    const body = renderInstallScript(SERVER_URL);
    const tmpScript = join(tmpDir, "rendered-install.sh");
    writeFileSync(tmpScript, body);
    const r = spawnSync("bash", ["-n", tmpScript], { encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  test("no handle → aborts with the flag-form command; never guesses from $USER", () => {
    // The handle is the leaderboard identity. `VAR=… curl … | bash` drops
    // the env var on curl (it never crosses the pipe), which used to fall
    // back to $USER and register junk handles like a full unix username.
    const body = renderInstallScript(SERVER_URL);
    expect(body).toContain("must be explicit");
    expect(body).toContain("--name=your-handle");
    // The old fallback is gone from the script entirely.
    expect(body).not.toContain("${USER:-");

    // Execute the abort path for real where the platform check allows it
    // (the script exits earlier on non-macOS runners).
    if (process.platform === "darwin") {
      const tmpScript = join(tmpDir, "no-name-install.sh");
      writeFileSync(tmpScript, body);
      const env = { ...process.env };
      delete env.TOKENLEADER_USER;
      const r = spawnSync("bash", [tmpScript], { encoding: "utf8", env });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("--name=your-handle");
      expect(r.stderr).toContain("must be explicit");
    }
  });

  test("has the polished UX bits the team expects", () => {
    const body = renderInstallScript(SERVER_URL);
    expect(body).toContain("tokenleader installer");
    // Numbered step prefix; steps start at [2/N] (there is no name step).
    expect(body).toContain("[2/");
    // No interactive prompts -- handle comes from --name/env, or the
    // installer aborts (a $USER-derived handle registered junk identities).
    expect(body).not.toContain('read -r -p "  > "');
    expect(body).toContain("--name=");
    expect(body).toContain("resolve_handle");
    expect(body).toContain("tick_done");
    expect(body).toContain("endpoint");
    expect(body).toContain("platform");
    expect(body).toContain("installing");
    expect(body).toContain("installed as");
    expect(body).toContain("uninstall");
  });

  test("tolerates being piped through bash (no /dev/tty, no `read -r`)", () => {
    const body = renderInstallScript(SERVER_URL);
    expect(body).not.toContain("exec </dev/tty");
    expect(body).not.toMatch(/\bread -r\b/);
    const r = spawnSync("bash", ["-n"], { input: body, encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  test("--join flag is parsed and forwarded into the plist as TOKENLEADER_JOIN", () => {
    const body = renderInstallScript(SERVER_URL);
    // Flag + env fallback parsing.
    expect(body).toContain("--join=*)");
    expect(body).toContain('JOIN_CODE="${ARG_JOIN:-${TOKENLEADER_JOIN:-}}"');
    // Conditional plist entry: key only exists when a code was provided.
    expect(body).toContain("<key>TOKENLEADER_JOIN</key>");
    expect(body).toContain("<string>$JOIN_CODE</string>");
    expect(body).toContain('if [ -n "$JOIN_CODE" ]; then');
  });

  test("--company flag is parsed and forwarded into the plist as TOKENLEADER_COMPANY", () => {
    const body = renderInstallScript(SERVER_URL);
    // Flag (both --company=X and --company X forms) + env fallback parsing.
    expect(body).toContain("--company=*)");
    expect(body).toContain('--company)    ARG_COMPANY="${2:-}"; shift ;;');
    expect(body).toContain('COMPANY="${ARG_COMPANY:-${TOKENLEADER_COMPANY:-}}"');
    // Conditional plist entry: the TOKENLEADER_COMPANY line exists only when
    // a (non-empty) value was provided; absent otherwise.
    expect(body).toContain('if [ -n "$COMPANY" ]; then');
    expect(body).toContain("<key>TOKENLEADER_COMPANY</key>");
    expect(body).toContain("<string>$COMPANY</string>");
    const guardIdx = body.indexOf('if [ -n "$COMPANY" ]; then');
    const keyIdx = body.indexOf("<key>TOKENLEADER_COMPANY</key>");
    expect(guardIdx).toBeGreaterThan(0);
    expect(keyIdx).toBeGreaterThan(guardIdx);
    // Advertised in --help.
    expect(body).toContain("--company=DOMAIN");
    // Still valid bash.
    const r = spawnSync("bash", ["-n"], { input: body, encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  test("--link flag is parsed and forwarded into the plist as TOKENLEADER_LINK", () => {
    const body = renderInstallScript(SERVER_URL);
    // Flag (both --link=X and --link X forms) + env fallback parsing.
    expect(body).toContain("--link=*)");
    expect(body).toContain('--link)       ARG_LINK="${2:-}"; shift ;;');
    expect(body).toContain('LINK_CODE="${ARG_LINK:-${TOKENLEADER_LINK:-}}"');
    // Conditional plist entry, same shape as join/company.
    expect(body).toContain('if [ -n "$LINK_CODE" ]; then');
    expect(body).toContain("<key>TOKENLEADER_LINK</key>");
    expect(body).toContain("<string>$LINK_CODE</string>");
    // Advertised in --help.
    expect(body).toContain("--link=CODE");
    // Still valid bash.
    const r = spawnSync("bash", ["-n"], { input: body, encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  test("installs the documented `tokenleader` CLI name as a guarded symlink", () => {
    const body = renderInstallScript(SERVER_URL);
    expect(body).toContain('ln -sfn "$BIN_DST" "$TARGET_HOME/.local/bin/tokenleader"');
    // Never clobbers a real (non-symlink) file that owns the name.
    expect(body).toContain(
      'if [ ! -e "$TARGET_HOME/.local/bin/tokenleader" ] || [ -L "$TARGET_HOME/.local/bin/tokenleader" ]; then',
    );
  });

  test("joinRequired advertises --join=<code> in the one-liner and warns when missing", () => {
    const gated = renderInstallScript(SERVER_URL, { joinRequired: true });
    expect(gated).toContain("| bash -s -- --join=<code>");
    expect(gated).toContain("requires a join code for NEW handles");
    // Still valid bash with the extra block.
    const r = spawnSync("bash", ["-n"], { input: gated, encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);

    const open = renderInstallScript(SERVER_URL);
    expect(open).not.toContain("| bash -s -- --join=<code>");
    expect(open).not.toContain("requires a join code for NEW handles");
  });

  test("registers the v0.6.0 watchdog pair: hardlink, plist, then same launchctl discipline", () => {
    const body = renderInstallScript(SERVER_URL);
    // Derived label + plist path, pinned beside the daemon's.
    expect(body).toContain('WATCHDOG_LABEL="${LABEL}.watchdog"');
    expect(body).toContain('WATCHDOG_PLIST="$HOME/Library/LaunchAgents/${WATCHDOG_LABEL}.plist"');
    // Hardlink (same filesystem, force-replace) — the plist must point at
    // the .watchdog HARDLINK, never the daemon binary, so a deleted or
    // rolled-back daemon binary can't take the watchdog down with it.
    expect(body).toContain('ln -f "$BIN_DST" "$BIN_DST.watchdog"');
    expect(body).toContain("<string>${HOME}/.local/bin/anara-leaderboard.watchdog</string>");
    expect(body).toContain("<string>watchdog</string>");
    // Both labels go through the ONE registration function (bootout +
    // disappearance wait + enable + bootstrap retries + print verify).
    expect(body).toContain('register_launch_agent "$LABEL" "$PLIST"');
    expect(body).toContain('register_launch_agent "$WATCHDOG_LABEL" "$WATCHDOG_PLIST"');
    expect(body).toContain("for _i in 1 2 3 4 5 6 7 8 9 10; do");
    expect(body).toContain('launchctl enable "$DOMAIN/$label"');
    // Verdict is `launchctl print` (loaded?), not bootstrap's exit code —
    // "already loaded" on a half-installed machine counts as success.
    expect(body).toContain('launchctl print "$DOMAIN/$label" >/dev/null 2>&1\n}');
    // Main flow order: daemon registered, then watchdog, then start.
    expect(body).toContain(
      "  write_plist_and_register\n  write_watchdog_plist_and_register\n  wait_for_first_tick",
    );
    // A watchdog registration failure warns; only the daemon path is fatal.
    expect(body).toContain("watchdog not registered (daemon retries at every boot");
  });

  test("watchdog plist: StartInterval+RunAtLoad one-shot, no KeepAlive, single log file", () => {
    const body = renderInstallScript(SERVER_URL);
    const m = body.match(/<<WATCHDOG_PLIST_EOF\n([\s\S]*?)\nWATCHDOG_PLIST_EOF/);
    expect(m).not.toBeNull();
    const plist = m![1]!;
    expect(plist).toContain("<string>sh.anara.leaderboard.watchdog</string>");
    expect(plist).toContain("<key>StartInterval</key>");
    expect(plist).toContain("<integer>120</integer>");
    expect(plist).toContain("<key>RunAtLoad</key>");
    // NEVER a KeepAlive key: launchd drops (never queues) collided/asleep
    // StartInterval firings — the watchdog is a one-shot, and a resident
    // copy would share the daemon's wedgeable-runtime failure domain. (The
    // XML *comment* explaining this contains the word, hence the key match.)
    expect(plist).not.toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<key>ProcessType</key>");
    // stdout and stderr share one watchdog.log.
    const logRefs = plist.match(/watchdog\.log<\/string>/g) ?? [];
    expect(logRefs.length).toBe(2);
    // HOME + PATH env like the daemon plist.
    expect(plist).toContain("<key>HOME</key>");
    expect(plist).toContain("<key>PATH</key>");
  });

  test("installer watchdog plist is byte-identical to render_watchdog_plist (plist-templates.sh)", () => {
    // The daemon's own ensure-plist renderer (src/daemon/watchdog.ts) is
    // byte-converged to this same XML; if the two installer-side renderers
    // drift from each other, that three-way contract is already broken.
    const body = renderInstallScript(SERVER_URL);
    const m = body.match(/<<WATCHDOG_PLIST_EOF\n([\s\S]*?)\nWATCHDOG_PLIST_EOF/);
    expect(m).not.toBeNull();
    const fixtureHome = "/Users/fixture";

    // Expand the installer's heredoc exactly as the installer would.
    const harness = `HOME="${fixtureHome}"\ncat <<WATCHDOG_PLIST_EOF\n${m![1]!}\nWATCHDOG_PLIST_EOF\n`;
    const fromInstaller = spawnSync("bash", ["-c", harness], { encoding: "utf8" });
    expect(fromInstaller.status).toBe(0);

    const templates = join(import.meta.dir, "..", "..", "scripts", "plist-templates.sh");
    const fromTemplates = spawnSync(
      "bash",
      ["-c", `source "${templates}"; render_watchdog_plist "${fixtureHome}"`],
      { encoding: "utf8" },
    );
    expect(fromTemplates.status).toBe(0);
    expect(fromInstaller.stdout).toBe(fromTemplates.stdout);

    // Execution assertion where the platform allows it: the converged XML
    // must satisfy plutil (comments included).
    if (process.platform === "darwin") {
      const plistPath = join(tmpDir, "watchdog-converged.plist");
      writeFileSync(plistPath, fromTemplates.stdout);
      const lint = spawnSync("plutil", ["-lint", plistPath], { encoding: "utf8" });
      expect(lint.status).toBe(0);
    }
  });

  test("teamName renders into the banner subtitle (sanitized)", () => {
    const branded = renderInstallScript(SERVER_URL, { teamName: "acme" });
    expect(branded).toContain("acme team token-usage leaderboard");

    const plain = renderInstallScript(SERVER_URL);
    expect(plain).toContain("team token-usage leaderboard");
    expect(plain).not.toContain("acme team");

    // printf-format metacharacters are stripped, not interpolated.
    const hostile = renderInstallScript(SERVER_URL, { teamName: 'ac"me%s$x`' });
    expect(hostile).toContain("acmesx team token-usage leaderboard");
    const r = spawnSync("bash", ["-n"], { input: hostile, encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });
});

// The Linux branch. Everything here is a regression guard for a failure the
// port already produced once, in Docker against real systemd 252, or for a
// stanza whose absence silently strands a fleet.
describe("renderInstallScript — Linux branch", () => {
  test("dispatches on uname -s instead of refusing every non-Darwin machine", () => {
    const body = renderInstallScript(SERVER_URL);
    // The exact string from the bug report must be gone.
    expect(body).not.toContain("tokenleader only supports macOS");
    expect(body).toContain('  Darwin) TL_OS="darwin" ;;');
    expect(body).toContain('  Linux)  TL_OS="linux" ;;');
    // …but a third platform is still refused, clearly.
    expect(body).toContain('die "tokenleader supports macOS and Linux. Detected: $OS_NAME."');
  });

  test("Linux arch map accepts aarch64 (every ARM VPS reports it, never arm64)", () => {
    const body = renderInstallScript(SERVER_URL);
    expect(body).toContain('aarch64|arm64) ASSET_KEY="linux-arm64"');
    expect(body).toContain('x86_64|amd64)  ASSET_KEY="linux-x64"');
    // The darwin arm mapping stays the bare arch (frozen /bin + manifest key).
    expect(body).toContain('arm64)  ASSET_KEY="arm64"');
  });

  test("Linux resolves its sha from manifest.platforms, not the darwin legacy keys", () => {
    // The blocker: reading manifest["arm64"] on Linux resolves the DARWIN
    // entry, so the installer would sha-check a Mach-O. Run the shipped sed
    // expression against a production-shaped manifest and require it to pick
    // the linux entry, distinct from every darwin one.
    const body = renderInstallScript(SERVER_URL);
    const m = body.match(/\| sed -E "(.+?)" /);
    expect(m).not.toBeNull();
    const sedExpr = m![1]!;
    const linuxSha = "1".repeat(64);
    const manifest = JSON.stringify(
      {
        schemaVersion: 2,
        version: "v9.9.9",
        platforms: {
          "darwin-arm64": { sha256: "a".repeat(64) },
          "darwin-x64": { sha256: "b".repeat(64) },
          "linux-x64": { sha256: "c".repeat(64) },
          "linux-arm64": { sha256: linuxSha },
        },
        arm64: { sha256: "a".repeat(64) },
        x64: { sha256: "b".repeat(64) },
      },
      null,
      2,
    );
    const mPath = join(tmpDir, "v2-manifest.json");
    writeFileSync(mPath, manifest);
    const run = (key: string): string => {
      const harness =
        `ASSET_KEY=${key}\n` +
        `expected_sha="$(tr -d '\\n\\r' < "${mPath}" | sed -E "${sedExpr}" | grep -E '^[0-9a-fA-F]{64}$' || true)"\n` +
        'printf "%s" "$expected_sha"';
      const r = spawnSync("bash", ["-c", harness], { encoding: "utf8" });
      expect(r.status).toBe(0);
      return r.stdout;
    };
    expect(run("linux-arm64")).toBe(linuxSha);
    expect(run("linux-x64")).toBe("c".repeat(64));
    // The frozen darwin keys still resolve to the TOP-LEVEL entries — the
    // leading quote is what stops "x64" matching inside "darwin-x64".
    expect(run("arm64")).toBe("a".repeat(64));
    expect(run("x64")).toBe("b".repeat(64));
  });

  test("systemd unit carries the exact four stanzas that keep a daemon alive", () => {
    const body = renderInstallScript(SERVER_URL);
    const m = body.match(/<<UNIT_EOF\n([\s\S]*?)\nUNIT_EOF/);
    expect(m).not.toBeNull();
    const unit = m![1]!;
    // Directives only — the comments deliberately NAME the forbidden values
    // in order to explain why they are forbidden.
    const directives = unit
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .join("\n");
    // launchd KeepAlive:true parity. on-failure + SuccessExitStatus=75 means
    // the daemon NEVER returns from an update; on-success would not respawn a
    // crash. Only `always` is correct.
    expect(directives).toContain("\nRestart=always\n");
    expect(directives).not.toContain("Restart=on-failure");
    expect(directives).not.toContain("Restart=on-success");
    // launchd ThrottleInterval=30 parity.
    expect(directives).toContain("\nRestartSec=30\n");
    // The deliberate post-update / directive exit, so the journal reads
    // "Deactivated successfully" instead of a crash.
    expect(directives).toContain("\nSuccessExitStatus=75\n");
    // THE one that prevents the Linux repeat of the v0.5.x fleet-stuck
    // incident: systemd's default 5-starts-per-10s limit latches the unit
    // into `failed` FOREVER, and there is no watchdog on Linux to recover it.
    expect(directives).toContain("\nStartLimitIntervalSec=0\n");
    // It has to live in [Unit]; systemd ignores it in [Service].
    const unitSection = directives.slice(
      directives.indexOf("[Unit]"),
      directives.indexOf("[Service]"),
    );
    expect(unitSection).toContain("StartLimitIntervalSec=0");
    // Type=notify would never finish starting (no READY=1); WatchdogSec=
    // would SIGABRT a daemon that does not ping.
    expect(directives).toContain("Type=exec");
    expect(directives).not.toContain("Type=notify");
    expect(directives).not.toContain("WatchdogSec=");
  });

  test("system unit uses absolute paths and the user unit uses %h", () => {
    const body = renderInstallScript(SERVER_URL);
    // %h in a SYSTEM unit resolves to the service MANAGER's home (/root),
    // not User='s — so it may only appear in the user-scope body.
    expect(body).toContain('unit_body="User=$SERVICE_USER');
    expect(body).toContain("ExecStart=$TARGET_HOME/.local/bin/anara-leaderboard");
    expect(body).toContain('unit_body="WorkingDirectory=%h');
    expect(body).toContain("ExecStart=%h/.local/bin/anara-leaderboard");
    expect(body).toContain("WantedBy=$wanted_by");
    expect(body).toContain('local wanted_by="multi-user.target"');
    expect(body).toContain('if [ "$SERVICE_SCOPE" = "user" ]; then wanted_by="default.target"; fi');
  });

  test("identity lives in an EnvironmentFile, and never carries the dead TOKENLEADER_HOME key", () => {
    const body = renderInstallScript(SERVER_URL);
    expect(body).toContain('ENV_FILE="$STATE_DIR/daemon.env"');
    expect(body).toContain("EnvironmentFile=$ENV_FILE");
    expect(body).toContain(`printf 'TOKENLEADER_USER=%s\\n' "$USER_NAME"`);
    expect(body).toContain(`printf 'TOKENLEADER_ENDPOINT=%s\\n' "$SERVER_URL"`);
    expect(body).toContain(`printf 'TOKENLEADER_JOIN=%s\\n' "$JOIN_CODE"`);
    expect(body).toContain(`printf 'TOKENLEADER_COMPANY=%s\\n' "$COMPANY"`);
    expect(body).toContain(`printf 'TOKENLEADER_LINK=%s\\n' "$LINK_CODE"`);
    // Secrets-adjacent; the CLI reads it as the user.
    expect(body).toContain('chmod 600 "$tmp_env"');
    // TOKENLEADER_HOME is read NOWHERE in src/ and disagrees with
    // TOKENLEADER_STATE_DIR — it may stay in the frozen plist, never in the
    // env file.
    const envBlock = body.slice(
      body.indexOf("local tmp_env="),
      body.indexOf('chmod 600 "$tmp_env"'),
    );
    expect(envBlock).not.toContain("TOKENLEADER_HOME");
  });

  test("every refusal happens BEFORE the download, so no half-install is possible", () => {
    const body = renderInstallScript(SERVER_URL);
    // sd_booted(3): systemctl can exist while systemd is not PID 1.
    expect(body).toContain("if [ ! -d /run/systemd/system ]; then");
    expect(body).toContain("systemd is not running as init here");
    // musl: the glibc binary fails there as a mystifying "not found".
    expect(body).toContain(
      "ls /lib/ld-musl-* >/dev/null 2>&1 || ldd --version 2>&1 | grep -qi musl",
    );
    expect(body).toContain("the published binary is glibc-only");
    // curl is a RUNTIME dep of the updater, not just an install-time one.
    expect(body).toContain("curl is required — the daemon shells out to it for every auto-update");
    expect(body).toContain("need sha256sum (coreutils) or shasum");
    // Ordering is the whole point.
    expect(body).toContain("  linux_preflight\n  ensure_dirs\n  do_download\n");
  });

  test("user scope enables lingering and verifies it by STATE, or refuses", () => {
    const body = renderInstallScript(SERVER_URL);
    expect(body).toContain('loginctl enable-linger "$SERVICE_USER"');
    // Marker file first: `loginctl show-user` fails outright when the user
    // object is not instantiated, which would read as "linger off".
    expect(body).toContain('if [ -e "/var/lib/systemd/linger/$SERVICE_USER" ]; then return 0; fi');
    expect(body).toContain("grep -q '^Linger=yes$'");
    // …and when it cannot be turned on, abort with the exact command.
    expect(body).toContain("sudo loginctl enable-linger $SERVICE_USER");
    expect(body).toContain("Nothing was installed.");
    // The user manager must actually be reachable before we drive it.
    expect(body).toContain('if [ ! -d "/run/user/$(id -u)" ]; then');
  });

  test("system scope is the default; user scope is the no-root fallback", () => {
    const body = renderInstallScript(SERVER_URL);
    expect(body).toContain('SERVICE_SCOPE="${TOKENLEADER_SERVICE_SCOPE:-}"');
    expect(body).toContain(
      'if [ "$(id -u)" = "0" ] || [ -n "$SUDO" ]; then\n      SERVICE_SCOPE="system"',
    );
    expect(body).toContain('UNIT_PATH="/etc/systemd/system/$UNIT"');
    expect(body).toContain('UNIT_PATH="$TARGET_HOME/.config/systemd/user/$UNIT"');
    // curl | sudo bash must target the HUMAN, not root's empty ~/.claude.
    expect(body).toContain('SERVICE_USER="${SUDO_USER:-root}"');
    // Root-created dirs are handed to the service user at EVERY level.
    expect(body).toContain('install -d -m 0755 -o "$SERVICE_USER" -g "$SERVICE_GROUP" "$d"');
    expect(body).toContain('"$TARGET_HOME/.local" \\');
  });

  test("never drives the user manager as root", () => {
    const body = renderInstallScript(SERVER_URL);
    // `systemctl --user` as root talks to ROOT's manager and silently does
    // nothing to the user's unit — drop to the user first.
    expect(body).toContain(
      'su -s /bin/sh "$SERVICE_USER" -c "XDG_RUNTIME_DIR=/run/user/$uid systemctl --user $*"',
    );
  });

  // --- dual-scope: RUN the code, don't grep it ----------------------------
  // The previous version of this test asserted the teardown STRINGS were
  // present. They were — ending in `|| true`, so on the ordinary VPS (sudo
  // asks for a password => $SUDO empty) every teardown command failed
  // silently and the installer happily started a second daemon beside the
  // system one. Both wrote the same state dir; the operator saw two green
  // `systemctl status`. These tests execute the shipped functions instead.

  test("can_remove_other_scope answers no exactly when the teardown would fail", () => {
    const fn = extractFn(renderInstallScript(SERVER_URL), "can_remove_other_scope");
    const ask = (scope: string, sudo: string): number => {
      const r = spawnSync(
        "bash",
        ["-c", `SERVICE_SCOPE=${scope}\nSUDO='${sudo}'\n${fn}\ncan_remove_other_scope`],
        { encoding: "utf8" },
      );
      return r.status ?? -1;
    };
    // A user unit lives in the target user's own HOME: always removable.
    expect(ask("system", "")).toBe(0);
    // The system unit under /etc needs root. $SUDO is EMPTY whenever
    // `sudo -n true` failed — the normal password-protected-sudo VPS.
    expect(ask("user", "")).toBe(1);
    expect(ask("user", "sudo -n")).toBe(0);
  });

  test("preflight refuses BEFORE the download when the other scope can't be removed", () => {
    const body = renderInstallScript(SERVER_URL);
    // The refusal has to sit in preflight (step 1), i.e. ahead of
    // do_download, or the refusal itself leaves a downloaded half-install.
    const guard = 'if [ -f "$OTHER_UNIT_PATH" ] && ! can_remove_other_scope; then';
    expect(body).toContain(guard);
    expect(body.indexOf(guard)).toBeLessThan(body.indexOf("do_download() {"));
    expect(body).toContain("would leave TWO daemons double-reporting");
  });

  test("register_systemd_unit REFUSES when the other scope's unit survives teardown", () => {
    // Simulated /etc: a read-only directory, so `rm -f` fails exactly the way
    // it does for an unprivileged user against /etc/systemd/system.
    const root = mkdtempSync(join(tmpDir, "dualscope-"));
    const etc = join(root, "etc");
    mkdirSync(etc);
    const otherUnit = join(etc, "tokenleader.service");
    writeFileSync(otherUnit, "[Unit]\n");
    chmodSync(etc, 0o555);
    try {
      const r = runSystemdRegister({
        otherUnitPath: otherUnit,
        unitPath: join(root, "user-unit.service"),
        enableStatus: 0,
      });
      expect(r.status).not.toBe(0);
      expect(r.stdout).toContain("the other scope's unit is still installed");
      // …and it must refuse BEFORE enabling anything.
      expect(r.calls).not.toContain("enable --now");
      expect(existsSync(otherUnit)).toBe(true);
    } finally {
      chmodSync(etc, 0o755);
    }
  });

  test("register_systemd_unit proceeds once the other scope is actually gone", () => {
    const root = mkdtempSync(join(tmpDir, "dualscope-ok-"));
    const otherUnit = join(root, "other.service");
    writeFileSync(otherUnit, "[Unit]\n");
    const r = runSystemdRegister({
      otherUnitPath: otherUnit,
      unitPath: join(root, "user-unit.service"),
      enableStatus: 0,
    });
    expect(r.status).toBe(0);
    expect(existsSync(otherUnit)).toBe(false);
    expect(r.calls).toContain("systemctl_do enable --now tokenleader.service");
  });

  test("a failed `enable --now` leaves NOTHING enabled or crash-looping", () => {
    // `enable --now` creates the multi-user.target.wants symlink before it
    // tries to start, and StartLimitIntervalSec=0 means systemd never gives
    // up: bailing out here used to leave a unit crash-looping every 30s
    // forever, surviving reboots, with no summary telling the user how to
    // remove it.
    const root = mkdtempSync(join(tmpDir, "enable-fail-"));
    const unitPath = join(root, "tokenleader.service");
    writeFileSync(unitPath, "[Unit]\n");
    const r = runSystemdRegister({
      otherUnitPath: join(root, "absent.service"),
      unitPath,
      enableStatus: 1,
    });
    expect(r.status).not.toBe(0);
    expect(r.calls).toContain("systemctl_do disable --now tokenleader.service");
    expect(r.calls).toContain("systemctl_do reset-failed tokenleader.service");
    expect(existsSync(unitPath)).toBe(false);
    // …and the error names the two real causes of a 203/EXEC.
    expect(r.stdout).toContain("noexec mount");
    expect(r.stdout).toContain("SELinux");
  });

  test("the downloaded binary is proven executable AS THE SERVICE USER before any unit exists", () => {
    const body = renderInstallScript(SERVER_URL);
    // noexec /home and SELinux user_home_t both let the download succeed and
    // then fail the unit with a bare status=203/EXEC.
    expect(body).toContain("linux_verify_binary_exec() {");
    expect(body).toContain(`su -s /bin/sh "$SERVICE_USER" -c "\\"$BIN_DST\\" --version"`);
    const check = 'if [ "$TL_OS" = "linux" ] && ! linux_verify_binary_exec; then';
    expect(body).toContain(check);
    // Inside do_download — i.e. before write_systemd_unit runs at all.
    expect(body.indexOf(check)).toBeGreaterThan(body.indexOf("do_download() {"));
    expect(body).toContain("No service was installed.");
  });

  test("values that systemd would re-read differently are refused, not written", () => {
    const fn = extractFn(renderInstallScript(SERVER_URL), "reject_unsafe_env_value");
    const check = (value: string): { status: number; out: string } => {
      const r = spawnSync(
        "bash",
        [
          "-c",
          `step_fail(){ printf 'FAIL:%s\\n' "$1"; exit 1; }\n${fn}\nreject_unsafe_env_value --link "$1"`,
          "harness",
          value,
        ],
        { encoding: "utf8" },
      );
      return { status: r.status ?? -1, out: r.stdout };
    };
    // The installer writes daemon.env with bare printf and no escaping layer;
    // systemd's EnvironmentFile parser strips matching quotes, so a value
    // with one reaches the daemon as different bytes than the operator typed
    // (surfacing as an opaque "link code invalid or expired").
    expect(check('"anara.com').status).not.toBe(0);
    expect(check("BM2U-'DXD8").status).not.toBe(0);
    expect(check("BM2U\tDXD8").status).not.toBe(0);
    expect(check(" BM2U-DXD8").status).not.toBe(0);
    expect(check("BM2U-DXD8 ").status).not.toBe(0);
    expect(check('"anara.com').out).toContain("--link");
    // …and ordinary values still pass, including an empty (unset) one.
    expect(check("BM2U-DXD8").status).toBe(0);
    expect(check("anara.com").status).toBe(0);
    expect(check("").status).toBe(0);
    expect(check("https://leaderboard.example.com/x?a=b").status).toBe(0);
    // …and the check runs in preflight, i.e. before the ~36 MB download.
    const body = renderInstallScript(SERVER_URL);
    expect(body.indexOf('reject_unsafe_env_value "--join"')).toBeLessThan(
      body.indexOf("do_download() {"),
    );
    const preflight = body.slice(
      body.indexOf("linux_preflight() {"),
      body.indexOf("can_remove_other_scope() {"),
    );
    expect(preflight).toContain('reject_unsafe_env_value "--link" "$LINK_CODE"');
  });

  test("a root install never re-modes a directory that already exists", () => {
    const body = renderInstallScript(SERVER_URL);
    // `install -d -m 0755` over the whole ~/.local chain widened a user's
    // private 0700 ~/.local (and every other app's data under it).
    expect(body).toContain('chown "$SERVICE_USER:$SERVICE_GROUP" "$d" 2>/dev/null || true');
    const ensure = body.slice(body.indexOf("ensure_dirs() {"), body.indexOf("sha256_of() {"));
    expect(ensure).toContain('elif [ -d "$d" ]; then');
    // The mode is only applied on CREATE.
    expect(ensure).toContain('install -d -m 0755 -o "$SERVICE_USER" -g "$SERVICE_GROUP" "$d"');
    expect(ensure.indexOf("install -d")).toBeGreaterThan(ensure.indexOf('elif [ -d "$d" ]'));
  });

  test("the summary advertises the uninstall command that will actually work", () => {
    const body = renderInstallScript(SERVER_URL);
    // A system unit under /etc needs the same root the install did; the
    // sudo-less form dies half-way, AFTER telling the server the device is
    // gone.
    expect(body).toContain('local uninstall_pipe="bash"');
    expect(body).toContain(
      'if [ "$TL_OS" = "linux" ] && [ "$SERVICE_SCOPE" = "system" ]; then\n    uninstall_pipe="sudo bash"',
    );
  });

  test("Linux logs land in XDG state, never in a literal ~/Library on a VPS", () => {
    const body = renderInstallScript(SERVER_URL);
    expect(body).toContain('LOG_DIR="$TARGET_HOME/.local/state/anara-leaderboard"');
    expect(body).toContain("journalctl -u tokenleader -f");
    expect(body).toContain("journalctl --user -u tokenleader -f");
    // The darwin log path is untouched.
    expect(body).toContain('LOG_DIR="$HOME/Library/Logs/anara-leaderboard"');
  });

  test("no launchd verb ever runs on the Linux path (and vice versa)", () => {
    const body = renderInstallScript(SERVER_URL);
    // The Linux main sequence calls none of the launchd steps.
    const mainIdx = body.indexOf('if [ "$TL_OS" = "darwin" ]; then\n  ensure_dirs');
    expect(mainIdx).toBeGreaterThan(0);
    const linuxArm = body.slice(body.indexOf("else\n  linux_preflight", mainIdx));
    expect(linuxArm).not.toContain("launchctl");
    expect(linuxArm).not.toContain("do_codesign");
    expect(linuxArm).not.toContain("write_watchdog_plist_and_register");
    // xattr only exists inside the darwin-only do_codesign step.
    expect(body).toContain('do_codesign() {\n  step_start 3 "Preparing binary"\n  xattr -cr');
  });

  test("sha256sum is used when present, shasum stays the macOS fallback", () => {
    const body = renderInstallScript(SERVER_URL);
    expect(body).toContain("if command -v sha256sum >/dev/null 2>&1; then");
    expect(body).toContain(`sha256sum "$1" | awk '{print $1}'`);
    expect(body).toContain(`shasum -a 256 "$1" | awk '{print $1}'`);
    expect(body).toContain('actual_sha="$(sha256_of "$tmp_bin")"');
  });

  test("only the Linux download asks for the compressed representation", () => {
    const body = renderInstallScript(SERVER_URL);
    expect(body).toContain('if curl -#fL --compressed "$bin_url" -o "$tmp_bin"; then dl_ok=1; fi');
    expect(body).toContain('if curl -#fL "$bin_url" -o "$tmp_bin"; then dl_ok=1; fi');
  });

  test("rendered script parses under bash on both branches", () => {
    for (const opts of [{}, { joinRequired: true }, { teamName: "Anara" }]) {
      const r = spawnSync("bash", ["-n"], {
        input: renderInstallScript(SERVER_URL, opts),
        encoding: "utf8",
      });
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
    }
  });
});

describe("renderUninstallScript", () => {
  test("starts with #!/usr/bin/env bash and parses as valid bash", () => {
    const body = renderUninstallScript(SERVER_URL);
    expect(body.startsWith("#!/usr/bin/env bash")).toBe(true);
    const tmpScript = join(tmpDir, "rendered-uninstall.sh");
    writeFileSync(tmpScript, body);
    const r = spawnSync("bash", ["-n", tmpScript], { encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  test("removes the tokenleader symlink (and only a symlink)", () => {
    const body = renderUninstallScript(SERVER_URL);
    expect(body).toContain('if [ -L "$TARGET_HOME/.local/bin/tokenleader" ]; then');
    expect(body).toContain('rm -f "$TARGET_HOME/.local/bin/tokenleader"');
  });

  test("boots out the watchdog first, then the daemon; removes plists, hardlink, symlink", () => {
    // This script ships with the server deploy BEFORE v0.6.0 exists in the
    // wild (docs/resilience.md, migration step 1) — it must clean up a
    // watchdog when present without assuming one exists.
    const body = renderUninstallScript(SERVER_URL);
    expect(body).toContain('WATCHDOG_LABEL="${LABEL}.watchdog"');
    expect(body).toContain('BIN_WATCHDOG="$BIN.watchdog"');

    // Watchdog bootout precedes the daemon's: its boot-time self-heal
    // re-bootstraps an absent daemon label (resurrection race otherwise).
    const wdBootout = body.indexOf('launchctl bootout "$DOMAIN/$WATCHDOG_LABEL"');
    const daemonBootout = body.indexOf('launchctl bootout "$DOMAIN/$LABEL"');
    expect(wdBootout).toBeGreaterThan(0);
    expect(daemonBootout).toBeGreaterThan(wdBootout);
    // A missing watchdog is informational, never an error.
    expect(body).toContain("pre-v0.6.0 install, or already gone");

    // Both plists, the binary, the .watchdog hardlink and the CLI symlink.
    expect(body).toContain('rm -f "$WATCHDOG_PLIST"');
    expect(body).toContain('rm -f "$PLIST"');
    expect(body).toContain('rm -f "$BIN"');
    expect(body).toContain('rm -f "$BIN_WATCHDOG"');
    expect(body).toContain('rm -f "$TARGET_HOME/.local/bin/tokenleader"');
  });

  test("POSTs to /events/uninstall before cleanup", () => {
    const body = renderUninstallScript(SERVER_URL);
    expect(body).toContain("notify_server_uninstall");
    expect(body).toContain("/events/uninstall");
    expect(body).toContain("--max-time 5");
    expect(body).toContain("--fail-with-body");
    expect(body).toContain("X-Tokenleader-Secret");
    expect(body).toContain("TOKENLEADER_USER");
    expect(body).toContain("PlistBuddy");
    const notifyIdx = body.indexOf("notify_server_uninstall\n");
    const bootoutIdx = body.indexOf("launchctl bootout");
    const rmPlistIdx = body.indexOf('rm -f "$PLIST"');
    expect(notifyIdx).toBeGreaterThan(0);
    expect(notifyIdx).toBeLessThan(bootoutIdx);
    expect(notifyIdx).toBeLessThan(rmPlistIdx);
  });

  test("Linux: reads the handle from daemon.env and sweeps BOTH systemd scopes", () => {
    const body = renderUninstallScript(SERVER_URL);
    expect(body).not.toContain("This uninstaller only supports macOS");
    expect(body).toContain('  Linux)  TL_OS="linux" ;;');
    // PlistBuddy has no Linux counterpart; the EnvironmentFile is the store.
    expect(body).toContain(
      `handle="$(sed -n 's/^TOKENLEADER_USER=//p' "$ENV_FILE" 2>/dev/null | head -1 || true)"`,
    );
    // A unit left enabled in the OTHER scope is a service systemd keeps
    // restarting after its binary is gone.
    expect(body).toContain('for candidate in "system:/etc/systemd/system/$UNIT" \\');
    expect(body).toContain('"user:$TARGET_HOME/.config/systemd/user/$UNIT"; do');
    expect(body).toContain('systemctl_do disable --now "$UNIT"');
    expect(body).toContain('systemctl_do reset-failed "$UNIT"');
    // …driven as the target user, not as root's own manager.
    expect(body).toContain(
      'su -s /bin/sh "$SERVICE_USER" -c "XDG_RUNTIME_DIR=/run/user/$uid systemctl --user $*"',
    );
    // The macOS launchd teardown stays inside its own branch.
    const linuxIdx = body.indexOf("else\n  # disable --now must be as disciplined");
    expect(linuxIdx).toBeGreaterThan(0);
    const linuxTeardown = body
      .slice(linuxIdx, body.indexOf('if [ -f "$BIN" ]'))
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .join("\n");
    expect(linuxTeardown).not.toContain("launchctl");
  });

  test("Linux: refuses a system-scope uninstall it cannot complete, BEFORE notifying", () => {
    // The installer used to advertise `curl … /uninstall | bash` for every
    // install. Against a system unit that command POSTed /events/uninstall,
    // then died on `rm: Permission denied` under set -e — the server had
    // dropped the device while the daemon kept ticking and re-registering.
    const body = renderUninstallScript(SERVER_URL);
    const fn = extractFn(body, "linux_uninstall_preflight");
    const run = (vars: Record<string, string>): { status: number; out: string } => {
      const assigns = Object.entries(vars)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join("\n");
      const r = spawnSync(
        "bash",
        [
          "-c",
          `set -euo pipefail\nerr(){ printf 'ERR:%s\\n' "$*"; }\n${assigns}\n${fn}\nlinux_uninstall_preflight\nprintf 'PROCEEDED\\n'`,
        ],
        { encoding: "utf8" },
      );
      return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
    };
    const base = {
      TL_OS: "linux",
      SERVICE_SCOPE: "system",
      SUDO: "",
      UNIT_PATH: "/etc/systemd/system/tokenleader.service",
      SERVER_URL,
    };
    // Non-root, no passwordless sudo, system unit → refuse, change nothing.
    const refused = run(base);
    expect(refused.status).not.toBe(0);
    expect(refused.out).not.toContain("PROCEEDED");
    expect(refused.out).toContain("| sudo bash");
    expect(refused.out).toContain("Nothing was changed.");
    // Every other combination proceeds.
    expect(run({ ...base, SUDO: "sudo -n" }).out).toContain("PROCEEDED");
    expect(run({ ...base, SERVICE_SCOPE: "user" }).out).toContain("PROCEEDED");
    expect(run({ ...base, TL_OS: "darwin" }).out).toContain("PROCEEDED");
    // …and it runs ahead of the server notify.
    expect(body.indexOf("linux_uninstall_preflight\n")).toBeLessThan(
      body.indexOf("notify_server_uninstall()"),
    );
  });

  test("Linux: a failed unit removal warns instead of aborting the teardown", () => {
    const body = renderUninstallScript(SERVER_URL);
    // set -e + a bare `rm` aborted the uninstall mid-flight, leaving the
    // binary, the symlink and the other scope untouched.
    expect(body).toContain('$SUDO rm -f "$UNIT_PATH" 2>/dev/null || true');
    expect(body).toContain('rm -f "$UNIT_PATH" 2>/dev/null || true');
    expect(body).toContain('if [ -f "$UNIT_PATH" ]; then');
    expect(body).toContain("Couldn't remove $UNIT_PATH (need root?");
  });

  test("the /dev/tty reopen can never kill the script before the server notify", () => {
    // `exec </dev/tty` failure exits a non-interactive shell outright and
    // `|| true` does NOT catch it — reproduced under `docker exec` with no
    // -t, where /dev/tty exists, passes -r, and cannot be opened.
    const body = renderUninstallScript(SERVER_URL);
    expect(body).toContain("if [ ! -t 0 ] && [ -r /dev/tty ] && (: </dev/tty) 2>/dev/null; then");
  });
});
