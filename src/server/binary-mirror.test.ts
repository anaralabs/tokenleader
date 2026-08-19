import { afterEach, describe, expect, test } from "bun:test";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { makeTmpDir as mkTmpDir } from "../test-helpers.ts";
import {
  BinaryMirror,
  __internal,
  MIRRORED_ASSETS,
  normalizeArch,
  REQUIRED_ASSETS,
} from "./binary-mirror.ts";

let tmpCleanups: Array<() => Promise<void>> = [];

async function makeTmpDir(): Promise<string> {
  const { dir, cleanup } = await mkTmpDir("tokenleader-mirror-");
  tmpCleanups.push(cleanup);
  return dir;
}

afterEach(async () => {
  await Promise.all(tmpCleanups.map((fn) => fn()));
  tmpCleanups = [];
});

/**
 * Build a fetchImpl stub that maps URLs → Response. Unmapped URLs throw,
 * which surfaces as a "failed fetch" + the mirror returning without
 * swapping anything.
 */
function fakeFetch(handlers: Record<string, () => Response | Promise<Response>>): typeof fetch {
  return (async (input: unknown) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    const h = handlers[url];
    if (!h) {
      throw new Error(`unmapped url in test: ${url}`);
    }
    return h();
  }) as unknown as typeof fetch;
}

const GH_REPO = "example-org/leaderboard";
// GitHub's "latest" MARKER endpoint — tried first.
const MARKER_URL = "https://api.github.com/repos/example-org/leaderboard/releases/latest";
// Legacy rolling release whose literal git tag is "latest" — 404 fallback.
const LEGACY_TAG_URL = "https://api.github.com/repos/example-org/leaderboard/releases/tags/latest";

function releaseJson(
  assets: Array<{ id: number; name: string; url: string }>,
  tag = "latest",
): string {
  return JSON.stringify({ tag_name: tag, assets });
}

function makeMirror(opts: {
  cacheDir: string;
  fetchImpl: typeof fetch;
  errors?: string[];
}): BinaryMirror {
  return new BinaryMirror({
    cacheDir: opts.cacheDir,
    ghRepo: GH_REPO,
    ghToken: "test-token-xyz",
    fetchImpl: opts.fetchImpl,
    initialDelayMs: 0,
    // Logger that swallows everything so test output stays clean.
    log: {
      info: () => {},
      warn: () => {},
      error: (m, ...rest) => opts.errors?.push([m, ...rest.map(String)].join(" ")),
    },
  });
}

describe("normalizeArch", () => {
  test("accepts arm64", () => {
    expect(normalizeArch("arm64")).toBe("arm64");
  });
  test("accepts x64", () => {
    expect(normalizeArch("x64")).toBe("x64");
  });
  test("aliases x86_64 → x64", () => {
    expect(normalizeArch("x86_64")).toBe("x64");
  });
  test("rejects unknown arches", () => {
    expect(normalizeArch("linux-x64")).toBe("linux-x64");
    expect(normalizeArch("linux-arm64")).toBe("linux-arm64");
    // uname -m courtesy aliases for hand-rolled curl users, mirroring the
    // existing x86_64 -> x64 courtesy.
    expect(normalizeArch("linux-x86_64")).toBe("linux-x64");
    expect(normalizeArch("linux-amd64")).toBe("linux-x64");
    expect(normalizeArch("linux-aarch64")).toBe("linux-arm64");
    // The three legacy spellings mean DARWIN forever — fielded daemons build
    // that URL from process.arch.
    expect(normalizeArch("arm64")).toBe("arm64");
    expect(normalizeArch("x86_64")).toBe("x64");
    // …and the platform-qualified darwin spellings resolve to the same two
    // assets, so both platforms can be named the same way by hand. A BARE
    // `x86_64` still means darwin, which is why the qualified form exists.
    expect(normalizeArch("darwin-arm64")).toBe("arm64");
    expect(normalizeArch("darwin-x64")).toBe("x64");
    expect(normalizeArch("riscv")).toBeNull();
    expect(normalizeArch("darwin-x86_64")).toBeNull();
    expect(normalizeArch("")).toBeNull();
    expect(normalizeArch("..")).toBeNull();
    expect(normalizeArch("anara-leaderboard-arm64")).toBeNull();
  });
});

