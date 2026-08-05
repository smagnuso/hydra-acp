// The theme is swappable, and a swap reaches everything derived from it.
//
// The interesting failure mode is a PARTIAL swap: some derived table rebuilt,
// another still holding the old palette, producing a screen mixing two themes.
// So this asserts on each derived surface separately rather than eyeballing one.

import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PALETTE,
  proseInlineOpts,
  resolveStyle,
  setTheme,
  syntaxTheme,
  themeRevision,
  thoughtInlineOpts,
  type Palette,
} from "./index.js";
import { parseAgentMarkdown } from "../format.js";
import { rgb } from "./color.js";

// Distinct explicit colours so a stale value is unmistakable rather than
// coincidentally right.
const LOUD: Palette = {
  ...DEFAULT_PALETTE,
  red: rgb(1, 2, 3),
  green: rgb(4, 5, 6),
  brightYellow: rgb(7, 8, 9),
  brightCyan: rgb(10, 11, 12),
  brightBlue: rgb(13, 14, 15),
  brightBlack: rgb(16, 17, 18),
  cyan: rgb(19, 20, 21),
};

afterEach(() => {
  setTheme(DEFAULT_PALETTE);
});

describe("setTheme", () => {
  it("updates token colours", () => {
    expect(resolveStyle("status-active", "truecolor").open).toBe("\x1b[93m");
    setTheme(LOUD);
    expect(resolveStyle("status-active", "truecolor").open).toBe(
      "\x1b[38;2;7;8;9m",
    );
  });

  it("updates chrome tokens too, not just scrollback styles", () => {
    setTheme(LOUD);
    expect(resolveStyle("box-title", "truecolor").open).toBe(
      "\x1b[38;2;10;11;12m",
    );
  });

  it("updates the inline-span openers", () => {
    // These are read at parse time, so a stale value would bake the old colour
    // into every subsequent body.
    setTheme(LOUD);
    expect(proseInlineOpts().codeOpen).toContain("38;5;");
    expect(thoughtInlineOpts().codeOpen).toContain("38;5;");
    expect(thoughtInlineOpts().base).toContain("38;5;");
  });

  it("updates the syntax theme", () => {
    const before = syntaxTheme().keyword!("X");
    setTheme(LOUD);
    expect(syntaxTheme().keyword!("X")).not.toBe(before);
  });

  it("bumps the revision so derived caches miss", () => {
    const r = themeRevision();
    setTheme(LOUD);
    expect(themeRevision()).toBe(r + 1);
  });

  it("re-highlights a fence rather than serving the cached old palette", () => {
    // The highlight cache holds already-coloured output and is keyed on the
    // revision for exactly this reason.
    const md = "```js\nconst a = 1;\n```";
    const before = parseAgentMarkdown(md).map((l) => l.body).join("");
    setTheme(LOUD);
    const after = parseAgentMarkdown(md).map((l) => l.body).join("");
    expect(after).not.toBe(before);
    expect(after).toContain("38;5;");
  });

  it("restores exactly on the way back", () => {
    const snapshot = () =>
      [
        resolveStyle("status-active", "truecolor").open,
        resolveStyle("box-title", "truecolor").open,
        proseInlineOpts().codeOpen,
        syntaxTheme().keyword!("X"),
      ].join("|");
    const before = snapshot();
    setTheme(LOUD);
    setTheme(DEFAULT_PALETTE);
    expect(snapshot()).toBe(before);
  });
});
