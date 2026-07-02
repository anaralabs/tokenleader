// Directive channel + heartbeat: /checkin stamps liveness for daemons with
// nothing to post and delivers single-shot directives; /diag/logs stores a
// log tail; /admin/directives enqueues. Identity changes (claim/re-claim/
// link) must stay exclusively on /ingest — /checkin only ever authenticates
// EXISTING devices.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestApp, jsonOf, makeTokenEvent } from "../test-helpers.ts";
import type { TokenEvent } from "../types.ts";

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
});
