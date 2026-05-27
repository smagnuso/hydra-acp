import { describe, it, expect } from "vitest";
import { renderMarkdownForCat } from "./cat-render.js";

describe("renderMarkdownForCat — plain mode", () => {
  it("strips bold markers", () => {
    const out = renderMarkdownForCat("hello **world** there", "plain");
    expect(out).toBe("hello world there\n");
  });

  it("strips inline code markers", () => {
    const out = renderMarkdownForCat("call `foo()` next", "plain");
    expect(out).toBe("call foo() next\n");
  });

  it("strips mixed inline markup", () => {
    const out = renderMarkdownForCat("**foo** and `bar`", "plain");
    expect(out).toBe("foo and bar\n");
  });

  it("preserves literal ^ characters round-trip", () => {
    const out = renderMarkdownForCat("`a ^ b` and **x ^ y**", "plain");
    expect(out).toBe("a ^ b and x ^ y\n");
  });

  it("contains no ANSI escapes for any line", () => {
    const out = renderMarkdownForCat(
      "# heading\n\n**bold** and `code` here.",
      "plain",
    );
    expect(out).not.toMatch(/\x1b\[/);
  });

  it("strips ANSI emitted by syntax highlighting inside a fenced block", () => {
    const out = renderMarkdownForCat(
      "```js\nconst x = 1;\n```\n",
      "plain",
    );
    expect(out).not.toMatch(/\x1b\[/);
    expect(out).toContain("const x = 1;");
  });

  it("renders pipe tables with box-drawing chars", () => {
    const src = [
      "| Name | Score |",
      "|------|-------|",
      "| Foo  | 10    |",
      "| Bar  | 20    |",
      "",
    ].join("\n");
    const out = renderMarkdownForCat(src, "plain");
    expect(out).toContain("│");
    expect(out).toContain("─┼─");
    expect(out).toContain("Foo");
    expect(out).toContain("20");
  });
});

describe("renderMarkdownForCat — ansi mode", () => {
  it("wraps bold spans with bold/reset SGR", () => {
    const out = renderMarkdownForCat("plain **bold** plain", "ansi");
    expect(out).toContain("\x1b[1mbold\x1b[0m");
  });

  it("wraps inline code spans with bright-cyan SGR", () => {
    const out = renderMarkdownForCat("call `foo()` now", "ansi");
    expect(out).toContain("\x1b[96mfoo()\x1b[0m");
  });

  it("preserves literal ^ characters when adjacent to markup", () => {
    const out = renderMarkdownForCat("`a ^ b`", "ansi");
    expect(out).toContain("a ^ b");
  });

  it("applies bold styling to headings", () => {
    const out = renderMarkdownForCat("# Title\n", "ansi");
    expect(out).toContain("\x1b[");
    expect(out).toContain("Title");
  });

  it("styles inline code inside a heading and restores the heading style after", () => {
    // heading-1 emits `^Ccli/^+^Y` for inline code; after translateMarkup
    // the bright-cyan opener and the bold+bright-yellow restorer survive
    // the pipe so the rest of the heading body keeps its style.
    const out = renderMarkdownForCat("# pre `cli/` post", "ansi");
    expect(out).toContain("\x1b[96mcli/\x1b[1m\x1b[93m");
    expect(out).toContain("pre ");
    expect(out).toContain(" post");
  });

  it("strips heading inline markup in plain mode", () => {
    const out = renderMarkdownForCat("# pre `cli/` post", "plain");
    expect(out).toBe("pre cli/ post\n");
  });

  it("emits highlighted code lines with ANSI from cli-highlight", () => {
    const out = renderMarkdownForCat(
      "```js\nconst x = 1;\n```\n",
      "ansi",
    );
    expect(out).toMatch(/\x1b\[/);
    expect(out).toContain("const");
  });

  it("renders pipe tables with box-drawing chars", () => {
    const src = [
      "| Name | Score |",
      "|------|-------|",
      "| Foo  | 10    |",
      "",
    ].join("\n");
    const out = renderMarkdownForCat(src, "ansi");
    expect(out).toContain("│");
    expect(out).toContain("─┼─");
  });
});
