import { describe, expect, it } from "vitest";
import type { Terminal } from "terminal-kit";
import type { FormattedLine } from "./format.js";
import type { InputDispatcher } from "./input.js";
import { Screen } from "./screen.js";

// Minimal mock term: width 10/height 10 makes repaint() short-circuit
// (it bails when width < 20), so we never exercise the draw path. We
// access private state via casts; TS privates are compile-time only.
function makeScreen(opts: { maxScrollbackLines?: number } = {}): Screen {
  const term = {
    width: 10,
    height: 10,
    on() {},
    off() {},
  } as unknown as Terminal;
  const dispatcher = {} as InputDispatcher;
  return new Screen({
    term,
    dispatcher,
    onKey: () => {},
    repaintThrottleMs: 0,
    maxScrollbackLines: opts.maxScrollbackLines,
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
    expect(getWrapCache(screen).size).toBe(0);
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
    // Two lines: leading separator (the very first stream gets no separator
    // since lines was empty) — actually, the first streaming call with
    // empty scrollback creates exactly one line. Sanity-check that.
    expect(lines.length).toBeGreaterThan(0);
    wrapAll(screen, 80);
    const cacheBefore = getWrapCache(screen).size;
    expect(cacheBefore).toBeGreaterThan(0);
    // Stream another chunk — should mutate the last line in place and
    // drop its cache entry.
    screen.appendStreaming(" world", "  ", "agent");
    const cacheAfter = getWrapCache(screen).size;
    expect(cacheAfter).toBe(cacheBefore - 1);
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
