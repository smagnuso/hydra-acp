import { describe, it, expect } from "vitest";
import {
  extractPermissionDetail,
  formatPermissionDetailLine,
} from "./permission-pick.js";

describe("extractPermissionDetail", () => {
  it("returns empty detail when toolCall is missing", () => {
    expect(extractPermissionDetail({})).toEqual({ paths: [] });
    expect(extractPermissionDetail(undefined)).toEqual({ paths: [] });
  });

  it("pulls kind + path from an edit toolCall", () => {
    const d = extractPermissionDetail({
      toolCall: {
        kind: "edit",
        rawInput: { file_path: "/repo/src/a.ts" },
        locations: [{ path: "/repo/src/a.ts" }],
      },
    });
    expect(d.kind).toBe("edit");
    expect(d.paths).toEqual(["/repo/src/a.ts"]);
  });

  it("de-dupes paths across locations and rawInput", () => {
    const d = extractPermissionDetail({
      toolCall: {
        locations: [{ path: "/a" }, { path: "/b" }],
        rawInput: { file_path: "/a", path: "/c" },
      },
    });
    expect(d.paths).toEqual(["/a", "/b", "/c"]);
  });

  it("pulls command / url / description", () => {
    const d = extractPermissionDetail({
      toolCall: {
        kind: "execute",
        rawInput: { command: "git status", description: "check" },
      },
    });
    expect(d.command).toBe("git status");
    expect(d.description).toBe("check");

    const f = extractPermissionDetail({
      toolCall: { kind: "fetch", rawInput: { url: "https://x.test" } },
    });
    expect(f.url).toBe("https://x.test");
  });
});

describe("formatPermissionDetailLine", () => {
  it("prefers command, then url, then single path", () => {
    expect(
      formatPermissionDetailLine({ paths: ["/p"], command: "ls" }),
    ).toBe("$ ls");
    expect(formatPermissionDetailLine({ paths: ["/p"], url: "u" })).toBe("u");
    expect(formatPermissionDetailLine({ paths: ["/only"] })).toBe("/only");
  });

  it("summarizes multiple paths", () => {
    expect(formatPermissionDetailLine({ paths: ["/a", "/b", "/c"] })).toBe(
      "/a (+2 more)",
    );
  });

  it("falls back to description, then empty", () => {
    expect(formatPermissionDetailLine({ paths: [], description: "d" })).toBe(
      "d",
    );
    expect(formatPermissionDetailLine({ paths: [] })).toBe("");
  });
});
