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

  it("OSC 8 hyperlink framing is removed, leaving the visible link text", () => {
    // ESC ] 8 ; ; URI ESC \ … ESC ] 8 ; ; ESC \ wraps the caret-styled
    // link text. Both halves plus the caret markup collapse to the text.
    const body =
      "see \x1b]8;;https://example.com\x1b\\^C^_link text^:\x1b]8;;\x1b\\ end";
    expect(stripTkMarkup(body)).toBe("see link text end");
  });

  it("BEL-terminated OSC 8 is also removed", () => {
    const body = "\x1b]8;;https://x\x07^C^_x^:\x1b]8;;\x07";
    expect(stripTkMarkup(body)).toBe("x");
  });
});

describe("CSI SGR — click-to-offset lands on visible-cell boundaries", () => {
  it("treats CSI SGR sequences as zero-width segments", () => {
    // Simulated cli-highlight output: red 'const' followed by reset and
    // the rest of the line. Visible chars: "const x = 1;" (12 cells).
    const body = "\x1b[31mconst\x1b[0m x = 1;";
    const segs = [...segmentForWidth(body)];
    const totalWidth = segs.reduce((n, s) => n + s.width, 0);
    expect(totalWidth).toBe("const x = 1;".length);
  });

  it("offsets snap past preceding SGR openers so a slice starts on a visible char", () => {
    const body = "\x1b[31mconst\x1b[0m only = 42;";
    const segs = [...segmentForWidth(body)];
    // Column 0 clamps to offset 0 by contract (pre-first-cell).
    expect(columnToOffsetFromSegments(segs, 0)).toBe(0);
    // Column 1 must skip the opening `\x1b[31m` and land on 'c' — the
    // regression this fix targets: click-drag on a syntax-highlighted
    // row used to snap to the whole line because the offset landed
    // inside the SGR sequence.
    expect(columnToOffsetFromSegments(segs, 1)).toBe("\x1b[31mc".length);
    // Column 4 sits between 's' and 't' inside the styled span — still
    // in front of the closing `\x1b[0m`.
    expect(columnToOffsetFromSegments(segs, 4)).toBe("\x1b[31mcons".length);
    // Round-trip every visible column.
    const visible = "const only = 42;";
    for (let c = 0; c <= visible.length; c++) {
      const off = columnToOffsetFromSegments(segs, c);
      expect(offsetToColumnFromSegments(segs, off)).toBe(c);
    }
  });

  it("stripTkMarkup removes CSI SGR spans from a syntax-highlighted line", () => {
    const body = "\x1b[31mconst\x1b[0m x = \x1b[32m1\x1b[0m;";
    expect(stripTkMarkup(body)).toBe("const x = 1;");
  });

  it("a mid-line diff-style green span selects to the visible-char slice", () => {
    // Approximation of a highlighted diff line: bright red '-e HOST_UID='
    // hunk sitting inside a green added row.
    const body = "\x1b[32m+        -e HOST_UID=$(id -u)\x1b[0m";
    const segs = [...segmentForWidth(body)];
    const visible = "+        -e HOST_UID=$(id -u)";
    // Selecting "HOST_UID=" (visible cols 12..21).
    const startOff = columnToOffsetFromSegments(segs, 12);
    const endOff = columnToOffsetFromSegments(segs, 21);
    expect(stripTkMarkup(body.slice(startOff, endOff))).toBe("HOST_UID=");
    // The total visible width matches the stripped length.
    const totalWidth = segs.reduce((n, s) => n + s.width, 0);
    expect(totalWidth).toBe(visible.length);
  });
});

describe("segmentForWidth — OSC 8 is zero-width", () => {
  it("treats an OSC 8 span as a single zero-width segment", () => {
    const body = "a\x1b]8;;https://x\x1b\\b\x1b]8;;\x1b\\c";
    const segs = [...segmentForWidth(body)];
    const totalWidth = segs.reduce((n, s) => n + s.width, 0);
    // Visible cells: a, b, c → width 3, regardless of the OSC 8 bytes.
    expect(totalWidth).toBe(3);
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
