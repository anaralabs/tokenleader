// Directive channel + heartbeat: /checkin stamps liveness for daemons with
// nothing to post and delivers single-shot directives; /watchdog-checkin is
// the second channel that still works when the daemon is wedged;
// /directives/ack completes a directive (delivery alone no longer does);
// /diag/logs stores a per-device log tail; /admin/directives enqueues (with
// optional device targeting). Identity changes (claim/re-claim/link) must
// stay exclusively on /ingest — the checkin routes only ever authenticate
// EXISTING devices.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createTestApp, jsonOf, makeTokenEvent } from "../test-helpers.ts";
import type { TokenEvent } from "../types.ts";
import { DIRECTIVE_TTL_MS } from "./db.ts";

const SECRET = "hb-machine-secret";
const ADMIN = "admin-tok";

let harness: ReturnType<typeof createTestApp>;
let app: ReturnType<typeof createTestApp>["app"];
let store: ReturnType<typeof createTestApp>["store"];

beforeAll(() => {
  harness = createTestApp({ adminToken: ADMIN });
  app = harness.app;
  store = harness.store;
});

afterAll(async () => {
  await harness.cleanup();
});

let msgCounter = 0;
const makeEvent = (user: string): TokenEvent =>
  makeTokenEvent({ user, messageId: `hb-msg-${msgCounter++}` });

async function claim(user: string, secret: string): Promise<void> {
  const res = await app.request(
    new Request("http://x/ingest", {
      method: "POST",
      headers: { "content-type": "application/json", "x-tokenleader-secret": secret },
      body: JSON.stringify({ events: [makeEvent(user)] }),
    }),
  );
  expect(res.status).toBe(200);
}

function checkinReq(user: string, secret: string, headers: Record<string, string> = {}): Request {
  return new Request("http://x/checkin", {
    method: "POST",
    headers: {
      "x-tokenleader-secret": secret,
      "x-tokenleader-user": user,
      ...headers,
    },
  });
}

