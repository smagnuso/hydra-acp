import { describe, it, expect } from "vitest";
import {
  buildWorkspacePreamble,
  isSourceTreeBreach,
  mentionsSourceTree,
  rewriteSourcePaths,
} from "./path-identity.js";

const SRC = "/home/u/proj";
const WS = "/home/u/.hydra-acp/workspaces/ab12/feature";

describe("rewriteSourcePaths", () => {
  it("rewrites a path into the source tree", () => {
    const r = rewriteSourcePaths(`look at ${SRC}/src/foo.cpp please`, SRC, WS);
    expect(r.text).toBe(`look at ${WS}/src/foo.cpp please`);
    expect(r.rewritten).toEqual([`${SRC}/src/foo.cpp`]);
  });

  it("rewrites every occurrence", () => {
    const r = rewriteSourcePaths(`diff ${SRC}/a.ts against ${SRC}/b.ts`, SRC, WS);
    expect(r.text).toBe(`diff ${WS}/a.ts against ${WS}/b.ts`);
    expect(r.rewritten).toHaveLength(2);
  });

  it("leaves a bare mention of the tree alone", () => {
    // "the repo at /home/u/proj" is prose about the project, not a file
    // reference; rewriting it would produce a sentence naming a
    // directory the user has never heard of.
    const r = rewriteSourcePaths(`the repo at ${SRC} is large`, SRC, WS);
    expect(r.text).toBe(`the repo at ${SRC} is large`);
    expect(r.rewritten).toEqual([]);
  });

  it("does not match a sibling directory sharing the prefix", () => {
    const r = rewriteSourcePaths("/home/u/project-notes/todo.md", SRC, WS);
    expect(r.text).toBe("/home/u/project-notes/todo.md");
    expect(r.rewritten).toEqual([]);
  });

  it("handles regex metacharacters in the source path", () => {
    const weird = "/home/u/my+proj (v2)";
    const r = rewriteSourcePaths(`${weird}/a.ts`, weird, WS);
    expect(r.text).toBe(`${WS}/a.ts`);
  });

  it("tolerates a trailing separator on either root", () => {
    const r = rewriteSourcePaths(`${SRC}/a.ts`, `${SRC}/`, `${WS}/`);
    expect(r.text).toBe(`${WS}/a.ts`);
  });

  it("is a no-op when there is no workspace to point at", () => {
    const r = rewriteSourcePaths(`${SRC}/a.ts`, SRC, SRC);
    expect(r.text).toBe(`${SRC}/a.ts`);
    expect(r.rewritten).toEqual([]);
  });

  it("reports the whole path token, stopping at punctuation", () => {
    const r = rewriteSourcePaths(`open "${SRC}/src/a.ts", then stop`, SRC, WS);
    expect(r.rewritten).toEqual([`${SRC}/src/a.ts`]);
  });
});

describe("mentionsSourceTree", () => {
  it("gates cheaply on the root appearing at all", () => {
    expect(mentionsSourceTree(`see ${SRC}/x`, SRC)).toBe(true);
    expect(mentionsSourceTree("see src/x", SRC)).toBe(false);
    expect(mentionsSourceTree("anything", "")).toBe(false);
  });
});

describe("buildWorkspacePreamble", () => {
  it("states both directories and the mapping rule", () => {
    const text = buildWorkspacePreamble({ workspacePath: WS, sourceCwd: SRC, notes: [] });
    expect(text).toContain(WS);
    expect(text).toContain(SRC);
    expect(text).toMatch(/repo-relative/i);
  });

  it("includes provider notes verbatim", () => {
    const text = buildWorkspacePreamble({
      workspacePath: WS,
      sourceCwd: SRC,
      notes: ["Submodules are NOT initialized in a new worktree."],
    });
    expect(text).toContain("Submodules are NOT initialized");
  });

  it("reads as a reminder when re-asserting", () => {
    // A one-time note is exactly what compaction drops, so the
    // re-assertion has to stand on its own rather than read like a
    // duplicate introduction.
    const text = buildWorkspacePreamble({
      workspacePath: WS,
      sourceCwd: SRC,
      notes: [],
      reassert: true,
    });
    expect(text).toMatch(/reminder/i);
  });
});

describe("isSourceTreeBreach", () => {
  it("flags a write into the source tree", () => {
    expect(isSourceTreeBreach(`${SRC}/src/a.ts`, SRC, WS)).toBe(true);
  });

  it("does not flag a write into the workspace", () => {
    expect(isSourceTreeBreach(`${WS}/src/a.ts`, SRC, WS)).toBe(false);
  });

  it("does not flag an unrelated absolute path", () => {
    expect(isSourceTreeBreach("/tmp/scratch.txt", SRC, WS)).toBe(false);
  });

  it("ignores relative paths, which resolve against the workspace anyway", () => {
    expect(isSourceTreeBreach("src/a.ts", SRC, WS)).toBe(false);
  });

  it("prefers the workspace when it is nested inside the source tree", () => {
    // With an inside-the-repo layout every workspace write also starts
    // with the source prefix; treating those as breaches would make the
    // signal useless.
    const nested = `${SRC}/.hydra/workspaces/x`;
    expect(isSourceTreeBreach(`${nested}/a.ts`, SRC, nested)).toBe(false);
    expect(isSourceTreeBreach(`${SRC}/a.ts`, SRC, nested)).toBe(true);
  });
});
