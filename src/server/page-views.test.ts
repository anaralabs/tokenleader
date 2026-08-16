import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { makeTmpDirSync } from "../test-helpers.ts";
import { PAGE_VIEWS_MAX, type PageViewRow, Store } from "./db.ts";
import {
  isBotUserAgent,
  PAGE_VIEW_BUFFER_MAX,
  PAGE_VIEW_DROP_WARN_MS,
  PageViewRecorder,
} from "./page-views.ts";

// A fixed UTC day so the strftime bucketing is asserted against a literal.
const DAY_MS = 86_400_000;
const DAY_1 = Date.UTC(2026, 7, 12); // 2026-08-12
const DAY_2 = DAY_1 + DAY_MS; // 2026-08-13

describe("isBotUserAgent", () => {
  test("the unfurlers and scanners seen in real traffic are bots", () => {
    for (const ua of [
      "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
      "WhatsApp/2.23.20.0 A",
      "Expanse, a Palo Alto Networks company, searches across the global IPv4 space",
      "python-requests/2.31.0",
      "Claude-User/1.0",
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      "curl/8.4.0",
      "HeadlessChrome/120.0.0.0",
    ]) {
      expect(isBotUserAgent(ua)).toBe(true);
    }
  });

  test("real browsers are not bots", () => {
    for (const ua of [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
      "Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
    ]) {
      expect(isBotUserAgent(ua)).toBe(false);
    }
  });

  test("a missing or empty user-agent counts as a bot", () => {
    // Every real browser sends one; absent means a script. Under-counting
    // beats reporting scripts as readers.
    expect(isBotUserAgent(null)).toBe(true);
    expect(isBotUserAgent(undefined)).toBe(true);
    expect(isBotUserAgent("   ")).toBe(true);
  });
});

describe("PageViewRecorder", () => {
  let tmpDir: string;
  let rmTmpDir: () => void;
  let store: Store;

  beforeEach(() => {
    ({ dir: tmpDir, cleanup: rmTmpDir } = makeTmpDirSync("page-views-test-"));
    store = new Store(join(tmpDir, "test.sqlite"));
  });
  afterEach(() => {
    store.close();
    rmTmpDir();
  });

  test("record() writes NOTHING until a flush (no SQLite on the request path)", () => {
    const rec = new PageViewRecorder({ store, now: () => DAY_1 });
    rec.record("/");
    rec.record("/admin");
    expect(rec.pending()).toBe(2);
    expect(store.countPageViews(0, Number.MAX_SAFE_INTEGER)).toBe(0);

    expect(rec.flush()).toBe(2);
    expect(rec.pending()).toBe(0);
    expect(store.countPageViews(0, Number.MAX_SAFE_INTEGER)).toBe(2);
  });

  test("the interval drains the buffer on its own", async () => {
    const rec = new PageViewRecorder({ store, flushIntervalMs: 5, now: () => DAY_1 });
    rec.start();
    try {
      rec.record("/");
      await Bun.sleep(40);
      expect(store.countPageViews(0, Number.MAX_SAFE_INTEGER)).toBe(1);
    } finally {
      rec.stop();
    }
  });

  test("stop() flushes what the interval hadn't reached (graceful shutdown)", () => {
    const rec = new PageViewRecorder({ store, flushIntervalMs: 60_000, now: () => DAY_1 });
    rec.start();
    rec.record("/");
    rec.stop();
    expect(store.countPageViews(0, Number.MAX_SAFE_INTEGER)).toBe(1);
    // Idempotent: a second stop must not double-write or throw.
    rec.stop();
    expect(store.countPageViews(0, Number.MAX_SAFE_INTEGER)).toBe(1);
  });

  test("the buffer is capped — a flood drops loads instead of growing forever", () => {
    const rec = new PageViewRecorder({ store, now: () => DAY_1 });
    for (let i = 0; i < PAGE_VIEW_BUFFER_MAX + 25; i++) rec.record("/");
    expect(rec.pending()).toBe(PAGE_VIEW_BUFFER_MAX);
    expect(rec.flush()).toBe(PAGE_VIEW_BUFFER_MAX);
  });

  test("dropping loads warns from record(), not only from flush()", () => {
    // The scenario that fills the buffer is a wedged flush timer (this repo
    // has a documented Bun-timer wedge class), and then flush() never runs
    // again — so a warning that only fired there would never fire at all.
    // The operator would see counts stop with nothing in the logs.
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    let clock = DAY_1;
    try {
      const rec = new PageViewRecorder({ store, now: () => clock });
      for (let i = 0; i < PAGE_VIEW_BUFFER_MAX + 3; i++) rec.record("/");
      // First drop warns immediately; the rest are rate-limited so the log
      // line cannot itself become the flood.
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("dropped 1 load(s)");

      clock += PAGE_VIEW_DROP_WARN_MS + 1;
      rec.record("/");
      expect(warnings.length).toBe(2);
      // The suppressed drops are carried, not lost: 2 more + this one.
      expect(warnings[1]).toContain("dropped 3 load(s)");
    } finally {
      console.warn = realWarn;
    }
  });

  test("a broken store never propagates out of flush()", () => {
    // The flush runs on an interval and on the shutdown path; a throw there
    // would take out the timer or the drain.
    const rec = new PageViewRecorder({
      store: {
        recordPageViews: () => {
          throw new Error("disk on fire");
        },
      },
      now: () => DAY_1,
    });
    rec.record("/");
    expect(rec.flush()).toBe(0);
    // The batch is dropped, not re-queued into an ever-growing buffer.
    expect(rec.pending()).toBe(0);
  });
});

