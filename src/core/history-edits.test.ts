import { describe, it, expect } from "vitest";
import { aggregateFileEdits } from "./history-edits.js";

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
      { path: "/a.ts", hunks: [{ oldText: "old", newText: "new" }], created: false },
    ]);
  });

  it("treats Write (empty oldText) as created", () => {
    const result = aggregateFileEdits([writeCall("/a.ts", "body")]);
    expect(result).toEqual([
      { path: "/a.ts", hunks: [{ oldText: "", newText: "body" }], created: true },
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
      { oldText: "one", newText: "ONE" },
      { oldText: "two", newText: "TWO" },
      { oldText: "three", newText: "THREE" },
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
      { oldText: "a", newText: "A" },
      { oldText: "b", newText: "B" },
      { oldText: "c", newText: "C" },
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
