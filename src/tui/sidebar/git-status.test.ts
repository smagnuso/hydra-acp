import { describe, expect, it } from "vitest";
import { parseGitPorcelainV2 } from "./git-status.js";

// Real `git status --porcelain=v2 --branch` output shapes.
const HEADER = [
  "# branch.oid 1111111111111111111111111111111111111111",
  "# branch.head main",
  "# branch.upstream origin/main",
  "# branch.ab +2 -1",
].join("\n");

const ordinary = (xy: string, path: string): string =>
  `1 ${xy} N... 100644 100644 100644 aaaaaaa bbbbbbb ${path}`;

describe("parseGitPorcelainV2", () => {
  it("reads the branch and ahead/behind counts", () => {
    const s = parseGitPorcelainV2(HEADER, "/repo");
    expect(s.branch).toBe("main");
    expect(s.ahead).toBe(2);
    expect(s.behind).toBe(1);
  });

  it("reports a detached HEAD as no branch", () => {
    const s = parseGitPorcelainV2("# branch.head (detached)", "/repo");
    expect(s.branch).toBeNull();
  });

  it("omits ahead/behind for a branch with no upstream", () => {
    const s = parseGitPorcelainV2("# branch.head topic", "/repo");
    expect(s.ahead).toBe(0);
    expect(s.behind).toBe(0);
  });

  it("counts staged, unstaged and untracked separately", () => {
    const out = [
      HEADER,
      ordinary("M.", "staged.ts"),
      ordinary(".M", "dirty.ts"),
      "? new.ts",
    ].join("\n");
    const s = parseGitPorcelainV2(out, "/repo");
    expect(s.staged).toBe(1);
    expect(s.unstaged).toBe(1);
    expect(s.untracked).toBe(1);
  });

  it("counts a staged-and-dirty file in both columns but reports it dirty", () => {
    const s = parseGitPorcelainV2(ordinary("MM", "both.ts"), "/repo");
    expect(s.staged).toBe(1);
    expect(s.unstaged).toBe(1);
    expect(s.files).toEqual([{ path: "/repo/both.ts", state: "dirty" }]);
  });

  it("resolves paths against the repo toplevel, not the cwd", () => {
    const s = parseGitPorcelainV2(ordinary(".M", "src/deep/a.ts"), "/repo");
    expect(s.files[0]!.path).toBe("/repo/src/deep/a.ts");
  });

  // The bug this module exists to prevent: splitting on whitespace and
  // taking the last field truncates any path containing a space.
  it("keeps paths that contain spaces intact", () => {
    const s = parseGitPorcelainV2(
      [ordinary(".M", "src/my file.ts"), "? another new file.txt"].join("\n"),
      "/repo",
    );
    expect(s.files.map((f) => f.path)).toEqual([
      "/repo/src/my file.ts",
      "/repo/another new file.txt",
    ]);
  });

  it("takes the new name from a rename record, not the original", () => {
    const s = parseGitPorcelainV2(
      "2 R. N... 100644 100644 100644 aaaaaaa bbbbbbb R100 new/name.ts\told/name.ts",
      "/repo",
    );
    expect(s.files).toEqual([{ path: "/repo/new/name.ts", state: "staged" }]);
  });

  it("handles a renamed path containing spaces", () => {
    const s = parseGitPorcelainV2(
      "2 R. N... 100644 100644 100644 aaaaaaa bbbbbbb R100 new/my file.ts\told/my file.ts",
      "/repo",
    );
    expect(s.files[0]!.path).toBe("/repo/new/my file.ts");
  });

  it("parses unmerged records, which carry three extra fields", () => {
    const s = parseGitPorcelainV2(
      "u UU N... 100644 100644 100644 100644 aaaaaaa bbbbbbb ccccccc conflict.ts",
      "/repo",
    );
    expect(s.files).toEqual([{ path: "/repo/conflict.ts", state: "dirty" }]);
    expect(s.staged).toBe(1);
    expect(s.unstaged).toBe(1);
  });

  it("produces counts but no clickable rows when the toplevel is unknown", () => {
    const s = parseGitPorcelainV2(
      [ordinary(".M", "a.ts"), "? b.ts"].join("\n"),
      null,
    );
    expect(s.unstaged).toBe(1);
    expect(s.untracked).toBe(1);
    expect(s.files).toEqual([]);
  });

  it("returns an all-zero status for a clean repo", () => {
    const s = parseGitPorcelainV2(HEADER, "/repo");
    expect(s.staged).toBe(0);
    expect(s.unstaged).toBe(0);
    expect(s.untracked).toBe(0);
    expect(s.files).toEqual([]);
  });

  it("ignores empty input and unknown record types", () => {
    expect(parseGitPorcelainV2("", "/repo").files).toEqual([]);
    // "!" is an ignored-file record (only emitted with --ignored).
    const s = parseGitPorcelainV2("! ignored.ts\n\n", "/repo");
    expect(s.files).toEqual([]);
    expect(s.untracked).toBe(0);
  });

  it("skips malformed records rather than inventing a file", () => {
    const s = parseGitPorcelainV2("1 .M truncated", "/repo");
    expect(s.files).toEqual([]);
  });
});
