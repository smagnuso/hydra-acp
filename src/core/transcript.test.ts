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
    expect(md).toContain("## Turn 1");
    expect(md).toContain("**User:**");
    expect(md).toContain("> hello");
    expect(md).toContain("**Assistant:**");
    expect(md).toContain("hi there");
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

  it("starts a new turn on each prompt_received", () => {
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
    expect(md).toContain("## Turn 1");
    expect(md).toContain("## Turn 2");
    expect(md.indexOf("## Turn 1")).toBeLessThan(md.indexOf("## Turn 2"));
    expect(md.indexOf("a1")).toBeLessThan(md.indexOf("## Turn 2"));
    expect(md.indexOf("a2")).toBeGreaterThan(md.indexOf("## Turn 2"));
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
          status: "in_progress",
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
    // Pending / in_progress badges shouldn't leak into the final output.
    expect(md).not.toContain("↻ Read");
    expect(md).not.toContain("· Read");
  });

  it("marks failed tool calls with ✗ and a status suffix", () => {
    const md = bundleToMarkdown(
      makeBundle([
        update({ sessionUpdate: "prompt_received", prompt: [{ type: "text", text: "p" }] }),
        update({
          sessionUpdate: "tool_call",
          toolCallId: "tc1",
          title: "Bash boom",
        }),
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

  it("emits agent thoughts as italic blockquote lines", () => {
    const md = bundleToMarkdown(
      makeBundle([
        update({ sessionUpdate: "prompt_received", prompt: [{ type: "text", text: "p" }] }),
        update({ sessionUpdate: "agent_thought", text: "thinking quietly" }),
      ]),
    );
    expect(md).toContain("> _thinking quietly_");
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
    expect(md).toContain("> p");
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
