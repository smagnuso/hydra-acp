import { describe, expect, it } from "vitest";
import { sameTags } from "./tags.js";

describe("sameTags", () => {
  it("treats undefined and empty as equal, order-sensitive otherwise", () => {
    expect(sameTags(undefined, [])).toBe(true);
    expect(sameTags(["a", "b"], ["a", "b"])).toBe(true);
    expect(sameTags(["a"], ["b"])).toBe(false);
  });
});
