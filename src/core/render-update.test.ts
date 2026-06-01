import { describe, expect, it } from "vitest";
import {
  isExitPlanModeTool,
  mapUpdate,
  sanitizeSingleLine,
  sanitizeWireText,
} from "./render-update.js";

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

  it("extracts errorText from content[] on a failed tool_call_update", () => {
    expect(
      mapUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "tc1",
        status: "failed",
        content: [
          { type: "content", content: { type: "text", text: "boom: ENOENT" } },
        ],
      }),
    ).toEqual({
      kind: "tool-call-update",
      toolCallId: "tc1",
      status: "failed",
      errorText: "boom: ENOENT",
    });
  });

  it("falls back to rawOutput.error when content[] has no text", () => {
    expect(
      mapUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "tc1",
        status: "failed",
        rawOutput: { error: "fallback error" },
      }),
    ).toEqual({
      kind: "tool-call-update",
      toolCallId: "tc1",
      status: "failed",
      errorText: "fallback error",
    });
  });

  it("flags upstreamInterrupted on rawOutput.metadata.interrupted===true", () => {
    expect(
      mapUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "tc1",
        status: "failed",
        content: [
          { type: "content", content: { type: "text", text: "Tool execution aborted" } },
        ],
        rawOutput: {
          error: "Tool execution aborted",
          metadata: { interrupted: true },
        },
      }),
    ).toEqual({
      kind: "tool-call-update",
      toolCallId: "tc1",
      status: "failed",
      errorText: "Tool execution aborted",
      upstreamInterrupted: true,
    });
  });

  it("flags upstreamInterrupted on 'Tool execution aborted' text without metadata", () => {
    expect(
      mapUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "tc1",
        status: "failed",
        content: [
          { type: "content", content: { type: "text", text: "Tool execution aborted" } },
        ],
      }),
    ).toEqual({
      kind: "tool-call-update",
      toolCallId: "tc1",
      status: "failed",
      errorText: "Tool execution aborted",
      upstreamInterrupted: true,
    });
  });

  it("does NOT flag upstreamInterrupted on a regular failed tool", () => {
    expect(
      mapUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "tc1",
        status: "failed",
        content: [{ type: "content", content: { type: "text", text: "ENOENT" } }],
      }),
    ).toEqual({
      kind: "tool-call-update",
      toolCallId: "tc1",
      status: "failed",
      errorText: "ENOENT",
    });
  });

  it("extracts editDiff from content[] type:\"diff\" on tool_call", () => {
    expect(
      mapUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "tc1",
        title: "Edit",
        content: [
          {
            type: "diff",
            path: "/repo/src/foo.ts",
            oldText: "old line\n",
            newText: "new line\n",
          },
        ],
      }),
    ).toEqual({
      kind: "tool-call",
      toolCallId: "tc1",
      title: "Edit",
      editDiff: {
        path: "/repo/src/foo.ts",
        oldText: "old line\n",
        newText: "new line\n",
      },
    });
  });

  it("falls back to rawInput.{old_string,new_string,file_path} for Claude's Edit tool", () => {
    expect(
      mapUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "tc1",
        title: "Edit",
        rawInput: {
          file_path: "/repo/src/foo.ts",
          old_string: "before",
          new_string: "after",
        },
      }),
    ).toEqual({
      kind: "tool-call",
      toolCallId: "tc1",
      title: "Edit",
      editDiff: {
        path: "/repo/src/foo.ts",
        oldText: "before",
        newText: "after",
      },
    });
  });

  it("treats Write's rawInput.{path,content} as a full-file insert (oldText empty)", () => {
    expect(
      mapUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "tc1",
        title: "Write",
        rawInput: {
          file_path: "/repo/new.ts",
          content: "export const x = 1;\n",
        },
      }),
    ).toEqual({
      kind: "tool-call",
      toolCallId: "tc1",
      title: "Write",
      editDiff: {
        path: "/repo/new.ts",
        oldText: "",
        newText: "export const x = 1;\n",
      },
    });
  });

  it("makes a tool_call_update meaningful when only an editDiff is present", () => {
    // claude-acp emits the canonical content[] diff on the
    // tool_call_update (status remains in_progress until a separate
    // terminal update). Without the diff-aware path the update would be
    // dropped as intermediate noise.
    expect(
      mapUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "tc1",
        content: [
          {
            type: "diff",
            path: "/repo/src/foo.ts",
            oldText: "a",
            newText: "b",
          },
        ],
      }),
    ).toEqual({
      kind: "tool-call-update",
      toolCallId: "tc1",
      editDiff: { path: "/repo/src/foo.ts", oldText: "a", newText: "b" },
    });
  });

  it("omits editDiff for non-edit tool calls", () => {
    expect(
      mapUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "tc1",
        title: "Read",
        rawInput: { file_path: "/repo/src/foo.ts" },
      }),
    ).toEqual({
      kind: "tool-call",
      toolCallId: "tc1",
      title: "Read",
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

  it("reads the hydra-acp amended marker from turn_complete _meta and surfaces it as amended: true", () => {
    expect(
      mapUpdate({
        sessionUpdate: "turn_complete",
        stopReason: "cancelled",
        _meta: {
          "hydra-acp": {
            amended: {
              cancelledMessageId: "m_old",
              newMessageId: "m_new",
            },
          },
        },
      }),
    ).toEqual({
      kind: "turn-complete",
      stopReason: "cancelled",
      amended: true,
    });
  });

  it("does NOT set amended for a normal turn_complete without the _meta marker", () => {
    expect(
      mapUpdate({ sessionUpdate: "turn_complete", stopReason: "cancelled" }),
    ).toEqual({ kind: "turn-complete", stopReason: "cancelled" });
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
      mapUpdate({ sessionUpdate: "some_future_kind", foo: "bar" }),
    ).toEqual({
      kind: "unknown",
      sessionUpdate: "some_future_kind",
      raw: { sessionUpdate: "some_future_kind", foo: "bar" },
    });
  });

  it("maps config_option_update into a config-options event, dropping malformed entries", () => {
    expect(
      mapUpdate({
        sessionUpdate: "config_option_update",
        configOptions: [
          {
            id: "agent",
            name: "Agent",
            category: "_hydra_agent",
            type: "select",
            currentValue: "claude-acp",
            options: [
              { value: "claude-acp", name: "Claude" },
              { value: "opencode" },
              "garbage",
              { name: "no-value" },
            ],
          },
          { id: "model" }, // missing currentValue/options → dropped
          "not-an-object",
        ],
      }),
    ).toEqual({
      kind: "config-options",
      options: [
        {
          id: "agent",
          name: "Agent",
          category: "_hydra_agent",
          type: "select",
          currentValue: "claude-acp",
          options: [
            { value: "claude-acp", name: "Claude" },
            { value: "opencode", name: "opencode" },
          ],
        },
      ],
    });
  });

  it("returns null for config_option_update without a configOptions array", () => {
    expect(
      mapUpdate({ sessionUpdate: "config_option_update", foo: "bar" }),
    ).toBeNull();
  });

  it("returns null for non-objects and missing tag", () => {
    expect(mapUpdate(null)).toBeNull();
    expect(mapUpdate(undefined)).toBeNull();
    expect(mapUpdate("hello")).toBeNull();
    expect(mapUpdate({})).toBeNull();
    expect(mapUpdate({ foo: "bar" })).toBeNull();
  });
});

