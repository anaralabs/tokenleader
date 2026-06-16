import type { CursorIdeAuth } from "../parser/cursor-locator.ts";
import {
  defaultCursorStateDbPathForPlatform,
  readCursorIdeAuth,
  readCursorMachineId,
} from "../parser/cursor-locator.ts";
import {
  buildWorkosSessionToken,
  fetchCursorUserEmail,
  refreshCursorAccessToken,
  verifyCursorAccessToken,
} from "../parser/cursor-auth.ts";
import { validateCursorToken } from "../parser/cursor-api.ts";

export {
  buildWorkosSessionToken,
  CURSOR_AUTH_USAGE_API,
  CURSOR_OAUTH_CLIENT_ID,
  CURSOR_OAUTH_TOKEN_API,
  CURSOR_USER_API,
  fetchCursorUserEmail,
  refreshCursorAccessToken,
  userIdFromJwt,
  verifyCursorAccessToken,
} from "../parser/cursor-auth.ts";
export { CURSOR_AUTH_KEYS } from "../parser/cursor-locator.ts";
export type { CursorIdeAuth };

export interface ExtractCursorSessionOptions {
  dbPath?: string;
  storageJsonPath?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** Test seam — skip temp copy when the DB is already isolated. */
  skipCopy?: boolean;
}

export interface ExtractCursorSessionResult {
  sessionToken: string;
  email: string;
  machineId: string;
  auth: CursorIdeAuth;
}

/**
 * Extract IDE tokens, verify (refreshing when needed), confirm the account
 * email via the Cloud API, and return a WorkosCursorSessionToken.
 */
export async function extractCursorSessionToken(
  opts: ExtractCursorSessionOptions = {},
): Promise<ExtractCursorSessionResult> {
  const dbPath = opts.dbPath ?? defaultCursorStateDbPathForPlatform();
  const auth = readCursorIdeAuth(dbPath, { skipCopy: opts.skipCopy });
  // The auth DB carries the same serviceMachineId Cursor signs requests with;
  // fall back to telemetry.machineId in storage.json only when the DB lacks it.
  const machineId = auth.serviceMachineId ?? readCursorMachineId(opts.storageJsonPath);

  let accessToken = auth.accessToken;
  const fetchImpl = opts.fetchImpl;
  const signal = opts.signal;
  const ok = await verifyCursorAccessToken(accessToken, { fetchImpl, signal, machineId });
  if (!ok) {
    accessToken = await refreshCursorAccessToken(auth.refreshToken, { fetchImpl, signal });
    const refreshedOk = await verifyCursorAccessToken(accessToken, {
      fetchImpl,
      signal,
      machineId,
    });
    if (!refreshedOk) {
      throw new Error("cursor session still invalid after refresh — sign in to Cursor again");
    }
  }

  const sessionToken = buildWorkosSessionToken(accessToken);
  await validateCursorToken(sessionToken, { fetchImpl, signal, machineId });
  const email = await fetchCursorUserEmail(sessionToken, { fetchImpl, signal, machineId });

  return {
    sessionToken,
    email,
    machineId,
    auth: { ...auth, accessToken },
  };
}
