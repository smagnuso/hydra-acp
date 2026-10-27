import { describe, it, expect } from "vitest";
import { aggregateFileEdits, foldForDisplay, foldHunks, foldWholeFileHunks } from "./history-edits.js";

let nextId = 0;
function newId(): string {
  nextId += 1;
  return `tc-${nextId}`;
}

interface Update {
  sessionUpdate: "tool_call" | "tool_call_update";
  toolCallId?: string;
  name?: string;
  rawInput?: unknown;
  content?: unknown;
  rawOutput?: unknown;
}

function entry(update: Update) {
  return {
    method: "session/update",
    params: { update },
    recordedAt: 1,
  };
}

// Claude Edit tool — rawInput.{file_path, old_string, new_string}.
function editCall(
  path: string,
  oldStr: string,
  newStr: string,
  toolCallId: string = newId(),
) {
  return entry({
    sessionUpdate: "tool_call",
    toolCallId,
    name: "Edit",
    rawInput: { file_path: path, old_string: oldStr, new_string: newStr },
  });
}

// Claude Write tool — rawInput.{file_path, content}.
function writeCall(
  path: string,
  content: string,
  toolCallId: string = newId(),
) {
  return entry({
    sessionUpdate: "tool_call",
    toolCallId,
    name: "Write",
    rawInput: { file_path: path, content },
  });
}

// Canonical ACP content[]-with-diff carrier.
function contentDiffCall(
  path: string,
  oldText: string,
  newText: string,
  toolCallId: string = newId(),
) {
  return entry({
    sessionUpdate: "tool_call",
    toolCallId,
    name: "Edit",
    content: [{ type: "diff", path, oldText, newText }],
  });
}

