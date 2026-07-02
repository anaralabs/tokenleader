import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
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
      "ARCH_PATH=arm64\n" +
      `expected_sha="$(tr -d '\\n\\r' < "${mPath}" | sed -E "${sedExpr}" | grep -E '^[0-9a-fA-F]{64}$' || true)"\n` +
      'printf "%s" "$expected_sha"';
    const r = spawnSync("bash", ["-c", harness], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(sha);
  });

  test("downloads the binary from the server's own /bin route via curl", () => {
    const body = renderInstallScript(SERVER_URL);
    expect(body).toContain('BINARY_BASE_URL="${TOKENLEADER_BINARY_URL:-$SERVER_URL/bin}"');
    expect(body).toContain('arch_asset="anara-leaderboard-$ARCH_PATH"');
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
    // The manifest's keys are arm64/x64 (NOT x86_64); ARCH_PATH doubles
    // as the manifest key, so the x86_64 uname must map to "x64".
    expect(body).toContain('x86_64) ARCH_PATH="x64"');
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
    expect(body).toContain('ln -sfn "$BIN_DST" "$HOME/.local/bin/tokenleader"');
    // Never clobbers a real (non-symlink) file that owns the name.
    expect(body).toContain(
      'if [ ! -e "$HOME/.local/bin/tokenleader" ] || [ -L "$HOME/.local/bin/tokenleader" ]; then',
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
    expect(body).toContain('if [ -L "$HOME/.local/bin/tokenleader" ]; then');
    expect(body).toContain('rm -f "$HOME/.local/bin/tokenleader"');
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
});
