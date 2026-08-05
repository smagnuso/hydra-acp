// End-to-end characterization of inline markdown rendering.
//
// Pins the bytes that reach the terminal for a corpus of markdown inputs:
// format.ts parses them into FormattedLines, then writeStyled emits them
// through a real terminal-kit. This spans the whole pipeline, so it covers
// the handoff that the two per-layer test suites each miss — format.test.ts
// asserts on caret literals and never renders them, while the writeStyled
// characterization renders single styles and never parses markdown.
//
// The point is to make the caret-markup -> SGR migration provably
// output-preserving. terminal-kit's caret interpretation is itself just a
// caret->SGR table (^C -> ESC[96m, ^: -> ESC[0m, ...), so emitting those
// sequences directly should land on identical bytes. If a snapshot moves,
// the migration changed what the user sees.

import { describe, expect, it } from "vitest";
import {
  parseAgentMarkdown,
  parseThoughtMarkdown,
  type FormattedLine,
} from "../format.js";
import { writeStyled } from "../screen.js";
import { createCapturingTerminal, visible } from "./capture.js";

// Constructs chosen to hit every inline emission point in
// applyInlineMarkupWithLinks, plus the per-style closer tables
// (planInlineOptsFor / headingInlineOptsFor) that re-emit a row's base
// colour after a span.
const CORPUS: { name: string; md: string }[] = [
  { name: "plain prose", md: "just some words" },
  { name: "bold", md: "a **bold** b" },
  { name: "italic-star", md: "a *ital* b" },
  { name: "italic-underscore", md: "a _ital_ b" },
  { name: "inline code", md: "call `foo()` now" },
  { name: "link", md: "see [the docs](https://example.com/x) now" },
  { name: "bold inside code", md: "`a **b** c`" },
  { name: "code inside bold", md: "**a `b` c**" },
  { name: "literal caret in prose", md: "press ^C to quit" },
  { name: "literal caret in code", md: "`a ^ b`" },
  { name: "backslash-escaped star", md: "a \\*not italic\\* b" },
  { name: "heading-1 with code", md: "# pre `cli/` post" },
  { name: "heading-2 with bold", md: "## **bold** mid" },
  { name: "heading-3 with code", md: "### `x` y" },
  { name: "heading-1 with link", md: "# see [docs](https://e.com) x" },
  { name: "bullet list with spans", md: "- **a** and `b`\n- plain" },
  { name: "ordered list with spans", md: "1. **a** and `b`\n2. plain" },
  {
    name: "table with spans",
    md: "| h **b** | h2 |\n| --- | --- |\n| `c` | *i* |",
  },
  { name: "fenced code", md: "```js\nconst a = 1;\n```" },
  { name: "fenced code no lang", md: "```\nraw ^ text\n```" },
  { name: "unbalanced bold", md: "a **b c" },
  { name: "adjacent spans", md: "**a**`b`*c*" },
  { name: "multiline prose with spans", md: "line **one**\nline `two`" },
];

function renderLines(lines: FormattedLine[], generic: string): string {
  const { term, take } = createCapturingTerminal(generic);
  const out: string[] = [];
  for (const line of lines) {
    take();
    // Mirror the shape of a real paint: prefix then body, each with its own
    // style, which is how writeFormattedLine drives writeStyled.
    if (line.prefix) {
      writeStyled(term, line.prefix, line.prefixStyle);
    }
    writeStyled(term, line.body, line.bodyStyle);
    out.push(
      `  ${(line.bodyStyle ?? "(none)").padEnd(12)} ${visible(take())}`,
    );
  }
  return out.join("\n");
}

for (const generic of ["xterm-256color", "xterm-truecolor"]) {
  describe(`inline markup end-to-end (${generic})`, () => {
    it("renders the agent-markdown corpus to stable bytes", () => {
      const blocks = CORPUS.map(
        (c) =>
          `### ${c.name}\n${renderLines(parseAgentMarkdown(c.md), generic)}`,
      );
      expect(blocks.join("\n\n")).toMatchSnapshot();
    });

    it("renders the thought-markdown corpus to stable bytes", () => {
      // Thoughts pass their own inline opts (dim-cyan code, a bold reset
      // that keeps the gray register, and a codeReset that restores
      // brightBlack), so they exercise a different closer set entirely.
      const blocks = CORPUS.map(
        (c) =>
          `### ${c.name}\n${renderLines(parseThoughtMarkdown(c.md), generic)}`,
      );
      expect(blocks.join("\n\n")).toMatchSnapshot();
    });

    it("renders hovered rows to stable bytes", () => {
      // Hover is where the thought style's baked codeReset gets rewritten,
      // so it needs its own coverage.
      const { term, take } = createCapturingTerminal(generic);
      const out: string[] = [];
      for (const c of CORPUS) {
        for (const line of parseThoughtMarkdown(c.md)) {
          take();
          writeStyled(term, line.body, line.bodyStyle, true);
          out.push(`${c.name.padEnd(26)} ${visible(take())}`);
        }
      }
      expect(out.join("\n")).toMatchSnapshot();
    });
  });
}
