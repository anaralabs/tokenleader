import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";

function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  if (p === "~") return homedir();
  return p;
}

function resolveDir(envValue: string | undefined, fallback: string): string {
  const raw = envValue && envValue.length > 0 ? envValue : fallback;
  const expanded = expandHome(raw);
  return isAbsolute(expanded) ? expanded : join(process.cwd(), expanded);
}

export function getClaudeCodeProjectsDir(): string {
  // CLAUDE_CONFIG_DIR points at the .claude root; sessions live under projects/
  const root = resolveDir(process.env.CLAUDE_CONFIG_DIR, join(homedir(), ".claude"));
  return join(root, "projects");
}

/**
 * Per-OS root where desktop apps keep their support data: macOS
 * `~/Library/Application Support`, Windows `%APPDATA%` (Roaming), Linux
 * `~/.config`. Both Claude Desktop and Cursor live under here.
 */
function platformAppSupportRoot(): string {
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support");
  if (process.platform === "win32") {
    return process.env.APPDATA && process.env.APPDATA.length > 0
      ? process.env.APPDATA
      : join(homedir(), "AppData", "Roaming");
  }
  return join(homedir(), ".config");
}

/**
 * Root of the Claude **Desktop** app's data dir, which holds Claude Cowork
 * ("local agent mode") sessions. Each session runs in a sandbox with its own
 * nested `.claude/projects/...jsonl` transcript — byte-identical to the CLI
 * format but living here, not under ~/.claude. Override with
 * TOKENLEADER_CLAUDE_COWORK_DIR.
 */
export function getClaudeCoworkDir(): string {
  return resolveDir(
    process.env.TOKENLEADER_CLAUDE_COWORK_DIR,
    join(platformAppSupportRoot(), "Claude"),
  );
}

// Session-transcript roots under the Desktop data dir. The store reportedly
// migrated names across versions, so we scan both and tolerate either being
// absent (scanGlob returns [] for a missing dir).
const COWORK_SESSION_ROOTS = ["local-agent-mode-sessions", "claude-code-sessions"] as const;

export function getCodexSessionsDir(): string {
  const root = resolveDir(process.env.CODEX_HOME, join(homedir(), ".codex"));
  return join(root, "sessions");
}

export function getCursorGlobalStorageDir(): string {
  const fallback = join(platformAppSupportRoot(), "Cursor", "User", "globalStorage");
  return resolveDir(process.env.CURSOR_DATA_DIR, fallback);
}

export function getCursorStateDbPath(): string {
  return join(getCursorGlobalStorageDir(), "state.vscdb");
}

export function getCursorProjectsDir(): string {
  return resolveDir(process.env.CURSOR_PROJECTS_DIR, join(homedir(), ".cursor", "projects"));
}

function isTruthyEnv(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

/** A toggle env var that defaults ON: unset/empty → true, else parse truthiness. */
function isEnabledByDefault(envVar: string): boolean {
  const raw = process.env[envVar];
  if (raw === undefined || raw.trim() === "") return true;
  return isTruthyEnv(raw);
}

/** Default on; set TOKENLEADER_CURSOR_LOCAL=0 to disable local Cursor parsing. */
export function isCursorLocalEnabled(): boolean {
  return isEnabledByDefault("TOKENLEADER_CURSOR_LOCAL");
}

/** Default on; set TOKENLEADER_CLAUDE_COWORK=0 to disable Claude Cowork parsing. */
export function isClaudeCoworkEnabled(): boolean {
  return isEnabledByDefault("TOKENLEADER_CLAUDE_COWORK");
}

async function scanGlob(
  cwd: string,
  pattern: string,
  opts: { dot?: boolean } = {},
): Promise<string[]> {
  const out: string[] = [];
  try {
    const glob = new Bun.Glob(pattern);
    for await (const rel of glob.scan({ cwd, onlyFiles: true, dot: opts.dot ?? false })) {
      out.push(join(cwd, rel));
    }
  } catch {
    // dir missing — return empty
  }
  return out;
}

export async function listClaudeCodeFiles(): Promise<string[]> {
  return scanGlob(getClaudeCodeProjectsDir(), "**/*.jsonl");
}

/**
 * Cowork transcripts live at
 * `<DesktopDir>/<session-root>/**​/.claude/projects/**​/*.jsonl`. The `.claude`
 * segment is hidden, so the scan must opt into dotfiles (`dot: true`) or it
 * matches nothing. Scoped to the known session roots so it never descends into
 * the multi-GB `vm_bundles/` sibling.
 */
export async function listClaudeCoworkFiles(): Promise<string[]> {
  if (!isClaudeCoworkEnabled()) return [];
  const base = getClaudeCoworkDir();
  const groups = await Promise.all(
    COWORK_SESSION_ROOTS.map((root) =>
      scanGlob(join(base, root), "**/.claude/projects/**/*.jsonl", { dot: true }),
    ),
  );
  return groups.flat();
}

export async function listCodexFiles(): Promise<string[]> {
  return scanGlob(getCodexSessionsDir(), "**/*.jsonl");
}

export async function listCursorTranscriptFiles(): Promise<string[]> {
  return scanGlob(getCursorProjectsDir(), "**/agent-transcripts/**/*.jsonl");
}