describe("aggregateFileEdits", () => {
  it("returns an empty list when there are no edits", () => {
    expect(aggregateFileEdits([])).toEqual([]);
    expect(
      aggregateFileEdits([
        entry({
          sessionUpdate: "tool_call",
          toolCallId: "tc-bash",
          name: "Bash",
          rawInput: { command: "ls" },
        }),
      ]),
    ).toEqual([]);
  });

  it("extracts a single Edit as one hunk", () => {
    const result = aggregateFileEdits([editCall("/a.ts", "old", "new")]);
    expect(result).toEqual([
      { path: "/a.ts", hunks: [{ oldText: "old", newText: "new", scope: "snippet" }], created: false },
    ]);
  });

  it("treats Write (empty oldText) as created", () => {
    const result = aggregateFileEdits([writeCall("/a.ts", "body")]);
    expect(result).toEqual([
      { path: "/a.ts", hunks: [{ oldText: "", newText: "body", scope: "file" }], created: true },
    ]);
  });

  it("preserves edit order as multiple hunks under one file header", () => {
    const result = aggregateFileEdits([
      editCall("/a.ts", "one", "ONE"),
      editCall("/a.ts", "two", "TWO"),
      editCall("/a.ts", "three", "THREE"),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]!.path).toBe("/a.ts");
    expect(result[0]!.hunks).toEqual([
      { oldText: "one", newText: "ONE", scope: "snippet" },
      { oldText: "two", newText: "TWO", scope: "snippet" },
      { oldText: "three", newText: "THREE", scope: "snippet" },
    ]);
  });

  it("dedupes tool_call_update repeating the same toolCallId payload", () => {
    const id = "tc-shared";
    const result = aggregateFileEdits([
      editCall("/a.ts", "old", "new", id),
      // claude-acp re-emits the same EditDiff on the completion update.
      entry({
        sessionUpdate: "tool_call_update",
        toolCallId: id,
        name: "Edit",
        rawInput: { file_path: "/a.ts", old_string: "old", new_string: "new" },
      }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]!.hunks).toHaveLength(1);
  });

  it("takes a hunk's scope from a later update of the same call", () => {
    const id = "tc-late";
    const block = [{ type: "diff", path: "/a.ts", oldText: "v0\n", newText: "v1\n" }];
    const result = aggregateFileEdits([
      entry({ sessionUpdate: "tool_call", toolCallId: id, content: block }),
      entry({
        sessionUpdate: "tool_call_update",
        toolCallId: id,
        content: block,
        rawOutput: { metadata: { files: [{ filePath: "/a.ts", patch: "@@ -1 +1 @@\n-v0\n+v1\n" }] } },
      }),
    ]);
    expect(result[0]!.hunks).toEqual([{ oldText: "v0\n", newText: "v1\n", scope: "file" }]);
  });

  it("keeps two distinct toolCallIds on the same file as two hunks", () => {
    const result = aggregateFileEdits([
      editCall("/a.ts", "x", "X", "tc-1"),
      editCall("/a.ts", "y", "Y", "tc-2"),
    ]);
    expect(result[0]!.hunks).toHaveLength(2);
  });

  it("expands MultiEdit's edits[] into one hunk per sub-edit", () => {
    const result = aggregateFileEdits([
      entry({
        sessionUpdate: "tool_call",
        toolCallId: "tc-me",
        name: "MultiEdit",
        rawInput: {
          file_path: "/a.ts",
          edits: [
            { old_string: "a", new_string: "A" },
            { old_string: "b", new_string: "B" },
            { old_string: "c", new_string: "C" },
          ],
        },
      }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]!.hunks).toEqual([
      { oldText: "a", newText: "A", scope: "snippet" },
      { oldText: "b", newText: "B", scope: "snippet" },
      { oldText: "c", newText: "C", scope: "snippet" },
    ]);
  });

  it("reads the canonical content[] type:diff carrier", () => {
    const result = aggregateFileEdits([
      contentDiffCall("/a.ts", "before", "after"),
    ]);
    expect(result).toEqual([
      {
        path: "/a.ts",
        hunks: [{ oldText: "before", newText: "after" }],
        created: false,
      },
    ]);
  });

  it("treats a content[] block with null/missing oldText as created", () => {
    const result = aggregateFileEdits([
      entry({
        sessionUpdate: "tool_call",
        toolCallId: "tc-w",
        name: "Write",
        content: [
          { type: "diff", path: "/new.ts", oldText: null, newText: "hi" },
        ],
      }),
    ]);
    expect(result).toEqual([
      {
        path: "/new.ts",
        hunks: [{ oldText: "", newText: "hi" }],
        created: true,
      },
    ]);
  });

  it("groups edits per file when multiple files are touched", () => {
    const result = aggregateFileEdits([
      editCall("/a.ts", "x", "X"),
      editCall("/b.ts", "y", "Y"),
      editCall("/a.ts", "x2", "X2"),
    ]);
    const byPath = new Map(result.map((f) => [f.path, f] as const));
    expect(byPath.get("/a.ts")!.hunks).toHaveLength(2);
    expect(byPath.get("/b.ts")!.hunks).toHaveLength(1);
  });

  it("ignores tool calls that don't carry an edit payload", () => {
    const result = aggregateFileEdits([
      entry({
        sessionUpdate: "tool_call",
        toolCallId: "tc-read",
        name: "Read",
        rawInput: { file_path: "/a.ts" },
      }),
      entry({
        sessionUpdate: "tool_call",
        toolCallId: "tc-grep",
        name: "Grep",
        rawInput: { pattern: "foo" },
      }),
    ]);
    expect(result).toEqual([]);
  });

  it("flags created=true only for the first edit; later edits don't unset it", () => {
    const result = aggregateFileEdits([
      writeCall("/a.ts", "v1"),
      editCall("/a.ts", "v1", "v2"),
    ]);
    expect(result[0]!.created).toBe(true);
    expect(result[0]!.hunks).toHaveLength(2);
  });
});

describe("foldHunks", () => {
  it("returns input unchanged when no hunks chain", () => {
    const hunks = [
      { oldText: "a", newText: "A" },
      { oldText: "b", newText: "B" },
    ];
    expect(foldHunks(hunks)).toEqual(hunks);
  });

  it("composes a two-hunk chain into one net-effect hunk", () => {
    expect(
      foldHunks([
        { oldText: "A", newText: "B" },
        { oldText: "B", newText: "C" },
      ]),
    ).toEqual([{ oldText: "A", newText: "C" }]);
  });

  it("composes a three-hunk chain", () => {
    expect(
      foldHunks([
        { oldText: "A", newText: "B" },
        { oldText: "B", newText: "C" },
        { oldText: "C", newText: "D" },
      ]),
    ).toEqual([{ oldText: "A", newText: "D" }]);
  });

  it("preserves unrelated hunks alongside a folded chain", () => {
    expect(
      foldHunks([
        { oldText: "A", newText: "B" },
        { oldText: "x", newText: "X" },
        { oldText: "B", newText: "C" },
      ]),
    ).toEqual([
      { oldText: "A", newText: "C" },
      { oldText: "x", newText: "X" },
    ]);
  });

  it("treats a Write-then-Edit (created file) as foldable to a single create", () => {
    expect(
      foldHunks([
        { oldText: "", newText: "v1" },
        { oldText: "v1", newText: "v2" },
      ]),
    ).toEqual([{ oldText: "", newText: "v2" }]);
  });

  it("folds against the most recent matching newText when two earlier hunks tie", () => {
    expect(
      foldHunks([
        { oldText: "A1", newText: "X" },
        { oldText: "A2", newText: "X" },
        { oldText: "X", newText: "Y" },
      ]),
    ).toEqual([
      { oldText: "A1", newText: "X" },
      { oldText: "A2", newText: "Y" },
    ]);
  });

  it("returns [] for an empty list", () => {
    expect(foldHunks([])).toEqual([]);
  });

  it("reads a patch tool's per-file diffs, as opencode's apply_patch records them", () => {
    const files = aggregateFileEdits([
      {
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: newId(),
            rawOutput: {
              metadata: {
                files: [
                  { filePath: "/r/a.cpp", patch: "@@ -1 +1 @@\n-old\n+new\n" },
                  { filePath: "/r/new.js", patch: "@@ -0,0 +1 @@\n+fresh\n" },
                ],
              },
            },
          },
        },
        recordedAt: 1,
      },
    ]);
    expect(files).toEqual([
      { path: "/r/a.cpp", hunks: [{ oldText: "old\n", newText: "new\n", scope: "snippet" }], created: false },
      { path: "/r/new.js", hunks: [{ oldText: "", newText: "fresh\n", scope: "snippet" }], created: true },
    ]);
  });
});


