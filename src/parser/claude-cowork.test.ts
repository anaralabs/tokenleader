import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getClaudeCoworkDir, isClaudeCoworkEnabled, listClaudeCoworkFiles } from "./index.ts";

const ENV_DIR = "TOKENLEADER_CLAUDE_COWORK_DIR";
const ENV_ON = "TOKENLEADER_CLAUDE_COWORK";

afterEach(() => {
  delete process.env[ENV_DIR];
  delete process.env[ENV_ON];
});

/** Write a file, creating parent dirs. */
async function put(path: string, body = "{}\n"): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, body);
}

/**
 * Build a Desktop-app-shaped tree under a temp dir. `sessionRoot` is the
 * top-level sessions dir (e.g. local-agent-mode-sessions). Returns the
 * transcript path that listClaudeCoworkFiles should discover.
 */
async function makeCoworkTree(sessionRoot: string): Promise<{ base: string; transcript: string }> {
  const base = await mkdtemp(join(tmpdir(), "cowork-disco-"));
  const transcript = join(
    base,
    sessionRoot,
    "acct-uuid",
    "org-uuid",
    "local_sess-1",
    ".claude",
    "projects",
    "-sessions-foo",
    "abc.jsonl",
  );
  await put(transcript);
  return { base, transcript };
}

describe("listClaudeCoworkFiles", () => {
  it("discovers a transcript buried under the hidden .claude/projects path", async () => {
    const { base, transcript } = await makeCoworkTree("local-agent-mode-sessions");
    process.env[ENV_DIR] = base;
    const found = await listClaudeCoworkFiles();
    expect(found).toContain(transcript);
  });

  it("also discovers the migrated claude-code-sessions layout", async () => {
    const { base, transcript } = await makeCoworkTree("claude-code-sessions");
    process.env[ENV_DIR] = base;
    const found = await listClaudeCoworkFiles();
    expect(found).toContain(transcript);
  });

  it("ignores files that are not under a .claude/projects subtree", async () => {
    const base = await mkdtemp(join(tmpdir(), "cowork-disco-"));
    // A sibling jsonl outside .claude/projects (e.g. audit.jsonl) must not match.
    await put(join(base, "local-agent-mode-sessions", "x", "y", "local_z", "audit.jsonl"));
    // A heavy sibling dir the scan must never surface either.
    await put(join(base, "vm_bundles", "claudevm.bundle", "stuff.jsonl"));
    process.env[ENV_DIR] = base;
    expect(await listClaudeCoworkFiles()).toEqual([]);
  });

  it("returns [] when disabled via TOKENLEADER_CLAUDE_COWORK=0", async () => {
    const { base } = await makeCoworkTree("local-agent-mode-sessions");
    process.env[ENV_DIR] = base;
    process.env[ENV_ON] = "0";
    expect(isClaudeCoworkEnabled()).toBe(false);
    expect(await listClaudeCoworkFiles()).toEqual([]);
  });

  it("returns [] when the Desktop dir does not exist", async () => {
    process.env[ENV_DIR] = join(tmpdir(), "cowork-does-not-exist-zzz");
    expect(await listClaudeCoworkFiles()).toEqual([]);
  });

  it("is enabled by default and resolves a platform Desktop dir", () => {
    expect(isClaudeCoworkEnabled()).toBe(true);
    expect(getClaudeCoworkDir()).toContain("Claude");
  });
});
