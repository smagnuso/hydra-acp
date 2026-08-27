import { describe, expect, it } from "vitest";
import { layoutRow, truncateToWidth } from "./layout.js";
import type { Chunk, FieldGroup, SlotStyle } from "./layout.js";

const BARE_STYLE: SlotStyle = {
  prefix: "",
  suffix: "",
  fill: "",
  pad: "",
  separator: "",
  separatorToken: "rule-meta",
  ruleToken: "rule",
  padToken: "rule-pad",
  minGap: 0,
};

function group(id: string, chunks: Chunk[], priority = Infinity): FieldGroup {
  return { id, chunks, priority };
}

const ANSI_CODE = /\x1b\[[0-9;]*m/g;

describe("truncateToWidth", () => {
  it("returns the text unchanged when it already fits", () => {
    expect(truncateToWidth("hello", 10)).toBe("hello");
  });

  it("truncates plain text with an ellipsis", () => {
    expect(truncateToWidth("hello world", 6)).toBe("hello…");
  });

  it("returns just an ellipsis at width 1", () => {
    expect(truncateToWidth("hello", 1)).toBe("…");
  });

  it("returns empty string at width 0 or less", () => {
    expect(truncateToWidth("hello", 0)).toBe("");
  });

  it("does not count an embedded ANSI colour code toward width", () => {
    const colored = "\x1b[31mhi\x1b[0m";
    // Visible width is 2 ("hi"); a fitting budget passes it through
    // unchanged, codes and all.
    expect(truncateToWidth(colored, 2)).toBe(colored);
  });

  it("truncates colored text without splitting an escape sequence", () => {
    const colored = "\x1b[31mred alert\x1b[0m";
    const out = truncateToWidth(colored, 5);
    // Every escape sequence present is a complete match — never a
    // partial/dangling code from slicing mid-sequence.
    const codes = out.match(ANSI_CODE) ?? [];
    expect(codes.length).toBeGreaterThan(0);
    // The opening colour code survived whole, and the visible text
    // respects the budget.
    expect(out.startsWith("\x1b[31m")).toBe(true);
    expect(out.replace(ANSI_CODE, "")).toBe("red …");
  });

  it("keeps a full escape code intact even when trailing text is cut", () => {
    const colored = "\x1b[38;5;200mvalue\x1b[0m";
    const out = truncateToWidth(colored, 3);
    expect(out.startsWith("\x1b[38;5;200m")).toBe(true);
    expect(out.endsWith("…")).toBe(true);
    for (const code of out.match(ANSI_CODE) ?? []) {
      expect(code).toMatch(/^\x1b\[[0-9;]*m$/);
    }
  });
});

describe("layoutRow truncation opt-out", () => {
  it("hard-truncates an overflowing chunk by default", () => {
    const left = [
      group("thing", [{ id: "thing", text: "0123456789ABCDEF", token: "content" }]),
    ];
    const result = layoutRow(10, left, [], BARE_STYLE);
    const text = result.chunks.map((c) => c.text).join("");
    expect(text).toContain("…");
    expect(text.length).toBeLessThan("0123456789ABCDEF".length);
  });

  it("drops a truncatable:false chunk whole instead of slicing it", () => {
    const left = [
      group("thing", [
        { id: "thing", text: "0123456789ABCDEF", token: "content", truncatable: false },
      ]),
    ];
    const result = layoutRow(10, left, [], BARE_STYLE);
    const text = result.chunks.map((c) => c.text).join("");
    expect(text).not.toContain("0123456789ABCDEF");
    expect(text).not.toContain("…");
    expect(result.chunks.find((c) => c.id === "thing")).toBeUndefined();
  });

  it("truncatable:false also exempts a flex chunk from shrinking", () => {
    const left = [
      group("thing", [
        {
          id: "thing",
          text: "0123456789ABCDEF",
          token: "content",
          flex: true,
          minWidth: 3,
          truncatable: false,
        },
      ]),
    ];
    // Narrow enough that shrink() would normally kick in; truncatable:
    // false means it's dropped by hardTruncate instead of shrunk down to
    // minWidth with a partial value.
    const result = layoutRow(10, left, [], BARE_STYLE);
    const text = result.chunks.map((c) => c.text).join("");
    expect(text).not.toContain("0123456789ABCDEF");
    expect(result.chunks.find((c) => c.id === "thing")).toBeUndefined();
  });

  it("keeps a truncatable:false chunk intact when it does fit", () => {
    const left = [
      group("thing", [
        { id: "thing", text: "short", token: "content", truncatable: false },
      ]),
    ];
    const result = layoutRow(20, left, [], BARE_STYLE);
    const text = result.chunks.map((c) => c.text).join("");
    expect(text).toContain("short");
  });
});
