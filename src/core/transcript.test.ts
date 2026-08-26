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

  it("collapses a tool's lifecycle to a single line keyed by final status (includeTools=true)", () => {
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
      { includeTools: true },
    );
    expect(md).toContain("- ✓ Read src/foo.ts");
  });

  it("marks failed tool calls with ✗ and a status suffix (includeTools=true)", () => {
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
      { includeTools: true },
    );
    expect(md).toContain("- ✗ Bash boom _(failed)_");
  });

  it("marks cancelled tool calls with ⊘ (includeTools=true)", () => {
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
      { includeTools: true },
    );
    expect(md).toContain("- ⊘ WebFetch _(cancelled)_");
  });

  it("coalesces consecutive tool calls into a tight bullet list (includeTools=true)", () => {
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
      { includeTools: true },
    );
    expect(md).toContain("- ✓ Read a\n- ✓ Read b\n- ✓ Read c\n");
  });

  it("omits tool activity by default", () => {
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
    );
    expect(md).not.toContain("Read src/foo.ts");
    expect(md).not.toMatch(/[✓✗⊘]/);
  });

  it("omits agent thoughts by default", () => {
    const md = bundleToMarkdown(
      makeBundle([
        update({ sessionUpdate: "prompt_received", prompt: [{ type: "text", text: "p" }] }),
        update({ sessionUpdate: "agent_thought", text: "thinking quietly" }),
      ]),
    );
    expect(md).not.toContain("thinking quietly");
  });

  it("emits agent thoughts as italic blockquote lines with includeThoughts", () => {
    const md = bundleToMarkdown(
      makeBundle([
        update({ sessionUpdate: "prompt_received", prompt: [{ type: "text", text: "p" }] }),
        update({ sessionUpdate: "agent_thought", text: "thinking quietly" }),
      ]),
      { includeThoughts: true },
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
      { includeThoughts: true },
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
      { includeThoughts: true },
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
        update({ sessionUpdate: "_hydra_current_model_update", currentModel: "claude-opus-4-7" }),
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

  describe("windowing", () => {
    // Five turns, each one prompt + one reply, recorded a second apart
    // so the --since tests have something to bite on.
    function fiveTurns(): Bundle {
      const history: Bundle["history"] = [];
      for (let i = 1; i <= 5; i += 1) {
        const t = 1000 + i * 1000;
        history.push(
          update(
            {
              sessionUpdate: "prompt_received",
              prompt: [{ type: "text", text: `ask ${i}` }],
            },
            t,
          ),
          update(
            {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: `reply ${i}` },
            },
            t + 100,
          ),
          update({ sessionUpdate: "turn_complete" }, t + 200),
        );
      }
      return makeBundle(history);
    }

    it("renders every turn when no window is requested", () => {
      const md = bundleToMarkdown(fiveTurns());
      for (let i = 1; i <= 5; i += 1) {
        expect(md).toContain(`ask ${i}`);
      }
      expect(md).not.toContain("Showing turns");
    });

    it("--last keeps only the final n turns", () => {
      const md = bundleToMarkdown(fiveTurns(), { last: 2 });
      expect(md).not.toContain("ask 3");
      expect(md).toContain("ask 4");
      expect(md).toContain("ask 5");
      expect(md).toContain("_Showing turns 4-5 of 5._");
    });

    it("negative from counts back from the end", () => {
      const md = bundleToMarkdown(fiveTurns(), { from: -2 });
      expect(md).not.toContain("ask 3");
      expect(md).toContain("ask 4");
      expect(md).toContain("ask 5");
    });

    it("from/to select a middle slice, inclusive on both ends", () => {
      const md = bundleToMarkdown(fiveTurns(), { from: 2, to: 3 });
      expect(md).not.toContain("ask 1");
      expect(md).toContain("ask 2");
      expect(md).toContain("ask 3");
      expect(md).not.toContain("ask 4");
      expect(md).toContain("_Showing turns 2-3 of 5._");
    });

    it("clamps an over-long window instead of erroring", () => {
      const md = bundleToMarkdown(fiveTurns(), { last: 99 });
      expect(md).toContain("ask 1");
      expect(md).toContain("ask 5");
      expect(md).not.toContain("Showing turns");
    });

    it("sinceMs keeps turns with activity at or after the cutoff", () => {
      // Turn 4 starts at 5000; anything at/after that is turns 4 and 5.
      const md = bundleToMarkdown(fiveTurns(), { sinceMs: 5000 });
      expect(md).not.toContain("ask 3");
      expect(md).toContain("ask 4");
      expect(md).toContain("ask 5");
    });

    it("says which turns a slice covers so it cannot read as a short session", () => {
      const md = bundleToMarkdown(fiveTurns(), { last: 1 });
      expect(md).toContain("_Showing turns 5-5 of 5._");
    });

    it("renders an inverted window as empty rather than throwing", () => {
      const md = bundleToMarkdown(fiveTurns(), { from: 4, to: 2 });
      expect(md).toContain("_No conversation history recorded._");
    });
  });

  describe("angle brackets", () => {
    function withPrompt(text: string): string {
      return bundleToMarkdown(
        makeBundle([
          update({ sessionUpdate: "prompt_received", prompt: [{ type: "text", text }] }),
        ]),
      );
    }

    it("fences a prompt with tag-shaped runs and leaves the brackets literal", () => {
      const md = withPrompt("netflix::Atomic<int>::modify(int)\n  <nrdp>/include/Atomic.h:86");
      expect(md).not.toContain("&lt;");
      expect(md).not.toContain("&gt;");
      expect(md).toContain("netflix::Atomic<int>::modify(int)");
      expect(md).toContain("<nrdp>/include/Atomic.h:86");
      expect(md).toContain("```\nnetflix::Atomic<int>");
    });

    it("keeps bold for a prompt with no tag-shaped runs", () => {
      const md = withPrompt("why is this slow?");
      expect(md).toContain("**why is this slow?**");
    });

    it("does not fence on `<=`, which no renderer reads as a tag", () => {
      const md = withPrompt("assert x <= y and y >= z");
      expect(md).toContain("**assert x <= y and y >= z**");
    });

    it("outruns an embedded fence so the block cannot close early", () => {
      const md = withPrompt("look:\n```\nvector<int> v;\n```\nwhy?");
      expect(md).toContain("````\nlook:");
      expect(md).toContain("vector<int> v;");
      expect(md).toContain("\n````");
    });

    it("escapes only the tag-shaped run in an inline context like a title", () => {
      const md = bundleToMarkdown(makeBundle([], { title: "crash in Atomic<int> <== here" }));
      expect(md).toContain("# crash in Atomic&lt;int&gt; <== here");
    });
  });
});
