import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestApp, jsonOf, makeTmpDirSync, makeTokenEvent } from "../test-helpers.ts";
import type { TokenEvent } from "../types.ts";
import { BinaryMirror } from "./binary-mirror.ts";
import { normalizeCompany } from "./company.ts";
import { Store } from "./db.ts";
import { buildApp } from "./main.ts";

// Each user's daemon picks its own random secret on first run; the server
// claims it TOFU-style. Tests pre-assign per-user secrets so we can drive
// the API directly.
const ALICE_SECRET = "alice-secret-aaaa";
const BOB_SECRET = "bob-secret-bbbb";
const CAROL_SECRET = "carol-secret-cccc";

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

let harness: ReturnType<typeof createTestApp>;
let app: ReturnType<typeof buildApp>["app"];
let store: ReturnType<typeof buildApp>["store"];

beforeAll(() => {
  harness = createTestApp();
  app = harness.app;
  store = harness.store;
});

afterAll(async () => {
  await harness.cleanup();
});

const makeEvent = (overrides: Partial<TokenEvent> = {}): TokenEvent =>
  makeTokenEvent({
    sessionId: "sess-1",
    messageId: "msg-1",
    requestId: "req-1",
    inputTokens: 100,
    outputTokens: 50,
    cacheCreationTokens: 10,
    cacheReadTokens: 20,
    ...overrides,
  });

function ingestReq(events: TokenEvent[], secret: string): Request {
  return new Request("http://x/ingest", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-tokenleader-secret": secret,
    },
    body: JSON.stringify({ events }),
  });
}

