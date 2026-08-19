import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { makeTmpDir as mkTmpDir } from "../test-helpers";
import { endpointOverridePath, readEndpointOverride } from "./endpoint-override";
import type { Logger } from "./log";
import {
  __internal,
  BINARY_PATH_PREFIX,
  checkForUpdate,
  emptyManifestCache,
  MANIFEST_PATH,
  type Manifest,
  resolveManifestEntry,
} from "./update";

const ENDPOINT = "https://leaderboard.example.com";
const MANIFEST_URL = `${ENDPOINT}${MANIFEST_PATH}`;

let tmpCleanups: Array<() => Promise<void>> = [];

async function makeTmpDir(): Promise<string> {
  const { dir, cleanup } = await mkTmpDir("tokenleader-update-");
  tmpCleanups.push(cleanup);
  return dir;
}

afterEach(async () => {
  await Promise.all(tmpCleanups.map((fn) => fn()));
  tmpCleanups = [];
});

function makeLog(): { log: Logger; records: { level: string; msg: string }[] } {
  const records: { level: string; msg: string }[] = [];
  const push = (level: string) => (msg: string) => {
    records.push({ level, msg });
  };
  const log: Logger = {
    debug: push("debug"),
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
  };
  return { log, records };
}

function sha(bytes: Uint8Array | string): string {
  const buf = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  return createHash("sha256").update(buf).digest("hex");
}

function manifestFor(arch: "arm64" | "x64", sha256: string): Manifest {
  const otherSha = sha("other-arch-binary");
  const other: { sha256: string } = { sha256: otherSha };
  return {
    version: "abcd123",
    publishedAt: new Date().toISOString(),
    arm64: arch === "arm64" ? { sha256 } : other,
    x64: arch === "x64" ? { sha256 } : other,
  };
}

function mkFetch(handler: (url: string) => Response | Promise<Response>): typeof fetch {
  return (async (input: unknown) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    return handler(url);
  }) as unknown as typeof fetch;
}

/**
 * Stub for the downloadBinary seam (curl in prod): writes `bytes` to dest
 * and records the requested URL into `urls` when given.
 */
function mkDownload(
  bytes: Uint8Array | string,
  urls?: string[],
): (url: string, dest: string) => Promise<string | null> {
  return async (url, dest) => {
    urls?.push(url);
    const buf = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
    await fsp.writeFile(dest, buf);
    return null;
  };
}

