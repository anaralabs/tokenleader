import { describe, expect, test } from "bun:test";
import type { Logger } from "./log";
import { healInstalledPlist, healPlistXml } from "./plist-heal";

function makeLog(): { log: Logger; records: { level: string; msg: string }[] } {
  const records: { level: string; msg: string }[] = [];
  const push = (level: string) => (msg: string) => {
    records.push({ level, msg });
  };
  const log: Logger = {
    debug: push("debug"),
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
  };
  return { log, records };
}

const LEGACY_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>sh.anara.leaderboard</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>TOKENLEADER_USER</key>
        <string>alice</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>Crashed</key>
        <true/>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>30</integer>
</dict>
</plist>`;

const HEALED_PLIST = LEGACY_PLIST.replace(
  /<key>KeepAlive<\/key>\s*<dict>[\s\S]*?<\/dict>/,
  "<key>KeepAlive</key>\n    <true/>",
);

describe("healPlistXml", () => {
  test("rewrites a strand-prone KeepAlive dict to unconditional", () => {
    const { changed, xml } = healPlistXml(LEGACY_PLIST);
    expect(changed).toBe(true);
    expect(xml).toContain("<key>KeepAlive</key>\n    <true/>");
    expect(xml).not.toContain("SuccessfulExit");
    // Everything else is preserved untouched.
    expect(xml).toContain("<string>alice</string>");
    expect(xml).toContain("<key>ThrottleInterval</key>");
  });

  test("already-healed plist is left unchanged (idempotent)", () => {
    const { changed, xml } = healPlistXml(HEALED_PLIST);
    expect(changed).toBe(false);
    expect(xml).toBe(HEALED_PLIST);
  });

  test("plist without a KeepAlive dict is untouched", () => {
    const noKeepAlive = "<plist><dict><key>RunAtLoad</key><true/></dict></plist>";
    expect(healPlistXml(noKeepAlive)).toEqual({ changed: false, xml: noKeepAlive });
  });
});

describe("healInstalledPlist", () => {
  test("writes the healed plist when drift is detected", async () => {
    const { log } = makeLog();
    let written: { path: string; data: string } | null = null;
    const healed = await healInstalledPlist(log, {
      plistPath: "/fake/sh.anara.leaderboard.plist",
      readFile: async () => LEGACY_PLIST,
      writeFile: async (p, data) => {
        written = { path: p, data };
      },
    });
    expect(healed).toBe(true);
    expect(written).not.toBeNull();
    expect(written!.path).toBe("/fake/sh.anara.leaderboard.plist");
    expect(written!.data).toContain("<key>KeepAlive</key>\n    <true/>");
    expect(written!.data).not.toContain("SuccessfulExit");
  });

  test("no write when the plist is already healed", async () => {
    const { log } = makeLog();
    let wrote = false;
    const healed = await healInstalledPlist(log, {
      readFile: async () => HEALED_PLIST,
      writeFile: async () => {
        wrote = true;
      },
    });
    expect(healed).toBe(false);
    expect(wrote).toBe(false);
  });

  test("missing plist (unreadable) is a no-op, never throws", async () => {
    const { log } = makeLog();
    const healed = await healInstalledPlist(log, {
      readFile: async () => {
        throw new Error("ENOENT");
      },
      writeFile: async () => {
        throw new Error("should not be called");
      },
    });
    expect(healed).toBe(false);
  });

  test("a write failure is swallowed, never throws", async () => {
    const { log, records } = makeLog();
    const healed = await healInstalledPlist(log, {
      readFile: async () => LEGACY_PLIST,
      writeFile: async () => {
        throw new Error("EACCES");
      },
    });
    expect(healed).toBe(false);
    expect(records.some((r) => r.level === "warn" && r.msg === "plist_heal_failed")).toBe(true);
  });
});
