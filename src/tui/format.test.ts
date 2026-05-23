import { describe, expect, it } from "vitest";
import stringWidth from "string-width";
import {
  formatEvent,
  formatExitPlanMode,
  formatToolLine,
  parseAgentMarkdown,
  type FormattedLine,
} from "./format.js";

// Measure the on-screen width of a rendered table line. Mirrors what
// the screen layer eventually writes: prefix + body, with terminal-kit
// caret-markup tokens (^X, ^+, ^C, ^:, doubled ^^) removed because
// they're zero-width style commands when the agent bodyStyle is
// interpreted via term(text). The escape `^^` -> `^` is unwound first
// so a literal caret survives the strip.
function visibleWidth(line: FormattedLine): number {
  const text = (line.prefix ?? "") + line.body;
  const stripped = text
    .replace(/\^\^/g, "\u0000")
    .replace(/\^[+CRGBMYWcrgbmyw:]/g, "")
    .replace(/\u0000/g, "^");
  return stringWidth(stripped);
}

const ESC = "";

describe("parseAgentMarkdown", () => {
  it("renders prose lines with agent style and no ansi flag", () => {
    const lines = parseAgentMarkdown("hello world\nhow are you");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      body: "hello world",
      bodyStyle: "agent",
    });
    expect(lines[0]?.ansi).toBeUndefined();
  });

  it("renders an unlabeled code fence as plain code, no ansi flag", () => {
    const lines = parseAgentMarkdown("```\nplain code\nmore code\n```");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.bodyStyle).toBe("code");
      expect(line.fillRow).toBe(true);
      expect(line.ansi).toBeUndefined();
      expect(line.body).not.toContain(ESC);
    }
    expect(lines[0]?.body).toBe("plain code");
    expect(lines[1]?.body).toBe("more code");
  });

  it("highlights a ```diff block — +/- lines carry ANSI", () => {
    const lines = parseAgentMarkdown(
      "```diff\n- old line\n+ new line\n@@ -1,1 +1,1 @@\n```",
    );
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line.bodyStyle).toBe("code");
    }
    // - old line: deletion (red)
    expect(lines[0]?.ansi).toBe(true);
    expect(lines[0]?.body).toContain(ESC);
    // + new line: addition (green)
    expect(lines[1]?.ansi).toBe(true);
    expect(lines[1]?.body).toContain(ESC);
    // @@ ... @@ hunk header: meta (magenta)
    expect(lines[2]?.ansi).toBe(true);
    expect(lines[2]?.body).toContain(ESC);
  });

  it("highlights ```javascript blocks with ANSI", () => {
    const lines = parseAgentMarkdown("```javascript\nconst x = 1;\n```");
    expect(lines).toHaveLength(1);
    expect(lines[0]?.ansi).toBe(true);
    expect(lines[0]?.body).toContain(ESC);
  });

  it("highlights ```typescript blocks — lines with recognized tokens carry ANSI", () => {
    const lines = parseAgentMarkdown(
      "```typescript\nfunction foo(x: number) {\n  return x + 1;\n}\n```",
    );
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line.bodyStyle).toBe("code");
    }
    // At least one line must have been highlighted to prove the
    // highlighter ran. Lines with no recognized tokens (a bare `}`)
    // can legitimately come back unchanged — that's intentional.
    expect(lines.some((l) => l.ansi === true)).toBe(true);
    expect(lines.some((l) => l.body.includes(ESC))).toBe(true);
  });

  it("highlights ```cpp blocks — lines with recognized tokens carry ANSI", () => {
    const lines = parseAgentMarkdown(
      "```cpp\n#include <iostream>\nint main() { return 0; }\n```",
    );
    expect(lines).toHaveLength(2);
    expect(lines.some((l) => l.ansi === true)).toBe(true);
    expect(lines.some((l) => l.body.includes(ESC))).toBe(true);
  });

  it("falls back to plain code for unknown language tag", () => {
    const lines = parseAgentMarkdown(
      "```nonsensenotalang\nsome text\nmore text\n```",
    );
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.bodyStyle).toBe("code");
      expect(line.ansi).toBeUndefined();
      expect(line.body).not.toContain(ESC);
    }
  });

  it("emits highlighted lines mid-stream when the closing fence hasn't arrived", () => {
    // Simulates a chunk that opens a fence and emits content but hasn't
    // closed yet — parseAgentMarkdown is re-run on every chunk against
    // the full accumulated buffer, so the in-progress code must still
    // render as code (and be highlighted when a known lang is present).
    const lines = parseAgentMarkdown("```diff\n- old\n+ new");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.bodyStyle).toBe("code");
      expect(line.ansi).toBe(true);
    }
  });

  it("does not apply ansi to interleaved prose, only to code-block lines", () => {
    const lines = parseAgentMarkdown(
      "prose line\n```diff\n- old\n```\nmore prose",
    );
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ body: "prose line", bodyStyle: "agent" });
    expect(lines[0]?.ansi).toBeUndefined();
    expect(lines[1]?.bodyStyle).toBe("code");
    expect(lines[1]?.ansi).toBe(true);
    expect(lines[2]).toMatchObject({
      body: "more prose",
      bodyStyle: "agent",
    });
    expect(lines[2]?.ansi).toBeUndefined();
  });

  it("renders a basic 2-column pipe table aligned by widest cell", () => {
    const lines = parseAgentMarkdown(
      "| Subscriber concern | Subscribes to |\n|---|---|\n| Queue chip rendering | prompt_queue_added |\n| Turn lifecycle | turn_complete |",
    );
    expect(lines).toHaveLength(4);
    expect(lines[0]?.bodyStyle).toBe("heading-3");
    expect(lines[0]?.body).toBe("Subscriber concern   │ Subscribes to     ");
    expect(lines[1]?.bodyStyle).toBe("dim");
    expect(lines[1]?.body).toBe("─────────────────────┼───────────────────");
    expect(lines[2]?.bodyStyle).toBe("agent");
    expect(lines[2]?.body).toBe("Queue chip rendering │ prompt_queue_added");
    expect(lines[3]?.body).toBe("Turn lifecycle       │ turn_complete     ");
  });

  it("does NOT treat a stray `a | b` in prose as a table", () => {
    const lines = parseAgentMarkdown("here is a thing: a | b in a sentence");
    expect(lines).toHaveLength(1);
    expect(lines[0]?.bodyStyle).toBe("agent");
    expect(lines[0]?.body).toBe("here is a thing: a | b in a sentence");
  });

  it("renders mid-stream: header + separator with no body rows yet", () => {
    const lines = parseAgentMarkdown("| a | b |\n|---|---|");
    expect(lines).toHaveLength(2);
    expect(lines[0]?.bodyStyle).toBe("heading-3");
    expect(lines[0]?.body).toBe("a │ b");
    expect(lines[1]?.bodyStyle).toBe("dim");
    expect(lines[1]?.body).toBe("──┼──");
  });

  it("accepts tables without outer pipes", () => {
    const lines = parseAgentMarkdown("a | b\n---|---\nfoo | bar");
    expect(lines).toHaveLength(3);
    expect(lines[0]?.bodyStyle).toBe("heading-3");
    expect(lines[0]?.body).toBe("a   │ b  ");
    expect(lines[2]?.bodyStyle).toBe("agent");
    expect(lines[2]?.body).toBe("foo │ bar");
  });

  it("widens column to fit the widest body cell", () => {
    const lines = parseAgentMarkdown(
      "| a | b |\n|---|---|\n| short | a_much_longer_value |",
    );
    expect(lines[0]?.body).toBe("a     │ b                  ");
    expect(lines[2]?.body).toBe("short │ a_much_longer_value");
  });

  it("ignores GFM alignment markers (renders left-aligned) but accepts them as a valid separator", () => {
    const lines = parseAgentMarkdown(
      "| a | b |\n| :--- | ---: |\n| x | y |",
    );
    expect(lines).toHaveLength(3);
    expect(lines[0]?.bodyStyle).toBe("heading-3");
    expect(lines[2]?.body).toBe("x │ y");
  });

  // Alignment regression coverage. Pre-fix, formatTable measured cell
  // widths with .length (UTF-16 code units) and padded by .length, so
  // any cell whose visible width != code-point count produced rows
  // that drifted out of column with the header / separator. The
  // expectation here is that every emitted line of a table block has
  // the same on-screen width.
  it("aligns columns when cells contain non-ASCII (→ rightwards arrow)", () => {
    const lines = parseAgentMarkdown(
      "| a | b |\n|---|---|\n| client→server | x |\n| short | server→client |",
    );
    const widths = lines.map(visibleWidth);
    expect(new Set(widths).size).toBe(1);
  });

  it("aligns columns when cells contain **bold** and `code` markdown", () => {
    const lines = parseAgentMarkdown(
      "| a | b |\n|---|---|\n| **bold cell** | plain |\n| plain | `code cell` |",
    );
    const widths = lines.map(visibleWidth);
    expect(new Set(widths).size).toBe(1);
    // Bold body cell renders via applyInlineMarkup (^+...^:).
    expect(lines[2]?.body).toContain("^+bold cell^:");
    // Code body cell renders via applyInlineMarkup (^C...^:).
    expect(lines[3]?.body).toContain("^Ccode cell^:");
  });

  it("does NOT apply inline markup to header cells (heading-3 writes literally)", () => {
    // applyInlineMarkup is suppressed for the header so heading-3
    // lines (rendered through term.bold.noFormat) don't leak literal
    // `^+` / `^:` into the user's terminal.
    const lines = parseAgentMarkdown(
      "| **bold header** | b |\n|---|---|\n| x | y |",
    );
    expect(lines[0]?.bodyStyle).toBe("heading-3");
    expect(lines[0]?.body).not.toContain("^+");
    expect(lines[0]?.body).not.toContain("^:");
    expect(lines[0]?.body).toContain("**bold header**");
    const widths = lines.map(visibleWidth);
    expect(new Set(widths).size).toBe(1);
  });

  it("aligns columns when cells contain *italic* markers (rendered literally)", () => {
    // applyInlineMarkup doesn't process *…*, so the asterisks render
    // literally and contribute to visible width. The padding math
    // must account for them.
    const lines = parseAgentMarkdown(
      "| a | b |\n|---|---|\n| *italic cell* | plain |\n| plain | other |",
    );
    const widths = lines.map(visibleWidth);
    expect(new Set(widths).size).toBe(1);
    expect(lines[2]?.body).toContain("*italic cell*");
  });

  it("aligns columns when cells contain wide glyphs (✓ check mark)", () => {
    const lines = parseAgentMarkdown(
      "| feature | ok |\n|---|---|\n| basic | ✓ |\n| longer feature name | ✓ |",
    );
    const widths = lines.map(visibleWidth);
    expect(new Set(widths).size).toBe(1);
  });

  // Regression: the exact RFD audit table the agent emitted in
  // session hydra_session_w5CYtGbWRDnGOLVa (messageId
  // msg_e4d229630001llp4x7sqsGbWms, lines ~62-74 of the reconstructed
  // markdown), which surfaced the original alignment bug. Inlined
  // verbatim — do not "clean up" the unicode (→, em-dash) or the
  // *italic* markers; they're exactly what triggered the misalign.
  it("aligns the RFD audit table from hydra_session_w5CYtGbWRDnGOLVa", () => {
    const table = [
      "| RFD requirement | hydra-acp | Status |",
      "|---|---|---|",
      "| `POST /acp` with `application/json` for client→server | Not implemented | **Doesn't implement** (server WS-only — allowed) |",
      "| `GET /acp` SSE stream (connection-scoped) | Not implemented | **Doesn't implement** |",
      "| `GET /acp` SSE stream (session-scoped) | Not implemented | **Doesn't implement** |",
      "| `DELETE /acp` to terminate connection | Not implemented | **Doesn't implement** |",
      "| `Acp-Connection-Id` / `Acp-Session-Id` headers | Not implemented anywhere | **Doesn't implement** |",
      "| `Acp-Protocol-Version` header | Not implemented | **Doesn't implement** (RFD itself defers this to Phase 4) |",
      "| Cookie support for sticky sessions | Not implemented | **Doesn't implement** (RFD makes this a *client* MUST, not server) |",
      "| `initialize` returns 200+JSON over HTTP | N/A — hydra has no HTTP transport | **Doesn't implement** |",
      "| Other POSTs return 202 Accepted | N/A | **Doesn't implement** |",
      "| HTTP/2 required for Streamable HTTP | N/A; hydra serves WS over HTTP/1.1 upgrade, which is fine for the WS profile | **Doesn't implement** |",
      "| Batch JSON-RPC returns 501 | hydra doesn't have a batch path at all | **N/A** |",
    ].join("\n");
    const lines = parseAgentMarkdown(table);
    // header + separator + 11 body rows = 13.
    expect(lines).toHaveLength(13);
    expect(lines[0]?.bodyStyle).toBe("heading-3");
    expect(lines[1]?.bodyStyle).toBe("dim");
    for (let i = 2; i < lines.length; i++) {
      expect(lines[i]?.bodyStyle).toBe("agent");
    }
    const widths = lines.map(visibleWidth);
    expect(
      new Set(widths).size,
      `expected all rows equal width, got widths ${widths.join(",")}`,
    ).toBe(1);
  });
});

