import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Logger } from "./log";
import {
  createHeartbeat,
  journalExit,
  writeUpdateMarker,
} from "./heartbeat";
import {
  DAEMON_LABEL,
  emptyWatchdogState,
  type Exec,
  FUSE_RESPAWNS,
  loadWatchdogState,
  renderWatchdogPlist,
  runWatchdog,
  saveWatchdogState,
  STALE_RUNS_MIN,
  staleRunsFor,
  UPDATE_GRACE_RUNS,
  WATCHDOG_LABEL,
  type WatchdogDeps,
} from "./watchdog";

const nullLog: Logger = { debug() {}, info() {}, warn() {}, error() {} };

const dirs: string[] = [];
async function makeTmpDir(): Promise<string> {
  const d = await fsp.mkdtemp(path.join(tmpdir(), "tokenleader-wd-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  for (const d of dirs.splice(0)) {
    await fsp.rm(d, { recursive: true, force: true });
  }
});

interface Harness {
  deps: WatchdogDeps;
  home: string;
  stateDir: string;
  execCalls: string[][];
  kills: { pid: number; sig: string }[];
  /** Mutable: what `launchctl print gui/uid/daemon-label` reports as pid. */
  daemonPid: { value: number | null };
}

/** A watchdog test rig: real tmp fs, fake launchctl/sample/curl, fake kill. */
async function makeHarness(): Promise<Harness> {
  const home = await makeTmpDir();
  const stateDir = path.join(home, "state");
  await fsp.mkdir(stateDir, { recursive: true });
  await fsp.mkdir(path.join(home, "Library", "LaunchAgents"), { recursive: true });
  await fsp.mkdir(path.join(home, ".local", "bin"), { recursive: true });
  // A daemon plist with identity env, and a binary, so self-clean never trips.
  await fsp.writeFile(
    path.join(home, "Library", "LaunchAgents", `${DAEMON_LABEL}.plist`),
    `<plist><dict>
      <key>TOKENLEADER_USER</key><string>krish</string>
      <key>TOKENLEADER_ENDPOINT</key><string>https://example.com</string>
    </dict></plist>`,
  );
  await fsp.writeFile(path.join(home, ".local", "bin", "anara-leaderboard"), "#!/bin/sh\n");

  const execCalls: string[][] = [];
  const kills: { pid: number; sig: string }[] = [];
  const daemonPid = { value: 4242 as number | null };
  const exec: Exec = (cmd, args) => {
    execCalls.push([cmd, ...args]);
    if (cmd === "launchctl" && args[0] === "print" && args[1]?.endsWith(DAEMON_LABEL)) {
      if (daemonPid.value === null) return { ok: false, stdout: "", err: "not running" };
      return { ok: true, stdout: `\tstate = running\n\tpid = ${daemonPid.value}\n` };
    }
    if (cmd === "launchctl") return { ok: true, stdout: "" };
    if (cmd === "curl") return { ok: false, stdout: "", err: "offline" };
    return { ok: true, stdout: "" };
  };
  const deps: WatchdogDeps = {
    log: nullLog,
    stateDir,
    logDir: path.join(home, "logs"),
    home,
    exec,
    kill: (pid, sig) => kills.push({ pid, sig: String(sig) }),
    skipDomainAssert: true,
    env: {},
  };
  return { deps, home, stateDir, execCalls, kills, daemonPid };
}

describe("staleness + kill ladder", () => {
  test("unchanged heartbeat across the threshold: forensics, SIGTERM, then SIGKILL", async () => {
    const h = await makeHarness();
    const hb = createHeartbeat(h.stateDir, "dev", 4242);
    hb.tickStart(); // one write; never advances again — the wedge

    for (let i = 0; i < STALE_RUNS_MIN; i++) {
      const r = await runWatchdog(h.deps);
      expect(r.action).toBe("observe");
      expect(h.kills).toEqual([]);
    }
    // Threshold reached: evidence first, then SIGTERM.
    let r = await runWatchdog(h.deps);
    expect(r.action).toBe("sigterm");
    expect(h.kills).toEqual([{ pid: 4242, sig: "SIGTERM" }]);
    expect(h.execCalls.some((c) => c[0] === "sample" && c.includes("4242"))).toBe(true);

    // Still wedged next run: SIGKILL.
    r = await runWatchdog(h.deps);
    expect(r.action).toBe("sigkill");
    expect(h.kills[1]).toEqual({ pid: 4242, sig: "SIGKILL" });
  });

  test("a moving heartbeat is never touched", async () => {
    const h = await makeHarness();
    const hb = createHeartbeat(h.stateDir, "dev", 4242);
    for (let i = 0; i < STALE_RUNS_MIN + 3; i++) {
      hb.tickStart(); // fresh write before every watchdog firing
      const r = await runWatchdog(h.deps);
      expect(r.action).toBe("observe");
    }
    expect(h.kills).toEqual([]);
  });

  test("missing heartbeat is observe-only even with a live daemon (pre-0.6 / rollback)", async () => {
    const h = await makeHarness();
    for (let i = 0; i < STALE_RUNS_MIN + 5; i++) {
      const r = await runWatchdog(h.deps);
      expect(r.action).toBe("observe");
    }
    expect(h.kills).toEqual([]);
  });

  test("identity anchor: label pid differing from heartbeat pid is unkillable", async () => {
    const h = await makeHarness();
    const hb = createHeartbeat(h.stateDir, "dev", 4242);
    hb.tickStart();
    h.daemonPid.value = 9001; // respawned since the heartbeat was written
    for (let i = 0; i <= STALE_RUNS_MIN + 2; i++) {
      await runWatchdog(h.deps);
    }
    expect(h.kills).toEqual([]);
  });

  test("a fresh update marker widens the deadline to the update grace window", async () => {
    const h = await makeHarness();
    const hb = createHeartbeat(h.stateDir, "dev", 4242);
    hb.tickStart();
    writeUpdateMarker(h.stateDir);
    for (let i = 0; i <= STALE_RUNS_MIN + 4; i++) {
      const r = await runWatchdog(h.deps);
      expect(r.action).toBe("observe"); // would have SIGTERMed without the marker
    }
    expect(h.kills).toEqual([]);
    expect(UPDATE_GRACE_RUNS).toBeGreaterThan(STALE_RUNS_MIN);
  });

  test("staleRunsFor scales with custom tick intervals", () => {
    expect(staleRunsFor(300)).toBe(STALE_RUNS_MIN);
    expect(staleRunsFor(3600)).toBe(90); // 3x a 1h tick, in 120s firings
  });
});

