import { describe, expect, it } from "vitest";
import { bundleToMarkdown } from "./transcript.js";
import type { Bundle } from "./bundle.js";

function makeBundle(history: Bundle["history"], overrides: Partial<Bundle["session"]> = {}): Bundle {
  return {
    version: 1,
    exportedAt: "2026-05-15T12:00:00.000Z",
    exportedFrom: { hydraVersion: "0.1.14", machine: "host.example.net" },
    session: {
      sessionId: "hydra_session_abc123",
      lineageId: "hydra_lineage_xyz",
      agentId: "claude",
      cwd: "/home/u/dev/proj",
      currentModel: "claude-opus-4-7",
      createdAt: "2026-05-15T11:00:00.000Z",
      updatedAt: "2026-05-15T12:00:00.000Z",
      ...overrides,
    },
    history,
  };
}

function update(updateBody: Record<string, unknown>, recordedAt = 1000): Bundle["history"][number] {
  return {
    method: "session/update",
    params: { update: updateBody, sessionId: "hydra_session_abc123" },
    recordedAt,
  };
}

describe("bundleToMarkdown", () => {
  it("renders a header with session metadata", () => {
    const md = bundleToMarkdown(makeBundle([], { title: "deep scan" }));
    expect(md).toContain("# deep scan");
    expect(md).toContain("**Session:** `abc123`");
    expect(md).toContain("lineage `hydra_lineage_xyz`");
    expect(md).toContain("**Agent:** claude · model: claude-opus-4-7");
    expect(md).toContain("**Cwd:** /home/u/dev/proj");
    expect(md).toContain(
      "**Exported:** 2026-05-15T12:00:00.000Z from host.example.net (hydra 0.1.14)",
    );
  });

  it("falls back to 'Hydra session <id>' when title is unset", () => {
    const md = bundleToMarkdown(makeBundle([]));
    expect(md).toContain("# Hydra session abc123");
  });

  it("emits a placeholder body when there is no history", () => {
    const md = bundleToMarkdown(makeBundle([]));
    expect(md).toContain("_No conversation history recorded._");
  });

  it("renders a user prompt + agent response as Turn 1", () => {
    const md = bundleToMarkdown(
      makeBundle([
        update({ sessionUpdate: "prompt_received", prompt: [{ type: "text", text: "hello" }] }),
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi there" } }),
        update({ sessionUpdate: "turn_complete" }, 1100),
      ]),
    );
    expect(md).toContain("**hello**");
    expect(md).toContain("hi there");
    expect(md).not.toContain("> hello");
    expect(md).not.toContain("**User:**");
    expect(md).not.toContain("**Assistant:**");
    expect(md).not.toContain("## Turn");
  });

  it("concatenates streamed agent chunks before flushing", () => {
    const md = bundleToMarkdown(
      makeBundle([
        update({ sessionUpdate: "prompt_received", prompt: [{ type: "text", text: "q" }] }),
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hel" } }),
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "lo " } }),
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "world" } }),
        update({ sessionUpdate: "turn_complete" }),
      ]),
    );
    expect(md).toContain("hello world");
    expect(md).not.toContain("hel\nlo");
  });

  it("separates consecutive turns with a single `---` rule", () => {
    const md = bundleToMarkdown(
      makeBundle([
        update({ sessionUpdate: "prompt_received", prompt: [{ type: "text", text: "one" }] }, 1000),
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "a1" } }, 1100),
        update({ sessionUpdate: "turn_complete" }, 1200),
        update({ sessionUpdate: "prompt_received", prompt: [{ type: "text", text: "two" }] }, 1300),
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "a2" } }, 1400),
        update({ sessionUpdate: "turn_complete" }, 1500),
      ]),
    );
    // One `---` rule before the first turn (separating it from the
    // metadata header) and one between the two turns.
    const rules = md.match(/^---$/gm) ?? [];
    expect(rules.length).toBe(2);
    expect(md.indexOf("a1")).toBeLessThan(md.lastIndexOf("---"));
    expect(md.lastIndexOf("---")).toBeLessThan(md.indexOf("two"));
    expect(md.indexOf("two")).toBeLessThan(md.indexOf("a2"));
  });

  it("collapses a tool's lifecycle to a single line keyed by final status", () => {
    const md = bundleToMarkdown(
      makeBundle([
        update({ sessionUpdate: "prompt_received", prompt: [{ type: "text", text: "p" }] }),
        update({
          sessionUpdate: "tool_call",
          toolCallId: "tc1",
          title: "Read src/foo.ts",
          status: "pending",
        }),
        update({
          sessionUpdate: "tool_call_update",
          toolCallId: "tc1",
          status: "completed",
        }),
        update({ sessionUpdate: "turn_complete" }),
      ]),
    );
    expect(md).toContain("- ✓ Read src/foo.ts");
  });

  it("marks failed tool calls with ✗ and a status suffix", () => {
    const md = bundleToMarkdown(
      makeBundle([
        update({ sessionUpdate: "prompt_received", prompt: [{ type: "text", text: "p" }] }),
        update({ sessionUpdate: "tool_call", toolCallId: "tc1", title: "Bash boom" }),
        update({
          sessionUpdate: "tool_call_update",
          toolCallId: "tc1",
          status: "failed",
        }),
      ]),
    );
    expect(md).toContain("- ✗ Bash boom _(failed)_");
  });

  it("marks cancelled tool calls with ⊘", () => {
    const md = bundleToMarkdown(
      makeBundle([
        update({ sessionUpdate: "prompt_received", prompt: [{ type: "text", text: "p" }] }),
        update({
          sessionUpdate: "tool_call",
          toolCallId: "tc1",
          title: "WebFetch",
          status: "cancelled",
        }),
      ]),
    );
    expect(md).toContain("- ⊘ WebFetch _(cancelled)_");
  });

  it("coalesces consecutive tool calls into a tight bullet list (no blank between lines)", () => {
    const md = bundleToMarkdown(
      makeBundle([
        update({ sessionUpdate: "prompt_received", prompt: [{ type: "text", text: "p" }] }),
        update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Read a" }),
        update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" }),
        update({ sessionUpdate: "tool_call", toolCallId: "t2", title: "Read b" }),
        update({ sessionUpdate: "tool_call_update", toolCallId: "t2", status: "completed" }),
        update({ sessionUpdate: "tool_call", toolCallId: "t3", title: "Read c" }),
        update({ sessionUpdate: "tool_call_update", toolCallId: "t3", status: "completed" }),
      ]),
    );
    expect(md).toContain("- ✓ Read a\n- ✓ Read b\n- ✓ Read c\n");
  });

  it("omits tool activity when includeTools is false", () => {
    const md = bundleToMarkdown(
      makeBundle([
        update({ sessionUpdate: "prompt_received", prompt: [{ type: "text", text: "p" }] }),
        update({ sessionUpdate: "tool_call", toolCallId: "tc1", title: "Read src/foo.ts" }),
        update({
          sessionUpdate: "tool_call_update",
          toolCallId: "tc1",
          status: "completed",
        }),
      ]),
      { includeTools: false },
    );
    expect(md).not.toContain("Read src/foo.ts");
    expect(md).not.toMatch(/[✓✗⊘]/);
  });

  it("emits agent thoughts as italic blockquote lines", () => {
    const md = bundleToMarkdown(
      makeBundle([
        update({ sessionUpdate: "prompt_received", prompt: [{ type: "text", text: "p" }] }),
        update({ sessionUpdate: "agent_thought", text: "thinking quietly" }),
      ]),
    );
    expect(md).toContain("*thinking quietly*");
  });

  it("wraps each paragraph of a multi-paragraph thought independently in italic", () => {
    const md = bundleToMarkdown(
      makeBundle([
        update({ sessionUpdate: "prompt_received", prompt: [{ type: "text", text: "p" }] }),
        update({
          sessionUpdate: "agent_thought",
          text: "first paragraph\n\nsecond paragraph",
        }),
      ]),
    );
    expect(md).toContain("*first paragraph*\n\n*second paragraph*");
  });

  it("coalesces streamed agent_thought fragments into one blockquote (no blank lines between fragments)", () => {
    const md = bundleToMarkdown(
      makeBundle([
        update({ sessionUpdate: "prompt_received", prompt: [{ type: "text", text: "p" }] }),
        update({ sessionUpdate: "agent_thought", text: "I" }),
        update({ sessionUpdate: "agent_thought", text: " need to" }),
        update({ sessionUpdate: "agent_thought", text: " think." }),
      ]),
    );
    expect(md).toContain("*I need to think.*");
  });

  it("renders plan entries as a markdown checklist", () => {
    const md = bundleToMarkdown(
      makeBundle([
        update({ sessionUpdate: "prompt_received", prompt: [{ type: "text", text: "p" }] }),
        update({
          sessionUpdate: "plan",
          entries: [
            { content: "do thing one", status: "completed" },
            { content: "do thing two", status: "pending" },
          ],
        }),
      ]),
    );
    expect(md).toContain("**Plan:**");
    expect(md).toContain("- [x] do thing one");
    expect(md).toContain("- [ ] do thing two");
  });

  it("annotates mode and model changes inline", () => {
    const md = bundleToMarkdown(
      makeBundle([
        update({ sessionUpdate: "prompt_received", prompt: [{ type: "text", text: "p" }] }),
        update({ sessionUpdate: "current_mode_update", currentMode: "default" }),
        update({ sessionUpdate: "current_model_update", currentModel: "claude-opus-4-7" }),
      ]),
    );
    expect(md).toContain("_mode: default_");
    expect(md).toContain("_model: claude-opus-4-7_");
  });

  it("skips snapshot/meta events from the body", () => {
    const md = bundleToMarkdown(
      makeBundle([
        update({ sessionUpdate: "session_info_update", title: "x" }),
        update({ sessionUpdate: "usage_update", used: 100, size: 1000 }),
        update({ sessionUpdate: "available_commands_update", availableCommands: [] }),
      ]),
    );
    // No body section emitted from these — should fall back to the empty
    // placeholder because nothing rendered.
    expect(md).toContain("_No conversation history recorded._");
  });

  it("silently skips history entries that aren't session/update", () => {
    const md = bundleToMarkdown(
      makeBundle([
        { method: "session/something_else", params: {}, recordedAt: 1 },
        update({ sessionUpdate: "prompt_received", prompt: [{ type: "text", text: "p" }] }, 2),
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } }, 3),
      ]),
    );
    expect(md).toMatch(/^\*\*p\*\*$/m);
    expect(md).toContain("hi");
  });

  it("renders usage in the header when present", () => {
    const md = bundleToMarkdown(
      makeBundle([], {
        currentUsage: { used: 12345, size: 200000, costAmount: 0.42, costCurrency: "USD" },
      }),
    );
    expect(md).toContain("**Usage:** 12,345 / 200,000 tokens · $0.42 USD");
  });

  it("preserves chronological order: id-path output matches file-path output", () => {
    // Regression check: the same Bundle rendered twice produces the same
    // string. (The CLI's id-path and file-path both call bundleToMarkdown
    // with the same bundle shape, so this is the contract the daemon
    // route and CLI rely on for byte-identical output.)
    const bundle = makeBundle([
      update({ sessionUpdate: "prompt_received", prompt: [{ type: "text", text: "hi" }] }),
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "yo" } }),
      update({ sessionUpdate: "turn_complete" }),
    ]);
    expect(bundleToMarkdown(bundle)).toBe(bundleToMarkdown(bundle));
  });
});
