import { describe, expect, it } from "vitest";
import { getParentToolUseId, getWorkerTaskId } from "./worker-id.js";

describe("getWorkerTaskId", () => {
  it("returns the workerTaskId string when present", () => {
    const update = { sessionUpdate: "tool_call", workerTaskId: "wt-abc123" };
    expect(getWorkerTaskId(update)).toBe("wt-abc123");
  });

  it("returns undefined when workerTaskId is absent", () => {
    const update = { sessionUpdate: "agent_message_chunk", text: "hello" };
    expect(getWorkerTaskId(update)).toBeUndefined();
  });

  it("returns undefined when the update is null or non-object", () => {
    expect(getWorkerTaskId(null)).toBeUndefined();
    expect(getWorkerTaskId(undefined)).toBeUndefined();
    expect(getWorkerTaskId(42)).toBeUndefined();
    expect(getWorkerTaskId("string")).toBeUndefined();
  });
});

describe("getParentToolUseId", () => {
  it("returns parentToolUseId from _meta.claudeCode when present", () => {
    const update = {
      sessionUpdate: "tool_call",
      _meta: { claudeCode: { parentToolUseId: "toolu_01abc" } },
    };
    expect(getParentToolUseId(update)).toBe("toolu_01abc");
  });

  it("returns undefined for a top-level tool call with no parent", () => {
    const update = {
      sessionUpdate: "tool_call",
      _meta: { claudeCode: { toolName: "Bash" } },
    };
    expect(getParentToolUseId(update)).toBeUndefined();
  });

  it("returns undefined when _meta or claudeCode is absent or malformed", () => {
    expect(getParentToolUseId({ sessionUpdate: "tool_call" })).toBeUndefined();
    expect(
      getParentToolUseId({ sessionUpdate: "tool_call", _meta: null }),
    ).toBeUndefined();
    expect(
      getParentToolUseId({
        sessionUpdate: "tool_call",
        _meta: { claudeCode: "not-an-object" },
      }),
    ).toBeUndefined();
  });

  it("returns undefined when the update is null or non-object", () => {
    expect(getParentToolUseId(null)).toBeUndefined();
    expect(getParentToolUseId(undefined)).toBeUndefined();
    expect(getParentToolUseId(42)).toBeUndefined();
  });
});
