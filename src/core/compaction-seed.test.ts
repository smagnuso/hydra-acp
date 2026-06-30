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

  it("omits the compaction header and uses the recall-oriented note when synopsis is absent", () => {
    const seed = renderCompactionSeed({
      title: "btw: quick aside",
      tail: buildHistory(2),
      tailK: 10,
    });

    // No synopsis → no compaction header block at all.
    expect(seed).not.toContain("--- begin prior session compaction ---");
    expect(seed).not.toContain("--- end prior session compaction ---");
    expect(seed).not.toContain("[Goal]");
    // Title still renders, above the recent turns.
    expect(seed).toContain("[Title] btw: quick aside");
    expect(seed).toContain("--- begin recent turns (verbatim, last 2) ---");
    expect(seed).toContain("User: prompt 1");
    expect(seed).toContain("Assistant: response 2");
    // Honest closing note — does NOT claim a compaction happened, points at recall.
    expect(seed).not.toContain("Hydra has compacted earlier conversation");
    expect(seed).toContain("forked from another session");
    expect(seed).toContain("hydra-recall");
  });

  it("watermark-anchored clamp: no turns past watermark + floor=0 → empty tail (compaction-lean)", () => {
    // Synopsis covers everything (watermark = entry count). With
    // floor=0, the post-watermark gap is zero turns so the tail is
    // empty — this is the /compact handoff: pure synopsis.
    const history = buildHistory(5);
    const seed = renderCompactionSeed({
      synopsis: synopsis(),
      tail: history,
      tailK: 20,
      watermark: history.length,
      tailFloor: 0,
    });
    expect(seed).toContain("--- begin recent turns (verbatim, last 0) ---");
    expect(seed).not.toContain("User: prompt");
    expect(seed).not.toContain("Assistant: response");
  });

  it("watermark-anchored clamp: floor reaches back into pre-watermark turns for continuity", () => {
    // No turns past watermark, but floor=3 → render last 3 closed
    // turns even though the synopsis already covers them. This is the
    // /hydra agent / fork / btw continuity handoff.
    const history = buildHistory(5);
    const seed = renderCompactionSeed({
      synopsis: synopsis(),
      tail: history,
      tailK: 20,
      watermark: history.length,
      tailFloor: 3,
    });
    expect(seed).toContain("--- begin recent turns (verbatim, last 3) ---");
    expect(seed).not.toContain("User: prompt 1");
    expect(seed).not.toContain("User: prompt 2");
    expect(seed).toContain("User: prompt 3");
    expect(seed).toContain("User: prompt 4");
    expect(seed).toContain("User: prompt 5");
  });

  it("watermark-anchored clamp: gap larger than floor uses the gap", () => {
    // Stale synopsis: 5 turns since watermark, floor=2 → tail = 5
    // (the full gap), not floor. The cap (tailK) only kicks in if the
    // gap exceeds it.
    const allTurns = buildHistory(10);
    // First 5 turns sit before the watermark (covered by synopsis);
    // remaining 5 are post-watermark and must replay verbatim.
    const fiveTurnEntries = buildHistory(5).length; // 15 entries (prompt+chunk+complete per turn)
    const seed = renderCompactionSeed({
      synopsis: synopsis(),
      tail: allTurns,
      tailK: 20,
      watermark: fiveTurnEntries,
      tailFloor: 2,
    });
    expect(seed).toContain("--- begin recent turns (verbatim, last 5) ---");
    expect(seed).not.toContain("User: prompt 5");
    expect(seed).toContain("User: prompt 6");
    expect(seed).toContain("User: prompt 10");
  });

  it("watermark-anchored clamp: gap larger than tailK is capped (recall covers the rest)", () => {
    const allTurns = buildHistory(10);
    const seed = renderCompactionSeed({
      synopsis: synopsis(),
      tail: allTurns,
      tailK: 3,
      watermark: 0, // entire history is post-watermark
      tailFloor: 0,
    });
    expect(seed).toContain("--- begin recent turns (verbatim, last 3) ---");
    expect(seed).not.toContain("User: prompt 7");
    expect(seed).toContain("User: prompt 8");
    expect(seed).toContain("User: prompt 10");
  });

  it("renders an in-flight open turn in its own section", () => {
    // History ends mid-turn — user prompt + chunks + tool call, no
    // turn_complete. Should render the open turn separately.
    const history = [
      ...buildHistory(2),
      userPrompt("ongoing question"),
      agentChunk("partial answer in "),
      agentChunk("progress"),
      toolCall("Bash", { command: "ls" }),
    ];
    const seed = renderCompactionSeed({
      synopsis: synopsis(),
      tail: history,
      tailK: 10,
    });
    expect(seed).toContain("--- end recent turns ---");
    expect(seed).toContain("--- begin current in-flight turn (no completion yet) ---");
    expect(seed).toContain("User: ongoing question");
    expect(seed).toContain("Assistant: partial answer in progress");
    expect(seed).toContain("Tool: Bash(command=ls)");
    expect(seed).toContain("--- end current in-flight turn ---");
  });

  it("does not emit the in-flight section when every turn is closed", () => {
    const seed = renderCompactionSeed({
      synopsis: synopsis(),
      tail: buildHistory(2),
      tailK: 10,
    });
    expect(seed).not.toContain("--- begin current in-flight turn");
    expect(seed).not.toContain("--- end current in-flight turn");
  });

  it("returns closing note on every invocation", () => {
    const seed = renderCompactionSeed({
      synopsis: synopsis(),
      tail: [],
      tailK: 0,
    });

    expect(seed).toContain(
      "(Hydra has compacted earlier conversation. Do NOT call any tools yet. Do NOT read any files, run any commands, or invoke hydra-recall. Reply with the single word 'OK' and wait for the next user message — at that point you can use the hydra-recall tools to look up specifics on demand if needed.)",
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
