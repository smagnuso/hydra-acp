import { describe, expect, it } from "vitest";
import {
  isClaudeSelfCompactionUpdate,
  isCodexSelfCompactionUpdate,
  isContextUsageDrop,
  isSelfCompactionUpdate,
  OpencodeSummaryDetector,
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

describe("isContextUsageDrop", () => {
  it("flags a fall of more than half from a substantial prior figure", () => {
    expect(isContextUsageDrop(898_002, 54_220)).toBe(true);
  });

  it("ignores a modest fall", () => {
    expect(isContextUsageDrop(100_000, 60_000)).toBe(false);
  });

  it("ignores a drop to zero (cleared context)", () => {
    expect(isContextUsageDrop(100_000, 0)).toBe(false);
  });

  it("ignores small priors and a missing prior", () => {
    expect(isContextUsageDrop(10_000, 1_000)).toBe(false);
    expect(isContextUsageDrop(undefined, 50_000)).toBe(false);
  });
});

describe("OpencodeSummaryDetector", () => {
  const chunk = (messageId: string | undefined, text: string) => ({
    sessionUpdate: "agent_message_chunk",
    ...(messageId ? { messageId } : {}),
    content: { type: "text", text },
  });

  it("fires once when both headings have streamed in", () => {
    const d = new OpencodeSummaryDetector();
    expect(d.feed(chunk("m1", "##"))).toBe(false);
    expect(d.feed(chunk("m1", " Objective"))).toBe(false);
    expect(d.feed(chunk("m1", "\n- goal\n\n## Important"))).toBe(false);
    expect(d.feed(chunk("m1", " Details\n- x"))).toBe(true);
    expect(d.feed(chunk("m1", " more"))).toBe(false);
  });

  it("does not fire for ordinary prose", () => {
    const d = new OpencodeSummaryDetector();
    expect(d.feed(chunk("m1", "Here is the fix"))).toBe(false);
    expect(d.feed(chunk("m1", "\n## Important Details\n"))).toBe(false);
  });

  it("does not fire for a message that has only the first heading", () => {
    const d = new OpencodeSummaryDetector();
    expect(d.feed(chunk("m1", "## Objective\n- a\n"))).toBe(false);
    expect(d.feed(chunk("m2", "unrelated"))).toBe(false);
  });

  it("resets between messages and ignores other update kinds", () => {
    const d = new OpencodeSummaryDetector();
    expect(d.feed({ sessionUpdate: "tool_call" })).toBe(false);
    expect(d.feed(chunk("m1", "## Objective\n## Important Details\n"))).toBe(true);
    expect(d.feed(chunk("m2", "## Objective\n## Important Details\n"))).toBe(true);
  });

  it("ignores chunks without a messageId", () => {
    const d = new OpencodeSummaryDetector();
    expect(d.feed(chunk(undefined, "## Objective\n## Important Details\n"))).toBe(false);
  });
});