describe("sanitizeWireText", () => {
  it("strips SGR color codes", () => {
    expect(sanitizeWireText("\x1b[31mhello\x1b[0m")).toBe("hello");
  });

  it("strips cursor positioning sequences", () => {
    expect(sanitizeWireText("before\x1b[10;5Hafter")).toBe("beforeafter");
  });

  it("strips erase-line / erase-display sequences", () => {
    expect(sanitizeWireText("clean\x1b[Kthis\x1b[2Jall")).toBe("cleanthisall");
  });

  it("strips OSC sequences", () => {
    expect(sanitizeWireText("\x1b]2;title\x07after")).toBe("after");
  });

  it("strips carriage returns and other C0 controls but keeps \\n and \\t", () => {
    expect(sanitizeWireText("a\rb\nc\td\x08e\x07f")).toBe("ab\nc\tdef");
  });

  it("strips DEL (0x7f)", () => {
    expect(sanitizeWireText("a\x7fb")).toBe("ab");
  });

  it("leaves ordinary text untouched", () => {
    expect(sanitizeWireText("hello world 中文 🇺🇸")).toBe("hello world 中文 🇺🇸");
  });
});

describe("mapUpdate sanitizes wire text", () => {
  it("sanitizes agent text", () => {
    const ev = mapUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "\x1b[31mred\x1b[0m" },
    });
    expect(ev).toEqual({ kind: "agent-text", text: "red" });
  });

  it("sanitizes tool-call title", () => {
    const ev = mapUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "ls\x1b[2J/home",
    });
    expect(ev).toMatchObject({ kind: "tool-call", title: "ls/home" });
  });

  it("sanitizes plan entry content", () => {
    const ev = mapUpdate({
      sessionUpdate: "plan",
      entries: [{ content: "step\x1b[1;1H1", status: "pending" }],
    });
    expect(ev).toEqual({
      kind: "plan",
      entries: [{ content: "step1", status: "pending" }],
    });
  });
});

