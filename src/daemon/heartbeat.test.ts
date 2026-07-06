import { afterEach, describe, expect, test } from "bun:test";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  clearUpdateMarker,
  createHeartbeat,
  journalExit,
  journalTail,
  readHeartbeat,
  readJournal,
  readUpdateMarker,
  writeUpdateMarker,
} from "./heartbeat";

const dirs: string[] = [];
async function makeTmpDir(): Promise<string> {
  const d = await fsp.mkdtemp(path.join(tmpdir(), "tokenleader-hb-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  for (const d of dirs.splice(0)) {
    await fsp.rm(d, { recursive: true, force: true });
  }
});

describe("heartbeat", () => {
  test("tickStart bumps the sequence; tickEnd records outcome; file round-trips", async () => {
    const dir = await makeTmpDir();
    const hb = createHeartbeat(dir, "v9.9.9", 4242);
    hb.tickStart();
    hb.tickEnd(true);
    let read = readHeartbeat(dir);
    expect(read?.pid).toBe(4242);
    expect(read?.tick_seq).toBe(1);
    expect(read?.consec_failures).toBe(0);
    expect(read?.version).toBe("v9.9.9");

    hb.tickStart();
    hb.tickEnd(false, "parse exploded");
    hb.tickStart();
    hb.tickEnd(false, "parse exploded again");
    read = readHeartbeat(dir);
    expect(read?.tick_seq).toBe(3);
    expect(read?.consec_failures).toBe(2);
    expect(read?.last_error).toBe("parse exploded again");

    // Success clears the failure streak.
    hb.tickStart();
    hb.tickEnd(true);
    read = readHeartbeat(dir);
    expect(read?.consec_failures).toBe(0);
    expect(read?.last_error).toBeNull();
  });

  test("missing and corrupt heartbeats read as null (observe-only rule)", async () => {
    const dir = await makeTmpDir();
    expect(readHeartbeat(dir)).toBeNull();
    await fsp.writeFile(path.join(dir, "heartbeat.json"), "{ not json");
    expect(readHeartbeat(dir)).toBeNull();
    await fsp.writeFile(path.join(dir, "heartbeat.json"), JSON.stringify({ pid: "nope" }));
    expect(readHeartbeat(dir)).toBeNull();
  });

  test("unwritable state dir counts write failures instead of throwing", async () => {
    const hb = createHeartbeat("/nonexistent/definitely/missing", "dev");
    hb.tickStart();
    hb.tickEnd(true);
    expect(hb.writeFailures).toBeGreaterThan(0);
  });
});

describe("exit journal", () => {
  test("appends, reads back in order, and filters by time", async () => {
    const dir = await makeTmpDir();
    journalExit(dir, "update_swap", 75);
    journalExit(dir, "shutdown", 0);
    const all = readJournal(dir);
    expect(all.map((e) => e.reason)).toEqual(["update_swap", "shutdown"]);
    expect(all[0]!.code).toBe(75);
    expect(journalTail(dir, Date.now() + 60_000)).toEqual([]);
    expect(journalTail(dir, Date.now() - 60_000).length).toBe(2);
  });

  test("torn lines are skipped, not fatal", async () => {
    const dir = await makeTmpDir();
    journalExit(dir, "recycle", 75);
    await fsp.appendFile(path.join(dir, "exit-journal.jsonl"), "{torn\n");
    journalExit(dir, "shutdown", 0);
    expect(readJournal(dir).map((e) => e.reason)).toEqual(["recycle", "shutdown"]);
  });

  test("size cap rewrites to the newest tail instead of growing forever", async () => {
    const dir = await makeTmpDir();
    // Oversize the journal well past the 64KB cap, then append once more.
    for (let i = 0; i < 3000; i++) journalExit(dir, `reason-${i}`, 75);
    const entries = readJournal(dir);
    expect(entries.length).toBeLessThan(3000);
    expect(entries[entries.length - 1]!.reason).toBe("reason-2999");
  });
});

describe("update marker", () => {
  test("write/read/clear lifecycle; empty file is no marker", async () => {
    const dir = await makeTmpDir();
    expect(readUpdateMarker(dir)).toBeNull();
    writeUpdateMarker(dir);
    const m = readUpdateMarker(dir);
    expect(m).not.toBeNull();
    expect(Math.abs(m!.started_at - Date.now())).toBeLessThan(5_000);
    clearUpdateMarker(dir);
    expect(readUpdateMarker(dir)).toBeNull();
  });
});