describe("foldWholeFileHunks", () => {
  it("composes whole-file hunks into the first before and last after", () => {
    expect(
      foldWholeFileHunks([
        { oldText: "a\n", newText: "b\n", scope: "file" },
        { oldText: "b\n", newText: "c\n", scope: "file" },
        { oldText: "x", newText: "y", scope: "snippet" },
        { oldText: "a\n", newText: "d\n", scope: "file" },
      ]),
    ).toEqual([
      { oldText: "a\n", newText: "d\n", scope: "file" },
      { oldText: "x", newText: "y", scope: "snippet" },
    ]);
  });

  it("leaves snippet and untagged hunks alone", () => {
    const hunks = [
      { oldText: "a", newText: "b", scope: "snippet" as const },
      { oldText: "b", newText: "c" },
    ];
    expect(foldWholeFileHunks(hunks)).toEqual(hunks);
  });

  it("keeps every step with steps: true", () => {
    const files = [
      {
        path: "/a",
        created: false,
        hunks: [
          { oldText: "a\n", newText: "b\n", scope: "file" as const },
          { oldText: "b\n", newText: "c\n", scope: "file" as const },
        ],
      },
    ];
    expect(foldForDisplay(files, { steps: true })[0]!.hunks).toHaveLength(2);
    expect(foldForDisplay(files, {})[0]!.hunks).toHaveLength(1);
  });
});
