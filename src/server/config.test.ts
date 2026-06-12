import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { makeTmpDirSync } from "../test-helpers.ts";
import {
  ConfigError,
  parseCompanyAliases,
  parseCursorUserMap,
  parseServerConfig,
  resolveDataDir,
} from "./config.ts";

let tmpDir: string;
let rmTmpDir: () => void;

beforeAll(() => {
  ({ dir: tmpDir, cleanup: rmTmpDir } = makeTmpDirSync("tokenleader-config-test-"));
});

afterAll(() => {
  rmTmpDir();
});

/** Collects warn lines so clamp/charset warnings are assertable. */
function warnSpy(): { log: { warn: (m: string) => void }; warns: string[] } {
  const warns: string[] = [];
  return { log: { warn: (m: string) => warns.push(m) }, warns };
}

describe("parseServerConfig defaults", () => {
  test("boots with zero env vars", () => {
    const { log } = warnSpy();
    const cfg = parseServerConfig({}, log);
    expect(cfg.port).toBe(8787);
    expect(cfg.host).toBe("0.0.0.0");
    expect(cfg.dbPath).toBe(join(cfg.dataDir, "tokenleader.sqlite"));
    expect(cfg.binaryCacheDir).toBe(join(cfg.dataDir, "binaries"));
    expect(cfg.mirrorIntervalSec).toBe(900);
    expect(cfg.cursorIntervalSec).toBe(900);
    expect(cfg.serverUrl).toBeUndefined();
    expect(cfg.teamName).toBeUndefined();
    expect(cfg.dashboardToken).toBeUndefined();
    expect(cfg.joinToken).toBeUndefined();
    expect(cfg.ghRepo).toBeUndefined();
    expect(cfg.cursorUserMap).toBeUndefined();
  });

  test("db + binary cache derive from TOKENLEADER_DATA_DIR", () => {
    const cfg = parseServerConfig({ TOKENLEADER_DATA_DIR: "/data" });
    expect(cfg.dataDir).toBe(resolve("/data"));
    expect(cfg.dbPath).toBe(resolve("/data/tokenleader.sqlite"));
    expect(cfg.binaryCacheDir).toBe(resolve("/data/binaries"));
  });

  test("explicit TOKENLEADER_DB / TOKENLEADER_BINARY_CACHE_DIR beat derivation", () => {
    const cfg = parseServerConfig({
      TOKENLEADER_DATA_DIR: "/data",
      TOKENLEADER_DB: "/elsewhere/db.sqlite",
      TOKENLEADER_BINARY_CACHE_DIR: "/elsewhere/bin",
    });
    expect(cfg.dbPath).toBe(resolve("/elsewhere/db.sqlite"));
    expect(cfg.binaryCacheDir).toBe(resolve("/elsewhere/bin"));
  });

  test("serverUrl drops trailing slashes", () => {
    const cfg = parseServerConfig({
      TOKENLEADER_SERVER_URL: "https://lb.example.com///",
    });
    expect(cfg.serverUrl).toBe("https://lb.example.com");
  });

  test("invalid PORT is a fatal config error", () => {
    expect(() => parseServerConfig({ PORT: "nope" })).toThrow(ConfigError);
    expect(() => parseServerConfig({ PORT: "0" })).toThrow(ConfigError);
    expect(() => parseServerConfig({ PORT: "70000" })).toThrow(ConfigError);
    expect(parseServerConfig({ PORT: "9000" }).port).toBe(9000);
  });

  test("intervals clamp-and-log instead of failing", () => {
    const { log, warns } = warnSpy();
    const cfg = parseServerConfig(
      {
        TOKENLEADER_MIRROR_INTERVAL_SEC: "1",
        TOKENLEADER_CURSOR_INTERVAL_SEC: "999999999",
      },
      log,
    );
    expect(cfg.mirrorIntervalSec).toBe(60);
    expect(cfg.cursorIntervalSec).toBe(86_400);
    expect(warns.length).toBe(2);
  });
});

