import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HISTORY_CAP,
  appendEntry,
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