describe("BinaryMirror.tick", () => {
  test("happy path: fetches release, downloads all three assets, writes them atomically", async () => {
    const cacheDir = await makeTmpDir();
    const manifestBytes = new TextEncoder().encode(
      JSON.stringify({
        version: "abcd",
        publishedAt: new Date().toISOString(),
        arm64: { sha256: "a".repeat(64) },
        x64: { sha256: "b".repeat(64) },
      }),
    );
    const armBytes = new TextEncoder().encode("arm64-binary-bytes");
    const x64Bytes = new TextEncoder().encode("x64-binary-bytes");

    const assets = [
      {
        id: 1,
        name: "manifest.json",
        url: "https://api.github.com/repos/example-org/leaderboard/releases/assets/1",
      },
      {
        id: 2,
        name: "anara-leaderboard-arm64",
        url: "https://api.github.com/repos/example-org/leaderboard/releases/assets/2",
      },
      {
        id: 3,
        name: "anara-leaderboard-x64",
        url: "https://api.github.com/repos/example-org/leaderboard/releases/assets/3",
      },
    ];

    const calls: string[] = [];
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      calls.push(url);
      // Validate auth header on every call.
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer test-token-xyz");
      if (url === MARKER_URL) {
        return new Response(releaseJson(assets), { status: 200 });
      }
      if (url === assets[0]!.url) {
        return new Response(manifestBytes, { status: 200 });
      }
      if (url === assets[1]!.url) {
        return new Response(armBytes, { status: 200 });
      }
      if (url === assets[2]!.url) {
        return new Response(x64Bytes, { status: 200 });
      }
      return new Response("nope", { status: 404 });
    }) as unknown as typeof fetch;

    const mirror = makeMirror({ cacheDir, fetchImpl });
    await mirror.tick();

    // The marker endpoint is hit FIRST; the legacy tag URL not at all.
    expect(calls[0]).toBe(MARKER_URL);
    expect(calls).not.toContain(LEGACY_TAG_URL);

    // Files landed atomically.
    const cachedManifest = await fsp.readFile(__internal.manifestPath(cacheDir));
    expect(new Uint8Array(cachedManifest)).toEqual(manifestBytes);
    const cachedArm = await fsp.readFile(__internal.binaryPath(cacheDir, "arm64"));
    expect(new Uint8Array(cachedArm)).toEqual(armBytes);
    const cachedX64 = await fsp.readFile(__internal.binaryPath(cacheDir, "x64"));
    expect(new Uint8Array(cachedX64)).toEqual(x64Bytes);

    // Public API matches.
    const got = mirror.getManifest();
    expect(got).not.toBeNull();
    expect(new Uint8Array(got!)).toEqual(manifestBytes);

    const arch = mirror.getBinary("arm64");
    expect(arch).not.toBeNull();
    expect(arch!.size).toBe(armBytes.byteLength);
  });

  test("second tick with unchanged manifest is a no-op (no binary re-download)", async () => {
    const cacheDir = await makeTmpDir();
    const manifestBytes = new TextEncoder().encode(
      JSON.stringify({
        version: "v1",
        publishedAt: new Date().toISOString(),
        arm64: { sha256: "a".repeat(64) },
        x64: { sha256: "b".repeat(64) },
      }),
    );
    const armBytes = new TextEncoder().encode("arm-binary");
    const x64Bytes = new TextEncoder().encode("x64-binary");
    const assets = [
      { id: 1, name: "manifest.json", url: "https://api.github.com/x/1" },
      {
        id: 2,
        name: "anara-leaderboard-arm64",
        url: "https://api.github.com/x/2",
      },
      {
        id: 3,
        name: "anara-leaderboard-x64",
        url: "https://api.github.com/x/3",
      },
    ];

    const calls: string[] = [];
    const fetchImpl = fakeFetch({
      [MARKER_URL]: () => new Response(releaseJson(assets), { status: 200 }),
      "https://api.github.com/x/1": () => new Response(manifestBytes, { status: 200 }),
      "https://api.github.com/x/2": () => new Response(armBytes, { status: 200 }),
      "https://api.github.com/x/3": () => new Response(x64Bytes, { status: 200 }),
    });
    // Wrap to count calls.
    const wrapped = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      calls.push(url);
      return (fetchImpl as unknown as (i: unknown, x?: RequestInit) => Promise<Response>)(
        input,
        init,
      );
    }) as unknown as typeof fetch;

    const mirror = makeMirror({ cacheDir, fetchImpl: wrapped });
    await mirror.tick();
    const firstCalls = [...calls];
    expect(firstCalls).toContain(MARKER_URL);
    expect(firstCalls).toContain("https://api.github.com/x/2");

    calls.length = 0;
    await mirror.tick();
    // Second tick fetches the release + manifest to compare shas, but
    // does NOT download the arch binaries because the manifest sha is
    // unchanged.
    expect(calls).toContain(MARKER_URL);
    expect(calls).toContain("https://api.github.com/x/1");
    expect(calls).not.toContain("https://api.github.com/x/2");
    expect(calls).not.toContain("https://api.github.com/x/3");
  });

  test("marker endpoint 404 falls back to the legacy tags/latest release", async () => {
    const cacheDir = await makeTmpDir();
    const manifestBytes = new TextEncoder().encode(
      JSON.stringify({
        version: "legacy-1",
        publishedAt: new Date().toISOString(),
        arm64: { sha256: "a".repeat(64) },
        x64: { sha256: "b".repeat(64) },
      }),
    );
    const assets = [
      { id: 1, name: "manifest.json", url: "https://api.github.com/f/1" },
      {
        id: 2,
        name: "anara-leaderboard-arm64",
        url: "https://api.github.com/f/2",
      },
      {
        id: 3,
        name: "anara-leaderboard-x64",
        url: "https://api.github.com/f/3",
      },
    ];
    const calls: string[] = [];
    const inner = fakeFetch({
      // No release has the "latest" marker yet → 404 from the marker endpoint.
      [MARKER_URL]: () => new Response("not found", { status: 404 }),
      [LEGACY_TAG_URL]: () => new Response(releaseJson(assets), { status: 200 }),
      "https://api.github.com/f/1": () => new Response(manifestBytes, { status: 200 }),
      "https://api.github.com/f/2": () => new Response("arm", { status: 200 }),
      "https://api.github.com/f/3": () => new Response("x64", { status: 200 }),
    });
    const wrapped = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      calls.push(url);
      return (inner as unknown as (i: unknown, x?: RequestInit) => Promise<Response>)(input, init);
    }) as unknown as typeof fetch;

    const mirror = makeMirror({ cacheDir, fetchImpl: wrapped });
    await mirror.tick();

    // Marker first, then the legacy tag URL, then the assets.
    expect(calls[0]).toBe(MARKER_URL);
    expect(calls[1]).toBe(LEGACY_TAG_URL);
    const cachedManifest = await fsp.readFile(__internal.manifestPath(cacheDir));
    expect(new Uint8Array(cachedManifest)).toEqual(manifestBytes);
    expect(mirror.getBinary("arm64")).not.toBeNull();
    expect(mirror.getBinary("x64")).not.toBeNull();
  });

  test("linux assets are OPTIONAL: a pre-linux release still mirrors darwin", async () => {
    // The mirror follows the `releases/latest` marker, which routinely points
    // at a release older than the running server image (a rollback, or a
    // server deployed ahead of the next tag). If linux were required, that
    // release would stop mirroring ENTIRELY and take the darwin fleet's
    // update channel down with it.
    const cacheDir = await makeTmpDir();
    const manifestBytes = new TextEncoder().encode('{"version":"v0.6.9"}');
    const assets = [
      { id: 1, name: "manifest.json", url: "https://api.github.com/f/1" },
      { id: 2, name: "anara-leaderboard-arm64", url: "https://api.github.com/f/2" },
      { id: 3, name: "anara-leaderboard-x64", url: "https://api.github.com/f/3" },
    ];
    const mirror = makeMirror({
      cacheDir,
      fetchImpl: fakeFetch({
        [MARKER_URL]: () => new Response(releaseJson(assets, "v0.6.9"), { status: 200 }),
        "https://api.github.com/f/1": () => new Response(manifestBytes, { status: 200 }),
        "https://api.github.com/f/2": () => new Response("arm", { status: 200 }),
        "https://api.github.com/f/3": () => new Response("x64", { status: 200 }),
      }),
    });
    await mirror.tick();

    expect(await fsp.readFile(__internal.manifestPath(cacheDir))).toEqual(
      Buffer.from(manifestBytes),
    );
    expect(mirror.getBinary("arm64")).not.toBeNull();
    expect(mirror.getBinary("x64")).not.toBeNull();
    expect(mirror.getBinary("linux-x64")).toBeNull();
    expect(mirror.getBinary("linux-arm64")).toBeNull();
  });

  test("a manifest advertising an asset the release dropped logs a loud, specific error", async () => {
    // Deleting a bad `tokenleader-linux-x64` from the published release is
    // the natural way to un-ship it — and it leaves the manifest advertising
    // a sha the mirror cannot serve. The darwin channel must keep flowing
    // (23 machines), so the cycle proceeds; the gap has to be LOUD instead,
    // or linux daemons re-download ~34 MB hourly forever with no signal.
    const cacheDir = await makeTmpDir();
    const manifestBytes = new TextEncoder().encode(
      JSON.stringify({
        version: "v0.7.0",
        publishedAt: new Date().toISOString(),
        arm64: { sha256: "a".repeat(64) },
        x64: { sha256: "b".repeat(64) },
        platforms: {
          "darwin-arm64": { sha256: "a".repeat(64) },
          "darwin-x64": { sha256: "b".repeat(64) },
          "linux-x64": { sha256: "c".repeat(64) },
        },
      }),
    );
    const assets = [
      { id: 1, name: "manifest.json", url: "https://api.github.com/f/1" },
      { id: 2, name: "anara-leaderboard-arm64", url: "https://api.github.com/f/2" },
      { id: 3, name: "anara-leaderboard-x64", url: "https://api.github.com/f/3" },
    ];
    const errors: string[] = [];
    const mirror = makeMirror({
      cacheDir,
      errors,
      fetchImpl: fakeFetch({
        [MARKER_URL]: () => new Response(releaseJson(assets, "v0.7.0"), { status: 200 }),
        "https://api.github.com/f/1": () => new Response(manifestBytes, { status: 200 }),
        "https://api.github.com/f/2": () => new Response("arm", { status: 200 }),
        "https://api.github.com/f/3": () => new Response("x64", { status: 200 }),
      }),
    });
    await mirror.tick();

    // Darwin still swapped — the fleet keeps updating.
    expect(mirror.getBinary("arm64")).not.toBeNull();
    expect(await fsp.readFile(__internal.manifestPath(cacheDir))).toEqual(
      Buffer.from(manifestBytes),
    );
    const gap = errors.find((e) => e.includes("does not carry"));
    expect(gap).toBeDefined();
    expect(gap).toContain("tokenleader-linux-x64");
    expect(gap).toContain("absent");
    // linux-arm64 is not advertised at all, so nothing is promised and
    // nothing is logged about it.
    expect(errors.some((e) => e.includes("tokenleader-linux-arm64"))).toBe(false);
  });

  test("a release WITH linux assets mirrors all four under platform-keyed names", async () => {
    const cacheDir = await makeTmpDir();
    const manifestBytes = new TextEncoder().encode('{"version":"v0.7.0"}');
    const assets = [
      { id: 1, name: "manifest.json", url: "https://api.github.com/f/1" },
      { id: 2, name: "anara-leaderboard-arm64", url: "https://api.github.com/f/2" },
      { id: 3, name: "anara-leaderboard-x64", url: "https://api.github.com/f/3" },
      // Linux ships under its CANONICAL release name — no duplicate ~94 MB
      // upload just to give the same bytes a legacy alias.
      { id: 4, name: "tokenleader-linux-x64", url: "https://api.github.com/f/4" },
      { id: 5, name: "tokenleader-linux-arm64", url: "https://api.github.com/f/5" },
    ];
    const mirror = makeMirror({
      cacheDir,
      fetchImpl: fakeFetch({
        [MARKER_URL]: () => new Response(releaseJson(assets, "v0.7.0"), { status: 200 }),
        "https://api.github.com/f/1": () => new Response(manifestBytes, { status: 200 }),
        "https://api.github.com/f/2": () => new Response("darwin-arm", { status: 200 }),
        "https://api.github.com/f/3": () => new Response("darwin-x64", { status: 200 }),
        "https://api.github.com/f/4": () => new Response("linux-x64-bytes", { status: 200 }),
        "https://api.github.com/f/5": () => new Response("linux-arm64-bytes", { status: 200 }),
      }),
    });
    await mirror.tick();

    for (const asset of MIRRORED_ASSETS) {
      expect(mirror.getBinary(asset)).not.toBeNull();
    }
    // Cache filenames ARE the /bin suffixes: darwin keeps the frozen bare
    // arch, linux is platform-keyed.
    expect(await fsp.readFile(path.join(cacheDir, "anara-leaderboard-arm64"), "utf8")).toBe(
      "darwin-arm",
    );
    expect(await fsp.readFile(path.join(cacheDir, "anara-leaderboard-linux-x64"), "utf8")).toBe(
      "linux-x64-bytes",
    );
  });

  test("a MISSING DARWIN asset still bails the whole cycle", async () => {
    const cacheDir = await makeTmpDir();
    await fsp.writeFile(__internal.manifestPath(cacheDir), "previous-manifest");
    const assets = [
      { id: 1, name: "manifest.json", url: "https://api.github.com/f/1" },
      { id: 2, name: "anara-leaderboard-arm64", url: "https://api.github.com/f/2" },
      { id: 4, name: "tokenleader-linux-x64", url: "https://api.github.com/f/4" },
    ];
    const mirror = makeMirror({
      cacheDir,
      fetchImpl: fakeFetch({
        [MARKER_URL]: () => new Response(releaseJson(assets, "v0.7.0"), { status: 200 }),
      }),
    });
    await mirror.tick();

    expect(await fsp.readFile(__internal.manifestPath(cacheDir), "utf8")).toBe("previous-manifest");
    expect(REQUIRED_ASSETS).toEqual(["arm64", "x64"]);
  });

  test("transient GH error: tick swallows error, cache stays untouched", async () => {
    const cacheDir = await makeTmpDir();
    // Pre-populate with a "current" manifest so we can assert it doesn't
    // get clobbered by a failed fetch.
    const oldManifest = "previous-manifest-bytes";
    await fsp.writeFile(__internal.manifestPath(cacheDir), oldManifest);

    const fetchImpl = (async () => {
      throw new Error("ENETUNREACH");
    }) as unknown as typeof fetch;

    const mirror = makeMirror({ cacheDir, fetchImpl });
    // Must not throw.
    await mirror.tick();

    const after = await fsp.readFile(__internal.manifestPath(cacheDir), "utf8");
    expect(after).toBe(oldManifest);
  });

  test("release missing one of the required assets: tick bails without writing", async () => {
    const cacheDir = await makeTmpDir();
    // arm64 missing.
    const assets = [
      { id: 1, name: "manifest.json", url: "https://api.github.com/y/1" },
      {
        id: 3,
        name: "anara-leaderboard-x64",
        url: "https://api.github.com/y/3",
      },
    ];
    const fetchImpl = fakeFetch({
      [MARKER_URL]: () => new Response(releaseJson(assets), { status: 200 }),
    });
    const mirror = makeMirror({ cacheDir, fetchImpl });
    await mirror.tick();
    // No files written.
    const list = await fsp.readdir(cacheDir);
    expect(list).toHaveLength(0);
  });

  test("start() schedules an initial fetch and the setInterval is unref'd", async () => {
    const cacheDir = await makeTmpDir();
    const fetchImpl = fakeFetch({
      [MARKER_URL]: () =>
        new Response(
          releaseJson([
            { id: 1, name: "manifest.json", url: "https://api.github.com/z/1" },
            {
              id: 2,
              name: "anara-leaderboard-arm64",
              url: "https://api.github.com/z/2",
            },
            {
              id: 3,
              name: "anara-leaderboard-x64",
              url: "https://api.github.com/z/3",
            },
          ]),
          { status: 200 },
        ),
      "https://api.github.com/z/1": () =>
        new Response(
          JSON.stringify({
            version: "v",
            publishedAt: "t",
            arm64: { sha256: "a".repeat(64) },
            x64: { sha256: "b".repeat(64) },
          }),
          { status: 200 },
        ),
      "https://api.github.com/z/2": () => new Response("arm", { status: 200 }),
      "https://api.github.com/z/3": () => new Response("x64", { status: 200 }),
    });
    const mirror = new BinaryMirror({
      cacheDir,
      ghRepo: GH_REPO,
      ghToken: "tok",
      fetchImpl,
      initialDelayMs: 5,
      intervalSec: 60,
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });
    await mirror.start();
    // Give the scheduler a moment to fire the initial fetch.
    await new Promise((r) => setTimeout(r, 50));
    // Stop the mirror; otherwise an interval would hold the process open
    // in non-test environments. (.unref makes it not hold in tests.)
    mirror.stop();

    const got = mirror.getManifest();
    expect(got).not.toBeNull();
  });
});

