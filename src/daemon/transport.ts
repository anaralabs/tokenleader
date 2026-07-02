import type { DaemonDirective, IngestRequest, IngestResponse, TokenEvent } from "../types";
import { log } from "./log";

export const USER_AGENT = "tokenleader-daemon/0.1.0";
// Server caps each /ingest POST at 1000 events; match that ceiling.
// TOKENLEADER_BATCH_SIZE still wins — see daemon/main.ts.
export const DEFAULT_BATCH_SIZE = 1000;

export interface TransportOpts {
  endpoint: string; // base URL, no trailing slash
  // Per-user TOFU secret presented to the server. Daemon-generated.
  secret: string;
  // Legacy shared-bearer field. Kept optional so existing callers that
  // still set it can compile, but never sent on the wire. New code should
  // not set this.
  token?: string;
  // Daemon build version + arch, stamped on every POST so the server can
  // track which build each teammate is running (fleet visibility). Optional
  // so tests/old callers compile; default to "dev"/"" on the wire.
  version?: string;
  arch?: string;
  // Optional join code for servers that gate first-claims
  // (TOKENLEADER_JOIN_TOKEN). Sent on every POST when set — the server
  // only consults it for unclaimed handles and ignores it once claimed,
  // so "always send" is the simplest correct client behavior.
  join?: string;
  // Optional company affiliation (TOKENLEADER_COMPANY). Sent raw as
  // X-Tokenleader-Company on every ingest POST when set; the server
  // normalizes to a bare hostname and ignores invalid values.
  company?: string;
  // Short hostname, sent as X-Tokenleader-Device so the server can label
  // this machine's device row. Cosmetic — auth never consults it.
  device?: string;
  // Optional link code (TOKENLEADER_LINK, from the installer's --link
  // flag). Sent on every POST when set — the server only consults it when
  // the secret doesn't match an existing device, and ignores it after the
  // single-use redemption, so "always send" is the simplest correct
  // client behavior (same contract as `join`).
  link?: string;
  batchSize?: number;
  // Test/DI hooks. Real callers don't pass these.
  fetchImpl?: typeof fetch;
  sleepMs?: (ms: number, signal?: AbortSignal) => Promise<void>;
  attempts?: number; // default 3
  // Random source 0..1 (for jitter). Override in tests.
  random?: () => number;
}

export interface PostResult {
  ok: boolean;
  inserted: number;
  duplicates: number;
  // Reason if !ok, for logging.
  error?: string;
  // Single-shot remote action piggybacked on the server's response.
  // Old servers never set it.
  directive?: DaemonDirective;
}

const BACKOFF_BASE_MS = [1000, 4000, 16000];

