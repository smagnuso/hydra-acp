import { describe, it, expect } from "vitest";
import { coalesceReplay } from "./coalesce-replay.js";
import type { HistoryEntry } from "./history-store.js";

const SID = "hydra_session_abc";

function chunk(
  kind: string,
  text: string,
  messageId: string,
  recordedAt = 0,
): HistoryEntry {
  return {
    method: "session/update",
    params: {
      sessionId: SID,
      update: {
        sessionUpdate: kind,
        content: { type: "text", text },
        messageId,
      },
    },
    recordedAt,
  };
}

function toolUpdate(
  toolCallId: string,
  content: Array<Record<string, unknown>> | undefined,
  status?: string,
  title?: string,
  recordedAt = 0,
): HistoryEntry {
  const update: Record<string, unknown> = {
    sessionUpdate: "tool_call_update",
    toolCallId,
  };
  if (content !== undefined) update.content = content;
  if (status !== undefined) update.status = status;
  if (title !== undefined) update.title = title;
  return {
    method: "session/update",
    params: { sessionId: SID, update },
    recordedAt,
  };
}

function planEntry(
  steps: Array<{ content: string; status: string }>,
  recordedAt = 0,
): HistoryEntry {
  return {
    method: "session/update",
    params: {
      sessionId: SID,
      update: { sessionUpdate: "plan", entries: steps },
    },
    recordedAt,
  };
}

function simpleUpdate(kind: string, extra: Record<string, unknown> = {}): HistoryEntry {
  return {
    method: "session/update",
    params: { sessionId: SID, update: { sessionUpdate: kind, ...extra } },
    recordedAt: 0,
  };
}

