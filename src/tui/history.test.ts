import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GLOBAL_HISTORY_CAP,
  HISTORY_CAP,
  appendEntry,
  appendHistoryLine,
  buildCombinedHistory,
  loadHistory,
  parseHistory,
  saveHistory,
} from "./history.js";

describe("appendEntry", () => {
  it("trims trailing newlines and appends", () => {
    expect(appendEntry([], "hello\n")).toEqual(["hello"]);
    expect(appendEntry([], "multi\nline\n\n")).toEqual(["multi\nline"]);
  });

  it("ignores empty entries", () => {
    expect(appendEntry(["a"], "")).toEqual(["a"]);
    expect(appendEntry(["a"], "\n\n")).toEqual(["a"]);
  });

  it("de-dupes consecutive identical entries", () => {
    expect(appendEntry(["a", "b"], "b")).toEqual(["a", "b"]);
  });

  it("does not de-dupe non-consecutive duplicates", () => {
    expect(appendEntry(["a", "b"], "a")).toEqual(["a", "b", "a"]);
  });

  it("enforces the cap", () => {
    const big = Array.from({ length: HISTORY_CAP }, (_, i) => `e${i}`);
    const out = appendEntry(big, "new");
    expect(out.length).toBe(HISTORY_CAP);
    expect(out[out.length - 1]).toBe("new");
    expect(out[0]).toBe("e1");
  });

  it("honors a custom cap (global tier)", () => {
    const big = Array.from(
      { length: GLOBAL_HISTORY_CAP },
      (_, i) => `g${i}`,
    );
    const out = appendEntry(big, "new", GLOBAL_HISTORY_CAP);
    expect(out.length).toBe(GLOBAL_HISTORY_CAP);
    expect(out[out.length - 1]).toBe("new");
    expect(out[0]).toBe("g1");
  });

  it("returns the same array reference on dedupe (so callers can skip writes)", () => {
    const start = ["a", "b"];
    expect(appendEntry(start, "b")).toBe(start);
    expect(appendEntry(start, "")).toBe(start);
  });
});

describe("buildCombinedHistory", () => {
  it("keeps newest-at-end ordering with global entries first", () => {
    const combined = buildCombinedHistory(["g1", "g2"], ["s1", "s2"]);
    expect(combined).toEqual(["g1", "g2", "s1", "s2"]);
  });

  it("hides global entries that also appear in the session list", () => {
    const combined = buildCombinedHistory(
      ["old", "dup", "older"],
      ["dup", "new"],
    );
    expect(combined).toEqual(["old", "older", "dup", "new"]);
  });

  it("handles an empty session list", () => {
    expect(buildCombinedHistory(["g1", "g2"], [])).toEqual(["g1", "g2"]);
  });

  it("handles an empty global list", () => {
    expect(buildCombinedHistory([], ["s1"])).toEqual(["s1"]);
  });
});

describe("parseHistory", () => {
  it("decodes JSON-encoded lines", () => {
    const text = `${JSON.stringify("a")}\n${JSON.stringify("b\nc")}\n`;
    expect(parseHistory(text)).toEqual(["a", "b\nc"]);
  });

  it("tolerates corrupted lines", () => {
    const text = `${JSON.stringify("a")}\nnotjson\n${JSON.stringify("c")}\n`;
    expect(parseHistory(text)).toEqual(["a", "c"]);
  });

  it("ignores empty lines", () => {
    expect(parseHistory("\n\n")).toEqual([]);
  });
});

describe("save + load round-trip", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tui-history-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns [] when file missing", async () => {
    expect(await loadHistory(path.join(tmpDir, "missing"))).toEqual([]);
  });

  it("round-trips multi-line entries", async () => {
    const file = path.join(tmpDir, "h");
    const entries = ["one", "two\nthree", "four"];
    await saveHistory(file, entries);
    expect(await loadHistory(file)).toEqual(entries);
  });

  it("creates parent directory on save", async () => {
    const file = path.join(tmpDir, "nested", "deeper", "h");
    await saveHistory(file, ["x"]);
    expect(await loadHistory(file)).toEqual(["x"]);
  });
});

describe("appendHistoryLine", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tui-history-append-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("appends one JSON-encoded line per call", async () => {
    const file = path.join(tmpDir, "g");
    await appendHistoryLine(file, "one");
    await appendHistoryLine(file, "two\nthree");
    expect(await loadHistory(file)).toEqual(["one", "two\nthree"]);
  });

  it("creates parent directories as needed", async () => {
    const file = path.join(tmpDir, "a", "b", "g");
    await appendHistoryLine(file, "hello");
    expect(await loadHistory(file)).toEqual(["hello"]);
  });

  it("skips empty entries", async () => {
    const file = path.join(tmpDir, "g");
    await appendHistoryLine(file, "");
    await appendHistoryLine(file, "\n\n");
    await fs.writeFile(file, "", { flag: "a" });
    expect(await loadHistory(file)).toEqual([]);
  });

  it("survives concurrent appends without losing entries", async () => {
    const file = path.join(tmpDir, "g");
    const entries = Array.from({ length: 20 }, (_, i) => `entry-${i}`);
    await Promise.all(entries.map((e) => appendHistoryLine(file, e)));
    const loaded = await loadHistory(file);
    expect(loaded.sort()).toEqual(entries.sort());
  });
});
