import { describe, it, expect } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionStreamBuffer, STREAM_READ_MAX_BYTES } from "./stream-buffer.js";

describe("SessionStreamBuffer.append + read", () => {
  it("returns appended bytes from cursor 0", () => {
    const buf = new SessionStreamBuffer({ capacityBytes: 1024 });
    buf.append(Buffer.from("hello"));
    const r = buf.read(0, 64);
    expect(r.bytes.toString("utf8")).toBe("hello");
    expect(r.nextCursor).toBe(5);
    expect(r.gap).toBeUndefined();
    expect(r.eof).toBeUndefined();
  });

  it("advances writeCursor monotonically across appends", () => {
    const buf = new SessionStreamBuffer({ capacityBytes: 1024 });
    buf.append(Buffer.from("ab"));
    buf.append(Buffer.from("cd"));
    buf.append(Buffer.from("ef"));
    expect(buf.writeCursorPos).toBe(6);
    const r = buf.read(2, 64);
    expect(r.bytes.toString("utf8")).toBe("cdef");
    expect(r.nextCursor).toBe(6);
  });

  it("caps a single read at STREAM_READ_MAX_BYTES even when the caller asks for more", () => {
    const buf = new SessionStreamBuffer({
      capacityBytes: STREAM_READ_MAX_BYTES * 2,
    });
    const big = Buffer.alloc(STREAM_READ_MAX_BYTES * 2, 0x61);
    buf.append(big);
    const r = buf.read(0, STREAM_READ_MAX_BYTES * 4);
    expect(r.bytes.length).toBe(STREAM_READ_MAX_BYTES);
    expect(r.nextCursor).toBe(STREAM_READ_MAX_BYTES);
  });

  it("returns empty bytes when cursor is at writeCursor", () => {
    const buf = new SessionStreamBuffer({ capacityBytes: 1024 });
    buf.append(Buffer.from("abc"));
    const r = buf.read(3, 64);
    expect(r.bytes.length).toBe(0);
    expect(r.nextCursor).toBe(3);
    expect(r.eof).toBeUndefined();
  });
});

describe("SessionStreamBuffer ring eviction + gap reporting", () => {
  it("evicts oldest bytes and reports a gap when cursor lags", () => {
    const buf = new SessionStreamBuffer({ capacityBytes: 8 });
    buf.append(Buffer.from("12345678"));
    buf.append(Buffer.from("abcd"));
    expect(buf.writeCursorPos).toBe(12);
    expect(buf.oldestAvailable).toBe(4);
    const r = buf.read(0, 64);
    expect(r.gap).toBe(4);
    expect(r.bytes.toString("utf8")).toBe("5678abcd");
    expect(r.nextCursor).toBe(12);
  });

  it("handles wrap-around on the storage ring without scrambling bytes", () => {
    const buf = new SessionStreamBuffer({ capacityBytes: 6 });
    buf.append(Buffer.from("ABCD"));
    buf.append(Buffer.from("EFGH"));
    const r = buf.read(2, 64);
    expect(r.bytes.toString("utf8")).toBe("CDEFGH");
    expect(r.gap).toBeUndefined();
  });

  it("drops the prefix when a single chunk exceeds the capacity", () => {
    const buf = new SessionStreamBuffer({ capacityBytes: 4 });
    buf.append(Buffer.from("ABCDEFGH"));
    expect(buf.writeCursorPos).toBe(8);
    expect(buf.oldestAvailable).toBe(4);
    const r = buf.read(0, 64);
    expect(r.gap).toBe(4);
    expect(r.bytes.toString("utf8")).toBe("EFGH");
  });
});

describe("SessionStreamBuffer.tail + head", () => {
  it("tail returns the most recent bytes with truncated:false when fully resident", () => {
    const buf = new SessionStreamBuffer({ capacityBytes: 1024 });
    buf.append(Buffer.from("abcdefghij"));
    const t = buf.tail(4);
    expect(t.bytes.toString("utf8")).toBe("ghij");
    expect(t.startCursor).toBe(6);
    expect(t.endCursor).toBe(10);
    expect(t.truncated).toBe(false);
  });

  it("tail marks truncated when the requested span predates the oldest byte", () => {
    const buf = new SessionStreamBuffer({ capacityBytes: 4 });
    buf.append(Buffer.from("ABCDEFGH"));
    const t = buf.tail(8);
    expect(t.bytes.toString("utf8")).toBe("EFGH");
    expect(t.truncated).toBe(true);
  });

  it("head returns oldest bytes; marks truncated when cursor 0 is evicted", () => {
    const buf = new SessionStreamBuffer({ capacityBytes: 4 });
    buf.append(Buffer.from("ABCDEFGH"));
    const h = buf.head(4);
    expect(h.bytes.toString("utf8")).toBe("EFGH");
    expect(h.startCursor).toBe(4);
    expect(h.endCursor).toBe(8);
    expect(h.truncated).toBe(true);
  });
});

