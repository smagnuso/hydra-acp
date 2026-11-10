import { describe, expect, it } from "vitest";
import {
  fitWidth,
  padEndWidth,
  takeWidth,
  takeWidthEnd,
  textWidth,
  truncateEndWidth,
  truncateMiddleWidth,
} from "./width.js";
import { formatRow, computeWidths } from "../cli/session-row.js";

const ko = "국제화와지역화";

describe("width helpers", () => {
  it("takes whole graphemes within the cell budget", () => {
    expect(takeWidth(ko, 5)).toBe("국제");
    expect(takeWidthEnd(ko, 5)).toBe("역화");
  });

  it("truncates and pads by cells", () => {
    expect(textWidth(truncateEndWidth(ko, 8))).toBeLessThanOrEqual(8);
    expect(truncateEndWidth(ko, 8)).toBe("국제화…");
    expect(textWidth(truncateMiddleWidth(ko, 9))).toBeLessThanOrEqual(9);
    expect(textWidth(padEndWidth(ko, 20))).toBe(20);
    expect(textWidth(fitWidth(ko, 5))).toBe(5);
  });

  it("keeps session rows within the width budget", () => {
    const row = {
      session: "abc", upstream: "", host: "", state: "warm", agent: "x",
      model: "", age: "1m", cwd: "/tmp", title: ko.repeat(4), cost: "",
    } as Parameters<typeof formatRow>[0];
    const widths = computeWidths([row]);
    expect(textWidth(formatRow(row, widths, 40))).toBeLessThanOrEqual(40);
  });
});

import { nextGraphemeOffset, prevGraphemeOffset } from "./width.js";

describe("grapheme offsets", () => {
  const s = "a👍🏽é한";
  it("steps over whole clusters", () => {
    const thumbs = "👍🏽";
    expect(nextGraphemeOffset(s, 1)).toBe(1 + thumbs.length);
    expect(prevGraphemeOffset(s, 1 + thumbs.length)).toBe(1);
    expect(prevGraphemeOffset(s, 0)).toBe(0);
    expect(nextGraphemeOffset(s, s.length)).toBe(s.length);
  });
});
