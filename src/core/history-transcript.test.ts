import { describe, it, expect } from "vitest";
import { renderTranscript } from "./history-transcript.js";

function userPrompt(text: string) {
  return {
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "prompt_received",
        prompt: [{ type: "text", text }],
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
        content: { type: "text", text },
      },
    },
    recordedAt: 1,
  };
}

function toolCall(
  name: string,
  rawInput: Record<string, unknown> = {},
  opts: { nameField?: "name" | "title" } = {},
) {
  const field = opts.nameField ?? "title";
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

describe("renderTranscript", () => {
  it("renders user prompts verbatim", () => {
    const t = renderTranscript([userPrompt("hello world")]);
    expect(t).toBe("User: hello world");
  });

  it("merges consecutive agent chunks into one Assistant block per turn", () => {
    const t = renderTranscript([
      userPrompt("hi"),
      agentChunk("hi "),
      agentChunk("there"),
      turnComplete(),
    ]);
    expect(t).toBe("User: hi\nAssistant: hi there");
  });

  it("flushes assistant buffer when a tool_call interleaves", () => {
    const t = renderTranscript([
      userPrompt("hi"),
      agentChunk("let me read it"),
      toolCall("Read", { file_path: "src/a.ts" }),
      agentChunk("done"),
      turnComplete(),
    ]);
    expect(t).toBe(
      "User: hi\nAssistant: let me read it\nTool: Read(file_path=src/a.ts)\nAssistant: done",
    );
  });

  it("renders tool calls with no surfaced args as bare name", () => {
    const t = renderTranscript([toolCall("Bash", { command: "ls" })]);
    expect(t).toBe("Tool: Bash(command=ls)");
  });

  it("renders tool calls with unrecognized args as just the name", () => {
    const t = renderTranscript([toolCall("Custom", { random: "v" })]);
    expect(t).toBe("Tool: Custom");
  });

  it("ignores thought_chunk, plan_update, tool_call_update", () => {
    const t = renderTranscript([
      userPrompt("hi"),
      {
        method: "session/update",
        params: { update: { sessionUpdate: "thought_chunk", content: { text: "x" } } },
        recordedAt: 1,
      },
      {
        method: "session/update",
        params: { update: { sessionUpdate: "plan_update" } },
        recordedAt: 1,
      },
      {
        method: "session/update",
        params: { update: { sessionUpdate: "tool_call_update" } },
        recordedAt: 1,
      },
    ]);
    expect(t).toBe("User: hi");
  });

  it("ignores non-session/update entries", () => {
    const t = renderTranscript([
      { method: "session/prompt", params: {}, recordedAt: 1 },
      userPrompt("hi"),
    ]);
    expect(t).toBe("User: hi");
  });

  it("prefers tool name over title", () => {
    const t = renderTranscript([
      {
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "tool_call",
            name: "Spec",
            title: "Agent",
            rawInput: {},
          },
        },
        recordedAt: 1,
      },
    ]);
    expect(t).toBe("Tool: Spec");
  });

  it("truncates the head and prepends marker when over maxChars", () => {
    const entries = Array.from({ length: 50 }, (_, i) =>
      userPrompt(`prompt-${i}`),
    );
    const t = renderTranscript(entries, { maxChars: 80 });
    expect(t.startsWith("[older history truncated]")).toBe(true);
    expect(t.length).toBeLessThanOrEqual(80);
    expect(t).toContain("prompt-49");
  });

  it("returns text unchanged when under maxChars", () => {
    const t = renderTranscript([userPrompt("short")], { maxChars: 1000 });
    expect(t).toBe("User: short");
  });

  it("inlines long arg values with an ellipsis", () => {
    const long = "x".repeat(500);
    const t = renderTranscript([toolCall("Edit", { file_path: long })]);
    expect(t).toContain("…");
    expect(t.length).toBeLessThan(long.length + 50);
  });

  it("does not crash on prompt_received with non-array prompt", () => {
    const t = renderTranscript([
      {
        method: "session/update",
        params: { update: { sessionUpdate: "prompt_received", prompt: "plain string" } },
        recordedAt: 1,
      },
    ]);
    expect(t).toBe("User: plain string");
  });

  it("returns empty string for empty history", () => {
    expect(renderTranscript([])).toBe("");
  });
});
