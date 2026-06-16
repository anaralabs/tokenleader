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

export function getCodexSessionsDir(): string {
  const root = resolveDir(process.env.CODEX_HOME, join(homedir(), ".codex"));
  return join(root, "sessions");
}

export function getCursorGlobalStorageDir(): string {
  let fallback: string;
  if (process.platform === "darwin") {
    fallback = join(homedir(), "Library", "Application Support", "Cursor", "User", "globalStorage");
  } else if (process.platform === "win32") {
    const appData =
      process.env.APPDATA && process.env.APPDATA.length > 0
        ? process.env.APPDATA
        : join(homedir(), "AppData", "Roaming");
    fallback = join(appData, "Cursor", "User", "globalStorage");
  } else {
    fallback = join(homedir(), ".config", "Cursor", "User", "globalStorage");
  }
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

/** Default on; set TOKENLEADER_CURSOR_LOCAL=0 to disable local Cursor parsing. */
export function isCursorLocalEnabled(): boolean {
  const raw = process.env.TOKENLEADER_CURSOR_LOCAL;
  if (raw === undefined || raw.trim() === "") return true;
  return isTruthyEnv(raw);
}

async function scanGlob(cwd: string, pattern: string): Promise<string[]> {
  const out: string[] = [];
  try {
    const glob = new Bun.Glob(pattern);
    for await (const rel of glob.scan({ cwd, onlyFiles: true })) {
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

export async function listCodexFiles(): Promise<string[]> {
  return scanGlob(getCodexSessionsDir(), "**/*.jsonl");
}

export async function listCursorTranscriptFiles(): Promise<string[]> {
  return scanGlob(getCursorProjectsDir(), "**/agent-transcripts/**/*.jsonl");
}
