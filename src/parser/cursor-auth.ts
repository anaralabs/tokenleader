export const CURSOR_AUTH_USAGE_API = "https://api2.cursor.sh/auth/usage";
export const CURSOR_OAUTH_TOKEN_API = "https://api2.cursor.sh/oauth/token";
export const CURSOR_OAUTH_CLIENT_ID = "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB";
export const CURSOR_USER_API = "https://cursor.com/api/auth/me";

/** Derive the Cursor user id embedded in WorkosCursorSessionToken from a JWT `sub`. */
export function userIdFromJwt(accessToken: string): string {
  const parts = accessToken.trim().split(".");
  if (parts.length < 2) {
    throw new Error("invalid cursor access token (not a JWT)");
  }
  let payload = parts[1]!;
  payload = payload.replace(/-/g, "+").replace(/_/g, "/");
  while (payload.length % 4 !== 0) payload += "=";
  let json: { sub?: unknown };
  try {
    json = JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as { sub?: unknown };
  } catch {
    throw new Error("invalid cursor access token (malformed JWT payload)");
  }
  const sub = typeof json.sub === "string" ? json.sub : "";
  if (sub.length === 0) {
    throw new Error("cursor access token missing subject");
  }
  const pipe = sub.lastIndexOf("|");
  return pipe >= 0 ? sub.slice(pipe + 1) : sub;
}

/** Build the WorkosCursorSessionToken cookie value Cursor's dashboard expects. */
export function buildWorkosSessionToken(accessToken: string): string {
  return `${userIdFromJwt(accessToken)}::${accessToken.trim()}`;
}

export async function verifyCursorAccessToken(
  accessToken: string,
  opts: { fetchImpl?: typeof fetch; signal?: AbortSignal; machineId?: string } = {},
): Promise<boolean> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const headers: Record<string, string> = { Authorization: `Bearer ${accessToken.trim()}` };
  if (opts.machineId) headers["x-cursor-client-id"] = opts.machineId;

  const res = await fetchImpl(CURSOR_AUTH_USAGE_API, {
    method: "GET",
    headers,
    signal: opts.signal ?? AbortSignal.timeout(15_000),
  });
  if (res.status === 401 || res.status === 403) return false;
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    throw new Error(
      `cursor auth verification failed (${res.status})${detail ? `: ${detail}` : ""}`,
    );
  }
  return true;
}

export async function refreshCursorAccessToken(
  refreshToken: string,
  opts: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(CURSOR_OAUTH_TOKEN_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: CURSOR_OAUTH_CLIENT_ID,
      refresh_token: refreshToken.trim(),
    }),
    signal: opts.signal ?? AbortSignal.timeout(15_000),
  });

  let json: {
    access_token?: unknown;
    shouldLogout?: unknown;
    message?: unknown;
    error?: unknown;
  } = {};
  try {
    json = (await res.json()) as typeof json;
  } catch {
    throw new Error("cursor token refresh returned a non-JSON response");
  }

  if (json.shouldLogout === true || !res.ok) {
    const msg =
      (typeof json.message === "string" && json.message) ||
      (typeof json.error === "string" && json.error) ||
      `HTTP ${res.status}`;
    throw new Error(`cursor refresh token rejected — sign in to Cursor again (${msg})`);
  }

  const accessToken = typeof json.access_token === "string" ? json.access_token.trim() : "";
  if (accessToken.length === 0) {
    throw new Error("cursor token refresh returned an empty access token — sign in to Cursor again");
  }
  return accessToken;
}

export async function fetchCursorUserEmail(
  sessionToken: string,
  opts: { fetchImpl?: typeof fetch; signal?: AbortSignal; machineId?: string } = {},
): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    Cookie: `WorkosCursorSessionToken=${sessionToken.trim()}`,
  };
  if (opts.machineId) headers["x-cursor-client-id"] = opts.machineId;

  const res = await fetchImpl(CURSOR_USER_API, {
    method: "GET",
    headers,
    signal: opts.signal ?? AbortSignal.timeout(15_000),
  });

  if (res.status === 401 || res.status === 403) {
    throw new Error("cursor session token rejected (expired or invalid)");
  }
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    throw new Error(`cursor user API returned ${res.status}${detail ? `: ${detail}` : ""}`);
  }

  let json: { email?: unknown };
  try {
    json = (await res.json()) as { email?: unknown };
  } catch {
    throw new Error("cursor user API returned a non-JSON response");
  }

  const email = typeof json.email === "string" ? json.email.trim() : "";
  if (email.length === 0) {
    throw new Error("cursor user API response missing email");
  }
  return email;
}