describe("resolveDataDir platform defaults", () => {
  test("darwin → ~/Library/Application Support/tokenleader", () => {
    expect(resolveDataDir({}, "darwin")).toBe(
      join(homedir(), "Library", "Application Support", "tokenleader"),
    );
  });

  test("linux honors XDG_DATA_HOME, else ~/.local/share", () => {
    expect(resolveDataDir({ XDG_DATA_HOME: "/xdg" }, "linux")).toBe(resolve("/xdg/tokenleader"));
    expect(resolveDataDir({}, "linux")).toBe(join(homedir(), ".local", "share", "tokenleader"));
  });

  test("explicit TOKENLEADER_DATA_DIR wins on any platform", () => {
    expect(resolveDataDir({ TOKENLEADER_DATA_DIR: "/data" }, "linux")).toBe(resolve("/data"));
  });
});

describe("cursor user map parsing", () => {
  test("inline JSON parses; keys lowercased; values trimmed", () => {
    const { log } = warnSpy();
    const map = parseCursorUserMap(
      {
        TOKENLEADER_CURSOR_USER_MAP: '{"Alice@Example.COM":" alice "}',
      },
      log,
    );
    expect(map).toEqual({ "alice@example.com": "alice" });
  });

  test("malformed JSON is fatal", () => {
    expect(() => parseCursorUserMap({ TOKENLEADER_CURSOR_USER_MAP: "{not json" }, console)).toThrow(
      ConfigError,
    );
  });

  test("non-object / array JSON is fatal", () => {
    expect(() => parseCursorUserMap({ TOKENLEADER_CURSOR_USER_MAP: '["a"]' }, console)).toThrow(
      ConfigError,
    );
    expect(() => parseCursorUserMap({ TOKENLEADER_CURSOR_USER_MAP: '"str"' }, console)).toThrow(
      ConfigError,
    );
  });

  test("non-string, empty, and >64-char values are fatal", () => {
    expect(() =>
      parseCursorUserMap({ TOKENLEADER_CURSOR_USER_MAP: '{"a@example.com": 1}' }, console),
    ).toThrow(ConfigError);
    expect(() =>
      parseCursorUserMap({ TOKENLEADER_CURSOR_USER_MAP: '{"a@example.com": "  "}' }, console),
    ).toThrow(ConfigError);
    const long = "x".repeat(65);
    expect(() =>
      parseCursorUserMap({ TOKENLEADER_CURSOR_USER_MAP: `{"a@example.com": "${long}"}` }, console),
    ).toThrow(ConfigError);
  });

  test("chars outside [A-Za-z0-9._-] warn but do not fail", () => {
    const { log, warns } = warnSpy();
    const map = parseCursorUserMap(
      { TOKENLEADER_CURSOR_USER_MAP: '{"a@example.com":"weird name!"}' },
      log,
    );
    expect(map).toEqual({ "a@example.com": "weird name!" });
    expect(warns.length).toBe(1);
  });

  test("_FILE wins entirely over inline (no merge)", () => {
    const file = join(tmpDir, "map.json");
    writeFileSync(file, '{"file@example.com":"filed"}');
    const { log } = warnSpy();
    const map = parseCursorUserMap(
      {
        TOKENLEADER_CURSOR_USER_MAP: '{"inline@example.com":"inlined"}',
        TOKENLEADER_CURSOR_USER_MAP_FILE: file,
      },
      log,
    );
    expect(map).toEqual({ "file@example.com": "filed" });
  });

  test("unreadable _FILE is fatal", () => {
    expect(() =>
      parseCursorUserMap(
        { TOKENLEADER_CURSOR_USER_MAP_FILE: join(tmpDir, "missing.json") },
        console,
      ),
    ).toThrow(ConfigError);
  });

  test("cursor token without a map warns and disables the mirror (non-fatal)", () => {
    // A throw here would crash-loop fielded servers (token set, map
    // scrubbed) under launchd KeepAlive — parse must succeed.
    const noMap = warnSpy();
    const cfg1 = parseServerConfig({ TOKENLEADER_CURSOR_TOKEN: "crsr_x" }, noMap.log);
    expect(cfg1.cursorToken).toBe("crsr_x");
    expect(cfg1.cursorUserMap).toBeUndefined();
    expect(noMap.warns.length).toBe(1);
    expect(noMap.warns[0]).toContain("CURSOR MIRROR DISABLED");

    const emptyMap = warnSpy();
    const cfg2 = parseServerConfig(
      {
        TOKENLEADER_CURSOR_TOKEN: "crsr_x",
        TOKENLEADER_CURSOR_USER_MAP: "{}",
      },
      emptyMap.log,
    );
    expect(cfg2.cursorUserMap).toEqual({});
    expect(emptyMap.warns.length).toBe(1);

    const ok = warnSpy();
    const cfg3 = parseServerConfig(
      {
        TOKENLEADER_CURSOR_TOKEN: "crsr_x",
        TOKENLEADER_CURSOR_USER_MAP: '{"a@example.com":"a"}',
      },
      ok.log,
    );
    expect(cfg3.cursorUserMap).toEqual({ "a@example.com": "a" });
    expect(ok.warns.length).toBe(0);
  });
});

