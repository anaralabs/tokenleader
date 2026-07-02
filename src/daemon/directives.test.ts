import { describe, expect, test } from "bun:test";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { makeTmpDir } from "../test-helpers";
import type { Logger } from "./log";
import { executeDirective, readLogTail } from "./directives";
import { postCheckin } from "./transport";
import { RESTART_EXIT_CODE } from "./update";

function makeLog(): { log: Logger; records: { level: string; msg: string }[] } {
  const records: { level: string; msg: string }[] = [];
  const push = (level: string) => (msg: string) => {
    records.push({ level, msg });
  };
  return {
    log: { debug: push("debug"), info: push("info"), warn: push("warn"), error: push("error") },
    records,
  };
}

describe("readLogTail", () => {
  test("returns the last N bytes of a large file, whole small files, null when missing", async () => {
    const { dir, cleanup } = await makeTmpDir("tokenleader-directives-");
    try {
      const p = path.join(dir, "daemon.jsonl");
      const head = "OLD".repeat(10_000);
      const tail = "NEW-TAIL-MARKER";
      await fsp.writeFile(p, head + tail);
      const got = await readLogTail(p, 1024);
      expect(got).toHaveLength(1024);
      expect(got!.endsWith(tail)).toBe(true);
      expect(got).not.toContain("OLDOLDOLD".repeat(300));

      const small = path.join(dir, "small.jsonl");
      await fsp.writeFile(small, "just-this");
      expect(await readLogTail(small, 1024)).toBe("just-this");

      expect(await readLogTail(path.join(dir, "missing"), 1024)).toBeNull();
    } finally {
      await cleanup();
    }
  });
});

describe("executeDirective", () => {
  test("restart: exits with RESTART_EXIT_CODE", async () => {
    const { log, records } = makeLog();
    const exits: number[] = [];
    await executeDirective(
      { id: 1, verb: "restart" },
      {
        log,
        endpoint: "https://x",
        secret: "s",
        user: "u",
        exit: (code) => {
          exits.push(code);
        },
      },
    );
    expect(exits).toEqual([RESTART_EXIT_CODE]);
    expect(records.some((r) => r.msg === "directive_restart")).toBe(true);
  });

  test("upload_logs: POSTs the log tail with auth headers", async () => {
    const { dir, cleanup } = await makeTmpDir("tokenleader-directives-");
    try {
      const logFile = path.join(dir, "daemon.jsonl");
      await fsp.writeFile(logFile, '{"msg":"tick_done"}\n');
      const { log } = makeLog();
      let captured: { url: string; body: string; headers: Record<string, string> } | null = null;
      const fetchImpl = (async (url: unknown, init?: RequestInit) => {
        captured = {
          url: String(url),
          body: String(init?.body),
          headers: init?.headers as Record<string, string>,
        };
        return new Response(JSON.stringify({ ok: true, bytes: 20 }), { status: 200 });
      }) as unknown as typeof fetch;

      await executeDirective(
        { id: 2, verb: "upload_logs" },
        {
          log,
          endpoint: "https://srv.example.com/",
          secret: "sec",
          user: "kim",
          fetchImpl,
          logFile,
        },
      );
      expect(captured).not.toBeNull();
      expect(captured!.url).toBe("https://srv.example.com/diag/logs");
      expect(captured!.body).toContain("tick_done");
      expect(captured!.headers["X-Tokenleader-Secret"]).toBe("sec");
      expect(captured!.headers["X-Tokenleader-User"]).toBe("kim");
    } finally {
      await cleanup();
    }
  });

  test("unknown verbs are logged and dropped — never throw, never exit", async () => {
    const { log, records } = makeLog();
    let exited = false;
    await executeDirective(
      { id: 3, verb: "format_disk" },
      {
        log,
        endpoint: "https://x",
        secret: "s",
        user: "u",
        exit: () => {
          exited = true;
        },
      },
    );
    expect(exited).toBe(false);
    expect(records.some((r) => r.msg === "directive_unknown_verb" && r.level === "warn")).toBe(
      true,
    );
  });
});

describe("postCheckin", () => {
  const opts = {
    endpoint: "https://srv.example.com",
    secret: "sec",
    version: "v1.2.3",
    arch: "arm64",
  };

  test("200 with a directive parses it; headers carry identity + build", async () => {
    let headers: Record<string, string> | null = null;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      headers = init?.headers as Record<string, string>;
      return new Response(JSON.stringify({ ok: true, directive: { id: 7, verb: "restart" } }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const r = await postCheckin("kim", { ...opts, fetchImpl });
    expect(r).toEqual({ ok: true, directive: { id: 7, verb: "restart" } });
    expect(headers!["X-Tokenleader-User"]).toBe("kim");
    expect(headers!["X-Tokenleader-Version"]).toBe("v1.2.3");
  });

  test("404 (old server) and network errors resolve {ok:false} silently", async () => {
    const notFound = (async () =>
      new Response("no route", { status: 404 })) as unknown as typeof fetch;
    expect(await postCheckin("kim", { ...opts, fetchImpl: notFound })).toEqual({ ok: false });

    const boom = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await postCheckin("kim", { ...opts, fetchImpl: boom })).toEqual({ ok: false });
  });

  test("garbage directive shapes are ignored", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ ok: true, directive: { verb: 42 } }), {
        status: 200,
      })) as unknown as typeof fetch;
    expect(await postCheckin("kim", { ...opts, fetchImpl })).toEqual({ ok: true });
  });
});