describe("SessionStreamBuffer.waitForData long-poll", () => {
  it("resolves immediately when cursor is already behind writeCursor", async () => {
    const buf = new SessionStreamBuffer({ capacityBytes: 64 });
    buf.append(Buffer.from("hi"));
    await expect(buf.waitForData(0, 1000)).resolves.toBe("data");
  });

  it("resolves with 'data' when an append arrives mid-wait", async () => {
    const buf = new SessionStreamBuffer({ capacityBytes: 64 });
    const pending = buf.waitForData(0, 1000);
    setImmediate(() => buf.append(Buffer.from("late")));
    await expect(pending).resolves.toBe("data");
  });

  it("resolves with 'eof' when the buffer closes while waiting", async () => {
    const buf = new SessionStreamBuffer({ capacityBytes: 64 });
    const pending = buf.waitForData(0, 1000);
    setImmediate(() => buf.close());
    await expect(pending).resolves.toBe("eof");
  });

  it("resolves with 'timeout' when no event arrives in time", async () => {
    const buf = new SessionStreamBuffer({ capacityBytes: 64 });
    await expect(buf.waitForData(0, 25)).resolves.toBe("timeout");
  });

  it("resolves multiple concurrent waiters with the same outcome", async () => {
    const buf = new SessionStreamBuffer({ capacityBytes: 64 });
    const a = buf.waitForData(0, 1000);
    const b = buf.waitForData(0, 1000);
    const c = buf.waitForData(0, 1000);
    setImmediate(() => buf.append(Buffer.from("x")));
    const results = await Promise.all([a, b, c]);
    expect(results).toEqual(["data", "data", "data"]);
  });
});

describe("SessionStreamBuffer.close + eof on read", () => {
  it("marks eof:true when reading at or past writeCursor after close", () => {
    const buf = new SessionStreamBuffer({ capacityBytes: 64 });
    buf.append(Buffer.from("abc"));
    buf.close();
    const r = buf.read(3, 64);
    expect(r.bytes.length).toBe(0);
    expect(r.eof).toBe(true);
  });

  it("silently drops appends after close", () => {
    const buf = new SessionStreamBuffer({ capacityBytes: 64 });
    buf.append(Buffer.from("a"));
    buf.close();
    buf.append(Buffer.from("b"));
    expect(buf.writeCursorPos).toBe(1);
  });
});

