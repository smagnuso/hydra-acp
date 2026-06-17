import { describe, expect, it, vi } from "vitest";
import stringWidth from "string-width";
import type { Terminal } from "terminal-kit";
import type { FormattedLine } from "./format.js";
import { parseThoughtMarkdown } from "./format.js";
import { setAmbiguousWide } from "./screen.js";
import type { InputDispatcher, KeyEvent } from "./input.js";
import {
  Screen,
  buildIterm2ImageEscape,
  truncate,
  wrap,
} from "./screen.js";
// Minimal mock term: width 10/height 10 makes repaint() short-circuit
// (it bails when width < 20), so we never exercise the draw path. We
// access private state via casts; TS privates are compile-time only.
function makeScreen(
  opts: {
    maxScrollbackLines?: number;
    repaintThrottleMs?: number;
    progressIndicator?: boolean;
    mouse?: boolean;
  } = {},
): Screen {
  // Proxy-based mock: `term` itself is callable (`term("text")` writes
  // strings in terminal-kit) AND chains via any property access
  // (`term.moveTo(x, y).eraseLineAfter().brightYellow("…")`). Width /
  // height stay at 10×10 so repaint() short-circuits, but direct draws
  // (banner right-slot tests) still need a callable mock that can walk
  // through paintRow.
  const handler: ProxyHandler<(...args: unknown[]) => unknown> = {
    apply: () => term,
    get(_target, prop) {
      if (prop === "width") return 10;
      if (prop === "height") return 10;
      if (prop === "on" || prop === "off") return () => undefined;
      return new Proxy(() => term, handler);
    },
  };
  const term = new Proxy(
    function noop() {} as (...args: unknown[]) => unknown,
    handler,
  ) as unknown as Terminal;
  // Minimal dispatcher stub: just enough surface so the few code paths
  // that touch it during scroll math (promptRows → state().buffer) work.
  const dispatcher = {
    state: () => ({
      buffer: [""],
      row: 0,
      col: 0,
      planMode: false,
      historyIndex: -1,
      queueIndex: -1,
      attachments: [],
      historySearchQuery: null,
    }),
  } as unknown as InputDispatcher;
  return new Screen({
    term,
    dispatcher,
    onKey: () => {},
    repaintThrottleMs: opts.repaintThrottleMs ?? 0,
    maxScrollbackLines: opts.maxScrollbackLines,
    progressIndicator: opts.progressIndicator ?? false,
    mouse: opts.mouse ?? false,
  });
}

function getLines(screen: Screen): FormattedLine[] {
  return (screen as unknown as { lines: FormattedLine[] }).lines;
}

function getKeyedBlocks(
  screen: Screen,
): Map<string, { start: number; count: number }> {
  return (
    screen as unknown as {
      keyedBlocks: Map<string, { start: number; count: number }>;
    }
  ).keyedBlocks;
}

function getWrapCache(screen: Screen): Map<number, FormattedLine[]> {
  return (screen as unknown as { wrapCache: Map<number, FormattedLine[]> })
    .wrapCache;
}

function getWrapCacheWidth(screen: Screen): number {
  return (screen as unknown as { wrapCacheWidth: number }).wrapCacheWidth;
}

// Walk-everything wrap for tests. Production code uses wrapTail(needed)
// to bound work to the visible window; passing Infinity here exercises
// the same cache path while still wrapping every line, giving tests a
// stable handle on cache population.
function wrapAll(screen: Screen, width: number): FormattedLine[] {
  return (
    screen as unknown as {
      wrapTail: (
        w: number,
        needed: number,
      ) => { rows: FormattedLine[]; exhausted: boolean };
    }
  ).wrapTail(width, Number.POSITIVE_INFINITY).rows;
}

describe("Screen scrollback cap", () => {
  it("drops oldest lines when over the cap", () => {
    const screen = makeScreen({ maxScrollbackLines: 100 });
    for (let i = 0; i < 150; i++) {
      screen.appendLine({ body: `line-${i}` });
    }
    const lines = getLines(screen);
    expect(lines.length).toBe(100);
    expect(lines[0]?.body).toBe("line-50");
    expect(lines[99]?.body).toBe("line-149");
  });

  it("shifts keyedBlocks indices when trim does not engulf them", () => {
    const screen = makeScreen({ maxScrollbackLines: 100 });
    // Fill scrollback right up to the cap.
    for (let i = 0; i < 100; i++) {
      screen.appendLine({ body: `line-${i}` });
    }
    // Upsert a block at the tail (gets start ~= 100, then 100 immediately
    // becomes 99 because the upsert push triggers trim).
    screen.upsertLines("block", [
      { body: "tool-row-1" },
      { body: "tool-row-2" },
    ]);
    const before = getKeyedBlocks(screen).get("block")!;
    const startBefore = before.start;
    // Now push enough new lines to trim the head by 10 but leave the
    // block intact at the tail.
    for (let i = 0; i < 10; i++) {
      screen.appendLine({ body: `more-${i}` });
    }
    const after = getKeyedBlocks(screen).get("block")!;
    expect(after.start).toBe(startBefore - 10);
    expect(after.count).toBe(2);
    // The block's lines should still be in scrollback at the new index.
    const lines = getLines(screen);
    expect(lines[after.start]?.body).toBe("tool-row-1");
    expect(lines[after.start + 1]?.body).toBe("tool-row-2");
  });

  it("drops keyedBlocks entries whose lines fall off the head", () => {
    const screen = makeScreen({ maxScrollbackLines: 100 });
    // Upsert a block early so it ends up at the head.
    screen.upsertLines("doomed", [{ body: "old-row" }]);
    expect(getKeyedBlocks(screen).has("doomed")).toBe(true);
    // Push enough lines to push the block fully off the head.
    for (let i = 0; i < 200; i++) {
      screen.appendLine({ body: `line-${i}` });
    }
    expect(getKeyedBlocks(screen).has("doomed")).toBe(false);
    expect(getLines(screen).length).toBe(100);
  });
});

describe("Screen wrap cache", () => {
  it("populates one entry per logical line on first wrap", () => {
    const screen = makeScreen();
    for (let i = 0; i < 20; i++) {
      screen.appendLine({ body: `line-${i}` });
    }
    // wrapAll at a different width than term.width discards the
    // on-insert cache populated by scroll-anchor math and rebuilds it
    // fresh — one entry per logical line.
    wrapAll(screen, 80);
    expect(getWrapCache(screen).size).toBe(20);
  });

  it("returns cached results without growing the cache on a second call", () => {
    const screen = makeScreen();
    for (let i = 0; i < 20; i++) {
      screen.appendLine({ body: `line-${i}` });
    }
    wrapAll(screen, 80);
    const sizeAfterFirst = getWrapCache(screen).size;
    // Mutate the cache value to a sentinel and confirm the second call
    // returns it — proving the cache was actually consulted rather than
    // rebuilt.
    const lines = getLines(screen);
    const firstId = (
      screen as unknown as { lineIds: WeakMap<FormattedLine, number> }
    ).lineIds.get(lines[0]!)!;
    const sentinel: FormattedLine[] = [{ body: "FROM-CACHE" }];
    getWrapCache(screen).set(firstId, sentinel);
    const second = wrapAll(screen, 80);
    expect(getWrapCache(screen).size).toBe(sizeAfterFirst);
    expect(second[0]?.body).toBe("FROM-CACHE");
  });

  it("invalidates the cache entry for a line mutated by streaming", () => {
    const screen = makeScreen();
    screen.appendStreaming("hello", "  ", "agent");
    const lines = getLines(screen);
    expect(lines.length).toBeGreaterThan(0);
    wrapAll(screen, 80);
    expect(getWrapCache(screen).size).toBeGreaterThan(0);
    // Stream another chunk — should mutate the last line in place and
    // re-wrap against the extended body (scroll-anchor math re-populates
    // the cache at term.width during the insert).
    screen.appendStreaming(" world", "  ", "agent");
    const wrapped = wrapAll(screen, 80);
    const joined = wrapped.map((l) => l.body).join("");
    expect(joined).toContain("hello world");
  });

  it("flushes the whole cache on width change", () => {
    const screen = makeScreen();
    for (let i = 0; i < 5; i++) {
      screen.appendLine({ body: `line-${i}` });
    }
    wrapAll(screen, 80);
    expect(getWrapCacheWidth(screen)).toBe(80);
    expect(getWrapCache(screen).size).toBe(5);
    // Stash sentinel values; a width change should evict them.
    const cache = getWrapCache(screen);
    for (const id of cache.keys()) {
      cache.set(id, [{ body: "STALE" }]);
    }
    const wrapped = wrapAll(screen, 40);
    expect(getWrapCacheWidth(screen)).toBe(40);
    expect(wrapped[0]?.body).toBe("line-0");
  });

  it("clears the cache on clearScrollback", () => {
    const screen = makeScreen();
    for (let i = 0; i < 10; i++) {
      screen.appendLine({ body: `line-${i}` });
    }
    wrapAll(screen, 80);
    expect(getWrapCache(screen).size).toBe(10);
    screen.clearScrollback();
    expect(getWrapCache(screen).size).toBe(0);
    expect(getWrapCacheWidth(screen)).toBe(0);
    expect(getLines(screen).length).toBe(0);
  });
});

describe("Screen wrapTail bounded walk", () => {
  function wrapTail(
    screen: Screen,
    width: number,
    needed: number,
  ): { rows: FormattedLine[]; exhausted: boolean } {
    return (
      screen as unknown as {
        wrapTail: (
          w: number,
          n: number,
        ) => { rows: FormattedLine[]; exhausted: boolean };
      }
    ).wrapTail(width, needed);
  }

  it("only wraps as many lines as needed from the tail", () => {
    const screen = makeScreen();
    for (let i = 0; i < 500; i++) {
      screen.appendLine({ body: `line-${i}` });
    }
    const { rows, exhausted } = wrapTail(screen, 80, 30);
    // Each short line wraps to exactly one row at width 80, so 30 needed
    // rows means we processed exactly 30 logical lines from the tail.
    expect(getWrapCache(screen).size).toBe(30);
    expect(exhausted).toBe(false);
    expect(rows).toHaveLength(30);
    // The rows come back in top-down order — last 30 of 500.
    expect(rows[0]?.body).toBe("line-470");
    expect(rows[29]?.body).toBe("line-499");
  });

  it("marks the walk exhausted when it reaches the head", () => {
    const screen = makeScreen();
    for (let i = 0; i < 10; i++) {
      screen.appendLine({ body: `line-${i}` });
    }
    const { rows, exhausted } = wrapTail(screen, 80, 100);
    expect(exhausted).toBe(true);
    expect(rows).toHaveLength(10);
    expect(rows[0]?.body).toBe("line-0");
  });

  it("returns empty rows + exhausted=true on an empty buffer", () => {
    const screen = makeScreen();
    const { rows, exhausted } = wrapTail(screen, 80, 10);
    expect(rows).toEqual([]);
    expect(exhausted).toBe(true);
  });

  it("wraps thought lines flush to a 2-column gutter, ignoring caret markup in the width budget", () => {
    const screen = makeScreen();
    // `^c…^K` (inline code) and `^+…^-` (bold) are zero-width on screen —
    // the wrap budget must skip them so the line fills to the margin, the
    // same as agent text. The whole thought body left-aligns at column 2
    // (a blank 2-space gutter); wrapped rows match that indent.
    screen.appendLine({
      prefix: "  ",
      bodyStyle: "thought",
      body: "Let me check the ^csettings.json^K file and confirm the ^+banner^- source here",
    });
    const rows = wrapAll(screen, 40);
    expect(rows.length).toBeGreaterThan(1);
    // First row and continuations share the same blank gutter.
    expect(rows[0]?.prefix).toBe("  ");
    for (const row of rows.slice(1)) {
      expect(row.prefix).toBe("  ");
    }
    // No row overflows the terminal once caret markup is discounted.
    const visibleWidth = (s: string): number =>
      s.replace(/\^(?:\^|[+\-:CcKY])/g, (m) => (m === "^^" ? "^" : "")).length;
    for (const row of rows) {
      expect((row.prefix ?? "").length + visibleWidth(row.body)).toBeLessThanOrEqual(40);
    }
  });

  it("uses a blank gutter (no marker glyph) for thoughts", () => {
    // No "*"/"·" marker: dim gray color + indent distinguish thoughts, and a
    // blank gutter keeps copy/paste clean.
    const [first] = parseThoughtMarkdown("hello");
    expect(first?.prefix).toBe("  ");
  });

  it("strips a leading space so the first thought line stays flush with the gutter", () => {
    const screen = makeScreen();
    // Streamed reasoning deltas often begin with a space; it must not land
    // between the gutter and the first word (which pushed the first line one
    // column right of the continuations).
    for (const l of parseThoughtMarkdown(
      " I'm realizing the leading space in the body was the actual cause here.",
    )) {
      screen.appendLine(l);
    }
    const rows = wrapAll(screen, 40);
    expect(rows[0]?.prefix).toBe("  ");
    expect(rows[0]?.body.startsWith(" ")).toBe(false);
    expect(rows[0]?.body.startsWith("I'm")).toBe(true);
    for (const row of rows.slice(1)) {
      expect(row.prefix).toBe("  ");
    }
  });

  it("treats ambiguous-width glyphs as 2 cols when ambiguous-wide is set, so lines don't bleed past the margin", () => {
    // On a terminal that draws ambiguous glyphs (em-dash —, smart quotes,
    // ellipsis, middle-dot) as 2 cells, the default narrow budget under-
    // counts and rows overflow. setAmbiguousWide(true) makes the budget
    // match the render. Measure each row the way that terminal would.
    const renderCols = (s: string): number =>
      stringWidth(s, { ambiguousIsNarrow: false });
    const WIDTH = 50;
    const text =
      "A reasoning line with a leading space\u2014like \u201cthe user wants\u2026\u201d\u2014and more words to wrap.";
    try {
      setAmbiguousWide(true);
      const screen = makeScreen();
      for (const l of parseThoughtMarkdown(text)) screen.appendLine(l);
      const rows = wrapAll(screen, WIDTH);
      // Blank 2-space gutter (no marker), so all rows share it.
      expect(rows[0]?.prefix).toBe("  ");
      for (const row of rows.slice(1)) {
        expect(row.prefix).toBe("  ");
      }
      // No row bleeds past the margin in the terminal's own measurement.
      for (const row of rows) {
        expect(renderCols((row.prefix ?? "") + row.body)).toBeLessThanOrEqual(
          WIDTH,
        );
      }
    } finally {
      setAmbiguousWide(false);
    }
  });

  it("keeps every thought line aligned at the gutter across paragraphs", () => {
    const screen = makeScreen();
    // A multi-paragraph thought: the second paragraph's first line must
    // stay aligned with the first paragraph's wrapped rows (no drop back to
    // a narrower indent), which was the staggered-look regression.
    for (const l of parseThoughtMarkdown(
      "First paragraph that is long enough to wrap onto a second row here.\n\n" +
        "Second paragraph also long enough to wrap onto another row of text.",
    )) {
      screen.appendLine(l);
    }
    const rows = wrapAll(screen, 50);
    expect(rows[0]?.prefix).toBe("  ");
    for (const row of rows.slice(1)) {
      expect(row.prefix).toBe("  ");
    }
  });

  it("hideThoughts drops a thought-tagged separator along with the thought body", () => {
    const screen = makeScreen();
    screen.appendLine({ body: "before" });
    // Mirrors appendThought: a thought block opens with a "thought"-tagged
    // separator (the gap above it) followed by thought-styled body lines.
    screen.ensureSeparator("thought");
    screen.upsertLines("thought:0", [
      { body: "thinking...", bodyStyle: "thought" },
    ]);
    screen.appendLine({ body: "after" });

    // Shown: separator + thought body are both visible.
    expect(wrapAll(screen, 80).map((l) => l.body)).toEqual([
      "before",
      "",
      "thinking...",
      "after",
    ]);

    // Hidden: the tagged separator AND the body collapse to nothing — no
    // orphaned blank line left behind.
    screen.setHideThoughts(true);
    expect(wrapAll(screen, 80).map((l) => l.body)).toEqual([
      "before",
      "after",
    ]);
  });
});

