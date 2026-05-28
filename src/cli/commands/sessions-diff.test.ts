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
});
