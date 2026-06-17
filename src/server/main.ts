import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import type { MessageType, Source, TokenEvent } from "../types.ts";
import { renderAdminHtml } from "./admin-html.ts";
import { brandedTitle, defaultFaviconSvg, defaultLogoSvg, injectBranding } from "./branding.ts";
import { mountApiV1 } from "./api-v1.ts";
import { normalizeCompany } from "./company.ts";
import { BinaryMirror, normalizeArch } from "./binary-mirror.ts";
import { ConfigError, echoConfig, parseServerConfig, type ServerConfig } from "./config.ts";
import { CursorMirror } from "./cursor-mirror.ts";
import { type Bucket, type DeviceInfo, Store } from "./db.ts";
import { renderInstallScript, renderUninstallScript } from "./install-script.ts";
import { PricingCache, computeRowCostUsd, roundUsd } from "./pricing.ts";
import { parseStatsRange } from "./range.ts";
import pkg from "../../package.json";

/** Release identity for /stats/admin. TOKENLEADER_SERVER_VERSION (set by the
 *  Docker image / release pipeline) wins; falls back to package.json, which
 *  Bun inlines under both `bun run` and `--compile`. */
export const SERVER_VERSION: string = process.env.TOKENLEADER_SERVER_VERSION?.trim() || pkg.version;

const MAX_EVENTS_PER_REQUEST = 1000;
// Ceiling on a single event's self-reported cost ($100). costUsdMicros is
// authenticated but client-supplied; without a cap a daemon could inflate
// leaderboard cost arbitrarily. No realistic single Cursor request approaches
// this, so legitimate events are never rejected.
const MAX_COST_USD_MICROS = 100_000_000;
const VALID_SOURCES: ReadonlySet<Source> = new Set([
  "claude_code",
  "claude_cowork",
  "codex",
  "cursor",
  "cursor_local",
]);

// Vite bundle extension → content-type for /assets/*.
const ASSET_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
};

function isFiniteInt(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && Number.isInteger(v);
}

function isNonNegInt(v: unknown): v is number {
  return isFiniteInt(v) && v >= 0;
}

/** Compact, content-free view of a raw event for reject logging. */
function summarizeEvent(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return { _type: typeof raw };
  const e = raw as Record<string, unknown>;
  return {
    source: e.source,
    messageType: e.messageType,
    model: e.model,
    sessionId: e.sessionId,
    messageId: e.messageId,
    timestamp: e.timestamp,
  };
}

function validateEvent(raw: unknown, idx: number): TokenEvent | string {
  if (!raw || typeof raw !== "object") return `events[${idx}] not an object`;
  const e = raw as Record<string, unknown>;
  // The handle is the trust boundary's join key AND is interpolated into the
  // rendered install command (link flow). The installer slugifies client-side
  // to [a-z0-9._-]; enforce that server-side too so a raw POST can't claim a
  // handle carrying shell metacharacters or break the install-command round
  // trip. 64 = generous headroom over the installer's 32-char slug cap.
  if (typeof e.user !== "string" || !/^[a-z0-9._-]{1,64}$/.test(e.user))
    return `events[${idx}].user must match /^[a-z0-9._-]{1,64}$/`;
  if (typeof e.source !== "string" || !VALID_SOURCES.has(e.source as Source))
    return `events[${idx}].source must be 'claude_code' | 'claude_cowork' | 'codex' | 'cursor' | 'cursor_local'`;
  if (typeof e.sessionId !== "string" || e.sessionId.length === 0)
    return `events[${idx}].sessionId must be non-empty string`;
  if (typeof e.messageId !== "string" || e.messageId.length === 0)
    return `events[${idx}].messageId must be non-empty string`;
  if (e.requestId !== null && typeof e.requestId !== "string")
    return `events[${idx}].requestId must be string | null`;
  if (!isFiniteInt(e.timestamp)) return `events[${idx}].timestamp must be integer (unix ms)`;
  // Emptiness is conditionally permitted for user-message events below.
  if (typeof e.model !== "string") return `events[${idx}].model must be a string`;
  if (!isNonNegInt(e.inputTokens)) return `events[${idx}].inputTokens invalid`;
  if (!isNonNegInt(e.outputTokens)) return `events[${idx}].outputTokens invalid`;
  if (!isNonNegInt(e.cacheCreationTokens)) return `events[${idx}].cacheCreationTokens invalid`;
  if (!isNonNegInt(e.cacheReadTokens)) return `events[${idx}].cacheReadTokens invalid`;
  if (e.reasoningTokens !== null && !isNonNegInt(e.reasoningTokens))
    return `events[${idx}].reasoningTokens must be non-negative integer | null`;
  // Optional on the wire: old daemons only ever sent assistant events.
  let messageType: MessageType = "assistant";
  if (e.messageType !== undefined) {
    if (e.messageType !== "user" && e.messageType !== "assistant")
      return `events[${idx}].messageType must be 'user' | 'assistant'`;
    messageType = e.messageType;
  }
  // Empty model is allowed only for user-message events (string-ness was
  // already checked above).
  if (messageType === "assistant" && e.model.length === 0)
    return `events[${idx}].model must be non-empty string for assistant messages`;
  let costUsdMicros: number | null | undefined;
  if (e.costUsdMicros !== undefined && e.costUsdMicros !== null) {
    if (!isNonNegInt(e.costUsdMicros))
      return `events[${idx}].costUsdMicros must be non-negative integer | null`;
    if (e.costUsdMicros > MAX_COST_USD_MICROS)
      return `events[${idx}].costUsdMicros exceeds maximum`;
    costUsdMicros = e.costUsdMicros;
  }
  return {
    user: e.user,
    source: e.source as Source,
    sessionId: e.sessionId,
    messageId: e.messageId,
    requestId: e.requestId as string | null,
    timestamp: e.timestamp,
    model: e.model,
    messageType,
    inputTokens: e.inputTokens,
    outputTokens: e.outputTokens,
    cacheCreationTokens: e.cacheCreationTokens,
    cacheReadTokens: e.cacheReadTokens,
    reasoningTokens: e.reasoningTokens as number | null,
    ...(costUsdMicros !== undefined ? { costUsdMicros } : {}),
  };
}

export interface BuildOptions {
  dbPath: string;
  startedAt?: number;
  /** False = skip the daily pricing-refresh interval (tests). */
  schedulePricingRefresh?: boolean;
  /** Stats-cache invalidations are leading-edge coalesced to at most one
   *  clear per this window (default 10s) so bulk replays can't starve the
   *  event loop. 0 = clear on every write (tests). */
  statsCacheClearCoalesceMs?: number;
  /** Public-facing server URL rendered into the dashboard + install
   *  snippets. Unset → inferred from request headers. Same URL the daemon
   *  uses for /ingest and /manifest.json. */
  serverUrl?: string;
  /** Gates the destructive POST /admin/clear. Unset → that route 503s.
   *  From TOKENLEADER_ADMIN_TOKEN in production. */
  adminToken?: string;
  /** Bearer for `/api/v1/*` (TOKENLEADER_API_TOKEN). Unset leaves the API
   *  following the dashboard posture. */
  apiToken?: string;
  /** BinaryMirror cache dir; /manifest.json and /bin/* serve from it.
   *  Until the mirror's first successful fetch those routes 503 and
   *  daemons stay on their current binary. */
  binaryCacheDir?: string;
  /** GitHub token for release reads (TOKENLEADER_GH_TOKEN). Unset → the
   *  mirror is not started; server still boots, update routes 503. */
  ghToken?: string;
  /** GitHub repo (`owner/name`) for daemon releases (TOKENLEADER_GH_REPO).
   *  No default: unset disables the mirror. */
  ghRepo?: string;
  /** False = don't start the BinaryMirror polling loop (tests). */
  scheduleBinaryMirror?: boolean;
  /** Mirror polling interval in seconds. Defaults to 900 (15 min). */
  mirrorIntervalSec?: number;
  /** Test seam: a pre-populated mirror with stub fetch. When provided,
   *  ghToken / ghRepo / mirrorIntervalSec are ignored. */
  binaryMirror?: BinaryMirror;
  /** Cursor admin API key (TOKENLEADER_CURSOR_TOKEN). Unset → no Cursor
   *  mirror; server still boots. */
  cursorToken?: string;
  /** Cursor poller interval in seconds. Defaults to 900 (15 min). */
  cursorIntervalSec?: number;
  /** If false, do not start the CursorMirror's polling loop (tests). */
  scheduleCursorMirror?: boolean;
  /** Injection seam for tests: pre-built mirror with a stub fetch. */
  cursorMirror?: CursorMirror;
  /** Email → leaderboard-user map for the Cursor mirror
   *  (TOKENLEADER_CURSOR_USER_MAP(_FILE)). The mirror only starts when
   *  this is non-empty AND cursorToken is set. */
  cursorUserMap?: Readonly<Record<string, string>>;
  /** Normalized domain → domain rewrites applied to X-Tokenleader-Company
   *  at ingest (operator typo-fix lever; TOKENLEADER_COMPANY_ALIASES). */
  companyAliases?: Readonly<Record<string, string>>;
  /** Test-only clock for `range=<N>d` resolution (pins the minute so
   *  rolling-window cache keys are deterministic). */
  now?: () => number;
  /** Display identity (TOKENLEADER_TEAM_NAME): dashboard header + title,
   *  installer banner. Display-only — never in paths or labels. */
  teamName?: string;
  /** Viewer token (TOKENLEADER_DASHBOARD_TOKEN) gating GET /, /stats,
   *  /stats/* via cookie, Bearer, or one-shot ?token=. Unset = public.
   *  /api/v1/* inherits this token when apiToken is unset. */
  dashboardToken?: string;
  /** Join code (TOKENLEADER_JOIN_TOKEN) gating FIRST claims on /ingest
   *  (X-Tokenleader-Join). Claimed users are untouched — their TOFU secret
   *  rules. Unset = open TOFU. */
  joinToken?: string;
  /** Built-SPA dir. With an index.html inside, GET / serves it and
   *  /assets/* the hashed bundles; otherwise the legacy server-rendered
   *  dashboard. Only the entrypoint wires this, so direct buildApp callers
   *  (tests) never need a web build. */
  webDistDir?: string;
  /** Data dir (TOKENLEADER_DATA_DIR); buildApp only reads
   *  `<dataDir>/brand/` for operator logo.svg / favicon.svg. Unset → the
   *  built-in neutral marks always serve. */
  dataDir?: string;
}

