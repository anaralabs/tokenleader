// Boot-time self-heal of the LaunchAgent plist.
//
// Older installs shipped KeepAlive as {Crashed:true, SuccessfulExit:false},
// which strands the daemon on ANY clean exit (notably the post-update
// process.exit(0)) until the next login — the v0.5.x fleet-stuck incident.
// We now ship unconditional `KeepAlive: true`. Updates swap only the binary,
// never the plist, so an already-installed daemon keeps its strand-prone
// plist forever otherwise. This heals it in place: on boot, any daemon
// running the new binary rewrites a drifted KeepAlive stanza. Surgical (only
// the KeepAlive stanza is touched — env vars and paths are preserved) and
// idempotent.
//
// Takes effect on the NEXT launchd load (reboot/login). We deliberately do
// NOT self-bootout to apply it live: bootout + bootstrap of our own job mid-run
// is the exact fragile restart path that produced the stranding, so we let the
// already-correct `RunAtLoad` pick the healed plist up on the next boot.

import { promises as fsp } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Logger } from "./log";

export function defaultPlistPath(): string {
  return path.join(homedir(), "Library", "LaunchAgents", "sh.anara.leaderboard.plist");
}

// The legacy KeepAlive dict, with any inner whitespace. The `<dict>` body is
// what distinguishes a strand-prone plist from an already-healed `<true/>`.
const LEGACY_KEEPALIVE = /<key>KeepAlive<\/key>\s*<dict>[\s\S]*?<\/dict>/;
const HEALED_KEEPALIVE = "<key>KeepAlive</key>\n    <true/>";

/** Pure core: rewrite a drifted KeepAlive stanza to the unconditional form. */
export function healPlistXml(xml: string): { changed: boolean; xml: string } {
  if (!LEGACY_KEEPALIVE.test(xml)) return { changed: false, xml };
  return { changed: true, xml: xml.replace(LEGACY_KEEPALIVE, HEALED_KEEPALIVE) };
}

async function atomicWrite(p: string, data: string): Promise<void> {
  const tmp = `${p}.new`;
  await fsp.writeFile(tmp, data, { mode: 0o600 });
  await fsp.rename(tmp, p);
}

export interface HealPlistDeps {
  plistPath?: string;
  readFile?: (p: string) => Promise<string>;
  writeFile?: (p: string, data: string) => Promise<void>;
}

/**
 * Best-effort: rewrite a drifted LaunchAgent plist to unconditional KeepAlive.
 * Never throws. Returns true iff the file was changed.
 */
export async function healInstalledPlist(log: Logger, deps: HealPlistDeps = {}): Promise<boolean> {
  const p = deps.plistPath ?? defaultPlistPath();
  const read = deps.readFile ?? ((f: string) => fsp.readFile(f, "utf8"));
  const write = deps.writeFile ?? atomicWrite;

  let xml: string;
  try {
    xml = await read(p);
  } catch {
    // No plist (env-run daemon, dev, or not installed via launchd) — nothing to heal.
    return false;
  }

  const { changed, xml: next } = healPlistXml(xml);
  if (!changed) {
    log.debug("plist_keepalive_ok", { plist: p });
    return false;
  }

  try {
    await write(p, next);
    log.info("plist_keepalive_healed", { plist: p });
    return true;
  } catch (err: unknown) {
    log.warn("plist_heal_failed", { plist: p, err: String((err as Error)?.message ?? err) });
    return false;
  }
}