function adminEnqueue(user: string, verb: string): Request {
  return new Request("http://x/admin/directives", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN}` },
    body: JSON.stringify({ user, verb }),
  });
}

describe("/checkin heartbeat", () => {
  test("existing device: 200, last_seen + version stamped", async () => {
    await claim("hana", SECRET);
    const res = await app.request(
      checkinReq("hana", SECRET, {
        "x-tokenleader-version": "v9.9.9",
        "x-tokenleader-arch": "arm64",
      }),
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.ok).toBe(true);
    expect(body.directive).toBeUndefined();

    const devices = store.listUserDevices("hana");
    expect(devices.length).toBe(1);
    expect(devices[0]!.version).toBe("v9.9.9");
    expect(devices[0]!.lastSeen).toBeGreaterThan(Date.now() - 5_000);
  });

  test("never claims: unknown user is 403 and stays unclaimed", async () => {
    const res = await app.request(checkinReq("ghost", "ghost-secret"));
    expect(res.status).toBe(403);
    expect(store.getUserSecretRow("ghost")).toBeNull();
  });

  test("wrong secret for a claimed user is 403", async () => {
    const res = await app.request(checkinReq("hana", "intruder"));
    expect(res.status).toBe(403);
  });

  test("bad user header is 400", async () => {
    const res = await app.request(checkinReq("Not A Handle!", SECRET));
    expect(res.status).toBe(400);
  });
});

describe("directive lifecycle", () => {
  test("admin enqueue → checkin delivers exactly once", async () => {
    await claim("iris", SECRET);
    const enq = await app.request(adminEnqueue("iris", "restart"));
    expect(enq.status).toBe(200);
    const { id } = await jsonOf(enq);
    expect(typeof id).toBe("number");

    const first = await jsonOf(await app.request(checkinReq("iris", SECRET)));
    expect(first.directive).toEqual({ id, verb: "restart" });

    // Single-shot: the next checkin gets nothing.
    const second = await jsonOf(await app.request(checkinReq("iris", SECRET)));
    expect(second.ok).toBe(true);
    expect(second.directive).toBeUndefined();

    // Admin list shows it delivered.
    const list = await app.request(
      new Request("http://x/admin/directives?user=iris", {
        headers: { authorization: `Bearer ${ADMIN}` },
      }),
    );
    const body = await jsonOf(list);
    expect(body.directives[0].delivered_at).toBeGreaterThan(0);
  });

  test("directives ride the /ingest response too", async () => {
    await claim("jules", SECRET);
    await app.request(adminEnqueue("jules", "upload_logs"));
    const res = await app.request(
      new Request("http://x/ingest", {
        method: "POST",
        headers: { "content-type": "application/json", "x-tokenleader-secret": SECRET },
        body: JSON.stringify({ events: [makeEvent("jules")] }),
      }),
    );
    const body = await jsonOf(res);
    expect(body.directive.verb).toBe("upload_logs");
  });

  test("expired directives are never delivered", async () => {
    await claim("kai", SECRET);
    store.enqueueDirective("kai", "restart", Date.now() - 25 * 60 * 60 * 1000);
    const body = await jsonOf(await app.request(checkinReq("kai", SECRET)));
    expect(body.ok).toBe(true);
    expect(body.directive).toBeUndefined();
  });

  test("admin validation: bad verb 400, unknown user 404, no auth 401", async () => {
    expect((await app.request(adminEnqueue("iris", "rm -rf /"))).status).toBe(400);
    expect((await app.request(adminEnqueue("nobody-here", "restart"))).status).toBe(404);
    const noAuth = await app.request(
      new Request("http://x/admin/directives", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ user: "iris", verb: "restart" }),
      }),
    );
    expect(noAuth.status).toBe(401);
  });
});

describe("/diag/logs", () => {
  test("upload + admin readback; auth enforced; oversize capped", async () => {
    await claim("lena", SECRET);
    const up = await app.request(
      new Request("http://x/diag/logs", {
        method: "POST",
        headers: { "x-tokenleader-secret": SECRET, "x-tokenleader-user": "lena" },
        body: '{"msg":"tick_done"}\n{"msg":"update_available"}\n',
      }),
    );
    expect(up.status).toBe(200);

    const read = await app.request(
      new Request("http://x/admin/diag/logs?user=lena", {
        headers: { authorization: `Bearer ${ADMIN}` },
      }),
    );
    const body = await jsonOf(read);
    expect(body.content).toContain("update_available");
    expect(body.uploadedAt).toBeGreaterThan(0);

    // Wrong secret can't upload.
    const bad = await app.request(
      new Request("http://x/diag/logs", {
        method: "POST",
        headers: { "x-tokenleader-secret": "intruder", "x-tokenleader-user": "lena" },
        body: "sneaky",
      }),
    );
    expect(bad.status).toBe(403);

    // Oversize payloads are truncated to the cap, not rejected.
    const big = await app.request(
      new Request("http://x/diag/logs", {
        method: "POST",
        headers: { "x-tokenleader-secret": SECRET, "x-tokenleader-user": "lena" },
        body: "x".repeat(300 * 1024),
      }),
    );
    expect((await jsonOf(big)).bytes).toBe(256 * 1024);

    // No upload yet → 404 for a different user.
    await claim("mo", SECRET);
    const none = await app.request(
      new Request("http://x/admin/diag/logs?user=mo", {
        headers: { authorization: `Bearer ${ADMIN}` },
      }),
    );
    expect(none.status).toBe(404);
  });

  test("per-device: two machines keep separate tails; &device= selects; unknown device 404", async () => {
    await claim("nyla", SECRET);
    const second = "nyla-second-secret";
    store.linkUserDevice("nyla", sha256Hex(second), Date.now(), "imac");

    const upload = (secret: string, content: string) =>
      app.request(
        new Request("http://x/diag/logs", {
          method: "POST",
          headers: { "x-tokenleader-secret": secret, "x-tokenleader-user": "nyla" },
          body: content,
        }),
      );
    expect((await upload(SECRET, "tail-from-first")).status).toBe(200);
    // Distinct uploaded_at: real uploads are minutes apart; the "newest
    // across devices" read below must not hinge on a same-ms tie.
    await Bun.sleep(2);
    expect((await upload(second, "tail-from-imac")).status).toBe(200);

    const read = (qs: string) =>
      app.request(
        new Request(`http://x/admin/diag/logs?${qs}`, {
          headers: { authorization: `Bearer ${ADMIN}` },
        }),
      );
    // No device param → newest upload across devices (the imac's).
    const latest = await jsonOf(await read("user=nyla"));
    expect(latest.content).toBe("tail-from-imac");
    expect(typeof latest.deviceId).toBe("number");

    // &device= by label narrows to one machine — the first device's tail
    // was NOT overwritten by the imac's upload.
    const byLabel = await jsonOf(await read("user=nyla&device=imac"));
    expect(byLabel.content).toBe("tail-from-imac");
    expect(byLabel.deviceLabel).toBe("imac");
    const firstId = store.listUserDevices("nyla")[0]!.id;
    const byId = await jsonOf(await read(`user=nyla&device=${firstId}`));
    expect(byId.content).toBe("tail-from-first");

    expect((await read("user=nyla&device=ghost-machine")).status).toBe(404);
  });
});

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function watchdogCheckinReq(
  user: string,
  secret: string,
  body?: string,
  headers: Record<string, string> = {},
): Request {
  return new Request("http://x/watchdog-checkin", {
    method: "POST",
    headers: { "x-tokenleader-secret": secret, "x-tokenleader-user": user, ...headers },
    ...(body !== undefined ? { body } : {}),
  });
}