describe("SessionStreamBuffer file projection", () => {
  it("appends each chunk to filePath alongside the in-memory ring", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "hydra-stream-buf-"));
    const file = path.join(dir, "stream.log");
    try {
      const buf = new SessionStreamBuffer({
        capacityBytes: 64,
        filePath: file,
      });
      buf.append(Buffer.from("first\n"));
      buf.append(Buffer.from("second\n"));
      await buf.drainFileWrites();
      const onDisk = await fsp.readFile(file, "utf8");
      expect(onDisk).toBe("first\nsecond\n");
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it("stops writing to the file once the soft cap is hit and fires the callback once", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "hydra-stream-buf-"));
    const file = path.join(dir, "stream.log");
    let capCalls = 0;
    try {
      const buf = new SessionStreamBuffer({
        capacityBytes: 1024,
        filePath: file,
        fileCapBytes: 10,
        onFileCapReached: () => {
          capCalls += 1;
        },
      });
      buf.append(Buffer.from("0123456")); // 7 bytes
      buf.append(Buffer.from("789ABCDEF")); // 9 bytes; first 3 get through to cap.
      buf.append(Buffer.from("more")); // dropped from file entirely.
      await buf.drainFileWrites();
      const onDisk = await fsp.readFile(file, "utf8");
      expect(onDisk).toBe("0123456789");
      expect(capCalls).toBe(1);
      // The ring still has everything.
      const r = buf.read(0, 1024);
      expect(r.bytes.toString("utf8")).toBe("0123456789ABCDEFmore");
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("SessionStreamBuffer lazy growth", () => {
  it("starts at the initial allocation, not the configured cap", () => {
    const buf = new SessionStreamBuffer({ capacityBytes: 64 * 1024 * 1024 });
    expect(buf.allocatedBytes).toBe(1 * 1024 * 1024);
    expect(buf.capacity).toBe(64 * 1024 * 1024);
  });

  it("does not grow when small writes fit in the initial allocation", () => {
    const buf = new SessionStreamBuffer({ capacityBytes: 64 * 1024 * 1024 });
    buf.append(Buffer.alloc(1024, 0x61));
    expect(buf.allocatedBytes).toBe(1 * 1024 * 1024);
  });

  it("doubles the allocation on demand until the cap is reached", () => {
    const buf = new SessionStreamBuffer({ capacityBytes: 8 * 1024 * 1024 });
    expect(buf.allocatedBytes).toBe(1 * 1024 * 1024);
    buf.append(Buffer.alloc(1.5 * 1024 * 1024, 0x61));
    expect(buf.allocatedBytes).toBe(2 * 1024 * 1024);
    buf.append(Buffer.alloc(3 * 1024 * 1024, 0x62));
    expect(buf.allocatedBytes).toBe(8 * 1024 * 1024);
  });

  it("caps at maxCapacityBytes and evicts only after the cap is reached", () => {
    const buf = new SessionStreamBuffer({ capacityBytes: 4 * 1024 * 1024 });
    buf.append(Buffer.alloc(3 * 1024 * 1024, 0x61));
    expect(buf.allocatedBytes).toBe(4 * 1024 * 1024);
    expect(buf.oldestAvailable).toBe(0);
    buf.append(Buffer.alloc(2 * 1024 * 1024, 0x62));
    expect(buf.allocatedBytes).toBe(4 * 1024 * 1024);
    expect(buf.oldestAvailable).toBe(1 * 1024 * 1024);
  });

  it("preserves bytes across growth", () => {
    const buf = new SessionStreamBuffer({ capacityBytes: 8 * 1024 * 1024 });
    buf.append(Buffer.from("hello"));
    buf.append(Buffer.alloc(2 * 1024 * 1024, 0x61));
    const r = buf.read(0, 5);
    expect(r.bytes.toString("utf8")).toBe("hello");
  });

  it("clamps initial allocation to capacity when cap is smaller than INITIAL", () => {
    const buf = new SessionStreamBuffer({ capacityBytes: 1024 });
    expect(buf.allocatedBytes).toBe(1024);
    expect(buf.capacity).toBe(1024);
  });
});

describe("SessionStreamBuffer.grep", () => {
  it("returns matching lines with absolute cursors and skips a trailing partial line when open", () => {
    const buf = new SessionStreamBuffer({ capacityBytes: 1024 });
    buf.append(Buffer.from("alpha\nbeta\nalpha2\npartial"));
    const r = buf.grep({ pattern: "alpha" });
    expect(r.matches.map((m) => m.line)).toEqual(["alpha", "alpha2"]);
    expect(r.matches[0]!.cursor).toBe(0);
    expect(r.matches[1]!.cursor).toBe("alpha\nbeta\n".length);
    expect(r.truncated).toBe(false);
    expect(r.eof).toBeUndefined();
    expect(r.nextCursor).toBe("alpha\nbeta\nalpha2\n".length);
  });

  it("treats a trailing line as final when buffer is closed and reports eof", () => {
    const buf = new SessionStreamBuffer({ capacityBytes: 1024 });
    buf.append(Buffer.from("alpha\ntrailing-alpha"));
    buf.close();
    const r = buf.grep({ pattern: "alpha" });
    expect(r.matches.map((m) => m.line)).toEqual(["alpha", "trailing-alpha"]);
    expect(r.eof).toBe(true);
  });

  it("supports literal substring matching when regex:false", () => {
    const buf = new SessionStreamBuffer({ capacityBytes: 1024 });
    buf.append(Buffer.from("a.c\nabc\n"));
    const r = buf.grep({ pattern: "a.c", regex: false });
    expect(r.matches.map((m) => m.line)).toEqual(["a.c"]);
  });

  it("supports caseInsensitive and invert", () => {
    const buf = new SessionStreamBuffer({ capacityBytes: 1024 });
    buf.append(Buffer.from("HELLO\nworld\nHELLO\n"));
    const ci = buf.grep({ pattern: "hello", caseInsensitive: true });
    expect(ci.matches).toHaveLength(2);
    const inv = buf.grep({ pattern: "HELLO", invert: true });
    expect(inv.matches.map((m) => m.line)).toEqual(["world"]);
  });

  it("truncates at maxMatches and sets nextCursor for resumption", () => {
    const buf = new SessionStreamBuffer({ capacityBytes: 1024 });
    buf.append(Buffer.from("x\nx\nx\nx\n"));
    const r = buf.grep({ pattern: "x", maxMatches: 2 });
    expect(r.matches).toHaveLength(2);
    expect(r.truncated).toBe(true);
    expect(r.nextCursor).toBe(4);
    const r2 = buf.grep({ pattern: "x", cursor: r.nextCursor });
    expect(r2.matches).toHaveLength(2);
  });

  it("reports gap when cursor is older than oldestAvailable", () => {
    const buf = new SessionStreamBuffer({ capacityBytes: 8 });
    buf.append(Buffer.from("aaaaaa\n")); // 7 bytes
    buf.append(Buffer.from("bbbbb\n")); // 6 more — total 13, oldest=5
    const r = buf.grep({ pattern: ".+", cursor: 0 });
    expect(r.gap).toBe(5);
  });

  it("includes context_before / context_after lines", () => {
    const buf = new SessionStreamBuffer({ capacityBytes: 1024 });
    buf.append(Buffer.from("L0\nL1\nMATCH\nL3\nL4\n"));
    const r = buf.grep({
      pattern: "MATCH",
      contextBefore: 2,
      contextAfter: 2,
    });
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]!.before?.map((b) => b.line)).toEqual(["L0", "L1"]);
    expect(r.matches[0]!.after?.map((a) => a.line)).toEqual(["L3", "L4"]);
  });

  it("throws on an invalid regex pattern", () => {
    const buf = new SessionStreamBuffer({ capacityBytes: 1024 });
    buf.append(Buffer.from("abc\n"));
    expect(() => buf.grep({ pattern: "[" })).toThrow();
  });
});
