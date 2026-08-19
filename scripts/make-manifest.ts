#!/usr/bin/env bun
// Emit the DUAL-SHAPE release manifest consumed by every daemon in the
// field and by the server's BinaryMirror.
//
// One generator, two callers:
//   * .github/workflows/release.yml   (tag-driven CI release)
//   * scripts/publish-release.sh      (emergency manual publish)
//
// Shape rules (frozen):
//   * v1 keys `version`, `publishedAt`, and top-level `arm64`/`x64` (each
//     `{ sha256 }`) are what the FIELDED daemons validate and consume — they
//     are unconditional, forever.
//   * v2 additive fields: `schemaVersion: 2`, `buildSha`, `channel`, and the
//     `platforms` map keyed by `${os}-${arch}` tokens. The legacy keys are
//     byte-equal mirrors of platforms["darwin-*"] BY CONSTRUCTION here (same
//     object); release.yml re-asserts equality with jq as guard (c). The
//     linux-* entries are ADDITIVE inside `platforms` and are the only place
//     a Linux daemon looks; a darwin daemon never reads them because it
//     resolves the legacy keys.
//   * No `url` fields: daemons fetch binaries from their own server's /bin
//     routes, so a stale or hostile manifest cannot redirect them.
//     `canonicalEndpoint` is reserved for hand-crafted transition manifests
//     and is never emitted by tooling.
//
// Usage:
//   bun scripts/make-manifest.ts --version v0.1.0 \
//     [--bin-dir bin] [--out bin/manifest.json] [--build-sha <short-sha>]
//
// Binary discovery per platform: the canonical asset name first
// (tokenleader-darwin-*), then the legacy fleet name (anara-leaderboard-*)
// so the emergency publish path works unchanged.

import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PUBLISHED_PLATFORM_KEYS, type PublishedPlatformKey } from "../src/daemon/platform.ts";

export interface ManifestEntryJson {
  sha256: string;
}

export interface ManifestJson {
  schemaVersion: 2;
  version: string;
  buildSha: string;
  publishedAt: string;
  channel: string;
  platforms: Record<string, ManifestEntryJson>;
  // Legacy v1 mirror keys — what the fielded daemons consume.
  arm64: ManifestEntryJson;
  x64: ManifestEntryJson;
}

export interface MakeManifestOptions {
  /** Release version string — the git tag in CI (e.g. "v0.1.0"). */
  version: string;
  /** Directory holding the built daemon binaries. */
  binDir: string;
  /** Bare git short SHA; defaults to `git rev-parse --short HEAD`. */
  buildSha?: string;
  /** ISO-8601 UTC timestamp; defaults to now (second precision). */
  publishedAt?: string;
  /** Informational at v0.1.0 — always "stable" in published manifests. */
  channel?: string;
}

/** Currently published platforms — the daemon's OWN list (it builds its
 *  `/bin` asset name and reads its manifest entry from the same tokens), so
 *  the generator and the consumer can never disagree about what shipped. */
export const PUBLISHED_PLATFORMS = PUBLISHED_PLATFORM_KEYS;
export type PublishedPlatform = PublishedPlatformKey;

/**
 * Legacy top-level manifest keys — DARWIN ONLY, forever. They are the v1
 * consumer shape every fielded daemon validates and reads. Linux is additive
 * inside `platforms` and must never grow a legacy alias: there is no fielded
 * Linux daemon to be compatible with, and inventing one would give the same
 * bytes two names.
 */
const LEGACY_KEY: Record<"darwin-arm64" | "darwin-x64", "arm64" | "x64"> = {
  "darwin-arm64": "arm64",
  "darwin-x64": "x64",
};

/** Candidate file names per platform, new canonical name first. */
export function binaryCandidates(platform: PublishedPlatform): string[] {
  const legacy = (LEGACY_KEY as Record<string, "arm64" | "x64" | undefined>)[platform];
  return legacy
    ? [`tokenleader-${platform}`, `anara-leaderboard-${legacy}`]
    : [`tokenleader-${platform}`];
}

function resolveBinary(binDir: string, platform: PublishedPlatform): string {
  for (const name of binaryCandidates(platform)) {
    const p = join(binDir, name);
    if (existsSync(p)) return p;
  }
  throw new Error(
    `make-manifest: no binary for ${platform} in ${binDir} ` +
      `(looked for: ${binaryCandidates(platform).join(", ")})`,
  );
}

function sha256OfFile(path: string): string {
  const bytes = readFileSync(path);
  if (bytes.length === 0) {
    throw new Error(`make-manifest: ${path} is empty`);
  }
  return createHash("sha256").update(bytes).digest("hex");
}

function defaultBuildSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

export function makeManifest(opts: MakeManifestOptions): ManifestJson {
  const version = opts.version.trim();
  if (!version) throw new Error("make-manifest: --version is required");

  const platforms: Record<string, ManifestEntryJson> = {};
  for (const platform of PUBLISHED_PLATFORMS) {
    platforms[platform] = {
      sha256: sha256OfFile(resolveBinary(opts.binDir, platform)),
    };
  }

  // Legacy keys reference the SAME entry objects as the platforms map, so
  // the dual shape cannot drift within one invocation.
  return {
    schemaVersion: 2,
    version,
    buildSha: (opts.buildSha ?? defaultBuildSha()).trim(),
    publishedAt: opts.publishedAt ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    channel: opts.channel ?? "stable",
    platforms,
    arm64: platforms["darwin-arm64"]!,
    x64: platforms["darwin-x64"]!,
  };
}

export function renderManifest(manifest: ManifestJson): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function parseArgs(argv: string[]): {
  version: string;
  binDir: string;
  out: string;
  buildSha?: string;
} {
  let version = "";
  let binDir = "bin";
  let out = "";
  let buildSha: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`make-manifest: ${arg} needs a value`);
      return v;
    };
    if (arg === "--version") version = next();
    else if (arg === "--bin-dir") binDir = next();
    else if (arg === "--out") out = next();
    else if (arg === "--build-sha") buildSha = next();
    else throw new Error(`make-manifest: unknown argument ${arg}`);
  }
  if (!version) {
    throw new Error(
      "usage: bun scripts/make-manifest.ts --version <vX.Y.Z> " +
        "[--bin-dir bin] [--out bin/manifest.json] [--build-sha <sha>]",
    );
  }
  return { version, binDir, out: out || join(binDir, "manifest.json"), buildSha };
}

if (import.meta.main) {
  const { version, binDir, out, buildSha } = parseArgs(process.argv.slice(2));
  const manifest = makeManifest({ version, binDir, buildSha });
  writeFileSync(out, renderManifest(manifest));
  console.error(`make-manifest: wrote ${out} (version=${manifest.version})`);
  console.log(renderManifest(manifest).trimEnd());
}