describe("formatEvent — user-text with attachments", () => {
  it("appends one thumbnail line per attachment after the text body", () => {
    const lines = formatEvent({
      kind: "user-text",
      text: "look at this",
      attachments: [
        { mimeType: "image/png", data: "AAAA", name: "a.png", sizeBytes: 3 },
        { mimeType: "image/jpeg", data: "BBBB", name: "b.jpg", sizeBytes: 5 },
      ],
    });
    expect(lines).toHaveLength(3);
    expect(lines[0]?.body).toBe("look at this");
    expect(lines[1]?.body).toBe("📎 a.png");
    expect(lines[1]?.iterm2Image).toEqual({ data: "AAAA", heightCells: 5 });
    expect(lines[2]?.body).toBe("📎 b.jpg");
    expect(lines[2]?.iterm2Image).toEqual({ data: "BBBB", heightCells: 5 });
  });

  it("emits the text body unchanged when there are no attachments", () => {
    const lines = formatEvent({ kind: "user-text", text: "plain" });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.body).toBe("plain");
    expect(lines[0]?.iterm2Image).toBeUndefined();
  });
});

describe("formatToolLine", () => {
  it("returns a single line for a non-failed tool", () => {
    const lines = formatToolLine({
      initialTitle: "Terminal",
      latestTitle: "ls -la",
      status: "completed",
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.body).toBe("Terminal · ls -la");
  });

  it("appends an indented error line when status=failed and errorText present", () => {
    const lines = formatToolLine({
      initialTitle: "task",
      latestTitle: "task",
      status: "failed",
      errorText: "Tool execution aborted",
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]?.body).toBe("task");
    expect(lines[0]?.bodyStyle).toBe("tool-status-fail");
    expect(lines[1]?.body).toBe("Tool execution aborted");
    expect(lines[1]?.bodyStyle).toBe("tool-status-fail");
    expect(lines[1]?.prefix).toBe("     ");
  });

  it("returns one line when status=failed but errorText is missing", () => {
    const lines = formatToolLine({
      initialTitle: "task",
      latestTitle: "task",
      status: "failed",
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.body).toBe("task");
  });

  it("does not emit an error line when status is not failed even with errorText set", () => {
    const lines = formatToolLine({
      initialTitle: "task",
      latestTitle: "task",
      status: "completed",
      errorText: "stale text",
    });
    expect(lines).toHaveLength(1);
  });

  it("collapses multi-line errorText to a single line", () => {
    const lines = formatToolLine({
      initialTitle: "task",
      latestTitle: "task",
      status: "failed",
      errorText: "line one\nline two\tline three",
    });
    expect(lines).toHaveLength(2);
    expect(lines[1]?.body).toBe("line one line two line three");
  });
});

describe("formatExitPlanMode", () => {
  it("renders a Plan header followed by parsed markdown body", () => {
    const lines = formatExitPlanMode({
      plan: "## Step 1\n- do thing\n- do other",
    });
    expect(lines[0]).toMatchObject({ body: "Plan", bodyStyle: "plan" });
    expect(lines[1]).toMatchObject({ body: "Step 1", bodyStyle: "heading-2" });
    expect(lines[2]?.body).toContain("• do thing");
    expect(lines[3]?.body).toContain("• do other");
  });

  it("appends an awaiting-approval footer when status is pending", () => {
    const lines = formatExitPlanMode({ plan: "body", status: "pending" });
    expect(lines.at(-1)).toMatchObject({
      body: "awaiting approval…",
      bodyStyle: "dim",
    });
  });

  it("appends ✓ Approved on completed status", () => {
    const lines = formatExitPlanMode({ plan: "body", status: "completed" });
    expect(lines.at(-1)).toMatchObject({
      body: "✓ Approved",
      bodyStyle: "tool-status-ok",
    });
  });

  it("appends ✗ Rejected on rejected status", () => {
    const lines = formatExitPlanMode({ plan: "body", status: "rejected" });
    expect(lines.at(-1)).toMatchObject({
      body: "✗ Rejected",
      bodyStyle: "tool-status-fail",
    });
  });

  it("omits the footer when status is unset", () => {
    const lines = formatExitPlanMode({ plan: "body" });
    expect(lines.some((l) => l.body === "awaiting approval…")).toBe(false);
    expect(lines.some((l) => l.body.startsWith("✓") || l.body.startsWith("✗")))
      .toBe(false);
  });
});
