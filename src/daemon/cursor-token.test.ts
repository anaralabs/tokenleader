import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { makeTmpDirSync } from "../test-helpers.ts";
import {
  CURSOR_CREDENTIALS_FILENAME,
  CURSOR_TOKEN_FILENAME,
  loadCursorCloudAuth,
  loadCursorToken,
  saveCursorCredentials,
  saveCursorToken,
} from "./cursor-token.ts";

describe("cursor-token credential stores", () => {
  test("loadCursorToken prefers cursor_token over stale credentials", async () => {
    const { dir, cleanup } = makeTmpDirSync("cursor-token-priority-");
    try {
      await saveCursorCredentials(dir, {
        sessionToken: "old-session",
        refreshToken: "refresh",
        machineId: "machine",
      });
      await fs.writeFile(join(dir, CURSOR_TOKEN_FILENAME), "fresh-session", { mode: 0o600 });
      expect(await loadCursorToken(dir)).toBe("fresh-session");
      const creds = await fs.readFile(join(dir, CURSOR_CREDENTIALS_FILENAME), "utf8");
      expect(JSON.parse(creds).sessionToken).toBe("old-session");
    } finally {
      cleanup();
    }
  });

  test("saveCursorToken removes stale credentials file", async () => {
    const { dir, cleanup } = makeTmpDirSync("cursor-token-cleanup-");
    try {
      await saveCursorCredentials(dir, {
        sessionToken: "old-session",
        refreshToken: "refresh",
        machineId: "machine",
      });
      await saveCursorToken(dir, "fresh-session");
      expect(await loadCursorToken(dir)).toBe("fresh-session");
      await expect(fs.access(join(dir, CURSOR_CREDENTIALS_FILENAME))).rejects.toThrow();
    } finally {
      cleanup();
    }
  });

  test("loadCursorCloudAuth only attaches refresh material when stores agree", async () => {
    const { dir, cleanup } = makeTmpDirSync("cursor-token-auth-");
    try {
      await saveCursorCredentials(dir, {
        sessionToken: "session-a",
        refreshToken: "refresh-a",
        machineId: "machine-a",
      });
      let auth = await loadCursorCloudAuth(dir);
      expect(auth?.refreshToken).toBe("refresh-a");

      await saveCursorToken(dir, "session-b");
      auth = await loadCursorCloudAuth(dir);
      expect(auth?.sessionToken).toBe("session-b");
      expect(auth?.refreshToken).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("a corrupt credentials file doesn't block a valid cursor_token", async () => {
    const { dir, cleanup } = makeTmpDirSync("cursor-token-corrupt-");
    try {
      await fs.writeFile(join(dir, CURSOR_TOKEN_FILENAME), "good-session", { mode: 0o600 });
      await fs.writeFile(join(dir, CURSOR_CREDENTIALS_FILENAME), "{ truncated", { mode: 0o600 });
      const auth = await loadCursorCloudAuth(dir);
      expect(auth?.sessionToken).toBe("good-session");
      expect(auth?.refreshToken).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("saveCursorCredentials writes both stores atomically", async () => {
    const { dir, cleanup } = makeTmpDirSync("cursor-token-save-");
    try {
      await saveCursorCredentials(dir, {
        sessionToken: "sess",
        refreshToken: "ref",
        machineId: "mid",
        email: "a@b.com",
      });
      expect(await loadCursorToken(dir)).toBe("sess");
      const raw = JSON.parse(await fs.readFile(join(dir, CURSOR_CREDENTIALS_FILENAME), "utf8"));
      expect(raw.sessionToken).toBe("sess");
      expect(raw.email).toBe("a@b.com");
    } finally {
      cleanup();
    }
  });

  test("saveCursorCredentials refreshes the token store, never shadowing fresh creds", async () => {
    const { dir, cleanup } = makeTmpDirSync("cursor-token-rotate-");
    try {
      await saveCursorCredentials(dir, {
        sessionToken: "old-session",
        refreshToken: "old-ref",
        machineId: "mid",
      });
      await saveCursorCredentials(dir, {
        sessionToken: "new-session",
        refreshToken: "new-ref",
        machineId: "mid",
      });
      // cursor_token shadows creds in loadCursorToken — it must track the
      // newest session, and the creds store must agree so refresh material
      // is still attached.
      expect(await loadCursorToken(dir)).toBe("new-session");
      const auth = await loadCursorCloudAuth(dir);
      expect(auth?.sessionToken).toBe("new-session");
      expect(auth?.refreshToken).toBe("new-ref");
    } finally {
      cleanup();
    }
  });
});
