import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  CURSOR_AUTH_KEYS,
  CURSOR_STORAGE_MACHINE_ID_KEY,
  readCursorIdeAuth,
  readCursorMachineId,
} from "./cursor-locator.ts";

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

describe("cursor-locator", () => {
  test("readCursorIdeAuth reads ItemTable keys from a temp database", () => {
    const jwt = "eyJhbGciOiJub25lIn0.eyJzdWIiOiJhdXRoMHx1c2VyX2xvY2FsIn0.sig";
    const dbPath = makeTestVscdb({
      [CURSOR_AUTH_KEYS.accessToken]: jwt,
      [CURSOR_AUTH_KEYS.refreshToken]: "refresh-abc",
      [CURSOR_AUTH_KEYS.cachedEmail]: "alice@example.com",
      [CURSOR_AUTH_KEYS.serviceMachineId]: "machine-1",
    });
    try {
      const auth = readCursorIdeAuth(dbPath, { skipCopy: true });
      expect(auth.accessToken).toBe(jwt);
      expect(auth.refreshToken).toBe("refresh-abc");
      expect(auth.cachedEmail).toBe("alice@example.com");
      expect(auth.serviceMachineId).toBe("machine-1");
    } finally {
      rmSync(join(dbPath, ".."), { recursive: true, force: true });
    }
  });

  test("readCursorMachineId reads telemetry.machineId from storage.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "tokenleader-storage-"));
    const storagePath = join(dir, "storage.json");
    const machineId = "289aedcf3ccf5d3814ed682c26c4076833600e42e397cd1c50d918a335a531a8";
    Bun.write(
      storagePath,
      JSON.stringify({ [CURSOR_STORAGE_MACHINE_ID_KEY]: machineId }),
    );
    try {
      expect(readCursorMachineId(storagePath)).toBe(machineId);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