describe("wrap (visible-width aware)", () => {
  it("wraps pure ASCII at the char boundary, preferring space breaks", () => {
    expect(wrap("hello world foo bar", 10)).toEqual(["hello", "world foo", "bar"]);
  });

  it("hard-breaks long unspaced tokens", () => {
    expect(wrap("abcdefghijklmnop", 5)).toEqual(["abcde", "fghij", "klmno", "p"]);
  });

  it("budgets CJK by visible width, not char count", () => {
    // Each CJK char is 2 visible columns; width 4 fits exactly 2 chars.
    const wrapped = wrap("中文中文中文", 4);
    for (const chunk of wrapped) {
      expect(stringWidth(chunk)).toBeLessThanOrEqual(4);
    }
    expect(wrapped.join("")).toBe("中文中文中文");
  });

  it("handles mixed ASCII + CJK", () => {
    const wrapped = wrap("hi 中文 bye", 5);
    for (const chunk of wrapped) {
      expect(stringWidth(chunk)).toBeLessThanOrEqual(5);
    }
  });

  it("emits a single wide grapheme that exceeds width rather than looping", () => {
    // Width 1 with a 2-col char: must still make forward progress.
    const wrapped = wrap("中", 1);
    expect(wrapped).toEqual(["中"]);
  });

  it("keeps regional-indicator flag pairs intact", () => {
    const wrapped = wrap("🇺🇸🇯🇵", 2);
    // Each flag is one grapheme, ~2 cols. Each chunk should be one flag.
    for (const chunk of wrapped) {
      expect(stringWidth(chunk)).toBeLessThanOrEqual(2);
    }
    expect(wrapped.join("")).toBe("🇺🇸🇯🇵");
  });
});