describe("page_views aggregates", () => {
  let tmpDir: string;
  let rmTmpDir: () => void;
  let store: Store;

  beforeEach(() => {
    ({ dir: tmpDir, cleanup: rmTmpDir } = makeTmpDirSync("page-views-agg-test-"));
    store = new Store(join(tmpDir, "test.sqlite"));
    store.recordPageViews([
      { ts: DAY_1, path: "/" },
      { ts: DAY_1 + 3_600_000, path: "/" },
      { ts: DAY_1 + 7_200_000, path: "/admin" },
      { ts: DAY_2, path: "/" },
    ]);
  });
  afterEach(() => {
    store.close();
    rmTmpDir();
  });

  test("per-day buckets are UTC and ascending", () => {
    expect(store.pageViewsByDay(0, Number.MAX_SAFE_INTEGER)).toEqual([
      { day: "2026-08-12", views: 3 },
      { day: "2026-08-13", views: 1 },
    ]);
  });

  test("per-path buckets are busiest first", () => {
    expect(store.pageViewsByPath(0, Number.MAX_SAFE_INTEGER)).toEqual([
      { path: "/", views: 3 },
      { path: "/admin", views: 1 },
    ]);
  });

  test("ranges are half-open [since, until)", () => {
    expect(store.countPageViews(0, Number.MAX_SAFE_INTEGER)).toBe(4);
    // until is exclusive: DAY_2 itself is outside a window ending there.
    expect(store.countPageViews(DAY_1, DAY_2)).toBe(3);
    expect(store.countPageViews(DAY_2, DAY_2 + DAY_MS)).toBe(1);
    expect(store.pageViewsByDay(DAY_2, DAY_2 + DAY_MS)).toEqual([{ day: "2026-08-13", views: 1 }]);
  });

  test("an empty batch is a no-op", () => {
    expect(store.recordPageViews([])).toBe(0);
    expect(store.countPageViews(0, Number.MAX_SAFE_INTEGER)).toBe(4);
  });

  test("normal-sized flushes prune nothing", () => {
    // The cap must be invisible below it: no row disappears just because a
    // flush ran, or the long trend this table exists for would rot.
    store.recordPageViews([{ ts: DAY_2 + 1, path: "/" }]);
    expect(store.countPageViews(0, Number.MAX_SAFE_INTEGER)).toBe(5);
  });
});

describe("page_views is capped", () => {
  let tmpDir: string;
  let rmTmpDir: () => void;
  let store: Store;

  beforeEach(() => {
    ({ dir: tmpDir, cleanup: rmTmpDir } = makeTmpDirSync("page-views-cap-test-"));
    store = new Store(join(tmpDir, "test.sqlite"));
  });
  afterEach(() => {
    store.close();
    rmTmpDir();
  });

  test("a flood is trimmed to PAGE_VIEWS_MAX, oldest first", () => {
    // `GET /` is unauthenticated when no dashboard token is set, so this
    // table's write path is open to the internet. Without the prune a
    // crawler grows the Litestream-replicated DB without bound.
    const over = 50;
    const oldest: PageViewRow[] = [];
    for (let i = 0; i < PAGE_VIEWS_MAX + over; i++) {
      oldest.push({ ts: DAY_1 + i, path: i < over ? "/oldest" : "/" });
    }
    store.recordPageViews(oldest);
    expect(store.countPageViews(0, Number.MAX_SAFE_INTEGER)).toBe(PAGE_VIEWS_MAX);
    // The dropped rows are the OLDEST ones: recent counts stay truthful.
    expect(store.pageViewsByPath(0, Number.MAX_SAFE_INTEGER)).toEqual([
      { path: "/", views: PAGE_VIEWS_MAX },
    ]);

    // And it stays capped across subsequent flushes.
    store.recordPageViews([{ ts: DAY_2, path: "/admin" }]);
    expect(store.countPageViews(0, Number.MAX_SAFE_INTEGER)).toBe(PAGE_VIEWS_MAX);
    expect(store.countPageViews(DAY_2, Number.MAX_SAFE_INTEGER)).toBe(1);
  });
});