describe("coalesceReplay", () => {
  it("returns the input unchanged when empty", () => {
    expect(coalesceReplay([])).toEqual([]);
  });

  it("concatenates consecutive agent_message_chunks with the same messageId", () => {
    const out = coalesceReplay([
      chunk("agent_message_chunk", "Hello ", "m_1"),
      chunk("agent_message_chunk", "world", "m_1"),
      chunk("agent_message_chunk", "!", "m_1"),
    ]);
    expect(out).toHaveLength(1);
    const upd = (out[0]!.params as { update: { content: { text: string } } })
      .update;
    expect(upd.content.text).toBe("Hello world!");
  });

  it("merges consecutive chunks even when messageIds differ (daemon stamps a fresh id per chunk)", () => {
    const out = coalesceReplay([
      chunk("agent_message_chunk", "a", "m_1"),
      chunk("agent_message_chunk", "b", "m_2"),
      chunk("agent_message_chunk", "c", "m_3"),
    ]);
    expect(out).toHaveLength(1);
    const text = (out[0]!.params as { update: { content: { text: string } } })
      .update.content.text;
    expect(text).toBe("abc");
  });

  it("does not merge chunks across an interrupting event", () => {
    const out = coalesceReplay([
      chunk("agent_message_chunk", "a", "m_1"),
      simpleUpdate("tool_call", { toolCallId: "t1", content: [] }),
      chunk("agent_message_chunk", "b", "m_1"),
    ]);
    expect(out).toHaveLength(3);
  });

  it("does not merge chunks of different kinds", () => {
    const out = coalesceReplay([
      chunk("agent_message_chunk", "a", "m_1"),
      chunk("agent_thought_chunk", "b", "m_1"),
    ]);
    expect(out).toHaveLength(2);
  });

  it("emits only the last tool_call_update per toolCallId with concatenated content", () => {
    const out = coalesceReplay([
      simpleUpdate("tool_call", { toolCallId: "t1", content: [] }),
      toolUpdate("t1", [{ type: "content", content: { type: "text", text: "a" } }], "pending"),
      toolUpdate("t1", [{ type: "content", content: { type: "text", text: "b" } }], "in_progress"),
      toolUpdate("t1", [{ type: "content", content: { type: "text", text: "c" } }], "completed"),
    ]);
    // tool_call (kept) + one merged tool_call_update
    expect(out).toHaveLength(2);
    const last = out[1]!.params as {
      update: {
        sessionUpdate: string;
        status: string;
        content: Array<{ content: { text: string } }>;
      };
    };
    expect(last.update.sessionUpdate).toBe("tool_call_update");
    expect(last.update.status).toBe("completed");
    expect(last.update.content.map((c) => c.content.text)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("interleaves merges per toolCallId independently", () => {
    const out = coalesceReplay([
      toolUpdate("a", [{ type: "content", content: { type: "text", text: "a1" } }], "pending"),
      toolUpdate("b", [{ type: "content", content: { type: "text", text: "b1" } }], "pending"),
      toolUpdate("a", [{ type: "content", content: { type: "text", text: "a2" } }], "completed"),
      toolUpdate("b", [{ type: "content", content: { type: "text", text: "b2" } }], "completed"),
    ]);
    expect(out).toHaveLength(2);
    const aUpd = (out[0]!.params as { update: { toolCallId: string; content: Array<{ content: { text: string } }> } }).update;
    const bUpd = (out[1]!.params as { update: { toolCallId: string; content: Array<{ content: { text: string } }> } }).update;
    expect(aUpd.toolCallId).toBe("a");
    expect(aUpd.content.map((c) => c.content.text)).toEqual(["a1", "a2"]);
    expect(bUpd.toolCallId).toBe("b");
    expect(bUpd.content.map((c) => c.content.text)).toEqual(["b1", "b2"]);
  });

  it("keeps only the last plan within a turn", () => {
    const out = coalesceReplay([
      simpleUpdate("prompt_received", { messageId: "m_p1" }),
      planEntry([{ content: "step a", status: "pending" }]),
      planEntry([{ content: "step a", status: "in_progress" }]),
      planEntry([{ content: "step a", status: "completed" }]),
      simpleUpdate("turn_complete", { messageId: "m_p1" }),
    ]);
    // prompt_received + 1 plan + turn_complete
    expect(out).toHaveLength(3);
    const plan = (out[1]!.params as { update: { entries: Array<{ status: string }> } }).update;
    expect(plan.entries[0]?.status).toBe("completed");
  });

  it("resets the plan run at turn boundaries", () => {
    const out = coalesceReplay([
      simpleUpdate("prompt_received", { messageId: "m_p1" }),
      planEntry([{ content: "a", status: "pending" }]),
      simpleUpdate("turn_complete", { messageId: "m_p1" }),
      simpleUpdate("prompt_received", { messageId: "m_p2" }),
      planEntry([{ content: "b", status: "pending" }]),
      simpleUpdate("turn_complete", { messageId: "m_p2" }),
    ]);
    const planKinds = out.filter(
      (e) =>
        (e.params as { update: { sessionUpdate: string } }).update
          .sessionUpdate === "plan",
    );
    expect(planKinds).toHaveLength(2);
  });

  it("passes other update kinds through unchanged", () => {
    const input = [
      simpleUpdate("prompt_received", { messageId: "m_a" }),
      simpleUpdate("turn_complete", { messageId: "m_a", stopReason: "end_turn" }),
      simpleUpdate("usage_update", { used: 100 }),
      simpleUpdate("config_option_update", { configOptions: [] }),
    ];
    expect(coalesceReplay(input)).toEqual(input);
  });

  it("ignores non-session/update entries", () => {
    const input: HistoryEntry[] = [
      { method: "other/method", params: {}, recordedAt: 0 },
      chunk("agent_message_chunk", "x", "m_1"),
      chunk("agent_message_chunk", "y", "m_1"),
    ];
    const out = coalesceReplay(input);
    expect(out).toHaveLength(2);
    expect(out[0]!.method).toBe("other/method");
    const merged = (out[1]!.params as { update: { content: { text: string } } }).update.content.text;
    expect(merged).toBe("xy");
  });

  it("does not mutate the input entries", () => {
    const original: HistoryEntry = chunk("agent_message_chunk", "a", "m_1");
    const second: HistoryEntry = chunk("agent_message_chunk", "b", "m_1");
    coalesceReplay([original, second]);
    expect(
      (original.params as { update: { content: { text: string } } }).update
        .content.text,
    ).toBe("a");
  });

  it("preserves recordedAt of the first chunk in a run", () => {
    const out = coalesceReplay([
      chunk("agent_message_chunk", "a", "m_1", 100),
      chunk("agent_message_chunk", "b", "m_1", 200),
    ]);
    expect(out[0]!.recordedAt).toBe(100);
  });
});
