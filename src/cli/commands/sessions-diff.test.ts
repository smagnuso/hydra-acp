import { describe, it, expect } from "vitest";
import { renderDiff } from "./sessions-diff.js";
import type { FileEditAggregate } from "../../core/history-edits.js";

describe("renderDiff", () => {
  it("emits a placeholder when nothing was edited", () => {
    expect(renderDiff([], false)).toBe("No file edits found in this session.\n");
  });

  it("emits a single-hunk diff for one Edit", () => {
    const files: FileEditAggregate[] = [
      {
        path: "/a.ts",
        created: false,
        hunks: [{ oldText: "old line\n", newText: "new line\n" }],
      },
    ];
    const out = renderDiff(files, false);
    expect(out).toContain("diff --hydra a//a.ts b//a.ts");
    expect(out).toContain("--- a//a.ts");
    expect(out).toContain("+++ b//a.ts");
    expect(out).toContain("@@ -1,1 +1,1 @@");
    expect(out).toContain("- old line");
    expect(out).toContain("+ new line");
  });

  it("emits a new-file header and a -0,0 start for created files", () => {
    const files: FileEditAggregate[] = [
      {
        path: "/new.ts",
        created: true,
        hunks: [{ oldText: "", newText: "hello\nworld\n" }],
      },
    ];
    const out = renderDiff(files, false);
    expect(out).toContain("new file");
    expect(out).toContain("--- /dev/null");
    expect(out).toContain("+++ b//new.ts");
    expect(out).toContain("@@ -0,0 +1,2 @@");
    expect(out).toContain("+ hello");
    expect(out).toContain("+ world");
  });

  it("reports real line counts and tags edit N of M as a marker tail", () => {
    const files: FileEditAggregate[] = [
      {
        path: "/a.ts",
        created: false,
        hunks: [
          { oldText: "x\ny\n", newText: "X\nY\nZ\n" },
          { oldText: "p", newText: "P\nQ" },
        ],
      },
    ];
    const out = renderDiff(files, false);
    expect(out).toContain("@@ -1,2 +1,3 @@ edit 1 of 2");
    expect(out).toContain("@@ -1,1 +1,2 @@ edit 2 of 2");
  });

  it("sorts file blocks by path so output is deterministic", () => {
    const files: FileEditAggregate[] = [
      { path: "/z.ts", created: false, hunks: [{ oldText: "a", newText: "A" }] },
      { path: "/a.ts", created: false, hunks: [{ oldText: "b", newText: "B" }] },
    ];
    const out = renderDiff(files, false);
    const aIdx = out.indexOf("/a.ts");
    const zIdx = out.indexOf("/z.ts");
    expect(aIdx).toBeGreaterThanOrEqual(0);
    expect(zIdx).toBeGreaterThan(aIdx);
  });

  it("drops hunks whose old/new texts are identical (no visible change)", () => {
    const files: FileEditAggregate[] = [
      {
        path: "/a.ts",
        created: false,
        hunks: [
          { oldText: "real-old", newText: "real-new" },
          { oldText: "same-line", newText: "same-line" },
        ],
      },
    ];
    const out = renderDiff(files, false);
    // The real edit survives; the no-op doesn't, so we end up with one
    // hunk total and no "edit N of M" tail.
    expect(out).toContain("@@ -1,1 +1,1 @@\n");
    expect(out).not.toContain("edit 1 of 2");
    expect(out).not.toContain("edit 2 of 2");
    expect(out).toContain("- real-old");
    expect(out).toContain("+ real-new");
    expect(out).not.toContain("same-line");
  });

  it("drops hunks differing only by a trailing newline", () => {
    const files: FileEditAggregate[] = [
      {
        path: "/a.ts",
        created: false,
        hunks: [{ oldText: "foo\nbar\n", newText: "foo\nbar" }],
      },
    ];
    expect(renderDiff(files, false)).toBe(
      "No file edits found in this session.\n",
    );
  });

  it("drops a file entirely when every hunk is a no-op", () => {
    const files: FileEditAggregate[] = [
      {
        path: "/noop.ts",
        created: false,
        hunks: [
          { oldText: "x", newText: "x" },
          { oldText: "y", newText: "y" },
        ],
      },
      {
        path: "/real.ts",
        created: false,
        hunks: [{ oldText: "a", newText: "A" }],
      },
    ];
    const out = renderDiff(files, false);
    expect(out).not.toContain("/noop.ts");
    expect(out).toContain("/real.ts");
  });

  it("renumbers surviving hunks so edit N of M reflects the visible count", () => {
    const files: FileEditAggregate[] = [
      {
        path: "/a.ts",
        created: false,
        hunks: [
          { oldText: "a", newText: "A" },
          { oldText: "noop", newText: "noop" },
          { oldText: "b", newText: "B" },
          { oldText: "c", newText: "C" },
        ],
      },
    ];
    const out = renderDiff(files, false);
    expect(out).toContain("edit 1 of 3");
    expect(out).toContain("edit 2 of 3");
    expect(out).toContain("edit 3 of 3");
    expect(out).not.toContain("of 4");
  });
});
