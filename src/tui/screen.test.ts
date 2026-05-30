import { describe, expect, it } from "vitest";
import stringWidth from "string-width";
import type { Terminal } from "terminal-kit";
import type { FormattedLine } from "./format.js";
import type { InputDispatcher } from "./input.js";
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
    return (screen as unknown as { throttledRepaintTimer: NodeJS.Timeout | null })
      .throttledRepaintTimer;
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
