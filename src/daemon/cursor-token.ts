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
 * Load the Cursor dashboard session token from `<stateDir>/cursor_token`.
 * Returns null when the file is missing or empty.
 */
export async function loadCursorToken(stateDir: string): Promise<string | null> {
  const creds = await loadCursorCredentials(stateDir);
  if (creds) return creds.sessionToken;

  try {
    const token = (await fs.readFile(path.join(stateDir, CURSOR_TOKEN_FILENAME), "utf8")).trim();
    return token.length > 0 ? token : null;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") return null;
    throw err;
  }
}

export async function loadCursorCredentials(
  stateDir: string,
): Promise<CursorCredentials | null> {
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
    throw err;
  }
}

/**
 * Persist the Cursor dashboard session token with mode 0o600 — same posture
 * as `<stateDir>/secret`.
 */
export async function saveCursorToken(stateDir: string, token: string): Promise<void> {
  const trimmed = token.trim();
  if (trimmed.length === 0) {
    throw new Error("cursor session token must not be empty");
  }
  await fs.mkdir(stateDir, { recursive: true });
  const p = path.join(stateDir, CURSOR_TOKEN_FILENAME);
  const tmp = `${p}.tmp.${process.pid}`;
  await fs.writeFile(tmp, trimmed, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, p);
  await fs.chmod(p, 0o600);
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

  await saveCursorToken(stateDir, sessionToken);

  const payload: CursorCredentials = {
    sessionToken,
    refreshToken,
    machineId,
    ...(creds.email?.trim() ? { email: creds.email.trim() } : {}),
  };

  await fs.mkdir(stateDir, { recursive: true });
  const p = path.join(stateDir, CURSOR_CREDENTIALS_FILENAME);
  const tmp = `${p}.tmp.${process.pid}`;
  await fs.writeFile(tmp, `${JSON.stringify(payload)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, p);
  await fs.chmod(p, 0o600);
}
