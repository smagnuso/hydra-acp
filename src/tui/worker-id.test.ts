import { describe, expect, it } from "vitest";
import { getWorkerTaskId } from "./worker-id.js";

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