describe("BinaryMirror gzip serving (ensureGzip / getBinaryGzip)", () => {
  test("ensureGzip writes a .gz that decodes back to the raw binary", async () => {
    const { gunzipSync } = await import("node:zlib");
    const cacheDir = await makeTmpDir();
    const raw = new Uint8Array(200_000);
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 7) % 256;
    await fsp.writeFile(__internal.binaryPath(cacheDir, "arm64"), raw);

    const mirror = makeMirror({ cacheDir, fetchImpl: fakeFetch({}) });
    // No .gz yet → getBinaryGzip is null; raw serving is the fallback.
    expect(mirror.getBinaryGzip("arm64")).toBeNull();

    await mirror.ensureGzip();
    const gz = mirror.getBinaryGzip("arm64");
    expect(gz).not.toBeNull();
    expect(gz!.path).toBe(__internal.gzipPath(cacheDir, "arm64"));
    // Decodes byte-for-byte back to the raw binary (sha-equivalence the daemon
    // relies on: it verifies the DECODED bytes against the manifest sha).
    const decoded = gunzipSync(await fsp.readFile(gz!.path));
    expect(decoded.length).toBe(raw.length);
    expect(Buffer.from(decoded).equals(Buffer.from(raw))).toBe(true);
    // A real binary compresses; the .gz must be smaller than the raw.
    expect(gz!.size).toBeLessThan(raw.length);
  });

  test("getBinaryGzip ignores a .gz older than its raw binary (stale)", async () => {
    const cacheDir = await makeTmpDir();
    const rawPath = __internal.binaryPath(cacheDir, "arm64");
    await fsp.writeFile(rawPath, new Uint8Array(50_000));
    const mirror = makeMirror({ cacheDir, fetchImpl: fakeFetch({}) });
    await mirror.ensureGzip();
    expect(mirror.getBinaryGzip("arm64")).not.toBeNull();

    // Age the cached .gz behind its raw binary (simulating a refresh that
    // swapped in a newer raw before ensureGzip regenerated the .gz).
    const past = new Date(Date.now() - 60_000);
    await fsp.utimes(__internal.gzipPath(cacheDir, "arm64"), past, past);
    expect(mirror.getBinaryGzip("arm64")).toBeNull();

    // ensureGzip regenerates the fresher copy.
    await mirror.ensureGzip();
    expect(mirror.getBinaryGzip("arm64")).not.toBeNull();
  });
});
