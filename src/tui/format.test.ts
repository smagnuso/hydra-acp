import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import stringWidth from "string-width";
import {
  buildUnifiedDiff,
  formatEditDiffBlock,
  formatEvent,
  formatExitPlanMode,
  formatToolLine,
  parseAgentMarkdown,
  pickPlanWindow,
  type FormattedLine,
} from "./format.js";
import type { PlanEntry } from "../core/render-update.js";

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

  it("applies inline markup inside headings with level-specific restore closers", () => {
    // heading-1: bold + brightYellow, code opens with ^C and closes with
    // ^+^Y so bold + brightYellow restore after the span. heading-2 swaps
    // the code opener to ^Y (the default ^C would clash with brightCyan)
    // and restores via ^+^C. heading-3 has no outer color, so closers
    // fully reset and re-bold via ^:^+.
    const h1 = parseAgentMarkdown("# pre `cli/` post");
    expect(h1[0]?.bodyStyle).toBe("heading-1");
    expect(h1[0]?.body).toBe("pre ^Ccli/^+^Y post");

    const h2 = parseAgentMarkdown("## **bold** mid");
    expect(h2[0]?.bodyStyle).toBe("heading-2");
    expect(h2[0]?.body).toBe("^+bold^+^C mid");

    const h3 = parseAgentMarkdown("### `x` y");
    expect(h3[0]?.bodyStyle).toBe("heading-3");
    expect(h3[0]?.body).toBe("^Cx^:^+ y");
  });

  it("applies inline markup to header cells using heading-3 closers", () => {
    // heading-3 cells now route through the markup-interpreting writer
    // (term.bold without .noFormat), so applyInlineMarkup is run on the
    // header. heading-3 has no outer color, so the closer is `^:^+`:
    // reset everything then re-bold for the rest of the header.
    const lines = parseAgentMarkdown(
      "| **bold header** | b |\n|---|---|\n| x | y |",
    );
    expect(lines[0]?.bodyStyle).toBe("heading-3");
    expect(lines[0]?.body).toContain("^+bold header^:^+");
    expect(lines[0]?.body).not.toContain("**bold header**");
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

  // When maxWidth is omitted, formatTable keeps its old "natural width"
  // behavior — column widths come from the widest cell, no wrapping. A row
  // of `header + separator + body` should still be the count of source rows.
  it("leaves a narrow table unchanged when no maxWidth is given", () => {
    const lines = parseAgentMarkdown(
      "| a | b |\n|---|---|\n| short | a_much_longer_value |",
    );
    expect(lines).toHaveLength(3);
    expect(lines[2]?.body).toBe("short │ a_much_longer_value");
  });

  // The whole point of the new clamp: when maxWidth is too small for the
  // natural table, columns shrink and long cells split across multiple
  // physical rows — and the `│` separators stay aligned across every
  // physical row of a single source row.
  it("wraps wide table cells when maxWidth is set", () => {
    const table = [
      "| Op | Behavior |",
      "|---|---|",
      "| createBuffer | Validation error fires at the creation call, captured by the current error scope. |",
    ].join("\n");
    const lines = parseAgentMarkdown(table, { maxWidth: 40 });
    expect(lines[0]?.bodyStyle).toBe("heading-3");
    expect(lines[1]?.bodyStyle).toBe("dim");
    // Body has multiple physical rows for the single source row.
    const bodyLines = lines.slice(2);
    expect(bodyLines.length).toBeGreaterThan(1);
    for (const l of bodyLines) {
      expect(l.bodyStyle).toBe("agent");
    }
    // Every emitted line — header, separator, body — has the same visible
    // width (i.e. │ separators line up across the whole block).
    const widths = lines.map(visibleWidth);
    expect(
      new Set(widths).size,
      `expected all rows equal width, got widths ${widths.join(",")}`,
    ).toBe(1);
  });

  // Markup spans must stay intact across wrap — splitting a `**…**` mid-span
  // would emit "**Resource" on one line and "creation**" on another, neither
  // of which would render bold. The tokenizer keeps the span as a single
  // word so the wrap respects that boundary.
  it("keeps **bold** spans atomic across wrap", () => {
    const table = [
      "| Kind | Note |",
      "|---|---|",
      "| **Resource creation** | does X and Y |",
    ].join("\n");
    const lines = parseAgentMarkdown(table, { maxWidth: 28 });
    // Find the line that holds the bold span; it should carry the converted
    // `^+Resource creation^:` markup, not a half-broken `**Resource` literal.
    const boldLine = lines.find((l) => l.body.includes("Resource creation"));
    expect(boldLine?.body).toContain("^+Resource creation^:");
    expect(boldLine?.body).not.toContain("**Resource");
    expect(boldLine?.body).not.toContain("creation**");
  });

  // Regression: the 3-column table from session hydra_session_qVcKQN67lY6fuNXk
  // — natural column widths summed to ~350 chars, far over a typical 120-col
  // terminal. Without clamp, the screen-layer wrap chops each row mid-content
  // and the divider drifts onto its own line. With clamp, each physical row
  // is exactly maxWidth chars wide (including the prefix) and `│` aligns.
  it("renders the qVcKQN67lY6fuNXk validation-rules table cleanly at width 120", () => {
    const table = [
      "| Operation kind | Per-spec behavior | What the bridge should do |",
      "|---|---|---|",
      "| **Resource creation** (`createBuffer`, `createBindGroup`, `createPipeline`, …) | Validation error fires at the creation call, captured by the current error scope. | Raise on device at creation. (`sendUncaught(target)` does this.) |",
      "| **Encoder operations** (`setVertexBuffer`, `clearBuffer`, `drawIndirect`, …) | NO validation error fires at encode time. Errors accumulate on the encoder. ONE error eventually surfaces at `finish()` (for encode-time sync errors) or `submit()` (for resource-state errors like destroyed). | Use `setFirstError` on the encoder. Never call `device->raiseError` from an encoder lambda. Never produce a `Throwable` error that would route there. |",
      "| **Queue operations** (`writeBuffer`, `writeTexture`, `submit`) | Validation error fires at the call. | Raise on device. |",
    ].join("\n");
    const lines = parseAgentMarkdown(table, { maxWidth: 120 });
    const widths = lines.map(visibleWidth);
    // Every emitted row is the same visible width — the screen layer's
    // mid-row wrap (which produced the broken layout the user reported)
    // never fires because every row already fits inside maxWidth.
    expect(
      new Set(widths).size,
      `expected all rows equal width, got widths ${widths.join(",")}`,
    ).toBe(1);
    expect(widths[0]).toBeLessThanOrEqual(120);
    // Header (1) + separator (1) + 3 body rows that each wrapped to
    // multiple physical rows.
    expect(lines.length).toBeGreaterThan(5);
    expect(lines[0]?.bodyStyle).toBe("heading-3");
    expect(lines[1]?.bodyStyle).toBe("dim");
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

describe("formatEditDiffBlock", () => {
  it("in 'edit' mode emits just the dim path header", () => {
    const lines = formatEditDiffBlock(
      { path: "/repo/src/foo.ts", oldText: "x", newText: "y" },
      "edit",
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      body: "▸ Edited /repo/src/foo.ts",
      bodyStyle: "dim",
    });
  });

  it("in 'diff' mode emits the header followed by a highlighted diff body", () => {
    const lines = formatEditDiffBlock(
      {
        path: "/repo/src/foo.ts",
        oldText: "old line\n",
        newText: "new line\n",
      },
      "diff",
    );
    // 1 path header + 2 diff lines (1 removed, 1 added)
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({
      body: "▸ Edited /repo/src/foo.ts",
      bodyStyle: "dim",
    });
    expect(lines[1]?.bodyStyle).toBe("code");
    expect(lines[1]?.ansi).toBe(true);
    expect(lines[2]?.bodyStyle).toBe("code");
    expect(lines[2]?.ansi).toBe(true);
  });

  it("omits the header when path is absent", () => {
    const lines = formatEditDiffBlock(
      { oldText: "a\n", newText: "b\n" },
      "diff",
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]?.bodyStyle).toBe("code");
  });

  it("returns no lines when 'diff' mode has nothing to show", () => {
    expect(
      formatEditDiffBlock({ oldText: "", newText: "" }, "diff"),
    ).toEqual([]);
  });

  it("contracts a home-prefixed path to ~ in the header", () => {
    const home = homedir();
    const lines = formatEditDiffBlock(
      { path: `${home}/dev/proj/foo.ts`, oldText: "x", newText: "y" },
      "edit",
    );
    expect(lines[0]?.body).toBe("▸ Edited ~/dev/proj/foo.ts");
  });
});

describe("buildUnifiedDiff", () => {
  it("renders inserts and deletes around an unchanged context line", () => {
    const out = buildUnifiedDiff({
      oldText: "a\nb\nc\n",
      newText: "a\nB\nc\n",
    });
    expect(out).toBe("  a\n- b\n+ B\n  c");
  });

  it("treats a full-file write (empty oldText) as all-inserts", () => {
    const out = buildUnifiedDiff({
      oldText: "",
      newText: "one\ntwo\n",
    });
    expect(out).toBe("+ one\n+ two");
  });

  it("truncates very large diffs with a … N more footer", () => {
    const newLines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
    const out = buildUnifiedDiff({
      oldText: "",
      newText: newLines.join("\n"),
    });
    const rendered = out.split("\n");
    expect(rendered.length).toBe(40);
    expect(rendered[rendered.length - 1]).toMatch(/^… \d+ more lines$/);
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

describe("pickPlanWindow", () => {
  function entries(statuses: string[]): PlanEntry[] {
    return statuses.map((status, i) => ({ content: `step ${i}`, status }));
  }

  it("returns the full range when there are fewer than the limit", () => {
    const e = entries(["completed", "in_progress", "pending"]);
    expect(pickPlanWindow(e, 5)).toEqual({ start: 0, end: 3 });
  });

  it("returns the full range when exactly at the limit", () => {
    const e = entries(["completed", "pending", "pending", "pending", "pending"]);
    expect(pickPlanWindow(e, 5)).toEqual({ start: 0, end: 5 });
  });

  it("anchors on the in_progress entry with two slots above when possible", () => {
    const e = entries([
      "completed", "completed", "completed", "in_progress",
      "pending", "pending", "pending", "pending", "pending", "pending",
    ]);
    expect(pickPlanWindow(e, 5)).toEqual({ start: 1, end: 6 });
  });

  it("falls back to first pending when nothing is in_progress", () => {
    const e = entries([
      "completed", "completed", "pending",
      "pending", "pending", "pending", "pending",
    ]);
    expect(pickPlanWindow(e, 5)).toEqual({ start: 0, end: 5 });
  });

  it("anchors at the head when no completed entries exist yet", () => {
    const e = entries([
      "in_progress", "pending", "pending", "pending", "pending", "pending",
      "pending",
    ]);
    expect(pickPlanWindow(e, 5)).toEqual({ start: 0, end: 5 });
  });

  it("slides the window left when the anchor sits near the end of the list", () => {
    const e = entries([
      "completed", "completed", "completed", "completed",
      "completed", "completed", "completed", "in_progress", "pending", "pending",
    ]);
    expect(pickPlanWindow(e, 5)).toEqual({ start: 5, end: 10 });
  });

  it("anchors on the last entry when every entry is completed", () => {
    const e = entries([
      "completed", "completed", "completed", "completed", "completed",
      "completed", "completed", "completed",
    ]);
    expect(pickPlanWindow(e, 5)).toEqual({ start: 3, end: 8 });
  });

  it("returns the full range when limit is 0 (unlimited)", () => {
    const e = entries([
      "completed", "completed", "in_progress",
      "pending", "pending", "pending", "pending", "pending",
    ]);
    expect(pickPlanWindow(e, 0)).toEqual({ start: 0, end: 8 });
  });
});

describe("formatEvent plan windowing", () => {
  function planEvent(
    statuses: string[],
    opts: { stopped?: boolean; amended?: boolean } = {},
  ) {
    return {
      kind: "plan" as const,
      entries: statuses.map((status, i) => ({
        content: `step ${i}`,
        status,
      })),
      ...(opts.stopped !== undefined ? { stopped: opts.stopped } : {}),
      ...(opts.amended !== undefined ? { amended: opts.amended } : {}),
    };
  }

  it("omits the summary suffix when the plan fits in the visible window", () => {
    const lines = formatEvent(
      planEvent(["completed", "in_progress", "pending"]),
    );
    expect(lines[0]).toMatchObject({ body: "Plan" });
    expect(lines).toHaveLength(4);
  });

  it("appends a `X done · Y left` summary when truncating", () => {
    const lines = formatEvent(
      planEvent([
        "completed", "completed", "completed",
        "in_progress",
        "pending", "pending", "pending", "pending", "pending", "pending",
      ]),
    );
    expect(lines[0]?.body).toBe("Plan · 3 done · 7 left");
  });

  it("renders only the windowed entries when truncating", () => {
    const lines = formatEvent(
      planEvent([
        "completed", "completed", "completed",
        "in_progress",
        "pending", "pending", "pending", "pending", "pending", "pending",
      ]),
    );
    // 1 header + 5 entries = 6 lines
    expect(lines).toHaveLength(6);
    const entryBodies = lines.slice(1).map((l) => l.body);
    expect(entryBodies).toEqual([
      "[x] step 1",
      "[x] step 2",
      "[~] step 3",
      "[ ] step 4",
      "[ ] step 5",
    ]);
  });

  it("includes the last completed entry as context above the in_progress anchor", () => {
    const lines = formatEvent(
      planEvent([
        "completed", "completed", "completed", "completed", "completed",
        "completed",
        "in_progress",
        "pending", "pending", "pending",
      ]),
    );
    expect(lines[0]?.body).toBe("Plan · 6 done · 4 left");
    const bodies = lines.slice(1).map((l) => l.body);
    expect(bodies[0]).toBe("[x] step 4");
    expect(bodies[1]).toBe("[x] step 5");
    expect(bodies[2]).toBe("[~] step 6");
  });

  it("counts all done when the plan is fully completed and truncates", () => {
    const lines = formatEvent(
      planEvent([
        "completed", "completed", "completed", "completed",
        "completed", "completed", "completed", "completed",
      ]),
    );
    expect(lines[0]?.body).toBe("Plan · 8 done");
    expect(lines[0]?.bodyStyle).toBe("plan-done");
    expect(lines).toHaveLength(6);
  });

  it("renders every entry and skips the summary when maxPlanItems is 0", () => {
    const lines = formatEvent(
      planEvent([
        "completed", "completed", "completed",
        "in_progress",
        "pending", "pending", "pending", "pending", "pending", "pending",
      ]),
      { maxPlanItems: 0 },
    );
    expect(lines[0]?.body).toBe("Plan");
    expect(lines).toHaveLength(11);
  });

  it("respects an explicit maxPlanItems override", () => {
    const lines = formatEvent(
      planEvent([
        "completed", "in_progress", "pending", "pending", "pending",
        "pending", "pending",
      ]),
      { maxPlanItems: 3 },
    );
    expect(lines[0]?.body).toBe("Plan · 1 done · 6 left");
    expect(lines).toHaveLength(4);
  });

  it("strips a leading N/M progress prefix from each entry's content", () => {
    const lines = formatEvent({
      kind: "plan" as const,
      entries: [
        { content: "1/3 First step", status: "completed" },
        { content: "2/3 Second step", status: "in_progress" },
        { content: "3/3 Third step", status: "pending" },
      ],
    });
    const bodies = lines.slice(1).map((l) => l.body);
    expect(bodies).toEqual([
      "[x] First step",
      "[~] Second step",
      "[ ] Third step",
    ]);
  });

  it("strips a trailing parenthesised (N/M) progress suffix", () => {
    const lines = formatEvent({
      kind: "plan" as const,
      entries: [
        { content: "First step (1/3)", status: "completed" },
        { content: "Second step (2/3)", status: "in_progress" },
        { content: "Third step (3/3)", status: "pending" },
      ],
    });
    const bodies = lines.slice(1).map((l) => l.body);
    expect(bodies).toEqual([
      "[x] First step",
      "[~] Second step",
      "[ ] Third step",
    ]);
  });

  it("strips a trailing bare N/M progress suffix", () => {
    const lines = formatEvent({
      kind: "plan" as const,
      entries: [{ content: "Read config 1/5", status: "completed" }],
    });
    expect(lines[1]?.body).toBe("[x] Read config");
  });

  it("leaves fractions inside an entry intact", () => {
    const lines = formatEvent({
      kind: "plan" as const,
      entries: [
        { content: "Reduce 1/5 of records before sweep", status: "pending" },
      ],
    });
    expect(lines[1]?.body).toBe(
      "[ ] Reduce 1/5 of records before sweep",
    );
  });

  it("preserves the stopped header style when truncating", () => {
    const lines = formatEvent(
      planEvent(
        [
          "completed", "completed",
          "in_progress",
          "pending", "pending", "pending", "pending",
        ],
        { stopped: true },
      ),
    );
    expect(lines[0]?.bodyStyle).toBe("tool-status-fail");
    expect(lines[0]?.body).toBe("Plan · 2 done · 5 left");
  });
});