describe("server", () => {
  test("/health is unauthenticated", async () => {
    const res = await app.request(new Request("http://x/health"));
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.ok).toBe(true);
    expect(typeof body.uptimeMs).toBe("number");
    expect(typeof body.eventsCount).toBe("number");
  });

  test("/health does zero DB work (still 200 after store.close())", async () => {
    // The constant-time contract is load-bearing: container healthchecks
    // probe /health every few seconds and a COUNT(*) there blocks the
    // event loop. A closed DB throws on any statement, so a 200 here
    // proves the handler never touches SQLite (the count is cached).
    const built = createTestApp();
    try {
      built.store.close();
      const res = await built.app.request(new Request("http://x/health"));
      expect(res.status).toBe(200);
      const body = await jsonOf(res);
      expect(body.ok).toBe(true);
      expect(typeof body.eventsCount).toBe("number");
    } finally {
      await built.cleanup();
    }
  });

  test("/ingest rejects missing X-Tokenleader-Secret header", async () => {
    const res = await app.request(
      new Request("http://x/ingest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ events: [makeEvent()] }),
      }),
    );
    expect(res.status).toBe(400);
    const body = await jsonOf(res);
    expect(body.error).toContain("X-Tokenleader-Secret");
  });

  test("/ingest rejects empty X-Tokenleader-Secret header", async () => {
    const res = await app.request(
      new Request("http://x/ingest", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-tokenleader-secret": "",
        },
        body: JSON.stringify({ events: [makeEvent()] }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("/ingest first POST claims username TOFU-style and inserts events", async () => {
    const events = [
      makeEvent({ messageId: "m-a", user: "alice" }),
      makeEvent({ messageId: "m-b", user: "alice" }),
    ];
    const res = await app.request(ingestReq(events, ALICE_SECRET));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ inserted: 2, duplicates: 0 });
    // Username is now claimed in user_secrets.
    expect(store.getUserSecretHash("alice")).toBe(sha256Hex(ALICE_SECRET));
  });

  test("/ingest second POST with the SAME secret succeeds", async () => {
    const events = [makeEvent({ messageId: "m-a2", user: "alice" })];
    const res = await app.request(ingestReq(events, ALICE_SECRET));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ inserted: 1, duplicates: 0 });
  });

  test("/ingest second POST with a DIFFERENT secret for same user is 403", async () => {
    const events = [makeEvent({ messageId: "m-attacker", user: "alice" })];
    const res = await app.request(ingestReq(events, "totally-wrong-secret"));
    expect(res.status).toBe(403);
    const body = await jsonOf(res);
    expect(body.error).toContain("secret mismatch");
    expect(body.error).toContain("alice");
  });

  test("/ingest rejects mixed-user events (400)", async () => {
    const res = await app.request(
      ingestReq(
        [
          makeEvent({ messageId: "mx-1", user: "alice" }),
          makeEvent({ messageId: "mx-2", user: "bob" }),
        ],
        ALICE_SECRET,
      ),
    );
    expect(res.status).toBe(400);
    const body = await jsonOf(res);
    expect(body.error).toContain("mixed");
  });

  test("/ingest first POST for a fresh user claims that user", async () => {
    const res = await app.request(
      ingestReq(
        [
          makeEvent({
            messageId: "m-c",
            user: "bob",
            source: "codex",
            model: "gpt-5",
            reasoningTokens: 200,
            inputTokens: 10,
            outputTokens: 5,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
          }),
        ],
        BOB_SECRET,
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ inserted: 1, duplicates: 0 });
    expect(store.getUserSecretHash("bob")).toBe(sha256Hex(BOB_SECRET));
  });

  test("/ingest dedups identical events", async () => {
    const dup = makeEvent({ messageId: "m-a", user: "alice" });
    const res = await app.request(ingestReq([dup, dup], ALICE_SECRET));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ inserted: 0, duplicates: 2 });
  });

  test("/ingest dedup respects requestId differentiation", async () => {
    const a = makeEvent({ messageId: "m-shared", requestId: "r-1" });
    const b = makeEvent({ messageId: "m-shared", requestId: "r-2" });
    const res = await app.request(ingestReq([a, b], ALICE_SECRET));
    expect(await res.json()).toEqual({ inserted: 2, duplicates: 0 });
  });

  test("/ingest validates field types", async () => {
    const bad = { ...makeEvent(), inputTokens: "lots" } as unknown as TokenEvent;
    const res = await app.request(ingestReq([bad], ALICE_SECRET));
    expect(res.status).toBe(400);
  });

  test("/ingest rejects > 1000 events", async () => {
    const events = Array.from({ length: 1001 }, (_, i) => makeEvent({ messageId: `cap-${i}` }));
    const res = await app.request(ingestReq(events, ALICE_SECRET));
    expect(res.status).toBe(413);
  });

  test("/stats aggregates per-user totals and byModel (public, no auth)", async () => {
    const res = await app.request(new Request("http://x/stats?user=alice"));
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.user).toBe("alice");
    // alice has m-a + m-b + m-shared(r1) + m-shared(r2) = 4 events × {in:100,out:50,cc:10,cr:20}
    // plus m-a2 from the "same secret succeeds" test (5 events)
    expect(body.totalInputTokens).toBe(500);
    expect(body.totalOutputTokens).toBe(250);
    expect(body.totalCacheCreationTokens).toBe(50);
    expect(body.totalCacheReadTokens).toBe(100);
    expect(Array.isArray(body.byModel)).toBe(true);
    expect(body.byModel[0].model).toBe("claude-sonnet-4-5");
    expect(body.byModel[0].count).toBe(5);
  });

  test("/stats filters by since", async () => {
    const res = await app.request(new Request("http://x/stats?user=alice&since=9999999999999"));
    const body = await jsonOf(res);
    expect(body.totalInputTokens).toBe(0);
    expect(body.byModel).toEqual([]);
  });

  test("/stats/leaderboard returns users sorted by total (public)", async () => {
    const res = await app.request(new Request("http://x/stats/leaderboard"));
    expect(res.status).toBe(200);
    const body = await jsonOf<any[]>(res);
    expect(Array.isArray(body)).toBe(true);
    // alice has way more tokens than bob
    expect(body[0].user).toBe("alice");
    expect(body[1].user).toBe("bob");
  });

  test("/stats is public (no bearer required)", async () => {
    const res = await app.request(new Request("http://x/stats?user=alice"));
    expect(res.status).toBe(200);
  });

  test("/stats includes totalCostUsd, per-row costUsd, unknownModels", async () => {
    const res = await app.request(new Request("http://x/stats?user=alice"));
    const body = await jsonOf(res);
    expect(typeof body.totalCostUsd).toBe("number");
    expect(body.totalCostUsd).toBeGreaterThan(0);
    expect(Array.isArray(body.unknownModels)).toBe(true);
    expect(body.unknownModels).toEqual([]);
    for (const row of body.byModel) {
      expect(typeof row.costUsd).toBe("number");
    }
    // The aggregate matches the row sum to within rounding.
    const rowSum = body.byModel.reduce((s: number, r: { costUsd: number }) => s + r.costUsd, 0);
    expect(Math.abs(body.totalCostUsd - rowSum)).toBeLessThan(0.001);
  });

  test("/ingest accepts cursor_local source events", async () => {
    const events = [
      makeEvent({
        messageId: "cursor-b1",
        user: "alice",
        source: "cursor_local",
        model: "cursor",
      }),
    ];
    const res = await app.request(ingestReq(events, ALICE_SECRET));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ inserted: 1, duplicates: 0 });
  });

  test("/ingest accepts claude_cowork source events", async () => {
    const events = [
      makeEvent({
        messageId: "cowork-a1",
        user: "alice",
        source: "claude_cowork",
        model: "claude-opus-4-6",
      }),
    ];
    const res = await app.request(ingestReq(events, ALICE_SECRET));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ inserted: 1, duplicates: 0 });
  });

  test("/ingest is per-row tolerant: lands valid events, skips invalid ones", async () => {
    // The Andrew incident: one bad row (empty sessionId, as a cowork/cursor
    // parser could emit) must NOT 400 the whole batch — the good events land.
    const events = [
      makeEvent({ messageId: "tol-good", user: "alice", sessionId: "s-ok" }),
      makeEvent({ messageId: "tol-bad", user: "alice", sessionId: "" }),
    ];
    const res = await app.request(ingestReq(events, ALICE_SECRET));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ inserted: 1, duplicates: 0, skipped: 1 });
  });

  test("/ingest still 400s when EVERY event is invalid (no valid rows)", async () => {
    const events = [makeEvent({ messageId: "all-bad", user: "alice", sessionId: "" })];
    const res = await app.request(ingestReq(events, ALICE_SECRET));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("sessionId");
  });

  test("/ingest accepts cursor cloud events with costUsdMicros", async () => {
    const events = [
      makeEvent({
        messageId: "cloud-1",
        user: "alice",
        source: "cursor",
        model: "claude-4.5-sonnet",
        costUsdMicros: 12_300,
      }),
    ];
    const res = await app.request(ingestReq(events, ALICE_SECRET));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ inserted: 1, duplicates: 0 });
    const stats = await jsonOf(await app.request(new Request("http://x/stats?user=alice")));
    const row = stats.byModel.find((m: { model: string }) => m.model === "claude-4.5-sonnet");
    expect(row?.costUsd).toBeCloseTo(0.0123, 5);
  });

  test("/ingest cursor events replace cursor_local rows at the same timestamp", async () => {
    const user = "reconcileuser";
    const secret = "reconcile-secret";
    const ts = Date.UTC(2026, 5, 10, 12, 0, 0);
    await app.request(
      ingestReq(
        [
          makeEvent({
            user,
            source: "cursor_local",
            messageId: "local-bubble",
            timestamp: ts,
            model: "cursor",
            inputTokens: 999,
            outputTokens: 999,
          }),
        ],
        secret,
      ),
    );
    await app.request(
      ingestReq(
        [
          makeEvent({
            user,
            source: "cursor",
            messageId: "cloud-event",
            timestamp: ts,
            model: "claude-4.5-sonnet",
            inputTokens: 100,
            outputTokens: 50,
            costUsdMicros: 50_000,
          }),
        ],
        secret,
      ),
    );
    const stats = await jsonOf(await app.request(new Request(`http://x/stats?user=${user}`)));
    expect(stats.byModel.some((m: { model: string }) => m.model === "cursor")).toBe(false);
    const cloud = stats.byModel.find((m: { model: string }) => m.model === "claude-4.5-sonnet");
    expect(cloud?.input).toBe(100);
    expect(cloud?.costUsd).toBeCloseTo(0.05, 5);
  });

  test("/ingest cursor events reconcile cursor_local rows across the span (not byte-equal)", async () => {
    const user = "spanuser";
    const secret = "span-secret";
    // Local (composer createdAt / DB-mtime) timestamps; cloud (per-request
    // epoch-ms) timestamps are derived independently and never byte-equal.
    const localInSpanTs = Date.UTC(2026, 5, 10, 12, 7, 31);
    const localOutOfSpanTs = Date.UTC(2026, 5, 10, 9, 0, 0);
    const cloudMinTs = Date.UTC(2026, 5, 10, 12, 0, 4);
    const cloudMaxTs = Date.UTC(2026, 5, 10, 12, 15, 22);
    await app.request(
      ingestReq(
        [
          makeEvent({
            user,
            source: "cursor_local",
            messageId: "local-in-span",
            timestamp: localInSpanTs,
            model: "cursor",
            inputTokens: 777,
            outputTokens: 777,
          }),
          makeEvent({
            user,
            source: "cursor_local",
            messageId: "local-out-of-span",
            timestamp: localOutOfSpanTs,
            model: "cursor",
            inputTokens: 123,
            outputTokens: 456,
          }),
        ],
        secret,
      ),
    );
    await app.request(
      ingestReq(
        [
          makeEvent({
            user,
            source: "cursor",
            messageId: "cloud-lo",
            timestamp: cloudMinTs,
            model: "claude-4.5-sonnet",
            inputTokens: 100,
            outputTokens: 50,
            costUsdMicros: 40_000,
          }),
          makeEvent({
            user,
            source: "cursor",
            messageId: "cloud-hi",
            timestamp: cloudMaxTs,
            model: "claude-4.5-sonnet",
            inputTokens: 200,
            outputTokens: 80,
            costUsdMicros: 60_000,
          }),
        ],
        secret,
      ),
    );
    const stats = await jsonOf(await app.request(new Request(`http://x/stats?user=${user}`)));
    // The local row inside the cloud span is removed; the one before the span
    // survives — so the surviving `cursor` model carries only its tokens.
    const local = stats.byModel.find((m: { model: string }) => m.model === "cursor");
    expect(local?.input).toBe(123);
    expect(local?.output).toBe(456);
    const cloud = stats.byModel.find((m: { model: string }) => m.model === "claude-4.5-sonnet");
    expect(cloud?.input).toBe(300);
  });

  test("/ingest rejects costUsdMicros above the per-event ceiling", async () => {
    const over = makeEvent({
      user: "alice",
      messageId: "cost-over",
      source: "cursor",
      model: "claude-4.5-sonnet",
      costUsdMicros: 100_000_001,
    });
    const res = await app.request(ingestReq([over], ALICE_SECRET));
    expect(res.status).toBe(400);
    const body = await jsonOf(res);
    expect(body.error).toContain("costUsdMicros exceeds maximum");

    const ok = makeEvent({
      user: "alice",
      messageId: "cost-at-cap",
      source: "cursor",
      model: "claude-4.5-sonnet",
      costUsdMicros: 100_000_000,
    });
    const okRes = await app.request(ingestReq([ok], ALICE_SECRET));
    expect(okRes.status).toBe(200);
    expect(await okRes.json()).toEqual({ inserted: 1, duplicates: 0 });
  });

  test("/stats reports unknown models in unknownModels", async () => {
    const ev: TokenEvent = makeEvent({
      user: "carol",
      messageId: "carol-1",
      model: "totally-fake-model-xyz-2099",
    });
    await app.request(ingestReq([ev], CAROL_SECRET));
    const res = await app.request(new Request("http://x/stats?user=carol"));
    const body = await jsonOf(res);
    expect(body.unknownModels).toContain("totally-fake-model-xyz-2099");
    expect(body.totalCostUsd).toBe(0);
    expect(body.byModel[0].costUsd).toBe(0);
  });

  test("/stats/leaderboard includes costUsd per user", async () => {
    const res = await app.request(new Request("http://x/stats/leaderboard"));
    const body = await jsonOf<Array<{ user: string; costUsd: number }>>(res);
    for (const row of body) {
      expect(typeof row.costUsd).toBe("number");
    }
    const alice = body.find((r) => r.user === "alice");
    expect(alice).toBeDefined();
    expect(alice!.costUsd).toBeGreaterThan(0);
  });

  test("GET / serves admin dashboard html", async () => {
    const res = await app.request(new Request("http://x/"));
    expect(res.status).toBe(200);
    const ct = res.headers.get("content-type") || "";
    expect(ct.startsWith("text/html")).toBe(true);
    const text = await res.text();
    expect(text).toContain("TOKENLEADER");
    expect(text).toContain("/stats/admin");
    // Geist font + HSL token vars are present in the response.
    expect(text).toContain("fonts.googleapis.com/css2?family=Geist");
    expect(text).toContain("--background-primary");
    expect(text.toLowerCase()).toContain("<!doctype html>");
    // Read-only bearer logic removed (stats are public).
    expect(text).not.toContain("Authentication Required");
    // The dashboard still purges the legacy bearer-token localStorage key.
    expect(text).toContain("removeItem(LEGACY_TOKEN_KEY)");
    expect(text).toContain('"tokenleaderToken"'); // LEGACY_TOKEN_KEY value
    // Range picker + danger zone are present.
    expect(text).toContain("range-picker");
    expect(text).toContain("danger-zone");
    expect(text).toContain("tokenleaderAdminToken");
    // Theme override classes + keyboard toggle.
    expect(text).toContain("theme-dark");
    expect(text).toContain("tokenleaderTheme");
  });

  describe("SPA static serving (webDistDir)", () => {
    let webDir: string;
    let rmWebDir: () => void;
    let spa: ReturnType<typeof createTestApp>;

    beforeAll(() => {
      ({ dir: webDir, cleanup: rmWebDir } = makeTmpDirSync("tokenleader-webdist-"));
      writeFileSync(
        join(webDir, "index.html"),
        "<!doctype html><html><body>SPA-MARKER</body></html>",
      );
      mkdirSync(join(webDir, "assets"));
      writeFileSync(join(webDir, "assets", "index-abc123.js"), "console.log(1)");
      spa = createTestApp({ webDistDir: webDir });
    });

    afterAll(async () => {
      await spa.cleanup();
      rmWebDir();
    });

    test("GET / serves the built index.html", async () => {
      const res = await spa.app.request(new Request("http://x/"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.text()).toContain("SPA-MARKER");
    });

    test("GET /admin serves the same SPA shell (history-mode route)", async () => {
      const res = await spa.app.request(new Request("http://x/admin"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.text()).toContain("SPA-MARKER");
    });

    test("GET /assets/* serves hashed bundles with immutable caching", async () => {
      const res = await spa.app.request(new Request("http://x/assets/index-abc123.js"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/javascript");
      expect(res.headers.get("cache-control")).toContain("immutable");
      expect(await res.text()).toBe("console.log(1)");
    });

    test("GET /assets/* 404s on missing files and directories", async () => {
      const missing = await spa.app.request(new Request("http://x/assets/nope.js"));
      expect(missing.status).toBe(404);
      // Bare assets dir (empty rel path) must not stream a directory.
      const dir = await spa.app.request(new Request("http://x/assets/"));
      expect(dir.status).toBe(404);
    });

    test("GET /assets/* blocks percent-encoded traversal", async () => {
      // Raw ../ collapses at the URL layer; the encoded form reaches the
      // handler and must be contained inside assets/.
      const res = await spa.app.request(new Request("http://x/assets/%2e%2e/index.html"));
      expect(res.status).toBe(404);
    });

    test("falls back to the legacy dashboard when webDistDir lacks a build", async () => {
      const empty = makeTmpDirSync("tokenleader-nodist-");
      const legacy = createTestApp({
        webDistDir: join(empty.dir, "does-not-exist"),
      });
      try {
        const res = await legacy.app.request(new Request("http://x/"));
        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text).toContain("TOKENLEADER");
        expect(text).toContain("range-picker");
      } finally {
        await legacy.cleanup();
        empty.cleanup();
      }
    });
  });

  describe("branding (/brand/* + serve-time title injection)", () => {
    // The SPA shell placeholders injectBranding rewrites — mirrors
    // web/index.html's <title> and og:title lines.
    const SHELL_HTML = `<!doctype html><html><head>
<title>tokenleader</title>
<meta property="og:title" content="tokenleader" />
</head><body>SPA-MARKER</body></html>`;
    const TEAM = "Acme & Co <script>alert(1)</script>";
    const DASH_TOKEN = "brand-dash-token";
    let dir: string;
    let rmDir: () => void;
    let branded: ReturnType<typeof createTestApp>;

    beforeAll(() => {
      ({ dir, cleanup: rmDir } = makeTmpDirSync("tokenleader-brand-test-"));
      mkdirSync(join(dir, "dist"));
      writeFileSync(join(dir, "dist", "index.html"), SHELL_HTML);
      branded = createTestApp({
        dataDir: join(dir, "data"),
        webDistDir: join(dir, "dist"),
        teamName: TEAM,
        dashboardToken: DASH_TOKEN,
      });
    });

    afterAll(async () => {
      await branded.cleanup();
      rmDir();
    });

    test("/brand/* serves the built-in neutral SVGs when <data-dir>/brand is absent", async () => {
      for (const f of ["logo.svg", "favicon.svg"]) {
        const res = await branded.app.request(new Request(`http://x/brand/${f}`));
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("image/svg+xml");
        expect(res.headers.get("cache-control")).toBe("public, max-age=300");
        const body = await res.text();
        expect(body).toContain("<svg");
        expect(body).toContain("prefers-color-scheme");
      }
    });

    test("/brand/* works without a dataDir at all (defaults always serve)", async () => {
      // The module-level app was built with no dataDir.
      const res = await app.request(new Request("http://x/brand/logo.svg"));
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("<svg");
    });

    test("/brand/* is UNGATED even with a dashboard token (favicon on /login)", async () => {
      // No cookie, no bearer, browser accept header — the dashboard gate
      // would 302 this to /login if /brand were gated.
      const res = await branded.app.request(
        new Request("http://x/brand/favicon.svg", {
          headers: { accept: "text/html,image/svg+xml" },
        }),
      );
      expect(res.status).toBe(200);
    });

    test("operator file in <data-dir>/brand/ overrides the built-in", async () => {
      const CUSTOM = '<svg xmlns="http://www.w3.org/2000/svg"><!-- custom-mark --></svg>';
      mkdirSync(join(dir, "data", "brand"), { recursive: true });
      writeFileSync(join(dir, "data", "brand", "logo.svg"), CUSTOM);
      const res = await branded.app.request(new Request("http://x/brand/logo.svg"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/svg+xml");
      expect(res.headers.get("cache-control")).toBe("public, max-age=300");
      expect(await res.text()).toBe(CUSTOM);
      // favicon.svg was NOT overridden — still the built-in.
      const fav = await branded.app.request(new Request("http://x/brand/favicon.svg"));
      expect(await fav.text()).toContain("prefers-color-scheme");
    });

    test("GET / injects the team name into <title> + og:title, escaped", async () => {
      const res = await branded.app.request(
        new Request("http://x/", {
          headers: { authorization: `Bearer ${DASH_TOKEN}` },
        }),
      );
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("SPA-MARKER");
      // The operator-supplied <script> must come out escaped...
      expect(html).not.toContain("<script>");
      expect(html).toContain(
        "<title>tokenleader · Acme &amp; Co &lt;script&gt;alert(1)&lt;/script&gt;</title>",
      );
      expect(html).toContain(
        'content="tokenleader · Acme &amp; Co &lt;script&gt;alert(1)&lt;/script&gt;"',
      );
    });

    test("GET /admin serves the same injected shell", async () => {
      const res = await branded.app.request(
        new Request("http://x/admin", {
          headers: { authorization: `Bearer ${DASH_TOKEN}` },
        }),
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("<title>tokenleader · Acme &amp; Co");
    });

    test("/login carries /brand/favicon.svg + the branded (escaped) title", async () => {
      const res = await branded.app.request(new Request("http://x/login"));
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('href="/brand/favicon.svg"');
      expect(html).not.toContain("<script>alert(1)</script>");
      expect(html).toContain(
        "<title>tokenleader · Acme &amp; Co &lt;script&gt;alert(1)&lt;/script&gt; — login</title>",
      );
    });

    test("no team name → the shell passes through with the bare title", async () => {
      const plainTmp = makeTmpDirSync("tokenleader-brand-plain-");
      mkdirSync(join(plainTmp.dir, "dist"));
      writeFileSync(join(plainTmp.dir, "dist", "index.html"), SHELL_HTML);
      const plain = createTestApp({ webDistDir: join(plainTmp.dir, "dist") });
      try {
        const res = await plain.app.request(new Request("http://x/"));
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toContain("<title>tokenleader</title>");
        expect(html).toContain('content="tokenleader"');
      } finally {
        await plain.cleanup();
        plainTmp.cleanup();
      }
    });
  });

  test("/stats/admin is public (no bearer)", async () => {
    const res = await app.request(new Request("http://x/stats/admin"));
    expect(res.status).toBe(200);
  });

  test("/stats/admin returns the documented snapshot shape", async () => {
    const res = await app.request(new Request("http://x/stats/admin"));
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    // server block
    expect(body.server).toBeDefined();
    expect(typeof body.server.uptimeMs).toBe("number");
    expect(typeof body.server.eventsCount).toBe("number");
    expect(typeof body.server.dbSizeBytes).toBe("number");
    expect(body.server.dbSizeBytes).toBeGreaterThan(0);
    expect(body.server.lastEventAt === null || typeof body.server.lastEventAt === "number").toBe(
      true,
    );
    // Release identity for the dashboard footer strip.
    expect(typeof body.server.version).toBe("string");
    expect(body.server.version.length).toBeGreaterThan(0);
    // No joinToken on this app → open TOFU → hero renders no --join flag.
    expect(body.server.joinRequired).toBe(false);
    // leaderboard
    expect(Array.isArray(body.leaderboard)).toBe(true);
    expect(body.leaderboard.length).toBeGreaterThan(0);
    const lbRow = body.leaderboard[0];
    for (const k of [
      "user",
      "totalInputTokens",
      "totalOutputTokens",
      "totalCacheCreationTokens",
      "totalCacheReadTokens",
      "costUsd",
      "eventCount",
      "lastEventAt",
      "modelCount",
      "company",
    ]) {
      expect(lbRow).toHaveProperty(k);
    }
    expect(typeof lbRow.eventCount).toBe("number");
    expect(typeof lbRow.modelCount).toBe("number");
    expect(typeof lbRow.costUsd).toBe("number");
    // byModel
    expect(Array.isArray(body.byModel)).toBe(true);
    expect(body.byModel.length).toBeGreaterThan(0);
    const m0 = body.byModel[0];
    for (const k of [
      "model",
      "count",
      "inputTokens",
      "outputTokens",
      "cacheCreationTokens",
      "cacheReadTokens",
      "costUsd",
      "unknownPrice",
    ]) {
      expect(m0).toHaveProperty(k);
    }
    expect(typeof m0.unknownPrice).toBe("boolean");
    // The fake model from an earlier test should be flagged unknown.
    const fake = body.byModel.find(
      (r: { model: string }) => r.model === "totally-fake-model-xyz-2099",
    );
    expect(fake).toBeDefined();
    expect(fake!.unknownPrice).toBe(true);
    expect(fake!.costUsd).toBe(0);
    // recent
    expect(Array.isArray(body.recent)).toBe(true);
    expect(body.recent.length).toBeGreaterThan(0);
    expect(body.recent.length).toBeLessThanOrEqual(50);
    const r0 = body.recent[0];
    for (const k of ["id", "user", "source", "model", "timestamp", "totalTokens"]) {
      expect(r0).toHaveProperty(k);
    }
    // newest first
    for (let i = 1; i < body.recent.length; i++) {
      expect(body.recent[i - 1].id).toBeGreaterThan(body.recent[i].id);
    }
  });

  test("/stats/admin accepts since/until range filter", async () => {
    // since in the far future → leaderboard collapses to empty
    const farFuture = Date.now() + 365 * 24 * 60 * 60 * 1000;
    const res = await app.request(new Request(`http://x/stats/admin?since=${farFuture}`));
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.leaderboard).toEqual([]);
    expect(body.byModel).toEqual([]);
  });

  test("/stats/admin rejects malformed since", async () => {
    const res = await app.request(new Request("http://x/stats/admin?since=-1"));
    expect(res.status).toBe(400);
  });

  test("/stats/timeseries returns documented shape (day bucket)", async () => {
    const res = await app.request(new Request("http://x/stats/timeseries?bucket=day"));
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.bucket).toBe("day");
    expect(Array.isArray(body.rows)).toBe(true);
    expect(body.rows.length).toBeGreaterThan(0);
    const row = body.rows[0];
    for (const k of [
      "bucketStart",
      "bucketLabel",
      "events",
      "inputTokens",
      "outputTokens",
      "cacheCreationTokens",
      "cacheReadTokens",
      "reasoningTokens",
      "costUsd",
      "byUser",
    ]) {
      expect(row).toHaveProperty(k);
    }
    expect(typeof row.bucketStart).toBe("number");
    expect(typeof row.bucketLabel).toBe("string");
    expect(typeof row.events).toBe("number");
    expect(typeof row.costUsd).toBe("number");
    expect(Array.isArray(row.byUser)).toBe(true);
    // Day bucket labels look like "YYYY-MM-DD".
    expect(/^\d{4}-\d{2}-\d{2}$/.test(row.bucketLabel)).toBe(true);
    // bucketStart should round-trip into the same UTC date.
    const recovered = new Date(row.bucketStart).toISOString().slice(0, 10);
    expect(recovered).toBe(row.bucketLabel);
    // Rows are sorted ascending by bucketStart.
    for (let i = 1; i < body.rows.length; i++) {
      expect(body.rows[i - 1].bucketStart).toBeLessThanOrEqual(body.rows[i].bucketStart);
    }
  });

  test("/stats/timeseries omits byUser when filtered to a single user", async () => {
    const res = await app.request(new Request("http://x/stats/timeseries?bucket=day&user=alice"));
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.rows.length).toBeGreaterThan(0);
    // No byUser key on any row when the user filter is in effect.
    for (const row of body.rows) {
      expect(row.byUser).toBeUndefined();
    }
  });

  test("/stats/timeseries accepts week and month buckets", async () => {
    const w = await jsonOf(await app.request(new Request("http://x/stats/timeseries?bucket=week")));
    const m = await jsonOf(
      await app.request(new Request("http://x/stats/timeseries?bucket=month")),
    );
    expect(w.bucket).toBe("week");
    expect(m.bucket).toBe("month");
    expect(w.rows.length).toBeGreaterThan(0);
    expect(m.rows.length).toBeGreaterThan(0);
    expect(/^\d{4}-W\d{2}$/.test(w.rows[0].bucketLabel)).toBe(true);
    expect(/^\d{4}-\d{2}$/.test(m.rows[0].bucketLabel)).toBe(true);
  });

  test("/stats/timeseries rejects invalid bucket", async () => {
    const res = await app.request(new Request("http://x/stats/timeseries?bucket=hour"));
    expect(res.status).toBe(400);
  });

  test("/stats/admin exposes top-level messages totals and per-row user/assistant counts", async () => {
    const res = await app.request(new Request("http://x/stats/admin"));
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    // top-level messages block, totals across the filtered range.
    expect(body.messages).toBeDefined();
    expect(typeof body.messages.userMessages).toBe("number");
    expect(typeof body.messages.assistantMessages).toBe("number");
    // All seeded fixtures are assistant rows, so the assistant total is the
    // events count and the user total is 0.
    expect(body.messages.assistantMessages).toBeGreaterThan(0);
    expect(body.messages.userMessages).toBe(0);
    // Per-row carries the split too.
    for (const row of body.leaderboard) {
      expect(typeof row.userMessages).toBe("number");
      expect(typeof row.assistantMessages).toBe("number");
      // eventCount is the assistant-row count (token-bearing). Should match.
      expect(row.assistantMessages).toBe(row.eventCount);
    }
  });

  test("/stats/timeseries rows carry userMessages/assistantMessages per bucket and per user", async () => {
    const res = await app.request(new Request("http://x/stats/timeseries?bucket=day"));
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.rows.length).toBeGreaterThan(0);
    for (const row of body.rows) {
      expect(typeof row.userMessages).toBe("number");
      expect(typeof row.assistantMessages).toBe("number");
      // events (assistant-only) and assistantMessages should match
      // because the only seeded rows are assistant.
      expect(row.assistantMessages).toBe(row.events);
      // byUser entries also carry the split.
      if (Array.isArray(row.byUser)) {
        for (const bu of row.byUser) {
          expect(typeof bu.userMessages).toBe("number");
          expect(typeof bu.assistantMessages).toBe("number");
        }
      }
    }
  });

  test("/stats?user= includes userMessages and assistantMessages", async () => {
    const res = await app.request(new Request("http://x/stats?user=alice"));
    const body = await jsonOf(res);
    expect(typeof body.userMessages).toBe("number");
    expect(typeof body.assistantMessages).toBe("number");
    // alice's fixtures are all assistant.
    expect(body.assistantMessages).toBeGreaterThan(0);
    expect(body.userMessages).toBe(0);
  });
});

