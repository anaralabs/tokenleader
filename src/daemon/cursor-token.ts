import { promises as fs } from "node:fs";
import path from "node:path";

export const CURSOR_TOKEN_FILENAME = "cursor_token";
export const CURSOR_CREDENTIALS_FILENAME = "cursor_credentials.json";

export interface CursorCredentials {
  sessionToken: string;
  refreshToken: string;
  machineId: string;
  email?: string;
}

/**
 * Load the Cursor dashboard session token. `cursor_token` wins when present;
 * otherwise falls back to `cursor_credentials.json`.
 */
export async function loadCursorToken(stateDir: string): Promise<string | null> {
  try {
    const token = (await fs.readFile(path.join(stateDir, CURSOR_TOKEN_FILENAME), "utf8")).trim();
    if (token.length > 0) return token;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "ENOENT") throw err;
  }

  const creds = await loadCursorCredentials(stateDir);
  return creds?.sessionToken ?? null;
}

export async function loadCursorCredentials(stateDir: string): Promise<CursorCredentials | null> {
  try {
    const raw = await fs.readFile(path.join(stateDir, CURSOR_CREDENTIALS_FILENAME), "utf8");
    const parsed = JSON.parse(raw) as Partial<CursorCredentials>;
    const sessionToken = typeof parsed.sessionToken === "string" ? parsed.sessionToken.trim() : "";
    const refreshToken = typeof parsed.refreshToken === "string" ? parsed.refreshToken.trim() : "";
    const machineId = typeof parsed.machineId === "string" ? parsed.machineId.trim() : "";
    if (sessionToken.length === 0 || refreshToken.length === 0 || machineId.length === 0) {
      return null;
    }
    const email = typeof parsed.email === "string" ? parsed.email.trim() : undefined;
    return { sessionToken, refreshToken, machineId, ...(email ? { email } : {}) };
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") return null;
    // A truncated/corrupt creds file is treated as absent, not fatal — it must
    // not block an otherwise-valid cursor_token from authenticating.
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}

/** Auth material for cloud API calls — session token plus refresh/machine when creds match. */
export async function loadCursorCloudAuth(
  stateDir: string,
): Promise<{ sessionToken: string; refreshToken?: string; machineId?: string } | null> {
  const sessionToken = await loadCursorToken(stateDir);
  if (!sessionToken) return null;

  const creds = await loadCursorCredentials(stateDir);
  if (!creds || creds.sessionToken !== sessionToken) {
    return { sessionToken };
  }
  return {
    sessionToken,
    refreshToken: creds.refreshToken,
    machineId: creds.machineId,
  };
}

async function writeSecureFile(filePath: string, contents: string): Promise<void> {
  const tmp = `${filePath}.tmp.${process.pid}`;
  await fs.writeFile(tmp, contents, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, filePath);
  await fs.chmod(filePath, 0o600);
}

async function removeCredentialsFile(stateDir: string): Promise<void> {
  try {
    await fs.unlink(path.join(stateDir, CURSOR_CREDENTIALS_FILENAME));
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "ENOENT") throw err;
  }
}

/**
 * Persist the Cursor dashboard session token with mode 0o600 — same posture
 * as `<stateDir>/secret`. Removes stale auto-discovered credentials so a
 * manual token update takes effect immediately.
 */
export async function saveCursorToken(stateDir: string, token: string): Promise<void> {
  const trimmed = token.trim();
  if (trimmed.length === 0) {
    throw new Error("cursor session token must not be empty");
  }
  await fs.mkdir(stateDir, { recursive: true });
  await writeSecureFile(path.join(stateDir, CURSOR_TOKEN_FILENAME), trimmed);
  await removeCredentialsFile(stateDir);
}

export async function saveCursorCredentials(
  stateDir: string,
  creds: CursorCredentials,
): Promise<void> {
  const sessionToken = creds.sessionToken.trim();
  const refreshToken = creds.refreshToken.trim();
  const machineId = creds.machineId.trim();
  if (sessionToken.length === 0 || refreshToken.length === 0 || machineId.length === 0) {
    throw new Error("cursor credentials must include sessionToken, refreshToken, and machineId");
  }

  const payload: CursorCredentials = {
    sessionToken,
    refreshToken,
    machineId,
    ...(creds.email?.trim() ? { email: creds.email.trim() } : {}),
  };

  await fs.mkdir(stateDir, { recursive: true });
  // `cursor_token` shadows creds in loadCursorToken, so refresh it first: a
  // crash before the creds rename leaves a fresh token, never a stale one.
  await writeSecureFile(path.join(stateDir, CURSOR_TOKEN_FILENAME), sessionToken);
  await writeSecureFile(
    path.join(stateDir, CURSOR_CREDENTIALS_FILENAME),
    `${JSON.stringify(payload)}\n`,
  );
}
