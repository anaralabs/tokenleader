// Tests for scripts/make-manifest.ts — the dual-shape manifest generator
// used by release.yml and publish-release.sh. Load-bearing: the legacy
// top-level arm64/x64 keys are EXACT mirrors of the darwin platforms
// entries, the output passes the daemon's own isManifest validator, and
// legacy anara-leaderboard-* binary names still resolve.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import {
  binaryCandidates,
  makeManifest,
  renderManifest,
  PUBLISHED_PLATFORMS,
} from "./make-manifest.ts";
import { __internal } from "../src/daemon/update.ts";

const HEX64 = /^[0-9a-f]{64}$/;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Every published platform must be present or makeManifest throws (that is
 *  the point — a partially-failed release matrix cannot publish a short
 *  manifest). Callers override only the names a test cares about. */
const DEFAULT_BINARIES: Record<string, string> = {
  "tokenleader-darwin-arm64": "darwin-arm64-bytes",
  "tokenleader-darwin-x64": "darwin-x64-bytes",
  "tokenleader-linux-x64": "linux-x64-bytes",
  "tokenleader-linux-arm64": "linux-arm64-bytes",
};

function makeBinDir(names: Record<string, string>, exact = false): string {
  const dir = mkdtempSync(join(tmpdir(), "make-manifest-test-"));
  const files = exact ? names : { ...DEFAULT_BINARIES, ...names };
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

describe("makeManifest", () => {
  test("dual shape: legacy keys mirror the darwin platforms map exactly", () => {
    const dir = makeBinDir({
      "tokenleader-darwin-arm64": "arm64-bytes",
      "tokenleader-darwin-x64": "x64-bytes",
    });
    const m = makeManifest({
      version: "v0.1.0",
      binDir: dir,
      buildSha: "abc1234",
      publishedAt: "2026-06-11T00:00:00Z",
    });

    expect(m.schemaVersion).toBe(2);
    expect(m.version).toBe("v0.1.0");
    expect(m.buildSha).toBe("abc1234");
    expect(m.publishedAt).toBe("2026-06-11T00:00:00Z");
    expect(m.channel).toBe("stable");

    expect(m.platforms["darwin-arm64"]?.sha256).toBe(sha256("arm64-bytes"));
    expect(m.platforms["darwin-x64"]?.sha256).toBe(sha256("x64-bytes"));
    expect(m.arm64.sha256).toMatch(HEX64);
    expect(m.x64.sha256).toMatch(HEX64);

    // Byte-equality of the mirrors (release.yml asserts the same thing
    // post-serialization with jq).
    expect(m.arm64).toEqual(m.platforms["darwin-arm64"]!);
    expect(m.x64).toEqual(m.platforms["darwin-x64"]!);

    // No url / canonicalEndpoint fields, ever, from tooling.
    const parsed = JSON.parse(renderManifest(m));
    expect(parsed.arm64.url).toBeUndefined();
    expect(parsed.x64.url).toBeUndefined();
    expect(parsed.canonicalEndpoint).toBeUndefined();
  });

  test("output passes the daemon's own manifest validator (fleet path)", () => {
    const dir = makeBinDir({
      "tokenleader-darwin-arm64": "a",
      "tokenleader-darwin-x64": "b",
    });
    const m = makeManifest({ version: "v0.1.0", binDir: dir });
    // Round-trip through JSON exactly like the wire does.
    const parsed: unknown = JSON.parse(renderManifest(m));
    expect(__internal.isManifest(parsed)).toBe(true);
  });

  test("legacy anara-leaderboard-* names resolve (emergency publish path)", () => {
    const dir = makeBinDir(
      {
        "anara-leaderboard-arm64": "legacy-arm",
        "anara-leaderboard-x64": "legacy-x64",
        "tokenleader-linux-x64": "linux-x64-bytes",
        "tokenleader-linux-arm64": "linux-arm64-bytes",
      },
      true,
    );
    const m = makeManifest({ version: "deadbee", binDir: dir });
    expect(m.platforms["darwin-arm64"]?.sha256).toBe(sha256("legacy-arm"));
    expect(m.platforms["darwin-x64"]?.sha256).toBe(sha256("legacy-x64"));
  });

  test("new canonical name wins over a legacy name in the same dir", () => {
    const dir = makeBinDir({
      "tokenleader-darwin-arm64": "new-arm",
      "anara-leaderboard-arm64": "old-arm",
      "tokenleader-darwin-x64": "new-x64",
    });
    const m = makeManifest({ version: "v0.1.0", binDir: dir });
    expect(m.platforms["darwin-arm64"]?.sha256).toBe(sha256("new-arm"));
  });

  test("missing binary throws and names the candidates", () => {
    const dir = makeBinDir({ "tokenleader-darwin-arm64": "only-arm" }, true);
    expect(() => makeManifest({ version: "v0.1.0", binDir: dir })).toThrow(/darwin-x64/);
  });

  test("empty binary throws (a zero-byte daemon must never publish)", () => {
    const dir = makeBinDir({
      "tokenleader-darwin-arm64": "",
      "tokenleader-darwin-x64": "ok",
    });
    expect(() => makeManifest({ version: "v0.1.0", binDir: dir })).toThrow(/empty/);
  });

  test("blank version throws", () => {
    const dir = makeBinDir({
      "tokenleader-darwin-arm64": "a",
      "tokenleader-darwin-x64": "b",
    });
    expect(() => makeManifest({ version: "  ", binDir: dir })).toThrow(/--version/);
  });

  test("candidate order is canonical-first for every published platform", () => {
    expect(PUBLISHED_PLATFORMS).toEqual(["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"]);
    expect(binaryCandidates("darwin-arm64")).toEqual([
      "tokenleader-darwin-arm64",
      "anara-leaderboard-arm64",
    ]);
    expect(binaryCandidates("darwin-x64")).toEqual([
      "tokenleader-darwin-x64",
      "anara-leaderboard-x64",
    ]);
    // Linux gets NO legacy alias: there is no fielded linux daemon to be
    // compatible with, and an alias would give the same bytes two names.
    expect(binaryCandidates("linux-x64")).toEqual(["tokenleader-linux-x64"]);
    expect(binaryCandidates("linux-arm64")).toEqual(["tokenleader-linux-arm64"]);
  });

  test("linux entries are ADDITIVE: they exist, and the legacy keys stay darwin", () => {
    const dir = makeBinDir({});
    const m = makeManifest({ version: "v0.7.0", binDir: dir, buildSha: "abc1234" });

    expect(m.platforms["linux-x64"]?.sha256).toBe(sha256("linux-x64-bytes"));
    expect(m.platforms["linux-arm64"]?.sha256).toBe(sha256("linux-arm64-bytes"));

    // release.yml guard (c): the legacy pair mirrors DARWIN, forever. If this
    // ever drifted to a linux entry the whole macOS fleet would roll onto an
    // ELF and refuse every update.
    expect(m.arm64).toBe(m.platforms["darwin-arm64"]!);
    expect(m.x64).toBe(m.platforms["darwin-x64"]!);
    expect(m.arm64.sha256).not.toBe(m.platforms["linux-arm64"]?.sha256);
    expect(m.x64.sha256).not.toBe(m.platforms["linux-x64"]?.sha256);

    // release.yml guard (c2): four distinct artifacts, four distinct shas.
    const shas = Object.values(m.platforms).map((e) => e.sha256);
    expect(new Set(shas).size).toBe(4);
  });

  test("a missing linux binary throws rather than publishing a short manifest", () => {
    const dir = makeBinDir(
      {
        "tokenleader-darwin-arm64": "a",
        "tokenleader-darwin-x64": "b",
        "tokenleader-linux-x64": "c",
      },
      true,
    );
    expect(() => makeManifest({ version: "v0.7.0", binDir: dir })).toThrow(
      /no binary for linux-arm64/,
    );
  });
});