function jitter(ms: number, rnd: () => number): number {
  // ±20% jitter
  const factor = 0.8 + rnd() * 0.4;
  return Math.round(ms * factor);
}

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function chunk<T>(arr: T[], size: number): T[][] {
  if (size <= 0) return [arr];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

// Wall-clock fetch timeout. In Bun 1.1.38 (verified) an AbortSignal does NOT
// interrupt a connect-phase hang — an unreachable host settles only at the
// ~75s kernel TCP timeout — so we race the fetch against a real timer; the
// AbortController still tears down the socket and lets shutdown win once
// connected. clearTimeout in finally on EVERY path, or a lingering timer
// keeps the event loop alive and inhibits App Nap between ticks.
const FETCH_TIMEOUT_MS = 20_000;
// Ingest POSTs get a longer leash: during a bulk replay the server is busy
// inserting + serving dashboards between batches, and a queued-but-working
// POST axed at 20s aborts the whole tick (offsets only advance on ack, so
// the next tick re-reads everything — a livelock against a slow server).
const INGEST_TIMEOUT_MS = 60_000;
async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  shutdown?: AbortSignal,
): Promise<Response> {
  const ac = new AbortController();
  const onShutdown = () => ac.abort();
  if (shutdown) {
    if (shutdown.aborted) ac.abort();
    else shutdown.addEventListener("abort", onShutdown, { once: true });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wall = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      reject(new Error(`fetch timeout after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return (await Promise.race([fetchImpl(url, { ...init, signal: ac.signal }), wall])) as Response;
  } finally {
    if (timer) clearTimeout(timer);
    shutdown?.removeEventListener("abort", onShutdown);
  }
}

async function postBatch(
  opts: TransportOpts,
  events: TokenEvent[],
  signal?: AbortSignal,
): Promise<PostResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleepMs ?? defaultSleep;
  const rnd = opts.random ?? Math.random;
  const attempts = opts.attempts ?? 3;
  const url = `${opts.endpoint.replace(/\/+$/, "")}/ingest`;

  let lastErr = "unknown";

  for (let i = 0; i < attempts; i++) {
    if (signal?.aborted) {
      return { ok: false, inserted: 0, duplicates: 0, error: "aborted" };
    }
    try {
      const body: IngestRequest = { events };
      const res = await fetchWithTimeout(
        fetchImpl,
        url,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
            "X-Tokenleader-Secret": opts.secret,
            // Fleet visibility: which daemon build + arch is posting. The
            // server records these per user; old servers ignore them.
            "X-Tokenleader-Version": opts.version ?? "dev",
            "X-Tokenleader-Arch": opts.arch ?? "",
            ...(opts.join ? { "X-Tokenleader-Join": opts.join } : {}),
            ...(opts.company ? { "X-Tokenleader-Company": opts.company } : {}),
            ...(opts.device ? { "X-Tokenleader-Device": opts.device } : {}),
            ...(opts.link ? { "X-Tokenleader-Link": opts.link } : {}),
          },
          body: JSON.stringify(body),
        },
        INGEST_TIMEOUT_MS,
        signal,
      );

      if (res.status >= 200 && res.status < 300) {
        const json = (await res.json()) as Partial<IngestResponse>;
        return {
          ok: true,
          inserted: typeof json.inserted === "number" ? json.inserted : 0,
          duplicates: typeof json.duplicates === "number" ? json.duplicates : 0,
          ...(isDirective(json.directive) ? { directive: json.directive } : {}),
        };
      }

      // 403 "secret mismatch" / "link code invalid": the username is
      // claimed by a different machine and this one isn't (yet) linked.
      // Retrying will keep failing — surface a loud, actionable error.
      if (res.status === 403) {
        let bodyText = "";
        try {
          bodyText = await res.text();
        } catch {}
        const lower = bodyText.toLowerCase();
        if (lower.includes("link code")) {
          log.error("post_link_invalid", {
            url,
            hint: "Link code expired or already used — run `anara-leaderboard link` on the linked machine and reinstall here with the fresh --link code",
            serverBody: bodyText.slice(0, 200),
            batchSize: events.length,
          });
          return { ok: false, inserted: 0, duplicates: 0, error: "link_invalid" };
        }
        if (lower.includes("secret mismatch")) {
          log.error("post_secret_mismatch", {
            url,
            hint: "Username already claimed by a different machine — to share the handle, run `anara-leaderboard link` there and reinstall here with --link=CODE; otherwise pick a new name",
            serverBody: bodyText.slice(0, 200),
            batchSize: events.length,
          });
          return {
            ok: false,
            inserted: 0,
            duplicates: 0,
            error: "secret_mismatch",
          };
        }
      }

      // 4xx (except 408/429) is non-retriable; the server told us "no".
      const retriable = res.status === 408 || res.status === 429 || res.status >= 500;
      lastErr = `http_${res.status}`;
      if (!retriable) {
        log.error("post_non_retriable", {
          url,
          status: res.status,
          batchSize: events.length,
        });
        return {
          ok: false,
          inserted: 0,
          duplicates: 0,
          error: lastErr,
        };
      }
      log.warn("post_retriable_status", {
        url,
        status: res.status,
        attempt: i + 1,
        batchSize: events.length,
      });
    } catch (err: unknown) {
      lastErr = String((err as Error)?.message ?? err);
      log.warn("post_threw", {
        url,
        attempt: i + 1,
        err: lastErr,
        batchSize: events.length,
      });
    }

    // Sleep before next attempt (skip if this was the last one).
    if (i < attempts - 1) {
      const baseIdx = Math.min(i, BACKOFF_BASE_MS.length - 1);
      const base = BACKOFF_BASE_MS[baseIdx]!;
      await sleep(jitter(base, rnd), signal);
    }
  }

  return {
    ok: false,
    inserted: 0,
    duplicates: 0,
    error: lastErr,
  };
}

function isDirective(v: unknown): v is DaemonDirective {
  if (!v || typeof v !== "object") return false;
  const d = v as Record<string, unknown>;
  return typeof d.id === "number" && typeof d.verb === "string" && d.verb.length > 0;
}

// Heartbeats are cheap and retried by the very next tick, so a single
// short-leash attempt is enough — never let a slow/hung heartbeat delay
// the loop the way an event POST is allowed to.
const CHECKIN_TIMEOUT_MS = 15_000;

/**
 * Liveness heartbeat for a tick that had nothing to post: stamps this
 * device's last_seen/version on the server and picks up any pending
 * directive. Best-effort — a 404 (old server), auth refusal, or network
 * error all resolve to {ok:false} and the daemon just carries on.
 */
export async function postCheckin(
  user: string,
  opts: TransportOpts,
  signal?: AbortSignal,
): Promise<{ ok: boolean; directive?: DaemonDirective }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${opts.endpoint.replace(/\/+$/, "")}/checkin`;
  try {
    const res = await fetchWithTimeout(
      fetchImpl,
      url,
      {
        method: "POST",
        headers: {
          "User-Agent": USER_AGENT,
          "X-Tokenleader-Secret": opts.secret,
          "X-Tokenleader-User": user,
          "X-Tokenleader-Version": opts.version ?? "dev",
          "X-Tokenleader-Arch": opts.arch ?? "",
          ...(opts.device ? { "X-Tokenleader-Device": opts.device } : {}),
        },
      },
      CHECKIN_TIMEOUT_MS,
      signal,
    );
    if (!res.ok) {
      // 404 = pre-directive server; 403 = unclaimed/mismatched identity
      // (a fresh install that hasn't posted its first events yet). Both
      // are expected states, not errors worth a warn.
      log.debug("checkin_http", { url, status: res.status });
      return { ok: false };
    }
    const json = (await res.json()) as { directive?: unknown };
    return {
      ok: true,
      ...(isDirective(json.directive) ? { directive: json.directive } : {}),
    };
  } catch (err: unknown) {
    log.debug("checkin_failed", { url, err: String((err as Error)?.message ?? err) });
    return { ok: false };
  }
}

/**
 * Post events to the server, splitting into batches up to `batchSize`.
 * If ANY batch fails, the whole call fails — the daemon does NOT advance
 * state on partial success. The server is idempotent so re-sending earlier
 * batches next tick is safe.
 */
export async function postEvents(
  events: TokenEvent[],
  opts: TransportOpts,
  signal?: AbortSignal,
): Promise<PostResult> {
  if (events.length === 0) {
    return { ok: true, inserted: 0, duplicates: 0 };
  }
  const size = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const batches = chunk(events, size);

  let inserted = 0;
  let duplicates = 0;
  let directive: DaemonDirective | undefined;

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]!;
    const r = await postBatch(opts, batch, signal);
    if (!r.ok) {
      log.error("post_failed", {
        batchIndex: i,
        totalBatches: batches.length,
        batchSize: batch.length,
        err: r.error,
      });
      return r;
    }
    inserted += r.inserted;
    duplicates += r.duplicates;
    // Keep the first directive seen this flush; anything else still queued
    // arrives on a later tick's response.
    directive ??= r.directive;
  }

  return { ok: true, inserted, duplicates, ...(directive ? { directive } : {}) };
}
