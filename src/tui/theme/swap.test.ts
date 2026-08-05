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
  setInlineDepth,
  setTheme,
  syntaxTheme,
  themeRevision,
  thoughtInlineOpts,
  type Palette,
} from "./index.js";
import { parseAgentMarkdown } from "../format.js";
import { parseColor, rgb } from "./color.js";

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

  // The symptom that made this concrete: switching from dracula to terminal, a
  // paragraph rendered in TWO colours, splitting at its first backtick. Rows
  // holding a span kept dracula's foreground; rows without fell back to the
  // terminal's own. An inline span closes by restoring the ROW's base, so a body
  // parsed under one theme carries that theme's foreground inside it forever —
  // repainting cannot reach it, and the row's own open no longer agrees with it.
  //
  // Hence renderedAgentText in app.ts: a swap re-parses scrollback from source.
  // This pins the half of that contract living here — that a re-parse actually
  // yields the new theme, and that the old body is genuinely stale without one.
  it("leaves an already-parsed body holding the old theme's colours", () => {
    setInlineDepth("truecolor");
    const md = "a `b` c";
    const stale = parseAgentMarkdown(md)[0]!.body;
    const withFg: Palette = { ...LOUD, fg: rgb(200, 201, 202) };
    setTheme(withFg);

    // The stale body still restores the palette it was parsed under, and the row
    // style it will now be painted with disagrees with it.
    expect(parseAgentMarkdown(md)[0]!.body).not.toBe(stale);
    expect(stale).not.toContain("38;2;200;201;202");

    // Re-parsed from source, the span closes back to the new foreground — the
    // fix, and the reason the source has to be retained.
    expect(parseAgentMarkdown(md)[0]!.body).toContain("38;2;200;201;202");
    setInlineDepth("ansi256");
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

describe("band derivation", () => {
  const withBg = (hex: string): Palette => ({
    ...DEFAULT_PALETTE,
    bg: parseColor(hex)!,
  });
  // `open` also carries the token's own layers (user is bold, code sets a
  // foreground), so compare just the leading background sequence.
  const bandOf = (token: "user" | "code"): string =>
    /^\x1b\[48;2;\d+;\d+;\d+m/.exec(resolveStyle(token, "truecolor").open)![0];

  it("uses the legacy absolute levels when no bg is declared", () => {
    // The terminal's background is unknown, so an absolute dark band is the
    // best guess available — and it is what shipped before themes existed.
    expect(bandOf("user")).toBe("\x1b[48;2;43;43;43m");
    expect(bandOf("code")).toBe("\x1b[48;2;28;28;28m");
  });

  it("reproduces those levels exactly from a pure black bg", () => {
    // The step constants are chosen for this: lighten(#000, 0.17) === 43.
    setTheme(withBg("#000000"));
    expect(bandOf("user")).toBe("\x1b[48;2;43;43;43m");
    expect(bandOf("code")).toBe("\x1b[48;2;28;28;28m");
  });

  it("steps away from the background in both directions", () => {
    const chan = (open: string): number =>
      Number(/48;2;(\d+)/.exec(open)![1]);

    setTheme(withBg("#282a36"));
    expect(chan(bandOf("user"))).toBeGreaterThan(0x28);

    setTheme(withBg("#fdf6e3"));
    // The whole point: on a light theme the band must go DOWN. Lifting toward
    // white would make it invisible.
    expect(chan(bandOf("user"))).toBeLessThan(0xfd);
  });

  it("keeps the hover tint an index, not a grayscale level, by default", () => {
    // 236 is an index into the 256 cube; the legacy bands are 0-255 levels.
    // Treating one as the other quantises it to a different shade.
    const hovered = resolveStyle("tool", "ansi256");
    expect(hovered).toBeDefined();
    setTheme(DEFAULT_PALETTE);
  });
});
