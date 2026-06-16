import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { getCursorGlobalStorageDir, getCursorStateDbPath } from "./index.ts";

export const CURSOR_AUTH_KEYS = {
  accessToken: "cursorAuth/accessToken",
  refreshToken: "cursorAuth/refreshToken",
  cachedEmail: "cursorAuth/cachedEmail",
  serviceMachineId: "storage.serviceMachineId",
} as const;

export const CURSOR_STORAGE_MACHINE_ID_KEY = "telemetry.machineId";

export interface CursorIdeAuth {
  accessToken: string;
  refreshToken: string;
  cachedEmail: string | null;
  serviceMachineId: string | null;
}

export interface ReadCursorIdeAuthOptions {
  /** Test seam — query the given path directly without copying. */
  skipCopy?: boolean;
}

function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

function requireSqlite3Cli(): void {
  try {
    execFileSync("sqlite3", ["-version"], { stdio: "ignore" });
  } catch {
    throw new Error("sqlite3 CLI not found (ships with macOS)");
  }
}

function withTempDbCopy<T>(sourcePath: string, fn: (copyPath: string) => T): T {
  const dir = mkdtempSync(path.join(tmpdir(), "tokenleader-cursor-auth-"));
  const copyPath = path.join(dir, "state.vscdb");
  try {
    copyFileSync(sourcePath, copyPath);
    // Copy the WAL/SHM sidecars too — without them sqlite3 reads only the
    // committed main DB and misses writes Cursor just made to the WAL.
    for (const suffix of ["-wal", "-shm"] as const) {
      const sidecar = `${sourcePath}${suffix}`;
      if (existsSync(sidecar)) copyFileSync(sidecar, `${copyPath}${suffix}`);
    }
    return fn(copyPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function queryItemTable(dbPath: string, key: string): string | null {
  const sql = `SELECT value FROM ItemTable WHERE key = '${escapeSqlString(key)}';`;
  const out = execFileSync("sqlite3", [dbPath, sql], { encoding: "utf8" }).trim();
  return out.length > 0 ? out : null;
}

function readFromDb(dbPath: string): CursorIdeAuth {
  const accessToken = queryItemTable(dbPath, CURSOR_AUTH_KEYS.accessToken);
  const refreshToken = queryItemTable(dbPath, CURSOR_AUTH_KEYS.refreshToken);
  const cachedEmail = queryItemTable(dbPath, CURSOR_AUTH_KEYS.cachedEmail);
  const serviceMachineId = queryItemTable(dbPath, CURSOR_AUTH_KEYS.serviceMachineId);
  if (!accessToken) {
    throw new Error(
      "no cursorAuth/accessToken in Cursor storage — open Cursor and sign in, then retry",
    );
  }
  if (!refreshToken) {
    throw new Error(
      "no cursorAuth/refreshToken in Cursor storage — open Cursor and sign in, then retry",
    );
  }
  return { accessToken, refreshToken, cachedEmail, serviceMachineId };
}

/**
 * Read Cursor IDE auth material from state.vscdb. Always copies to a temp
 * file first so reads succeed while Cursor holds a write lock on the live DB.
 */
export function readCursorIdeAuth(
  dbPath: string,
  opts: ReadCursorIdeAuthOptions = {},
): CursorIdeAuth {
  requireSqlite3Cli();
  if (!existsSync(dbPath)) {
    throw new Error(
      `Cursor state database not found at ${dbPath} — is Cursor installed and signed in?`,
    );
  }

  if (opts.skipCopy) {
    return readFromDb(dbPath);
  }

  return withTempDbCopy(dbPath, (copyPath) => readFromDb(copyPath));
}

export function defaultCursorStorageJsonPath(): string {
  return path.join(getCursorGlobalStorageDir(), "storage.json");
}

/**
 * Read the machine id Cursor binds to Cloud API requests from storage.json.
 */
export function readCursorMachineId(storageJsonPath?: string): string {
  const resolved = storageJsonPath ?? defaultCursorStorageJsonPath();
  if (!existsSync(resolved)) {
    throw new Error(`Cursor storage.json not found at ${resolved}`);
  }

  let json: Record<string, unknown>;
  try {
    json = JSON.parse(readFileSync(resolved, "utf8")) as Record<string, unknown>;
  } catch {
    throw new Error(`Cursor storage.json at ${resolved} is not valid JSON`);
  }

  const machineId = json[CURSOR_STORAGE_MACHINE_ID_KEY];
  if (typeof machineId !== "string" || machineId.trim().length === 0) {
    throw new Error(
      `no ${CURSOR_STORAGE_MACHINE_ID_KEY} in Cursor storage.json — open Cursor and sign in, then retry`,
    );
  }
  return machineId.trim();
}

export function defaultCursorStateDbPathForPlatform(): string {
  return getCursorStateDbPath();
}