describe(".env.example parity", () => {
  // Every TOKENLEADER_* env var the server code reads must have a row in
  // .env.example, and every TOKENLEADER_* row in .env.example must be read
  // by server code. Scans actual env READS (env.X / env["X"]), not string
  // mentions, so script-only daemon vars rendered into installers don't
  // count.
  test("server env reads ↔ .env.example rows", () => {
    const serverDir = join(import.meta.dir);
    const readVars = new Set<string>();
    for (const f of readdirSync(serverDir)) {
      if (!f.endsWith(".ts") || f.endsWith(".test.ts")) continue;
      const src = readFileSync(join(serverDir, f), "utf8");
      for (const m of src.matchAll(/env(?:\.|\[["'])(TOKENLEADER_[A-Z_]+)/g)) {
        readVars.add(m[1]!);
      }
    }
    const example = readFileSync(join(import.meta.dir, "..", "..", ".env.example"), "utf8");
    const exampleVars = new Set<string>();
    for (const m of example.matchAll(/^#?\s*(TOKENLEADER_[A-Z_]+)=/gm)) {
      exampleVars.add(m[1]!);
    }
    expect([...readVars].sort()).toEqual([...exampleVars].sort());
    // Sanity: the scan found the core set (guards against a regex rot
    // making both sides empty-and-equal).
    expect(readVars.has("TOKENLEADER_DATA_DIR")).toBe(true);
    expect(readVars.has("TOKENLEADER_CURSOR_USER_MAP_FILE")).toBe(true);
  });
});

describe("parseCompanyAliases (TOKENLEADER_COMPANY_ALIASES)", () => {
  const warnings: string[] = [];
  const log = { warn: (m: string) => warnings.push(m) };

  test("normalizes both sides and applies domain shape", () => {
    const out = parseCompanyAliases(
      { TOKENLEADER_COMPANY_ALIASES: '{"Sync.Labs":"https://www.sync.so/x","ok.com":"ok.com"}' },
      log,
    );
    expect(out).toEqual({ "sync.labs": "sync.so", "ok.com": "ok.com" });
  });

  test("drops non-domain entries with a warn, empty result is undefined", () => {
    warnings.length = 0;
    const out = parseCompanyAliases(
      { TOKENLEADER_COMPANY_ALIASES: '{"notadomain":"also bad"}' },
      log,
    );
    expect(out).toBeUndefined();
    expect(warnings.length).toBe(1);
  });

  test("absent → undefined; malformed JSON is fatal", () => {
    expect(parseCompanyAliases({}, log)).toBeUndefined();
    expect(() => parseCompanyAliases({ TOKENLEADER_COMPANY_ALIASES: "{nope" }, log)).toThrow(
      ConfigError,
    );
    expect(() => parseCompanyAliases({ TOKENLEADER_COMPANY_ALIASES: "[1]" }, log)).toThrow(
      ConfigError,
    );
  });
});
