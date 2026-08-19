import { describe, expect, test } from "bun:test";
import { daemonEnvFilePath, parseEnvFile } from "./env-file.ts";

describe("daemonEnvFilePath", () => {
  test("lives in the state dir, beside the TOFU secret", () => {
    expect(daemonEnvFilePath("/home/wing/.local/share/anara-leaderboard")).toBe(
      "/home/wing/.local/share/anara-leaderboard/daemon.env",
    );
    expect(daemonEnvFilePath("/srv/state/")).toBe("/srv/state/daemon.env");
  });
});

describe("parseEnvFile", () => {
  test("reads what the installer writes", () => {
    const parsed = parseEnvFile(
      [
        "TOKENLEADER_USER=wing",
        "TOKENLEADER_ENDPOINT=https://leaderboard.example.com",
        "TOKENLEADER_LINK=BM2U-DXD8",
        "",
      ].join("\n"),
    );
    expect(parsed).toEqual({
      TOKENLEADER_USER: "wing",
      TOKENLEADER_ENDPOINT: "https://leaderboard.example.com",
      TOKENLEADER_LINK: "BM2U-DXD8",
    });
  });

  test("ignores comments, blanks and non-ALL-CAPS keys (mirrors parsePlistEnv)", () => {
    const parsed = parseEnvFile(
      ["# a comment", "", "  ", "lowercase=nope", "9BAD=nope", "OK_KEY=yes", "NOEQUALS"].join("\n"),
    );
    expect(parsed).toEqual({ OK_KEY: "yes" });
  });

  test("tolerates a quoted value even though we never write one", () => {
    expect(parseEnvFile(`TOKENLEADER_USER="wing"\nTOKENLEADER_JOIN='abc'\n`)).toEqual({
      TOKENLEADER_USER: "wing",
      TOKENLEADER_JOIN: "abc",
    });
  });

  test("a value containing '=' survives intact (URLs with query strings)", () => {
    expect(parseEnvFile("TOKENLEADER_ENDPOINT=https://x.example/y?a=b\n")).toEqual({
      TOKENLEADER_ENDPOINT: "https://x.example/y?a=b",
    });
  });
});
