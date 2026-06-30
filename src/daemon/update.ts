// Silent self-update for the daemon.
//
// Flow: GET <endpoint>/manifest.json, compare the manifest sha256 for our
// arch against the SHA-256 of the running binary; if different, download
// /bin/anara-leaderboard-<arch>, sha-verify, atomically rename it over
// `execPath`, then relaunch via `launchctl kickstart -k`.
//
// Updates come from the daemon's OWN server, never GitHub: a single network
// dependency (if /ingest is reachable, updates are reachable) and no gh CLI
// or GitHub auth needed at runtime.
//
// Double-count safety: the server dedups events via a UNIQUE index +
// INSERT … ON CONFLICT DO NOTHING; state.json lives in a different directory
// from the binary and is written atomically, so after an update-driven
// restart the daemon resumes from each file's stored byteOffset.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";
import {
  isAcceptableEndpoint,
  normalizeEndpoint,
  writeEndpointOverride,
} from "./endpoint-override";
import type { Logger } from "./log";

export const LAUNCHD_LABEL = "sh.anara.leaderboard";

// Wall-clock fetch budgets. See transport.ts fetchWithTimeout for why a bare
// AbortSignal is insufficient in Bun 1.1.38 (connect-phase hangs ignore it).
const UPDATE_FETCH_TIMEOUT_MS = 20_000; // manifest GET
// Binary GET. The server serves /bin gzip-compressed (~24 MB), but this is the
// hard cap on the WHOLE download, so it must clear the worst real-world link:
// the old 120s stranded the fleet when the binary grew past what a slow
// connection could pull in two minutes (see the v0.5.x fleet-stuck incident).
// 600s tolerates links down to ~40 KB/s for the compressed payload; a partial
// download is sha-rejected, never executed, so a generous budget is free.
const UPDATE_BINARY_TIMEOUT_MS = 600_000;

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  shutdown?: AbortSignal,
): Promise<Response> {
  const ac = new AbortController();
  const onShutdown = () => ac.abort();
  if (shutdown) {
    if (shutdown.aborted) ac.abort();
    else shutdown.addEventListener("abort", onShutdown, { once: true });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wall = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      reject(new Error(`fetch timeout after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return (await Promise.race([fetchImpl(url, { ...init, signal: ac.signal }), wall])) as Response;
  } finally {
    if (timer) clearTimeout(timer);
    shutdown?.removeEventListener("abort", onShutdown);
  }
}

// Path components. Absolute URL is built from cfg.endpoint at call-time;
// the server's BinaryMirror serves both routes. The daemon never talks to
// GitHub for updates.
export const MANIFEST_PATH = "/manifest.json";
export const BINARY_PATH_PREFIX = "/bin/anara-leaderboard-";

export type ManifestArch = "arm64" | "x64";

export interface ManifestEntry {
  // Optional: the daemon constructs the URL from
  // `endpoint + BINARY_PATH_PREFIX + arch`; `url` is accepted for
  // compatibility with older manifest shapes.
  url?: string;
  sha256: string;
}

// Dual-shape manifest. The legacy top-level arm64/x64 keys are frozen and
// remain what this daemon CONSUMES; the v2 fields (platforms map et al.) are
// validated when present but not yet consumed. Unknown fields are ignored.
export interface Manifest {
  version: string;
  publishedAt: string;
  // Legacy v1 keys — byte-equal mirrors of platforms["darwin-*"] in
  // CI-published manifests.
  arm64?: ManifestEntry;
  x64?: ManifestEntry;
  // v2 additive fields.
  schemaVersion?: number;
  buildSha?: string;
  channel?: string;
  minServerVersion?: string;
  // Honored only when present in the upstream (signed) manifest bytes; the
  // X-Tokenleader-Canonical-Endpoint response header wins over this field.
  canonicalEndpoint?: string;
  platforms?: Record<string, ManifestEntry>;
}

/**
 * In-memory `{etag, manifest}` cache for /manifest.json.
 * `If-None-Match` is sent only when a previously VALIDATED body is cached;
 * a 304 re-runs the full pipeline on the cached body so a failed binary
 * download retries every cycle instead of stranding on "up_to_date".
 * In-memory only — a daemon restart just refetches a <1KB file.
 */
export interface ManifestCache {
  etag: string | null;
  manifest: Manifest | null;
}

export function emptyManifestCache(): ManifestCache {
  return { etag: null, manifest: null };
}

const defaultManifestCache: ManifestCache = emptyManifestCache();

export type UpdateReason =
  | "up_to_date"
  | "disabled"
  | "network_error"
  | "manifest_invalid"
  | "no_entry_for_arch"
  | "sha_mismatch"
  | "download_failed"
  | "write_failed"
  | "rename_failed"
  | "endpoint_override";

export interface UpdateResult {
  updated: boolean;
  reason?: UpdateReason;
  oldSha?: string;
  newSha?: string;
}

export interface UpdateOpts {
  log: Logger;
  abortSignal?: AbortSignal;
  /**
   * Base URL of the server (same as TOKENLEADER_ENDPOINT). The daemon hits
   * `${endpoint}/manifest.json` and `${endpoint}/bin/<arch>`.
   * Required: the caller is responsible for plumbing this through.
   */
  endpoint: string;
  /**
   * State dir holding the `endpoint` override file. When unset, the
   * X-Tokenleader-Canonical-Endpoint header (and the in-manifest field)
   * is ignored entirely.
   */
  stateDir?: string;
  /**
   * Manifest etag cache. Defaults to a module-level singleton shared across
   * cycles; tests inject their own to stay isolated.
   */
  cache?: ManifestCache;
  // Test seams. Real callers leave these undefined.
  fetchImpl?: typeof fetch;
  execPath?: string;
  arch?: ManifestArch;
  // Triggered after a successful swap (or an accepted endpoint override).
  // Default: launchctl kickstart + exit.
  restart?: () => void;
  // Hook the moment we successfully wrote the new binary (used in tests).
  onSwapped?: (info: { oldSha: string; newSha: string }) => void;
}

export function pickArch(): ManifestArch {
  return process.arch === "arm64" ? "arm64" : "x64";
}

function isManifestEntry(e: unknown): e is ManifestEntry {
  if (!e || typeof e !== "object") return false;
  const entry = e as Record<string, unknown>;
  // url is optional in the new shape.
  if (entry.url !== undefined && typeof entry.url !== "string") return false;
  return typeof entry.sha256 === "string" && /^[0-9a-f]{64}$/i.test(entry.sha256);
}

// Tolerant dual-shape validator: a manifest is valid when it carries the
// frozen legacy {arm64,x64} pair, OR a v2 platforms map with at least one
// valid entry. When the legacy keys are present at all, BOTH must be valid —
// a half-broken legacy pair is garbage, not a v2 manifest. Consumption stays
// legacy-keys-only: a platforms-only manifest validates but resolves to
// `no_entry_for_arch` below.
function isManifest(value: unknown): value is Manifest {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.version !== "string") return false;
  if (typeof v.publishedAt !== "string") return false;
  if (v.arm64 !== undefined || v.x64 !== undefined) {
    return isManifestEntry(v.arm64) && isManifestEntry(v.x64);
  }
  const p = v.platforms;
  if (!p || typeof p !== "object" || Array.isArray(p)) return false;
  const entries = Object.values(p);
  return entries.length > 0 && entries.every(isManifestEntry);
}

async function sha256OfFile(p: string): Promise<string> {
  const buf = await fsp.readFile(p);
  return createHash("sha256").update(buf).digest("hex");
}

function sha256OfBytes(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

function defaultRestart(log: Logger): void {
  const uid = process.getuid?.() ?? 0;
  const target = `gui/${uid}/${LAUNCHD_LABEL}`;
  try {
    const child = spawn("launchctl", ["kickstart", "-k", target], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    log.info("update_restart_dispatched", { target });
  } catch (err: unknown) {
    log.warn("update_restart_spawn_failed", {
      err: String((err as Error)?.message ?? err),
    });
  }
  // Give launchctl a moment to send SIGTERM, then exit. The plist now sets
  // unconditional `KeepAlive: true`, so this clean exit(0) is by itself enough
  // for launchd to respawn us — kickstart -k is just the faster path. The old
  // {Crashed,SuccessfulExit:false} plist did NOT respawn on a clean exit, so a
  // kickstart that raced the 30s ThrottleInterval left the daemon dead until
  // the next login (the v0.5.x fleet-stuck incident; older plists are repaired
  // on boot by plist-heal.ts).
  setTimeout(() => {
    process.exit(0);
  }, 200).unref?.();
}

/**
 * Check the manifest, swap the binary if a new version is published, and
 * trigger a relaunch. Safe to call concurrently with nothing else (the
 * daemon loop in main.ts must NOT run a tick while this runs — caller is
 * responsible for that gating).
 *
 * Never throws. All errors are turned into `{ updated: false, reason: … }`.
 */
export async function checkForUpdate(opts: UpdateOpts): Promise<UpdateResult> {
  const log = opts.log;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const execPath = opts.execPath ?? process.execPath;
  const arch = opts.arch ?? pickArch();
  const base = normalizeEndpoint(opts.endpoint);
  const cache = opts.cache ?? defaultManifestCache;

  if (opts.abortSignal?.aborted) {
    return { updated: false, reason: "disabled" };
  }

  // 1. Fetch manifest from the server. If-None-Match only rides along when
  // a previously validated body is cached; on 304 we reuse that body and
  // run the FULL pipeline from the sha-compare step — never short-circuit
  // to up_to_date, or a failed binary download would strand the update
  // until the NEXT release changes the manifest bytes.
  const manifestUrl = `${base}${MANIFEST_PATH}`;
  let manifest: Manifest;
  let manifestRes: Response;
  try {
    const headers: Record<string, string> = { "Cache-Control": "no-cache" };
    if (cache.manifest && cache.etag) {
      headers["If-None-Match"] = cache.etag;
    }
    const res = await fetchWithTimeout(
      fetchImpl,
      manifestUrl,
      { method: "GET", headers },
      UPDATE_FETCH_TIMEOUT_MS,
      opts.abortSignal,
    );
    if (res.status === 304 && cache.manifest) {
      log.debug("update_manifest_304", { url: manifestUrl });
      manifest = cache.manifest;
    } else if (!res.ok) {
      // 404 means the server is up but doesn't have a manifest yet
      // (fresh deploy, sync hasn't run). Same response shape as any other
      // HTTP error — caller decides what's interesting in logs. A stray
      // 304 without a cached body lands here too.
      log.warn("update_manifest_http", { status: res.status, url: manifestUrl });
      return { updated: false, reason: "network_error" };
    } else {
      const parsed = (await res.json()) as unknown;
      if (!isManifest(parsed)) {
        log.warn("update_manifest_invalid", {});
        return { updated: false, reason: "manifest_invalid" };
      }
      manifest = parsed;
      cache.etag = res.headers.get("etag");
      cache.manifest = manifest;
    }
    manifestRes = res;
  } catch (err: unknown) {
    // Network failures are non-fatal; we'll try again next interval.
    log.debug("update_manifest_fetch_failed", {
      url: manifestUrl,
      err: String((err as Error)?.message ?? err),
    });
    return { updated: false, reason: "network_error" };
  }

  // 1b. Operator-driven endpoint migration. Only honored
  // after the manifest validated; the response header (read on 200 AND 304)
  // wins over the in-manifest field. An accepted value is persisted to
  // <stateDir>/endpoint and the daemon restarts so boot-time precedence
  // (override file > env) picks it up.
  const canonicalRaw =
    manifestRes.headers.get("x-tokenleader-canonical-endpoint") ?? manifest.canonicalEndpoint;
  if (canonicalRaw && opts.stateDir) {
    const canonical = normalizeEndpoint(canonicalRaw);
    if (!isAcceptableEndpoint(canonical)) {
      log.warn("endpoint_override_rejected", { value: canonicalRaw });
    } else if (canonical !== base) {
      try {
        await writeEndpointOverride(opts.stateDir, canonical);
        log.info("endpoint_override_active", { from: base, to: canonical });
        const restartForOverride = opts.restart ?? (() => defaultRestart(log));
        restartForOverride();
        return { updated: false, reason: "endpoint_override" };
      } catch (err: unknown) {
        // Fall through to the normal update flow; we'll retry the write
        // next cycle.
        log.warn("endpoint_override_write_failed", {
          err: String((err as Error)?.message ?? err),
        });
      }
    }
  }

  const entry = manifest[arch];
  if (!entry) {
    log.warn("update_no_entry_for_arch", { arch });
    return { updated: false, reason: "no_entry_for_arch" };
  }

  // 2. SHA of running binary.
  let currentSha: string;
  try {
    currentSha = await sha256OfFile(execPath);
  } catch (err: unknown) {
    log.warn("update_current_sha_failed", {
      execPath,
      err: String((err as Error)?.message ?? err),
    });
    return { updated: false, reason: "network_error" };
  }

  if (currentSha.toLowerCase() === entry.sha256.toLowerCase()) {
    log.debug("update_up_to_date", {
      version: manifest.version,
      sha: currentSha,
    });
    return { updated: false, reason: "up_to_date", oldSha: currentSha };
  }

  log.info("update_available", {
    version: manifest.version,
    currentSha,
    newSha: entry.sha256,
    arch,
  });

  // 3. Download the new binary. Prefer the manifest's `url` field if
  // present (so historical / external manifests still work), otherwise
  // construct from the same server endpoint.
  const binaryUrl =
    entry.url && entry.url.length > 0 ? entry.url : `${base}${BINARY_PATH_PREFIX}${arch}`;

  // 3b. STREAM the new binary straight to a temp file via Bun.write rather
  // than buffering with res.arrayBuffer(): the binary is large (~55MB) and
  // arrayBuffer() aborts a slow response (~44s observed) that a streamed
  // write rides out. Retry to absorb transient resets; whatever lands is
  // sha-verified below before any swap, so a partial/corrupt file is never
  // executed.
  const tmpPath = `${execPath}.new`;
  const DOWNLOAD_ATTEMPTS = 3;
  let downloadOk = false;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
    if (opts.abortSignal?.aborted) return { updated: false, reason: "disabled" };
    try {
      const res = await fetchWithTimeout(
        fetchImpl,
        binaryUrl,
        { method: "GET" },
        UPDATE_BINARY_TIMEOUT_MS,
        opts.abortSignal,
      );
      if (!res.ok) {
        log.warn("update_download_http", {
          status: res.status,
          url: binaryUrl,
          attempt,
        });
        continue;
      }
      await Bun.write(tmpPath, res);
      downloadOk = true;
      break;
    } catch (err: unknown) {
      log.warn("update_download_threw", {
        url: binaryUrl,
        attempt,
        err: String((err as Error)?.message ?? err),
      });
    }
  }
  if (!downloadOk) {
    try {
      await fsp.unlink(tmpPath);
    } catch {}
    return { updated: false, reason: "download_failed" };
  }

  // 4. Verify SHA of the downloaded file (rejects partial/corrupt downloads).
  let dlSha: string;
  try {
    dlSha = await sha256OfFile(tmpPath);
  } catch (err: unknown) {
    log.error("update_tmp_read_failed", {
      tmpPath,
      err: String((err as Error)?.message ?? err),
    });
    try {
      await fsp.unlink(tmpPath);
    } catch {}
    return { updated: false, reason: "download_failed" };
  }
  if (dlSha.toLowerCase() !== entry.sha256.toLowerCase()) {
    log.error("update_sha_mismatch", {
      expected: entry.sha256,
      actual: dlSha,
    });
    try {
      await fsp.unlink(tmpPath);
    } catch {}
    return { updated: false, reason: "sha_mismatch" };
  }

  // 5. chmod, strip quarantine, rename atomically.
  try {
    await fsp.chmod(tmpPath, 0o755);
  } catch (err: unknown) {
    log.error("update_tmp_write_failed", {
      tmpPath,
      err: String((err as Error)?.message ?? err),
    });
    try {
      await fsp.unlink(tmpPath);
    } catch {}
    return { updated: false, reason: "write_failed" };
  }

  // macOS quarantine xattr can prevent execution if the bytes arrived via
  // browser-style download. `bun build --compile` outputs are already
  // ad-hoc signed, so `xattr -cr` is enough — never re-sign.
  try {
    spawnSync("xattr", ["-cr", tmpPath], { stdio: "ignore" });
  } catch {
    // Non-fatal; rename still proceeds.
  }

  try {
    await fsp.rename(tmpPath, execPath);
  } catch (err: unknown) {
    log.error("update_rename_failed", {
      from: tmpPath,
      to: execPath,
      err: String((err as Error)?.message ?? err),
    });
    try {
      await fsp.unlink(tmpPath);
    } catch {}
    return { updated: false, reason: "rename_failed" };
  }

  log.info("update_swapped", {
    version: manifest.version,
    oldSha: currentSha,
    newSha: dlSha,
    arch,
    execPath,
  });
  opts.onSwapped?.({ oldSha: currentSha, newSha: dlSha });

  // 6. Restart. Default path calls launchctl + process.exit(0); tests
  // override this so they don't kill the test runner.
  const restart = opts.restart ?? (() => defaultRestart(log));
  restart();

  return {
    updated: true,
    oldSha: currentSha,
    newSha: dlSha,
  };
}

// Exported for tests / future tooling.
export const __internal = {
  isManifest,
  sha256OfBytes,
  sha256OfFile,
  pickArch,
  defaultRestart,
  manifestPathLocal: (dir: string) => path.join(dir, "manifest.json"),
};
