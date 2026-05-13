import { describe, expect, it } from "vitest";
import { mapUpdate } from "./render-update.js";

describe("mapUpdate", () => {
  it("handles agent_message_chunk with text content", () => {
    expect(
      mapUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello " },
      }),
    ).toEqual({ kind: "agent-text", text: "hello " });
  });

  it("handles agent_message_chunk with raw string content", () => {
    expect(
      mapUpdate({
        sessionUpdate: "agent_message_chunk",
        content: "world",
      }),
    ).toEqual({ kind: "agent-text", text: "world" });
  });

  it("falls back to legacy `kind` discriminator", () => {
    expect(
      mapUpdate({
        kind: "agent_message_chunk",
        content: { type: "text", text: "x" },
      }),
    ).toEqual({ kind: "agent-text", text: "x" });
  });

  it("handles agent_thought_chunk", () => {
    expect(
      mapUpdate({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "thinking..." },
      }),
    ).toEqual({ kind: "agent-thought", text: "thinking..." });
  });

  it("handles legacy agent_thought with text field", () => {
    expect(
      mapUpdate({ kind: "agent_thought", text: "thinking" }),
    ).toEqual({ kind: "agent-thought", text: "thinking" });
  });

  it("handles user_message_chunk", () => {
    expect(
      mapUpdate({
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "from user" },
      }),
    ).toEqual({ kind: "user-text", text: "from user" });
  });

  it("suppresses user_message_chunk that is a compat shim for prompt_received", () => {
    expect(
      mapUpdate({
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "duplicate" },
        _meta: { "hydra-acp": { compatFor: "prompt_received" } },
      }),
    ).toBeNull();
  });

  it("drops sentBy attribution entirely — names are app-level noise, not human signal", () => {
    // sentBy.name (e.g. "hydra-acp-tui") and sentBy.clientId (e.g. "c1")
    // are both internal client identifiers, neither readable to a user.
    // We unconditionally drop the attribution rather than render "from
    // hydra-acp-tui" / "from cli_abc123" under every replayed prompt.
    expect(
      mapUpdate({
        sessionUpdate: "prompt_received",
        prompt: [{ type: "text", text: "hi" }, { type: "text", text: " there" }],
        sentBy: { name: "alice", clientId: "c1" },
      }),
    ).toEqual({ kind: "user-text", text: "hi there" });
    expect(
      mapUpdate({
        sessionUpdate: "prompt_received",
        prompt: [{ type: "text", text: "hi" }],
        sentBy: { clientId: "c1" },
      }),
    ).toEqual({ kind: "user-text", text: "hi" });
    expect(
      mapUpdate({
        sessionUpdate: "prompt_received",
        prompt: [{ type: "text", text: "hi" }],
        sentBy: { name: "hydra-acp-tui", clientId: "c1" },
      }),
    ).toEqual({ kind: "user-text", text: "hi" });
  });

  it("handles tool_call with status and rawKind", () => {
    expect(
      mapUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "tc1",
        title: "Read file",
        status: "pending",
        kind: "read",
      }),
    ).toEqual({
      kind: "tool-call",
      toolCallId: "tc1",
      title: "Read file",
      status: "pending",
      rawKind: "read",
    });
  });

  it("falls back to id when toolCallId is missing", () => {
    expect(
      mapUpdate({
        sessionUpdate: "tool_call",
        id: "tc2",
        name: "exec",
      }),
    ).toEqual({
      kind: "tool-call",
      toolCallId: "tc2",
      title: "exec",
    });
  });

  it("returns null for tool_call without identifier", () => {
    expect(mapUpdate({ sessionUpdate: "tool_call", title: "x" })).toBeNull();
  });

  it("handles tool_call_update", () => {
    expect(
      mapUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "tc1",
        status: "completed",
      }),
    ).toEqual({
      kind: "tool-call-update",
      toolCallId: "tc1",
      status: "completed",
    });
  });

  it("suppresses intermediate tool_call_update with no title and non-terminal status", () => {
    // Agents fan out a stream of "updated" pings during a tool call;
    // those would clutter the scrollback with one line per chunk if we
    // rendered them.
    expect(
      mapUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "tc1",
        status: "updated",
      }),
    ).toBeNull();
    // A title update IS meaningful even if the status is still in flight.
    expect(
      mapUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "tc1",
        title: "Edit foo.ts",
        status: "in_progress",
      }),
    ).toEqual({
      kind: "tool-call-update",
      toolCallId: "tc1",
      title: "Edit foo.ts",
      status: "in_progress",
    });
  });

  it("normalizes plan entries", () => {
    expect(
      mapUpdate({
        sessionUpdate: "plan",
        entries: [
          { content: "step 1", status: "pending" },
          { content: "step 2", status: "in_progress", priority: "high" },
          { status: "ignored — no content" },
          "garbage",
          { content: "step 3" },
        ],
      }),
    ).toEqual({
      kind: "plan",
      entries: [
        { content: "step 1", status: "pending" },
        { content: "step 2", status: "in_progress", priority: "high" },
        { content: "step 3" },
      ],
    });
  });

  it("handles current_mode_update", () => {
    expect(
      mapUpdate({
        sessionUpdate: "current_mode_update",
        currentMode: "plan",
      }),
    ).toEqual({ kind: "mode-changed", mode: "plan" });
  });

  it("handles current_model_update", () => {
    expect(
      mapUpdate({
        sessionUpdate: "current_model_update",
        currentModel: "claude-sonnet",
      }),
    ).toEqual({ kind: "model-changed", model: "claude-sonnet" });
  });

  it("handles turn_complete with and without stopReason", () => {
    expect(
      mapUpdate({ sessionUpdate: "turn_complete", stopReason: "end_turn" }),
    ).toEqual({ kind: "turn-complete", stopReason: "end_turn" });
    expect(mapUpdate({ sessionUpdate: "turn_complete" })).toEqual({
      kind: "turn-complete",
    });
  });

  it("handles usage_update", () => {
    expect(
      mapUpdate({
        sessionUpdate: "usage_update",
        used: 12345,
        size: 200000,
        cost: { amount: 0.0042, currency: "USD" },
      }),
    ).toEqual({
      kind: "usage-update",
      used: 12345,
      size: 200000,
      costAmount: 0.0042,
      costCurrency: "USD",
    });
  });

  it("usage_update tolerates partial payloads", () => {
    expect(
      mapUpdate({ sessionUpdate: "usage_update", used: 100 }),
    ).toEqual({ kind: "usage-update", used: 100 });
  });

  it("handles available_commands_update and normalizes names with a leading slash", () => {
    expect(
      mapUpdate({
        sessionUpdate: "available_commands_update",
        availableCommands: [
          { name: "create_plan", description: "Create a plan" }, // bare → slash-prepended
          { name: "/init", description: "Initialize" }, // already prefixed
          { name: "research_codebase" },
          { description: "no name — skipped" },
          "garbage",
        ],
      }),
    ).toEqual({
      kind: "available-commands",
      commands: [
        { name: "/create_plan", description: "Create a plan" },
        { name: "/init", description: "Initialize" },
        { name: "/research_codebase" },
      ],
    });
  });

  it("maps session_info_update to a session-info event", () => {
    expect(
      mapUpdate({
        sessionUpdate: "session_info_update",
        title: "fix the bug in foo.ts",
        updatedAt: "2026-05-11T00:00:00.000Z",
      }),
    ).toEqual({ kind: "session-info", title: "fix the bug in foo.ts" });
  });

  it("ignores session_info_update without a title or agentId", () => {
    expect(
      mapUpdate({ sessionUpdate: "session_info_update", updatedAt: "x" }),
    ).toBeNull();
  });

  it("maps session_info_update with a hydra agentId in _meta", () => {
    expect(
      mapUpdate({
        sessionUpdate: "session_info_update",
        _meta: { "hydra-acp": { synthetic: true, agentId: "codex-acp" } },
      }),
    ).toEqual({ kind: "session-info", agentId: "codex-acp" });
  });

  it("maps session_info_update with both title and agentId", () => {
    expect(
      mapUpdate({
        sessionUpdate: "session_info_update",
        title: "fix the bug",
        _meta: { "hydra-acp": { agentId: "codex-acp" } },
      }),
    ).toEqual({ kind: "session-info", title: "fix the bug", agentId: "codex-acp" });
  });

  it("returns unknown for unrecognized sessionUpdate", () => {
    expect(
      mapUpdate({ sessionUpdate: "config_option_update", foo: "bar" }),
    ).toEqual({
      kind: "unknown",
      sessionUpdate: "config_option_update",
      raw: { sessionUpdate: "config_option_update", foo: "bar" },
    });
  });

  it("returns null for non-objects and missing tag", () => {
    expect(mapUpdate(null)).toBeNull();
    expect(mapUpdate(undefined)).toBeNull();
    expect(mapUpdate("hello")).toBeNull();
    expect(mapUpdate({})).toBeNull();
    expect(mapUpdate({ foo: "bar" })).toBeNull();
  });
});