describe("checkForUpdate", () => {
  test("up-to-date: returns reason 'up_to_date' and does not restart", async () => {
    const dir = await makeTmpDir();
    const execPath = path.join(dir, "anara-leaderboard");
    const current = new TextEncoder().encode("current-binary-bytes");
    await fsp.writeFile(execPath, current);
    const currentSha = sha(current);
    const manifest = manifestFor("arm64", currentSha);

    let restarted = false;
    const { log } = makeLog();
    const r = await checkForUpdate({
      log,
      endpoint: ENDPOINT,
      execPath,
      arch: "arm64",
      platform: "darwin",
      restart: () => {
        restarted = true;
      },
      fetchImpl: mkFetch((url) => {
        if (url === MANIFEST_URL) {
          return new Response(JSON.stringify(manifest), { status: 200 });
        }
        return new Response("nope", { status: 404 });
      }),
    });

    expect(r.updated).toBe(false);
    expect(r.reason).toBe("up_to_date");
    expect(restarted).toBe(false);
  });

  test("new version: server-served manifest (no url field) → daemon constructs URL from endpoint, swaps, restarts", async () => {
    const dir = await makeTmpDir();
    const execPath = path.join(dir, "anara-leaderboard");
    const oldBytes = new TextEncoder().encode("old-binary");
    await fsp.writeFile(execPath, oldBytes);

    const newBytes = new TextEncoder().encode("new-binary-payload");
    const newSha = sha(newBytes);
    const manifest = manifestFor("x64", newSha);
    const expectedBinaryUrl = `${ENDPOINT}${BINARY_PATH_PREFIX}x64`;

    let restartCalls = 0;
    let swapped: { oldSha: string; newSha: string } | null = null;
    const calledUrls: string[] = [];
    const { log } = makeLog();
    const r = await checkForUpdate({
      log,
      endpoint: ENDPOINT,
      execPath,
      arch: "x64",
      platform: "darwin",
      downloadBinary: mkDownload(newBytes, calledUrls),
      // The fixture "binary" is a text payload, not an executable — skip the
      // real smoke run (it has its own tests below).
      verifyBinary: () => null,
      restart: () => {
        restartCalls++;
      },
      onSwapped: (info) => {
        swapped = info;
      },
      fetchImpl: mkFetch(async (url) => {
        calledUrls.push(url);
        if (url === MANIFEST_URL) {
          return new Response(JSON.stringify(manifest), { status: 200 });
        }
        return new Response("nope", { status: 404 });
      }),
    });

    expect(r.updated).toBe(true);
    expect(r.newSha).toBe(newSha);
    expect(r.oldSha).toBe(sha(oldBytes));
    expect(restartCalls).toBe(1);
    expect(swapped).not.toBeNull();
    expect(calledUrls).toContain(expectedBinaryUrl);

    const onDisk = await fsp.readFile(execPath);
    expect(sha(new Uint8Array(onDisk))).toBe(newSha);

    let tmpExists = true;
    try {
      await fsp.stat(`${execPath}.new`);
    } catch {
      tmpExists = false;
    }
    expect(tmpExists).toBe(false);
  });

  test("manifest with explicit url field takes precedence over endpoint-derived URL", async () => {
    // Compatibility with the historical GH-hosted manifest shape.
    const dir = await makeTmpDir();
    const execPath = path.join(dir, "anara-leaderboard");
    await fsp.writeFile(execPath, new TextEncoder().encode("old"));

    const newBytes = new TextEncoder().encode("new-bytes");
    const newSha = sha(newBytes);
    const customUrl = "https://cdn.example.com/some/path/binary";
    const manifest: Manifest = {
      version: "v1",
      publishedAt: new Date().toISOString(),
      arm64: { sha256: newSha, url: customUrl },
      x64: { sha256: sha("other"), url: "https://cdn.example.com/x64" },
    };

    const calledUrls: string[] = [];
    const { log } = makeLog();
    const r = await checkForUpdate({
      log,
      endpoint: ENDPOINT,
      execPath,
      arch: "arm64",
      platform: "darwin",
      downloadBinary: mkDownload(newBytes, calledUrls),
      verifyBinary: () => null,
      restart: () => {},
      fetchImpl: mkFetch(async (url) => {
        calledUrls.push(url);
        if (url === MANIFEST_URL) {
          return new Response(JSON.stringify(manifest), { status: 200 });
        }
        return new Response("nope", { status: 404 });
      }),
    });

    expect(r.updated).toBe(true);
    expect(calledUrls).toContain(customUrl);
    // It should NOT have fallen back to the endpoint-derived URL when the
    // manifest specified one explicitly.
    expect(calledUrls).not.toContain(`${ENDPOINT}${BINARY_PATH_PREFIX}arm64`);
  });

  test("sha mismatch on downloaded bytes: returns 'sha_mismatch', cleans temp, does NOT restart", async () => {
    const dir = await makeTmpDir();
    const execPath = path.join(dir, "anara-leaderboard");
    const oldBytes = new TextEncoder().encode("old-binary");
    await fsp.writeFile(execPath, oldBytes);

    const claimedSha = sha("what-we-claim");
    const actualBytes = new TextEncoder().encode("but-actually-different");
    const manifest = manifestFor("arm64", claimedSha);

    let restarted = false;
    const { log } = makeLog();
    const r = await checkForUpdate({
      log,
      endpoint: ENDPOINT,
      execPath,
      arch: "arm64",
      platform: "darwin",
      downloadBinary: mkDownload(actualBytes),
      restart: () => {
        restarted = true;
      },
      fetchImpl: mkFetch(async (url) => {
        if (url === MANIFEST_URL) {
          return new Response(JSON.stringify(manifest), { status: 200 });
        }
        return new Response("nope", { status: 404 });
      }),
    });

    expect(r.updated).toBe(false);
    expect(r.reason).toBe("sha_mismatch");
    expect(restarted).toBe(false);

    const onDisk = await fsp.readFile(execPath);
    expect(sha(new Uint8Array(onDisk))).toBe(sha(oldBytes));

    let tmpExists = true;
    try {
      await fsp.stat(`${execPath}.new`);
    } catch {
      tmpExists = false;
    }
    expect(tmpExists).toBe(false);
  });

  test("network failure on manifest fetch: returns 'network_error', does not restart", async () => {
    const dir = await makeTmpDir();
    const execPath = path.join(dir, "anara-leaderboard");
    await fsp.writeFile(execPath, "old");

    let restarted = false;
    const { log } = makeLog();
    const r = await checkForUpdate({
      log,
      endpoint: ENDPOINT,
      execPath,
      arch: "arm64",
      platform: "darwin",
      restart: () => {
        restarted = true;
      },
      fetchImpl: (async () => {
        throw new Error("ENETUNREACH");
      }) as unknown as typeof fetch,
    });

    expect(r.updated).toBe(false);
    expect(r.reason).toBe("network_error");
    expect(restarted).toBe(false);
  });

  test("manifest 5xx: returns 'network_error'", async () => {
    const dir = await makeTmpDir();
    const execPath = path.join(dir, "anara-leaderboard");
    await fsp.writeFile(execPath, "old");

    const { log } = makeLog();
    const r = await checkForUpdate({
      log,
      endpoint: ENDPOINT,
      execPath,
      arch: "arm64",
      platform: "darwin",
      restart: () => {},
      fetchImpl: mkFetch(() => new Response("svc down", { status: 503 })),
    });

    expect(r.updated).toBe(false);
    expect(r.reason).toBe("network_error");
  });

  test("manifest 404: returns 'network_error' (server up but no manifest yet)", async () => {
    const dir = await makeTmpDir();
    const execPath = path.join(dir, "anara-leaderboard");
    await fsp.writeFile(execPath, "old");

    const { log } = makeLog();
    const r = await checkForUpdate({
      log,
      endpoint: ENDPOINT,
      execPath,
      arch: "arm64",
      platform: "darwin",
      restart: () => {},
      fetchImpl: mkFetch(() => new Response("not found", { status: 404 })),
    });

    expect(r.updated).toBe(false);
    expect(r.reason).toBe("network_error");
  });

  test("malformed manifest: returns 'manifest_invalid'", async () => {
    const dir = await makeTmpDir();
    const execPath = path.join(dir, "anara-leaderboard");
    await fsp.writeFile(execPath, "old");

    const { log } = makeLog();
    const r = await checkForUpdate({
      log,
      endpoint: ENDPOINT,
      execPath,
      arch: "arm64",
      platform: "darwin",
      restart: () => {},
      fetchImpl: mkFetch(() => new Response(JSON.stringify({ version: "x" }), { status: 200 })),
    });

    expect(r.updated).toBe(false);
    expect(r.reason).toBe("manifest_invalid");
  });

  test("download failure: retries 3x, returns 'download_failed', does not touch exec", async () => {
    const dir = await makeTmpDir();
    const execPath = path.join(dir, "anara-leaderboard");
    const oldBytes = new TextEncoder().encode("old");
    await fsp.writeFile(execPath, oldBytes);

    const newSha = sha("intended-new");
    const manifest = manifestFor("arm64", newSha);

    let attempts = 0;
    const { log } = makeLog();
    const r = await checkForUpdate({
      log,
      endpoint: ENDPOINT,
      execPath,
      arch: "arm64",
      platform: "darwin",
      downloadBinary: async () => {
        attempts++;
        return "curl exit 22: The requested URL returned error: 404";
      },
      restart: () => {},
      fetchImpl: mkFetch((url) => {
        if (url === MANIFEST_URL) {
          return new Response(JSON.stringify(manifest), { status: 200 });
        }
        return new Response("gone", { status: 404 });
      }),
    });
    expect(r.updated).toBe(false);
    expect(r.reason).toBe("download_failed");
    expect(attempts).toBe(3);
    const onDisk = await fsp.readFile(execPath);
    expect(sha(new Uint8Array(onDisk))).toBe(sha(oldBytes));
  });

  test("v2 dual-shape manifest: extras ignored, consumed via legacy keys", async () => {
    const dir = await makeTmpDir();
    const execPath = path.join(dir, "anara-leaderboard");
    const current = new TextEncoder().encode("current");
    await fsp.writeFile(execPath, current);
    const currentSha = sha(current);

    const manifest = {
      schemaVersion: 2,
      version: "v0.1.0",
      buildSha: "abc1234",
      publishedAt: new Date().toISOString(),
      channel: "stable",
      minServerVersion: "v0.1.0",
      platforms: {
        "darwin-arm64": { sha256: currentSha },
        "darwin-x64": { sha256: sha("x64-bytes") },
      },
      arm64: { sha256: currentSha },
      x64: { sha256: sha("x64-bytes") },
      someFutureField: { whatever: true },
    };

    const { log } = makeLog();
    const r = await checkForUpdate({
      log,
      endpoint: ENDPOINT,
      execPath,
      arch: "arm64",
      platform: "darwin",
      restart: () => {},
      fetchImpl: mkFetch(() => new Response(JSON.stringify(manifest), { status: 200 })),
    });
    expect(r.updated).toBe(false);
    expect(r.reason).toBe("up_to_date");
  });

  test("v2-only platforms manifest validates; legacy consumer reports no_entry_for_arch", async () => {
    // A platforms-only manifest is VALID, but the platforms-map consumer
    // is deferred to v0.2.0 — this daemon finds no legacy entry for its arch.
    const dir = await makeTmpDir();
    const execPath = path.join(dir, "anara-leaderboard");
    await fsp.writeFile(execPath, "old");

    const manifest = {
      schemaVersion: 2,
      version: "v0.2.0",
      publishedAt: new Date().toISOString(),
      platforms: {
        "darwin-arm64": { sha256: sha("a") },
        "darwin-x64": { sha256: sha("b") },
      },
    };

    const { log } = makeLog();
    const r = await checkForUpdate({
      log,
      endpoint: ENDPOINT,
      execPath,
      arch: "arm64",
      platform: "darwin",
      restart: () => {},
      fetchImpl: mkFetch(() => new Response(JSON.stringify(manifest), { status: 200 })),
    });
    expect(r.updated).toBe(false);
    expect(r.reason).toBe("no_entry_for_arch");
  });

  test("garbage manifests are rejected as manifest_invalid", async () => {
    const dir = await makeTmpDir();
    const execPath = path.join(dir, "anara-leaderboard");
    await fsp.writeFile(execPath, "old");

    const garbage: unknown[] = [
      // missing publishedAt
      { version: "v1", arm64: { sha256: sha("a") }, x64: { sha256: sha("b") } },
      // legacy entry with a bad sha
      {
        version: "v1",
        publishedAt: new Date().toISOString(),
        arm64: { sha256: "nothex" },
        x64: { sha256: sha("b") },
      },
      // half-broken legacy pair is garbage even with a valid platforms map
      {
        version: "v1",
        publishedAt: new Date().toISOString(),
        arm64: { sha256: "nothex" },
        platforms: { "darwin-arm64": { sha256: sha("a") } },
      },
      // empty platforms map and no legacy keys
      { version: "v1", publishedAt: new Date().toISOString(), platforms: {} },
      // platforms map with an invalid entry
      {
        version: "v1",
        publishedAt: new Date().toISOString(),
        platforms: { "darwin-arm64": { sha256: "short" } },
      },
      // not an object at all
      "v1",
    ];

    for (const m of garbage) {
      const { log } = makeLog();
      const r = await checkForUpdate({
        log,
        endpoint: ENDPOINT,
        execPath,
        arch: "arm64",
        platform: "darwin",
        platform: "darwin",
        restart: () => {},
        fetchImpl: mkFetch(() => new Response(JSON.stringify(m), { status: 200 })),
      });
      expect(r.updated).toBe(false);
      expect(r.reason).toBe("manifest_invalid");
    }
  });

  test("304 cache: If-None-Match only after a validated body is cached; 304 reuses it", async () => {
    const dir = await makeTmpDir();
    const execPath = path.join(dir, "anara-leaderboard");
    const current = new TextEncoder().encode("current");
    await fsp.writeFile(execPath, current);
    const manifest = manifestFor("arm64", sha(current));

    const inmHeaders: (string | null)[] = [];
    const fetchImpl = (async (input: unknown, init?: unknown) => {
      const req = new Request(input as string, init as RequestInit | undefined);
      const inm = req.headers.get("If-None-Match");
      inmHeaders.push(inm);
      if (inm === '"etag-1"') return new Response(null, { status: 304 });
      return new Response(JSON.stringify(manifest), {
        status: 200,
        headers: { ETag: '"etag-1"' },
      });
    }) as unknown as typeof fetch;

    const cache = emptyManifestCache();
    const { log } = makeLog();
    const opts = {
      log,
      endpoint: ENDPOINT,
      execPath,
      arch: "arm64" as const,
      platform: "darwin",
      restart: () => {},
      cache,
      fetchImpl,
    };

    const r1 = await checkForUpdate(opts);
    expect(r1.reason).toBe("up_to_date");
    const r2 = await checkForUpdate(opts);
    expect(r2.reason).toBe("up_to_date");

    // First call had no cache → no INM; second sent the cached etag and got
    // a 304 whose body came from the cache.
    expect(inmHeaders).toEqual([null, '"etag-1"']);
    expect(cache.etag).toBe('"etag-1"');
    expect(cache.manifest).not.toBeNull();
  });

  test("304 after a failed download retries the download (never strands on up_to_date)", async () => {
    const dir = await makeTmpDir();
    const execPath = path.join(dir, "anara-leaderboard");
    await fsp.writeFile(execPath, "old-binary");

    const newBytes = new TextEncoder().encode("new-binary");
    const newSha = sha(newBytes);
    const manifest = manifestFor("arm64", newSha);
    const binaryUrl = `${ENDPOINT}${BINARY_PATH_PREFIX}arm64`;

    let binaryUp = false;
    let binaryHits = 0;
    const fetchImpl = (async (input: unknown, init?: unknown) => {
      const req = new Request(input as string, init as RequestInit | undefined);
      if (req.url === MANIFEST_URL) {
        if (req.headers.get("If-None-Match") === '"e1"') {
          return new Response(null, { status: 304 });
        }
        return new Response(JSON.stringify(manifest), {
          status: 200,
          headers: { ETag: '"e1"' },
        });
      }
      return new Response("nope", { status: 404 });
    }) as unknown as typeof fetch;

    const cache = emptyManifestCache();
    let restarts = 0;
    const { log } = makeLog();
    const opts = {
      log,
      endpoint: ENDPOINT,
      execPath,
      arch: "arm64" as const,
      platform: "darwin",
      downloadBinary: async (url: string, dest: string) => {
        expect(url).toBe(binaryUrl);
        binaryHits++;
        if (!binaryUp) return "curl exit 22: mirror cold (503)";
        await fsp.writeFile(dest, newBytes);
        return null;
      },
      verifyBinary: () => null,
      restart: () => {
        restarts++;
      },
      cache,
      fetchImpl,
    };

    const r1 = await checkForUpdate(opts);
    expect(r1.reason).toBe("download_failed");
    expect(binaryHits).toBeGreaterThan(0);

    // Next cycle: manifest 304s, but the cached body re-runs the full
    // pipeline and the (now healthy) download succeeds.
    binaryUp = true;
    const r2 = await checkForUpdate(opts);
    expect(r2.updated).toBe(true);
    expect(r2.newSha).toBe(newSha);
    expect(restarts).toBe(1);
  });

  test("canonical-endpoint header: writes override, logs, restarts", async () => {
    const dir = await makeTmpDir();
    const stateDir = await makeTmpDir();
    const execPath = path.join(dir, "anara-leaderboard");
    const current = new TextEncoder().encode("current");
    await fsp.writeFile(execPath, current);
    const manifest = manifestFor("arm64", sha(current));

    let restarts = 0;
    const { log, records } = makeLog();
    const r = await checkForUpdate({
      log,
      endpoint: ENDPOINT,
      execPath,
      arch: "arm64",
      platform: "darwin",
      stateDir,
      cache: emptyManifestCache(),
      restart: () => {
        restarts++;
      },
      fetchImpl: mkFetch(
        () =>
          new Response(JSON.stringify(manifest), {
            status: 200,
            headers: {
              "X-Tokenleader-Canonical-Endpoint": "https://new.example.com/",
            },
          }),
      ),
    });

    expect(r.updated).toBe(false);
    expect(r.reason).toBe("endpoint_override");
    expect(restarts).toBe(1);
    expect(await readEndpointOverride(stateDir)).toBe("https://new.example.com");
    expect(records.some((x) => x.msg === "endpoint_override_active")).toBe(true);
  });

  test("canonical-endpoint equal to the effective endpoint is a no-op", async () => {
    const dir = await makeTmpDir();
    const stateDir = await makeTmpDir();
    const execPath = path.join(dir, "anara-leaderboard");
    const current = new TextEncoder().encode("current");
    await fsp.writeFile(execPath, current);
    const manifest = manifestFor("arm64", sha(current));

    let restarts = 0;
    const { log } = makeLog();
    const r = await checkForUpdate({
      log,
      endpoint: ENDPOINT,
      execPath,
      arch: "arm64",
      platform: "darwin",
      stateDir,
      cache: emptyManifestCache(),
      restart: () => {
        restarts++;
      },
      fetchImpl: mkFetch(
        () =>
          new Response(JSON.stringify(manifest), {
            status: 200,
            // Same endpoint modulo trailing slash → no override.
            headers: { "X-Tokenleader-Canonical-Endpoint": `${ENDPOINT}/` },
          }),
      ),
    });

    expect(r.reason).toBe("up_to_date");
    expect(restarts).toBe(0);
    expect(await readEndpointOverride(stateDir)).toBeNull();
  });

  test("whitespace-padded endpoint matching the canonical endpoint is a no-op", async () => {
    const dir = await makeTmpDir();
    const stateDir = await makeTmpDir();
    const execPath = path.join(dir, "anara-leaderboard");
    const current = new TextEncoder().encode("current");
    await fsp.writeFile(execPath, current);
    const manifest = manifestFor("arm64", sha(current));

    let restarts = 0;
    const { log } = makeLog();
    const r = await checkForUpdate({
      log,
      // Same endpoint modulo surrounding whitespace + trailing slash.
      endpoint: `  ${ENDPOINT}/  `,
      execPath,
      arch: "arm64",
      platform: "darwin",
      stateDir,
      cache: emptyManifestCache(),
      restart: () => {
        restarts++;
      },
      fetchImpl: mkFetch((url) => {
        if (url === MANIFEST_URL) {
          return new Response(JSON.stringify(manifest), {
            status: 200,
            headers: { "X-Tokenleader-Canonical-Endpoint": ENDPOINT },
          });
        }
        return new Response("nope", { status: 404 });
      }),
    });

    expect(r.reason).toBe("up_to_date");
    expect(restarts).toBe(0);
    expect(await readEndpointOverride(stateDir)).toBeNull();
  });

  test("invalid canonical-endpoint values are rejected, update flow continues", async () => {
    const dir = await makeTmpDir();
    const stateDir = await makeTmpDir();
    const execPath = path.join(dir, "anara-leaderboard");
    const current = new TextEncoder().encode("current");
    await fsp.writeFile(execPath, current);
    const manifest = manifestFor("arm64", sha(current));

    for (const bad of ["http://evil.example.com", "not a url"]) {
      let restarts = 0;
      const { log, records } = makeLog();
      const r = await checkForUpdate({
        log,
        endpoint: ENDPOINT,
        execPath,
        arch: "arm64",
        platform: "darwin",
        platform: "darwin",
        stateDir,
        cache: emptyManifestCache(),
        restart: () => {
          restarts++;
        },
        fetchImpl: mkFetch(
          () =>
            new Response(JSON.stringify(manifest), {
              status: 200,
              headers: { "X-Tokenleader-Canonical-Endpoint": bad },
            }),
        ),
      });
      expect(r.reason).toBe("up_to_date");
      expect(restarts).toBe(0);
      expect(records.some((x) => x.msg === "endpoint_override_rejected")).toBe(true);
    }
    expect(await readEndpointOverride(stateDir)).toBeNull();
    // Not even an invalid file was written.
    let exists = true;
    try {
      await fsp.stat(endpointOverridePath(stateDir));
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  test("canonical-endpoint header wins over the in-manifest field", async () => {
    const dir = await makeTmpDir();
    const stateDir = await makeTmpDir();
    const execPath = path.join(dir, "anara-leaderboard");
    const current = new TextEncoder().encode("current");
    await fsp.writeFile(execPath, current);
    const manifest = {
      ...manifestFor("arm64", sha(current)),
      canonicalEndpoint: "https://field.example.com",
    };

    const { log } = makeLog();
    const r = await checkForUpdate({
      log,
      endpoint: ENDPOINT,
      execPath,
      arch: "arm64",
      platform: "darwin",
      stateDir,
      cache: emptyManifestCache(),
      restart: () => {},
      fetchImpl: mkFetch(
        () =>
          new Response(JSON.stringify(manifest), {
            status: 200,
            headers: {
              "X-Tokenleader-Canonical-Endpoint": "https://header.example.com",
            },
          }),
      ),
    });
    expect(r.reason).toBe("endpoint_override");
    expect(await readEndpointOverride(stateDir)).toBe("https://header.example.com");
  });

  test("canonical-endpoint is ignored entirely when no stateDir is configured", async () => {
    const dir = await makeTmpDir();
    const execPath = path.join(dir, "anara-leaderboard");
    const current = new TextEncoder().encode("current");
    await fsp.writeFile(execPath, current);
    const manifest = manifestFor("arm64", sha(current));

    let restarts = 0;
    const { log } = makeLog();
    const r = await checkForUpdate({
      log,
      endpoint: ENDPOINT,
      execPath,
      arch: "arm64",
      platform: "darwin",
      cache: emptyManifestCache(),
      restart: () => {
        restarts++;
      },
      fetchImpl: mkFetch(
        () =>
          new Response(JSON.stringify(manifest), {
            status: 200,
            headers: {
              "X-Tokenleader-Canonical-Endpoint": "https://new.example.com",
            },
          }),
      ),
    });
    expect(r.reason).toBe("up_to_date");
    expect(restarts).toBe(0);
  });

  test("does NOT touch any URL outside the configured endpoint", async () => {
    // Regression guard: the only network dep is the configured endpoint.
    // If anyone re-introduces a gh subprocess or a third-party CDN, this
    // test will fail because the daemon will have hit a URL we didn't mock.
    const dir = await makeTmpDir();
    const execPath = path.join(dir, "anara-leaderboard");
    const current = new TextEncoder().encode("matches");
    await fsp.writeFile(execPath, current);
    const manifest = manifestFor("arm64", sha(current));

    const calledUrls: string[] = [];
    const { log } = makeLog();
    await checkForUpdate({
      log,
      endpoint: ENDPOINT,
      execPath,
      arch: "arm64",
      platform: "darwin",
      restart: () => {},
      fetchImpl: mkFetch((url) => {
        calledUrls.push(url);
        if (url === MANIFEST_URL) {
          return new Response(JSON.stringify(manifest), { status: 200 });
        }
        return new Response("nope", { status: 404 });
      }),
    });

    for (const u of calledUrls) {
      expect(u.startsWith(ENDPOINT)).toBe(true);
    }
  });
});

describe("binary verification", () => {
  test("verify failure: refuses the swap, cleans temp, keeps old binary, no restart", async () => {
    const dir = await makeTmpDir();
    const execPath = path.join(dir, "anara-leaderboard");
    const oldBytes = new TextEncoder().encode("old-binary");
    await fsp.writeFile(execPath, oldBytes);

    const newBytes = new TextEncoder().encode("broken-binary");
    const manifest = manifestFor("arm64", sha(newBytes));

    let restarted = false;
    const { log, records } = makeLog();
    const r = await checkForUpdate({
      log,
      endpoint: ENDPOINT,
      execPath,
      arch: "arm64",
      platform: "darwin",
      downloadBinary: mkDownload(newBytes),
      verifyBinary: () => "exit 3",
      restart: () => {
        restarted = true;
      },
      fetchImpl: mkFetch((url) => {
        if (url === MANIFEST_URL) {
          return new Response(JSON.stringify(manifest), { status: 200 });
        }
        return new Response("nope", { status: 404 });
      }),
    });

    expect(r.updated).toBe(false);
    expect(r.reason).toBe("verify_failed");
    expect(restarted).toBe(false);
    expect(records.some((x) => x.msg === "update_verify_failed" && x.level === "error")).toBe(true);

    // The working binary is untouched and the rejected download is gone.
    const onDisk = await fsp.readFile(execPath);
    expect(sha(new Uint8Array(onDisk))).toBe(sha(oldBytes));
    let tmpExists = true;
    try {
      await fsp.stat(`${execPath}.new`);
    } catch {
      tmpExists = false;
    }
    expect(tmpExists).toBe(false);
  });

  test("defaultVerifyBinary: accepts a binary that exits 0, rejects exit-nonzero and unexecutable", async () => {
    const dir = await makeTmpDir();

    const good = path.join(dir, "good");
    await fsp.writeFile(good, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    expect(__internal.defaultVerifyBinary(good)).toBeNull();

    const bad = path.join(dir, "bad");
    await fsp.writeFile(bad, "#!/bin/sh\nexit 3\n", { mode: 0o755 });
    expect(__internal.defaultVerifyBinary(bad)).toBe("exit 3");

    // Not executable at all (plain text, no shebang, no +x).
    const junk = path.join(dir, "junk");
    await fsp.writeFile(junk, "not a binary", { mode: 0o644 });
    expect(__internal.defaultVerifyBinary(junk)).not.toBeNull();

    expect(__internal.defaultVerifyBinary(path.join(dir, "missing"))).not.toBeNull();
  });
});

describe("defaultDownloadBinary (real curl)", () => {
  test("downloads bytes to dest via curl; 404 reports a curl failure", async () => {
    const dir = await makeTmpDir();
    const payload = new TextEncoder().encode("binary-payload-via-curl");
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const u = new URL(req.url);
        if (u.pathname === "/bin/ok") return new Response(payload);
        return new Response("nope", { status: 404 });
      },
    });
    try {
      const dest = path.join(dir, "downloaded");
      const ok = await __internal.defaultDownloadBinary(
        `http://127.0.0.1:${server.port}/bin/ok`,
        dest,
        30_000,
      );
      expect(ok).toBeNull();
      expect(sha(new Uint8Array(await fsp.readFile(dest)))).toBe(sha(payload));

      const err = await __internal.defaultDownloadBinary(
        `http://127.0.0.1:${server.port}/bin/missing`,
        path.join(dir, "missing"),
        30_000,
      );
      expect(err).not.toBeNull();
      expect(err).toContain("curl exit 22");
    } finally {
      server.stop(true);
    }
  });
});

// The dual-shape resolution contract. darwin is FROZEN on the legacy
// top-level keys; every other platform consumes the v2 `platforms` map.
// Before this split existed, a Linux daemon resolved manifest["arm64"] — the
// MACH-O — sha-matched it (right file, wrong OS), and was saved only by the
// pre-swap smoke test, so Linux never updated. Ever. Reproduced in Docker.
describe("resolveManifestEntry (platform-aware manifest consumption)", () => {
  const darwinArm = { sha256: "a".repeat(64) };
  const darwinX64 = { sha256: "b".repeat(64) };
  const linuxX64 = { sha256: "c".repeat(64) };
  const linuxArm = { sha256: "d".repeat(64) };
  const production: Manifest = {
    schemaVersion: 2,
    version: "v9.9.9",
    publishedAt: new Date().toISOString(),
    platforms: {
      "darwin-arm64": darwinArm,
      "darwin-x64": darwinX64,
      "linux-x64": linuxX64,
      "linux-arm64": linuxArm,
    },
    arm64: darwinArm,
    x64: darwinX64,
  };

  test("darwin reads the legacy keys and NOTHING else", () => {
    expect(resolveManifestEntry(production, "darwin", "arm64")).toBe(darwinArm);
    expect(resolveManifestEntry(production, "darwin", "x64")).toBe(darwinX64);
    // A platforms-only manifest must still resolve to nothing on darwin —
    // that is the frozen v1 consumer behaviour 23 fielded daemons rely on,
    // and widening it would change what a hand-crafted transition manifest
    // does to the live fleet.
    const platformsOnly: Manifest = {
      version: "v9.9.9",
      publishedAt: production.publishedAt,
      platforms: { "darwin-arm64": darwinArm },
    };
    expect(resolveManifestEntry(platformsOnly, "darwin", "arm64")).toBeUndefined();
  });

  test("linux reads platforms[linux-*], never the darwin legacy keys", () => {
    expect(resolveManifestEntry(production, "linux", "x64")).toBe(linuxX64);
    expect(resolveManifestEntry(production, "linux", "arm64")).toBe(linuxArm);
    // The blocker, stated as an assertion: linux must not land on darwin.
    expect(resolveManifestEntry(production, "linux", "arm64")).not.toBe(darwinArm);
    expect(resolveManifestEntry(production, "linux", "x64")).not.toBe(darwinX64);
  });

  test("a malformed platforms entry resolves to NOTHING, not to a bad sha", () => {
    // isManifest short-circuits on the legacy pair, which every published
    // manifest carries — so `platforms` is otherwise never validated, and
    // the linux half of the contract is the only half a Linux daemon reads.
    // An entry like {} used to survive validation and then re-download ~34 MB
    // hourly forever, logging `update_sha_mismatch expected=undefined`.
    const broken = {
      schemaVersion: 2,
      version: "v9.9.9",
      publishedAt: production.publishedAt,
      platforms: {
        "linux-x64": {} as unknown as { sha256: string },
        "linux-arm64": { sha256: 123 } as unknown as { sha256: string },
      },
      arm64: darwinArm,
      x64: darwinX64,
    } as Manifest;
    expect(resolveManifestEntry(broken, "linux", "x64")).toBeUndefined();
    expect(resolveManifestEntry(broken, "linux", "arm64")).toBeUndefined();
    // …while darwin, which never reads that map, is untouched by the rot.
    expect(resolveManifestEntry(broken, "darwin", "arm64")).toBe(darwinArm);
  });

  test("a darwin-only manifest gives linux no entry (fails loud, never swaps a Mach-O)", () => {
    const darwinOnly: Manifest = {
      version: "v9.9.9",
      publishedAt: production.publishedAt,
      arm64: darwinArm,
      x64: darwinX64,
    };
    expect(resolveManifestEntry(darwinOnly, "linux", "arm64")).toBeUndefined();
  });
});

describe("checkForUpdate on linux", () => {
  test("downloads the linux asset described by platforms[linux-arm64]", async () => {
    const dir = await makeTmpDir();
    const execPath = path.join(dir, "anara-leaderboard");
    await fsp.writeFile(execPath, "old-linux-binary");

    const newBytes = new TextEncoder().encode("new-linux-binary");
    const machO = new TextEncoder().encode("a-mach-o-that-must-never-be-fetched");
    const manifest: Manifest = {
      schemaVersion: 2,
      version: "v9.9.9",
      publishedAt: new Date().toISOString(),
      platforms: {
        "darwin-arm64": { sha256: sha(machO) },
        "darwin-x64": { sha256: sha(machO) },
        "linux-arm64": { sha256: sha(newBytes) },
      },
      // Legacy keys mirror darwin, exactly as CI publishes them.
      arm64: { sha256: sha(machO) },
      x64: { sha256: sha(machO) },
    };

    const urls: string[] = [];
    let restarts = 0;
    const { log } = makeLog();
    const r = await checkForUpdate({
      log,
      endpoint: ENDPOINT,
      execPath,
      arch: "arm64",
      platform: "darwin",
      platform: "linux",
      downloadBinary: mkDownload(newBytes, urls),
      verifyBinary: () => null,
      restart: () => {
        restarts++;
      },
      fetchImpl: mkFetch(() => new Response(JSON.stringify(manifest), { status: 200 })),
    });

    expect(r.updated).toBe(true);
    expect(restarts).toBe(1);
    // The platform-keyed asset, NOT /bin/anara-leaderboard-arm64.
    expect(urls).toEqual([`${ENDPOINT}${BINARY_PATH_PREFIX}linux-arm64`]);
    expect(await fsp.readFile(execPath, "utf8")).toBe("new-linux-binary");
  });

  test("a darwin-only manifest is no_entry_for_arch on linux — no download attempted", async () => {
    const dir = await makeTmpDir();
    const execPath = path.join(dir, "anara-leaderboard");
    await fsp.writeFile(execPath, "old-linux-binary");

    const manifest = manifestFor("arm64", sha("something-darwin"));
    const urls: string[] = [];
    const { log, records } = makeLog();
    const r = await checkForUpdate({
      log,
      endpoint: ENDPOINT,
      execPath,
      arch: "arm64",
      platform: "darwin",
      platform: "linux",
      downloadBinary: mkDownload("never", urls),
      restart: () => {},
      fetchImpl: mkFetch(() => new Response(JSON.stringify(manifest), { status: 200 })),
    });

    expect(r.reason).toBe("no_entry_for_arch");
    expect(urls).toEqual([]);
    expect(records.some((x) => x.msg === "update_no_entry_for_arch")).toBe(true);
    // The old binary is untouched.
    expect(await fsp.readFile(execPath, "utf8")).toBe("old-linux-binary");
  });

  test("darwin still resolves the legacy keys when linux entries are also present", async () => {
    const dir = await makeTmpDir();
    const execPath = path.join(dir, "anara-leaderboard");
    await fsp.writeFile(execPath, "old-darwin-binary");

    const darwinBytes = new TextEncoder().encode("new-darwin-binary");
    const linuxBytes = new TextEncoder().encode("new-linux-binary");
    const manifest: Manifest = {
      schemaVersion: 2,
      version: "v9.9.9",
      publishedAt: new Date().toISOString(),
      platforms: {
        "darwin-arm64": { sha256: sha(darwinBytes) },
        "darwin-x64": { sha256: sha(darwinBytes) },
        "linux-arm64": { sha256: sha(linuxBytes) },
        "linux-x64": { sha256: sha(linuxBytes) },
      },
      arm64: { sha256: sha(darwinBytes) },
      x64: { sha256: sha(darwinBytes) },
    };

    const urls: string[] = [];
    const { log } = makeLog();
    const r = await checkForUpdate({
      log,
      endpoint: ENDPOINT,
      execPath,
      arch: "arm64",
      platform: "darwin",
      platform: "darwin",
      downloadBinary: mkDownload(darwinBytes, urls),
      verifyBinary: () => null,
      restart: () => {},
      fetchImpl: mkFetch(() => new Response(JSON.stringify(manifest), { status: 200 })),
    });

    expect(r.updated).toBe(true);
    // The frozen bare-arch asset name, unchanged by the linux entries.
    expect(urls).toEqual([`${ENDPOINT}${BINARY_PATH_PREFIX}arm64`]);
  });
});
