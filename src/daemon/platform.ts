// The daemon's own identity as a release-artifact coordinate.
//
// One token, `${os}-${arch}`, is the single name for "which build am I":
// it keys the v2 manifest `platforms` map, names the /bin asset, is printed
// by `--version`, and is reported on every checkin so the server can tell a
// Linux box from a Mac. Keeping it in one module stops those four from
// drifting apart.
//
// FROZEN, do not "unify": on darwin the /bin asset and the manifest key stay
// the BARE arch (`arm64`/`x64`). 23 fielded daemons build that URL from
// `process.arch` and read the legacy top-level manifest keys; both are
// consumer contracts that can never be renamed. Linux is additive.

export type DaemonArch = "arm64" | "x64";

/** Platform tokens with published release artifacts. */
export const PUBLISHED_PLATFORM_KEYS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-x64",
  "linux-arm64",
] as const;
export type PublishedPlatformKey = (typeof PUBLISHED_PLATFORM_KEYS)[number];

/** Bun/Node `process.arch` collapsed to the two arches we build for.
 *  Anything exotic maps to x64 — the historical behaviour of pickArch(). */
export function daemonArch(arch: string = process.arch): DaemonArch {
  return arch === "arm64" ? "arm64" : "x64";
}

/** `${os}-${arch}` — e.g. "darwin-arm64", "linux-x64". */
export function platformKey(
  platform: string = process.platform,
  arch: string = process.arch,
): string {
  return `${platform}-${daemonArch(arch)}`;
}

/**
 * Suffix of the `/bin/anara-leaderboard-<suffix>` asset for a platform.
 * darwin → the frozen bare arch; everything else → the full platform token.
 */
export function binaryAssetSuffix(
  platform: string = process.platform,
  arch: string = process.arch,
): string {
  const a = daemonArch(arch);
  return platform === "darwin" ? a : `${platform}-${a}`;
}