// Schema migration: re-opening a Store on the same DB file must be a no-op.
// This is the test that catches accidental DDL drift between releases.
describe("Store schema migration idempotency", () => {
  test("rebuilding Store on the same DB file does not throw", () => {
    const { dir, cleanup } = makeTmpDirSync("tokenleader-migrate-test-");
    const dbPath = join(dir, "tl.sqlite");
    try {
      // First open creates the schema + applies the messageType migration.
      const s1 = new Store(dbPath);
      // Insert an event under the new schema so the column actually exists.
      s1.insertMany([
        {
          user: "u1",
          source: "claude_code",
          sessionId: "s",
          messageId: "m1",
          requestId: null,
          timestamp: Date.now(),
          model: "claude-sonnet-4-5",
          messageType: "assistant",
          inputTokens: 1,
          outputTokens: 1,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          reasoningTokens: null,
        },
      ]);
      s1.close();

      // Second open should re-apply the migration without erroring (the
      // ALTER TABLE is gated behind a PRAGMA table_info check; the index
      // rebuild uses DROP IF EXISTS + CREATE IF NOT EXISTS).
      const s2 = new Store(dbPath);
      expect(s2.count()).toBe(1);
      // And a user-message row must coexist with an assistant row that has
      // the same messageId (different messageType ⇒ different dedup row).
      const ins = s2.insertMany([
        {
          user: "u1",
          source: "claude_code",
          sessionId: "s",
          messageId: "m1",
          requestId: null,
          timestamp: Date.now(),
          model: "",
          messageType: "user",
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          reasoningTokens: null,
        },
      ]);
      expect(ins.inserted).toBe(1);
      s2.close();

      // Third open: still idempotent.
      const s3 = new Store(dbPath);
      expect(s3.count()).toBe(2);
      s3.close();
    } finally {
      cleanup();
    }
  });
});

// ----- /events/uninstall + Store.markUserUninstalled + re-claim ------------
// Lifecycle: install (claim) → uninstall (mark) → re-install (re-claim).
// Each scenario gets a fresh app/store so the global alice/bob/carol fixtures
// above stay untouched.

describe("Store.markUserUninstalled", () => {
  function fresh() {
    const { dir, cleanup: rmDir } = makeTmpDirSync("tokenleader-uninst-store-");
    const dbPath = join(dir, "tl.sqlite");
    const store = new Store(dbPath);
    return {
      store,
      dbPath,
      cleanup: () => {
        store.close();
        rmDir();
      },
    };
  }

  test("uninstalled_at migration is idempotent across re-opens", () => {
    const { store: s1, dbPath, cleanup } = fresh();
    try {
      // Claim a user under the (newly migrated) schema.
      s1.claimUserSecret("u1", sha256Hex("sec-1"), 1_000);
      s1.close();
      // Re-open: migration runs again and must be a no-op.
      const s2 = new Store(dbPath);
      expect(s2.getUserSecretHash("u1")).toBe(sha256Hex("sec-1"));
      // Mark uninstalled and verify the column persists across opens.
      const r = s2.markUserUninstalled("u1", sha256Hex("sec-1"), 2_000);
      expect(r.matched).toBe(true);
      expect(r.uninstalledAt).toBe(2_000);
      s2.close();
      // Third open: migration is still a no-op and uninstalled_at is intact.
      const s3 = new Store(dbPath);
      const list = s3.listUninstalledUsers();
      expect(list).toEqual([{ user: "u1", uninstalledAt: 2_000 }]);
      s3.close();
    } finally {
      cleanup();
    }
  });

  test("success: matched secret stamps uninstalled_at", () => {
    const { store, cleanup } = fresh();
    try {
      store.claimUserSecret("u1", sha256Hex("sec-1"), 1_000);
      const r = store.markUserUninstalled("u1", sha256Hex("sec-1"), 2_000);
      expect(r.matched).toBe(true);
      expect(r.uninstalledAt).toBe(2_000);
      expect(store.getUserSecretRow("u1")?.uninstalledAt).toBe(2_000);
    } finally {
      cleanup();
    }
  });

  test("wrong secret returns matched:false and does not stamp", () => {
    const { store, cleanup } = fresh();
    try {
      store.claimUserSecret("u1", sha256Hex("sec-1"), 1_000);
      const r = store.markUserUninstalled("u1", sha256Hex("wrong"), 2_000);
      expect(r.matched).toBe(false);
      expect(r.uninstalledAt).toBe(null);
      expect(store.getUserSecretRow("u1")?.uninstalledAt).toBe(null);
    } finally {
      cleanup();
    }
  });

  test("unknown user returns matched:false (caller decides 200 vs 403)", () => {
    const { store, cleanup } = fresh();
    try {
      const r = store.markUserUninstalled("nope", sha256Hex("sec-1"), 2_000);
      expect(r.matched).toBe(false);
      expect(r.uninstalledAt).toBe(null);
    } finally {
      cleanup();
    }
  });
});

