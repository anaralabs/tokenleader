// Release guard (f): drive the ACTUAL release binary through a full
// self-update cycle against a local server — manifest fetch → curl download
// → sha verify → smoke test → atomic swap → deliberate exit(75).
//
// Why this exists: tests run under `bun`, but the fleet runs the COMPILED
// binary — a different runtime surface. The v0.5.x silent-exit fetch kill
// (Bun's fetch of a large body terminating the whole process with a clean
// exit 0) shipped through a fully green 641-test suite precisely because no
// gate ever executed the real artifact's update path. This one does.
//
// Usage: bun scripts/update-gate.ts <release-binary> <next-binary>
//   <release-binary>  the artifact being published (executed for real)
//   <next-binary>     any OTHER valid daemon build (what the update swaps to)

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

const GATE_VERSION = "v0.0.0-updategate";
const TIMEOUT_MS = 150_000;

const [releaseBin, nextBin] = process.argv.slice(2);
if (!releaseBin || !nextBin) {
  console.error("usage: bun scripts/update-gate.ts <release-binary> <next-binary>");
  process.exit(2);
}

const nextBytes = await fsp.readFile(nextBin);
const nextSha = createHash("sha256").update(nextBytes).digest("hex");

// Local stand-in for the real server: manifest + binary + a JSON sink for
// ingest/checkin so the daemon's other requests never error.
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const p = new URL(req.url).pathname;
    if (p === "/manifest.json") {
      return Response.json({
        version: GATE_VERSION,
        publishedAt: new Date().toISOString(),
        arm64: { sha256: nextSha },
        x64: { sha256: nextSha },
      });
    }
    if (p.startsWith("/bin/")) return new Response(nextBytes);
    return Response.json({ inserted: 0, duplicates: 0 });
  },
});

const sandbox = await fsp.mkdtemp(path.join(os.tmpdir(), "update-gate-"));
const execPath = path.join(sandbox, "anara-leaderboard");
await fsp.copyFile(releaseBin, execPath);
await fsp.chmod(execPath, 0o755);

// Sandbox HOME: no transcript files to scan, no real state touched. The
// first update check fires ~30s after boot (initialUpdateDelayMs), so a
// healthy cycle completes well inside the timeout.
const child = spawn(execPath, [], {
  env: {
    ...process.env,
    HOME: sandbox,
    TOKENLEADER_USER: "update-gate",
    TOKENLEADER_ENDPOINT: `http://127.0.0.1:${server.port}`,
    TOKENLEADER_STATE_DIR: path.join(sandbox, "state"),
    TOKENLEADER_LOG_DIR: path.join(sandbox, "logs"),
    TOKENLEADER_INTERVAL_SEC: "5",
    TOKENLEADER_UPDATE_INTERVAL_SEC: "60",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (d: Buffer) => {
  output += d.toString();
});
child.stderr.on("data", (d: Buffer) => {
  output += d.toString();
});

const code: number | null = await new Promise((resolve) => {
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    resolve(null);
  }, TIMEOUT_MS);
  child.on("exit", (c) => {
    clearTimeout(timer);
    resolve(c);
  });
});
server.stop(true);

function fail(msg: string): never {
  console.error(`update-gate FAILED: ${msg}`);
  console.error(`--- daemon output (tail) ---\n${output.slice(-4000)}`);
  process.exit(1);
}

if (code === null) fail(`daemon did not exit within ${TIMEOUT_MS}ms (hung update path?)`);
// 0 here is the incident signature: a clean exit instead of the deliberate
// restart means the runtime died silently somewhere in the update path.
if (code !== 75) fail(`exit code ${code}, expected 75 (RESTART_EXIT_CODE)`);

const swappedSha = createHash("sha256")
  .update(await fsp.readFile(execPath))
  .digest("hex");
if (swappedSha !== nextSha) fail(`swapped binary sha ${swappedSha} != expected ${nextSha}`);

const ver = Bun.spawnSync([execPath, "--version"]).stdout.toString().trim();
if (!ver.startsWith(GATE_VERSION)) fail(`swapped binary --version reports '${ver}'`);

console.log(`update-gate OK: full cycle on the real artifact (exit 75, swapped to '${ver}')`);
await fsp.rm(sandbox, { recursive: true, force: true });
