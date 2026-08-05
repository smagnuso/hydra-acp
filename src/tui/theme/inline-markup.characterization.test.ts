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
import { writeBodyWithHighlight, writeStyled } from "../screen.js";
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

// Explicit regression coverage for span nesting and per-row restore. The
// snapshots above would catch a change here too, but only as an opaque byte
// diff; these say what the property is.
describe("span closers restore the enclosing state", () => {
  const lastSgrBefore = (body: string, marker: string): string => {
    const upto = body.slice(0, body.indexOf(marker));
    const all: string[] = upto.match(/\x1b\[[0-9;]*m/g) ?? [];
    // Everything since the last full reset is the state in force.
    const afterReset = all.lastIndexOf("\x1b[0m");
    return all.slice(afterReset + 1).join("");
  };

  it("restores bold after a code span nested inside bold", () => {
    // "**a `b` c**" — the code span's closer must put bold back, or " c"
    // renders unbolded.
    const body = parseAgentMarkdown("**a `b` c**")[0]!.body;
    expect(lastSgrBefore(body, " c")).toBe("\x1b[1m");
  });

  it("restores a heading's bold and colour after a link", () => {
    // A link's closer used to be a bare reset regardless of row, so
    // everything after a link in a heading lost the heading's style.
    const body = parseAgentMarkdown("# see [docs](https://e.com) x")[0]!.body;
    expect(lastSgrBefore(body, " x")).toBe("\x1b[1m\x1b[93m");
  });

  it("restores a heading's bold and colour after a code span", () => {
    const body = parseAgentMarkdown("# pre `cli/` post")[0]!.body;
    expect(lastSgrBefore(body, " post")).toBe("\x1b[1m\x1b[93m");
  });

  it("restores a thought's gray after every span kind", () => {
    for (const md of ["a **b** c", "a `b` c", "a [b](https://e.com) c"]) {
      const body = parseThoughtMarkdown(md)[0]!.body;
      expect(lastSgrBefore(body, " c"), md).toBe("\x1b[90m");
    }
  });

  it("keeps the hover band alive across a span", () => {
    // A span closes with a full reset, which clears the background. The
    // hovered row re-asserts its band afterwards or the band stops at the
    // first span.
    const { term, take } = createCapturingTerminal("xterm-256color");
    const line = parseThoughtMarkdown("call `foo()` now")[0]!;
    take();
    writeStyled(term, line.body, line.bodyStyle, true);
    const out = take();
    const band = "\x1b[48;5;233m";
    const resets = out.split("\x1b[0m");
    // Every reset except the final one is followed by the band again.
    for (const tail of resets.slice(1, -1)) {
      expect(tail.startsWith(band)).toBe(true);
    }
    expect(out).toContain(`\x1b[0m${band}`);
  });
});

describe("search highlight over a span-bearing body", () => {
  const paint = (body: string, term: string, activeCol?: number): string => {
    const { term: t, take } = createCapturingTerminal("xterm-256color");
    take();
    writeBodyWithHighlight(t, body, "agent", term, activeCol ?? null);
    return take();
  };
  const HL = "\x1b[103m\x1b[30m";

  it("highlights visible text, not the escape bytes around it", () => {
    const body = "call \x1b[96mfoo\x1b[0m now";
    expect(paint(body, "foo")).toContain(`${HL}foo`);
  });

  it("finds nothing when the term only occurs inside escapes", () => {
    // "m" terminates every SGR sequence; "[" and ";" appear in them too.
    const body = "call \x1b[96mfoo\x1b[0m now";
    for (const noise of ["m", "[", ";", "96"]) {
      expect(paint(body, noise), `term: ${noise}`).not.toContain(HL);
    }
  });

  it("keeps the band unbroken when a span boundary splits the match", () => {
    // "fo" + reset + "o" renders as "foo". Highlighting the raw slice would
    // let the interior reset punch a hole in the band, so the match is
    // stripped before painting.
    expect(paint("a fo\x1b[0mo b", "foo")).toContain(`${HL}foo`);
  });

  it("uses the louder style for the match the cursor is on", () => {
    const body = "call \x1b[96mfoo\x1b[0m now";
    const painted = paint(body, "foo", "call \x1b[96m".length);
    expect(painted).toContain("\x1b[41m\x1b[97mfoo");
  });
});

describe("NO_COLOR silences every source of colour", () => {
  // Three independent sources have to go quiet, and they are reached
  // differently: the token's own colour, the inline spans format.ts bakes into
  // a body at parse time, and cli-highlight's syntax colours on a fenced code
  // line. The first falls out of "none" being a depth; the other two are in the
  // body text, so writeStyled strips them.
  const render = (md: string, env: Record<string, string>): string => {
    const { term, take } = createCapturingTerminal("xterm-truecolor");
    const orig = { ...process.env };
    Object.assign(process.env, env);
    try {
      take();
      for (const line of parseAgentMarkdown(md)) {
        writeStyled(term, line.body, line.bodyStyle);
      }
      return take();
    } finally {
      for (const k of Object.keys(env)) {
        delete process.env[k];
      }
      Object.assign(process.env, orig);
    }
  };

  const CASES: Array<[string, string]> = [
    ["token colour", "# a heading"],
    ["inline span", "call `foo()` now"],
    ["link", "see [docs](https://example.com)"],
    ["syntax highlighting", "```js\nconst a = 1;\n```"],
    ["everything at once", "# h\n\n`c` and **b**\n\n```js\nconst a = 1;\n```"],
  ];

  for (const [what, md] of CASES) {
    it(`emits no escape at all — ${what}`, () => {
      const out = render(md, { NO_COLOR: "1" });
      expect(out).not.toContain("\x1b");
      // …and the visible text survives.
      expect(out.length).toBeGreaterThan(0);
    });

    it(`still emits colour without NO_COLOR — ${what}`, () => {
      // Guards against the assertion above passing because rendering broke.
      expect(render(md, {})).toContain("\x1b");
    });
  }

  it("leaves OSC 8 hyperlinks intact, since a link is not colour", () => {
    const { term, take } = createCapturingTerminal("xterm-truecolor");
    process.env.NO_COLOR = "1";
    try {
      take();
      writeStyled(
        term,
        "see \x1b]8;;https://example.com\x1b\\\x1b[96mdocs\x1b[0m\x1b]8;;\x1b\\ end",
        "agent",
      );
      const out = take();
      expect(out).toContain("\x1b]8;;https://example.com");
      expect(out).not.toContain("\x1b[96m");
    } finally {
      delete process.env.NO_COLOR;
    }
  });
});
