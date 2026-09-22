import { describe, expect, it } from "vitest";
import {
  isClaudeSelfCompactionUpdate,
  isCodexSelfCompactionUpdate,
  isSelfCompactionUpdate,
} from "./context-compaction-signal.js";

describe("isCodexSelfCompactionUpdate", () => {
  it("matches codex-acp's completed 'Compact conversation' tool_call_update", () => {
    expect(
      isCodexSelfCompactionUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "compact-1",
        title: "Compact conversation",
        status: "completed",
        _meta: { contextCompaction: { version: 1 } },
      }),
    ).toBe(true);
  });

  it("matches on title alone when _meta is absent", () => {
    expect(
      isCodexSelfCompactionUpdate({
        sessionUpdate: "tool_call_update",
        title: "Compact conversation",
        status: "completed",
      }),
    ).toBe(true);
  });

  it("matches on _meta alone when the title drifts", () => {
    expect(
      isCodexSelfCompactionUpdate({
        sessionUpdate: "tool_call",
        title: "Compacting",
        status: "completed",
        _meta: { contextCompaction: { version: 1 } },
      }),
    ).toBe(true);
  });

  it("ignores the in_progress start update — only the completion should arm recall", () => {
    expect(
      isCodexSelfCompactionUpdate({
        sessionUpdate: "tool_call",
        title: "Compact conversation",
        status: "in_progress",
        _meta: { contextCompaction: { version: 1 } },
      }),
    ).toBe(false);
  });

  it("rejects an ordinary completed tool call", () => {
    expect(
      isCodexSelfCompactionUpdate({
        sessionUpdate: "tool_call_update",
        title: "Run command",
        status: "completed",
      }),
    ).toBe(false);
  });

  it("rejects non tool_call updates even with a matching title", () => {
    expect(
      isCodexSelfCompactionUpdate({
        sessionUpdate: "agent_message_chunk",
        title: "Compact conversation",
        status: "completed",
      }),
    ).toBe(false);
  });

  it("handles undefined input", () => {
    expect(isCodexSelfCompactionUpdate(undefined)).toBe(false);
  });
});

describe("isClaudeSelfCompactionUpdate", () => {
  it("matches claude-agent-acp's manual /compact completion text", () => {
    expect(
      isClaudeSelfCompactionUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "\n\nCompacting completed." },
      }),
    ).toBe(true);
  });

  it("does not match the 'Compacting...' start marker", () => {
    expect(
      isClaudeSelfCompactionUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Compacting..." },
      }),
    ).toBe(false);
  });

  it("does not match a failed compaction", () => {
    expect(
      isClaudeSelfCompactionUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "\n\nCompacting failed: overloaded." },
      }),
    ).toBe(false);
  });

  it("does not match ordinary prose that happens to mention compacting", () => {
    expect(
      isClaudeSelfCompactionUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "I just finished compacting the array." },
      }),
    ).toBe(false);
  });

  it("handles undefined input", () => {
    expect(isClaudeSelfCompactionUpdate(undefined)).toBe(false);
  });
});

describe("isSelfCompactionUpdate", () => {
  it("is true for either agent's signal", () => {
    expect(
      isSelfCompactionUpdate({
        sessionUpdate: "tool_call_update",
        title: "Compact conversation",
        status: "completed",
      }),
    ).toBe(true);
    expect(
      isSelfCompactionUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "\n\nCompacting completed." },
      }),
    ).toBe(true);
  });

  it("is false for an unrelated update", () => {
    expect(
      isSelfCompactionUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Hello." },
      }),
    ).toBe(false);
  });
});
