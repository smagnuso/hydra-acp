import { describe, it, expect } from "vitest";
import {
  countTurns,
  extractFilesTouched,
  extractFilesTouchedDetailed,
  extractToolHistogram,
  extractToolsUsed,
} from "./history-aggregate.js";

function toolCall(
  name: string,
  rawInput: Record<string, unknown> = {},
  opts: {
    locations?: Array<{ path: string }>;
    nameField?: "name" | "title";
  } = {},
) {
  const field = opts.nameField ?? "title";
  return {
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "tool_call",
        toolCallId: `tc-${Math.random().toString(36).slice(2, 8)}`,
        [field]: name,
        rawInput,
        ...(opts.locations ? { locations: opts.locations } : {}),
      },
    },
    recordedAt: 1,
  };
}

function promptReceived() {
  return {
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "prompt_received",
        prompt: [{ type: "text", text: "hi" }],
      },
    },
    recordedAt: 1,
  };
}

describe("countTurns", () => {
  it("counts prompt_received entries only", () => {
    expect(
      countTurns([
        promptReceived(),
        toolCall("Read"),
        promptReceived(),
        toolCall("Edit"),
      ]),
    ).toBe(2);
  });

  it("returns 0 for empty history", () => {
    expect(countTurns([])).toBe(0);
  });

  it("ignores non-update entries and other sessionUpdate kinds", () => {
    expect(
      countTurns([
        promptReceived(),
        {
          method: "session/update",
          params: { update: { sessionUpdate: "agent_message_chunk" } },
          recordedAt: 1,
        },
        {
          method: "session/update",
          params: { update: { sessionUpdate: "tool_call_update" } },
          recordedAt: 1,
        },
      ]),
    ).toBe(1);
  });
});

describe("extractToolHistogram", () => {
  it("counts tool_call entries by name, sorted desc then alphabetical", () => {
    expect(
      extractToolHistogram([
        toolCall("Edit"),
        toolCall("Edit"),
        toolCall("Edit"),
        toolCall("Read"),
        toolCall("Read"),
        toolCall("Bash"),
        toolCall("Bash"),
      ]),
    ).toEqual([
      { name: "Edit", count: 3 },
      { name: "Bash", count: 2 },
      { name: "Read", count: 2 },
    ]);
  });

  it("ignores tool_call_update (already-issued tool calls)", () => {
    expect(
      extractToolHistogram([
        toolCall("Read"),
        {
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "tc1",
              status: "completed",
            },
          },
          recordedAt: 1,
        },
      ]),
    ).toEqual([{ name: "Read", count: 1 }]);
  });

  it("uses title fallback when name is absent (claude-acp shape)", () => {
    expect(extractToolHistogram([toolCall("Read")])).toEqual([
      { name: "Read", count: 1 },
    ]);
  });

  it("prefers name over title when both are present", () => {
    expect(
      extractToolHistogram([
        {
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "tool_call",
              name: "spec-name",
              title: "agent-title",
              rawInput: {},
            },
          },
          recordedAt: 1,
        },
      ]),
    ).toEqual([{ name: "spec-name", count: 1 }]);
  });

  it("falls back to (unnamed) when both name and title are missing", () => {
    expect(
      extractToolHistogram([
        {
          method: "session/update",
          params: { update: { sessionUpdate: "tool_call", rawInput: {} } },
          recordedAt: 1,
        },
      ]),
    ).toEqual([{ name: "(unnamed)", count: 1 }]);
  });
});

describe("extractToolsUsed", () => {
  it("returns just the names in histogram order", () => {
    expect(
      extractToolsUsed([
        toolCall("Edit"),
        toolCall("Edit"),
        toolCall("Read"),
        toolCall("Bash"),
      ]),
    ).toEqual(["Edit", "Bash", "Read"]);
  });
});

describe("extractFilesTouchedDetailed", () => {
  it("groups file_path by file with per-tool counts", () => {
    expect(
      extractFilesTouchedDetailed([
        toolCall("Read", { file_path: "src/a.ts" }),
        toolCall("Edit", { file_path: "src/a.ts" }),
        toolCall("Edit", { file_path: "src/a.ts" }),
        toolCall("Write", { file_path: "src/b.ts" }),
      ]),
    ).toEqual([
      {
        path: "src/a.ts",
        count: 3,
        byTool: [
          { name: "Edit", count: 2 },
          { name: "Read", count: 1 },
        ],
      },
      {
        path: "src/b.ts",
        count: 1,
        byTool: [{ name: "Write", count: 1 }],
      },
    ]);
  });

  it("uses `path` fallback when `file_path` is absent (Glob-style)", () => {
    expect(
      extractFilesTouchedDetailed([
        toolCall("Glob", { path: "src/**/*.ts" }),
      ])[0]!.path,
    ).toBe("src/**/*.ts");
  });

  it("extracts MultiEdit `edits[].file_path`", () => {
    const result = extractFilesTouchedDetailed([
      toolCall("MultiEdit", {
        edits: [
          { file_path: "src/a.ts", old: "x", new: "y" },
          { file_path: "src/b.ts", old: "p", new: "q" },
        ],
      }),
    ]);
    expect(result.map((f) => f.path).sort()).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
  });

  it("extracts paths from the locations[] sidecar", () => {
    const result = extractFilesTouchedDetailed([
      toolCall(
        "Grep",
        { pattern: "TODO" },
        { locations: [{ path: "src/a.ts" }, { path: "src/b.ts" }] },
      ),
    ]);
    expect(result.map((f) => f.path).sort()).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
  });

  it("returns empty array for tools with no extractable paths (Bash)", () => {
    expect(
      extractFilesTouchedDetailed([toolCall("Bash", { command: "ls" })]),
    ).toEqual([]);
  });
});

describe("extractFilesTouched (just paths)", () => {
  it("returns paths ordered by touch count (most-touched first)", () => {
    expect(
      extractFilesTouched([
        toolCall("Read", { file_path: "rare.ts" }),
        toolCall("Edit", { file_path: "hot.ts" }),
        toolCall("Edit", { file_path: "hot.ts" }),
        toolCall("Edit", { file_path: "hot.ts" }),
      ]),
    ).toEqual(["hot.ts", "rare.ts"]);
  });
});
