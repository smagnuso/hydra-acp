import { describe, it, expect } from "vitest";
import {
  columnToOffset,
  offsetToColumn,
  displayWidth,
  segmentGraphemes,
  columnToOffsetFromSegments,
  offsetToColumnFromSegments,
  type WidthSegment,
} from "./column-mapping.js";

// Fake "caret-style" inline markup: every "<X>" span is a zero-width
// style command. Mirrors how the screen layer tags terminal-kit markup
// spans before handing them to the segment-aware mappers — the
// column-mapping module itself stays free of any markup grammar.
function fakeSegment(str: string): WidthSegment[] {
  const out: WidthSegment[] = [];
  let i = 0;
  while (i < str.length) {
    if (str[i] === "<") {
      const end = str.indexOf(">", i);
      if (end !== -1) {
        out.push({ text: str.slice(i, end + 1), width: 0 });
        i = end + 1;
        continue;
      }
    }
    // ASCII-only test fixture: each char is one cell.
    out.push({ text: str[i]!, width: 1 });
    i += 1;
  }
  return out;
}

describe("columnToOffset — ASCII", () => {
  const s = "hello world";

  it("column 0 -> offset 0", () => {
    expect(columnToOffset(s, 0)).toBe(0);
  });

  it("maps each column 1:1 for ASCII", () => {
    for (let i = 0; i <= s.length; i++)
      expect(columnToOffset(s, i)).toBe(i);
  });

  it("clamps past end to string length", () => {
    expect(columnToOffset(s, 999)).toBe(s.length);
  });

  it("clamps negative to 0", () => {
    expect(columnToOffset(s, -5)).toBe(0);
  });

  it("empty string returns 0 for any column", () => {
    expect(columnToOffset("", 0)).toBe(0);
    expect(columnToOffset("", 5)).toBe(0);
    expect(columnToOffset("", -1)).toBe(0);
  });
});

describe("columnToOffset — CJK (wide)", () => {
  const s = "中文字符"; // 4 wide chars, total width 8

  it("column 0 -> offset 0", () => {
    expect(columnToOffset(s, 0)).toBe(0);
  });

  it("column at right edge of a wide char lands after it", () => {
    expect(columnToOffset(s, 2)).toBe(1);
    expect(columnToOffset(s, 4)).toBe(2);
    expect(columnToOffset(s, 6)).toBe(3);
    expect(columnToOffset(s, 8)).toBe(4);
  });

  it("column inside a wide char snaps to its start", () => {
    expect(columnToOffset(s, 1)).toBe(0);
    expect(columnToOffset(s, 3)).toBe(1);
    expect(columnToOffset(s, 5)).toBe(2);
    expect(columnToOffset(s, 7)).toBe(3);
  });

  it("past end clamps to length", () => {
    expect(columnToOffset(s, 100)).toBe(s.length);
  });
});

describe("columnToOffset — mixed ASCII + CJK", () => {
  const s = "a中b文c"; // widths: 1,2,1,2,1 -> total 7, length 5

  it("walks correctly across the line with no drift", () => {
    expect(columnToOffset(s, 0)).toBe(0); // before 'a'
    expect(columnToOffset(s, 1)).toBe(1); // after 'a'
    expect(columnToOffset(s, 2)).toBe(1); // inside '中'
    expect(columnToOffset(s, 3)).toBe(2); // after '中'
    expect(columnToOffset(s, 4)).toBe(3); // after 'b'
    expect(columnToOffset(s, 5)).toBe(3); // inside '文'
    expect(columnToOffset(s, 6)).toBe(4); // after '文'
    expect(columnToOffset(s, 7)).toBe(5); // after 'c' (end)
  });
});

describe("columnToOffset — emoji & ZWJ sequences", () => {
  it("simple emoji is treated as one wide cluster", () => {
    const s = "a😀b"; // 1 + 2 + 1
    expect(columnToOffset(s, 0)).toBe(0);
    expect(columnToOffset(s, 1)).toBe(1);
    expect(columnToOffset(s, 2)).toBe(1); // inside emoji
    expect(columnToOffset(s, 3)).toBe(s.indexOf("b"));
    expect(columnToOffset(s, 4)).toBe(s.length);
  });

  it("ZWJ family is one cluster, single offset jump", () => {
    const family = "👨‍👩‍👧";
    const s = "x" + family + "y";
    const famStart = 1;
    const famEnd = 1 + family.length;
    expect(columnToOffset(s, 0)).toBe(0);
    expect(columnToOffset(s, 1)).toBe(famStart);
    expect(columnToOffset(s, 2)).toBe(famStart); // inside family
    expect(columnToOffset(s, 3)).toBe(famEnd);
    expect(columnToOffset(s, 4)).toBe(s.length);
  });

  it("skin-tone emoji is a single cluster", () => {
    const e = "👍🏽";
    const s = "[" + e + "]";
    expect(columnToOffset(s, 0)).toBe(0);
    expect(columnToOffset(s, 1)).toBe(1);
    expect(columnToOffset(s, 2)).toBe(1); // inside the emoji
    expect(columnToOffset(s, 3)).toBe(1 + e.length);
    expect(columnToOffset(s, 4)).toBe(s.length);
  });
});

