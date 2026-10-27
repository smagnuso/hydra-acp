import { describe, expect, it } from "vitest";
import { editTexts, editedFilePaths, extractFileEdits } from "./file-edits.js";

// opencode's apply_patch: the completed update carries one unified diff per file.
const PATCH = "@@ -1,2 +1,2 @@\n keep\n-old\n+new\n";
const patchUpdate = {
  sessionUpdate: "tool_call_update",
  toolCallId: "p1",
  kind: "edit",
  rawOutput: {
    metadata: {
      files: [
        { filePath: "/r/a.cpp", patch: PATCH, additions: 1, deletions: 1 },
        { filePath: "/r/b.js", patch: { __hydraBlob: "abc", bytes: 9000 } },
      ],
    },
  },
};

// The same tool in a later opencode: worktree-relative `file` plus `status`, and counts per file.
const newerPatchUpdate = {
  sessionUpdate: "tool_call_update",
  toolCallId: "p2",
  kind: "edit",
  rawOutput: {
    metadata: {
      files: [
        { file: "src/a.cpp", patch: PATCH, status: "modified", additions: 1, deletions: 1 },
        { file: "src/new.js", patch: "@@ -0,0 +1 @@\n+fresh\n", status: "added", additions: 1, deletions: 0 },
      ],
    },
  },
};

describe("extractFileEdits", () => {
  it("reads opencode's worktree-relative `file` entries", () => {
    expect(extractFileEdits(newerPatchUpdate).map((edit) => edit.path)).toEqual(["src/a.cpp", "src/new.js"]);
    expect(editedFilePaths(newerPatchUpdate)).toEqual(["src/a.cpp", "src/new.js"]);
  });

  it("reads a patch tool's files, unfolding an inline patch into its texts", () => {
    const edits = extractFileEdits(patchUpdate);
    expect(edits.map((edit) => edit.path)).toEqual(["/r/a.cpp", "/r/b.js"]);
    expect(editTexts(edits[0]!)).toEqual({ oldText: "keep\nold\n", newText: "keep\nnew\n" });
    expect(edits[1]!.patch).toEqual({ ref: { hash: "abc", bytes: 9000 } });
    expect(editTexts(edits[1]!)).toEqual({ oldText: "", newText: "" });
  });

  it("prefers MultiEdit, then diff blocks, then a single Edit or Write", () => {
    expect(
      extractFileEdits({ rawInput: { file_path: "/m", edits: [{ old_string: "a", new_string: "b" }] } }),
    ).toEqual([{ path: "/m", old: { text: "a" }, new: { text: "b" }, scope: "snippet" }]);
    expect(
      extractFileEdits({
        content: [{ type: "diff", path: "/d", oldText: "a", newText: "b" }],
        rawInput: { file_path: "/e", old_string: "x", new_string: "y" },
      }).map((edit) => edit.path),
    ).toEqual(["/d"]);
    expect(extractFileEdits({ rawInput: { path: "/w", content: "hi" } })).toEqual([
      { path: "/w", old: { text: "" }, new: { text: "hi" }, scope: "file" },
    ]);
  });

  it("tells a diff block's scope from the rest of the update", () => {
    const block = { type: "diff", path: "/d", oldText: "a\nb\n", newText: "a\nc\n" };
    const scopeOf = (update: Record<string, unknown>) => extractFileEdits(update)[0]?.scope;
    expect(scopeOf({ content: [block] })).toBeUndefined();
    expect(scopeOf({ content: [block], rawInput: { file_path: "/d", old_string: "b", new_string: "c" } })).toBe("snippet");
    expect(scopeOf({ content: [block], rawInput: { file_path: "/d", content: "a\nc\n" } })).toBe("file");
    expect(scopeOf({ content: [block], rawOutput: { metadata: { files: [{ filePath: "/d", patch: "@@ -1 +1 @@\n-b\n+c\n" }] } } })).toBe("file");
  });

  it("finds nothing in a tool call that edits no file", () => {
    expect(extractFileEdits({ rawInput: { command: "ls" } })).toEqual([]);
  });
});

describe("editedFilePaths", () => {
  it("collects paths from every carrier, whether bodies are inline or blob refs", () => {
    expect(editedFilePaths(patchUpdate)).toEqual(["/r/a.cpp", "/r/b.js"]);
    expect(
      editedFilePaths({ rawInput: { file_path: "/big", content: { __hydraBlob: "h", bytes: 5000 } } }),
    ).toEqual(["/big"]);
  });
});