describe("/events/uninstall", () => {
  function uninstReq(user: string, secret: string): Request {
    return new Request("http://x/events/uninstall", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tokenleader-secret": secret,
      },
      body: JSON.stringify({ user }),
    });
  }

  test("200 on first call: stamps uninstalled_at and returns the timestamp", async () => {
    const { app: a, store: s, cleanup } = createTestApp();
    try {
      // Claim alice TOFU-style.
      await a.request(ingestReq([makeEvent({ user: "alice" })], ALICE_SECRET));
      const res = await a.request(uninstReq("alice", ALICE_SECRET));
      expect(res.status).toBe(200);
      const body = await jsonOf(res);
      expect(body.ok).toBe(true);
      expect(typeof body.uninstalledAt).toBe("number");
      expect(s.getUserSecretRow("alice")?.uninstalledAt).toBe(body.uninstalledAt);
    } finally {
      cleanup();
    }
  });

  test("200 again on second call: idempotent, timestamp updates", async () => {
    const { app: a, store: s, cleanup } = createTestApp();
    try {
      await a.request(ingestReq([makeEvent({ user: "alice" })], ALICE_SECRET));
      const r1 = await a.request(uninstReq("alice", ALICE_SECRET));
      const b1 = await jsonOf(r1);
      // Sleep a millisecond so Date.now() advances.
      await new Promise((r) => setTimeout(r, 2));
      const r2 = await a.request(uninstReq("alice", ALICE_SECRET));
      expect(r2.status).toBe(200);
      const b2 = await jsonOf(r2);
      expect(b2.ok).toBe(true);
      expect(b2.uninstalledAt).toBeGreaterThanOrEqual(b1.uninstalledAt);
      expect(s.getUserSecretRow("alice")?.uninstalledAt).toBe(b2.uninstalledAt);
    } finally {
      cleanup();
    }
  });

  test("403 on wrong secret with the same helpful 'secret mismatch' body", async () => {
    const { app: a, cleanup } = createTestApp();
    try {
      await a.request(ingestReq([makeEvent({ user: "alice" })], ALICE_SECRET));
      const res = await a.request(uninstReq("alice", "totally-wrong"));
      expect(res.status).toBe(403);
      const body = await jsonOf(res);
      expect(body.error).toContain("secret mismatch");
      expect(body.error).toContain("alice");
    } finally {
      cleanup();
    }
  });

  test("200 for unknown user (idempotent no-op, returns uninstalledAt:null)", async () => {
    const { app: a, cleanup } = createTestApp();
    try {
      const res = await a.request(uninstReq("ghost", "anything"));
      expect(res.status).toBe(200);
      const body = await jsonOf(res);
      expect(body.ok).toBe(true);
      expect(body.uninstalledAt).toBe(null);
    } finally {
      cleanup();
    }
  });

  test("400 on missing secret header", async () => {
    const { app: a, cleanup } = createTestApp();
    try {
      const res = await a.request(
        new Request("http://x/events/uninstall", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ user: "alice" }),
        }),
      );
      expect(res.status).toBe(400);
    } finally {
      cleanup();
    }
  });

  test("400 on missing/empty user", async () => {
    const { app: a, cleanup } = createTestApp();
    try {
      const res = await a.request(
        new Request("http://x/events/uninstall", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-tokenleader-secret": "anything",
          },
          body: JSON.stringify({}),
        }),
      );
      expect(res.status).toBe(400);
    } finally {
      cleanup();
    }
  });

  test("/stats/admin exposes the `uninstalled` array", async () => {
    const { app: a, cleanup } = createTestApp();
    try {
      await a.request(ingestReq([makeEvent({ user: "alice" })], ALICE_SECRET));
      await a.request(uninstReq("alice", ALICE_SECRET));
      const res = await a.request(new Request("http://x/stats/admin"));
      const body = await jsonOf(res);
      expect(Array.isArray(body.uninstalled)).toBe(true);
      expect(body.uninstalled.length).toBe(1);
      expect(body.uninstalled[0].user).toBe("alice");
      expect(typeof body.uninstalled[0].uninstalledAt).toBe("number");
    } finally {
      cleanup();
    }
  });
});

describe("/ingest re-claim after uninstall", () => {
  test("after uninstall, a NEW secret succeeds (TOFU re-claim) and rotates the hash", async () => {
    const built = createTestApp();
    try {
      const { app: a, store: s } = built;
      // 1) Original install claims alice.
      const r1 = await a.request(
        ingestReq([makeEvent({ user: "alice", messageId: "mc-1" })], "original-sec"),
      );
      expect(r1.status).toBe(200);
      const originalHash = s.getUserSecretHash("alice");
      expect(originalHash).toBe(sha256Hex("original-sec"));

      // 2) Without uninstall, a different secret must 403 (sanity check).
      const r2 = await a.request(
        ingestReq([makeEvent({ user: "alice", messageId: "mc-2" })], "new-sec"),
      );
      expect(r2.status).toBe(403);

      // 3) Uninstall stamps uninstalled_at.
      const ur = await a.request(
        new Request("http://x/events/uninstall", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-tokenleader-secret": "original-sec",
          },
          body: JSON.stringify({ user: "alice" }),
        }),
      );
      expect(ur.status).toBe(200);
      expect(s.getUserSecretRow("alice")?.uninstalledAt).not.toBe(null);

      // 4) Re-install: a fresh secret succeeds and rotates the stored hash,
      //    AND clears uninstalled_at back to null.
      const r3 = await a.request(
        ingestReq([makeEvent({ user: "alice", messageId: "mc-3" })], "new-sec"),
      );
      expect(r3.status).toBe(200);
      expect(s.getUserSecretHash("alice")).toBe(sha256Hex("new-sec"));
      expect(s.getUserSecretRow("alice")?.uninstalledAt).toBe(null);

      // 5) After re-claim the OLD secret no longer works.
      const r4 = await a.request(
        ingestReq([makeEvent({ user: "alice", messageId: "mc-4" })], "original-sec"),
      );
      expect(r4.status).toBe(403);
    } finally {
      await built.cleanup();
    }
  });
});

// ----- /admin/clear — isolated from the shared-store tests above ----------
// We build a fresh app per test so we don't pollute the alice/bob fixtures.

describe("/admin/clear gating", () => {
  function withFreshApp(adminToken?: string) {
    return createTestApp(adminToken !== undefined ? { adminToken } : {});
  }

  test("returns 503 when TOKENLEADER_ADMIN_TOKEN is unset", async () => {
    const { app: a, cleanup } = withFreshApp(undefined);
    try {
      const res = await a.request(
        new Request("http://x/admin/clear", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ scope: "all" }),
        }),
      );
      expect(res.status).toBe(503);
      const body = await jsonOf(res);
      expect(body.error).toContain("admin token not configured");
    } finally {
      cleanup();
    }
  });

  test("rejects requests without a Bearer header", async () => {
    const { app: a, cleanup } = withFreshApp("topsecret-xyz");
    try {
      const res = await a.request(
        new Request("http://x/admin/clear", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ scope: "all" }),
        }),
      );
      expect(res.status).toBe(401);
    } finally {
      cleanup();
    }
  });

  test("rejects requests with a wrong Bearer", async () => {
    const { app: a, cleanup } = withFreshApp("topsecret-xyz");
    try {
      const res = await a.request(
        new Request("http://x/admin/clear", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer not-the-right-token",
          },
          body: JSON.stringify({ scope: "all" }),
        }),
      );
      expect(res.status).toBe(403);
    } finally {
      cleanup();
    }
  });

  test("accepts correct Bearer, wipes events table (scope=all)", async () => {
    const { app: a, store: s, cleanup } = withFreshApp("topsecret-xyz");
    try {
      // Seed an event.
      await a.request(ingestReq([makeEvent({ user: "u1" })], "secret-1"));
      expect(s.count()).toBeGreaterThan(0);
      const res = await a.request(
        new Request("http://x/admin/clear", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer topsecret-xyz",
          },
          body: JSON.stringify({ scope: "all" }),
        }),
      );
      expect(res.status).toBe(200);
      const body = await jsonOf(res);
      expect(body.removed).toBeGreaterThanOrEqual(1);
      expect(body.remaining).toBe(0);
      // user_secrets row preserved — re-posting under same secret still works.
      expect(s.getUserSecretHash("u1")).not.toBeNull();
    } finally {
      cleanup();
    }
  });

  test("scope=reset-user clears events AND TOFU claim", async () => {
    const { app: a, store: s, cleanup } = withFreshApp("topsecret-xyz");
    try {
      await a.request(ingestReq([makeEvent({ user: "u1" })], "secret-1"));
      await a.request(ingestReq([makeEvent({ user: "u2", messageId: "m-2" })], "secret-2"));
      const res = await a.request(
        new Request("http://x/admin/clear", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer topsecret-xyz",
          },
          body: JSON.stringify({ scope: "reset-user", user: "u1" }),
        }),
      );
      expect(res.status).toBe(200);
      const body = await jsonOf(res);
      expect(body.removedEvents).toBeGreaterThanOrEqual(1);
      expect(body.removedSecret).toBe(1);
      expect(s.getUserSecretHash("u1")).toBeNull();
      // u2 was untouched.
      expect(s.getUserSecretHash("u2")).not.toBeNull();
    } finally {
      cleanup();
    }
  });

  test("rejects unknown scope", async () => {
    const { app: a, cleanup } = withFreshApp("topsecret-xyz");
    try {
      const res = await a.request(
        new Request("http://x/admin/clear", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer topsecret-xyz",
          },
          body: JSON.stringify({ scope: "nuke-everything" }),
        }),
      );
      expect(res.status).toBe(400);
    } finally {
      cleanup();
    }
  });
});