describe("columnToOffset — combining marks", () => {
  it("combining acute attaches to base, width 1, no drift", () => {
    const s = "cafe\u0301"; // 'cafe' + combining acute, width 4, length 5
    expect(displayWidth(s)).toBe(4);
    expect(columnToOffset(s, 0)).toBe(0);
    expect(columnToOffset(s, 1)).toBe(1);
    expect(columnToOffset(s, 2)).toBe(2);
    expect(columnToOffset(s, 3)).toBe(3);
    expect(columnToOffset(s, 4)).toBe(s.length); // past composed 'é'
  });

  it("multiple combining marks stay attached", () => {
    const s = "a\u0301\u0308b"; // a + acute + diaeresis + b
    expect(displayWidth(s)).toBe(2);
    expect(columnToOffset(s, 0)).toBe(0);
    expect(columnToOffset(s, 1)).toBe(3); // after composed 'a'
    expect(columnToOffset(s, 2)).toBe(s.length);
  });
});

describe("columnToOffset — single-cell symbols", () => {
  it("em-dash, bullet, box-drawing all width 1", () => {
    const s = "a—b•c│d";
    expect(displayWidth(s)).toBe(7);
    for (let i = 0; i <= 7; i++) {
      const off = columnToOffset(s, i);
      expect(off).toBeGreaterThanOrEqual(0);
      expect(off).toBeLessThanOrEqual(s.length);
    }
    expect(columnToOffset(s, 1)).toBe(1);
    expect(columnToOffset(s, 2)).toBe(2);
    expect(columnToOffset(s, 7)).toBe(s.length);
  });
});

describe("offsetToColumn — round trip", () => {
  it("ASCII round-trips exactly", () => {
    const s = "hello";
    for (let i = 0; i <= s.length; i++) {
      const col = offsetToColumn(s, i);
      expect(columnToOffset(s, col)).toBe(i);
    }
  });

  it("snaps offsets inside a cluster to its start column", () => {
    const s = "a中b";
    expect(offsetToColumn(s, 0)).toBe(0);
    expect(offsetToColumn(s, 1)).toBe(1);
    expect(offsetToColumn(s, 2)).toBe(3);
    expect(offsetToColumn(s, 3)).toBe(4);
  });

  it("clamps beyond end", () => {
    expect(offsetToColumn("abc", 999)).toBe(3);
    expect(offsetToColumn("abc", -2)).toBe(0);
  });
});

describe("displayWidth & segmentGraphemes", () => {
  it("displayWidth matches sum of grapheme widths", () => {
    const samples = [
      "",
      "hello",
      "中文字符",
      "a😀b👨‍👩‍👧c",
      "cafe\u0301",
      "—•│",
    ];
    for (const s of samples) {
      const sum = segmentGraphemes(s).reduce((a, g) => a + g.width, 0);
      expect(displayWidth(s)).toBe(sum);
    }
  });

  it("no drift: walking columns 0..width recovers monotonic offsets", () => {
    const s = "a中b😀cé—│d";
    const w = displayWidth(s);
    let prev = -1;
    for (let c = 0; c <= w; c++) {
      const off = columnToOffset(s, c);
      expect(off).toBeGreaterThanOrEqual(prev);
      prev = off;
    }
    expect(columnToOffset(s, w)).toBe(s.length);
  });
});

describe("segment-aware mapping — zero-width inline markup", () => {
  it("leading markup: column 0 anchors at offset 0", () => {
    const s = "<b>hi";
    expect(columnToOffsetFromSegments(fakeSegment(s), 0)).toBe(0);
  });

  it("leading markup: clicking visible chars lands past the markup", () => {
    const s = "<b>hi";
    expect(columnToOffsetFromSegments(fakeSegment(s), 1)).toBe("<b>h".length);
    expect(columnToOffsetFromSegments(fakeSegment(s), 2)).toBe("<b>hi".length);
  });

  it("interior markup: column→offset never lands inside the span", () => {
    const s = "ab<style>cd";
    // Walk every column; the returned offset must be at a segment
    // boundary (i.e. never inside the "<style>" substring).
    const markupStart = s.indexOf("<style>");
    const markupEnd = markupStart + "<style>".length;
    for (let c = 0; c <= 4; c++) {
      const off = columnToOffsetFromSegments(fakeSegment(s), c);
      expect(off > markupStart && off < markupEnd).toBe(false);
    }
  });

  it("offset round-trips back to the correct visible column", () => {
    const cases: Array<[string, number, number]> = [
      // [string, code-unit offset of a visible char, expected column]
      ["<b>hello", "<b>".length, 0],          // before 'h'
      ["<b>hello", "<b>h".length, 1],         // after  'h'
      ["a<b>bc", "a".length, 1],              // before markup, after 'a'
      ["a<b>bc", "a<b>".length, 1],           // after markup, before 'b'
      ["a<b>bc", "a<b>b".length, 2],          // after 'b'
      ["xy<r><b>z", "xy<r><b>".length, 2],    // after a run of markup
    ];
    for (const [s, off, col] of cases) {
      const segs = fakeSegment(s);
      expect(offsetToColumnFromSegments(segs, off)).toBe(col);
      // Round trip: column → offset must also land at this boundary
      // (or at the equivalent boundary after any trailing zero-width
      // markup that visually shares the column).
      const back = columnToOffsetFromSegments(segs, col);
      expect(offsetToColumnFromSegments(segs, back)).toBe(col);
    }
  });

  it("full sweep round-trips: every visible column maps to itself", () => {
    const s = "<a>foo<b>bar<c>";
    const segs = fakeSegment(s);
    // Visible width = "foobar".length = 6 (markup contributes 0).
    for (let c = 0; c <= 6; c++) {
      const off = columnToOffsetFromSegments(segs, c);
      expect(offsetToColumnFromSegments(segs, off)).toBe(c);
    }
  });
});
