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
    let c = startCycle(0, 5, choices, names, [null, null, null], "x");
    c = advanceCycle(c, "a/", 0, 5)!;
    expect(c.index).toBe(1);
    c = advanceCycle(c, "b.ts", 0, 5)!;
    c = advanceCycle(c, "c.ts", 0, 5)!;
    expect(c.index).toBe(0);
  });

  it("steps backwards with a negative step, wrapping to the end", () => {
    const c = startCycle(0, 5, choices, names, [null, null, null], "x");
    expect(advanceCycle(c, "a/", 0, 5, -1)?.index).toBe(2);
  });

  it("ends when the token was edited or moved", () => {
    const c = startCycle(0, 5, choices, names, [null, null, null], "x");
    expect(advanceCycle(c, "a/x", 0, 5)).toBe(null);
    expect(advanceCycle(c, "a/", 0, 6)).toBe(null);
    expect(advanceCycle(c, "a/", 1, 5)).toBe(null);
  });

  it("remembers the token as typed so cancel can restore it", () => {
    const c = advanceCycle(startCycle(0, 5, choices, names, [null, null, null], "@sr"), "a/", 0, 5)!;
    expect(c.original).toBe("@sr");
  });

  it("marks only the active choice in the listing", () => {
    const c = advanceCycle(startCycle(0, 0, choices, names, [null, null, null], "x"), "a/", 0, 0)!;
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

  it("keeps the list in order and marks the selected item, so the marker moves", () => {
    const at = (i: number) =>
      formatListingHint(["a", "b", "c"].map((name, j) => ({ name, selected: j === i })));
    expect(at(0)).toBe("1/3 \u203aa  b  c");
    expect(at(1)).toBe("2/3 a  \u203ab  c");
    expect(at(2)).toBe("3/3 a  b  \u203ac");
  });

  const six = (sel: number) =>
    ["a", "b", "c", "d", "e", "f"].map((name, i) => ({ name, selected: i === sel }));

  it("windows a long list around the selection with ... on the cut sides", () => {
    expect(formatListingHint(six(3), 20)).toBe("4/6 ... c  \u203ad  e  f");
    expect(formatListingHint(six(0), 20)).toBe("1/6 \u203aa  b  c  d ...");
  });

  it("always keeps the selected item, even in a very narrow row", () => {
    expect(formatListingHint(six(3), 8)).toContain("\u203ad");
  });

  it("drops the truncation flag when it does not fit", () => {
    const items = [...six(1), { name: "(cut)", note: true }];
    expect(formatListingHint(items)).toContain("(truncated)");
    expect(formatListingHint(items, 24)).not.toContain("(truncated)");
  });
});
