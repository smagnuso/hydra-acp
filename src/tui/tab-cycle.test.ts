import { describe, expect, it } from "vitest";
import {
  advanceCycle,
  completionWindow,
  cycleListing,
  formatListingHint,
  startCycle,
} from "./tab-cycle.js";

const choices = ["a/", "b.ts", "c.ts"];
const names = ["a/", "b.ts", "c.ts"];

describe("tab cycle", () => {
  it("advances while the token is still the inserted choice, and wraps", () => {
    let c = startCycle(0, 5, choices, names, false, "x");
    c = advanceCycle(c, "a/", 0, 5)!;
    expect(c.index).toBe(1);
    c = advanceCycle(c, "b.ts", 0, 5)!;
    c = advanceCycle(c, "c.ts", 0, 5)!;
    expect(c.index).toBe(0);
  });

  it("steps backwards with a negative step, wrapping to the end", () => {
    const c = startCycle(0, 5, choices, names, false, "x");
    expect(advanceCycle(c, "a/", 0, 5, -1)?.index).toBe(2);
  });

  it("ends when the token was edited or moved", () => {
    const c = startCycle(0, 5, choices, names, false, "x");
    expect(advanceCycle(c, "a/x", 0, 5)).toBe(null);
    expect(advanceCycle(c, "a/", 0, 6)).toBe(null);
    expect(advanceCycle(c, "a/", 1, 5)).toBe(null);
  });

  it("remembers the token as typed so cancel can restore it", () => {
    const c = advanceCycle(startCycle(0, 5, choices, names, false, "@sr"), "a/", 0, 5)!;
    expect(c.original).toBe("@sr");
  });

  it("marks only the active choice in the listing", () => {
    const c = advanceCycle(startCycle(0, 0, choices, names, false, "x"), "a/", 0, 0)!;
    expect(cycleListing(c)).toEqual([
      { name: "a/" },
      { name: "b.ts", selected: true },
      { name: "c.ts" },
    ]);
  });
});

describe("completionWindow", () => {
  it("shows everything when the list fits", () => {
    expect(completionWindow(4, 3, 6)).toEqual({ offset: 0, shown: 4, hidden: 0 });
  });

  it("keeps the top of a long list while the selection is visible", () => {
    expect(completionWindow(20, 2, 6)).toEqual({ offset: 0, shown: 5, hidden: 15 });
    expect(completionWindow(20, 4, 6).offset).toBe(0);
  });

  it("slides so a selection past the first rows stays visible", () => {
    const w = completionWindow(20, 9, 6);
    expect(w.offset).toBe(5);
    expect(9).toBeGreaterThanOrEqual(w.offset);
    expect(9).toBeLessThan(w.offset + w.shown);
  });

  it("clamps at the end of the list", () => {
    expect(completionWindow(20, 19, 6).offset).toBe(15);
  });
});

describe("formatListingHint", () => {
  it("excludes a note from the count and flags the truncation", () => {
    expect(
      formatListingHint([{ name: "a" }, { name: "b" }, { name: "(cut)", note: true }]),
    ).toBe("2 matches: a  b  (truncated)");
  });

  it("lists plain matches with a count", () => {
    expect(formatListingHint([{ name: "a" }, { name: "b" }])).toBe("2 matches: a  b");
  });

  it("leads with the selected item and wraps the rest after it", () => {
    expect(
      formatListingHint([{ name: "a" }, { name: "b", selected: true }, { name: "c" }]),
    ).toBe("2/3 \u203ab  c  a");
  });
});
