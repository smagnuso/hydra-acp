// Coverage for selection mapping on bodies that carry terminal-kit
// caret-style markup (the "agent" / heading / thought scrollback styles
// in format.ts). Two properties must hold:
//   1. Click-to-offset maps a visible column to a code-unit offset that
//      never lands inside a `^X` / `^^` / `^[#...]` span — the
//      column→offset and offset→column round-trip recovers the original
//      visible column for every visible cell.
//   2. The clipboard payload that getSelectionText would produce for a
//      slice carries the visible characters only (markup stripped),
//      regardless of whether the markup sits at the start, in the
//      middle, or at the end of the slice.
//
// The grammar definition lives in screen.ts (`matchTkMarkupAt`,
// `segmentForWidth`, `stripTkMarkup`). This test exercises those at
// the public boundary so any drift between the two consumers
// (column math vs. clipboard extraction) shows up.

import { describe, it, expect } from "vitest";
import {
  columnToOffsetFromSegments,
  offsetToColumnFromSegments,
} from "./column-mapping.js";
import { segmentForWidth, stripTkMarkup } from "./screen.js";

describe("terminal-kit markup — click-to-offset round trips", () => {
  it("leading bold span: click on the visible chars maps past the markup", () => {
    // "^+hello^:" — ^+ opens bold, ^: resets; both are 0 cols.
    const body = "^+hello^:";
    const segs = [...segmentForWidth(body)];
    // Visible cells are [h, e, l, l, o] at columns 0..4.
    expect(columnToOffsetFromSegments(segs, 0)).toBe(0);
    expect(columnToOffsetFromSegments(segs, 1)).toBe("^+h".length);
    expect(columnToOffsetFromSegments(segs, 5)).toBe("^+hello".length);
    // Full sweep round-trips.
    for (let c = 0; c <= 5; c++) {
      const off = columnToOffsetFromSegments(segs, c);
      expect(offsetToColumnFromSegments(segs, off)).toBe(c);
    }
  });

  it("interior code span: offsets never split the markup sequence", () => {
    // "see ^Cfoo^: now" — body with markup mid-line.
    const body = "see ^Cfoo^: now";
    const segs = [...segmentForWidth(body)];
    const visible = "see foo now"; // 11 cells
    expect(visible.length).toBe(11);
    for (let c = 0; c <= visible.length; c++) {
      const off = columnToOffsetFromSegments(segs, c);
      // Resulting offset must sit on a segment boundary -> the
      // substring up to `off` is the segment-prefix concatenation.
      let acc = 0;
      let boundary = false;
      for (const s of segs) {
        if (acc === off) {
          boundary = true;
          break;
        }
        acc += s.text.length;
      }
      if (acc === off) boundary = true;
      expect(boundary).toBe(true);
      // Round trip preserves the visible column.
      expect(offsetToColumnFromSegments(segs, off)).toBe(c);
    }
  });

  it("escaped caret renders as one visible cell", () => {
    // "a^^b" — ^^ is a literal '^' (width 1).
    const body = "a^^b";
    const segs = [...segmentForWidth(body)];
    // Visible: 'a', '^', 'b' — 3 cells.
    expect(columnToOffsetFromSegments(segs, 0)).toBe(0);
    expect(columnToOffsetFromSegments(segs, 1)).toBe(1);
    expect(columnToOffsetFromSegments(segs, 2)).toBe("a^^".length);
    expect(columnToOffsetFromSegments(segs, 3)).toBe(body.length);
  });
});

describe("stripTkMarkup — clipboard text is markup-free", () => {
  it("leading and trailing style spans are removed", () => {
    expect(stripTkMarkup("^+hello^:")).toBe("hello");
  });

  it("interior style spans are removed", () => {
    expect(stripTkMarkup("see ^Cfoo^: now")).toBe("see foo now");
  });

  it("escaped caret ^^ collapses to a single '^'", () => {
    expect(stripTkMarkup("a^^b")).toBe("a^b");
  });

  it("bracketed extended markup is removed", () => {
    expect(stripTkMarkup("a^[#ff0]bright^:b")).toBe("abrightb");
  });

  it("plain ASCII passes through unchanged", () => {
    expect(stripTkMarkup("hello, world!")).toBe("hello, world!");
  });

  it("slice-then-strip produces exactly the visible chars under the selection", () => {
    // Simulate the screen.ts pipeline: pick visible columns, ask the
    // segment-aware mapper for the corresponding code-unit slice,
    // strip markup -> visible substring.
    const body = "^+bold^: middle ^Ccode^: tail";
    const visible = "bold middle code tail";
    const segs = [...segmentForWidth(body)];
    // Select columns [5, 11) -> "middle"
    const start = columnToOffsetFromSegments(segs, 5);
    const end = columnToOffsetFromSegments(segs, 11);
    expect(stripTkMarkup(body.slice(start, end))).toBe(visible.slice(5, 11));
    // Selection that spans across a markup boundary stays clean.
    const start2 = columnToOffsetFromSegments(segs, 0);
    const end2 = columnToOffsetFromSegments(segs, visible.length);
    expect(stripTkMarkup(body.slice(start2, end2))).toBe(visible);
  });
});
