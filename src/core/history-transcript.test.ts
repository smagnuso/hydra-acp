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

// The three tool-call shapes observed in real sessions. Each agent opens
// a call and then fills in its arguments over later events, differently.
// Entries are pushed onto after construction with differently-shaped
// updates, so the element type has to stay open rather than be inferred
// from the first literal.
type Entry = Record<string, unknown>;

function claudeCall(
  id: string,
  toolName: string,
  command: string,
): Entry[] {
  const meta = { claudeCode: { toolName } };
  return [
    {
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call",
          toolCallId: id,
          title: "Terminal",
          kind: "execute",
          rawInput: {},
          status: "pending",
          _meta: meta,
        },
      },
      recordedAt: 1,
    },
    {
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: id,
          title: command,
          kind: "execute",
          rawInput: { command },
          _meta: meta,
        },
      },
      recordedAt: 2,
    },
  ];
}

function opencodeCall(id: string, command: string): Entry[] {
  return [
    {
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call",
          toolCallId: id,
          title: "bash",
          kind: "execute",
          rawInput: { cwd: "/repo" },
          status: "pending",
        },
      },
      recordedAt: 1,
    },
    {
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: id,
          title: command,
          kind: "execute",
          rawInput: { command, cwd: "/repo" },
        },
      },
      recordedAt: 2,
    },
  ];
}

function claudeShellWithOutput(id: string, command: string, stdout: string) {
  const entries = claudeCall(id, "Bash", command);
  entries.push({
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: id,
        status: "completed",
        rawOutput: stdout,
        _meta: { claudeCode: { toolResponse: { stdout, stderr: "" } } },
      },
    },
    recordedAt: 3,
  });
  return entries;
}

function legacyOpencodeCall(id: string, command: string) {
  return [
    {
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call",
          toolCallId: id,
          title: command,
          kind: "execute",
          rawInput: { command },
          status: "pending",
        },
      },
      recordedAt: 1,
    },
  ];
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
    const long = "x".repeat(900);
    const t = renderTranscript([toolCall("Edit", { file_path: long })]);
    expect(t).toContain("…");
    expect(t.length).toBeLessThan(long.length + 50);
  });

  it("keeps a shell command that would previously have been cut mid-pipeline", () => {
    const command = `git ls-files '*.h' | ${"grep -v vendor | ".repeat(20)}wc -l`;
    expect(command.length).toBeGreaterThan(300);
    const t = renderTranscript([toolCall("Bash", { command })]);
    expect(t).toContain("wc -l");
    expect(t).not.toContain("…");
  });

  // A tool call's arguments arrive on tool_call_update events, not on the
  // opening tool_call. Rendering only the opening event dropped every
  // command in the session, which is what made a workspace switch hand
  // the replacement agent "Tool: Terminal" and nothing else.
  describe("arguments that arrive after the call opens", () => {
    it("carries a claude-acp command through from its update", () => {
      const t = renderTranscript(claudeCall("a", "Bash", "git status --short"));
      expect(t).toBe("Tool: Bash(command=git status --short)");
    });

    it("carries an opencode command through, merging with the opening cwd", () => {
      const t = renderTranscript(opencodeCall("a", "ls -la"));
      expect(t).toBe("Tool: bash(command=ls -la)");
    });

    it("handles a legacy opencode call that opens complete", () => {
      const t = renderTranscript(legacyOpencodeCall("a", "wc -l"));
      expect(t).toBe("Tool: execute(command=wc -l)");
    });

    it("prefers the out-of-band name over the opening title", () => {
      const t = renderTranscript(claudeCall("a", "Bash", "true"));
      expect(t).toContain("Tool: Bash");
      expect(t).not.toContain("Terminal");
    });

    it("does not let a later title masquerade as the tool name", () => {
      const t = renderTranscript(opencodeCall("a", "rm -rf /tmp/x"));
      expect(t).toBe("Tool: bash(command=rm -rf /tmp/x)");
    });

    it("keeps interleaved calls separate by toolCallId", () => {
      const a = claudeCall("a", "Bash", "echo one");
      const b = claudeCall("b", "Bash", "echo two");
      const interleaved = [a[0]!, b[0]!, a[1]!, b[1]!];
      const lines = renderTranscript(interleaved).split("\n");
      expect(lines).toEqual([
        "Tool: Bash(command=echo one)",
        "Tool: Bash(command=echo two)",
      ]);
    });

    it("emits one line per call, not one per update", () => {
      const t = renderTranscript(claudeCall("a", "Bash", "echo hi"));
      expect(t.split("\n").filter((l) => l.startsWith("Tool: "))).toHaveLength(1);
    });

    it("falls back to the ACP kind rather than echoing the command as a name", () => {
      const command = "cd /tmp && ./run.sh --with-a-long-argument-list";
      const t = renderTranscript(legacyOpencodeCall("a", command));
      expect(t).toBe(`Tool: execute(command=${command})`);
    });

    it("still renders a call with no toolCallId to merge on", () => {
      const t = renderTranscript([toolCall("Read", { path: "/tmp/f" })]);
      expect(t).toBe("Tool: Read(path=/tmp/f)");
    });
  });

  // Output is opt-in. The seed and synopsis callers stay lean and, more
  // importantly, stale-free: a listing captured before a workspace move
  // asserts things that are no longer true.
  describe("tool output", () => {
    const opts = { toolOutput: { maxPerCall: 100, maxTotal: 1000 } };

    it("is absent unless the caller asks for it", () => {
      const t = renderTranscript(claudeShellWithOutput("a", "wc -l", "1679"));
      expect(t).toBe("Tool: Bash(command=wc -l)");
      expect(t).not.toContain("1679");
    });

    it("renders under the call when requested", () => {
      const t = renderTranscript(claudeShellWithOutput("a", "wc -l", "1679"), opts);
      expect(t).toBe("Tool: Bash(command=wc -l)\nOutput: 1679");
    });

    it("reads opencode's nested output shape", () => {
      const entries = opencodeCall("a", "ls");
      entries.push({
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "a",
            status: "completed",
            rawOutput: { output: "file.txt", metadata: {} },
          },
        },
        recordedAt: 3,
      });
      const t = renderTranscript(entries, opts);
      expect(t).toContain("Output: file.txt");
    });

    it("caps a single oversized output and says how much it dropped", () => {
      const t = renderTranscript(
        claudeShellWithOutput("a", "cat big", "y".repeat(500)),
        opts,
      );
      expect(t).toContain("more chars]");
      expect(t.length).toBeLessThan(300);
    });

    it("stops spending once the whole-response budget is gone", () => {
      const entries = [
        ...claudeShellWithOutput("a", "one", "x".repeat(80)),
        ...claudeShellWithOutput("b", "two", "y".repeat(80)),
        ...claudeShellWithOutput("c", "three", "z".repeat(80)),
      ];
      const t = renderTranscript(entries, {
        toolOutput: { maxPerCall: 100, maxTotal: 100 },
      });
      expect(t).toContain("Tool: Bash(command=three)");
      expect(t.split("\n").filter((l) => l.startsWith("Output: "))).toHaveLength(2);
    });
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