const DAILY_MS = 24 * 60 * 60 * 1000;

/** Default BinaryMirror cache dir (~/.local/share is the daemon's state
 *  dir on teammate machines — don't reuse it server-side). */
function defaultBinaryCacheDir(): string {
  return path.join(homedir(), "Library", "Application Support", "tokenleader", "binaries");
}

/**
 * Translate a strftime bucket key ("YYYY-MM-DD" / "GGGG-Www" / "YYYY-MM")
 * back to the unix-ms start of the bucket, UTC throughout to match
 * `bucketExpr` in db.ts. Null for malformed keys.
 */
export function bucketStartMs(bucket: Bucket, key: string): number | null {
  if (bucket === "day") {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
    if (!m) return null;
    return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!);
  }
  if (bucket === "month") {
    const m = /^(\d{4})-(\d{2})$/.exec(key);
    if (!m) return null;
    return Date.UTC(+m[1]!, +m[2]! - 1, 1);
  }
  // week: "GGGG-Www" → Monday of ISO week.
  const m = /^(\d{4})-W(\d{2})$/.exec(key);
  if (!m) return null;
  const isoYear = +m[1]!;
  const isoWeek = +m[2]!;
  // ISO 8601: week 1 is the week containing Jan 4. Monday of week 1 is
  // Jan 4 minus (Jan 4's weekday - 1) days where Monday=1.
  const jan4 = Date.UTC(isoYear, 0, 4);
  const jan4Dow = new Date(jan4).getUTCDay() || 7; // Sun=0 → 7
  const mondayWeek1 = jan4 - (jan4Dow - 1) * DAILY_MS;
  return mondayWeek1 + (isoWeek - 1) * 7 * DAILY_MS;
}

function isBucket(s: string): s is Bucket {
  return s === "day" || s === "week" || s === "month";
}

