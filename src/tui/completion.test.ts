import { describe, expect, it } from "vitest";
import { computeTabCompletion, longestCommonPrefix } from "./completion.js";

describe("longestCommonPrefix", () => {
  it("returns '' for an empty list", () => {
    expect(longestCommonPrefix([])).toBe("");
  });

  it("returns the only entry when there is one", () => {
    expect(longestCommonPrefix(["/foo"])).toBe("/foo");
  });

  it("returns the shared leading characters", () => {
    expect(longestCommonPrefix(["/emacsclient", "/emacsserver"])).toBe(
      "/emacs",
    );
  });

  it("returns '' when nothing is shared", () => {
    expect(longestCommonPrefix(["/foo", "bar"])).toBe("");
  });
});

describe("computeTabCompletion", () => {
  it("returns null when there are no matches", () => {
    expect(computeTabCompletion({ matches: [], firstLine: "/em" })).toBe(null);
  });

  it("commits the full name with a trailing space on a single match", () => {
    expect(
      computeTabCompletion({ matches: ["/emacsclient"], firstLine: "/em" }),
    ).toBe("/emacsclient ");
  });

  it("preserves an existing argument tail when committing a single match", () => {
    expect(
      computeTabCompletion({
        matches: ["/emacsclient"],
        firstLine: "/em foo",
      }),
    ).toBe("/emacsclient foo");
  });

  it("extends to the longest common prefix on multiple matches", () => {
    expect(
      computeTabCompletion({
        matches: ["/emacsclient", "/emacsserver"],
        firstLine: "/em",
      }),
    ).toBe("/emacs");
  });

  it("returns null when already at the divergence point", () => {
    expect(
      computeTabCompletion({
        matches: ["/emacsclient", "/emacsserver"],
        firstLine: "/emacs",
      }),
    ).toBe(null);
  });

  it("does not commit when typed prefix already equals common prefix", () => {
    expect(
      computeTabCompletion({
        matches: ["/foo", "/foobar"],
        firstLine: "/foo",
      }),
    ).toBe(null);
  });

  it("disambiguates after the user types past the divergence", () => {
    expect(
      computeTabCompletion({
        matches: ["/emacsclient"],
        firstLine: "/emacsc",
      }),
    ).toBe("/emacsclient ");
  });
});