describe("sanitizeSingleLine", () => {
  it("collapses newlines to spaces", () => {
    expect(sanitizeSingleLine("a\nb\nc")).toBe("a b c");
  });

  it("collapses tabs to spaces and squeezes runs of whitespace", () => {
    expect(sanitizeSingleLine("a\t\tb   c")).toBe("a b c");
  });

  it("strips ANSI and control chars (inherits from sanitizeWireText)", () => {
    expect(sanitizeSingleLine("\x1b[31mhello\x1b[0m\nworld")).toBe(
      "hello world",
    );
  });

  it("trims leading and trailing whitespace", () => {
    expect(sanitizeSingleLine("\n\n  hi  \n")).toBe("hi");
  });

  it("collapses a multi-line shell command into a single line", () => {
    const cmd = `python3 << 'EOF'\nimport json\nprint('hi')\nEOF`;
    const collapsed = sanitizeSingleLine(cmd);
    expect(collapsed.includes("\n")).toBe(false);
    expect(collapsed).toContain("python3");
    expect(collapsed).toContain("import json");
  });
});

describe("mapUpdate collapses multi-line tool titles", () => {
  it("collapses a heredoc shell command in the title", () => {
    const ev = mapUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "cat file | python3 -c \"\nimport sys, json\nprint(sys.stdin.read())\n\"",
    });
    expect(ev).toMatchObject({ kind: "tool-call" });
    const title = (ev as { title?: string }).title ?? "";
    expect(title.includes("\n")).toBe(false);
  });

  it("collapses multi-line plan content into a single body-safe row", () => {
    const ev = mapUpdate({
      sessionUpdate: "plan",
      entries: [{ content: "step one\nwith details\nand more", status: "pending" }],
    });
    const entries = (ev as { entries: { content: string }[] }).entries;
    expect(entries[0]?.content.includes("\n")).toBe(false);
  });

  it("promotes ExitPlanMode tool_call with rawInput.plan to exit-plan-mode", () => {
    expect(
      mapUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "tc-plan",
        name: "ExitPlanMode",
        status: "pending",
        rawInput: { plan: "## Step 1\n- do thing" },
      }),
    ).toEqual({
      kind: "exit-plan-mode",
      toolCallId: "tc-plan",
      plan: "## Step 1\n- do thing",
      status: "pending",
    });
  });

  it("accepts snake_case exit_plan_mode tool names", () => {
    const ev = mapUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "tc-plan",
      name: "exit_plan_mode",
      rawInput: { plan: "plan body" },
    });
    expect((ev as { kind: string }).kind).toBe("exit-plan-mode");
  });

  it("falls back to generic tool-call when ExitPlanMode lacks rawInput.plan", () => {
    expect(
      mapUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "tc-plan",
        name: "ExitPlanMode",
        status: "pending",
      }),
    ).toEqual({
      kind: "tool-call",
      toolCallId: "tc-plan",
      title: "ExitPlanMode",
      status: "pending",
    });
  });

  it("maps a terminal-status tool_call_update for ExitPlanMode to a status-only exit-plan-mode", () => {
    expect(
      mapUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-plan",
        name: "ExitPlanMode",
        status: "completed",
      }),
    ).toEqual({
      kind: "exit-plan-mode",
      toolCallId: "tc-plan",
      status: "completed",
    });
  });

  it("carries plan markdown on a tool_call_update when rawInput arrives late", () => {
    expect(
      mapUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-plan",
        name: "ExitPlanMode",
        status: "completed",
        rawInput: { plan: "late body" },
      }),
    ).toEqual({
      kind: "exit-plan-mode",
      toolCallId: "tc-plan",
      plan: "late body",
      status: "completed",
    });
  });

  it("sanitizes ANSI / control bytes from plan markdown", () => {
    const ev = mapUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "tc-plan",
      name: "ExitPlanMode",
      rawInput: { plan: "## \x1b[31mHeading\x1b[0m\n\x07bell" },
    });
    const plan = (ev as { plan: string }).plan;
    expect(plan).not.toMatch(/\x1b/);
    expect(plan).not.toMatch(/\x07/);
    expect(plan).toContain("Heading");
  });
});

describe("isExitPlanModeTool", () => {
  it("matches camelCase, snake_case, and mixed forms", () => {
    expect(isExitPlanModeTool("ExitPlanMode")).toBe(true);
    expect(isExitPlanModeTool("exit_plan_mode")).toBe(true);
    expect(isExitPlanModeTool("exit-plan-mode")).toBe(true);
    expect(isExitPlanModeTool("EXITPLANMODE")).toBe(true);
    expect(isExitPlanModeTool("Exit Plan Mode")).toBe(true);
  });

  it("rejects unrelated names and empty input", () => {
    expect(isExitPlanModeTool(undefined)).toBe(false);
    expect(isExitPlanModeTool("")).toBe(false);
    expect(isExitPlanModeTool("ExitPlanModeX")).toBe(false);
    expect(isExitPlanModeTool("Read file")).toBe(false);
  });
});
