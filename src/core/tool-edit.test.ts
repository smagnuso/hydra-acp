import { describe, expect, it } from "vitest";
import {
  FILE_EDITED_EVENT_KIND,
  FILE_MUTATING_KINDS,
  ToolKindTracker,
  firstLocationPath,
  isFileMutatingKind,
  locationPaths,
} from "./tool-edit.js";

describe("isFileMutatingKind", () => {
  it("accepts the kinds that change a file", () => {
    for (const kind of ["edit", "delete", "move"]) {
      expect(isFileMutatingKind(kind)).toBe(true);
    }
  });

  // The bug this vocabulary exists to prevent: locations[] is populated by
  // read/search/execute too, so kind is the only reliable discriminator.
  it("rejects the kinds that only observe", () => {
    for (const kind of ["execute", "read", "search", "think", "fetch", "other"]) {
      expect(isFileMutatingKind(kind)).toBe(false);
    }
  });

  it("rejects an absent or unknown kind", () => {
    expect(isFileMutatingKind(undefined)).toBe(false);
    expect(isFileMutatingKind("")).toBe(false);
    expect(isFileMutatingKind("EDIT")).toBe(false);
  });

  // PROTOCOL.md pins file.edited to kind: "edit" exactly, so the narrow
  // constant must stay a strict subset of the broad set — if someone
  // "fixes" the event to use FILE_MUTATING_KINDS, that's a wire change.
  it("keeps the file.edited kind inside the mutating set", () => {
    expect(FILE_MUTATING_KINDS.has(FILE_EDITED_EVENT_KIND)).toBe(true);
    expect(FILE_EDITED_EVENT_KIND).toBe("edit");
  });
});

describe("ToolKindTracker", () => {
  // The kind arrives on the initial tool_call; later updates that carry the
  // path usually omit it.
  it("remembers a kind across updates that omit it", () => {
    const t = new ToolKindTracker();
    t.note("t1", "edit");
    expect(t.effective("t1", undefined)).toBe("edit");
    expect(t.get("t1")).toBe("edit");
  });

  it("prefers the kind on the current update when present", () => {
    const t = new ToolKindTracker();
    t.note("t1", "edit");
    expect(t.effective("t1", "execute")).toBe("execute");
  });

  it("first non-empty kind wins, so a later update can't downgrade it", () => {
    const t = new ToolKindTracker();
    t.note("t1", "edit");
    t.note("t1", "execute");
    expect(t.get("t1")).toBe("edit");
  });

  it("ignores absent and empty kinds", () => {
    const t = new ToolKindTracker();
    t.note("t1", undefined);
    t.note("t1", "");
    expect(t.get("t1")).toBeUndefined();
    expect(t.size).toBe(0);
    // A real kind arriving later still registers.
    t.note("t1", "edit");
    expect(t.get("t1")).toBe("edit");
  });

  it("keeps calls independent", () => {
    const t = new ToolKindTracker();
    t.note("t1", "edit");
    t.note("t2", "execute");
    expect(t.effective("t1", undefined)).toBe("edit");
    expect(t.effective("t2", undefined)).toBe("execute");
    expect(t.effective("t3", undefined)).toBeUndefined();
  });

  it("clears", () => {
    const t = new ToolKindTracker();
    t.note("t1", "edit");
    t.clear();
    expect(t.size).toBe(0);
    expect(t.get("t1")).toBeUndefined();
  });
});

describe("locationPaths", () => {
  it("pulls paths in order", () => {
    expect(
      locationPaths([{ path: "/a.ts" }, { path: "/b.ts", line: 4 }]),
    ).toEqual(["/a.ts", "/b.ts"]);
  });

  it("does not deduplicate — callers dedupe in their own scope", () => {
    expect(locationPaths([{ path: "/a.ts" }, { path: "/a.ts" }])).toEqual([
      "/a.ts",
      "/a.ts",
    ]);
  });

  it("tolerates any shape, since this is unvalidated wire data", () => {
    expect(locationPaths(undefined)).toEqual([]);
    expect(locationPaths(null)).toEqual([]);
    expect(locationPaths("nope")).toEqual([]);
    expect(locationPaths({})).toEqual([]);
    expect(locationPaths([])).toEqual([]);
    expect(
      locationPaths([null, 42, "str", {}, { path: 7 }, { path: "" }, { path: "/ok" }]),
    ).toEqual(["/ok"]);
  });

  it("firstLocationPath takes the first usable entry", () => {
    expect(firstLocationPath([{ path: "" }, { path: "/b.ts" }])).toBe("/b.ts");
    expect(firstLocationPath([])).toBeUndefined();
    expect(firstLocationPath(undefined)).toBeUndefined();
  });
});
