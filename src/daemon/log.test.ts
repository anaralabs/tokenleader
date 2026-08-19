import { describe, expect, test } from "bun:test";
import { defaultLogDir } from "./log.ts";

describe("defaultLogDir", () => {
  test("macOS is unchanged: the LaunchAgent's own log dir", () => {
    expect(defaultLogDir("darwin", "/Users/wing")).toBe(
      "/Users/wing/Library/Logs/anara-leaderboard",
    );
  });

  test("Linux uses ~/.local/state, never a literal ~/Library on a VPS", () => {
    // Verified in-container before the fix: the Linux daemon created
    // /home/wing/Library/Logs/anara-leaderboard/daemon.jsonl. The
    // `upload_logs` directive reads THIS path, so remote debugging of a Linux
    // box depends on it landing where an operator would look.
    expect(defaultLogDir("linux", "/home/wing")).toBe("/home/wing/.local/state/anara-leaderboard");
  });

  test("XDG_STATE_HOME cannot move it — installer, daemon and uninstaller agree", () => {
    // The installer prints (and pre-creates) ~/.local/state/anara-leaderboard
    // and TOKENLEADER_PURGE=y deletes exactly that path; the state dir is
    // homedir-only too. An XDG_STATE_HOME inherited by a `systemd --user`
    // unit must not split the three apart.
    const before = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = "/var/state";
    try {
      expect(defaultLogDir("linux", "/home/wing")).toBe(
        "/home/wing/.local/state/anara-leaderboard",
      );
    } finally {
      if (before === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = before;
    }
  });
});
