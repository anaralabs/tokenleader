// BinaryMirror — server side of the daemon auto-update channel. Polls the
// `latest` GitHub Release on TOKENLEADER_GH_REPO and caches manifest.json +
// the per-platform binaries on disk; /manifest.json and /bin/* serve from that
// cache so daemons never talk to GitHub directly. Assets are written
// tmp-then-rename with the manifest renamed LAST, so a polling daemon sees a
// new sha only after every binary THE RELEASE CARRIES is servable.
//
// That last clause is the honest form of the invariant: the linux assets are
// OPTIONAL (see REQUIRED_ASSETS), so a release can advertise a linux sha in
// its manifest while carrying no linux asset — e.g. an operator deletes a bad
// linux binary from the published release as incident response. The darwin
// channel must keep flowing in that case, so the cycle proceeds and
// warnUnservableManifestEntries() logs every advertised-but-unservable
// platform loudly instead of letting linux daemons re-download forever with
// no signal. Transient fetch errors log and retry next tick. Callers MUST
// stop() on shutdown/teardown.

import { createHash } from "node:crypto";
import { existsSync, promises as fsp, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { gzip as gzipCb } from "node:zlib";

const gzipAsync = promisify(gzipCb);

/**
 * Assets the mirror manages, named by the suffix that appears BOTH in the
 * on-disk cache filename `anara-leaderboard-<suffix>` and in the `/bin`
 * route. The two darwin suffixes are the bare arch and are intentionally
 * legacy — fielded daemons build that URL from `process.arch`, so those two
 * names are frozen forever. Linux is additive and platform-keyed.
 */
export const MIRRORED_ASSETS = ["arm64", "x64", "linux-x64", "linux-arm64"] as const;
export type MirroredAsset = (typeof MIRRORED_ASSETS)[number];

/**
 * Assets whose absence from a release aborts the whole mirror cycle.
 *
 * ONLY the darwin pair. The mirror follows the `releases/latest` marker,
 * which routinely points at a release older than the running server image
 * (a rollback, or a server deployed ahead of the next tag). If the linux
 * assets were required, the first such release would stop mirroring
 * ENTIRELY — no manifest, no binaries — and take the 23-machine darwin
 * fleet's update channel down with it.
 */
export const REQUIRED_ASSETS: readonly MirroredAsset[] = ["arm64", "x64"];

/** `platforms` key of the v2 manifest per mirrored asset — the inverse of the
 *  frozen darwin spelling: the manifest is platform-keyed even where the
 *  asset name and /bin route are the bare legacy arch. */
const MANIFEST_PLATFORM_KEY: Record<MirroredAsset, string> = {
  arm64: "darwin-arm64",
  x64: "darwin-x64",
  "linux-x64": "linux-x64",
  "linux-arm64": "linux-arm64",
};

/** GH Release asset name per mirrored asset. darwin keeps the legacy fleet
 *  names; linux uses the canonical release artifact name directly, so no
 *  duplicate ~94 MB upload is needed just to rename it. */
const GH_ASSET_NAME: Record<MirroredAsset, string> = {
  arm64: "anara-leaderboard-arm64",
  x64: "anara-leaderboard-x64",
  "linux-x64": "tokenleader-linux-x64",
  "linux-arm64": "tokenleader-linux-arm64",
};

export const DEFAULT_MIRROR_INTERVAL_SEC = 15 * 60;
export const INITIAL_FETCH_DELAY_MS = 5_000;

const GITHUB_API = "https://api.github.com";

/** Console-shaped logger seam so callers can pass console directly. */
export interface MirrorLogger {
  info: (msg: string, ...rest: unknown[]) => void;
  warn: (msg: string, ...rest: unknown[]) => void;
  error: (msg: string, ...rest: unknown[]) => void;
}

const consoleLogger: MirrorLogger = {
  info: (m, ...r) => console.log(m, ...r),
  warn: (m, ...r) => console.warn(m, ...r),
  error: (m, ...r) => console.error(m, ...r),
};

export interface BinaryMirrorOpts {
  /** Cache dir for manifest + binaries; created on start(). The server's
   *  update routes read this same directory. */
  cacheDir: string;
  /** GitHub repo in `owner/name` form. */
  ghRepo: string;
  /** GitHub token with release read access (required for private repos). */
  ghToken: string;
  /** Polling interval in seconds. Defaults to 900 (15 min). */
  intervalSec?: number;
  /** Test seam: stub fetch so tests never hit network. */
  fetchImpl?: typeof fetch;
  /** Initial-fetch delay; 5000 ms in production, 0 in tests. */
  initialDelayMs?: number;
  /** Optional logger; defaults to console. */
  log?: MirrorLogger;
}

interface GhAsset {
  id: number;
  name: string;
  url: string;
}

interface GhRelease {
  tag_name: string;
  assets: GhAsset[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object";
}

function isGhRelease(v: unknown): v is GhRelease {
  if (!isRecord(v)) return false;
  if (typeof v.tag_name !== "string") return false;
  if (!Array.isArray(v.assets)) return false;
  return v.assets.every(
    (a) =>
      isRecord(a) &&
      typeof a.id === "number" &&
      typeof a.name === "string" &&
      typeof a.url === "string",
  );
}

/**
 * Map a `/bin/anara-leaderboard-<suffix>` suffix onto a mirrored asset.
 *
 * The three legacy spellings (`arm64`, `x64`, `x86_64`) must keep resolving
 * to DARWIN forever — fielded daemons build that URL from `process.arch` and
 * the mac install script uses `x64` for Intel. Note the consequence: a bare
 * `x86_64` means DARWIN, so `curl $SERVER/bin/anara-leaderboard-$(uname -m)`
 * on a Linux box hands back a Mach-O. The platform-qualified spellings are
 * the unambiguous ones, and `darwin-*` exists so both platforms can be named
 * the same way. Linux spellings are additive, with the same `uname -m`
 * courtesy aliases a hand-rolled curl user would reach for. Anything else →
 * null (404).
 */
export function normalizeArch(raw: string): MirroredAsset | null {
  if (raw === "arm64" || raw === "darwin-arm64") return "arm64";
  if (raw === "x64" || raw === "x86_64" || raw === "darwin-x64") return "x64";
  if (raw === "linux-x64" || raw === "linux-x86_64" || raw === "linux-amd64") return "linux-x64";
  if (raw === "linux-arm64" || raw === "linux-aarch64") return "linux-arm64";
  return null;
}

function manifestPath(cacheDir: string): string {
  return path.join(cacheDir, "manifest.json");
}

function binaryPath(cacheDir: string, asset: MirroredAsset): string {
  return path.join(cacheDir, `anara-leaderboard-${asset}`);
}

function gzipPath(cacheDir: string, asset: MirroredAsset): string {
  return `${binaryPath(cacheDir, asset)}.gz`;
}

function sha256Hex(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

export class BinaryMirror {
  private readonly cacheDir: string;
  private readonly ghRepo: string;
  private readonly ghToken: string;
  private readonly intervalMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly initialDelayMs: number;
  private readonly log: MirrorLogger;

  /** sha256 of the last manifest written to disk; short-circuits binary
   *  re-downloads when nothing changed. */
  private lastManifestSha: string | null = null;

  /** Manifest-bytes sha memoized by file mtime, so /manifest.json ETags
   *  cost one hash per refresh rather than per request. */
  private manifestShaMemo: { mtimeMs: number; sha256: string } | null = null;

  private timer: ReturnType<typeof setInterval> | null = null;
  private initialTimer: ReturnType<typeof setTimeout> | null = null;
  /** Guard against overlapping refresh runs (a slow fetch + a fast interval). */
  private inflight = false;

  constructor(opts: BinaryMirrorOpts) {
    this.cacheDir = opts.cacheDir;
    this.ghRepo = opts.ghRepo;
    this.ghToken = opts.ghToken;
    this.intervalMs = (opts.intervalSec ?? DEFAULT_MIRROR_INTERVAL_SEC) * 1000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.initialDelayMs =
      opts.initialDelayMs !== undefined ? opts.initialDelayMs : INITIAL_FETCH_DELAY_MS;
    this.log = opts.log ?? consoleLogger;
  }

  /** Begin mirroring. Idempotent while already running. */
  async start(): Promise<void> {
    if (this.timer || this.initialTimer) return;
    await fsp.mkdir(this.cacheDir, { recursive: true });

    // Seed lastManifestSha from disk so a server restart doesn't always
    // re-download both binaries on the first tick.
    try {
      const existing = await fsp.readFile(manifestPath(this.cacheDir));
      this.lastManifestSha = sha256Hex(existing);
    } catch {
      this.lastManifestSha = null;
    }

    // Backfill the gzip copies for any already-cached binaries (a restart with
    // an unchanged release won't re-run a refresh), so /bin can serve gzip
    // right away. Best-effort, off the boot path.
    void this.ensureGzip();

    this.initialTimer = setTimeout(() => {
      this.initialTimer = null;
      void this.tick();
      this.timer = setInterval(() => {
        void this.tick();
      }, this.intervalMs);
      // Don't keep the process alive purely for the mirror timer.
      this.timer.unref?.();
    }, this.initialDelayMs);
    this.initialTimer.unref?.();
  }

  /** Stop the polling timers (safe to repeat). Cached files stay served. */
  stop(): void {
    if (this.initialTimer) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Run one refresh cycle now. NEVER rejects — errors are logged and the
   *  next tick retries. */
  async tick(): Promise<void> {
    if (this.inflight) return;
    this.inflight = true;
    try {
      await this.refresh();
    } catch (err: unknown) {
      // refresh swallows per-step errors; never crash the server over a bug.
      this.log.warn(
        "[tokenleader] binary-mirror tick threw",
        String((err as Error)?.message ?? err),
      );
    } finally {
      this.inflight = false;
    }
  }

  /** Cached manifest bytes, or null if the mirror hasn't fetched yet. */
  getManifest(): Buffer | null {
    const p = manifestPath(this.cacheDir);
    try {
      if (!existsSync(p)) return null;
      // Re-read each time so a manual ops swap of manifest.json shows
      // without a restart; the file is tiny.
      return readFileSync(p);
    } catch {
      return null;
    }
  }

  /** Cached manifest bytes plus their sha256 (the /manifest.json ETag),
   *  or null if the mirror hasn't fetched yet. */
  getManifestWithSha(): { bytes: Buffer; sha256: string } | null {
    const p = manifestPath(this.cacheDir);
    try {
      const st = statSync(p);
      const bytes = readFileSync(p);
      if (this.manifestShaMemo?.mtimeMs !== st.mtimeMs) {
        this.manifestShaMemo = { mtimeMs: st.mtimeMs, sha256: sha256Hex(bytes) };
      }
      return { bytes, sha256: this.manifestShaMemo.sha256 };
    } catch {
      return null;
    }
  }

  /** On-disk path of the cached binary for `arch`, or null if not present.
   *  Caller streams via `Bun.file(path)`. */
  getBinary(arch: MirroredAsset): { path: string; size: number } | null {
    const p = binaryPath(this.cacheDir, arch);
    try {
      const st = statSync(p);
      return { path: p, size: st.size };
    } catch {
      return null;
    }
  }

  /** On-disk path of the gzip-compressed binary for `arch`, if a copy fresher
   *  than the raw binary is cached. The ~63 MB daemon binary compresses ~2.6x,
   *  and the daemon's update fetch has a hard 120s timeout — a raw 63 MB pull
   *  over a slow link exceeds it and strands the update, so /bin serves this to
   *  gzip-accepting clients. The daemon sha-verifies the DECODED bytes, so the
   *  manifest sha is unchanged. Returns null when no fresh .gz exists yet
   *  (ensureGzip hasn't run, or it's stale after a refresh) — the route then
   *  falls back to the raw binary. */
  getBinaryGzip(arch: MirroredAsset): { path: string; size: number } | null {
    try {
      const rawStat = statSync(binaryPath(this.cacheDir, arch));
      const gzStat = statSync(gzipPath(this.cacheDir, arch));
      if (gzStat.mtimeMs >= rawStat.mtimeMs) {
        return { path: gzipPath(this.cacheDir, arch), size: gzStat.size };
      }
    } catch {
      // raw or gz missing — caller falls back to raw serving.
    }
    return null;
  }

  /** Generate (or refresh) the gzip copy of each cached binary. Idempotent and
   *  atomic (tmp + rename); skips an arch whose .gz is already fresh. Called on
   *  start() and after each successful refresh so /bin can serve gzip. Errors
   *  are logged, never thrown — gzip is an optimization; raw serving still works. */
  async ensureGzip(): Promise<void> {
    for (const arch of MIRRORED_ASSETS) {
      const raw = binaryPath(this.cacheDir, arch);
      const gz = gzipPath(this.cacheDir, arch);
      let rawStat: ReturnType<typeof statSync>;
      try {
        rawStat = statSync(raw);
      } catch {
        continue; // no raw binary cached for this arch yet
      }
      try {
        if (statSync(gz).mtimeMs >= rawStat.mtimeMs) continue; // already fresh
      } catch {
        // gz missing — generate below.
      }
      try {
        const compressed = await gzipAsync(await fsp.readFile(raw));
        const tmp = `${gz}.tmp.${process.pid}`;
        await fsp.writeFile(tmp, compressed);
        await fsp.rename(tmp, gz);
        this.log.info(
          "[tokenleader] binary-mirror: gzipped",
          `arch=${arch}`,
          `raw=${rawStat.size}`,
          `gz=${compressed.length}`,
        );
      } catch (err: unknown) {
        this.log.error(
          "[tokenleader] binary-mirror: gzip failed",
          `arch=${arch}`,
          String((err as Error)?.message ?? err),
        );
      }
    }
  }

  // ---------------------------------------------------------------- private

  private ghHeaders(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${this.ghToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "tokenleader-mirror/1.0",
      ...(extra ?? {}),
    };
  }

  /**
   * Single mirror cycle. A single failed asset bails the whole cycle so
   * daemons never see a half-applied manifest + binary set; next tick
   * retries.
   */
  private async refresh(): Promise<void> {
    let release: GhRelease;
    try {
      release = await this.fetchLatestRelease();
    } catch (err: unknown) {
      this.log.warn(
        "[tokenleader] binary-mirror: failed to fetch release",
        String((err as Error)?.message ?? err),
      );
      return;
    }

    const manifestAsset = release.assets.find((a) => a.name === "manifest.json");
    if (!manifestAsset) {
      this.log.warn("[tokenleader] binary-mirror: release missing manifest.json asset");
      return;
    }
    // Required assets missing => bail the cycle. Optional (linux) assets
    // missing => mirror what the release actually has; a pre-linux release
    // must not stop the darwin update channel.
    const found: Partial<Record<MirroredAsset, GhAsset>> = {};
    for (const asset of MIRRORED_ASSETS) {
      const gh = release.assets.find((a) => a.name === GH_ASSET_NAME[asset]);
      if (gh) {
        found[asset] = gh;
      } else if (REQUIRED_ASSETS.includes(asset)) {
        this.log.warn("[tokenleader] binary-mirror: release missing asset", GH_ASSET_NAME[asset]);
        return;
      } else {
        this.log.info(
          "[tokenleader] binary-mirror: release has no optional asset",
          GH_ASSET_NAME[asset],
        );
      }
    }
    const present = MIRRORED_ASSETS.filter((a) => found[a] !== undefined);

    let manifestBytes: Uint8Array;
    try {
      manifestBytes = await this.fetchAssetBytes(manifestAsset);
    } catch (err: unknown) {
      this.log.warn(
        "[tokenleader] binary-mirror: failed to fetch manifest.json",
        String((err as Error)?.message ?? err),
      );
      return;
    }
    const newManifestSha = sha256Hex(manifestBytes);

    // Same manifest as last time → nothing to do.
    if (newManifestSha === this.lastManifestSha) {
      this.log.info("[tokenleader] binary-mirror: manifest unchanged", newManifestSha.slice(0, 12));
      return;
    }

    const tmpPath = (asset: MirroredAsset): string =>
      `${binaryPath(this.cacheDir, asset)}.tmp.${process.pid}`;
    try {
      for (const asset of present) {
        const bytes = await this.fetchAssetBytes(found[asset]!);
        await fsp.writeFile(tmpPath(asset), bytes);
        // Daemons fetch + chmod themselves; we don't need +x here.
      }
    } catch (err: unknown) {
      this.log.warn(
        "[tokenleader] binary-mirror: failed to fetch arch binary",
        String((err as Error)?.message ?? err),
      );
      // Clean up any tmp file we did write before bailing.
      for (const asset of present) {
        try {
          await fsp.unlink(tmpPath(asset));
        } catch {}
      }
      return;
    }

    // Rename binaries first, manifest LAST: a daemon polling /manifest.json
    // sees the new sha only after both binaries are reachable.
    try {
      for (const asset of present) {
        await fsp.rename(tmpPath(asset), binaryPath(this.cacheDir, asset));
      }
      const manifestTmp = `${manifestPath(this.cacheDir)}.tmp.${process.pid}`;
      await fsp.writeFile(manifestTmp, manifestBytes);
      await fsp.rename(manifestTmp, manifestPath(this.cacheDir));
    } catch (err: unknown) {
      this.log.error(
        "[tokenleader] binary-mirror: rename failed mid-swap",
        String((err as Error)?.message ?? err),
      );
      return;
    }

    this.lastManifestSha = newManifestSha;
    this.log.info(
      "[tokenleader] binary-mirror: refreshed",
      `tag=${release.tag_name}`,
      `sha=${newManifestSha.slice(0, 12)}`,
    );

    // Assets the release did NOT carry but the manifest still advertises: the
    // daemons for those platforms will fetch a binary whose sha can't match.
    // Nothing to fix automatically (rewriting the manifest would fork it from
    // the release), so make the gap loud.
    await this.warnUnservableManifestEntries(
      manifestBytes,
      MIRRORED_ASSETS.filter((a) => found[a] === undefined),
    );

    // Regenerate gzip copies for the freshly-swapped binaries.
    await this.ensureGzip();
  }

  /**
   * Log every platform the manifest advertises that this mirror cannot serve.
   *
   * Only reachable for OPTIONAL (linux) assets a release omitted while its
   * manifest still names them — deleting a bad linux asset from a published
   * release is the natural way to un-ship it, and it is exactly the action
   * that produces this state. We do not rewrite or withhold the manifest: the
   * darwin channel is 23 machines and must keep flowing, and a mirror-forked
   * manifest would be worse than a loud log.
   */
  private async warnUnservableManifestEntries(
    manifestBytes: Uint8Array,
    missing: readonly MirroredAsset[],
  ): Promise<void> {
    if (missing.length === 0) return;
    let advertised: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(Buffer.from(manifestBytes).toString("utf8")) as unknown;
      const p = isRecord(parsed) ? parsed.platforms : null;
      if (isRecord(p)) advertised = p;
    } catch {
      return; // unparseable manifest is its own problem; daemons reject it
    }
    for (const asset of missing) {
      const entry = advertised[MANIFEST_PLATFORM_KEY[asset]];
      const want = isRecord(entry) && typeof entry.sha256 === "string" ? entry.sha256 : null;
      if (!want) continue; // not advertised → nothing promised, nothing broken
      let have: string | null = null;
      try {
        have = sha256Hex(await fsp.readFile(binaryPath(this.cacheDir, asset)));
      } catch {
        have = null;
      }
      if (have === want) continue; // an older cycle already cached those bytes
      this.log.error(
        "[tokenleader] binary-mirror: manifest advertises a binary this release does not carry",
        `asset=${GH_ASSET_NAME[asset]}`,
        `want=${want.slice(0, 12)}`,
        `have=${have ? have.slice(0, 12) : "absent"}`,
        "- daemons on that platform will re-download every cycle until the asset is restored",
      );
    }
  }

  /** GitHub's "latest" MARKER endpoint first (vX.Y.Z releases, excludes
   *  drafts/prereleases); 404 → legacy rolling release tagged `latest`. */
  private async fetchLatestRelease(): Promise<GhRelease> {
    const url = `${GITHUB_API}/repos/${this.ghRepo}/releases/latest`;
    const res = await this.fetchImpl(url, { headers: this.ghHeaders() });
    if (res.status === 404) return this.fetchRelease("latest");
    return this.parseReleaseResponse(res, "latest (marker)");
  }

  private async fetchRelease(tag: string): Promise<GhRelease> {
    const url = `${GITHUB_API}/repos/${this.ghRepo}/releases/tags/${tag}`;
    const res = await this.fetchImpl(url, { headers: this.ghHeaders() });
    return this.parseReleaseResponse(res, tag);
  }

  private async parseReleaseResponse(res: Response, label: string): Promise<GhRelease> {
    if (!res.ok) {
      throw new Error(`GitHub release ${label} fetch failed: ${res.status} ${res.statusText}`);
    }
    const json = (await res.json()) as unknown;
    if (!isGhRelease(json)) {
      throw new Error(`GitHub release ${label} response missing tag_name/assets fields`);
    }
    return json;
  }

  private async fetchAssetBytes(asset: GhAsset): Promise<Uint8Array> {
    // asset.url is the API URL (not the browser-download URL); with
    // Accept: octet-stream it returns the raw binary.
    const res = await this.fetchImpl(asset.url, {
      headers: this.ghHeaders({ Accept: "application/octet-stream" }),
    });
    if (!res.ok) {
      throw new Error(`asset ${asset.name} fetch failed: ${res.status} ${res.statusText}`);
    }
    const ab = await res.arrayBuffer();
    return new Uint8Array(ab);
  }
}

// Re-exported for tests.
export const __internal = {
  manifestPath,
  binaryPath,
  gzipPath,
  sha256Hex,
  isGhRelease,
};
