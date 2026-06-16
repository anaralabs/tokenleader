import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURSOR_USAGE_SUMMARY_API } from "../parser/cursor-api.ts";
import {
  buildWorkosSessionToken,
  CURSOR_AUTH_USAGE_API,
  CURSOR_OAUTH_TOKEN_API,
  CURSOR_USER_API,
  refreshCursorAccessToken,
  userIdFromJwt,
  verifyCursorAccessToken,
} from "../parser/cursor-auth.ts";
import { CURSOR_AUTH_KEYS } from "../parser/cursor-locator.ts";
import { readCursorIdeAuth } from "../parser/cursor-locator.ts";
import { extractCursorSessionToken } from "./cursor-auto-login.ts";

function makeJwt(sub: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub })).toString("base64url");
  return `${header}.${payload}.sig`;
}

function makeTestVscdb(values: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "tokenleader-vscdb-"));
  const dbPath = join(dir, "state.vscdb");
  execFileSync("sqlite3", [dbPath, "CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);"]);
  for (const [key, value] of Object.entries(values)) {
    execFileSync(
      "sqlite3",
      [
        dbPath,
        `INSERT INTO ItemTable (key, value) VALUES ('${key.replace(/'/g, "''")}', '${value.replace(/'/g, "''")}');`,
      ],
    );
  }
  return dbPath;
}

describe("cursor-auto-login helpers", () => {
  test("userIdFromJwt takes the segment after the provider pipe", () => {
    expect(userIdFromJwt(makeJwt("auth0|user_abc123"))).toBe("user_abc123");
    expect(userIdFromJwt(makeJwt("google-oauth2|user_xyz"))).toBe("user_xyz");
  });

  test("buildWorkosSessionToken joins user id and access token", () => {
    const jwt = makeJwt("auth0|user_test");
    expect(buildWorkosSessionToken(jwt)).toBe(`user_test::${jwt}`);
  });

  test("readCursorIdeAuth reads ItemTable keys from a temp database", () => {
    const jwt = makeJwt("auth0|user_local");
    const dbPath = makeTestVscdb({
      [CURSOR_AUTH_KEYS.accessToken]: jwt,
      [CURSOR_AUTH_KEYS.refreshToken]: "refresh-abc",
      [CURSOR_AUTH_KEYS.serviceMachineId]: "machine-1",
    });
    try {
      const auth = readCursorIdeAuth(dbPath, { skipCopy: true });
      expect(auth.accessToken).toBe(jwt);
      expect(auth.refreshToken).toBe("refresh-abc");
      expect(auth.serviceMachineId).toBe("machine-1");
    } finally {
      rmSync(join(dbPath, ".."), { recursive: true, force: true });
    }
  });
});

describe("cursor-auto-login network flow", () => {
  test("verifyCursorAccessToken returns false on 401", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
    await expect(verifyCursorAccessToken("jwt", { fetchImpl })).resolves.toBe(false);
  });

  test("refreshCursorAccessToken posts to oauth/token", async () => {
    const jwt = makeJwt("auth0|user_fresh");
    const calls: Array<{ url: string; body: string }> = [];
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      calls.push({ url: String(input), body: String(init?.body ?? "") });
      return new Response(JSON.stringify({ access_token: jwt, shouldLogout: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const out = await refreshCursorAccessToken("old-refresh", { fetchImpl });
    expect(out).toBe(jwt);
    expect(calls[0]!.url).toBe(CURSOR_OAUTH_TOKEN_API);
    expect(JSON.parse(calls[0]!.body)).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "old-refresh",
    });
  });

  test("extractCursorSessionToken refreshes expired access tokens and fetches email", async () => {
    const stale = makeJwt("auth0|user_stale");
    const fresh = makeJwt("auth0|user_fresh");
    const dbPath = makeTestVscdb({
      [CURSOR_AUTH_KEYS.accessToken]: stale,
      [CURSOR_AUTH_KEYS.refreshToken]: "refresh-token",
    });
    const storageDir = mkdtempSync(join(tmpdir(), "tokenleader-storage-"));
    const storagePath = join(storageDir, "storage.json");
    const machineId = "289aedcf3ccf5d3814ed682c26c4076833600e42e397cd1c50d918a335a531a8";
    Bun.write(storagePath, JSON.stringify({ "telemetry.machineId": machineId }));

    const authCalls: string[] = [];
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const req = new Request(url, init);
      const auth = req.headers.get("Authorization");
      if (url === CURSOR_AUTH_USAGE_API) {
        authCalls.push(auth ?? "");
        if (auth === `Bearer ${stale}`) return new Response("", { status: 401 });
        if (auth === `Bearer ${fresh}`) return new Response("{}", { status: 200 });
      }
      if (url === CURSOR_OAUTH_TOKEN_API) {
        return new Response(JSON.stringify({ access_token: fresh, shouldLogout: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === CURSOR_USAGE_SUMMARY_API) {
        return new Response(JSON.stringify({ membershipType: "pro" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === CURSOR_USER_API) {
        return new Response(JSON.stringify({ email: "alice@example.com" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("unexpected", { status: 500 });
    }) as unknown as typeof fetch;

    try {
      const { sessionToken, email, machineId: mid } = await extractCursorSessionToken({
        dbPath,
        storageJsonPath: storagePath,
        skipCopy: true,
        fetchImpl,
      });
      expect(sessionToken).toBe(`user_fresh::${fresh}`);
      expect(email).toBe("alice@example.com");
      expect(mid).toBe(machineId);
      expect(authCalls).toEqual([`Bearer ${stale}`, `Bearer ${fresh}`]);
    } finally {
      rmSync(join(dbPath, ".."), { recursive: true, force: true });
      rmSync(storageDir, { recursive: true, force: true });
    }
  });
});
