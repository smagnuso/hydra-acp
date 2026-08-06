import { describe, it, expect } from "vitest";
import { collapseUsage, lifetimeCostOf } from "./usage-collapse.js";

describe("lifetimeCostOf", () => {
  it("sums the split", () => {
    expect(lifetimeCostOf({ costAmount: 1.5, cumulativeCost: 3.5 })).toBe(5);
  });

  it("handles a legacy collapsed record (no cumulativeCost)", () => {
    expect(lifetimeCostOf({ costAmount: 5 })).toBe(5);
  });

  it("handles a retired-only record (no costAmount)", () => {
    // The shape accumulateAndResetCost writes: banked total, current life $0.
    expect(lifetimeCostOf({ used: 0, cumulativeCost: 4.2 })).toBe(4.2);
  });

  it("returns undefined when there is no cost at all", () => {
    expect(lifetimeCostOf({ used: 100, size: 200 })).toBeUndefined();
    expect(lifetimeCostOf(undefined)).toBeUndefined();
  });

  it("distinguishes a genuine zero from absent", () => {
    expect(lifetimeCostOf({ costAmount: 0 })).toBe(0);
  });
});

describe("collapseUsage", () => {
  it("puts the lifetime total in costAmount and drops cumulativeCost", () => {
    const out = collapseUsage({
      used: 100,
      size: 200_000,
      costAmount: 1.5,
      cumulativeCost: 3.5,
      costCurrency: "USD",
    });
    expect(out).toEqual({
      used: 100,
      size: 200_000,
      costAmount: 5,
      costCurrency: "USD",
    });
  });

  // Regression: a spread would carry cumulativeCost onto the wire even though
  // SessionListUsage has no slot for it, and a consumer summing both fields
  // would then double-count.
  it("never emits cumulativeCost, even as undefined", () => {
    const out = collapseUsage({ costAmount: 1, cumulativeCost: 2 });
    expect(Object.keys(out ?? {})).not.toContain("cumulativeCost");
  });

  it("passes a legacy collapsed record through unchanged", () => {
    expect(collapseUsage({ used: 10, costAmount: 5, costCurrency: "USD" })).toEqual({
      used: 10,
      costAmount: 5,
      costCurrency: "USD",
    });
  });

  it("preserves token fields when there is no cost", () => {
    expect(collapseUsage({ used: 10, size: 20 })).toEqual({
      used: 10,
      size: 20,
    });
  });

  it("returns undefined for undefined input", () => {
    expect(collapseUsage(undefined)).toBeUndefined();
  });
});