function ackReq(user: string, secret: string, body: unknown): Request {
  return new Request("http://x/directives/ack", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-tokenleader-secret": secret,
      "x-tokenleader-user": user,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("v0.6 directive verbs", () => {
  test("watchdog verbs pass the admin allowlist", async () => {
    await claim("pax", SECRET);
    for (const verb of ["reinstall_watchdog", "sample", "upload_state"]) {
      const res = await app.request(adminEnqueue("pax", verb));
      expect(res.status).toBe(200);
      expect((await jsonOf(res)).verb).toBe(verb);
    }
  });
});

describe("directive channels: watchdog-only verbs never ride a daemon handout", () => {
  // A daemon handed `sample` would ack it 'failed: unknown verb' —
  // terminally completing it without the watchdog ever seeing it. Daemon
  // channels (/checkin, /ingest) must not even be OFFERED those verbs.
  test("sample skips /checkin and /ingest but is delivered on /watchdog-checkin", async () => {
    await claim("zane", SECRET);
    await app.request(adminEnqueue("zane", "sample"));

    const viaCheckin = await jsonOf(await app.request(checkinReq("zane", SECRET)));
    expect(viaCheckin.directive).toBeUndefined();
    const viaIngest = await jsonOf(
      await app.request(
        new Request("http://x/ingest", {
          method: "POST",
          headers: { "content-type": "application/json", "x-tokenleader-secret": SECRET },
          body: JSON.stringify({ events: [makeEvent("zane")] }),
        }),
      ),
    );
    expect(viaIngest.directive).toBeUndefined();

    const viaWatchdog = await jsonOf(await app.request(watchdogCheckinReq("zane", SECRET)));
    expect(viaWatchdog.directive.verb).toBe("sample");
  });

  test("a daemon claims the oldest verb it CAN run, skipping an older watchdog-only row", async () => {
    await claim("aria", SECRET);
    await app.request(adminEnqueue("aria", "upload_state")); // older, watchdog-only
    await app.request(adminEnqueue("aria", "restart")); // newer, daemon-runnable

    const viaCheckin = await jsonOf(await app.request(checkinReq("aria", SECRET)));
    expect(viaCheckin.directive.verb).toBe("restart");
    // The watchdog then drains the older watchdog-only directive.
    const viaWatchdog = await jsonOf(await app.request(watchdogCheckinReq("aria", SECRET)));
    expect(viaWatchdog.directive.verb).toBe("upload_state");
  });

  test("the watchdog may take ANY verb — daemon verbs included", async () => {
    await claim("bram", SECRET);
    await app.request(adminEnqueue("bram", "restart"));
    await app.request(adminEnqueue("bram", "reinstall_watchdog"));
    const first = await jsonOf(await app.request(watchdogCheckinReq("bram", SECRET)));
    expect(first.directive.verb).toBe("restart");
    const second = await jsonOf(await app.request(watchdogCheckinReq("bram", SECRET)));
    expect(second.directive.verb).toBe("reinstall_watchdog");
  });
});

describe("per-device directive targeting", () => {
  test("a device-pinned directive is only handed to that device; NULL goes to anyone", async () => {
    await claim("orla", SECRET);
    const imacSecret = "orla-imac-secret";
    const imacId = store.linkUserDevice("orla", sha256Hex(imacSecret), Date.now(), "imac");

    // Target the imac by label.
    const enq = await app.request(
      new Request("http://x/admin/directives", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN}` },
        body: JSON.stringify({ user: "orla", verb: "restart", device: "imac" }),
      }),
    );
    expect(enq.status).toBe(200);
    expect((await jsonOf(enq)).deviceId).toBe(imacId);

    // The first machine polls: nothing for it.
    const other = await jsonOf(await app.request(checkinReq("orla", SECRET)));
    expect(other.directive).toBeUndefined();
    // The imac polls: delivered.
    const target = await jsonOf(await app.request(checkinReq("orla", imacSecret)));
    expect(target.directive.verb).toBe("restart");

    // Untargeted directives still reach any device.
    await app.request(adminEnqueue("orla", "upload_logs"));
    const any = await jsonOf(await app.request(checkinReq("orla", SECRET)));
    expect(any.directive.verb).toBe("upload_logs");
  });

  test("device targeting by numeric id; unknown device is 404", async () => {
    await claim("piotr", SECRET);
    const deviceId = store.listUserDevices("piotr")[0]!.id;
    const byId = await app.request(
      new Request("http://x/admin/directives", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN}` },
        body: JSON.stringify({ user: "piotr", verb: "restart", device: deviceId }),
      }),
    );
    expect(byId.status).toBe(200);
    expect((await jsonOf(byId)).deviceId).toBe(deviceId);

    const unknown = await app.request(
      new Request("http://x/admin/directives", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN}` },
        body: JSON.stringify({ user: "piotr", verb: "restart", device: "no-such-machine" }),
      }),
    );
    expect(unknown.status).toBe(404);
  });
});

describe("executed-ack lifecycle (/directives/ack)", () => {
  test("delivery leaves a directive open; the ack completes it", async () => {
    await claim("quinn", SECRET);
    const { id } = await jsonOf(await app.request(adminEnqueue("quinn", "restart")));
    const delivered = await jsonOf(await app.request(checkinReq("quinn", SECRET)));
    expect(delivered.directive.id).toBe(id);

    const adminList = async () =>
      (
        await jsonOf(
          await app.request(
            new Request("http://x/admin/directives?user=quinn", {
              headers: { authorization: `Bearer ${ADMIN}` },
            }),
          ),
        )
      ).directives[0];

    // Delivered but un-acked: lifecycle says so.
    let row = await adminList();
    expect(row.state).toBe("delivered");
    expect(row.executed_at).toBeNull();

    const ack = await app.request(
      ackReq("quinn", SECRET, { id, result: "ok", executed_by: "daemon", detail: "restarted" }),
    );
    expect(ack.status).toBe(200);
    expect((await jsonOf(ack)).duplicate).toBe(false);

    row = await adminList();
    expect(row.state).toBe("executed");
    expect(row.executed_at).toBeGreaterThan(0);
    expect(row.result).toBe("ok");
    expect(row.detail).toBe("restarted");
    expect(row.executed_by).toBe("daemon");

    // Replayed ack: idempotent, first write stands.
    const replay = await jsonOf(
      await app.request(ackReq("quinn", SECRET, { id, result: "failed", executed_by: "watchdog" })),
    );
    expect(replay.ok).toBe(true);
    expect(replay.duplicate).toBe(true);
    expect((await adminList()).result).toBe("ok");
  });

  test("ack validation: wrong secret 403, foreign id 404, garbage 400 (never 500)", async () => {
    await claim("rene", SECRET);
    const { id } = await jsonOf(await app.request(adminEnqueue("rene", "upload_logs")));
    await app.request(checkinReq("rene", SECRET));

    expect(
      (await app.request(ackReq("rene", "intruder", { id, result: "ok", executed_by: "daemon" })))
        .status,
    ).toBe(403);
    // Another user cannot ack rene's directive even with valid auth.
    await claim("sana", SECRET);
    expect(
      (await app.request(ackReq("sana", SECRET, { id, result: "ok", executed_by: "daemon" })))
        .status,
    ).toBe(404);
    expect(
      (
        await app.request(
          ackReq("rene", SECRET, { id: 999_999, result: "ok", executed_by: "daemon" }),
        )
      ).status,
    ).toBe(404);
    expect((await app.request(ackReq("rene", SECRET, "{{{not json"))).status).toBe(400);
    expect(
      (await app.request(ackReq("rene", SECRET, { id, result: "shrug", executed_by: "daemon" })))
        .status,
    ).toBe(400);
    expect(
      (await app.request(ackReq("rene", SECRET, { id, result: "ok", executed_by: "cron" }))).status,
    ).toBe(400);
  });
});

describe("directive TTL re-queue (once, then expire)", () => {
  test("delivered-but-unacked re-queues exactly once after the TTL", async () => {
    await claim("tomo", SECRET);
    const { id } = await jsonOf(await app.request(adminEnqueue("tomo", "restart")));
    const first = await jsonOf(await app.request(checkinReq("tomo", SECRET)));
    expect(first.directive.id).toBe(id);

    // Simulate a full TTL passing with no ack (the executor died mid-run).
    store.db
      .prepare("UPDATE pending_directives SET delivered_at = ? WHERE id = ?")
      .run(Date.now() - DIRECTIVE_TTL_MS - 60_000, id);
    const requeued = await jsonOf(await app.request(checkinReq("tomo", SECRET)));
    expect(requeued.directive.id).toBe(id);

    // The retry is spent (requeued_at set): a second TTL lapse expires it.
    store.db
      .prepare("UPDATE pending_directives SET delivered_at = ?, requeued_at = ? WHERE id = ?")
      .run(Date.now() - DIRECTIVE_TTL_MS - 60_000, Date.now() - DIRECTIVE_TTL_MS - 60_000, id);
    const third = await jsonOf(await app.request(checkinReq("tomo", SECRET)));
    expect(third.directive).toBeUndefined();
  });
});

describe("/watchdog-checkin", () => {
  test("stamps watchdog_last_seen without touching the daemon channel", async () => {
    await claim("uli", SECRET);
    const before = store.listUserDevices("uli")[0]!;
    expect(before.watchdogLastSeen).toBeNull();

    const res = await app.request(watchdogCheckinReq("uli", SECRET));
    expect(res.status).toBe(200);
    expect((await jsonOf(res)).ok).toBe(true);

    const after = store.listUserDevices("uli")[0]!;
    expect(after.watchdogLastSeen).toBeGreaterThan(Date.now() - 5_000);
    expect(after.lastSeen).toBe(before.lastSeen); // daemon channel untouched
  });

  test("auth mirrors /checkin: unknown user 403 (never claims), bad handle 400", async () => {
    const res = await app.request(watchdogCheckinReq("phantom", "phantom-secret"));
    expect(res.status).toBe(403);
    expect(store.getUserSecretRow("phantom")).toBeNull();
    expect((await app.request(watchdogCheckinReq("Not A Handle!", SECRET))).status).toBe(400);
  });

  test("optional body is persisted; garbage bodies are ignored, still 200", async () => {
    await claim("vito", SECRET);
    const deviceId = store.listUserDevices("vito")[0]!.id;

    const good = await app.request(
      watchdogCheckinReq(
        "vito",
        SECRET,
        JSON.stringify({
          watchdog_version: "v0.6.0",
          daemon_pid_alive: true,
          heartbeat_age_runs: 2,
          kills_recent: 0,
          degraded: false,
          spool_pending: 1,
        }),
      ),
    );
    expect(good.status).toBe(200);
    const stored = store.getDeviceCheckinState(deviceId, "watchdog");
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored!.body).heartbeat_age_runs).toBe(2);
    const history = store.recentCheckinHistory(deviceId, "watchdog");
    expect(history.length).toBe(1);
    expect(history[0]!.version).toBe("v0.6.0");

    // Garbage body: 200, prior stored state untouched.
    const garbage = await app.request(watchdogCheckinReq("vito", SECRET, "{{{{ not json"));
    expect(garbage.status).toBe(200);
    expect((await jsonOf(garbage)).ok).toBe(true);
    expect(
      JSON.parse(store.getDeviceCheckinState(deviceId, "watchdog")!.body).heartbeat_age_runs,
    ).toBe(2);
    // The checkin still counted (that's the point of ignoring the body).
    expect(store.recentCheckinHistory(deviceId, "watchdog").length).toBe(2);
  });

  test("delivers directives — the heal path for a wedged daemon", async () => {
    await claim("wren", SECRET);
    await app.request(adminEnqueue("wren", "sample"));
    const body = await jsonOf(await app.request(watchdogCheckinReq("wren", SECRET)));
    expect(body.directive.verb).toBe("sample");
  });
});

describe("/checkin body persistence (v0.6)", () => {
  test("a CheckinBody is stored per device and uptime lands in the history journal", async () => {
    await claim("xena", SECRET);
    const deviceId = store.listUserDevices("xena")[0]!.id;
    const res = await app.request(
      new Request("http://x/checkin", {
        method: "POST",
        headers: {
          "x-tokenleader-secret": SECRET,
          "x-tokenleader-user": "xena",
          "x-tokenleader-version": "v0.6.0",
        },
        body: JSON.stringify({
          uptime_s: 4321,
          tick_seq: 7,
          consec_failures: 1,
          last_error: "batch_post_failed",
          last_update_result: null,
          disk_free_mb: 12000,
          drift_ms: 220,
          heartbeat_write_failures: 0,
          exit_journal_tail: [{ ts: Date.now() - 60_000, reason: "update_swap", code: 75 }],
          watchdog_installed: true,
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect((await jsonOf(res)).ok).toBe(true);

    const stored = store.getDeviceCheckinState(deviceId, "daemon");
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored!.body);
    expect(parsed.uptime_s).toBe(4321);
    expect(parsed.last_error).toBe("batch_post_failed");
    expect(parsed.exit_journal_tail.length).toBe(1);

    const history = store.recentCheckinHistory(deviceId, "daemon");
    expect(history[history.length - 1]!.uptime_s).toBe(4321);
    expect(history[history.length - 1]!.version).toBe("v0.6.0");
  });

  test("WIRE COMPAT: header-only and garbage-body checkins behave exactly like today", async () => {
    await claim("yuri", SECRET);
    const deviceId = store.listUserDevices("yuri")[0]!.id;

    // Header-only (every pre-0.6 daemon).
    const bare = await app.request(checkinReq("yuri", SECRET));
    expect(bare.status).toBe(200);
    expect(await jsonOf<{ ok: boolean }>(bare)).toEqual({ ok: true });
    expect(store.getDeviceCheckinState(deviceId, "daemon")).toBeNull();

    // Garbage body: ignored wholesale, same response shape, never a 500.
    const garbage = await app.request(
      new Request("http://x/checkin", {
        method: "POST",
        headers: { "x-tokenleader-secret": SECRET, "x-tokenleader-user": "yuri" },
        body: "\x00\x01 not json at all",
      }),
    );
    expect(garbage.status).toBe(200);
    expect(await jsonOf<{ ok: boolean }>(garbage)).toEqual({ ok: true });
    expect(store.getDeviceCheckinState(deviceId, "daemon")).toBeNull();
    // Both checkins still stamped the cadence journal.
    expect(store.recentCheckinHistory(deviceId, "daemon").length).toBe(2);
  });
});
