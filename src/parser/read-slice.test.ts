import { describe, expect, it } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_READ_BYTES, readNewlineLines } from "./read-slice.ts";

async function tempFile(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "read-slice-test-"));
  const path = join(dir, "data.jsonl");
  await writeFile(path, contents);
  return path;
}

/** Drain the generator, collecting lines, oversize-drop count, final offset. */
async function drain(
  path: string,
  byteOffset: number,
  maxBytes?: number,
): Promise<{ lines: string[]; oversize: number; newOffset: number; reads: number }> {
  const lines: string[] = [];
  let oversize = 0;
  let newOffset = byteOffset;
  let reads = 0;
  for await (const r of readNewlineLines(Bun.file(path), byteOffset, maxBytes)) {
    reads++;
    newOffset = r.newOffset;
    if (r.kind === "line") lines.push(r.text);
    else if (r.kind === "oversize") oversize++;
  }
  return { lines, oversize, newOffset, reads };
}

describe("readNewlineLines", () => {
  it("yields each line of a small file and advances to EOF", async () => {
    const body = "a\nb\nc\n";
    const path = await tempFile(body);
    const r = await drain(path, 0);
    expect(r.lines).toEqual(["a", "b", "c"]);
    expect(r.newOffset).toBe(Buffer.byteLength(body, "utf8"));
  });

  it("leaves an unterminated trailing line for the next read", async () => {
    const path = await tempFile("a\nb\npartial-no-newline");
    const r = await drain(path, 0);
    expect(r.lines).toEqual(["a", "b"]);
    expect(r.newOffset).toBe(Buffer.byteLength("a\nb\n", "utf8"));
  });

  it("skips blank lines but still advances the offset past them", async () => {
    const body = "a\n\n\nb\n";
    const path = await tempFile(body);
    const r = await drain(path, 0);
    expect(r.lines).toEqual(["a", "b"]);
    expect(r.newOffset).toBe(Buffer.byteLength(body, "utf8"));
  });

  it("consumes a file far larger than the window across many small windows", async () => {
    const want = Array.from({ length: 200 }, (_, i) => `line-${i}`);
    const body = want.map((l) => l + "\n").join("");
    const path = await tempFile(body);
    const r = await drain(path, 0, 16); // 16-byte windows force re-reads
    expect(r.lines).toEqual(want);
    expect(r.newOffset).toBe(Buffer.byteLength(body, "utf8"));
  });

  it("resumes correctly from a saved mid-file offset", async () => {
    const body = "one\ntwo\nthree\n";
    const path = await tempFile(body);
    const mid = Buffer.byteLength("one\n", "utf8");
    const r = await drain(path, mid, 16);
    expect(r.lines).toEqual(["two", "three"]);
    expect(r.newOffset).toBe(Buffer.byteLength(body, "utf8"));
  });

  it("returns nothing when starting at or past EOF", async () => {
    const path = await tempFile("a\nb\n");
    const size = Bun.file(path).size;
    const r = await drain(path, size);
    expect(r.lines).toEqual([]);
    expect(r.reads).toBe(0);
  });

  // --- oversized single line (longer than the window) ----------------------

  it("discards an oversized line entirely, reports it, and keeps the next line", async () => {
    const huge = "x".repeat(100);
    const body = `${huge}\nafter\n`;
    const path = await tempFile(body);
    const r = await drain(path, 0, 8); // window far smaller than the huge line
    expect(r.lines).toEqual(["after"]); // the huge line is dropped, not yielded
    expect(r.oversize).toBe(1); // the drop is reported, not silent
    expect(r.newOffset).toBe(Buffer.byteLength(body, "utf8")); // reached EOF
  });

  it("keeps a record whose content is exactly maxBytes; drops one byte longer", async () => {
    // Boundary: content length == maxBytes must fit (its newline sits at the
    // extra read byte); content length == maxBytes + 1 overflows and is dropped.
    const atLimit = "x".repeat(8);
    const overLimit = "y".repeat(9);
    const body = `${atLimit}\n${overLimit}\nz\n`;
    const path = await tempFile(body);
    const r = await drain(path, 0, 8);
    expect(r.lines).toEqual([atLimit, "z"]); // the over-limit record is gone
    expect(r.oversize).toBe(1);
    expect(r.newOffset).toBe(Buffer.byteLength(body, "utf8"));
  });

  it("does not yield the JSON suffix of an oversized line as a record", async () => {
    // A 200-char line of spaces ending in a real JSON object: with a small
    // window the line overflows, so the whole record (suffix included) must be
    // discarded — never surfaced as a parseable line.
    const oversized = " ".repeat(200) + '{"type":"real"}';
    const body = `${oversized}\n{"type":"next"}\n`;
    const path = await tempFile(body);
    const r = await drain(path, 0, 16);
    expect(r.lines).toEqual(['{"type":"next"}']);
    expect(r.lines.some((l) => l.includes('"real"'))).toBe(false);
    expect(r.oversize).toBe(1);
  });

  it("never stalls: an unterminated oversized tail leaves the offset put", async () => {
    // One giant line with no terminator at all (a file still being written).
    // We must not consume a partial record, report a drop, or loop forever.
    const body = "y".repeat(1000); // no newline
    const path = await tempFile(body);
    const r = await drain(path, 0, 8);
    expect(r.lines).toEqual([]);
    expect(r.oversize).toBe(0); // not a completed drop — wait for the terminator
    expect(r.newOffset).toBe(0); // nothing consumed
  });

  // --- UTF-8 correctness ---------------------------------------------------

  it("decodes multi-byte lines with byte-accurate offsets under a small window", async () => {
    // Because whole lines are decoded from raw bytes between newlines (never a
    // window-spanning slice), a multi-byte char ('€' is 3 bytes: E2 82 AC) is
    // never cut. Small windows that re-read line by line must still decode each
    // line intact and advance offsets by bytes, not characters.
    const body = "ab\nc€d\n€\n";
    const path = await tempFile(body);
    const r = await drain(path, 0, 8);
    expect(r.lines).toEqual(["ab", "c€d", "€"]);
    expect(r.newOffset).toBe(Buffer.byteLength(body, "utf8"));
  });

  it("decodes multi-byte lines that fit within one window", async () => {
    const body = "héllo-✓\nสวัสดี\n";
    const path = await tempFile(body);
    const r = await drain(path, 0);
    expect(r.lines).toEqual(["héllo-✓", "สวัสดี"]);
    expect(r.newOffset).toBe(Buffer.byteLength(body, "utf8"));
  });

  // --- contract guards -----------------------------------------------------

  it("throws on a non-positive maxBytes instead of looping forever", async () => {
    const path = await tempFile("a\n");
    await expect(drain(path, 0, 0)).rejects.toThrow(/maxBytes/);
    await expect(drain(path, 0, -1)).rejects.toThrow(/maxBytes/);
  });

  it("defaults to a window well under the string-length ceiling", () => {
    expect(MAX_READ_BYTES).toBeGreaterThan(0);
    expect(MAX_READ_BYTES).toBeLessThanOrEqual(512 * 1024 * 1024);
  });
});
