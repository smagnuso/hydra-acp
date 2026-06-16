import { describe, it, expect } from "vitest";
import { renderCompactionSeed } from "./compaction-seed.js";

function synopsis(overrides?: Partial<typeof defaultSynopsis>) {
  return { ...defaultSynopsis, ...overrides };
}

const defaultSynopsis = {
  goal: "build a feature",
  outcome: "shipped it",
  open_threads: ["follow-up refactor"],
  decisions: ["use SQLite"],
  file_edit_intentions: ["src/main.ts", "src/util.ts"],
  unresolved_errors: ["TypeScript strict mode warnings"],
  tool_state: ["bash active"],
  files_touched: ["src/a.ts", "src/b.ts", "src/c.ts"],
  tools_used: ["Read", "Write", "Bash"],
};

function userPrompt(text: string) {
  return {
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "prompt_received",
        prompt: [{ type: "text" as const, text }],
      },
    },
    recordedAt: 1,
  };
}

function agentChunk(text: string) {
  return {
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text" as const, text },
      },
    },
    recordedAt: 1,
  };
}

function toolCall(
  name: string,
  rawInput: Record<string, unknown> = {},
  opts?: { nameField?: "name" | "title" },
) {
  const field = opts?.nameField ?? "title";
  return {
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tc",
        [field]: name,
        rawInput,
      },
    },
    recordedAt: 1,
  };
}

function turnComplete() {
  return {
    method: "session/update",
    params: { update: { sessionUpdate: "turn_complete" } },
    recordedAt: 1,
  };
}

describe("renderCompactionSeed", () => {
  it("renders full artifact + 10-turn tail", () => {
    const seed = renderCompactionSeed({
      synopsis: synopsis(),
      title: "my session",
      tail: buildHistory(10),
      tailK: 10,
    });

    expect(seed).toContain("--- begin prior session compaction ---");
    expect(seed).toContain("[Title] my session");
    expect(seed).toContain("[Goal] build a feature");
    expect(seed).toContain("[Outcome] shipped it");
    expect(seed).toContain("- follow-up refactor");
    expect(seed).toContain("- use SQLite");
    expect(seed).toContain("- TypeScript strict mode warnings");
    expect(seed).toContain("- bash active");
    expect(seed).toContain("[Files previously touched] src/a.ts, src/b.ts, src/c.ts");
    expect(seed).toContain("[Tools previously used] Read, Write, Bash");
    expect(seed).toContain("--- end prior session compaction ---");
    expect(seed).toContain("--- begin recent turns (verbatim, last 10) ---");
    for (let i = 1; i <= 10; i++) {
      expect(seed).toContain("User: prompt " + i);
      expect(seed).toContain("Assistant: response " + i);
    }
    expect(seed).toContain("--- end recent turns ---");
    expect(seed).toContain(
      "(Hydra has compacted earlier conversation.",
    );
  });

  it("renders with empty optional fields", () => {
    const seed = renderCompactionSeed({
      synopsis: synopsis({
        goal: "",
        outcome: undefined,
        open_threads: [],
        decisions: [""],
        file_edit_intentions: undefined,
        unresolved_errors: [],
        tool_state: [""],
        files_touched: [],
        tools_used: undefined,
      }),
      title: "untitled session",
      tail: [],
      tailK: 5,
    });

    expect(seed).toContain("--- begin prior session compaction ---");
    expect(seed).toContain("[Title] untitled session");
    // Empty goal should be skipped (trim().length === 0)
    expect(seed).not.toContain("[Goal]");
    expect(seed).not.toContain("[Outcome]");
    expect(seed).not.toContain("[Open threads]");
    // decisions has one entry which is empty string → filtered out
    expect(seed).not.toContain("[Decisions]");
    expect(seed).not.toContain("[File edit intentions]");
    expect(seed).not.toContain("[Unresolved errors]");
    expect(seed).not.toContain("[Tool state]");
    expect(seed).not.toContain("[Files previously touched]");
    expect(seed).not.toContain("[Tools previously used]");
    expect(seed).toContain("--- end prior session compaction ---");
  });

  it("defaults title to (untitled) when omitted", () => {
    const seed = renderCompactionSeed({
      synopsis: synopsis(),
      tail: [],
      tailK: 0,
    });

    expect(seed).toContain("[Title] (untitled)");
  });

  it("tailK=0 renders no verbatim content", () => {
    const seed = renderCompactionSeed({
      synopsis: synopsis(),
      tail: buildHistory(5),
      tailK: 0,
    });

    expect(seed).toContain("--- begin recent turns (verbatim, last 0) ---");
    expect(seed).not.toContain("User: ");
    expect(seed).not.toContain("Assistant: ");
  });

  it("tailK larger than available history renders all turns", () => {
    const seed = renderCompactionSeed({
      synopsis: synopsis(),
      tail: buildHistory(3),
      tailK: 100,
    });

    // Should include all 3 turns (not truncated)
    expect(seed).toContain("User: prompt 1");
    expect(seed).toContain("Assistant: response 1");
    expect(seed).toContain("User: prompt 3");
    expect(seed).toContain("Assistant: response 3");
    // Should not include turn 4 (doesn't exist)
    expect(seed).not.toContain("prompt 4");
  });

  it("renders tool calls inside tail turns", () => {
    const history = [
      userPrompt("edit this file"),
      agentChunk("let me read "),
      agentChunk("the file"),
      toolCall("Read", { file_path: "src/a.ts" }),
      agentChunk("\n\nokay, done editing"),
      turnComplete(),
    ];

    const seed = renderCompactionSeed({
      synopsis: synopsis({ open_threads: undefined, decisions: undefined, unresolved_errors: undefined, tool_state: undefined, files_touched: undefined, tools_used: undefined }),
      tail: history,
      tailK: 1,
    });

    expect(seed).toContain("User: edit this file");
    expect(seed).toContain("Assistant: let me read the file\n\nokay, done editing");
    expect(seed).toContain("Tool: Read(file_path=src/a.ts)");
  });

  it("skips non-session/update entries in tail", () => {
    const history = [
      { method: "session/prompt", params: {}, recordedAt: 1 },
      userPrompt("hello"),
      agentChunk("hi back"),
      turnComplete(),
    ];

    const seed = renderCompactionSeed({
      synopsis: synopsis(),
      tail: history,
      tailK: 5,
    });

    expect(seed).toContain("User: hello");
    expect(seed).toContain("Assistant: hi back");
  });

  it("returns closing note on every invocation", () => {
    const seed = renderCompactionSeed({
      synopsis: synopsis(),
      tail: [],
      tailK: 0,
    });

    expect(seed).toContain(
      "(Hydra has compacted earlier conversation. Detail is retrievable via the hydra-recall tools if you need to look up specifics. Acknowledge briefly and wait for the next user message.)",
    );
  });
});

// Build a history array with N complete user/agent turns.
function buildHistory(count: number): Array<{ method?: string; params?: unknown; recordedAt: number }> {
  const entries: Array<{ method?: string; params?: unknown; recordedAt: number }> = [];
  for (let i = 1; i <= count; i++) {
    entries.push(userPrompt("prompt " + i));
    entries.push(agentChunk("response " + i));
    entries.push(turnComplete());
  }
  return entries;
}