function resolveServerUrl(
  c: {
    req: { header: (n: string) => string | undefined; url: string };
  },
  configured?: string,
): string {
  if (configured && configured.length > 0) return configured.replace(/\/+$/, "");
  // Fall back to inferring from the request. Prefer X-Forwarded-* when
  // present (Tailscale Funnel sets these), else parse the request URL.
  const proto =
    c.req.header("x-forwarded-proto") ?? (c.req.url.startsWith("https") ? "https" : "http");
  const host = c.req.header("x-forwarded-host") ?? c.req.header("host");
  if (host) return `${proto}://${host}`;
  // Last resort: the raw URL minus the path.
  try {
    const u = new URL(c.req.url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "http://localhost";
  }
}

function timingSafeEqStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// --- device link codes ------------------------------------------------------
// Pairing codes for adding another machine to a claimed handle. Minted by an
// authenticated device (POST /devices/link) or the admin (POST /admin/link);
// redeemed by the new machine's first /ingest via X-Tokenleader-Link.
const LINK_CODE_TTL_MS = 10 * 60 * 1000;
// 32 symbols (no modulo bias off a byte) with O/I/L/1 dropped — codes get
// read aloud and retyped across machines. 8 symbols = 40 bits.
const LINK_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ023456789";

function generateLinkCode(): string {
  const bytes = randomBytes(8);
  let raw = "";
  for (const b of bytes) raw += LINK_CODE_ALPHABET[b % LINK_CODE_ALPHABET.length];
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/** Case/punctuation-insensitive compare form ("abcd-2345" → "ABCD2345"). */
function normalizeLinkCode(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** X-Tokenleader-Device → display label: lowercase, [a-z0-9._-], ≤32 chars;
 *  empty after cleanup → null. Cosmetic only — auth never consults it. */
function deviceLabelFrom(raw: string | undefined): string | null {
  const s = (raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 32);
  return s.length > 0 ? s : null;
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function renderLoginHtml(failed: boolean, teamName?: string): string {
  // /brand/favicon.svg is ungated so it loads before any auth cookie
  // exists; brandedTitle escapes the operator-supplied team name.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${brandedTitle(teamName)} — login</title>
<link rel="icon" type="image/svg+xml" href="/brand/favicon.svg">
<style>
  body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; display: flex;
         justify-content: center; align-items: center; min-height: 100vh; margin: 0;
         background: #fafafa; color: #1a1a1a; }
  form { width: min(22rem, 90vw); display: flex; flex-direction: column; gap: .75rem; }
  h1 { font-size: 1rem; font-weight: 600; margin: 0; }
  input, button { font: inherit; padding: .5rem .75rem; border-radius: .5rem;
                  border: 1px solid #d4d4d4; }
  button { cursor: pointer; background: #1a1a1a; color: #fff; border-color: #1a1a1a; }
  .err { color: #c0392b; margin: 0; font-size: .85rem; }
  .hint { color: #737373; font-size: .75rem; line-height: 1.5; margin: 0; }
</style>
</head>
<body>
<form method="post" action="/login">
  <h1>tokenleader</h1>
  ${failed ? '<p class="err">Wrong token — try again.</p>' : ""}
  <input type="password" name="token" placeholder="dashboard token" autofocus>
  <button type="submit">View dashboard</button>
  <p class="hint">Deployed from the Railway template? Your token was generated
  for you — find it under your service's Variables as
  TOKENLEADER_DASHBOARD_TOKEN.</p>
</form>
</body>
</html>
`;
}

export function buildApp(opts: BuildOptions) {
  const store = new Store(opts.dbPath);
  const startedAt = opts.startedAt ?? Date.now();
  const pricing = new PricingCache();
  const app = new Hono();
  const now = opts.now ?? Date.now;

  // In-process response cache for the read-heavy dashboard routes, keyed
  // by route + query params. bun:sqlite is synchronous — overlapping polls
  // block the event loop, and coalescing them here keeps /health
  // responsive. FULLY CLEARED on every successful /ingest (and mirror
  // insert), so the dashboard never shows data older than the most recent
  // write or 15 s.
  const STATS_CACHE_TTL_MS = 15_000;
  // Windows ending in the past are frozen — no future write changes their
  // answer until a backfill — so cache up to a day; /ingest still nukes
  // the whole cache, so even a backfill can't serve stale frozen data.
  const STATS_CACHE_TTL_FROZEN_MS = 24 * 60 * 60 * 1000;
  function isFrozenRange(untilMs: number): boolean {
    // 60s buffer for clock skew vs the clock that built `until`.
    return untilMs > 0 && untilMs < Date.now() - 60_000;
  }
  const statsCache = new Map<string, { expiresAt: number; body: string }>();
  function readStatsCache(key: string): string | null {
    const hit = statsCache.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= Date.now()) {
      statsCache.delete(key);
      return null;
    }
    return hit.body;
  }
  function writeStatsCache(key: string, body: string, frozen = false): void {
    const ttl = frozen ? STATS_CACHE_TTL_FROZEN_MS : STATS_CACHE_TTL_MS;
    statsCache.set(key, { expiresAt: Date.now() + ttl, body });
  }
  // Invalidations are leading-edge coalesced: the first write clears the
  // cache immediately; further writes inside the window only schedule one
  // trailing clear. Without this, a bulk replay (hundreds of /ingest
  // batches) clears the cache per batch and every 5s dashboard poll re-runs
  // the full aggregations between batches — the synchronous queries starve
  // the event loop until ingest POSTs time out.
  const STATS_CACHE_CLEAR_COALESCE_MS = opts.statsCacheClearCoalesceMs ?? 10_000;
  let lastStatsClearAt = 0;
  let trailingClear: ReturnType<typeof setTimeout> | null = null;
  function invalidateStatsCache(): void {
    const now = Date.now();
    if (now - lastStatsClearAt >= STATS_CACHE_CLEAR_COALESCE_MS) {
      lastStatsClearAt = now;
      statsCache.clear();
      return;
    }
    if (trailingClear) return;
    trailingClear = setTimeout(
      () => {
        trailingClear = null;
        lastStatsClearAt = Date.now();
        statsCache.clear();
      },
      STATS_CACHE_CLEAR_COALESCE_MS - (now - lastStatsClearAt),
    );
    trailingClear.unref?.();
  }

  // Outstanding link codes, one per user — minting replaces any prior code.
  // In-memory by design: single-use 10-minute codes don't merit persistence;
  // a server restart just means re-minting.
  const linkCodes = new Map<string, { code: string; expiresAt: number }>();
  const mintLinkCode = (user: string): { code: string; expiresAt: number } => {
    const entry = { code: generateLinkCode(), expiresAt: Date.now() + LINK_CODE_TTL_MS };
    linkCodes.set(user, entry);
    return entry;
  };
  const consumeLinkCode = (user: string, presented: string): boolean => {
    const entry = linkCodes.get(user);
    if (!entry) return false;
    if (entry.expiresAt <= Date.now()) {
      linkCodes.delete(user);
      return false;
    }
    if (!timingSafeEqStr(normalizeLinkCode(presented), normalizeLinkCode(entry.code))) {
      return false;
    }
    linkCodes.delete(user);
    return true;
  };

  // --- dashboard viewer auth ----------------------------------------------
  // Gated routes are EXACTLY DASHBOARD_GATED — Hono's '/stats/*' does NOT
  // match bare /stats, so both are listed. Accept
  // order: tl_dash cookie (sha256 of the token, timing-safe) → Bearer →
  // one-shot ?token= (sets cookie, 302s without the param). Browsers get
  // /login; non-HTML callers get 401 JSON. Never gated: /health /ingest
  // /events/uninstall /manifest.json /bin/* /install /uninstall /login
  // /brand/* (favicon must load on /login) /assets/* (hashed bundles of
  // public code) /admin/clear (own token) /api/v1/* (own chain).
  const dashboardToken = opts.dashboardToken;
  const DASH_COOKIE = "tl_dash";
  const dashCookieExpected = dashboardToken
    ? createHash("sha256").update(dashboardToken).digest("hex")
    : null;
  const isSecureReq = (c: { req: { header: (n: string) => string | undefined; url: string } }) =>
    (c.req.header("x-forwarded-proto") ?? "") === "https" || c.req.url.startsWith("https:");
  const dashCookieHeader = (secure: boolean): string =>
    `${DASH_COOKIE}=${dashCookieExpected}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${secure ? "; Secure" : ""}`;

  const dashboardAuth: MiddlewareHandler = async (c, next) => {
    if (!dashboardToken || !dashCookieExpected) return next();
    const cookie = readCookie(c.req.header("cookie"), DASH_COOKIE);
    if (cookie && timingSafeEqStr(cookie, dashCookieExpected)) return next();
    const bearer = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (bearer && timingSafeEqStr(bearer, dashboardToken)) return next();
    const url = new URL(c.req.url);
    const qToken = url.searchParams.get("token");
    if (qToken && timingSafeEqStr(qToken, dashboardToken)) {
      url.searchParams.delete("token");
      return new Response(null, {
        status: 302,
        headers: {
          location: url.pathname + url.search,
          "set-cookie": dashCookieHeader(isSecureReq(c)),
        },
      });
    }
    if ((c.req.header("accept") ?? "").includes("text/html")) {
      return c.redirect("/login", 302);
    }
    return c.json({ error: "dashboard token required" }, 401);
  };
  const DASHBOARD_GATED = ["/", "/admin", "/stats", "/stats/*"] as const;
  for (const route of DASHBOARD_GATED) app.use(route, dashboardAuth);

  // Minimal login form for the cookie flow. Open by definition; redirects
  // home when no dashboard token is configured.
  app.get("/login", (c) => {
    if (!dashboardToken) return c.redirect("/", 302);
    return c.html(renderLoginHtml(false, opts.teamName));
  });
  app.post("/login", async (c) => {
    if (!dashboardToken) return c.redirect("/", 302);
    let token = "";
    try {
      const form = await c.req.parseBody();
      if (typeof form.token === "string") token = form.token;
    } catch {
      // fall through to the retry form
    }
    if (token && timingSafeEqStr(token, dashboardToken)) {
      return new Response(null, {
        status: 302,
        headers: {
          location: "/",
          "set-cookie": dashCookieHeader(isSecureReq(c)),
        },
      });
    }
    return c.html(renderLoginHtml(true, opts.teamName), 403);
  });

  app.get("/health", (c) =>
    c.json({
      ok: true,
      uptimeMs: Date.now() - startedAt,
      eventsCount: store.count(),
    }),
  );

  // --- daemon auto-update endpoints --------------------------------------
  // Daemons poll /manifest.json; on a sha change they fetch
  // /bin/anara-leaderboard-<arch>, verify, swap, restart. BinaryMirror
  // keeps both served from local cache.
  const binaryCacheDir = path.resolve(opts.binaryCacheDir ?? defaultBinaryCacheDir());

  // BinaryMirror needs BOTH repo and token; without them the server still
  // boots but update routes 503. The warn is loud — a silently-dark mirror
  // strands the fleet on old builds.
  let mirror: BinaryMirror | null = null;
  if (opts.binaryMirror) {
    mirror = opts.binaryMirror;
  } else if (opts.ghToken && opts.ghToken.length > 0 && opts.ghRepo && opts.ghRepo.length > 0) {
    mirror = new BinaryMirror({
      cacheDir: binaryCacheDir,
      ghRepo: opts.ghRepo,
      ghToken: opts.ghToken,
      ...(opts.mirrorIntervalSec !== undefined ? { intervalSec: opts.mirrorIntervalSec } : {}),
    });
  } else {
    console.warn(
      "[tokenleader] BINARY MIRROR DISABLED (set TOKENLEADER_GH_REPO + TOKENLEADER_GH_TOKEN): /manifest.json + /bin/* will 503; daemon auto-update is dark.",
    );
  }

  // CursorMirror needs both the token AND a non-empty user map.
  // parseServerConfig warns (non-fatal) on token-without-map at the
  // entrypoint; this guard keeps the mirror dark for direct callers too.
  const cursorUserMap = opts.cursorUserMap ?? {};
  let cursorMirror: CursorMirror | null = null;
  if (opts.cursorMirror) {
    cursorMirror = opts.cursorMirror;
  } else if (
    opts.cursorToken &&
    opts.cursorToken.length > 0 &&
    Object.keys(cursorUserMap).length > 0
  ) {
    cursorMirror = new CursorMirror({
      store,
      token: opts.cursorToken,
      userMap: cursorUserMap,
      ...(opts.cursorIntervalSec !== undefined ? { intervalSec: opts.cursorIntervalSec } : {}),
    });
  } else {
    console.warn(
      "[tokenleader] cursor mirror off (needs TOKENLEADER_CURSOR_TOKEN + a user map); Cursor team usage will not be mirrored.",
    );
  }

  // Mirror inserts must invalidate the stats cache like /ingest does —
  // otherwise a backfill serves stale frozen-range responses for up to
  // 24h. Composed, never overwritten, so an injected onInsert keeps firing.
  if (cursorMirror) {
    const prior = cursorMirror.onInsert;
    cursorMirror.onInsert = () => {
      prior?.();
      invalidateStatsCache();
    };
  }

  // Published daemon version from the mirrored manifest; /stats/fleet uses
  // it to flag stale teammates. null (no mirror / not fetched) flags nobody.
  const currentDaemonVersion = (): string | null => {
    if (!mirror) return null;
    const bytes = mirror.getManifest();
    if (!bytes) return null;
    try {
      const m = JSON.parse(bytes.toString("utf8")) as { version?: unknown };
      return typeof m.version === "string" && m.version.length > 0 ? m.version : null;
    } catch {
      return null;
    }
  };

  app.get("/manifest.json", (c) => {
    if (!mirror) {
      return c.json({ error: "binary mirror not configured" }, 503);
    }
    const entry = mirror.getManifestWithSha();
    if (!entry) {
      // Boot window: daemons treat 503 like a network blip and retry.
      return c.json({ error: "manifest not yet mirrored" }, 503);
    }
    const { bytes } = entry;
    let parsedOk = true;
    try {
      JSON.parse(bytes.toString("utf8"));
    } catch {
      parsedOk = false;
    }
    if (!parsedOk) {
      return c.json({ error: "manifest unreadable" }, 500);
    }
    // ETag = sha256 of the manifest bytes; daemons poll with If-None-Match.
    const etag = `"${entry.sha256}"`;
    if (c.req.header("if-none-match") === etag) {
      return new Response(null, {
        status: 304,
        headers: { etag, "cache-control": "no-store" },
      });
    }
    return new Response(bytes, {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        etag,
      },
    });
  });

  // Hono can't do mid-segment path params (`/bin/anara-leaderboard-:arch`
  // never matches), so match the whole asset name and parse the prefix.
  const BIN_ASSET_PREFIX = "anara-leaderboard-";
  app.get("/bin/:asset", (c) => {
    if (!mirror) {
      return c.json({ error: "binary mirror not configured" }, 503);
    }
    const asset = c.req.param("asset") ?? "";
    if (!asset.startsWith(BIN_ASSET_PREFIX)) {
      return c.json({ error: "unknown asset" }, 404);
    }
    const archParam = asset.slice(BIN_ASSET_PREFIX.length);
    const arch = normalizeArch(archParam);
    if (!arch) {
      return c.json({ error: "unknown arch" }, 404);
    }
    const entry = mirror.getBinary(arch);
    if (!entry) {
      return c.json({ error: "binary not yet mirrored" }, 503);
    }
    // Stream — don't buffer 60 MB per fetch. Bun.file under bun,
    // createReadStream under plain-node tests.
    if (typeof Bun !== "undefined" && typeof Bun.file === "function") {
      return new Response(Bun.file(entry.path), {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(entry.size),
          "cache-control": "no-store",
        },
      });
    }
    const stream = createReadStream(entry.path);
    return new Response(stream as unknown as ReadableStream, {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(entry.size),
        "cache-control": "no-store",
      },
    });
  });

  // The rendered script downloads the daemon binary back off this same
  // server's /bin route, sha256-verified against /manifest.json.
  app.get("/install", (c) => {
    const url = resolveServerUrl(c, opts.serverUrl);
    const script = renderInstallScript(url, {
      ...(opts.teamName !== undefined ? { teamName: opts.teamName } : {}),
      joinRequired: Boolean(opts.joinToken),
    });
    return new Response(script, {
      status: 200,
      headers: {
        "content-type": "text/x-shellscript; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  });

  app.get("/uninstall", (c) => {
    const url = resolveServerUrl(c, opts.serverUrl);
    return new Response(renderUninstallScript(url), {
      status: 200,
      headers: {
        "content-type": "text/x-shellscript; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  });

  // --- dashboard: built SPA when present, legacy render otherwise ---------
  const webDistDir =
    opts.webDistDir && existsSync(path.join(opts.webDistDir, "index.html"))
      ? path.resolve(opts.webDistDir)
      : null;

  // Same streaming dual-path as /bin/:asset.
  const fileResponse = (filePath: string, headers: Record<string, string>): Response => {
    if (typeof Bun !== "undefined" && typeof Bun.file === "function") {
      return new Response(Bun.file(filePath), { status: 200, headers });
    }
    return new Response(createReadStream(filePath) as unknown as ReadableStream, {
      status: 200,
      headers,
    });
  };

  // --- branding (/brand/*, ungated) ----------------------------------------
  // Ungated: the favicon must load on /login before any auth cookie exists.
  // Missing operator files fall back to the built-in marks (branding.ts);
  // max-age=300 lets operators swap files without a redeploy.
  const brandDir = opts.dataDir ? path.join(opts.dataDir, "brand") : null;
  const BRAND_HEADERS = {
    "content-type": "image/svg+xml",
    "cache-control": "public, max-age=300",
  };
  const serveBrand = (file: string, fallback: string): Response => {
    if (brandDir) {
      const filePath = path.join(brandDir, file);
      try {
        if (statSync(filePath).isFile()) {
          return fileResponse(filePath, BRAND_HEADERS);
        }
      } catch {
        // Missing or unreadable operator file → built-in default below.
      }
    }
    return new Response(fallback, { status: 200, headers: BRAND_HEADERS });
  };
  app.get("/brand/logo.svg", () => serveBrand("logo.svg", defaultLogoSvg));
  app.get("/brand/favicon.svg", () => serveBrand("favicon.svg", defaultFaviconSvg));

  // Serve-time branding for the SPA shell, memoized by index.html's mtime
  // so a redeployed web/dist re-injects while steady-state costs one stat().
  let indexHtmlCache: { mtimeMs: number; body: string } | null = null;
  const serveIndexHtml = (distDir: string): Response => {
    const indexPath = path.join(distDir, "index.html");
    const headers = {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    };
    let body: string;
    try {
      const mtimeMs = statSync(indexPath).mtimeMs;
      if (!indexHtmlCache || indexHtmlCache.mtimeMs !== mtimeMs) {
        indexHtmlCache = {
          mtimeMs,
          body: injectBranding(readFileSync(indexPath, "utf8"), opts.teamName),
        };
      }
      body = indexHtmlCache.body;
    } catch {
      // index.html vanished mid-redeploy — stream untransformed, don't 500.
      return fileResponse(indexPath, headers);
    }
    return new Response(body, { status: 200, headers });
  };

  if (webDistDir) {
    const assetsDir = path.join(webDistDir, "assets");
    app.get("/assets/*", (c) => {
      const rel = decodeURIComponent(new URL(c.req.url).pathname).slice("/assets/".length);
      const resolved = path.resolve(assetsDir, rel);
      // Containment check defeats ../ traversal (raw or percent-encoded).
      if (!resolved.startsWith(assetsDir + path.sep)) {
        return c.json({ error: "not found" }, 404);
      }
      if (!existsSync(resolved) || !statSync(resolved).isFile()) {
        return c.json({ error: "not found" }, 404);
      }
      return fileResponse(resolved, {
        "content-type": ASSET_TYPES[path.extname(resolved)] ?? "application/octet-stream",
        // Vite content-hashes every bundle filename, so immutable is safe.
        "cache-control": "public, max-age=31536000, immutable",
      });
    });
  }

  // The SPA-vs-legacy fork lives here once; each route supplies its legacy fallback.
  const spaOrLegacy =
    (legacy: (c: Context) => Response) =>
    (c: Context): Response =>
      webDistDir ? serveIndexHtml(webDistDir) : legacy(c);

  app.get(
    "/",
    spaOrLegacy((c) => {
      const url = resolveServerUrl(c, opts.serverUrl);
      return new Response(renderAdminHtml(url), {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }),
  );

  // SPA history-mode route: /admin serves the same index.html. NOT a
  // catch-all — other paths keep 404ing so daemon-route typos stay loud.
  // Without a web build, redirect to the legacy dashboard at /.
  app.get(
    "/admin",
    spaOrLegacy((c) => c.redirect("/", 302)),
  );

  // Optional `company=` filter shared by /stats/admin and /stats/timeseries:
  // absent or empty → no filter; non-normalizable → 400 (caller returns the
  // Response). A valid-but-unknown domain is NOT an error — it just matches
  // zero users, so the routes answer with empty/zeroed aggregates.
  const parseCompanyParam = (
    c: Context,
  ): { ok: true; company: string | undefined } | { ok: false; res: Response } => {
    const raw = c.req.query("company");
    if (raw === undefined || raw.length === 0) return { ok: true, company: undefined };
    const company = normalizeCompany(raw);
    if (company === null) {
      return { ok: false, res: c.json({ error: "invalid company" }, 400) };
    }
    return { ok: true, company };
  };

  app.get("/stats/admin", (c) => {
    const range = parseStatsRange(new URL(c.req.url).searchParams, now());
    if ("error" in range) return c.json({ error: range.error }, 400);
    const { since, until } = range;
    const companyParam = parseCompanyParam(c);
    if (!companyParam.ok) return companyParam.res;
    const company = companyParam.company;
    // Normalized company can't contain ":" (ports are stripped), so the
    // delimited key is collision-free.
    const cacheKey = `admin:${since}:${until}:${company ?? ""}`;
    const cached = readStatsCache(cacheKey);
    if (cached !== null) {
      return new Response(cached, {
        headers: { "content-type": "application/json; charset=UTF-8" },
      });
    }
    const leaderRows = store.adminLeaderboard(since, until, company);
    // Per-user cost walks the user's per-model breakdown over the same
    // [since, until) window — token sums and cost must describe the same
    // range. Fine for small/medium teams.
    const leaderboard = leaderRows
      .map((row) => {
        const byModel = store.userByModel(row.user, since, until);
        let usd = 0;
        for (const m of byModel) {
          // Source-provided cost (Cursor) wins over PricingCache derivation
          // — keeps max-mode multipliers intact.
          if (m.storedCostMicros > 0) {
            usd += m.storedCostMicros / 1_000_000;
            continue;
          }
          const price = pricing.lookup(m.model);
          if (!price) continue;
          usd += computeRowCostUsd(m, price);
        }
        return { ...row, costUsd: roundUsd(usd) };
      })
      // Rank purely by cost; the SQL ORDER BY token-sum is not the source
      // of truth.
      .sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0));

    const modelRows = store.adminByModel(since, until, company);
    const byModel = modelRows.map((m) => {
      let costUsd = 0;
      let unknownPrice = false;
      if (m.storedCostMicros > 0) {
        costUsd = roundUsd(m.storedCostMicros / 1_000_000);
      } else {
        const price = pricing.lookup(m.model);
        if (price) {
          costUsd = roundUsd(
            computeRowCostUsd(
              {
                input: m.inputTokens,
                output: m.outputTokens,
                cacheCreation: m.cacheCreationTokens,
                cacheRead: m.cacheReadTokens,
                reasoning: m.reasoningTokens,
              },
              price,
            ),
          );
        } else {
          unknownPrice = true;
        }
      }
      return {
        model: m.model,
        count: m.count,
        inputTokens: m.inputTokens,
        outputTokens: m.outputTokens,
        cacheCreationTokens: m.cacheCreationTokens,
        cacheReadTokens: m.cacheReadTokens,
        costUsd,
        unknownPrice,
      };
    });

    const recent = store.adminRecent(50, company);

    // Summed server-side so /stats/admin is the single source of truth for
    // the "Messages" total.
    let userMessages = 0;
    let assistantMessages = 0;
    for (const row of leaderboard) {
      userMessages += row.userMessages || 0;
      assistantMessages += row.assistantMessages || 0;
    }

    const payload = {
      server: {
        uptimeMs: Date.now() - startedAt,
        eventsCount: store.count(),
        dbSizeBytes: store.dbSizeBytes(),
        lastEventAt: store.lastEventAt(),
        // Display identity for the header chip + title. null = wordmark only.
        teamName: opts.teamName ?? null,
        version: SERVER_VERSION,
        // Boolean only — the join token itself never leaves the server.
        joinRequired: Boolean(opts.joinToken),
      },
      messages: {
        userMessages,
        assistantMessages,
      },
      leaderboard,
      byModel,
      recent,
      // Global pick-list for the dashboard's company-filter pills — ALWAYS
      // every distinct company, never narrowed by an active company filter
      // (the pills would vanish the moment one is selected).
      companies: store.listCompanies(),
      // Always lifetime, regardless of the active date-range pill.
      uninstalled: store.listUninstalledUsers(),
    };
    const body = JSON.stringify(payload);
    writeStatsCache(cacheKey, body, isFrozenRange(until));
    return new Response(body, {
      headers: { "content-type": "application/json; charset=UTF-8" },
    });
  });

  // Fleet view: every active device per teammate vs the published version.
  // The user row mirrors its most recently seen reporting device; per-device
  // rows ride along so multi-machine users don't flap. Not cached: a couple
  // of tiny indexed reads.
  app.get("/stats/fleet", (c) => {
    const latest = currentDaemonVersion();
    const uninstalled = new Set(store.listUninstalledUsers().map((u) => u.user));
    const devicesByUser = new Map<string, DeviceInfo[]>();
    for (const { user, device } of store.listFleetDevices()) {
      const list = devicesByUser.get(user);
      if (list) list.push(device);
      else devicesByUser.set(user, [device]);
    }
    const fleet = store
      .listClaimedUsers()
      .filter((u) => !uninstalled.has(u.user))
      .map((u) => {
        const devices = (devicesByUser.get(u.user) ?? []).map((d) => ({
          label: d.label,
          version: d.version,
          arch: d.arch,
          lastSeen: d.lastSeen,
          // Tri-state: true = on latest, false = stale/not-reporting, null =
          // can't compare (no published manifest yet — boot window or no GH
          // token). null must NOT render as "stale".
          isLatest: d.version === null ? false : latest === null ? null : d.version === latest,
        }));
        const reporting = devices.filter((d) => d.version !== null);
        let newest: (typeof devices)[number] | null = null;
        for (const d of reporting) {
          // >= so a lastSeen tie goes to the later-added device.
          if (newest === null || (d.lastSeen ?? 0) >= (newest.lastSeen ?? 0)) newest = d;
        }
        return {
          user: u.user,
          version: newest?.version ?? null,
          arch: newest?.arch ?? null,
          lastSeen: newest?.lastSeen ?? null,
          reporting: newest !== null,
          // Same tri-state; true only when EVERY reporting device is on
          // latest, so one stale laptop can't hide behind a fresh desktop.
          isLatest:
            newest === null
              ? false
              : latest === null
                ? null
                : reporting.every((d) => d.version === latest),
          devices,
        };
      })
      // Stale / unknown first so they stand out; then alphabetical.
      .sort((a, b) => Number(a.isLatest) - Number(b.isLatest) || a.user.localeCompare(b.user));
    return c.json({ latestVersion: latest, fleet });
  });

  app.get("/stats/timeseries", (c) => {
    const bucketRaw = c.req.query("bucket") ?? "day";
    if (!isBucket(bucketRaw)) {
      return c.json({ error: "bucket must be one of: day | week | month" }, 400);
    }
    const bucket: Bucket = bucketRaw;
    const range = parseStatsRange(new URL(c.req.url).searchParams, now());
    if ("error" in range) return c.json({ error: range.error }, 400);
    const { since, until } = range;
    const userFilter = c.req.query("user") || undefined;
    // A malformed company is still a 400 even alongside user=, but a VALID
    // company is ignored when user= is present: the user is the narrower
    // scope, so it wins (documented behavior — never an error).
    const companyParam = parseCompanyParam(c);
    if (!companyParam.ok) return companyParam.res;
    const companyFilter = userFilter ? undefined : companyParam.company;

    const cacheKey = `ts:${bucket}:${since}:${until}:${userFilter ?? ""}:${companyFilter ?? ""}`;
    const cached = readStatsCache(cacheKey);
    if (cached !== null) {
      return new Response(cached, {
        headers: { "content-type": "application/json; charset=UTF-8" },
      });
    }

    // 1) Per-(bucket, model) aggregates (assistant rows only).
    const modelRows = store.timeseriesByModel(bucket, since, until, userFilter, companyFilter);
    // 1b) Per-bucket message counts (both kinds) — always pulled so buckets
    //     with only user messages still surface.
    const countRows = store.timeseriesCountsByBucket(
      bucket,
      since,
      until,
      userFilter,
      companyFilter,
    );

    // 2) Group into per-bucket structures, computing cost via PricingCache.
    interface Acc {
      bucketKey: string;
      events: number;
      inputTokens: number;
      outputTokens: number;
      cacheCreationTokens: number;
      cacheReadTokens: number;
      reasoningTokens: number;
      costUsd: number;
      userMessages: number;
      assistantMessages: number;
    }
    const acc = new Map<string, Acc>();
    function ensureAcc(key: string): Acc {
      let a = acc.get(key);
      if (!a) {
        a = {
          bucketKey: key,
          events: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          reasoningTokens: 0,
          costUsd: 0,
          userMessages: 0,
          assistantMessages: 0,
        };
        acc.set(key, a);
      }
      return a;
    }
    for (const m of modelRows) {
      const a = ensureAcc(m.bucketKey);
      a.events += m.events;
      a.inputTokens += m.inputTokens;
      a.outputTokens += m.outputTokens;
      a.cacheCreationTokens += m.cacheCreationTokens;
      a.cacheReadTokens += m.cacheReadTokens;
      a.reasoningTokens += m.reasoningTokens;
      // Stored cost (Cursor) wins over derived cost (PricingCache).
      if (m.storedCostMicros > 0) {
        a.costUsd += m.storedCostMicros / 1_000_000;
      } else {
        const price = pricing.lookup(m.model);
        if (price) {
          a.costUsd += computeRowCostUsd(
            {
              input: m.inputTokens,
              output: m.outputTokens,
              cacheCreation: m.cacheCreationTokens,
              cacheRead: m.cacheReadTokens,
              reasoning: m.reasoningTokens,
            },
            price,
          );
        }
      }
    }
    for (const r of countRows) {
      const a = ensureAcc(r.bucketKey);
      a.userMessages += r.userMessages;
      a.assistantMessages += r.assistantMessages;
    }

    // 3) byUser breakdown — only when no `user` filter is in effect.
    const byUserByBucket = new Map<
      string,
      Map<
        string,
        {
          events: number;
          costUsd: number;
          userMessages: number;
          assistantMessages: number;
        }
      >
    >();
    if (!userFilter) {
      const userRows = store.timeseriesByUser(bucket, since, until, companyFilter);
      const userCountRows = store.timeseriesCountsByUser(bucket, since, until, companyFilter);
      const ensureBU = (bucketKey: string, user: string) => {
        let perBucket = byUserByBucket.get(bucketKey);
        if (!perBucket) {
          perBucket = new Map();
          byUserByBucket.set(bucketKey, perBucket);
        }
        let u = perBucket.get(user);
        if (!u) {
          u = { events: 0, costUsd: 0, userMessages: 0, assistantMessages: 0 };
          perBucket.set(user, u);
        }
        return u;
      };
      for (const r of userRows) {
        const u = ensureBU(r.bucketKey, r.user);
        u.events += r.events;
        if (r.storedCostMicros > 0) {
          u.costUsd += r.storedCostMicros / 1_000_000;
        } else {
          const price = pricing.lookup(r.model);
          if (price) {
            u.costUsd += computeRowCostUsd(
              {
                input: r.inputTokens,
                output: r.outputTokens,
                cacheCreation: r.cacheCreationTokens,
                cacheRead: r.cacheReadTokens,
                reasoning: r.reasoningTokens,
              },
              price,
            );
          }
        }
      }
      for (const r of userCountRows) {
        const u = ensureBU(r.bucketKey, r.user);
        u.userMessages += r.userMessages;
        u.assistantMessages += r.assistantMessages;
      }
    }

    // 4) Final rows, sorted by bucketStart ascending.
    const rows = Array.from(acc.values())
      .map((a) => {
        const bucketStart = bucketStartMs(bucket, a.bucketKey) ?? 0;
        const byUser = userFilter
          ? undefined
          : Array.from(byUserByBucket.get(a.bucketKey)?.entries() ?? [])
              .map(([user, v]) => ({
                user,
                events: v.events,
                costUsd: roundUsd(v.costUsd),
                userMessages: v.userMessages,
                assistantMessages: v.assistantMessages,
              }))
              .sort((x, y) => y.costUsd - x.costUsd);
        return {
          bucketStart,
          bucketLabel: a.bucketKey,
          events: a.events,
          inputTokens: a.inputTokens,
          outputTokens: a.outputTokens,
          cacheCreationTokens: a.cacheCreationTokens,
          cacheReadTokens: a.cacheReadTokens,
          reasoningTokens: a.reasoningTokens,
          costUsd: roundUsd(a.costUsd),
          userMessages: a.userMessages,
          assistantMessages: a.assistantMessages,
          ...(byUser ? { byUser } : {}),
        };
      })
      .sort((a, b) => a.bucketStart - b.bucketStart);

    const body = JSON.stringify({ bucket, rows });
    writeStatsCache(cacheKey, body, isFrozenRange(until));
    return new Response(body, {
      headers: { "content-type": "application/json; charset=UTF-8" },
    });
  });

  app.post("/ingest", async (c) => {
    const presentedSecret =
      c.req.header("x-tokenleader-secret") ?? c.req.header("X-Tokenleader-Secret") ?? "";
    if (!presentedSecret || presentedSecret.length === 0) {
      return c.json({ error: "missing X-Tokenleader-Secret header" }, 400);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json body" }, 400);
    }
    if (!body || typeof body !== "object" || !Array.isArray((body as any).events))
      return c.json({ error: "body.events must be an array" }, 400);
    const rawEvents = (body as { events: unknown[] }).events;
    if (rawEvents.length === 0) return c.json({ inserted: 0, duplicates: 0 });
    if (rawEvents.length > MAX_EVENTS_PER_REQUEST)
      return c.json({ error: `too many events (max ${MAX_EVENTS_PER_REQUEST})` }, 413);
    // Per-row tolerant: validate each event, INSERT the valid ones, and skip
    // + log the invalid ones — never 400 the whole batch on one bad row. A
    // single malformed event (e.g. an empty sessionId) used to reject all
    // 1000 events in the batch, freezing the daemon in a permanent retry loop.
    const validated: TokenEvent[] = [];
    const rejected: { idx: number; reason: string }[] = [];
    for (let i = 0; i < rawEvents.length; i++) {
      const r = validateEvent(rawEvents[i], i);
      if (typeof r === "string") {
        rejected.push({ idx: i, reason: r });
        continue;
      }
      validated.push(r);
    }
    // Whole batch invalid → keep the strict 400 (preserves the validation
    // contract and never acks unauthenticated garbage). The per-row tolerance
    // is specifically for a MIX: one bad row must not sink the good ones. A
    // real daemon's batch is overwhelmingly valid, so the all-invalid case is
    // pathological — and the parser fix removes the empty-field root cause.
    if (validated.length === 0) {
      return c.json({ error: rejected[0]!.reason }, 400);
    }

    // Defense in depth: all events in a single request must share the same
    // user. Mixed-user batches are a daemon bug or a tampering attempt.
    const firstUser = validated[0]!.user;
    for (let i = 1; i < validated.length; i++) {
      if (validated[i]!.user !== firstUser) {
        return c.json(
          { error: "events have mixed `user` values; expected single user per request" },
          400,
        );
      }
    }

    // TOFU device auth: the first request for a username claims it; later
    // requests must present a secret matching one of the user's active
    // devices. Order: claim → device match → re-claim (uninstalled users
    // have no active devices, so a reinstall's fresh secret rotates the
    // claim) → link-code redemption (adds this machine as a new device) →
    // 403.
    const presentedHash = createHash("sha256").update(presentedSecret).digest("hex");
    const deviceLabel = deviceLabelFrom(c.req.header("x-tokenleader-device"));
    const existing = store.getUserSecretRow(firstUser);
    let deviceId: number;
    if (existing === null) {
      // Join gate: the FIRST claim of an unclaimed username must present
      // X-Tokenleader-Join. Claimed users (incl. the re-claim branch
      // below) are untouched: their TOFU secret rules.
      if (opts.joinToken) {
        const join = c.req.header("x-tokenleader-join") ?? "";
        if (!join || !timingSafeEqStr(join, opts.joinToken)) {
          return c.json({ error: "join_required" }, 403);
        }
      }
      const claimed = store.claimUserSecret(firstUser, presentedHash, Date.now(), deviceLabel);
      if (claimed === null) {
        // Another machine won the claim race between our read and write.
        return c.json({ error: `secret mismatch for user '${firstUser}'` }, 403);
      }
      deviceId = claimed;
    } else {
      const auth = store.authenticateDevice(firstUser, presentedHash);
      if (auth) {
        deviceId = auth.deviceId;
        // Reconcile rollback drift: an old server may have set uninstalled_at
        // while this device stayed active. In forward-only operation an
        // authenticated device implies uninstalled_at is already null, so
        // this repairs only the drift state — blocking the stranger-reclaim
        // takeover it would otherwise enable.
        if (existing.uninstalledAt !== null) store.clearUninstalledMark(firstUser);
      } else if (
        existing.uninstalledAt !== null &&
        !store.isSecretBarred(firstUser, presentedHash)
      ) {
        // Re-claim of a genuinely uninstalled handle by a fresh secret. A
        // secret barred via /devices/revoke is refused here so a kicked
        // machine's still-running daemon can't resurrect itself.
        deviceId = store.reclaimUserSecret(firstUser, presentedHash, Date.now(), deviceLabel);
      } else {
        const linkHeader = c.req.header("x-tokenleader-link") ?? "";
        if (linkHeader.length === 0) {
          return c.json({ error: `secret mismatch for user '${firstUser}'` }, 403);
        }
        if (!consumeLinkCode(firstUser, linkHeader)) {
          return c.json({ error: `link code invalid or expired for user '${firstUser}'` }, 403);
        }
        deviceId = store.linkUserDevice(firstUser, presentedHash, Date.now(), deviceLabel);
      }
    }

    // Record the check-in (build, arch, label, last-seen) on the matched
    // device. Best-effort — must never fail an otherwise-valid ingest.
    try {
      const dVer = (c.req.header("x-tokenleader-version") ?? "").trim();
      const dArch = (c.req.header("x-tokenleader-arch") ?? "").trim();
      store.recordDeviceCheckIn(
        firstUser,
        deviceId,
        dVer.length > 0 && dVer.toLowerCase() !== "dev" ? dVer.slice(0, 64) : null,
        dArch.length > 0 ? dArch.slice(0, 16) : null,
        deviceLabel,
        Date.now(),
      );
    } catch {
      // fleet tracking is non-critical; never block an ingest on it
    }

    // Company affiliation (X-Tokenleader-Company, from TOKENLEADER_COMPANY).
    // Same lifecycle as the daemon-status record above: any authenticated
    // ingest with the header present upserts (last write wins); an ABSENT
    // header never clears a stored value. Invalid values are ignored with
    // one warn — never an error response.
    try {
      const rawCompany = (c.req.header("x-tokenleader-company") ?? "").trim();
      if (rawCompany.length > 0) {
        const company = normalizeCompany(rawCompany);
        if (company !== null) {
          // Operator alias map wins over the self-reported value — fixes a
          // typo'd install without touching the teammate's machine.
          store.setUserCompany(firstUser, opts.companyAliases?.[company] ?? company);
        } else {
          console.warn(
            `[tokenleader] ignoring invalid X-Tokenleader-Company ${JSON.stringify(rawCompany)} from user '${firstUser}'`,
          );
        }
      }
    } catch {
      // company affiliation is non-critical; never block an ingest on it
    }

    // Authenticated: surface skipped events in the server log so a bad row is
    // diagnosable here instead of by spelunking each daemon. Events are
    // token-count metadata (never message content), so this is privacy-safe;
    // bounded to a 5-event sample so a misbehaving client can't bloat logs.
    if (rejected.length > 0) {
      console.warn(
        `[tokenleader] ingest skipped ${rejected.length}/${rawEvents.length} invalid event(s) from user '${firstUser}': ${JSON.stringify(
          rejected
            .slice(0, 5)
            .map((x) => ({ reason: x.reason, event: summarizeEvent(rawEvents[x.idx]) })),
        )}`,
      );
    }

    const result = store.insertMany(validated);
    if (result.inserted > 0) invalidateStatsCache();
    // Only surface `skipped` when some row was dropped — an all-valid batch
    // keeps the exact {inserted, duplicates} shape older daemons expect.
    return c.json(rejected.length > 0 ? { ...result, skipped: rejected.length } : result);
  });

  // Called by the uninstall script BEFORE it removes local state (the
  // secret must still be on disk). Auth mirrors /ingest. Unknown user →
  // 200 (idempotent); wrong secret → 403; match → set uninstalled_at
  // (idempotent — a repeat call just updates the timestamp).
  app.post("/events/uninstall", async (c) => {
    const presentedSecret =
      c.req.header("x-tokenleader-secret") ?? c.req.header("X-Tokenleader-Secret") ?? "";
    if (!presentedSecret || presentedSecret.length === 0) {
      return c.json({ error: "missing X-Tokenleader-Secret header" }, 400);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json body" }, 400);
    }
    if (!body || typeof body !== "object") return c.json({ error: "body must be an object" }, 400);
    const user = (body as { user?: unknown }).user;
    if (typeof user !== "string" || user.length === 0)
      return c.json({ error: "body.user must be non-empty string" }, 400);

    const presentedHash = createHash("sha256").update(presentedSecret).digest("hex");
    const row = store.getUserSecretRow(user);
    if (row === null) {
      return c.json({ ok: true, uninstalledAt: null });
    }
    const result = store.markUserUninstalled(user, presentedHash, Date.now());
    if (!result.matched) {
      return c.json({ error: `secret mismatch for user '${user}'` }, 403);
    }
    return c.json({ ok: true, uninstalledAt: result.uninstalledAt });
  });

  // Admin bearer gate shared by /admin/link and /admin/clear; unset → 503.
  const requireAdmin = (c: Context): Response | null => {
    if (!opts.adminToken || opts.adminToken.length === 0) {
      return c.json({ error: "admin token not configured" }, 503);
    }
    const authHeader = c.req.header("authorization") ?? "";
    const presented = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (presented.length === 0) {
      return c.json({ error: "missing bearer token" }, 401);
    }
    if (!timingSafeEqStr(presented, opts.adminToken)) {
      return c.json({ error: "invalid bearer token" }, 403);
    }
    return null;
  };

  // --- multi-device management --------------------------------------------
  // All device-secret-auth'd (the /ingest scheme), never dashboard-gated.
  // The flow: an existing machine mints a one-time pairing code, the new
  // machine installs with --link=CODE, and its first /ingest redeems the
  // code (see the link branch in /ingest above).
  const authDevice = (c: Context, user: string): { deviceId: number } | null => {
    const secret = c.req.header("x-tokenleader-secret") ?? "";
    if (secret.length === 0) return null;
    const hash = createHash("sha256").update(secret).digest("hex");
    return store.authenticateDevice(user, hash);
  };

  const parseUserBody = async (
    c: Context,
  ): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; res: Response }> => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return { ok: false, res: c.json({ error: "invalid json body" }, 400) };
    }
    const user = (body as { user?: unknown } | null)?.user;
    if (typeof user !== "string" || user.length === 0) {
      return { ok: false, res: c.json({ error: "body.user must be non-empty string" }, 400) };
    }
    return { ok: true, body: body as Record<string, unknown> };
  };

  const linkCodeResponse = (c: Context, user: string): Response => {
    const minted = mintLinkCode(user);
    const url = resolveServerUrl(c, opts.serverUrl);
    return c.json({
      user,
      code: minted.code,
      expiresAt: minted.expiresAt,
      command: `curl -fsSL ${url}/install | bash -s -- --name=${user} --link=${minted.code}`,
    });
  };

  // Mint a pairing code for adding another machine to this handle.
  app.post("/devices/link", async (c) => {
    const parsed = await parseUserBody(c);
    if (!parsed.ok) return parsed.res;
    const user = parsed.body.user as string;
    if (!authDevice(c, user)) {
      return c.json({ error: `secret mismatch for user '${user}'` }, 403);
    }
    return linkCodeResponse(c, user);
  });

  // List a user's active devices. `current` marks the one whose secret
  // authenticated this request.
  app.get("/devices", (c) => {
    const user = c.req.query("user") ?? "";
    if (user.length === 0) return c.json({ error: "user query param required" }, 400);
    const auth = authDevice(c, user);
    if (!auth) return c.json({ error: `secret mismatch for user '${user}'` }, 403);
    const devices = store
      .listUserDevices(user)
      .map((d) => ({ ...d, current: d.id === auth.deviceId }));
    return c.json({ user, devices });
  });

  // Revoke one device by id. Any of the user's devices may revoke any other
  // (including itself — that's "unlink this machine"). Revoking the last
  // device marks the user uninstalled, same as the uninstall script.
  app.post("/devices/revoke", async (c) => {
    const parsed = await parseUserBody(c);
    if (!parsed.ok) return parsed.res;
    const user = parsed.body.user as string;
    const deviceId = parsed.body.deviceId;
    if (typeof deviceId !== "number" || !Number.isInteger(deviceId)) {
      return c.json({ error: "body.deviceId must be an integer" }, 400);
    }
    if (!authDevice(c, user)) {
      return c.json({ error: `secret mismatch for user '${user}'` }, 403);
    }
    // barred=true: the deliberate-revoke path bars this secret from
    // auto-reclaim, so a kicked machine's daemon can't resurrect the handle.
    const r = store.revokeUserDevice(user, deviceId, Date.now(), true);
    if (!r.revoked) {
      return c.json({ error: "device not found (or already revoked)" }, 404);
    }
    return c.json({ ok: true, deviceId, uninstalled: r.uninstalled });
  });

  // Admin escape hatch: mint a link code with the admin bearer instead of a
  // device secret — for when a user's only machine is gone and nothing can
  // mint. Unknown users get a 404: a FIRST install needs no code.
  app.post("/admin/link", async (c) => {
    const denied = requireAdmin(c);
    if (denied) return denied;
    const parsed = await parseUserBody(c);
    if (!parsed.ok) return parsed.res;
    const user = parsed.body.user as string;
    if (store.getUserSecretRow(user) === null) {
      return c.json({ error: `unknown user '${user}' — a first install needs no link code` }, 404);
    }
    return linkCodeResponse(c, user);
  });

  app.get("/stats", (c) => {
    const user = c.req.query("user");
    if (!user) return c.json({ error: "user query param required" }, 400);
    const range = parseStatsRange(new URL(c.req.url).searchParams, now());
    if ("error" in range) return c.json({ error: range.error }, 400);
    const { since, until } = range;
    const totals = store.userTotals(user, since, until);
    const byModel = store.userByModel(user, since, until);
    const msgCounts = store.userMessageCountsForUser(user, since, until);
    const unknown: string[] = [];
    let totalUsd = 0;
    const byModelOut = byModel.map((row) => {
      // Source-provided cost (Cursor) wins over PricingCache derivation —
      // the same reconciliation /stats/admin and /stats/leaderboard apply,
      // so the dashboard's focus mode agrees with the leaderboard row.
      if (row.storedCostMicros > 0) {
        const usd = row.storedCostMicros / 1_000_000;
        totalUsd += usd;
        return { ...row, costUsd: roundUsd(usd) };
      }
      const price = pricing.lookup(row.model);
      if (!price) {
        if (!unknown.includes(row.model)) unknown.push(row.model);
        return { ...row, costUsd: 0 };
      }
      const usd = computeRowCostUsd(row, price);
      totalUsd += usd;
      return { ...row, costUsd: roundUsd(usd) };
    });
    return c.json({
      user,
      totalInputTokens: totals?.totalInputTokens ?? 0,
      totalOutputTokens: totals?.totalOutputTokens ?? 0,
      totalCacheCreationTokens: totals?.totalCacheCreationTokens ?? 0,
      totalCacheReadTokens: totals?.totalCacheReadTokens ?? 0,
      totalCostUsd: roundUsd(totalUsd),
      userMessages: msgCounts.userMessages,
      assistantMessages: msgCounts.assistantMessages,
      byModel: byModelOut,
      unknownModels: unknown,
    });
  });

  // Destructive maintenance route, gated by the admin bearer.
  // Body: { scope: "all"|"user"|"reset-user"|"full", user?: string }.
  app.post("/admin/clear", async (c) => {
    const denied = requireAdmin(c);
    if (denied) return denied;
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json body" }, 400);
    }
    if (!body || typeof body !== "object") {
      return c.json({ error: "body must be an object" }, 400);
    }
    const { scope, user } = body as { scope?: unknown; user?: unknown };
    const userStr = typeof user === "string" && user.length > 0 ? user : null;
    if (scope === "all") {
      const removed = store.clearAllEvents();
      // Cursor rows are gone too — reset the watermark or the mirror
      // never re-imports the cleared history.
      cursorMirror?.resetWatermark();
      invalidateStatsCache();
      return c.json({ scope, removed, remaining: store.count() });
    }
    if (scope === "user") {
      if (!userStr) return c.json({ error: "scope=user requires `user` field" }, 400);
      const removed = store.clearUserEvents(userStr);
      invalidateStatsCache();
      return c.json({ scope, user: userStr, removed, remaining: store.count() });
    }
    if (scope === "reset-user") {
      if (!userStr) return c.json({ error: "scope=reset-user requires `user` field" }, 400);
      const removedEvents = store.clearUserEvents(userStr);
      const removedSecret = store.clearUserSecret(userStr);
      invalidateStatsCache();
      return c.json({
        scope,
        user: userStr,
        removedEvents,
        removedSecret,
        remaining: store.count(),
      });
    }
    if (scope === "full") {
      store.clearFull();
      // clearFull deletes the persisted key; this resets in-memory state.
      cursorMirror?.resetWatermark();
      invalidateStatsCache();
      return c.json({ scope, remaining: store.count() });
    }
    return c.json({ error: "scope must be one of: all | user | reset-user | full" }, 400);
  });

  app.get("/stats/leaderboard", (c) => {
    // Validate the full range BEFORE any query so token sums and cost
    // describe the same half-open window.
    const range = parseStatsRange(new URL(c.req.url).searchParams, now());
    if ("error" in range) return c.json({ error: range.error }, 400);
    const { since, until } = range;
    const rows = store.leaderboard(since, until);
    // Per-user cost re-queries the per-model breakdown; fine for small teams.
    const out = rows.map((row) => {
      const byModel = store.userByModel(row.user, since, until);
      let usd = 0;
      for (const m of byModel) {
        // Stored cost (Cursor) wins over PricingCache — same as
        // /stats/admin, so every cost path reconciles.
        if (m.storedCostMicros > 0) {
          usd += m.storedCostMicros / 1_000_000;
          continue;
        }
        const price = pricing.lookup(m.model);
        if (!price) continue;
        usd += computeRowCostUsd(m, price);
      }
      return { ...row, costUsd: roundUsd(usd) };
    });
    return c.json(out);
  });

  // /api/v1 auth chain: own apiToken if set, else the dashboard token (a
  // token-gated dashboard with a wide-open API would leak the same
  // numbers), else open.
  const effectiveApiToken = opts.apiToken ?? opts.dashboardToken;
  mountApiV1(app, {
    store,
    pricing,
    ...(effectiveApiToken !== undefined ? { apiToken: effectiveApiToken } : {}),
  });

  // Background pricing refresh so startup never blocks; failures non-fatal.
  pricing.refreshFromUpstream().catch((err) => {
    console.warn(`[tokenleader] pricing refresh failed: ${err}`);
  });
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  if (opts.schedulePricingRefresh !== false) {
    refreshTimer = setInterval(() => {
      pricing.refreshFromUpstream().catch((err) => {
        console.warn(`[tokenleader] pricing refresh failed: ${err}`);
      });
    }, DAILY_MS);
    // Don't keep the process alive purely for this timer.
    if (typeof refreshTimer === "object" && refreshTimer && "unref" in refreshTimer) {
      (refreshTimer as { unref?: () => void }).unref?.();
    }
  }

  // Start the BinaryMirror polling loop unless the caller opted out (tests).
  if (mirror && opts.scheduleBinaryMirror !== false) {
    mirror.start().catch((err: unknown) => {
      console.warn(
        "[tokenleader] binary-mirror start failed:",
        String((err as Error)?.message ?? err),
      );
    });
  }

  // Same lifecycle for the CursorMirror.
  if (cursorMirror && opts.scheduleCursorMirror !== false) {
    cursorMirror.start().catch((err: unknown) => {
      console.warn(
        "[tokenleader] cursor-mirror start failed:",
        String((err as Error)?.message ?? err),
      );
    });
  }

  return {
    app,
    store,
    pricing,
    startedAt,
    binaryMirror: mirror,
    cursorMirror,
    stop: async () => {
      if (refreshTimer) clearInterval(refreshTimer);
      mirror?.stop();
      // Awaited: a cursor tick can be mid-insertMany; the store must not
      // be closed until it drains.
      await cursorMirror?.stop();
    },
  };
}

// --- entrypoint -----------------------------------------------------------
// Explicit Bun.serve (instead of the default-export auto-serve) so we hold
// a server handle for graceful shutdown. Config errors fail fast with one
// line + exit 1; everything else boots with zero env vars.
if (import.meta.main) {
  const { mkdirSync } = await import("node:fs");
  let cfg: ServerConfig;
  try {
    cfg = parseServerConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`[tokenleader] config error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  mkdirSync(cfg.dataDir, { recursive: true });
  // Upgrade tripwire: an orphaned cwd-relative DB while config points
  // elsewhere would silently boot an empty database.
  const legacyCwdDb = path.resolve("./tokenleader.sqlite");
  if (existsSync(legacyCwdDb) && legacyCwdDb !== cfg.dbPath) {
    console.warn(
      `[tokenleader] WARNING: ${legacyCwdDb} exists but the server uses ${cfg.dbPath} — set TOKENLEADER_DB if that file is your real database.`,
    );
  }

  // Built SPA (repo-relative). buildApp falls back to the legacy dashboard
  // when unbuilt — including under `--compile`, where this never exists.
  const webDist = path.resolve(import.meta.dir, "../../web/dist");

  const buildOpts: BuildOptions = {
    dbPath: cfg.dbPath,
    dataDir: cfg.dataDir,
    binaryCacheDir: cfg.binaryCacheDir,
    mirrorIntervalSec: cfg.mirrorIntervalSec,
    cursorIntervalSec: cfg.cursorIntervalSec,
    webDistDir: webDist,
  };
  if (cfg.serverUrl !== undefined) buildOpts.serverUrl = cfg.serverUrl;
  if (cfg.teamName !== undefined) buildOpts.teamName = cfg.teamName;
  if (cfg.adminToken !== undefined) buildOpts.adminToken = cfg.adminToken;
  if (cfg.dashboardToken !== undefined) buildOpts.dashboardToken = cfg.dashboardToken;
  if (cfg.apiToken !== undefined) buildOpts.apiToken = cfg.apiToken;
  if (cfg.joinToken !== undefined) buildOpts.joinToken = cfg.joinToken;
  if (cfg.ghRepo !== undefined) buildOpts.ghRepo = cfg.ghRepo;
  if (cfg.ghToken !== undefined) buildOpts.ghToken = cfg.ghToken;
  if (cfg.cursorToken !== undefined) buildOpts.cursorToken = cfg.cursorToken;
  if (cfg.cursorUserMap !== undefined) buildOpts.cursorUserMap = cfg.cursorUserMap;
  if (cfg.companyAliases !== undefined) buildOpts.companyAliases = cfg.companyAliases;
  const rt = buildApp(buildOpts);
  echoConfig(cfg);
  console.log(
    existsSync(path.join(webDist, "index.html"))
      ? "[tokenleader] dashboard: serving built SPA from web/dist"
      : "[tokenleader] dashboard: web/dist not built; serving legacy dashboard (cd web && bun run build)",
  );

  const server = Bun.serve({
    port: cfg.port,
    hostname: cfg.host,
    fetch: rt.app.fetch,
  });
  console.log(`[tokenleader] listening on http://${cfg.host}:${cfg.port}`);

  // Graceful shutdown: stop accepting, drain in-flight requests (Bun's
  // stop() returns without draining), stop the mirrors, then checkpoint +
  // close the DB. Hard 8s cap — WAL is crash-safe if we have to bail.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[tokenleader] ${signal} received: draining...`);
    const force = setTimeout(() => process.exit(1), 8_000);
    server.stop();
    while (typeof server.pendingRequests === "number" && server.pendingRequests > 0) {
      await Bun.sleep(50);
    }
    await rt.stop();
    rt.store.close();
    clearTimeout(force);
    process.exit(0);
  };
  // Guard against --hot re-evaluating the module and stacking listeners.
  const g = globalThis as { __tokenleaderSignalsBound?: boolean };
  if (!g.__tokenleaderSignalsBound) {
    g.__tokenleaderSignalsBound = true;
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("SIGINT", () => void shutdown("SIGINT"));
  }
}
