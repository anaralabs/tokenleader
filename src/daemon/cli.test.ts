// `anara-leaderboard link|devices|revoke` — context resolution (env / plist /
// endpoint override / secret file) and the server round-trips, all through
// the DI seams so nothing touches the network or the real LaunchAgent.
import { describe, expect, test } from "bun:test";
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "../test-helpers.ts";
import { CURSOR_USAGE_SUMMARY_API } from "../parser/cursor-api.ts";
import { type CliDeps, parsePlistEnv, runCliCommand } from "./cli.ts";
import { CURSOR_TOKEN_FILENAME, CURSOR_CREDENTIALS_FILENAME } from "./cursor-token.ts";
import { deviceLabelFromHost, ensureCliSymlink } from "./main.ts";

const PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>sh.anara.leaderboard</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>TOKENLEADER_USER</key>
        <string>krish</string>
        <key>TOKENLEADER_ENDPOINT</key>
        <string>https://plist.example.com</string>
        <key>HOME</key>
        <string>/Users/krish</string>
    </dict>
</dict>
</plist>`;

describe("parsePlistEnv", () => {
  test("extracts the ALL-CAPS env entries and skips Label", () => {
    const env = parsePlistEnv(PLIST);
    expect(env.TOKENLEADER_USER).toBe("krish");
    expect(env.TOKENLEADER_ENDPOINT).toBe("https://plist.example.com");
    expect(env.Label).toBeUndefined();
  });
});

describe("deviceLabelFromHost", () => {
  test("lowercases and drops the domain part", () => {
    expect(deviceLabelFromHost("Krishs-MacBook-Pro.local")).toBe("krishs-macbook-pro");
  });
  test("collapses junk and bounds the length", () => {
    expect(deviceLabelFromHost("My Mac!!")).toBe("my-mac");
    expect(deviceLabelFromHost("x".repeat(99))).toBe("x".repeat(32));
  });
  test("nothing left → undefined", () => {
    expect(deviceLabelFromHost("---")).toBeUndefined();
    expect(deviceLabelFromHost("")).toBeUndefined();
  });
});

describe("ensureCliSymlink", () => {
  test("creates `tokenleader` beside the legacy-named binary", async () => {
    const { dir, cleanup } = await makeTmpDir("tokenleader-symlink-");
    try {
      const bin = join(dir, "anara-leaderboard");
      await fsp.writeFile(bin, "#!/bin/sh\n");
      await ensureCliSymlink(bin);
      expect(await fsp.readlink(join(dir, "tokenleader"))).toBe(bin);
      // Idempotent on re-run.
      await ensureCliSymlink(bin);
      expect(await fsp.readlink(join(dir, "tokenleader"))).toBe(bin);
    } finally {
      await cleanup();
    }
  });

  test("never clobbers a real file that owns the name", async () => {
    const { dir, cleanup } = await makeTmpDir("tokenleader-symlink-");
    try {
      const bin = join(dir, "anara-leaderboard");
      await fsp.writeFile(bin, "#!/bin/sh\n");
      await fsp.writeFile(join(dir, "tokenleader"), "someone else's tool");
      await ensureCliSymlink(bin);
      expect(await fsp.readFile(join(dir, "tokenleader"), "utf8")).toBe("someone else's tool");
    } finally {
      await cleanup();
    }
  });

  test("no-op when the binary isn't the legacy-named install (bun run)", async () => {
    const { dir, cleanup } = await makeTmpDir("tokenleader-symlink-");
    try {
      const bin = join(dir, "bun");
      await fsp.writeFile(bin, "");
      await ensureCliSymlink(bin);
      await expect(fsp.lstat(join(dir, "tokenleader"))).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });
});

interface StubCall {
  url: string;
  method: string;
  secret: string | null;
  body: unknown;
}

function makeDeps(opts: {
  stateDir: string;
  responses: Array<{ status: number; json: unknown }>;
  calls: StubCall[];
  env?: NodeJS.ProcessEnv;
}): { deps: CliDeps; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  let i = 0;
  const deps: CliDeps = {
    env: { TOKENLEADER_STATE_DIR: opts.stateDir, ...opts.env },
    readPlist: async () => PLIST,
    fetchImpl: (async (input: unknown, init?: RequestInit) => {
      const req = new Request(input as string, init);
      opts.calls.push({
        url: req.url,
        method: req.method,
        secret: req.headers.get("X-Tokenleader-Secret"),
        body: req.method === "POST" ? await req.json() : null,
      });
      const r = opts.responses[Math.min(i++, opts.responses.length - 1)]!;
      return new Response(JSON.stringify(r.json), {
        status: r.status,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch,
    print: (l) => out.push(l),
    printErr: (l) => err.push(l),
  };
  return { deps, out, err };
}

async function withSecretDir(fn: (stateDir: string) => Promise<void>): Promise<void> {
  const { dir, cleanup } = await makeTmpDir("tokenleader-cli-test-");
  try {
    await fsp.writeFile(join(dir, "secret"), "cli-test-secret\n");
    await fn(dir);
  } finally {
    await cleanup();
  }
}

describe("runCliCommand", () => {
  test("link: resolves user/endpoint from the plist, prints code + command", async () => {
    await withSecretDir(async (stateDir) => {
      const calls: StubCall[] = [];
      const { deps, out } = makeDeps({
        stateDir,
        calls,
        responses: [
          {
            status: 200,
            json: {
              user: "krish",
              code: "ABCD-2345",
              expiresAt: Date.now() + 600_000,
              command: "curl ... --link=ABCD-2345",
            },
          },
        ],
      });
      expect(await runCliCommand("link", [], deps)).toBe(0);
      expect(calls[0]!.url).toBe("https://plist.example.com/devices/link");
      expect(calls[0]!.secret).toBe("cli-test-secret");
      expect(calls[0]!.body).toEqual({ user: "krish" });
      expect(out.join("\n")).toContain("ABCD-2345");
      expect(out.join("\n")).toContain("--link=ABCD-2345");
    });
  });

  test("link: the endpoint override file beats the plist endpoint", async () => {
    await withSecretDir(async (stateDir) => {
      await fsp.writeFile(join(stateDir, "endpoint"), "https://override.example.com\n");
      const calls: StubCall[] = [];
      const { deps } = makeDeps({
        stateDir,
        calls,
        responses: [{ status: 200, json: { code: "X", expiresAt: Date.now(), command: "c" } }],
      });
      expect(await runCliCommand("link", [], deps)).toBe(0);
      expect(calls[0]!.url).toBe("https://override.example.com/devices/link");
    });
  });

  test("devices: lists with ids, labels and the current marker", async () => {
    await withSecretDir(async (stateDir) => {
      const calls: StubCall[] = [];
      const { deps, out } = makeDeps({
        stateDir,
        calls,
        responses: [
          {
            status: 200,
            json: {
              user: "krish",
              devices: [
                {
                  id: 1,
                  label: "mbp",
                  version: "v0.2.0",
                  arch: "arm64",
                  addedAt: 1,
                  lastSeen: Date.now(),
                  current: true,
                },
                {
                  id: 2,
                  label: null,
                  version: null,
                  arch: null,
                  addedAt: 2,
                  lastSeen: null,
                  current: false,
                },
              ],
            },
          },
        ],
      });
      expect(await runCliCommand("devices", [], deps)).toBe(0);
      const text = out.join("\n");
      expect(text).toContain("[1] mbp");
      expect(text).toContain("(this machine)");
      expect(text).toContain("[2] device-2");
    });
  });

  test("revoke: resolves a label to its id and POSTs the revocation", async () => {
    await withSecretDir(async (stateDir) => {
      const calls: StubCall[] = [];
      const { deps, out } = makeDeps({
        stateDir,
        calls,
        responses: [
          {
            status: 200,
            json: {
              user: "krish",
              devices: [
                {
                  id: 7,
                  label: "old-imac",
                  version: null,
                  arch: null,
                  addedAt: 1,
                  lastSeen: null,
                  current: false,
                },
              ],
            },
          },
          { status: 200, json: { ok: true, deviceId: 7, uninstalled: false } },
        ],
      });
      expect(await runCliCommand("revoke", ["old-imac"], deps)).toBe(0);
      expect(calls[1]!.url).toContain("/devices/revoke");
      expect(calls[1]!.body).toEqual({ user: "krish", deviceId: 7 });
      expect(out.join("\n")).toContain("Revoked");
    });
  });

  test("revoke: unknown target is a clean error, no revoke POST", async () => {
    await withSecretDir(async (stateDir) => {
      const calls: StubCall[] = [];
      const { deps, err } = makeDeps({
        stateDir,
        calls,
        responses: [{ status: 200, json: { user: "krish", devices: [] } }],
      });
      expect(await runCliCommand("revoke", ["nope"], deps)).toBe(1);
      expect(calls.length).toBe(1);
      expect(err.join("\n")).toContain("no active device matches");
    });
  });

  test("missing secret file is a clean error pointing at the daemon", async () => {
    const { dir, cleanup } = await makeTmpDir("tokenleader-cli-nosecret-");
    try {
      const calls: StubCall[] = [];
      const { deps, err } = makeDeps({ stateDir: dir, calls, responses: [] });
      expect(await runCliCommand("link", [], deps)).toBe(1);
      expect(err.join("\n")).toContain("no device secret");
      expect(calls.length).toBe(0);
    } finally {
      await cleanup();
    }
  });

  test("server 403 surfaces the server's error text", async () => {
    await withSecretDir(async (stateDir) => {
      const calls: StubCall[] = [];
      const { deps, err } = makeDeps({
        stateDir,
        calls,
        responses: [{ status: 403, json: { error: "secret mismatch for user 'krish'" } }],
      });
      expect(await runCliCommand("link", [], deps)).toBe(1);
      expect(err.join("\n")).toContain("secret mismatch");
    });
  });

  test("login-cursor --auto: extracts, validates, saves credentials, and syncs month", async () => {
    await withSecretDir(async (stateDir) => {
      const calls: StubCall[] = [];
      const { deps, out } = makeDeps({
        stateDir,
        calls,
        responses: [{ status: 200, json: { inserted: 2, duplicates: 0 } }],
      });
      deps.extractCursorSession = async () => ({
        sessionToken: "user_abc::jwt-token",
        email: "alice@example.com",
        machineId: "machine-abc",
        auth: {
          accessToken: "jwt-token",
          refreshToken: "refresh",
          cachedEmail: "alice@example.com",
          serviceMachineId: null,
        },
      });
      expect(await runCliCommand("login-cursor", ["--auto"], deps)).toBe(0);
      const saved = (await fsp.readFile(join(stateDir, CURSOR_TOKEN_FILENAME), "utf8")).trim();
      expect(saved).toBe("user_abc::jwt-token");
      const creds = JSON.parse(
        await fsp.readFile(join(stateDir, CURSOR_CREDENTIALS_FILENAME), "utf8"),
      );
      expect(creds.refreshToken).toBe("refresh");
      expect(creds.machineId).toBe("machine-abc");
      expect(out.join("\n")).toContain("Authenticated as: alice@example.com");
      expect(out.join("\n")).toContain("Synced");
      expect(calls.length).toBe(1);
    });
  });

  test("login-cursor --auto: warns but succeeds when month sync cannot post", async () => {
    await withSecretDir(async (stateDir) => {
      const ingestCalls: unknown[][] = [];
      const out: string[] = [];
      const err: string[] = [];
      const deps: CliDeps = {
        env: { TOKENLEADER_STATE_DIR: stateDir },
        readPlist: async () => PLIST,
        extractCursorSession: async () => ({
          sessionToken: "user_abc::jwt-token",
          email: "alice@example.com",
          machineId: "machine-abc",
          auth: {
            accessToken: "jwt-token",
            refreshToken: "refresh",
            cachedEmail: "alice@example.com",
            serviceMachineId: null,
          },
        }),
        fetchImpl: (async (input: unknown, init?: RequestInit) => {
          const url = String(input);
          if (url.includes("cursor.com")) {
            return new Response(
              JSON.stringify({
                usageEventsDisplay: [
                  {
                    timestamp: "1704067200000",
                    model: "claude-4.5-sonnet",
                    tokenUsage: { inputTokens: 10, outputTokens: 5, totalCents: 1.0 },
                  },
                ],
              }),
              { headers: { "Content-Type": "application/json" } },
            );
          }
          const req = new Request(url, init);
          ingestCalls.push((await req.json()) as unknown[]);
          return new Response(JSON.stringify({ error: "down" }), { status: 403 });
        }) as unknown as typeof fetch,
        print: (l) => out.push(l),
        printErr: (l) => err.push(l),
      };
      expect(await runCliCommand("login-cursor", ["--auto"], deps)).toBe(0);
      expect(out.join("\n")).toContain("Authenticated as: alice@example.com");
      expect(out.join("\n")).toContain("Warning: could not post");
      expect(ingestCalls.length).toBeGreaterThan(0);
    });
  });

  test("login-cursor: validates token, saves cursor_token with 0o600", async () => {
    const { dir, cleanup } = await makeTmpDir("tokenleader-cli-cursor-");
    try {
      const calls: Array<{ url: string; method: string; cookie: string | null }> = [];
      const deps: CliDeps = {
        env: { TOKENLEADER_STATE_DIR: dir },
        fetchImpl: (async (_input: unknown, init?: RequestInit) => {
          const req = new Request(CURSOR_USAGE_SUMMARY_API, init);
          calls.push({
            url: req.url,
            method: req.method,
            cookie: req.headers.get("Cookie"),
          });
          return new Response(JSON.stringify({ membershipType: "pro" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }) as unknown as typeof fetch,
        print: () => {},
        printErr: () => {},
      };
      expect(await runCliCommand("login-cursor", ["session-token-abc"], deps)).toBe(0);
      expect(calls[0]!.method).toBe("GET");
      expect(calls[0]!.cookie).toBe("WorkosCursorSessionToken=session-token-abc");
      const saved = (await fsp.readFile(join(dir, CURSOR_TOKEN_FILENAME), "utf8")).trim();
      expect(saved).toBe("session-token-abc");
      const st = await fsp.stat(join(dir, CURSOR_TOKEN_FILENAME));
      expect(st.mode & 0o777).toBe(0o600);
    } finally {
      await cleanup();
    }
  });

  test("login-cursor: rejects invalid token without writing cursor_token", async () => {
    const { dir, cleanup } = await makeTmpDir("tokenleader-cli-cursor-bad-");
    try {
      const err: string[] = [];
      const deps: CliDeps = {
        env: { TOKENLEADER_STATE_DIR: dir },
        fetchImpl: (async () =>
          new Response("unauthorized", { status: 401 })) as unknown as typeof fetch,
        print: () => {},
        printErr: (l) => err.push(l),
      };
      expect(await runCliCommand("login-cursor", ["bad-token"], deps)).toBe(1);
      expect(err.join("\n")).toContain("session token rejected");
      await expect(fsp.readFile(join(dir, CURSOR_TOKEN_FILENAME), "utf8")).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });

  test("login-cursor: missing token arg is a usage error", async () => {
    const { dir, cleanup } = await makeTmpDir("tokenleader-cli-cursor-usage-");
    try {
      const err: string[] = [];
      const deps: CliDeps = {
        env: { TOKENLEADER_STATE_DIR: dir },
        print: () => {},
        printErr: (l) => err.push(l),
      };
      expect(await runCliCommand("login-cursor", [], deps)).toBe(1);
      expect(err.join("\n")).toContain("usage: tokenleader login-cursor");
      expect(err.join("\n")).toContain("--auto");
    } finally {
      await cleanup();
    }
  });

  test("sync-cursor: full backfill posts events and saves cursorCloud state", async () => {
    await withSecretDir(async (stateDir) => {
      await fsp.writeFile(join(stateDir, "cursor_token"), "session-token\n", { mode: 0o600 });
      const ingestCalls: unknown[][] = [];
      const deps: CliDeps = {
        env: { TOKENLEADER_STATE_DIR: stateDir },
        // Inject the fixture plist so resolveCliContext doesn't read the host's
        // real LaunchAgent (USER/ENDPOINT) — otherwise this passes only on a
        // machine with the daemon installed and fails on a clean CI runner.
        readPlist: async () => PLIST,
        fetchImpl: (async (input: unknown, init?: RequestInit) => {
          const url = String(input);
          if (url.includes("cursor.com")) {
            return new Response(
              JSON.stringify({
                totalUsageEventsCount: 1,
                usageEventsDisplay: [
                  {
                    timestamp: "1704067200000",
                    model: "claude-4.5-sonnet",
                    tokenUsage: { inputTokens: 10, outputTokens: 5, totalCents: 1.0 },
                  },
                ],
              }),
              { headers: { "Content-Type": "application/json" } },
            );
          }
          const req = new Request(url, init);
          ingestCalls.push((await req.json()) as unknown[]);
          return new Response(JSON.stringify({ inserted: 1, duplicates: 0 }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }) as unknown as typeof fetch,
        print: () => {},
        printErr: (l) => err.push(l),
      };
      const err: string[] = [];
      expect(await runCliCommand("sync-cursor", [], deps)).toBe(0);
      expect(ingestCalls.length).toBe(1);
      const state = JSON.parse(await fsp.readFile(join(stateDir, "state.json"), "utf8"));
      expect(state.cursorCloud.fullSyncDone).toBe(true);
      expect(state.cursorCloud.lastSyncAt).toBeGreaterThan(0);
    });
  });

  test("login-cursor -: reads the token from stdin (keeps it out of argv)", async () => {
    await withSecretDir(async (stateDir) => {
      const deps: CliDeps = {
        env: { TOKENLEADER_STATE_DIR: stateDir },
        readStdin: async () => "  piped-session-token\n",
        fetchImpl: (async () =>
          new Response("{}", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })) as unknown as typeof fetch,
        print: () => {},
        printErr: () => {},
      };
      expect(await runCliCommand("login-cursor", ["-"], deps)).toBe(0);
      const saved = await fsp.readFile(join(stateDir, CURSOR_TOKEN_FILENAME), "utf8");
      expect(saved.trim()).toBe("piped-session-token");
    });
  });

  test("sync-cursor: drains a truncated backfill across passes until complete", async () => {
    await withSecretDir(async (stateDir) => {
      await fsp.writeFile(join(stateDir, CURSOR_TOKEN_FILENAME), "session-token\n", {
        mode: 0o600,
      });
      let passes = 0;
      const runSync = (async (o: { state: Record<string, unknown> }) => {
        passes += 1;
        const complete = passes >= 3;
        return {
          state: {
            ...o.state,
            cursorCloud: complete
              ? { lastSyncAt: passes, fullSyncDone: true }
              : { lastSyncAt: passes, resumePage: passes + 1, resumeStartDate: 0 },
          },
          eventsFetched: 10,
          eventsPosted: 10,
          inserted: 10,
          duplicates: 0,
          posted: true,
          skipped: false,
          complete,
          ...(complete ? {} : { nextPage: passes + 1 }),
        };
      }) as unknown as CliDeps["runCursorCloudSync"];
      const deps: CliDeps = {
        env: { TOKENLEADER_STATE_DIR: stateDir },
        readPlist: async () => PLIST,
        runCursorCloudSync: runSync,
        print: () => {},
        printErr: () => {},
      };
      expect(await runCliCommand("sync-cursor", [], deps)).toBe(0);
      expect(passes).toBe(3);
      const state = JSON.parse(await fsp.readFile(join(stateDir, "state.json"), "utf8"));
      expect(state.cursorCloud.fullSyncDone).toBe(true);
    });
  });
});