describe("/manifest.json + /bin/* (daemon self-update endpoints)", () => {
  // Each test gets its own BinaryMirror with a pre-populated cacheDir
  // (the post-tick state). The mirror is injected via opts.binaryMirror so
  // buildApp doesn't construct one from ghToken; scheduleBinaryMirror:false
  // keeps the polling timer from firing.
  function withApp(cacheDir?: string) {
    const mirror = cacheDir
      ? new BinaryMirror({
          cacheDir,
          ghRepo: "example-org/leaderboard",
          ghToken: "test-token",
          // Never actually fetches because we don't call start().
          fetchImpl: (async () => {
            throw new Error("test BinaryMirror should not hit network");
          }) as unknown as typeof fetch,
        })
      : undefined;
    return createTestApp({
      scheduleBinaryMirror: false,
      ...(mirror ? { binaryMirror: mirror } : {}),
    });
  }

  function makeManifest(armSha: string, x64Sha: string): string {
    return JSON.stringify({
      version: "test-1",
      publishedAt: new Date().toISOString(),
      arm64: { sha256: armSha },
      x64: { sha256: x64Sha },
    });
  }

  test("GET /manifest.json returns 503 when the mirror has not fetched yet", async () => {
    const { dir: cacheDir, cleanup: rmCache } = makeTmpDirSync("tokenleader-empty-bin-");
    const { app, cleanup } = withApp(cacheDir);
    try {
      const res = await app.fetch(new Request("http://x/manifest.json"));
      expect(res.status).toBe(503);
    } finally {
      cleanup();
      rmCache();
    }
  });

  test("GET /manifest.json returns 503 when no mirror configured (no ghToken)", async () => {
    // No binaryCacheDir + no ghToken + no binaryMirror → routes 503 with
    // the "binary mirror not configured" body.
    const { app, cleanup } = withApp();
    try {
      const res = await app.fetch(new Request("http://x/manifest.json"));
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("not configured");
    } finally {
      cleanup();
    }
  });

  test("GET /manifest.json serves the cached file verbatim", async () => {
    const { dir: cacheDir, cleanup: rmCache } = makeTmpDirSync("tokenleader-bin-");
    const body = makeManifest("a".repeat(64), "b".repeat(64));
    writeFileSync(join(cacheDir, "manifest.json"), body);
    const { app, cleanup } = withApp(cacheDir);
    try {
      const res = await app.fetch(new Request("http://x/manifest.json"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      const got = await res.text();
      expect(got).toBe(body);
    } finally {
      cleanup();
      rmCache();
    }
  });

  test("GET /manifest.json sets an ETag; If-None-Match replays get 304 with no body", async () => {
    const { dir: cacheDir, cleanup: rmCache } = makeTmpDirSync("tokenleader-bin-");
    const body = makeManifest("a".repeat(64), "b".repeat(64));
    writeFileSync(join(cacheDir, "manifest.json"), body);
    const { app, cleanup } = withApp(cacheDir);
    try {
      const first = await app.fetch(new Request("http://x/manifest.json"));
      expect(first.status).toBe(200);
      const etag = first.headers.get("etag");
      expect(etag).toMatch(/^"[0-9a-f]{64}"$/); // sha256 of the manifest bytes
      expect(await first.text()).toBe(body);

      // Daemon replay: matching If-None-Match → 304, empty body, ETag kept.
      const second = await app.fetch(
        new Request("http://x/manifest.json", {
          headers: { "if-none-match": etag! },
        }),
      );
      expect(second.status).toBe(304);
      expect(second.headers.get("etag")).toBe(etag);
      expect(second.headers.get("cache-control")).toBe("no-store");
      expect(await second.text()).toBe("");

      // Stale ETag still gets the full 200.
      const third = await app.fetch(
        new Request("http://x/manifest.json", {
          headers: { "if-none-match": '"' + "0".repeat(64) + '"' },
        }),
      );
      expect(third.status).toBe(200);
      expect(await third.text()).toBe(body);
    } finally {
      cleanup();
      rmCache();
    }
  });

  test("GET /manifest.json 5xx when cached file is invalid JSON", async () => {
    const { dir: cacheDir, cleanup: rmCache } = makeTmpDirSync("tokenleader-bin-");
    writeFileSync(join(cacheDir, "manifest.json"), "this is not json{{{");
    const { app, cleanup } = withApp(cacheDir);
    try {
      const res = await app.fetch(new Request("http://x/manifest.json"));
      expect(res.status).toBe(500);
    } finally {
      cleanup();
      rmCache();
    }
  });

  test("GET /bin/anara-leaderboard-arm64 streams the file with correct headers", async () => {
    const { dir: cacheDir, cleanup: rmCache } = makeTmpDirSync("tokenleader-bin-");
    const bytes = new Uint8Array(1024 * 32); // 32 KB stand-in
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
    writeFileSync(join(cacheDir, "anara-leaderboard-arm64"), bytes);
    const { app, cleanup } = withApp(cacheDir);
    try {
      const res = await app.fetch(new Request("http://x/bin/anara-leaderboard-arm64"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/octet-stream");
      expect(res.headers.get("content-length")).toBe(String(bytes.length));
      const got = new Uint8Array(await res.arrayBuffer());
      expect(got.length).toBe(bytes.length);
      // Spot-check a few bytes (full byte-equality is implied by the
      // length match + matching cursor positions).
      expect(got[0]).toBe(0);
      expect(got[255]).toBe(255);
      expect(got[256]).toBe(0);
    } finally {
      cleanup();
      rmCache();
    }
  });

  test("GET /bin/anara-leaderboard-x86_64 is aliased to the x64 file", async () => {
    // Path-param accepts arm64 | x64 | x86_64. The mirror only stores
    // files under `anara-leaderboard-x64`; the route normalizes x86_64
    // to x64 transparently.
    const { dir: cacheDir, cleanup: rmCache } = makeTmpDirSync("tokenleader-bin-");
    const bytes = new Uint8Array(64);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i;
    writeFileSync(join(cacheDir, "anara-leaderboard-x64"), bytes);
    const { app, cleanup } = withApp(cacheDir);
    try {
      const res = await app.fetch(new Request("http://x/bin/anara-leaderboard-x86_64"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-length")).toBe(String(bytes.length));
    } finally {
      cleanup();
      rmCache();
    }
  });

  test("GET /bin/anara-leaderboard-<unknown-arch> 404s (allowlist)", async () => {
    const { dir: cacheDir, cleanup: rmCache } = makeTmpDirSync("tokenleader-bin-");
    // Even if a same-prefix file exists, an arch outside the allowlist
    // must 404 — the route normalizes via normalizeArch().
    writeFileSync(join(cacheDir, "anara-leaderboard-arm64"), "ok");
    const { app, cleanup } = withApp(cacheDir);
    try {
      const res = await app.fetch(new Request("http://x/bin/anara-leaderboard-riscv"));
      expect(res.status).toBe(404);
    } finally {
      cleanup();
      rmCache();
    }
  });

  test("GET /bin/anara-leaderboard-x64 503s when the file is missing", async () => {
    const { dir: cacheDir, cleanup: rmCache } = makeTmpDirSync("tokenleader-bin-");
    const { app, cleanup } = withApp(cacheDir);
    try {
      const res = await app.fetch(new Request("http://x/bin/anara-leaderboard-x64"));
      expect(res.status).toBe(503);
    } finally {
      cleanup();
      rmCache();
    }
  });
});

describe("fleet version tracking (/stats/fleet)", () => {
  // Fresh app per test (own DB). Pass a manifest version to back the mirror so
  // isLatest can be exercised; omit it for the no-manifest path.
  function withFleetApp(manifestVersion?: string, adminToken?: string) {
    let mirror: BinaryMirror | undefined;
    if (manifestVersion) {
      const cacheDir = mkdtempSync(join(tmpdir(), "tokenleader-fleet-bin-"));
      writeFileSync(
        join(cacheDir, "manifest.json"),
        JSON.stringify({
          version: manifestVersion,
          publishedAt: "2026-06-03T00:00:00Z",
          arm64: { sha256: "a".repeat(64) },
          x64: { sha256: "b".repeat(64) },
        }),
      );
      mirror = new BinaryMirror({
        cacheDir,
        ghRepo: "example-org/leaderboard",
        ghToken: "test-token",
        fetchImpl: (async () => {
          throw new Error("test BinaryMirror should not hit network");
        }) as unknown as typeof fetch,
      });
    }
    return createTestApp({
      scheduleBinaryMirror: false,
      ...(mirror ? { binaryMirror: mirror } : {}),
      ...(adminToken !== undefined ? { adminToken } : {}),
    });
  }

  function ingestAs(
    user: string,
    secret: string,
    extraHeaders: Record<string, string> = {},
  ): Request {
    return new Request("http://x/ingest", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tokenleader-secret": secret,
        ...extraHeaders,
      },
      body: JSON.stringify({
        events: [makeEvent({ user, messageId: "fleet-" + user })],
      }),
    });
  }

  test("ingest with a version header records the build; /stats/fleet reports it as latest", async () => {
    const { app, cleanup } = withFleetApp("v-LATEST");
    try {
      const res = await app.request(
        ingestAs("eve", "eve-secret", {
          "x-tokenleader-version": "v-LATEST",
          "x-tokenleader-arch": "arm64",
        }),
      );
      expect(res.status).toBe(200);

      const body = await jsonOf<{ latestVersion: string; fleet: any[] }>(
        await app.request(new Request("http://x/stats/fleet")),
      );
      expect(body.latestVersion).toBe("v-LATEST");
      const eve = body.fleet.find((f) => f.user === "eve");
      expect(eve).toBeDefined();
      expect(eve.version).toBe("v-LATEST");
      expect(eve.arch).toBe("arm64");
      expect(eve.reporting).toBe(true);
      expect(eve.isLatest).toBe(true);
      expect(typeof eve.lastSeen).toBe("number");
    } finally {
      cleanup();
    }
  });

  test("a daemon on an older build is flagged isLatest=false", async () => {
    const { app, cleanup } = withFleetApp("v-LATEST");
    try {
      await app.request(
        ingestAs("frank", "frank-secret", {
          "x-tokenleader-version": "v-OLD",
          "x-tokenleader-arch": "x64",
        }),
      );
      const body = await jsonOf<{ fleet: any[] }>(
        await app.request(new Request("http://x/stats/fleet")),
      );
      const frank = body.fleet.find((f) => f.user === "frank");
      expect(frank.version).toBe("v-OLD");
      expect(frank.arch).toBe("x64");
      expect(frank.reporting).toBe(true);
      expect(frank.isLatest).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("re-ingest upserts the version (one fleet row per user, not duplicated)", async () => {
    const { app, cleanup } = withFleetApp("v-LATEST");
    try {
      await app.request(ingestAs("gwen", "gwen-secret", { "x-tokenleader-version": "v-OLD" }));
      await app.request(ingestAs("gwen", "gwen-secret", { "x-tokenleader-version": "v-LATEST" }));
      const body = await jsonOf<{ fleet: any[] }>(
        await app.request(new Request("http://x/stats/fleet")),
      );
      const rows = body.fleet.filter((f) => f.user === "gwen");
      expect(rows.length).toBe(1);
      expect(rows[0].version).toBe("v-LATEST");
      expect(rows[0].isLatest).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("legacy daemons (no version header) and explicit 'dev' surface as unknown/reporting=false", async () => {
    const { app, cleanup } = withFleetApp("v-LATEST");
    try {
      await app.request(ingestAs("heidi", "heidi-secret")); // no version header
      await app.request(ingestAs("ivan", "ivan-secret", { "x-tokenleader-version": "dev" }));
      const body = await jsonOf<{ fleet: any[] }>(
        await app.request(new Request("http://x/stats/fleet")),
      );
      for (const u of ["heidi", "ivan"]) {
        const row = body.fleet.find((f) => f.user === u);
        expect(row).toBeDefined();
        expect(row.version).toBeNull();
        expect(row.reporting).toBe(false);
        expect(row.isLatest).toBe(false);
      }
    } finally {
      cleanup();
    }
  });

  test("/stats/fleet with no manifest: latestVersion null, nobody flagged stale-vs-latest", async () => {
    const { app, cleanup } = withFleetApp(); // no mirror
    try {
      await app.request(
        ingestAs("judy", "judy-secret", {
          "x-tokenleader-version": "v-XYZ",
          "x-tokenleader-arch": "arm64",
        }),
      );
      const body = await jsonOf<{
        latestVersion: string | null;
        fleet: any[];
      }>(await app.request(new Request("http://x/stats/fleet")));
      expect(body.latestVersion).toBeNull();
      const judy = body.fleet.find((f) => f.user === "judy");
      expect(judy.version).toBe("v-XYZ");
      expect(judy.reporting).toBe(true);
      expect(judy.isLatest).toBeNull(); // tri-state: can't compare without a manifest
    } finally {
      cleanup();
    }
  });

  test("reset-user and full clear forget the user's daemon_status row", async () => {
    const { app, cleanup } = withFleetApp("v-LATEST", "admin-tok-xyz");
    const clear = (b: object) =>
      app.request(
        new Request("http://x/admin/clear", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer admin-tok-xyz",
          },
          body: JSON.stringify(b),
        }),
      );
    const fleet = async () =>
      (await jsonOf<{ fleet: any[] }>(await app.request(new Request("http://x/stats/fleet"))))
        .fleet;
    try {
      await app.request(ingestAs("kara", "kara-secret", { "x-tokenleader-version": "v-LATEST" }));
      await app.request(ingestAs("liam", "liam-secret", { "x-tokenleader-version": "v-LATEST" }));
      expect((await fleet()).find((f) => f.user === "kara").reporting).toBe(true);

      // reset-user clears kara's daemon_status row; a header-less re-claim then
      // shows "unknown", not her stale version.
      expect((await clear({ scope: "reset-user", user: "kara" })).status).toBe(200);
      await app.request(ingestAs("kara", "kara-fresh-secret")); // legacy daemon, no version header
      const kara = (await fleet()).find((f) => f.user === "kara");
      expect(kara).toBeDefined();
      expect(kara.version).toBeNull();
      expect(kara.reporting).toBe(false);

      // full clear empties daemon_status along with events + user_secrets.
      expect((await clear({ scope: "full" })).status).toBe(200);
      expect((await fleet()).length).toBe(0);
    } finally {
      cleanup();
    }
  });
});

// ----- company affiliation (X-Tokenleader-Company) --------------------------
// Daemon env TOKENLEADER_COMPANY → header on /ingest POSTs only. A present
// header on an authenticated ingest upserts user_secrets.company (last write
// wins); an ABSENT header never clears; an invalid value is ignored with a
// warn — never an error response.

describe("normalizeCompany", () => {
  test("url: scheme + path/query/fragment + port stripped", () => {
    expect(normalizeCompany("https://www.Anara.com/path")).toBe("anara.com");
    expect(normalizeCompany("http://sub.example.com:8080/a/b?q=1#frag")).toBe("sub.example.com");
    expect(normalizeCompany("example.com:443")).toBe("example.com");
  });

  test("case: lowercased", () => {
    expect(normalizeCompany("Anara.com")).toBe("anara.com");
    expect(normalizeCompany("EXAMPLE.CO.UK")).toBe("example.co.uk");
  });

  test("www: one leading www. stripped (inner ones kept)", () => {
    expect(normalizeCompany("www.anara.com")).toBe("anara.com");
    expect(normalizeCompany("www.www.example.com")).toBe("www.example.com");
  });

  test("already-bare domains pass through", () => {
    expect(normalizeCompany("anara.com")).toBe("anara.com");
    expect(normalizeCompany(" anara.com ")).toBe("anara.com");
  });

  test("garbage → null", () => {
    expect(normalizeCompany("")).toBeNull();
    expect(normalizeCompany("   ")).toBeNull();
    expect(normalizeCompany("not a domain")).toBeNull();
    expect(normalizeCompany("nodot")).toBeNull();
    expect(normalizeCompany("ex!ample.com")).toBeNull();
    expect(normalizeCompany("example.c")).toBeNull(); // TLD < 2 chars
    expect(normalizeCompany("example.123")).toBeNull(); // numeric TLD
    expect(normalizeCompany("https://")).toBeNull();
  });

  test("length: ≤ 64 chars after normalization", () => {
    const exactly64 = `${"a".repeat(60)}.com`;
    expect(normalizeCompany(exactly64)).toBe(exactly64);
    expect(normalizeCompany(`${"a".repeat(61)}.com`)).toBeNull(); // 65
    // Stripping can bring an over-long raw value under the cap.
    expect(normalizeCompany(`https://www.${exactly64}/long/path`)).toBe(exactly64);
  });
});

describe("company affiliation (X-Tokenleader-Company on /ingest)", () => {
  function ingestAs(
    user: string,
    secret: string,
    opts: { company?: string; messageId?: string } = {},
  ): Request {
    return new Request("http://x/ingest", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tokenleader-secret": secret,
        ...(opts.company !== undefined ? { "x-tokenleader-company": opts.company } : {}),
      },
      body: JSON.stringify({
        events: [makeEvent({ user, messageId: opts.messageId ?? `co-${user}` })],
      }),
    });
  }

  test("header on the first (claiming) ingest sets company; /stats/admin row carries it", async () => {
    const res = await app.request(
      ingestAs("mia", "mia-secret", { company: "https://www.Anara.com/about" }),
    );
    expect(res.status).toBe(200);
    expect(store.getUserCompany("mia")).toBe("anara.com");

    const body = await jsonOf<{ leaderboard: Array<{ user: string; company: string | null }> }>(
      await app.request(new Request("http://x/stats/admin")),
    );
    const row = body.leaderboard.find((r) => r.user === "mia");
    expect(row).toBeDefined();
    expect(row!.company).toBe("anara.com");
  });

  test("header on a later ingest upserts (last write wins)", async () => {
    await app.request(
      ingestAs("noa", "noa-secret", { company: "old.example.com", messageId: "co-noa-1" }),
    );
    expect(store.getUserCompany("noa")).toBe("old.example.com");

    const res = await app.request(
      ingestAs("noa", "noa-secret", { company: "New.Example.org", messageId: "co-noa-2" }),
    );
    expect(res.status).toBe(200);
    expect(store.getUserCompany("noa")).toBe("new.example.org");
  });

  test("absent header preserves the stored value", async () => {
    await app.request(ingestAs("oli", "oli-secret", { company: "anara.com", messageId: "co-1" }));
    expect(store.getUserCompany("oli")).toBe("anara.com");

    const res = await app.request(ingestAs("oli", "oli-secret", { messageId: "co-2" }));
    expect(res.status).toBe(200);
    expect(store.getUserCompany("oli")).toBe("anara.com");

    // Empty header value is treated as absent, not as a clear.
    const res2 = await app.request(
      ingestAs("oli", "oli-secret", { company: "", messageId: "co-3" }),
    );
    expect(res2.status).toBe(200);
    expect(store.getUserCompany("oli")).toBe("anara.com");
  });

  test("invalid header value is ignored — ingest succeeds, row stays null", async () => {
    const res = await app.request(ingestAs("pam", "pam-secret", { company: "not a domain!!" }));
    expect(res.status).toBe(200);
    expect(await jsonOf<{ inserted: number; duplicates: number }>(res)).toEqual({
      inserted: 1,
      duplicates: 0,
    });
    expect(store.getUserCompany("pam")).toBeNull();

    const body = await jsonOf<{ leaderboard: Array<{ user: string; company: string | null }> }>(
      await app.request(new Request("http://x/stats/admin")),
    );
    expect(body.leaderboard.find((r) => r.user === "pam")!.company).toBeNull();
  });
});

// ----- company filter (?company= on /stats/admin + /stats/timeseries) ------
// Scope: events whose user is claimed under user_secrets.company = <value>.
// The param normalizes via normalizeCompany (400 on garbage); a valid but
// unknown domain is an empty 200. The admin payload always carries the
// GLOBAL `companies` list so the dashboard's filter pills survive an active
// filter. On /stats/timeseries, user= (the narrower scope) wins.

describe("company filter (?company=)", () => {
  let built: ReturnType<typeof createTestApp>;

  // ada @ a.com: assistant events on Jun 1 + Jun 2 and a user message on
  // Jun 1. bea @ b.com: one gpt-5 event on Jun 3. cal (no company): one
  // event on Jun 4. All seeded through /ingest so the X-Tokenleader-Company
  // header path populates user_secrets.company.
  beforeAll(async () => {
    built = createTestApp();
    const post = (events: TokenEvent[], secret: string, company?: string) =>
      built.app.request(
        new Request("http://x/ingest", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-tokenleader-secret": secret,
            ...(company !== undefined ? { "x-tokenleader-company": company } : {}),
          },
          body: JSON.stringify({ events }),
        }),
      );
    const r1 = await post(
      [
        makeEvent({ user: "ada", messageId: "cf-ada-1", timestamp: Date.UTC(2026, 5, 1) }),
        makeEvent({ user: "ada", messageId: "cf-ada-2", timestamp: Date.UTC(2026, 5, 2) }),
        makeEvent({
          user: "ada",
          messageId: "cf-ada-u1",
          messageType: "user",
          model: "",
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          timestamp: Date.UTC(2026, 5, 1, 1),
        }),
      ],
      "ada-secret",
      "a.com",
    );
    expect(r1.status).toBe(200);
    const r2 = await post(
      [
        makeEvent({
          user: "bea",
          messageId: "cf-bea-1",
          model: "gpt-5",
          timestamp: Date.UTC(2026, 5, 3),
        }),
      ],
      "bea-secret",
      "b.com",
    );
    expect(r2.status).toBe(200);
    const r3 = await post(
      [makeEvent({ user: "cal", messageId: "cf-cal-1", timestamp: Date.UTC(2026, 5, 4) })],
      "cal-secret",
    );
    expect(r3.status).toBe(200);
  });

  afterAll(async () => {
    await built.cleanup();
  });

  test("/stats/admin?company=a.com scopes leaderboard, totals, models, recent to that company", async () => {
    const res = await built.app.request(new Request("http://x/stats/admin?company=a.com"));
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    // Only ada — bea (b.com) and cal (no company) are out.
    expect(body.leaderboard.map((r: any) => r.user)).toEqual(["ada"]);
    const ada = body.leaderboard[0];
    expect(ada.assistantMessages).toBe(2);
    expect(ada.userMessages).toBe(1);
    expect(ada.totalInputTokens).toBe(200); // 2 × 100
    expect(ada.totalOutputTokens).toBe(100); // 2 × 50
    expect(ada.company).toBe("a.com");
    // Message totals are summed over the filtered set.
    expect(body.messages).toEqual({ userMessages: 1, assistantMessages: 2 });
    // Per-model aggregation only sees ada's model.
    expect(body.byModel.map((m: any) => m.model)).toEqual(["claude-sonnet-4-5"]);
    expect(body.byModel[0].count).toBe(2);
    expect(body.byModel[0].inputTokens).toBe(200);
    // The recent feed is scoped too — no cross-company event leaks.
    expect(body.recent.length).toBeGreaterThan(0);
    for (const e of body.recent) expect(e.user).toBe("ada");
    // The param normalizes like the ingest header: A.com ≡ a.com.
    const upper = await jsonOf(
      await built.app.request(new Request("http://x/stats/admin?company=A.com")),
    );
    expect(upper.leaderboard.map((r: any) => r.user)).toEqual(["ada"]);
  });

  test("companies lists every company, sorted, with and without an active filter", async () => {
    const all = await jsonOf(await built.app.request(new Request("http://x/stats/admin")));
    expect(all.companies).toEqual(["a.com", "b.com"]);
    // Unfiltered view still has all three users.
    expect(all.leaderboard.map((r: any) => r.user).sort()).toEqual(["ada", "bea", "cal"]);
    // The list is global even while a filter is active — the pills must
    // not vanish when one is selected.
    const filtered = await jsonOf(
      await built.app.request(new Request("http://x/stats/admin?company=b.com")),
    );
    expect(filtered.companies).toEqual(["a.com", "b.com"]);
    expect(filtered.leaderboard.map((r: any) => r.user)).toEqual(["bea"]);
  });

  test("invalid company → 400 {error:'invalid company'} on both routes", async () => {
    for (const url of [
      "http://x/stats/admin?company=nodot",
      "http://x/stats/admin?company=not%20a%20domain",
      "http://x/stats/timeseries?bucket=day&company=nodot",
    ]) {
      const res = await built.app.request(new Request(url));
      expect(res.status).toBe(400);
      expect(await jsonOf<{ error: string }>(res)).toEqual({ error: "invalid company" });
    }
  });

  test("valid-but-unknown company → 200 with empty/zeroed data (companies stays global)", async () => {
    const res = await built.app.request(
      new Request("http://x/stats/admin?company=unknown.example.com"),
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.leaderboard).toEqual([]);
    expect(body.byModel).toEqual([]);
    expect(body.recent).toEqual([]);
    expect(body.messages).toEqual({ userMessages: 0, assistantMessages: 0 });
    expect(body.companies).toEqual(["a.com", "b.com"]);
  });

  test("/stats/timeseries?company= filters buckets (incl. byUser); user= wins over company=", async () => {
    const a = await jsonOf(
      await built.app.request(new Request("http://x/stats/timeseries?bucket=day&company=a.com")),
    );
    expect(a.rows.map((r: any) => r.bucketLabel)).toEqual(["2026-06-01", "2026-06-02"]);
    // Jun 1 carries the user message; events stay assistant-only.
    expect(a.rows[0].userMessages).toBe(1);
    expect(a.rows[0].assistantMessages).toBe(1);
    expect(a.rows[0].events).toBe(1);
    // The byUser breakdown respects the company scope too.
    for (const row of a.rows) {
      expect(Array.isArray(row.byUser)).toBe(true);
      for (const bu of row.byUser) expect(bu.user).toBe("ada");
    }
    // Unknown valid company → zero buckets, still a 200.
    const none = await jsonOf(
      await built.app.request(
        new Request("http://x/stats/timeseries?bucket=day&company=unknown.example.com"),
      ),
    );
    expect(none.rows).toEqual([]);
    // user= is the narrower scope: cal is NOT in a.com, yet his bucket is
    // what comes back — the company filter is ignored, not an error.
    const userWins = await jsonOf(
      await built.app.request(
        new Request("http://x/stats/timeseries?bucket=day&user=cal&company=a.com"),
      ),
    );
    expect(userWins.rows.map((r: any) => r.bucketLabel)).toEqual(["2026-06-04"]);
    for (const row of userWins.rows) expect(row.byUser).toBeUndefined();
  });

  // LAST in this describe: it inserts directly into the store (bypassing
  // /ingest cache invalidation) to prove cache-key isolation.
  test("stats cache: distinct company params get distinct entries; same params replay the cached body", async () => {
    const getBody = async (path: string) => {
      const res = await built.app.request(new Request(`http://x${path}`));
      expect(res.status).toBe(200);
      return res.text();
    };
    const adminA = await getBody("/stats/admin?company=a.com");
    const adminB = await getBody("/stats/admin?company=b.com");
    const tsA = await getBody("/stats/timeseries?bucket=day&company=a.com");
    const tsB = await getBody("/stats/timeseries?bucket=day&company=b.com");
    // Different params never serve each other's bodies.
    expect(adminA).not.toBe(adminB);
    expect(tsA).not.toBe(tsB);
    // Direct insert (no /ingest → no invalidation under the default test
    // posture of statsCacheClearCoalesceMs: 0): repeats with the SAME
    // params must replay the cached bodies byte-for-byte even though a
    // fresh query would now see cf-ada-cache.
    built.store.insertMany([
      makeEvent({ user: "ada", messageId: "cf-ada-cache", timestamp: Date.UTC(2026, 5, 5) }),
    ]);
    expect(await getBody("/stats/admin?company=a.com")).toBe(adminA);
    expect(await getBody("/stats/admin?company=b.com")).toBe(adminB);
    expect(await getBody("/stats/timeseries?bucket=day&company=a.com")).toBe(tsA);
    expect(await getBody("/stats/timeseries?bucket=day&company=b.com")).toBe(tsB);
  });
});

// ----- half-open [since, until) semantics --------------------------------
// The one date contract: an event at timestamp === until is OUT, an event
// at timestamp === since is IN, on every surface — so a boundary event
// belongs to exactly one month and the dashboard agrees with /api/v1.

describe("half-open range semantics (dashboard + API agree)", () => {
  const JUN_1 = Date.UTC(2026, 5, 1);
  const JUL_1 = Date.UTC(2026, 6, 1);
  const AUG_1 = Date.UTC(2026, 7, 1);

  function withSeededApp() {
    const built = createTestApp();
    built.store.insertMany([
      makeEvent({ user: "alice", messageId: "jun-mid", timestamp: Date.UTC(2026, 5, 15) }),
      makeEvent({
        user: "alice",
        messageId: "jun-last-ms",
        timestamp: Date.UTC(2026, 5, 30, 23, 59, 59, 999),
      }),
      // The headline fixture: exactly on the month boundary → July only.
      makeEvent({ user: "alice", messageId: "boundary", timestamp: JUL_1 }),
      makeEvent({ user: "alice", messageId: "jul-mid", timestamp: Date.UTC(2026, 6, 15) }),
      // A Cursor-sourced row with stored cost exercises the storedCostMicros
      // path on both surfaces.
      makeEvent({
        user: "bob",
        source: "cursor",
        messageId: "bob-cursor",
        timestamp: Date.UTC(2026, 5, 20),
        costUsdMicros: 1_234_500,
      }),
    ]);
    return built;
  }

  async function snap(a: typeof app, since?: number, until?: number) {
    const qs = since !== undefined && until !== undefined ? `?since=${since}&until=${until}` : "";
    const res = await a.request(new Request(`http://x/stats/admin${qs}`));
    expect(res.status).toBe(200);
    return jsonOf(res);
  }

  test("boundary event counts in exactly one month; JUN + JUL == ALL", async () => {
    const { app: a, cleanup } = withSeededApp();
    try {
      const jun = await snap(a, JUN_1, JUL_1);
      const jul = await snap(a, JUL_1, AUG_1);
      const all = await snap(a);
      const row = (s: any, u: string) => s.leaderboard.find((r: any) => r.user === u);

      // June holds jun-mid + jun-last-ms; the boundary event is July's.
      expect(row(jun, "alice").assistantMessages).toBe(2);
      expect(row(jul, "alice").assistantMessages).toBe(2);
      expect(row(all, "alice").assistantMessages).toBe(4);

      // JUN + JUL == ALL, exactly, for every additive column.
      for (const k of [
        "totalInputTokens",
        "totalOutputTokens",
        "totalCacheCreationTokens",
        "totalCacheReadTokens",
        "userMessages",
        "assistantMessages",
        "eventCount",
      ]) {
        expect(row(jun, "alice")[k] + row(jul, "alice")[k]).toBe(row(all, "alice")[k]);
      }
      // costUsd reconciles too (alice priced via PricingCache, bob via
      // stored Cursor cost). roundUsd is 1e-4 per window.
      for (const u of ["alice", "bob"]) {
        const j = row(jun, u)?.costUsd ?? 0;
        const l = row(jul, u)?.costUsd ?? 0;
        const t = row(all, u)?.costUsd ?? 0;
        expect(Math.abs(j + l - t)).toBeLessThan(0.0003);
      }
      // bob's stored cost lands whole in June.
      expect(row(jun, "bob").costUsd).toBe(1.2345);
      expect(row(jul, "bob")).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("timeseries is half-open: no phantom month bucket; boundary lands on 2026-07-01", async () => {
    const { app: a, cleanup } = withSeededApp();
    try {
      const m = await jsonOf(
        await a.request(
          new Request(`http://x/stats/timeseries?bucket=month&since=${JUN_1}&until=${JUL_1}`),
        ),
      );
      expect(m.rows.map((r: any) => r.bucketLabel)).toEqual(["2026-06"]);
      const d = await jsonOf(
        await a.request(
          new Request(`http://x/stats/timeseries?bucket=day&since=${JUL_1}&until=${AUG_1}`),
        ),
      );
      const labels = d.rows.map((r: any) => r.bucketLabel);
      expect(labels).toContain("2026-07-01");
      expect(labels).not.toContain("2026-06-30");
    } finally {
      cleanup();
    }
  });

  test("/stats honors until across totals, byModel and message counts", async () => {
    const { app: a, cleanup } = withSeededApp();
    try {
      const res = await a.request(
        new Request(`http://x/stats?user=alice&since=${JUN_1}&until=${JUL_1}`),
      );
      expect(res.status).toBe(200);
      const body = await jsonOf(res);
      // Two June events × makeEvent defaults (100/50/10/20).
      expect(body.totalInputTokens).toBe(200);
      expect(body.totalOutputTokens).toBe(100);
      expect(body.totalCacheCreationTokens).toBe(20);
      expect(body.totalCacheReadTokens).toBe(40);
      expect(body.assistantMessages).toBe(2);
      expect(body.byModel[0].count).toBe(2);
    } finally {
      cleanup();
    }
  });

  test("/stats?user= respects stored Cursor cost — agrees with the admin leaderboard row", async () => {
    // Focus mode (dashboard ?user=) reads GET /stats; its cost must match
    // the /stats/admin leaderboard row the user just clicked. bob's only
    // event carries storedCostMicros (Cursor), which wins over the
    // PricingCache derivation here exactly like it does on /stats/admin.
    const { app: a, cleanup } = withSeededApp();
    try {
      const res = await a.request(
        new Request(`http://x/stats?user=bob&since=${JUN_1}&until=${JUL_1}`),
      );
      expect(res.status).toBe(200);
      const body = await jsonOf(res);
      expect(body.totalCostUsd).toBe(1.2345);
      expect(body.byModel[0].costUsd).toBe(1.2345);
      // The model is priced (stored cost), so it must not be flagged unknown.
      expect(body.unknownModels).toEqual([]);
      const admin = await snap(a, JUN_1, JUL_1);
      const lb = admin.leaderboard.find((r: any) => r.user === "bob");
      expect(body.totalCostUsd).toBe(lb.costUsd);
    } finally {
      cleanup();
    }
  });

  test("/api/v1/usage?period=2026-06 agrees with the /stats/admin June leaderboard", async () => {
    const { app: a, cleanup } = withSeededApp();
    try {
      const api = await jsonOf(
        await a.request(new Request("http://x/api/v1/usage?period=2026-06")),
      );
      const admin = await snap(a, JUN_1, JUL_1);
      expect(api.users.length).toBe(admin.leaderboard.length);
      for (const u of api.users) {
        const lb = admin.leaderboard.find((r: any) => r.user === u.user);
        expect(lb).toBeDefined();
        // The API folds cache buckets into inputTokens.
        expect(u.inputTokens).toBe(
          lb.totalInputTokens + lb.totalCacheCreationTokens + lb.totalCacheReadTokens,
        );
        expect(u.outputTokens).toBe(lb.totalOutputTokens);
        expect(u.costUsd).toBe(lb.costUsd);
      }
    } finally {
      cleanup();
    }
  });

  test("reversed ranges 400 uniformly; since === until is an empty 200", async () => {
    const { app: a, cleanup } = withSeededApp();
    try {
      for (const route of [
        "/stats/admin",
        "/stats/timeseries",
        "/stats/leaderboard",
        "/stats?user=alice",
      ]) {
        const sep = route.includes("?") ? "&" : "?";
        const res = await a.request(new Request(`http://x${route}${sep}since=10&until=5`));
        expect(res.status).toBe(400);
      }
      const empty = await snap(a, JUN_1, JUN_1);
      expect(empty.leaderboard).toEqual([]);
    } finally {
      cleanup();
    }
  });
});

describe("/stats/leaderboard until", () => {
  test("token sums respect until: a user active only after the window has no row", async () => {
    const built = createTestApp();
    const JUN_1 = Date.UTC(2026, 5, 1);
    const JUL_1 = Date.UTC(2026, 6, 1);
    try {
      built.store.insertMany([
        makeEvent({ user: "alice", messageId: "in-window", timestamp: Date.UTC(2026, 5, 10) }),
        makeEvent({
          user: "alice",
          messageId: "after-window",
          timestamp: Date.UTC(2026, 6, 10),
          inputTokens: 77_777,
        }),
        // dave is active only at/after `until` — exactly the mixed-window
        // bug shape (tokens used to span [since, ∞) while cost was bound).
        makeEvent({ user: "dave", messageId: "at-until", timestamp: JUL_1 }),
        makeEvent({ user: "dave", messageId: "post-until", timestamp: Date.UTC(2026, 6, 20) }),
      ]);
      const res = await built.app.request(
        new Request(`http://x/stats/leaderboard?since=${JUN_1}&until=${JUL_1}`),
      );
      expect(res.status).toBe(200);
      const body = await jsonOf<any[]>(res);
      expect(body.map((r) => r.user)).toEqual(["alice"]);
      // alice's totals are June-only — the 77k July event is excluded.
      expect(body[0].totalInputTokens).toBe(100);

      // Malformed until → 400 before any query; same for malformed since.
      for (const qs of ["since=0&until=abc", "since=abc", "since=1.5", "since=1e12"]) {
        const bad = await built.app.request(new Request(`http://x/stats/leaderboard?${qs}`));
        expect(bad.status).toBe(400);
      }
    } finally {
      await built.cleanup();
    }
  });
});

describe("range=<N>d rolling windows (server-resolved, minute-quantized)", () => {
  test("same minute shares a cache key; the window steps per minute", async () => {
    const DAY_MS = 86_400_000;
    const FIXED = Date.UTC(2026, 5, 10, 12, 0, 30); // mid-minute
    let nowMs = FIXED;
    const built = createTestApp({ now: () => nowMs });
    try {
      built.store.insertMany([
        makeEvent({ user: "alice", messageId: "r-1", timestamp: FIXED - DAY_MS }),
      ]);
      const get = async () => {
        const res = await built.app.request(new Request("http://x/stats/admin?range=7d"));
        expect(res.status).toBe(200);
        return res.text();
      };
      const body1 = await get();
      expect(body1).toContain("alice");

      // Insert directly (bypassing /ingest invalidation): a same-minute
      // request must still serve the cached body — same key, no fresh query.
      built.store.insertMany([
        makeEvent({ user: "zed", messageId: "r-2", timestamp: FIXED - DAY_MS + 1000 }),
      ]);
      expect(await get()).toBe(body1);
      nowMs = FIXED + 29_000; // still inside the 12:00 minute
      expect(await get()).toBe(body1);

      // Crossing the minute mints a new key → fresh query sees zed.
      nowMs = FIXED + 31_000; // 12:01:01
      const body4 = await get();
      expect(body4).not.toBe(body1);
      expect(body4).toContain("zed");

      // Protocol validation: range can't combine with since/until and N
      // is bounded 1..366; floats/exponents in since are 400 too.
      for (const qs of [
        "range=7d&since=0",
        "range=0d",
        "range=367d",
        "range=7",
        "since=1.5",
        "since=1e12",
      ]) {
        const res = await built.app.request(new Request(`http://x/stats/admin?${qs}`));
        expect(res.status).toBe(400);
      }
    } finally {
      await built.cleanup();
    }
  });
});

describe("join token (TOKENLEADER_JOIN_TOKEN)", () => {
  const JOIN = "team-join-code";
  let built: ReturnType<typeof createTestApp>;

  beforeAll(() => {
    built = createTestApp({ joinToken: JOIN });
  });

  afterAll(async () => {
    await built.cleanup();
  });

  function joinIngestReq(events: TokenEvent[], secret: string, joinHeader?: string): Request {
    return new Request("http://x/ingest", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tokenleader-secret": secret,
        ...(joinHeader !== undefined ? { "x-tokenleader-join": joinHeader } : {}),
      },
      body: JSON.stringify({ events }),
    });
  }

  test("first claim WITHOUT the join header is 403 join_required (and claims nothing)", async () => {
    const res = await built.app.request(
      joinIngestReq([makeEvent({ user: "newbie", messageId: "j-1" })], "s-newbie"),
    );
    expect(res.status).toBe(403);
    expect((await jsonOf(res)).error).toBe("join_required");
    expect(built.store.getUserSecretRow("newbie")).toBeNull();
  });

  test("first claim with a WRONG join header is 403 join_required", async () => {
    const res = await built.app.request(
      joinIngestReq([makeEvent({ user: "newbie", messageId: "j-2" })], "s-newbie", "not-the-code"),
    );
    expect(res.status).toBe(403);
    expect((await jsonOf(res)).error).toBe("join_required");
    expect(built.store.getUserSecretRow("newbie")).toBeNull();
  });

  test("first claim WITH the join header claims TOFU-style and inserts", async () => {
    const res = await built.app.request(
      joinIngestReq([makeEvent({ user: "newbie", messageId: "j-3" })], "s-newbie", JOIN),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ inserted: 1, duplicates: 0 });
    expect(built.store.getUserSecretHash("newbie")).toBe(sha256Hex("s-newbie"));
  });

  test("claimed user posts subsequent batches WITHOUT the join header", async () => {
    const res = await built.app.request(
      joinIngestReq([makeEvent({ user: "newbie", messageId: "j-4" })], "s-newbie"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ inserted: 1, duplicates: 0 });
  });

  test("claimed user with the WRONG secret still 403s on secret (not join)", async () => {
    const res = await built.app.request(
      joinIngestReq([makeEvent({ user: "newbie", messageId: "j-5" })], "stolen"),
    );
    expect(res.status).toBe(403);
    expect((await jsonOf(res)).error).toContain("secret mismatch");
  });

  test("uninstalled-user reclaim is untouched by the join gate", async () => {
    // Mark uninstalled, then reclaim with a fresh secret and NO join
    // header — the reclaim path rotates the hash exactly as before.
    built.store.markUserUninstalled("newbie", sha256Hex("s-newbie"), Date.now());
    const res = await built.app.request(
      joinIngestReq([makeEvent({ user: "newbie", messageId: "j-6" })], "fresh-secret"),
    );
    expect(res.status).toBe(200);
    expect(built.store.getUserSecretHash("newbie")).toBe(sha256Hex("fresh-secret"));
  });

  test("/install advertises --join when the join token is set", async () => {
    const res = await built.app.request(new Request("http://x/install"));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("--join=<code>");
    // The join token VALUE must never leak into the public install script.
    expect(body).not.toContain(JOIN);
  });

  test("/stats/admin exposes joinRequired: true (boolean only, never the token)", async () => {
    const res = await built.app.request(new Request("http://x/stats/admin"));
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text);
    expect(body.server.joinRequired).toBe(true);
    // The SPA hero renders `--join=<code>` off this flag alone; the join
    // token value must never appear anywhere in the payload.
    expect(text).not.toContain(JOIN);
  });
});

describe("dashboard token (TOKENLEADER_DASHBOARD_TOKEN)", () => {
  const TOKEN = "dash-viewer-token";
  const COOKIE_VAL = sha256Hex(TOKEN);
  let built: ReturnType<typeof createTestApp>;

  beforeAll(() => {
    built = createTestApp({ dashboardToken: TOKEN });
  });

  afterAll(async () => {
    await built.cleanup();
  });

  test("unauthenticated browser on / is redirected to /login", async () => {
    const res = await built.app.request(
      new Request("http://x/", { headers: { accept: "text/html" } }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  test("unauthenticated non-HTML caller gets 401 JSON", async () => {
    const res = await built.app.request(new Request("http://x/"));
    expect(res.status).toBe(401);
    expect((await jsonOf(res)).error).toContain("dashboard token");
  });

  test("bare /stats?user=x is gated too (the '/stats/*' matcher misses it)", async () => {
    const res = await built.app.request(new Request("http://x/stats?user=alice"));
    expect(res.status).toBe(401);
  });

  test("GET /admin (SPA admin-panel page) is gated like /", async () => {
    const res = await built.app.request(new Request("http://x/admin"));
    expect(res.status).toBe(401);
    const ok = await built.app.request(
      new Request("http://x/admin", {
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
    );
    // No webDistDir on this app → authenticated /admin redirects to the
    // legacy dashboard, whose danger zone lives inline at /.
    expect(ok.status).toBe(302);
    expect(ok.headers.get("location")).toBe("/");
  });

  test("/stats/admin and /stats/fleet are gated", async () => {
    for (const p of ["/stats/admin", "/stats/fleet", "/stats/leaderboard", "/stats/timeseries"]) {
      const res = await built.app.request(new Request(`http://x${p}`));
      expect(res.status).toBe(401);
    }
  });

  test("Authorization: Bearer grants access", async () => {
    const res = await built.app.request(
      new Request("http://x/stats/admin", {
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
    );
    expect(res.status).toBe(200);
  });

  test("tl_dash cookie (sha256 of the token) grants access", async () => {
    const res = await built.app.request(
      new Request("http://x/stats/admin", {
        headers: { cookie: `tl_dash=${COOKIE_VAL}` },
      }),
    );
    expect(res.status).toBe(200);
  });

  test("wrong cookie / wrong bearer stay locked out", async () => {
    const bad1 = await built.app.request(
      new Request("http://x/stats/admin", {
        headers: { cookie: `tl_dash=${sha256Hex("wrong")}` },
      }),
    );
    expect(bad1.status).toBe(401);
    const bad2 = await built.app.request(
      new Request("http://x/stats/admin", {
        headers: { authorization: "Bearer wrong" },
      }),
    );
    expect(bad2.status).toBe(401);
  });

  test("one-shot ?token= sets the cookie and redirects without the param", async () => {
    const res = await built.app.request(
      new Request(`http://x/stats/admin?range=7d&token=${TOKEN}`),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/stats/admin?range=7d");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`tl_dash=${COOKIE_VAL}`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
  });

  test("wrong ?token= does not authenticate", async () => {
    const res = await built.app.request(new Request("http://x/stats/admin?token=wrong"));
    expect(res.status).toBe(401);
  });

  test("GET /login serves the form; POST sets the cookie; wrong POST is 403", async () => {
    const form = await built.app.request(new Request("http://x/login"));
    expect(form.status).toBe(200);
    expect(await form.text()).toContain('name="token"');

    const ok = await built.app.request(
      new Request("http://x/login", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `token=${TOKEN}`,
      }),
    );
    expect(ok.status).toBe(302);
    expect(ok.headers.get("location")).toBe("/");
    expect(ok.headers.get("set-cookie") ?? "").toContain(`tl_dash=${COOKIE_VAL}`);

    const bad = await built.app.request(
      new Request("http://x/login", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "token=wrong",
      }),
    );
    expect(bad.status).toBe(403);
  });

  test("never-gated routes stay open", async () => {
    const health = await built.app.request(new Request("http://x/health"));
    expect(health.status).toBe(200);

    const install = await built.app.request(new Request("http://x/install"));
    expect(install.status).toBe(200);

    const uninstall = await built.app.request(new Request("http://x/uninstall"));
    expect(uninstall.status).toBe(200);

    // 503 (mirror off) — NOT 401: the daemon paths must never see auth.
    const manifest = await built.app.request(new Request("http://x/manifest.json"));
    expect(manifest.status).toBe(503);
    const bin = await built.app.request(new Request("http://x/bin/anara-leaderboard-arm64"));
    expect(bin.status).toBe(503);

    // /ingest still does its own secret dance (400 missing header, not 401).
    const ingest = await built.app.request(
      new Request("http://x/ingest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ events: [] }),
      }),
    );
    expect(ingest.status).toBe(400);
  });

  test("/api/v1 inherits the dashboard token when apiToken is unset", async () => {
    const noAuth = await built.app.request(new Request("http://x/api/v1/usage"));
    expect(noAuth.status).toBe(401);
    const withAuth = await built.app.request(
      new Request("http://x/api/v1/usage?period=2026-05", {
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
    );
    expect(withAuth.status).toBe(200);
  });
});

describe("dashboard token unset (public posture)", () => {
  test("/, /stats/admin stay open and /login bounces home", async () => {
    // `app` from the main harness is built without a dashboard token.
    const root = await app.request(new Request("http://x/", { headers: { accept: "text/html" } }));
    expect(root.status).toBe(200);

    const admin = await app.request(new Request("http://x/stats/admin"));
    expect(admin.status).toBe(200);

    const login = await app.request(new Request("http://x/login"));
    expect(login.status).toBe(302);
    expect(login.headers.get("location")).toBe("/");
  });
});

describe("stats-cache invalidation coalescing", () => {
  test("writes inside the window serve the cached snapshot; window 0 clears every write", async () => {
    // Production posture: one clear per window so a bulk replay can't make
    // every dashboard poll re-aggregate between batches.
    const coalesced = createTestApp({ statsCacheClearCoalesceMs: 60_000 });
    try {
      const post = (id: string) =>
        coalesced.app.request(
          new Request("http://x/ingest", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-tokenleader-user": "alice",
              "x-tokenleader-secret": "s3cret-s3cret-s3cret-s3cret-s3cret-s3cret",
            },
            body: JSON.stringify({ events: [makeTokenEvent({ messageId: id })] }),
          }),
        );
      expect((await post("m-1")).status).toBe(200);
      const first = await (await coalesced.app.request(new Request("http://x/stats/admin"))).text();
      // Second write lands inside the coalesce window: the cached snapshot
      // keeps serving (byte-identical body) instead of clearing.
      expect((await post("m-2")).status).toBe(200);
      const second = await (
        await coalesced.app.request(new Request("http://x/stats/admin"))
      ).text();
      expect(second).toBe(first);
    } finally {
      await coalesced.cleanup();
    }
  });
});

describe("company aliases (TOKENLEADER_COMPANY_ALIASES)", () => {
  test("ingest header is rewritten through the alias map; others pass through", async () => {
    const t = createTestApp({ companyAliases: { "sync.labs": "sync.so" } });
    try {
      const post = (user: string, secret: string, company: string) =>
        t.app.request(
          new Request("http://x/ingest", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-tokenleader-user": user,
              "x-tokenleader-secret": secret,
              "x-tokenleader-company": company,
            },
            body: JSON.stringify({ events: [makeTokenEvent({ user, messageId: `m-${user}` })] }),
          }),
        );
      expect((await post("seb", "s".repeat(40), "Sync.Labs")).status).toBe(200);
      expect((await post("viv", "v".repeat(40), "listener.com")).status).toBe(200);
      const rows = (
        await jsonOf<{ leaderboard: { user: string; company: string | null }[] }>(
          await t.app.request(new Request("http://x/stats/admin")),
        )
      ).leaderboard;
      expect(rows.find((r) => r.user === "seb")?.company).toBe("sync.so");
      expect(rows.find((r) => r.user === "viv")?.company).toBe("listener.com");
    } finally {
      await t.cleanup();
    }
  });
});