describe("fuse (respawns, not kills)", () => {
  test("unexplained pid churn latches degraded; journaled exits do not count", async () => {
    const h = await makeHarness();
    const hb = createHeartbeat(h.stateDir, "dev", 4242);
    hb.tickStart();

    // Journal-explained churn first: swap restarts must never trip the fuse.
    for (let i = 0; i < FUSE_RESPAWNS + 1; i++) {
      journalExit(h.stateDir, "update_swap", 75);
      h.daemonPid.value = 5000 + i;
      const r = await runWatchdog(h.deps);
      expect(r.action).toBe("observe");
    }
    expect(loadWatchdogState(h.stateDir).state.degraded).toBe(false);
  });

  test("unexplained respawn churn hits the fuse and stops the ladder", async () => {
    const h = await makeHarness();
    const hb = createHeartbeat(h.stateDir, "dev", 4242);
    hb.tickStart();
    let r = await runWatchdog(h.deps); // records lastLabelPid
    for (let i = 1; i <= FUSE_RESPAWNS; i++) {
      h.daemonPid.value = 6000 + i; // crash-respawn, no journal entry
      r = await runWatchdog(h.deps);
    }
    expect(r.action).toBe("degraded");
    expect(loadWatchdogState(h.stateDir).state.degraded).toBe(true);
    // Degraded latch: even a fully stale + identity-matched daemon is not killed.
    const frozen = createHeartbeat(h.stateDir, "dev", 7777);
    frozen.tickStart();
    h.daemonPid.value = 7777;
    for (let i = 0; i <= STALE_RUNS_MIN + 2; i++) {
      await runWatchdog(h.deps);
    }
    expect(h.kills).toEqual([]);
  });
});

describe("watchdog state file", () => {
  test("corrupt state fails closed toward detection (one stale observation pre-recorded)", async () => {
    const dir = await makeTmpDir();
    await fsp.writeFile(path.join(dir, "watchdog.json"), "{nope");
    const { state, corrupt } = loadWatchdogState(dir);
    expect(corrupt).toBe(true);
    expect(state.consecUnchanged).toBe(1);
    // Missing state is a clean first run, not a corruption.
    const dir2 = await makeTmpDir();
    expect(loadWatchdogState(dir2)).toEqual({ state: emptyWatchdogState(), corrupt: false });
  });

  test("round-trips through save/load", async () => {
    const dir = await makeTmpDir();
    const s = emptyWatchdogState();
    s.consecUnchanged = 5;
    s.respawns = [123];
    saveWatchdogState(dir, s);
    expect(loadWatchdogState(dir).state).toEqual(s);
  });
});

describe("self-clean", () => {
  test("daemon plist AND binary both gone → remove own plist, bootout own label", async () => {
    const h = await makeHarness();
    await fsp.rm(path.join(h.home, "Library", "LaunchAgents", `${DAEMON_LABEL}.plist`));
    await fsp.rm(path.join(h.home, ".local", "bin", "anara-leaderboard"));
    const r = await runWatchdog(h.deps);
    expect(r.action).toBe("self_clean");
    expect(
      h.execCalls.some((c) => c[0] === "launchctl" && c[1] === "bootout" && c[2]?.endsWith(WATCHDOG_LABEL)),
    ).toBe(true);
  });
});

describe("plist renderer", () => {
  test("byte-converges with scripts/plist-templates.sh render_watchdog_plist", () => {
    if (process.platform !== "darwin") return;
    const home = "/Users/example";
    const r = spawnSync(
      "bash",
      ["-c", `source scripts/plist-templates.sh && render_watchdog_plist '${home}'`],
      { encoding: "utf8" },
    );
    expect(r.status).toBe(0);
    expect(renderWatchdogPlist(home)).toBe(r.stdout);
  });
});