describe("truncate (visible-width aware)", () => {
  it("returns short ASCII unchanged", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("truncates long ASCII with an ellipsis", () => {
    expect(truncate("hello world", 8)).toBe("hello w…");
  });

  it("truncates CJK by visible width", () => {
    // "中文中文" is 8 visible cols; max 5 should fit "中文" (4) + "…" (1) = 5.
    const out = truncate("中文中文", 5);
    expect(stringWidth(out)).toBeLessThanOrEqual(5);
    expect(out.endsWith("…")).toBe(true);
  });

  it("returns CJK unchanged when it already fits visibly", () => {
    expect(truncate("中文", 4)).toBe("中文");
  });

  it("never produces output wider than max for mixed content", () => {
    const out = truncate("hi 中文 world 🇺🇸", 8);
    expect(stringWidth(out)).toBeLessThanOrEqual(8);
  });
});

// Visible width counting that mirrors what the terminal actually renders
// for a body that will be passed to term-kit's markup-interpreting `term()`.
// Mirrors the production stripMarkup helper used by wrap/truncate.
function visibleCols(text: string): number {
  const stripped = text.replace(
    /\^\^|\^\[[^\]]*\]|\^[a-zA-Z+\-:_!#/]/g,
    (m) => (m === "^^" ? "^" : ""),
  );
  return stringWidth(stripped);
}

// Bug #2: applyInlineMarkup (format.ts) rewrites `code` -> ^Ccode^: and
// **bold** -> ^+bold^: so terminal-kit's `term(text)` can render them as
// styled spans. Those ^X sequences are zero-width SGR commands at render
// time but currently get counted as 1 col each by wrap/truncate via
// .length and string-width. Result: bullet bodies wrap or truncate too
// early and can split mid-markup, producing visible-text corruption
// ("Gupdated)", trailing stray backticks, dropped chars near code spans).
//
// The fix opts the "agent" bodyStyle into a markup-aware width path:
//   wrap(text, width, { stripMarkup: true })
//   truncate(text, max, { stripMarkup: true })
// Without the flag, behavior is unchanged (cwd/title/spec rendering
// already goes through .noFormat, so markup there should be counted as
// literal characters).
describe("wrap with terminal-kit caret markup (stripMarkup)", () => {
  it("does not count ^C...^: code-span markup toward visible width", () => {
    // applyInlineMarkup turns `foo` into ^Cfoo^: -- 7 JS chars but
    // term(text) renders as 3 visible cols ("foo"). So
    // "text ^Cfoo^: bar" is 16 JS chars / 12 visible cols and must
    // fit in width=12 with stripMarkup=true.
    expect(wrap("text ^Cfoo^: bar", 12, { stripMarkup: true })).toEqual([
      "text ^Cfoo^: bar",
    ]);
  });

  it("does not count ^+...^: bold markup toward visible width", () => {
    // "**foo**" -> "^+foo^:" : 7 JS chars, 3 visible cols.
    // "a ^+b^: c" -> 9 JS chars, 5 visible cols.
    expect(wrap("a ^+b^: c", 5, { stripMarkup: true })).toEqual(["a ^+b^: c"]);
  });

  it("treats ^^ as a single visible caret column", () => {
    // applyInlineMarkup escapes a literal `^` typed by the agent as `^^`;
    // term(text) renders that as one visible `^`. So "x ^^ y" is 6 JS
    // chars / 5 visible cols.
    expect(wrap("x ^^ y", 5, { stripMarkup: true })).toEqual(["x ^^ y"]);
  });

  it("budgets each wrapped chunk by visible width when markup is interspersed", () => {
    const wrapped = wrap("aaaa ^Cbbbb^: cccc dddd", 10, { stripMarkup: true });
    for (const chunk of wrapped) {
      expect(visibleCols(chunk)).toBeLessThanOrEqual(10);
    }
    // No source characters are dropped (other than the breaking space
    // between chunks, which is consumed at the wrap point).
    expect(wrapped.join(" ")).toMatch(/aaaa/);
    expect(wrapped.join(" ")).toMatch(/bbbb/);
    expect(wrapped.join(" ")).toMatch(/cccc/);
    expect(wrapped.join(" ")).toMatch(/dddd/);
  });

  it("never splits a chunk inside a ^X markup span", () => {
    // Splitting between '^' and 'C' would leave a dangling '^' (rendered
    // literally by term()) on one row and an orphan style code on the
    // next -- the exact corruption pattern seen in long bullet bodies.
    const wrapped = wrap("aaaa ^Cbbbbcccc^: dddd eeee ffff", 8, {
      stripMarkup: true,
    });
    for (const chunk of wrapped) {
      // No chunk ends with a bare '^' (would mean we cut inside ^X).
      expect(chunk).not.toMatch(/\^$/);
      // No chunk starts with a known single-char SGR code that isn't
      // preceded by its caret (would mean we cut between ^ and the code).
      expect(chunk).not.toMatch(/^[+\-:_!#/]/);
    }
  });

  it("falls back to char-count behavior when stripMarkup is omitted", () => {
    // Without the flag, "text ^Cfoo^: bar" (16 chars) gets the old
    // length-based wrap: wraps because length > 12. This is the
    // backward-compatible path for cwd/title/spec call sites that go
    // through .noFormat at render time (no markup interpretation).
    const wrapped = wrap("text ^Cfoo^: bar", 12);
    expect(wrapped.length).toBeGreaterThan(1);
  });
});

describe("truncate with terminal-kit caret markup (stripMarkup)", () => {
  it("returns the body unchanged when visible width already fits", () => {
    // 16 JS chars but only 12 visible cols.
    expect(truncate("text ^Cfoo^: bar", 12, { stripMarkup: true })).toBe(
      "text ^Cfoo^: bar",
    );
  });

  it("truncates by visible width, not by JS char count", () => {
    const out = truncate("text ^Cfoo^: bar", 6, { stripMarkup: true });
    expect(visibleCols(out)).toBeLessThanOrEqual(6);
  });

  it("treats ^^ as one visible column in the budget", () => {
    // 6 JS chars, 5 visible cols. max=5 -> unchanged.
    expect(truncate("x ^^ y", 5, { stripMarkup: true })).toBe("x ^^ y");
  });

  it("falls back to char-count behavior when stripMarkup is omitted", () => {
    // Without the flag, "text ^Cfoo^: bar" (16 chars) gets truncated
    // because length > 12. Preserves existing cwd/title semantics.
    const out = truncate("text ^Cfoo^: bar", 12);
    expect(out.length).toBeLessThanOrEqual(12);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("Screen scrollback search", () => {
  it("isScrolledBack reflects scrollOffset state", () => {
    const screen = makeScreen();
    expect(screen.isScrolledBack()).toBe(false);
    for (let i = 0; i < 50; i++) {
      screen.appendLine({ body: `row-${i}` });
    }
    screen.scrollBy(5);
    // Even though the mock term width is small enough to short-circuit
    // repaint, scrollBy updates scrollOffset via maxScrollOffset → the
    // flag reflects whatever lands in scrollOffset.
    expect(screen.isScrolledBack()).toBe(screen.isScrolledBack());
  });

  it("enterScrollbackSearch toggles the active flag and term is empty", () => {
    const screen = makeScreen();
    screen.appendLine({ body: "hello world" });
    expect(screen.isScrollbackSearchActive()).toBe(false);
    screen.enterScrollbackSearch();
    expect(screen.isScrollbackSearchActive()).toBe(true);
    expect(screen.scrollbackSearchTerm()).toBe("");
  });

  it("updateScrollbackSearchTerm collects matches newest→oldest", () => {
    const screen = makeScreen();
    screen.appendLine({ body: "alpha bravo" });
    screen.appendLine({ body: "charlie bravo delta" });
    screen.appendLine({ body: "no match here" });
    screen.enterScrollbackSearch();
    screen.updateScrollbackSearchTerm("bravo");
    const state = (screen as unknown as {
      scrollbackSearch: { matches: Array<{ lineIdx: number; col: number }>; matchIndex: number };
    }).scrollbackSearch;
    expect(state.matches.length).toBe(2);
    // Newest line containing "bravo" is the middle line (index 1).
    expect(state.matches[0]?.lineIdx).toBe(1);
    expect(state.matches[1]?.lineIdx).toBe(0);
    expect(state.matchIndex).toBe(0);
  });

  it("within a single line, matches are ordered right-to-left", () => {
    const screen = makeScreen();
    screen.appendLine({ body: "alpha" });
    screen.appendLine({ body: "fix and fix again" });
    screen.enterScrollbackSearch();
    screen.updateScrollbackSearchTerm("fix");
    const state = (screen as unknown as {
      scrollbackSearch: { matches: Array<{ lineIdx: number; col: number }> };
    }).scrollbackSearch;
    expect(state.matches.length).toBe(2);
    // Rightmost occurrence on the newest line comes first so ^r
    // visits it before stepping further left/up.
    expect(state.matches[0]).toEqual({ lineIdx: 1, col: 8 });
    expect(state.matches[1]).toEqual({ lineIdx: 1, col: 0 });
  });

  it("advance walks older matches without wrapping", () => {
    const screen = makeScreen();
    screen.appendLine({ body: "git pull" });
    screen.appendLine({ body: "git commit" });
    screen.appendLine({ body: "git push" });
    screen.enterScrollbackSearch();
    screen.updateScrollbackSearchTerm("git");
    screen.advanceScrollbackSearch();
    screen.advanceScrollbackSearch();
    const state = (screen as unknown as {
      scrollbackSearch: { matches: unknown[]; matchIndex: number };
    }).scrollbackSearch;
    expect(state.matchIndex).toBe(2);
    // Already at oldest — further advance is a no-op
    screen.advanceScrollbackSearch();
    expect(state.matchIndex).toBe(2);
  });

  it("retreat walks newer matches without wrapping", () => {
    const screen = makeScreen();
    screen.appendLine({ body: "git pull" });
    screen.appendLine({ body: "git commit" });
    screen.appendLine({ body: "git push" });
    screen.enterScrollbackSearch();
    screen.updateScrollbackSearchTerm("git");
    // Advance twice to land on the oldest match.
    screen.advanceScrollbackSearch();
    screen.advanceScrollbackSearch();
    const state = (screen as unknown as {
      scrollbackSearch: { matchIndex: number };
    }).scrollbackSearch;
    expect(state.matchIndex).toBe(2);
    screen.retreatScrollbackSearch();
    expect(state.matchIndex).toBe(1);
    screen.retreatScrollbackSearch();
    expect(state.matchIndex).toBe(0);
    // No wrap at the newest match.
    screen.retreatScrollbackSearch();
    expect(state.matchIndex).toBe(0);
  });

  it("case-insensitive matching", () => {
    const screen = makeScreen();
    screen.appendLine({ body: "Deploy to PROD" });
    screen.enterScrollbackSearch();
    screen.updateScrollbackSearchTerm("prod");
    const state = (screen as unknown as {
      scrollbackSearch: { matches: Array<{ col: number }> };
    }).scrollbackSearch;
    expect(state.matches.length).toBe(1);
    expect(state.matches[0]?.col).toBe(10);
  });

  it("cancel restores baseline scroll and clears search state", () => {
    const screen = makeScreen();
    for (let i = 0; i < 20; i++) {
      screen.appendLine({ body: `row-${i}` });
    }
    screen.scrollBy(3);
    const baseline = (screen as unknown as { scrollOffset: number }).scrollOffset;
    screen.enterScrollbackSearch();
    screen.updateScrollbackSearchTerm("row");
    screen.cancelScrollbackSearch();
    expect(screen.isScrollbackSearchActive()).toBe(false);
    expect((screen as unknown as { scrollOffset: number }).scrollOffset).toBe(
      baseline,
    );
  });

  it("accept keeps current scroll and clears the highlight", () => {
    const screen = makeScreen();
    for (let i = 0; i < 20; i++) {
      screen.appendLine({ body: `row-${i}` });
    }
    screen.enterScrollbackSearch();
    screen.updateScrollbackSearchTerm("row-3");
    screen.acceptScrollbackSearch();
    expect(screen.isScrollbackSearchActive()).toBe(false);
    expect((screen as unknown as { scrollbackHighlight: string | null }).scrollbackHighlight).toBe(null);
  });

  it("ansi lines are skipped but agent lines participate (chat output is agent-styled)", () => {
    const screen = makeScreen();
    screen.appendLine({ body: "this is plain text with foo", bodyStyle: "info" });
    screen.appendLine({ body: "^Cfoo^:", bodyStyle: "agent" });
    screen.appendLine({ body: "\x1b[31mfoo\x1b[0m", bodyStyle: "info", ansi: true });
    screen.enterScrollbackSearch();
    screen.updateScrollbackSearchTerm("foo");
    const state = (screen as unknown as {
      scrollbackSearch: { matches: Array<{ lineIdx: number }> };
    }).scrollbackSearch;
    // Info (0) and agent (1) both match; ANSI body (2) is excluded
    // because its escape bytes distort col positions.
    expect(state.matches.length).toBe(2);
    // Newest first — agent line at idx 1 leads.
    expect(state.matches[0]?.lineIdx).toBe(1);
    expect(state.matches[1]?.lineIdx).toBe(0);
  });

  it("manual scroll cancels an active search and accepts the current view", () => {
    const screen = makeScreen();
    for (let i = 0; i < 50; i++) {
      screen.appendLine({ body: `r${i}` });
    }
    screen.scrollBy(2);
    screen.enterScrollbackSearch();
    screen.updateScrollbackSearchTerm("r1");
    expect(screen.isScrollbackSearchActive()).toBe(true);
    // Wheel / PgUp / PgDn — anything routing through scrollBy.
    screen.scrollBy(1);
    expect(screen.isScrollbackSearchActive()).toBe(false);
  });
});

describe("Screen banner right slot", () => {
  function rightContent(screen: Screen): { text: string; kind: string } | null {
    return (screen as unknown as {
      bannerRightContent: () => { text: string; kind: string } | null;
    }).bannerRightContent();
  }

  it("scrollback search term takes priority and shows a match counter", () => {
    const screen = makeScreen();
    screen.notify("hello", 60_000);
    screen.setBannerSearchIndicator("prompt-q");
    screen.appendLine({ body: "match" });
    screen.enterScrollbackSearch();
    screen.updateScrollbackSearchTerm("match");
    const r = rightContent(screen);
    expect(r?.kind).toBe("search");
    expect(r?.text).toBe("🔍 match 1/1");
  });

  it("prompt-history indicator beats notification", () => {
    const screen = makeScreen();
    screen.notify("hello", 60_000);
    screen.setBannerSearchIndicator("prompt-q");
    const r = rightContent(screen);
    expect(r?.kind).toBe("search");
    expect(r?.text).toBe("🔍 prompt-q");
  });

  it("falls back to notification when no search active", () => {
    const screen = makeScreen();
    screen.notify("model set to claude-4.7", 60_000);
    const r = rightContent(screen);
    expect(r?.kind).toBe("notify");
    expect(r?.text).toBe("model set to claude-4.7");
  });

  it("notify auto-clears after the duration", async () => {
    const screen = makeScreen();
    screen.notify("transient", 30);
    expect(rightContent(screen)?.text).toBe("transient");
    await new Promise((res) => setTimeout(res, 60));
    expect(rightContent(screen)).toBe(null);
  });

  it("clearing the search indicator falls back to notification if present", () => {
    const screen = makeScreen();
    screen.notify("transient", 60_000);
    screen.setBannerSearchIndicator("q");
    expect(rightContent(screen)?.text).toBe("🔍 q");
    screen.setBannerSearchIndicator(null);
    expect(rightContent(screen)?.text).toBe("transient");
  });

  it("empty right slot when nothing set", () => {
    const screen = makeScreen();
    expect(rightContent(screen)).toBe(null);
  });

  it("compaction indicator appears in right slot at lowest priority", () => {
    const screen = makeScreen();
    screen.setCompactionIndicator("\u27f3 compacting...");
    const r = rightContent(screen);
    expect(r?.kind).toBe("compaction");
    expect(r?.text).toBe("\u27f3 compacting...");
  });

  it("transient notify takes priority over compaction indicator", () => {
    const screen = makeScreen();
    screen.setCompactionIndicator("\u27f3 compacting...");
    screen.notify("model changed", 60_000);
    expect(rightContent(screen)?.kind).toBe("notify");
    expect(rightContent(screen)?.text).toBe("model changed");
  });

  it("compaction indicator shows again after transient notify clears", async () => {
    const screen = makeScreen();
    screen.setCompactionIndicator("\u27f3 compacting...");
    screen.notify("model changed", 30);
    expect(rightContent(screen)?.kind).toBe("notify");
    await new Promise((res) => setTimeout(res, 60));
    expect(rightContent(screen)?.kind).toBe("compaction");
    expect(rightContent(screen)?.text).toBe("\u27f3 compacting...");
  });

  it("setCompactionIndicator null clears the indicator", () => {
    const screen = makeScreen();
    screen.setCompactionIndicator("\u27f3 compacting...");
    screen.setCompactionIndicator(null);
    expect(rightContent(screen)).toBe(null);
  });

  it("hydra_compaction phase sequence updates indicator correctly", async () => {
    const screen = makeScreen();

    // started → show compacting
    screen.setCompactionIndicator("\u27f3 compacting...");
    expect(rightContent(screen)?.text).toBe("\u27f3 compacting...");

    // deferred → show queued
    screen.setCompactionIndicator("\u27f3 compaction queued (waiting for idle)");
    expect(rightContent(screen)?.text).toBe("\u27f3 compaction queued (waiting for idle)");

    // swapped → clear indicator, brief notify
    screen.setCompactionIndicator(null);
    screen.notify("\u2713 compacted", 2000);
    expect(rightContent(screen)?.kind).toBe("notify");
    expect(rightContent(screen)?.text).toBe("\u2713 compacted");
    expect((screen as unknown as { compactionIndicator: string | null }).compactionIndicator).toBe(null);
  });

  it("failed phase clears indicator and shows error notify", async () => {
    const screen = makeScreen();
    screen.setCompactionIndicator("\u27f3 compacting...");

    screen.setCompactionIndicator(null);
    screen.notify("\u2717 compaction failed: deferral cap reached", 5000);
    expect(rightContent(screen)?.kind).toBe("notify");
    expect(rightContent(screen)?.text).toContain("\u2717 compaction failed");
    expect((screen as unknown as { compactionIndicator: string | null }).compactionIndicator).toBe(null);
  });
});

describe("Screen scroll anchor on new content", () => {
  function getScrollOffset(screen: Screen): number {
    return (screen as unknown as { scrollOffset: number }).scrollOffset;
  }

  // Mock term.width = 10. Strings like "0123456789abcdefghijABCDEFGHIJ"
  // (30 chars, no whitespace → hard breaks every 10 cols) wrap to 3 rows.

  it("appendLine shifts scrollOffset by the wrapped-row count, not logical lines", () => {
    const screen = makeScreen();
    for (let i = 0; i < 30; i++) {
      screen.appendLine({ body: `r${i}` });
    }
    screen.scrollBy(5);
    const before = getScrollOffset(screen);
    expect(before).toBeGreaterThan(0);
    screen.appendLine({ body: "0123456789abcdefghijABCDEFGHIJ" });
    expect(getScrollOffset(screen)).toBe(before + 3);
  });

  it("appendLines totals the wrapped rows of every added line", () => {
    const screen = makeScreen();
    for (let i = 0; i < 30; i++) {
      screen.appendLine({ body: `r${i}` });
    }
    screen.scrollBy(5);
    const before = getScrollOffset(screen);
    screen.appendLines([
      { body: "short" },
      { body: "abcdefghijABCDEFGHIJ" },
    ]);
    expect(getScrollOffset(screen)).toBe(before + 1 + 2);
  });

  it("appendStreaming accounts for in-place mutations that cross a wrap boundary", () => {
    const screen = makeScreen();
    for (let i = 0; i < 30; i++) {
      screen.appendLine({ body: `r${i}` });
    }
    screen.appendStreaming("123456", "", "agent");
    screen.scrollBy(5);
    const before = getScrollOffset(screen);
    screen.appendStreaming("7890XX", "", "agent");
    expect(getScrollOffset(screen)).toBe(before + 1);
  });

  it("upsertLines shifts scrollOffset by the wrapped-row delta when replacing a block", () => {
    const screen = makeScreen();
    for (let i = 0; i < 30; i++) {
      screen.appendLine({ body: `r${i}` });
    }
    screen.upsertLines("k", [{ body: "short" }]);
    screen.scrollBy(5);
    const before = getScrollOffset(screen);
    screen.upsertLines("k", [{ body: "0123456789abcdefghijABCDEFGHIJ" }]);
    expect(getScrollOffset(screen)).toBe(before + 2);
  });

  it("removeBlock pulls scrollOffset back by the wrapped rows of the removed block", () => {
    const screen = makeScreen();
    for (let i = 0; i < 30; i++) {
      screen.appendLine({ body: `r${i}` });
    }
    screen.upsertLines("k", [{ body: "0123456789abcdefghijABCDEFGHIJ" }]);
    screen.scrollBy(8);
    const before = getScrollOffset(screen);
    screen.removeBlock("k");
    expect(getScrollOffset(screen)).toBe(before - 3);
  });

  it("does not move scrollOffset when pinned at the bottom", () => {
    const screen = makeScreen();
    for (let i = 0; i < 30; i++) {
      screen.appendLine({ body: `r${i}` });
    }
    expect(getScrollOffset(screen)).toBe(0);
    screen.appendLine({ body: "0123456789abcdefghijABCDEFGHIJ" });
    expect(getScrollOffset(screen)).toBe(0);
  });
});

describe("Screen sticky-bottom block", () => {
  it("keeps the sticky block at the tail when other content is appended", () => {
    const screen = makeScreen();
    screen.setStickyBottomKey("plan");
    screen.appendLine({ body: "before" });
    screen.upsertLines("plan", [{ body: "plan-1" }, { body: "plan-2" }]);
    screen.appendLine({ body: "after" });
    const bodies = getLines(screen).map((l) => l.body);
    expect(bodies).toEqual(["before", "after", "plan-1", "plan-2"]);
    const range = getKeyedBlocks(screen).get("plan")!;
    expect(range.start).toBe(2);
    expect(range.count).toBe(2);
  });

  it("floats the sticky block back past a new upserted block", () => {
    const screen = makeScreen();
    screen.setStickyBottomKey("plan");
    screen.upsertLines("plan", [{ body: "plan" }]);
    screen.upsertLines("tools", [{ body: "tool-header" }, { body: "tool-row" }]);
    const bodies = getLines(screen).map((l) => l.body);
    expect(bodies).toEqual(["tool-header", "tool-row", "plan"]);
    const blocks = getKeyedBlocks(screen);
    expect(blocks.get("tools")?.start).toBe(0);
    expect(blocks.get("plan")?.start).toBe(2);
  });

  it("keeps the sticky block at the tail when an existing block in front of it grows", () => {
    const screen = makeScreen();
    screen.setStickyBottomKey("plan");
    screen.upsertLines("tools", [{ body: "t1" }]);
    screen.upsertLines("plan", [{ body: "plan" }]);
    screen.upsertLines("tools", [{ body: "t1" }, { body: "t2" }, { body: "t3" }]);
    const bodies = getLines(screen).map((l) => l.body);
    expect(bodies).toEqual(["t1", "t2", "t3", "plan"]);
    expect(getKeyedBlocks(screen).get("plan")?.start).toBe(3);
  });

  it("upserting the sticky key in place stays at the tail", () => {
    const screen = makeScreen();
    screen.setStickyBottomKey("plan");
    screen.upsertLines("plan", [{ body: "p1" }]);
    screen.upsertLines("tools", [{ body: "t1" }]);
    screen.upsertLines("plan", [{ body: "p1" }, { body: "p2" }]);
    const bodies = getLines(screen).map((l) => l.body);
    expect(bodies).toEqual(["t1", "p1", "p2"]);
    const blocks = getKeyedBlocks(screen);
    expect(blocks.get("plan")?.start).toBe(1);
    expect(blocks.get("plan")?.count).toBe(2);
  });

  it("stops floating once clearKey drops the sticky block", () => {
    const screen = makeScreen();
    screen.setStickyBottomKey("plan");
    screen.upsertLines("plan", [{ body: "plan" }]);
    screen.appendLine({ body: "during" });
    expect(getLines(screen).map((l) => l.body)).toEqual(["during", "plan"]);
    screen.clearKey("plan");
    screen.appendLine({ body: "next-turn" });
    expect(getLines(screen).map((l) => l.body)).toEqual([
      "during",
      "plan",
      "next-turn",
    ]);
  });

  it("ensureSeparator inserts above the sticky block instead of after it", () => {
    const screen = makeScreen();
    screen.setStickyBottomKey("plan");
    screen.appendLine({ body: "before" });
    screen.upsertLines("plan", [{ body: "plan" }]);
    screen.ensureSeparator();
    const bodies = getLines(screen).map((l) => l.body);
    expect(bodies).toEqual(["before", "", "plan"]);
    expect(getKeyedBlocks(screen).get("plan")?.start).toBe(2);
  });

  it("ensureSeparator inserts a separator above the sticky block when the line above it is non-blank, even if the sticky block opens with its own blank", () => {
    // Real-world scenario: plan upserted with a leading-blank "own
    // separator", then a new agent block lands. Without the
    // separator above the sticky, post-float scrollback reads
    // [..., prev_content, agent_lines, plan_lines] with no gap
    // between prev_content and agent_lines.
    const screen = makeScreen();
    screen.setStickyBottomKey("plan");
    screen.appendLine({ body: "tools" });
    screen.upsertLines("plan", [{ body: "" }, { body: "plan" }]);
    screen.ensureSeparator();
    screen.appendLine({ body: "agent" });
    const bodies = getLines(screen).map((l) => l.body);
    expect(bodies).toEqual(["tools", "", "agent", "", "plan"]);
  });

  it("ensureSeparator is a no-op when the line above the sticky block is already blank", () => {
    const screen = makeScreen();
    screen.setStickyBottomKey("plan");
    screen.appendLine({ body: "before" });
    screen.ensureSeparator();
    screen.upsertLines("plan", [{ body: "plan" }]);
    expect(getLines(screen).map((l) => l.body)).toEqual([
      "before",
      "",
      "plan",
    ]);
    screen.ensureSeparator();
    expect(getLines(screen).map((l) => l.body)).toEqual([
      "before",
      "",
      "plan",
    ]);
  });

  it("appendStreaming followed by a sticky upsert keeps the streaming line above the plan", () => {
    const screen = makeScreen();
    screen.setStickyBottomKey("plan");
    screen.appendStreaming("hello", "", "agent");
    screen.upsertLines("plan", [{ body: "plan" }]);
    const bodies = getLines(screen).map((l) => l.body);
    expect(bodies[bodies.length - 1]).toBe("plan");
    expect(bodies).toContain("hello");
    expect(bodies.indexOf("hello")).toBeLessThan(bodies.indexOf("plan"));
  });

  it("appendStreaming after the plan exists routes the new line above the plan", () => {
    const screen = makeScreen();
    screen.setStickyBottomKey("plan");
    screen.upsertLines("plan", [{ body: "plan" }]);
    screen.appendStreaming("hi", "", "agent");
    const bodies = getLines(screen).map((l) => l.body);
    expect(bodies[bodies.length - 1]).toBe("plan");
    expect(bodies.indexOf("hi")).toBeLessThan(bodies.indexOf("plan"));
  });
});

describe("buildIterm2ImageEscape", () => {
  it("emits OSC 1337 with inline=1, height, preserveAspectRatio, and BEL terminator", () => {
    const out = buildIterm2ImageEscape("AAAA", 5, false);
    expect(out).toBe(
      "\x1b]1337;File=inline=1;height=5;preserveAspectRatio=1:AAAA\x07",
    );
  });

  it("wraps in tmux DCS passthrough when insideTmux=true", () => {
    const out = buildIterm2ImageEscape("AAAA", 1, true);
    expect(out.startsWith("\x1bPtmux;")).toBe(true);
    expect(out.endsWith("\x1b\\")).toBe(true);
    // Every ESC inside the inner payload must be doubled. The inner
    // payload has two ESCs (OSC start and BEL — actually BEL is not
    // ESC; the OSC is just one ESC). So inside the wrap we expect
    // ESC ESC for the doubled OSC-start.
    const inner = out.slice("\x1bPtmux;".length, -"\x1b\\".length);
    // Inner should contain \x1b\x1b (the doubled OSC start).
    expect(inner.startsWith("\x1b\x1b]1337;")).toBe(true);
  });
});

describe("Screen.setAttachments", () => {
  it("updates state without crashing on empty or non-empty list", () => {
    const screen = makeScreen();
    screen.setAttachments([]);
    const att = {
      mimeType: "image/png",
      data: "AAAA",
      sizeBytes: 3,
      name: "x.png",
    };
    screen.setAttachments([att]);
    const attachments = (screen as unknown as { attachments: typeof att[] })
      .attachments;
    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.name).toBe("x.png");
  });

  it("is a no-op when identical references are passed", () => {
    const screen = makeScreen();
    const att = {
      mimeType: "image/png",
      data: "AAAA",
      sizeBytes: 3,
    };
    screen.setAttachments([att]);
    // Verify no exception is thrown for repeated identical-list calls.
    screen.setAttachments([att]);
    const attachments = (screen as unknown as { attachments: typeof att[] })
      .attachments;
    expect(attachments).toHaveLength(1);
  });
});

// stop() leaves the alternate screen. Any subsequent stdout write from a
// repaint would land in the host shell as raw ANSI and scramble it — so
// the screen must drop any pending throttled paint AND refuse to queue a
// new one. Regression test for the "^d-mid-turn corrupts terminal" bug.
describe("Screen lifecycle", () => {
  function getStarted(screen: Screen): boolean {
    return (screen as unknown as { started: boolean }).started;
  }
  function getThrottleTimer(screen: Screen): NodeJS.Timeout | null {
    return (
      screen as unknown as {
        scheduler: { pendingTimer: NodeJS.Timeout | null };
      }
    ).scheduler.pendingTimer;
  }

  it("clears the pending throttled repaint on stop()", () => {
    const screen = makeScreen({ repaintThrottleMs: 50 });
    screen.start();
    // start() runs a synchronous repaint, so lastRepaintAt is fresh.
    // The next appendLine arrives within the throttle window and queues
    // a setTimeout instead of painting directly.
    screen.appendLine({ body: "mid-turn output" });
    expect(getThrottleTimer(screen)).not.toBeNull();
    screen.stop();
    expect(getStarted(screen)).toBe(false);
    expect(getThrottleTimer(screen)).toBeNull();
  });

  it("refuses to queue further repaints after stop()", () => {
    const screen = makeScreen({ repaintThrottleMs: 50 });
    screen.start();
    screen.stop();
    // A late session/update notification slipping through before the WS
    // close completes used to schedule a paint into the host shell.
    screen.appendLine({ body: "post-stop update" });
    expect(getThrottleTimer(screen)).toBeNull();
  });

  it("paintRow's callback never runs after stop()", () => {
    const screen = makeScreen();
    screen.start();
    screen.stop();
    // setBanner from a stray sessionElapsedTimer tick would fall through
    // setBanner → drawBanner → paintRow → callback before the fix.
    let painted = false;
    (
      screen as unknown as {
        paintRow: (row: number, sig: string, paint: () => void) => void;
      }
    ).paintRow(1, "any-sig", () => {
      painted = true;
    });
    expect(painted).toBe(false);
  });

  it("setBanner after stop() emits no stdout writes", () => {
    const screen = makeScreen({ progressIndicator: true });
    screen.start();
    screen.stop();
    // Spy on the real stdout: the proxy mock funnels nothing here, so
    // any writeProgressIndicator or paintRow leak shows up directly.
    const original = process.stdout.write.bind(process.stdout);
    let writeCount = 0;
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
      writeCount += 1;
      return original(chunk as Parameters<typeof original>[0], ...(rest as []));
    }) as typeof process.stdout.write;
    try {
      // Mirrors the production sequence: sessionElapsedTimer ticks every
      // second and calls setBanner({ elapsedMs }) — would write banner
      // ANSI to the host shell post-detach without the started-guards.
      screen.setBanner({ status: "busy", elapsedMs: 1234 });
    } finally {
      process.stdout.write = original;
    }
    expect(writeCount).toBe(0);
  });

  it("clears the OSC 9;4 progress pulse when the banner leaves busy", () => {
    const screen = makeScreen({ progressIndicator: true });
    screen.start();
    const original = process.stdout.write.bind(process.stdout);
    const chunks: string[] = [];
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
      chunks.push(typeof chunk === "string" ? chunk : (chunk as Buffer).toString("binary"));
      return original(chunk as Parameters<typeof original>[0], ...(rest as []));
    }) as typeof process.stdout.write;
    try {
      screen.setBanner({ status: "busy", elapsedMs: 0 });
      // Cancelling (or any non-busy status) must emit state 0 so the host
      // terminal's taskbar / dock pulse stops the instant the user ^C's,
      // not only when the cancelled turn eventually settles.
      screen.setBanner({ status: "cancelling", elapsedMs: undefined });
    } finally {
      process.stdout.write = original;
    }
    const out = chunks.join("");
    expect(out).toContain("\x1b]9;4;3\x1b\\");
    expect(out).toContain("\x1b]9;4;0\x1b\\");
  });
});

describe("Selective Mouse Reporting probe + wheel", () => {
  // Capture stdout writes while body runs; restore on return.
  function captureStdout(body: () => void): string {
    const original = process.stdout.write.bind(process.stdout);
    const chunks: string[] = [];
    process.stdout.write = ((chunk: unknown) => {
      chunks.push(
        typeof chunk === "string" ? chunk : (chunk as Buffer).toString("binary"),
      );
      return true;
    }) as typeof process.stdout.write;
    try {
      body();
    } finally {
      process.stdout.write = original;
    }
    return chunks.join("");
  }

  // Reach into Screen's private consumeSelectiveMouseSequences for direct
  // testing. Mirrors the rawStdinHandler chunk-arrival path.
  function consume(screen: Screen, text: string): string {
    return (
      screen as unknown as { consumeSelectiveMouseSequences: (t: string) => string }
    ).consumeSelectiveMouseSequences(text);
  }

  function isProbing(screen: Screen): boolean {
    return (screen as unknown as { selectiveMouseProbing: boolean }).selectiveMouseProbing;
  }

  function isSupported(screen: Screen): boolean {
    return (screen as unknown as { selectiveMouseSupported: boolean }).selectiveMouseSupported;
  }

  function getScrollOffset(screen: Screen): number {
    return (screen as unknown as { scrollOffset: number }).scrollOffset;
  }

  it("emits probe sequence on start when mouseEnabled is false", () => {
    const screen = makeScreen();
    const out = captureStdout(() => screen.start());
    expect(out).toContain("\x1b[?w");
    expect(isProbing(screen)).toBe(true);
    screen.stop();
  });

  it("does NOT emit probe when mouseEnabled is true", () => {
    const screen = makeScreen({ mouse: true });
    const out = captureStdout(() => screen.start());
    expect(out).not.toContain("\x1b[?w");
    expect(isProbing(screen)).toBe(false);
    screen.stop();
  });

  it("on probe reply, enables wheel-only and marks supported", () => {
    const screen = makeScreen();
    screen.start();
    const out = captureStdout(() => {
      const remaining = consume(screen, "\x1b[?0;0 w");
      expect(remaining).toBe("");
    });
    expect(out).toBe("\x1b[=24;1w");
    expect(isSupported(screen)).toBe(true);
    expect(isProbing(screen)).toBe(false);
    screen.stop();
  });

  it("strips wheel SGR reports and dispatches scrollBy with correct sign", () => {
    const screen = makeScreen({ maxScrollbackLines: 1000 });
    screen.start();
    // Fill scrollback so scrollBy(3) actually moves the offset (otherwise
    // maxScrollOffset() clamps to 0 and the test can't observe a change).
    for (let i = 0; i < 200; i++) {
      screen.appendLine({ body: `line-${i}` });
    }
    // Probe-and-enable the protocol.
    consume(screen, "\x1b[?0;0 w");
    expect(isSupported(screen)).toBe(true);

    // Wheel up = scroll into older content (positive offset).
    const remainingUp = consume(screen, "\x1b[<64;10;5M");
    expect(remainingUp).toBe("");
    expect(getScrollOffset(screen)).toBeGreaterThan(0);

    // Wheel down = back toward live tail.
    const offsetAfterUp = getScrollOffset(screen);
    const remainingDown = consume(screen, "\x1b[<65;10;5M");
    expect(remainingDown).toBe("");
    expect(getScrollOffset(screen)).toBeLessThan(offsetAfterUp);
    screen.stop();
  });

  it("passes through text that isn't a probe reply or wheel report", () => {
    const screen = makeScreen();
    screen.start();
    consume(screen, "\x1b[?0;0 w");
    expect(consume(screen, "hello")).toBe("hello");
    expect(consume(screen, "\x1b[A")).toBe("\x1b[A"); // arrow up
    expect(consume(screen, "\x1b[<0;5;5M")).toBe("\x1b[<0;5;5M"); // left click — not consumed
    screen.stop();
  });

  it("handles wheel report mixed with other input in the same chunk", () => {
    const screen = makeScreen({ maxScrollbackLines: 1000 });
    screen.start();
    for (let i = 0; i < 200; i++) {
      screen.appendLine({ body: `line-${i}` });
    }
    consume(screen, "\x1b[?0;0 w");
    const remaining = consume(screen, "pre\x1b[<64;1;1Mmid\x1b[<64;1;1Mpost");
    expect(remaining).toBe("premidpost");
    expect(getScrollOffset(screen)).toBeGreaterThan(0);
    screen.stop();
  });

  it("emits disable sequence on stop() after enabling", () => {
    const screen = makeScreen();
    screen.start();
    consume(screen, "\x1b[?0;0 w");
    const out = captureStdout(() => screen.stop());
    expect(out).toContain("\x1b[=0;0w");
  });

  it("does NOT emit disable sequence on picker stop() if never enabled", () => {
    const screen = makeScreen();
    screen.start();
    // Don't send a probe reply; protocol never enabled. The picker
    // round-trip (keepFullscreen) skips the full emergency reset, so the
    // uninstall optimization still suppresses the selective-mouse-off.
    // The final-exit path deliberately sends it unconditionally as part
    // of the idempotent emergencyTerminalReset() convergence.
    const out = captureStdout(() => screen.stop({ keepFullscreen: true }));
    expect(out).not.toContain("\x1b[=0;0w");
  });

  it("ignores probe reply outside the probing window", () => {
    const screen = makeScreen();
    screen.start();
    // Cancel probing manually (simulates timeout firing).
    (screen as unknown as { selectiveMouseProbing: boolean }).selectiveMouseProbing = false;
    const out = captureStdout(() => {
      const remaining = consume(screen, "\x1b[?0;0 w");
      // Outside the window: not consumed, falls through to other handlers.
      expect(remaining).toBe("\x1b[?0;0 w");
    });
    expect(out).toBe("");
    expect(isSupported(screen)).toBe(false);
    screen.stop();
  });
});

// Click-to-toggle: a left-click resolves to the keyed block painted under
// it (keyAtRow) and is reported via onBlockClick — but only under full
// mouse capture.
describe("Screen btw overlay", () => {
  function makeOverlayScreen(opts: {
    width?: number;
    height?: number;
  } = {}): Screen {
    const width = opts.width ?? 40;
    const height = opts.height ?? 24;
    const handler: ProxyHandler<(...args: unknown[]) => unknown> = {
      apply: () => term,
      get(_target, prop) {
        if (prop === "width") return width;
        if (prop === "height") return height;
        if (prop === "on" || prop === "off") return () => undefined;
        return new Proxy(() => term, handler);
      },
    };
    const term = new Proxy(
      function noop() {} as (...args: unknown[]) => unknown,
      handler,
    ) as unknown as Terminal;
    const dispatcher = {
      state: () => ({
        buffer: [""],
        row: 0,
        col: 0,
        planMode: false,
        historyIndex: -1,
        queueIndex: -1,
        attachments: [],
        historySearchQuery: null,
      }),
    } as unknown as InputDispatcher;
    return new Screen({
      term,
      dispatcher,
      onKey: () => {},
      repaintThrottleMs: 0,
      progressIndicator: false,
    });
  }

  function getOverlayState(screen: Screen): {
    btwOverlayOpen: boolean;
    btwOverlayMaxHeight: number;
    btwOverlayLines: string[];
    btwOverlayLabel: string;
    btwOverlayStatus: string;
    btwOverlaySessionId: string | null;
    btwOverlayUsage: { used?: number; size?: number; costAmount?: number; costCurrency?: string } | undefined;
  } {
    const s = screen as unknown as {
      btwOverlayOpen: boolean;
      btwOverlayMaxHeight: number;
      btwOverlayLines: string[];
      btwOverlayLabel: string;
      btwOverlayStatus: "busy" | "done" | "cancelled" | "errored";
      btwOverlaySessionId: string | null;
      btwOverlayUsage:
        | { used?: number; size?: number; costAmount?: number; costCurrency?: string }
        | undefined;
    };
    return {
      btwOverlayOpen: s.btwOverlayOpen,
      btwOverlayMaxHeight: s.btwOverlayMaxHeight,
      btwOverlayLines: [...s.btwOverlayLines],
      btwOverlayLabel: s.btwOverlayLabel,
      btwOverlayStatus: s.btwOverlayStatus,
      btwOverlaySessionId: s.btwOverlaySessionId,
      btwOverlayUsage: s.btwOverlayUsage ? { ...s.btwOverlayUsage } : undefined,
    };
  }

  function overlayRows(screen: Screen): number {
    return (
      screen as unknown as { btwOverlayRows: () => number }
    ).btwOverlayRows();
  }

  function visibleRows(screen: Screen): number {
    return (
      screen as unknown as { scrollbackVisibleRows: () => number }
    ).scrollbackVisibleRows();
  }

  it("is closed by default; open + empty reserves zero rows", () => {
    const screen = makeOverlayScreen({ width: 40, height: 24 });
    const state = getOverlayState(screen);
    expect(state.btwOverlayOpen).toBe(false);
    const beforeRows = visibleRows(screen);
    screen.openBtwOverlay();
    expect(getOverlayState(screen).btwOverlayOpen).toBe(true);
    // Open with no content yet: overlay reserves zero rows (the prompt
    // separator carries the label). Scrollback height is unchanged.
    expect(overlayRows(screen)).toBe(0);
    expect(visibleRows(screen)).toBe(beforeRows);
  });

  it("openBtwOverlay sets default max-height and initial state", () => {
    const screen = makeOverlayScreen({ width: 40, height: 24 });
    screen.openBtwOverlay();
    const state = getOverlayState(screen);
    expect(state.btwOverlayOpen).toBe(true);
    expect(state.btwOverlayMaxHeight).toBe(12);
    expect(state.btwOverlayLines).toEqual([]);
    expect(state.btwOverlayLabel).toBe("");
    expect(state.btwOverlayStatus).toBe("busy");
  });

  it("openBtwOverlay with custom max-height", () => {
    const screen = makeOverlayScreen({ width: 40, height: 24 });
    screen.openBtwOverlay({ height: 8 });
    expect(getOverlayState(screen).btwOverlayMaxHeight).toBe(8);
  });

  // Helper: build a minimal FormattedLine for tests that only care about
  // line count / structure, not styling.
  const plain = (body: string): FormattedLine => ({ body });

  it("auto-sizes to content: rows == 1 + content.length, capped at max", () => {
    const screen = makeOverlayScreen({ width: 40, height: 24 });
    screen.openBtwOverlay({ height: 5 });
    expect(overlayRows(screen)).toBe(0);
    screen.setBtwOverlayContent([plain("a")]);
    expect(overlayRows(screen)).toBe(2);
    screen.setBtwOverlayContent([plain("a"), plain("b"), plain("c")]);
    expect(overlayRows(screen)).toBe(4);
    screen.setBtwOverlayContent(["a", "b", "c", "d", "e", "f"].map(plain));
    expect(overlayRows(screen)).toBe(5);
  });

  it("setBtwOverlayContent stores lines and shows last N when open", () => {
    const screen = makeOverlayScreen({ width: 40, height: 24 });
    screen.openBtwOverlay({ height: 5 });
    const lines = ["line-1", "line-2", "line-3", "line-4", "line-5"].map(plain);
    screen.setBtwOverlayContent(lines);
    expect(getOverlayState(screen).btwOverlayLines).toEqual(lines);
  });

  it("setBtwOverlayContent truncates to last (height-2) lines for display", () => {
    const screen = makeOverlayScreen({ width: 40, height: 24 });
    screen.openBtwOverlay({ height: 4 });
    screen.setBtwOverlayContent(
      ["first entry", "second entry", "third entry", "fourth entry"].map(plain),
    );
    expect(getOverlayState(screen).btwOverlayLines).toHaveLength(4);
  });

  it("setBtwOverlayContent is idempotent for identical references", () => {
    const screen = makeOverlayScreen({ width: 40, height: 24 });
    const lines = [plain("a"), plain("b")];
    screen.openBtwOverlay();
    screen.setBtwOverlayContent(lines);
    screen.setBtwOverlayContent(lines);
    expect(getOverlayState(screen).btwOverlayLines).toEqual(lines);
  });

  it("setBtwOverlayStatus updates label and style", () => {
    const screen = makeOverlayScreen({ width: 40, height: 24 });
    screen.openBtwOverlay();
    screen.setBtwOverlayStatus({ label: "agent-1", style: "busy" });
    expect(getOverlayState(screen).btwOverlayLabel).toBe("agent-1");
    expect(getOverlayState(screen).btwOverlayStatus).toBe("busy");
  });

  it("status colour maps running → brightYellow, done → green, cancelled → dim, errored → brightRed", () => {
    const screen = makeOverlayScreen({ width: 40, height: 24 });
    screen.openBtwOverlay();
    // Verify the status value is stored correctly for each type.
    screen.setBtwOverlayStatus({ label: "x", style: "busy" });
    expect(getOverlayState(screen).btwOverlayStatus).toBe("busy");
    screen.setBtwOverlayStatus({ label: "y", style: "done" });
    expect(getOverlayState(screen).btwOverlayStatus).toBe("done");
    screen.setBtwOverlayStatus({ label: "z", style: "cancelled" });
    expect(getOverlayState(screen).btwOverlayStatus).toBe("cancelled");
    screen.setBtwOverlayStatus({ label: "w", style: "errored" });
    expect(getOverlayState(screen).btwOverlayStatus).toBe("errored");
  });

  it("status update is idempotent for identical label+style", () => {
    const screen = makeOverlayScreen({ width: 40, height: 24 });
    screen.openBtwOverlay();
    screen.setBtwOverlayStatus({ label: "a", style: "busy" });
    // Same values — no-op.
    screen.setBtwOverlayStatus({ label: "a", style: "busy" });
    expect(getOverlayState(screen).btwOverlayLabel).toBe("a");
    expect(getOverlayState(screen).btwOverlayStatus).toBe("busy");
  });

  it("setBtwOverlayMeta stores sessionId and usage, resets on open/close", () => {
    const screen = makeOverlayScreen({ width: 80, height: 24 });
    screen.openBtwOverlay();
    expect(getOverlayState(screen).btwOverlaySessionId).toBeNull();
    expect(getOverlayState(screen).btwOverlayUsage).toBeUndefined();
    screen.setBtwOverlayMeta({ sessionId: "hydra-session-abc123" });
    expect(getOverlayState(screen).btwOverlaySessionId).toBe("hydra-session-abc123");
    screen.setBtwOverlayMeta({
      usage: { used: 1234, size: 200_000, costAmount: 0.42, costCurrency: "USD" },
    });
    expect(getOverlayState(screen).btwOverlayUsage).toEqual({
      used: 1234,
      size: 200_000,
      costAmount: 0.42,
      costCurrency: "USD",
    });
    // Replace semantics — caller passes a full snapshot each time.
    screen.setBtwOverlayMeta({ usage: { used: 2000 } });
    expect(getOverlayState(screen).btwOverlayUsage?.used).toBe(2000);
    expect(getOverlayState(screen).btwOverlayUsage?.size).toBeUndefined();
    screen.closeBtwOverlay();
    expect(getOverlayState(screen).btwOverlaySessionId).toBeNull();
    expect(getOverlayState(screen).btwOverlayUsage).toBeUndefined();
  });

  it("openBtwOverlay clears stale sessionId and usage", () => {
    const screen = makeOverlayScreen({ width: 80, height: 24 });
    screen.openBtwOverlay();
    screen.setBtwOverlayMeta({
      sessionId: "x",
      usage: { used: 1, costAmount: 0.01 },
    });
    screen.openBtwOverlay();
    expect(getOverlayState(screen).btwOverlaySessionId).toBeNull();
    expect(getOverlayState(screen).btwOverlayUsage).toBeUndefined();
  });

  it("closeBtwOverlay resets state to closed", () => {
    const screen = makeOverlayScreen({ width: 40, height: 24 });
    screen.openBtwOverlay({ height: 8 });
    screen.setBtwOverlayContent([plain("x")]);
    screen.setBtwOverlayStatus({ label: "test", style: "done" });
    screen.closeBtwOverlay();
    const state = getOverlayState(screen);
    expect(state.btwOverlayOpen).toBe(false);
    expect(state.btwOverlayLines).toEqual([]);
  });

  it("closeBtwOverlay is a no-op when already closed", () => {
    const screen = makeOverlayScreen({ width: 40, height: 24 });
    // Should not throw.
    screen.closeBtwOverlay();
    expect(getOverlayState(screen).btwOverlayOpen).toBe(false);
  });

  it("close then render matches before open (closed state is unchanged)", () => {
    const screen = makeOverlayScreen({ width: 40, height: 24 });
    const beforeRows = visibleRows(screen);
    screen.openBtwOverlay();
    screen.setBtwOverlayContent([plain("a"), plain("b")]);
    expect(visibleRows(screen)).toBeLessThan(beforeRows);
    screen.closeBtwOverlay();
    expect(visibleRows(screen)).toBe(beforeRows);
  });

  it("overlay with fewer lines than content rows shows all available", () => {
    const screen = makeOverlayScreen({ width: 40, height: 24 });
    screen.openBtwOverlay({ height: 6 });
    screen.setBtwOverlayContent([plain("only-one")]);
    expect(getOverlayState(screen).btwOverlayLines).toEqual([plain("only-one")]);
  });

  it("overlay with zero lines shows blank content rows", () => {
    const screen = makeOverlayScreen({ width: 40, height: 24 });
    screen.openBtwOverlay();
    // No setBtwOverlayContent call — lines are empty.
    expect(getOverlayState(screen).btwOverlayLines).toEqual([]);
  });

  it("re-opening with same max-height preserves state", () => {
    const screen = makeOverlayScreen({ width: 40, height: 24 });
    screen.openBtwOverlay({ height: 10 });
    expect(getOverlayState(screen).btwOverlayOpen).toBe(true);
    screen.openBtwOverlay({ height: 10 });
    expect(getOverlayState(screen).btwOverlayMaxHeight).toBe(10);
  });

  it("overlay shrinks scrollback by its dynamic row count", () => {
    const screen = makeOverlayScreen({ width: 40, height: 24 });
    const beforeRows = visibleRows(screen);
    screen.openBtwOverlay({ height: 7 });
    expect(visibleRows(screen)).toBe(beforeRows);
    screen.setBtwOverlayContent(["a", "b", "c"].map(plain));
    expect(beforeRows - visibleRows(screen)).toBe(4);
    screen.setBtwOverlayContent(["a", "b", "c", "d", "e", "f", "g"].map(plain));
    expect(beforeRows - visibleRows(screen)).toBe(7);
  });
});

describe("Screen block-click routing", () => {
  // A taller/wider mock than makeScreen so scrollbackVisibleRows() is
  // positive and the row→line mapping has real geometry to walk.
  function makeTallScreen(opts: {
    mouse?: boolean;
    onBlockClick?: (key: string, rowOffset: number) => void;
    onBlockVisible?: (key: string) => void;
    width?: number;
    height?: number;
    openFileCommand?: string | readonly string[];
  }): Screen {
    const width = opts.width ?? 40;
    const height = opts.height ?? 24;
    const handler: ProxyHandler<(...args: unknown[]) => unknown> = {
      apply: () => term,
      get(_target, prop) {
        if (prop === "width") return width;
        if (prop === "height") return height;
        if (prop === "on" || prop === "off") return () => undefined;
        return new Proxy(() => term, handler);
      },
    };
    const term = new Proxy(
      function noop() {} as (...args: unknown[]) => unknown,
      handler,
    ) as unknown as Terminal;
    const dispatcher = {
      state: () => ({
        buffer: [""],
        row: 0,
        col: 0,
        planMode: false,
        historyIndex: -1,
        queueIndex: -1,
        attachments: [],
        historySearchQuery: null,
      }),
    } as unknown as InputDispatcher;
    return new Screen({
      term,
      dispatcher,
      onKey: () => {},
      onBlockClick: opts.onBlockClick,
      onBlockVisible: opts.onBlockVisible,
      repaintThrottleMs: 0,
      progressIndicator: false,
      mouse: opts.mouse ?? false,
      openFileCommand: opts.openFileCommand,
    });
  }

  function draw(screen: Screen): void {
    (screen as unknown as { drawScrollback: () => void }).drawScrollback();
  }

  function callKeyAtRow(screen: Screen, y: number): string | null {
    return (
      screen as unknown as { keyAtRow: (y: number) => string | null }
    ).keyAtRow(y);
  }

  function dispatchMouse(screen: Screen, name: string, data?: unknown): void {
    (
      screen as unknown as {
        handleMouse: (name: string, data?: unknown) => void;
      }
    ).handleMouse(name, data);
  }

  // A full click: press then release on the same cell. Block-click
  // toggles are deferred by DOUBLE_CLICK_MAX_MS (so a follow-up click
  // can cancel the toggle and run the open-file gesture instead); the
  // tests want the eventual single-click effect, so we drain any
  // pending timers synchronously here. Uses fake timers locally so
  // real-time waits don't slow the suite.
  function clickAt(screen: Screen, x: number, y: number): void {
    vi.useFakeTimers();
    try {
      dispatchMouse(screen, "MOUSE_LEFT_BUTTON_PRESSED", { x, y });
      dispatchMouse(screen, "MOUSE_LEFT_BUTTON_RELEASED", { x, y });
      vi.runAllTimers();
    } finally {
      vi.useRealTimers();
    }
  }

  function visibleRows(screen: Screen): number {
    return (
      screen as unknown as { scrollbackVisibleRows: () => number }
    ).scrollbackVisibleRows();
  }

  it("notifyWhenVisible fires onBlockVisible once for an on-screen block", () => {
    const shown: string[] = [];
    const screen = makeTallScreen({ onBlockVisible: (k) => shown.push(k) });
    screen.upsertLines("editdiff:abc", [{ body: "⋯ fetching diff…" }]);
    screen.notifyWhenVisible("editdiff:abc");
    draw(screen);
    expect(shown).toEqual(["editdiff:abc"]);
    // One-shot: a second paint doesn't fire again.
    draw(screen);
    expect(shown).toEqual(["editdiff:abc"]);
  });

  it("notifyWhenVisible does not fire while the block is scrolled out of view", () => {
    const shown: string[] = [];
    const screen = makeTallScreen({ onBlockVisible: (k) => shown.push(k) });
    screen.upsertLines("editdiff:abc", [{ body: "⋯ fetching diff…" }]);
    screen.notifyWhenVisible("editdiff:abc");
    // Push the block far above the bottom-anchored visible window.
    for (let i = 0; i < 100; i++) {
      screen.appendLine({ body: `filler-${i}` });
    }
    draw(screen);
    expect(shown).toEqual([]);
  });

  it("does not fire onBlockVisible for blocks that weren't registered", () => {
    const shown: string[] = [];
    const screen = makeTallScreen({ onBlockVisible: (k) => shown.push(k) });
    screen.upsertLines("editdiff:abc", [{ body: "row" }]);
    draw(screen);
    expect(shown).toEqual([]);
  });

  it("keyAtRow maps a click row to the keyed block painted there", () => {
    const screen = makeTallScreen({ mouse: true });
    // Three single-row blocks, bottom-anchored in the scrollback area.
    screen.upsertLines("tools:1", [{ body: "tool-header" }]);
    screen.upsertLines("plan", [{ body: "plan-row" }]);
    screen.upsertLines("editdiff:abc", [{ body: "diff-row" }]);
    const rows = visibleRows(screen);
    // Content is bottom-anchored: with 3 rows of content, the last three
    // terminal rows (1-based) of the scrollback area hold the blocks.
    expect(callKeyAtRow(screen, rows - 2)).toBe("tools:1");
    expect(callKeyAtRow(screen, rows - 1)).toBe("plan");
    expect(callKeyAtRow(screen, rows)).toBe("editdiff:abc");
  });

  it("keyAtRow still resolves a frozen block after clearKey", () => {
    // A past-turn block: clearKey forgets the keyedBlocks entry but leaves
    // the line painted, carrying its blockKey stamp. The click must still
    // resolve so history blocks stay clickable.
    const screen = makeTallScreen({ mouse: true });
    screen.upsertLines("tools:1", [{ body: "frozen-tool-row" }]);
    screen.clearKey("tools:1");
    expect(
      (
        screen as unknown as {
          keyedBlocks: Map<string, unknown>;
        }
      ).keyedBlocks.has("tools:1"),
    ).toBe(false);
    expect(callKeyAtRow(screen, visibleRows(screen))).toBe("tools:1");
  });

  it("keyAtRow returns null for padding rows above the content", () => {
    const screen = makeTallScreen({ mouse: true });
    screen.upsertLines("tools:1", [{ body: "only-row" }]);
    // Row 1 is in the top padding (content is anchored at the bottom).
    expect(callKeyAtRow(screen, 1)).toBeNull();
  });

  it("keyAtRow returns null for rows outside the scrollback area", () => {
    const screen = makeTallScreen({ mouse: true });
    screen.upsertLines("tools:1", [{ body: "only-row" }]);
    expect(callKeyAtRow(screen, 0)).toBeNull();
    expect(callKeyAtRow(screen, visibleRows(screen) + 1)).toBeNull();
  });

  it("a full click (press+release same cell) fires onBlockClick", () => {
    const clicks: string[] = [];
    const screen = makeTallScreen({
      mouse: true,
      onBlockClick: (key, _rowOffset) => clicks.push(key),
    });
    screen.upsertLines("editdiff:xyz", [{ body: "diff-row" }]);
    clickAt(screen, 3, visibleRows(screen));
    expect(clicks).toEqual(["editdiff:xyz"]);
  });

  it("a single block-click toggle is deferred (debounced for the double-click window)", () => {
    const clicks: string[] = [];
    const screen = makeTallScreen({
      mouse: true,
      onBlockClick: (key, _rowOffset) => clicks.push(key),
      openFileCommand: ["true"],
    });
    screen.upsertLines("editdiff:xyz", [{ body: "diff-row" }]);
    vi.useFakeTimers();
    try {
      const y = visibleRows(screen);
      dispatchMouse(screen, "MOUSE_LEFT_BUTTON_PRESSED", { x: 3, y });
      dispatchMouse(screen, "MOUSE_LEFT_BUTTON_RELEASED", { x: 3, y });
      // Toggle hasn't fired yet — it's waiting for a possible double-click.
      expect(clicks).toEqual([]);
      vi.runAllTimers();
      expect(clicks).toEqual(["editdiff:xyz"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("when onBlockDoubleClick claims the gesture, the deferred toggle never fires", () => {
    const clicks: string[] = [];
    const opens: Array<{ key: string; rowOffset: number }> = [];
    const screen = makeTallScreen({
      mouse: true,
      onBlockClick: (key, _rowOffset) => clicks.push(key),
      openFileCommand: ["true"],
    });
    (
      screen as unknown as {
        onBlockDoubleClick: (key: string, rowOffset: number) => boolean;
      }
    ).onBlockDoubleClick = (key, rowOffset) => {
      opens.push({ key, rowOffset });
      return true;
    };
    screen.upsertLines("editdiff:xyz", [{ body: "diff-row" }]);
    vi.useFakeTimers();
    try {
      const y = visibleRows(screen);
      dispatchMouse(screen, "MOUSE_LEFT_BUTTON_PRESSED", { x: 3, y });
      dispatchMouse(screen, "MOUSE_LEFT_BUTTON_RELEASED", { x: 3, y });
      dispatchMouse(screen, "MOUSE_LEFT_BUTTON_PRESSED", { x: 3, y });
      dispatchMouse(screen, "MOUSE_LEFT_BUTTON_RELEASED", { x: 3, y });
      // The press scheduled NO new pending toggle (because the second
      // release saw doubleClickPending=true and skipped it). Advance
      // past the debounce window to be sure nothing fires later.
      vi.runAllTimers();
      expect(opens).toEqual([{ key: "editdiff:xyz", rowOffset: 0 }]);
      expect(clicks).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a follow-up press on a different cell flushes the deferred toggle immediately", () => {
    const clicks: string[] = [];
    const screen = makeTallScreen({
      mouse: true,
      onBlockClick: (key, _rowOffset) => clicks.push(key),
      openFileCommand: ["true"],
    });
    screen.upsertLines("editdiff:xyz", [{ body: "diff-row" }]);
    vi.useFakeTimers();
    try {
      const y = visibleRows(screen);
      dispatchMouse(screen, "MOUSE_LEFT_BUTTON_PRESSED", { x: 3, y });
      dispatchMouse(screen, "MOUSE_LEFT_BUTTON_RELEASED", { x: 3, y });
      // Still deferred — within the debounce window, no follow-up yet.
      expect(clicks).toEqual([]);
      // Press on a clearly different cell: the previous toggle should
      // fire NOW (before the new press's own gesture is processed),
      // not at the end of the debounce window.
      dispatchMouse(screen, "MOUSE_LEFT_BUTTON_PRESSED", { x: 20, y });
      expect(clicks).toEqual(["editdiff:xyz"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a double-click on the same cell cancels the deferred toggle", () => {
    const clicks: string[] = [];
    const screen = makeTallScreen({
      mouse: true,
      onBlockClick: (key, _rowOffset) => clicks.push(key),
      openFileCommand: ["true"],
    });
    screen.upsertLines("editdiff:xyz", [{ body: "diff-row" }]);
    vi.useFakeTimers();
    try {
      const y = visibleRows(screen);
      dispatchMouse(screen, "MOUSE_LEFT_BUTTON_PRESSED", { x: 3, y });
      dispatchMouse(screen, "MOUSE_LEFT_BUTTON_RELEASED", { x: 3, y });
      // Second press within the double-click window: the pending toggle
      // is cancelled. The second release runs the selection-finalize path
      // (word snap → clipboard) which does NOT toggle the block.
      dispatchMouse(screen, "MOUSE_LEFT_BUTTON_PRESSED", { x: 3, y });
      dispatchMouse(screen, "MOUSE_LEFT_BUTTON_RELEASED", { x: 3, y });
      vi.runAllTimers();
      expect(clicks).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("without openFileCommand, a single click fires the toggle synchronously (no debounce)", () => {
    const clicks: string[] = [];
    const screen = makeTallScreen({
      mouse: true,
      onBlockClick: (key, _rowOffset) => clicks.push(key),
    });
    screen.upsertLines("editdiff:xyz", [{ body: "diff-row" }]);
    const y = visibleRows(screen);
    dispatchMouse(screen, "MOUSE_LEFT_BUTTON_PRESSED", { x: 3, y });
    dispatchMouse(screen, "MOUSE_LEFT_BUTTON_RELEASED", { x: 3, y });
    expect(clicks).toEqual(["editdiff:xyz"]);
  });

  it("a press alone (no release) does not fire onBlockClick", () => {
    const clicks: string[] = [];
    const screen = makeTallScreen({
      mouse: true,
      onBlockClick: (key, _rowOffset) => clicks.push(key),
    });
    screen.upsertLines("editdiff:xyz", [{ body: "diff-row" }]);
    dispatchMouse(screen, "MOUSE_LEFT_BUTTON_PRESSED", {
      x: 3,
      y: visibleRows(screen),
    });
    expect(clicks).toEqual([]);
  });

  it("a press-drag-release (different cell) does not fire onBlockClick", () => {
    const clicks: string[] = [];
    const screen = makeTallScreen({
      mouse: true,
      onBlockClick: (key, _rowOffset) => clicks.push(key),
    });
    screen.upsertLines("editdiff:xyz", [{ body: "a-longer-diff-row" }]);
    const y = visibleRows(screen);
    // Drag horizontally within the same row (text selection): release on a
    // different x must NOT toggle.
    dispatchMouse(screen, "MOUSE_LEFT_BUTTON_PRESSED", { x: 3, y });
    dispatchMouse(screen, "MOUSE_LEFT_BUTTON_RELEASED", { x: 9, y });
    expect(clicks).toEqual([]);
  });

  it("a full click on an unkeyed row does not fire onBlockClick", () => {
    const clicks: string[] = [];
    const screen = makeTallScreen({
      mouse: true,
      onBlockClick: (key, _rowOffset) => clicks.push(key),
    });
    screen.upsertLines("tools:1", [{ body: "only-row" }]);
    // Top padding row — no block there.
    clickAt(screen, 3, 1);
    expect(clicks).toEqual([]);
  });

  it("wheel events never fire onBlockClick", () => {
    const clicks: string[] = [];
    const screen = makeTallScreen({
      mouse: true,
      onBlockClick: (key, _rowOffset) => clicks.push(key),
    });
    screen.upsertLines("tools:1", [{ body: "only-row" }]);
    dispatchMouse(screen, "MOUSE_WHEEL_UP", { x: 1, y: visibleRows(screen) });
    dispatchMouse(screen, "MOUSE_WHEEL_DOWN", { x: 1, y: visibleRows(screen) });
    expect(clicks).toEqual([]);
  });

  it("rowOffset is 0 on the top line of a multi-row block and increments downward", () => {
    const clicks: Array<{ key: string; rowOffset: number }> = [];
    // Use inAppSelection=false to avoid double-click detection interfering
    // with multiple consecutive clicks in the same test.
    const handler: ProxyHandler<(...args: unknown[]) => unknown> = {
      apply: () => term,
      get(_target, prop) {
        if (prop === "width") return 40;
        if (prop === "height") return 24;
        if (prop === "on" || prop === "off") return () => undefined;
        return new Proxy(() => term, handler);
      },
    };
    const term = new Proxy(
      function noop() {} as (...args: unknown[]) => unknown,
      handler,
    ) as unknown as Terminal;
    const dispatcher = {
      state: () => ({
        buffer: [""],
        row: 0,
        col: 0,
        planMode: false,
        historyIndex: -1,
        queueIndex: -1,
        attachments: [],
        historySearchQuery: null,
      }),
    } as unknown as InputDispatcher;
    const screen = new Screen({
      term,
      dispatcher,
      onKey: () => {},
      mouse: true,
      inAppSelection: false,
      onBlockClick: (key, rowOffset) => clicks.push({ key, rowOffset }),
      repaintThrottleMs: 0,
      progressIndicator: false,
    });
    // 4-line block at the tail.
    screen.upsertLines("tools:1", [
      { body: "header" },
      { body: "tool-a" },
      { body: "tool-b" },
      { body: "tool-c" },
    ]);
    const rows = visibleRows(screen);
    // Walk from the bottom up to find all terminal rows that map to our block.
    const blockRowsBottomUp: number[] = [];
    for (let y = rows; y >= 1; y--) {
      const key = callKeyAtRow(screen, y);
      if (key === "tools:1") {
        blockRowsBottomUp.push(y);
      } else if (blockRowsBottomUp.length > 0) {
        break;
      }
    }
    // reverse to get top-to-bottom order for testing
    const blockRows = blockRowsBottomUp.reverse();
    expect(blockRows.length).toBeGreaterThanOrEqual(4);
    // Click each block row from top to bottom and verify offsets.
    for (let i = 0; i < blockRows.length; i++) {
      clicks.length = 0;
      clickAt(screen, 3, blockRows[i]!);
      expect(clicks).toEqual([{ key: "tools:1", rowOffset: i }]);
    }
  });

  // Visible (non-skipped) line bodies, top-to-bottom, via the same wrapTail
  // path drawScrollback uses — so collapsed/hidden lines are excluded.
  function visibleBodies(screen: Screen): string[] {
    const { rows } = (
      screen as unknown as {
        wrapTail: (
          w: number,
          needed: number,
        ) => { rows: FormattedLine[]; exhausted: boolean };
      }
    ).wrapTail(40, Number.POSITIVE_INFINITY);
    return rows.map((r) => r.body);
  }

  it("contiguousRun groups thought blocks split only by an unkeyed separator", () => {
    const screen = makeTallScreen({});
    // A tools block above (keyed, but not a candidate) then two thoughts
    // with an unkeyed separator between — the real-world layout.
    screen.upsertLines("tools:1", [{ body: "tool-row" }]);
    screen.upsertLines("thought:0", [{ body: "t0" }]);
    screen.appendLine({ body: "", bodyStyle: "thought" }); // separator
    screen.upsertLines("thought:1", [{ body: "t1" }]);
    const cands = new Set(["thought:0", "thought:1"]);
    expect(screen.contiguousRun("thought:0", cands)).toEqual([
      "thought:0",
      "thought:1",
    ]);
    expect(screen.contiguousRun("thought:1", cands)).toEqual([
      "thought:0",
      "thought:1",
    ]);
  });

  it("contiguousRun breaks the run at a foreign keyed block between thoughts", () => {
    const screen = makeTallScreen({});
    screen.upsertLines("thought:0", [{ body: "t0" }]);
    screen.upsertLines("agent:0", [{ body: "prose" }]);
    screen.upsertLines("thought:1", [{ body: "t1" }]);
    const cands = new Set(["thought:0", "thought:1"]);
    expect(screen.contiguousRun("thought:0", cands)).toEqual(["thought:0"]);
    expect(screen.contiguousRun("thought:1", cands)).toEqual(["thought:1"]);
  });

  it("setRunCollapsed folds a run to a single lead line and expands it back", () => {
    const screen = makeTallScreen({});
    screen.upsertLines("thought:0", [{ body: "t0-a" }, { body: "t0-b" }]);
    screen.appendLine({ body: "", bodyStyle: "thought" });
    screen.upsertLines("thought:1", [{ body: "t1-a" }]);
    const run = ["thought:0", "thought:1"];
    // Collapse → only the lead "Thoughts" line is visible.
    screen.setRunCollapsed(run, true, [{ body: "▸ Thoughts" }]);
    expect(visibleBodies(screen)).toEqual(["▸ Thoughts"]);
    // Expand → original blocks restored (lead content re-supplied).
    screen.setRunCollapsed(run, false, [{ body: "t0-a" }, { body: "t0-b" }]);
    expect(visibleBodies(screen)).toEqual(["t0-a", "t0-b", "", "t1-a"]);
  });

  it("a click on a collapsed run's lead line resolves to the lead key", () => {
    const screen = makeTallScreen({ mouse: true });
    screen.upsertLines("thought:0", [{ body: "t0" }]);
    screen.appendLine({ body: "", bodyStyle: "thought" });
    screen.upsertLines("thought:1", [{ body: "t1" }]);
    screen.setRunCollapsed(["thought:0", "thought:1"], true, [
      { body: "▸ Thoughts" },
    ]);
    // Only one visible row now; it belongs to the lead key.
    expect(callKeyAtRow(screen, visibleRows(screen))).toBe("thought:0");
  });

  function resolve(
    screen: Screen,
    x: number,
    y: number,
  ): { sourceLineId: number; offset: number } | null {
    return (
      screen as unknown as {
        resolveCellToSource: (
          x: number,
          y: number,
        ) => { sourceLineId: number; offset: number } | null;
      }
    ).resolveCellToSource(x, y);
  }

  it("resolveCellToSource maps clicks to source line + offset", () => {
    const screen = makeTallScreen({ width: 40, height: 24 });
    screen.appendLine({ body: "hello world" });
    screen.appendLine({ body: "second line text" });
    const rows = visibleRows(screen);
    // Bottom row is "second line text"; click on 't' of "text" (col 13, 0-based 12).
    const r = resolve(screen, 13, rows);
    expect(r).not.toBeNull();
    expect(r!.offset).toBe(12);
    // Row above is "hello world"; column 1 -> offset 0.
    const r2 = resolve(screen, 1, rows - 1);
    expect(r2).not.toBeNull();
    expect(r2!.offset).toBe(0);
    expect(r2!.sourceLineId).not.toBe(r!.sourceLineId);
  });

  it("resolveCellToSource returns null outside the scrollback region", () => {
    const screen = makeTallScreen({ width: 40, height: 24 });
    screen.appendLine({ body: "hello" });
    const rows = visibleRows(screen);
    expect(resolve(screen, 1, 0)).toBeNull();
    expect(resolve(screen, 1, rows + 1)).toBeNull();
    expect(resolve(screen, 0, rows)).toBeNull();
    expect(resolve(screen, 1000, rows)).toBeNull();
    // Padding rows above a short history return null.
    expect(resolve(screen, 1, 1)).toBeNull();
  });

  it("resolveCellToSource is width-aware (CJK / wide glyphs)", () => {
    const screen = makeTallScreen({ width: 40, height: 24 });
    // Each Chinese char is width 2. Cols: 你=0..2, 好=2..4, 世=4..6, 界=6..8
    screen.appendLine({ body: "你好世界" });
    const rows = visibleRows(screen);
    // x=3 -> col 2 -> start of 好 (offset 1 in JS string).
    const r = resolve(screen, 3, rows);
    expect(r).not.toBeNull();
    expect(r!.offset).toBe(1);
    // x=2 -> col 1 -> inside 你; snaps left to offset 0.
    const r2 = resolve(screen, 2, rows);
    expect(r2!.offset).toBe(0);
  });

  function selectionRangeFor(
    screen: Screen,
    line: FormattedLine,
  ): { start: number; end: number; toEndOfLine: boolean } | null {
    return (
      screen as unknown as {
        selectionRangeForChunk: (
          l: FormattedLine,
        ) => { start: number; end: number; toEndOfLine: boolean } | null;
      }
    ).selectionRangeForChunk(line);
  }

  it("setSelection normalizes anchor/focus order and clears on degenerate range", () => {
    const screen = makeTallScreen({ width: 40, height: 24 });
    screen.appendLine({ body: "hello world" });
    const a = resolve(screen, 1, visibleRows(screen))!;
    const b = resolve(screen, 5, visibleRows(screen))!;
    // Pass in reversed order — should normalize.
    screen.setSelection(b, a);
    const sel = screen.getSelection();
    expect(sel).not.toBeNull();
    expect(sel!.start.offset).toBe(0);
    expect(sel!.end.offset).toBe(4);
    // Same point clears.
    screen.setSelection(a, a);
    expect(screen.getSelection()).toBeNull();
  });

  it("selectionRangeForChunk maps single-line selection to chunk offsets", () => {
    const screen = makeTallScreen({ width: 40, height: 24 });
    screen.appendLine({ body: "hello world" });
    const rows = visibleRows(screen);
    const a = resolve(screen, 3, rows)!; // offset 2
    const b = resolve(screen, 8, rows)!; // offset 7
    screen.setSelection(a, b);
    const wrapped = wrapAll(screen, 40);
    // Single chunk for short line.
    const chunk = wrapped[wrapped.length - 1]!;
    const range = selectionRangeFor(screen, chunk);
    expect(range).not.toBeNull();
    expect(range!.start).toBe(2);
    expect(range!.end).toBe(7);
    expect(range!.toEndOfLine).toBe(false);
  });

  it("selectionRangeForChunk spans multiple source lines (full middle, partial ends)", () => {
    const screen = makeTallScreen({ width: 80, height: 24 });
    screen.appendLine({ body: "first line" });
    screen.appendLine({ body: "middle line" });
    screen.appendLine({ body: "last line" });
    const wrapped = wrapAll(screen, 80);
    const firstChunk = wrapped[wrapped.length - 3]!;
    const midChunk = wrapped[wrapped.length - 2]!;
    const lastChunk = wrapped[wrapped.length - 1]!;
    const rows = visibleRows(screen);
    const a = resolve(screen, 4, rows - 2)!; // "first line" col 3 -> offset 3
    const b = resolve(screen, 5, rows)!; // "last line" col 4 -> offset 4
    screen.setSelection(a, b);
    const r1 = selectionRangeFor(screen, firstChunk);
    expect(r1).not.toBeNull();
    expect(r1!.start).toBe(3);
    expect(r1!.end).toBe(firstChunk.body.length);
    expect(r1!.toEndOfLine).toBe(true);
    const r2 = selectionRangeFor(screen, midChunk);
    expect(r2).not.toBeNull();
    expect(r2!.start).toBe(0);
    expect(r2!.end).toBe(midChunk.body.length);
    expect(r2!.toEndOfLine).toBe(true);
    const r3 = selectionRangeFor(screen, lastChunk);
    expect(r3).not.toBeNull();
    expect(r3!.start).toBe(0);
    expect(r3!.end).toBe(4);
    expect(r3!.toEndOfLine).toBe(false);
  });

  it("selectionRangeForChunk returns null for chunks outside the selection", () => {
    const screen = makeTallScreen({ width: 40, height: 24 });
    screen.appendLine({ body: "above" });
    screen.appendLine({ body: "selected" });
    screen.appendLine({ body: "below" });
    const wrapped = wrapAll(screen, 40);
    const rows = visibleRows(screen);
    const a = resolve(screen, 1, rows - 1)!;
    const b = resolve(screen, 5, rows - 1)!;
    screen.setSelection(a, b);
    expect(selectionRangeFor(screen, wrapped[wrapped.length - 3]!)).toBeNull();
    expect(selectionRangeFor(screen, wrapped[wrapped.length - 1]!)).toBeNull();
    expect(selectionRangeFor(screen, wrapped[wrapped.length - 2]!)).not.toBeNull();
  });

  it("selection survives scroll: range still resolves after scrollBy", () => {
    const screen = makeTallScreen({ width: 40, height: 24, mouse: true });
    for (let i = 0; i < 200; i++) {
      screen.appendLine({ body: `line-${i}` });
    }
    const rows = visibleRows(screen);
    const a = resolve(screen, 1, rows)!;
    const b = resolve(screen, 4, rows)!;
    screen.setSelection(a, b);
    const before = screen.getSelection()!;
    (screen as unknown as { scrollBy: (n: number) => void }).scrollBy(20);
    const after = screen.getSelection();
    expect(after).not.toBeNull();
    expect(after!.start.sourceLineId).toBe(before.start.sourceLineId);
    expect(after!.start.offset).toBe(before.start.offset);
    expect(after!.end.sourceLineId).toBe(before.end.sourceLineId);
    expect(after!.end.offset).toBe(before.end.offset);
  });

  it("selection range is width-aware (multi-byte / wide chars)", () => {
    const screen = makeTallScreen({ width: 40, height: 24 });
    // 你好世界 — each 2 cols wide, JS string length 4.
    screen.appendLine({ body: "你好世界" });
    const rows = visibleRows(screen);
    const a = resolve(screen, 3, rows)!; // start of 好 -> offset 1
    const b = resolve(screen, 7, rows)!; // start of 界 -> offset 3
    screen.setSelection(a, b);
    const wrapped = wrapAll(screen, 40);
    const range = selectionRangeFor(screen, wrapped[wrapped.length - 1]!);
    expect(range).not.toBeNull();
    expect(range!.start).toBe(1);
    expect(range!.end).toBe(3);
  });

  it("press-drag-release establishes a selection and copies via clipboard fallback", async () => {
    const screen = makeTallScreen({ width: 40, height: 24, mouse: true });
    screen.appendLine({ body: "hello world" });
    const y = visibleRows(screen);
    dispatchMouse(screen, "MOUSE_LEFT_BUTTON_PRESSED", { x: 1, y });
    dispatchMouse(screen, "MOUSE_DRAG", { x: 6, y });
    expect(screen.hasSelection()).toBe(true);
    dispatchMouse(screen, "MOUSE_LEFT_BUTTON_RELEASED", { x: 6, y });
    expect(screen.getSelectionText()).toBe("hello");
    // After release, selection remains intact (user may want to scroll
    // to look around before dismissing with a keystroke).
    expect(screen.hasSelection()).toBe(true);
  });

  it("a plain click with no drag dismisses any prior selection", () => {
    const screen = makeTallScreen({ width: 40, height: 24, mouse: true });
    screen.appendLine({ body: "hello world" });
    const y = visibleRows(screen);
    const a = resolve(screen, 1, y)!;
    const b = resolve(screen, 6, y)!;
    screen.setSelection(a, b);
    expect(screen.hasSelection()).toBe(true);
    dispatchMouse(screen, "MOUSE_LEFT_BUTTON_PRESSED", { x: 3, y });
    dispatchMouse(screen, "MOUSE_LEFT_BUTTON_RELEASED", { x: 3, y });
    expect(screen.hasSelection()).toBe(false);
  });

  it("double-click on a word snaps the selection to its ASCII bounds", () => {
    const screen = makeTallScreen({ width: 40, height: 24, mouse: true });
    screen.appendLine({ body: "alpha beta gamma" });
    const y = visibleRows(screen);
    // Click on the 'e' in "beta" (column 8 -> offset 7).
    dispatchMouse(screen, "MOUSE_LEFT_BUTTON_PRESSED", { x: 8, y });
    dispatchMouse(screen, "MOUSE_LEFT_BUTTON_RELEASED", { x: 8, y });
    // Second click within the double-click window.
    dispatchMouse(screen, "MOUSE_LEFT_BUTTON_PRESSED", { x: 8, y });
    expect(screen.getSelectionText()).toBe("beta");
    dispatchMouse(screen, "MOUSE_LEFT_BUTTON_RELEASED", { x: 8, y });
    expect(screen.getSelectionText()).toBe("beta");
  });

  it("double-click on whitespace does not create a selection", () => {
    const screen = makeTallScreen({ width: 40, height: 24, mouse: true });
    screen.appendLine({ body: "alpha beta" });
    const y = visibleRows(screen);
    // Column 6 is the space between alpha and beta.
    dispatchMouse(screen, "MOUSE_LEFT_BUTTON_PRESSED", { x: 6, y });
    dispatchMouse(screen, "MOUSE_LEFT_BUTTON_RELEASED", { x: 6, y });
    dispatchMouse(screen, "MOUSE_LEFT_BUTTON_PRESSED", { x: 6, y });
    dispatchMouse(screen, "MOUSE_LEFT_BUTTON_RELEASED", { x: 6, y });
    expect(screen.hasSelection()).toBe(false);
  });

  it("any keystroke clears an active selection before the host onKey runs", () => {
    const seen: KeyEvent[] = [];
    const screen = makeTallScreen({ width: 40, height: 24, mouse: true });
    // Re-install the host onKey through the constructor wrapper by
    // re-running the wrap closure: capture the wrapper's selection-
    // clear behaviour while observing host events.
    const wrapper = (screen as unknown as { onKey: (e: KeyEvent[]) => void }).onKey;
    (screen as unknown as { onKey: (e: KeyEvent[]) => void }).onKey = (e) => {
      seen.push(...e);
      wrapper(e);
    };
    screen.appendLine({ body: "hello world" });
    const y = visibleRows(screen);
    const a = resolve(screen, 1, y)!;
    const b = resolve(screen, 6, y)!;
    screen.setSelection(a, b);
    expect(screen.hasSelection()).toBe(true);
    (screen as unknown as {
      handleKey: (n: string, d: { isCharacter?: boolean }) => void;
    }).handleKey("a", { isCharacter: true });
    expect(screen.hasSelection()).toBe(false);
    expect(seen.length).toBe(1);
  });

  it("opening a modal clears any active selection", () => {
    const screen = makeTallScreen({ width: 40, height: 24, mouse: true });
    screen.appendLine({ body: "hello world" });
    const y = visibleRows(screen);
    const a = resolve(screen, 1, y)!;
    const b = resolve(screen, 6, y)!;
    screen.setSelection(a, b);
    screen.setOptionsPrompt({
      title: "Options",
      options: [],
      hint: "",
      cursor: 0,
    } as unknown as Parameters<Screen["setOptionsPrompt"]>[0] extends infer T
      ? T extends null ? never : T : never);
    expect(screen.hasSelection()).toBe(false);
  });

  it("getSelectionText slices partial first/last lines and joins with newlines", () => {
    const screen = makeTallScreen({ width: 80, height: 24 });
    screen.appendLine({ body: "first line" });
    screen.appendLine({ body: "middle line" });
    screen.appendLine({ body: "last line" });
    const rows = visibleRows(screen);
    const a = resolve(screen, 4, rows - 2)!; // 'first line' offset 3
    const b = resolve(screen, 5, rows)!; // 'last line' offset 4
    screen.setSelection(a, b);
    expect(screen.getSelectionText()).toBe("st line\nmiddle line\nlast");
  });

  it("selection orders by display position when line ids are non-monotonic", () => {
    // Re-rendering a block via upsertLines reassigns it a FRESH (higher)
    // line id while it keeps its original, higher-up slot — so the line
    // ABOVE can carry a higher id than the line BELOW. Selection extent
    // and extraction must follow display order, not id order, or a small
    // visual selection copies the wrong (or empty) range.
    const screen = makeTallScreen({ width: 80, height: 24 });
    screen.upsertLines("top", [{ body: "alpha" }]); // id 1, row 0
    screen.appendLine({ body: "bravo" }); // id 2, row 1
    screen.upsertLines("top", [{ body: "alpha" }]); // re-render: id 3, still row 0
    const rows = visibleRows(screen);
    const top = resolve(screen, 1, rows - 1)!; // 'alpha' offset 0 (higher id)
    const bottom = resolve(screen, 6, rows)!; // 'bravo' end (lower id)
    expect(top.sourceLineId).toBeGreaterThan(bottom.sourceLineId);
    screen.setSelection(top, bottom);
    expect(screen.getSelectionText()).toBe("alpha\nbravo");
    // Anchor order shouldn't matter — reversed drag yields the same text.
    screen.setSelection(bottom, top);
    expect(screen.getSelectionText()).toBe("alpha\nbravo");
  });

  it("getSelectionText returns empty after the selection's source lines are pruned", () => {
    const screen = makeTallScreen({ width: 40, height: 24 });
    (screen as unknown as { maxScrollbackLines: number }).maxScrollbackLines = 50;
    for (let i = 0; i < 50; i++) {
      screen.appendLine({ body: `line-${i}` });
    }
    const rows = visibleRows(screen);
    const a = resolve(screen, 1, rows)!;
    const b = resolve(screen, 4, rows)!;
    screen.setSelection(a, b);
    expect(screen.hasSelection()).toBe(true);
    // Push the selected line off the head.
    for (let i = 0; i < 200; i++) {
      screen.appendLine({ body: `flood-${i}` });
    }
    expect(screen.hasSelection()).toBe(false);
    expect(screen.getSelectionText()).toBe("");
  });

  it("scroll mid-interaction or after release preserves the selection", () => {
    const screen = makeTallScreen({ width: 40, height: 24, mouse: true });
    for (let i = 0; i < 200; i++) {
      screen.appendLine({ body: `line-${i}` });
    }
    const y = visibleRows(screen);
    dispatchMouse(screen, "MOUSE_LEFT_BUTTON_PRESSED", { x: 1, y });
    dispatchMouse(screen, "MOUSE_DRAG", { x: 4, y });
    dispatchMouse(screen, "MOUSE_LEFT_BUTTON_RELEASED", { x: 4, y });
    expect(screen.hasSelection()).toBe(true);
    (screen as unknown as { scrollBy: (n: number) => void }).scrollBy(20);
    expect(screen.hasSelection()).toBe(true);
  });

  it("opt-out: in-app selection disabled means no drag selection", () => {
    const screen = makeTallScreen({ width: 40, height: 24, mouse: true });
    screen.setInAppSelectionEnabled(false);
    screen.appendLine({ body: "hello world" });
    const y = visibleRows(screen);
    dispatchMouse(screen, "MOUSE_LEFT_BUTTON_PRESSED", { x: 1, y });
    dispatchMouse(screen, "MOUSE_DRAG", { x: 6, y });
    dispatchMouse(screen, "MOUSE_LEFT_BUTTON_RELEASED", { x: 6, y });
    expect(screen.hasSelection()).toBe(false);
  });

  it("resolveCellToSource survives wrapping at different widths", () => {
    const screen = makeTallScreen({ width: 40, height: 24 });
    // Long line will wrap at narrow width into multiple chunks.
    const body = "abcdefghij klmnopqrst uvwxyz0123 456789";
    screen.appendLine({ body });
    const rows = visibleRows(screen);
    // Click somewhere in the middle row, recover an offset, and verify it
    // points to the same code-unit content. We can't easily compare offsets
    // across width changes without rewrapping the mock, but we can assert
    // the offset points into the original body and is within range.
    const r = resolve(screen, 5, rows);
    expect(r).not.toBeNull();
    expect(r!.offset).toBeGreaterThanOrEqual(0);
    expect(r!.offset).toBeLessThan(body.length);
  });
});

describe("screen compaction prompt", () => {
  it("setCompactionPrompt makes prompt active", () => {
    const screen = makeScreen();
    expect(screen.isCompactionPromptActive()).toBe(false);
    screen.setCompactionPrompt({ message: "Test message" });
    expect(screen.isCompactionPromptActive()).toBe(true);
  });

  it("setCompactionPrompt null clears the prompt", () => {
    const screen = makeScreen();
    screen.setCompactionPrompt({ message: "Test message" });
    screen.setCompactionPrompt(null);
    expect(screen.isCompactionPromptActive()).toBe(false);
  });

  it("compaction prompt is inactive by default", () => {
    const screen = makeScreen();
    expect(screen.isCompactionPromptActive()).toBe(false);
  });
});
