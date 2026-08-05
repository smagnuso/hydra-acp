import { describe, expect, it } from "vitest";
import { BUILTIN_THEMES } from "./builtins.js";
import type { ColorDepth } from "./color.js";
import { resolveHovered, resolveStyle, setTheme } from "./index.js";

// A standing guard, added after a grey code band shipped as a cyan stripe.
//
// A band is furniture: the user-turn stripe, the code block, the hover tint. It
// says "this row is a different kind of thing", and it has to do that without
// carrying a hue, because a hue means something else everywhere else in the TUI
// (yellow is busy, red is failed). Nothing in the theme *declares* a hue for
// one, so a hued band can only arrive by accident — which is exactly what
// happened: quantize16 tied dracula's #40414c between bright black and dark
// cyan and handed it to cyan, and every fenced code block wore ESC[46m.
//
// The check is on the emitted bytes rather than on the derivation, because the
// derivation was never wrong. The quantiser downstream of it was.

const DEPTHS: ColorDepth[] = ["truecolor", "ansi256", "ansi16"];

// A band may inherit the cast of the background it was derived from — dracula's
// is 64/65/76, solarized's teal #002b36 derives a tinted slate — but it must not
// gain chroma on the way. So the ceiling is the theme's own background, plus a
// small margin for the arithmetic, rather than a fixed number.
const CHROMA_MARGIN = 8;

function chroma(ch: number[]): number {
  return Math.max(...ch) - Math.min(...ch);
}

/** The grey slots of the 16-colour block, as background codes. */
const GREY_BG = new Set([40, 47, 100, 107]);

/** Whether every background this escape string sets is free of hue. */
function backgroundsAreNeutral(sgr: string, ceiling: number): boolean {
  // 24-bit: compare the channels directly.
  for (const m of sgr.matchAll(/48;2;(\d+);(\d+);(\d+)/g)) {
    if (chroma([Number(m[1]), Number(m[2]), Number(m[3])]) > ceiling) {
      return false;
    }
  }
  // 256-colour: the grayscale ramp is 232-255, plus the cube's own black and
  // white at 16 and 231.
  for (const m of sgr.matchAll(/48;5;(\d+)/g)) {
    const idx = Number(m[1]);
    if (!(idx >= 232 || idx === 16 || idx === 231)) {
      return false;
    }
  }
  // Legacy: only the four grey slots. Walks the parameters rather than
  // scanning them, so the operands of an extended-colour sequence are not
  // mistaken for codes of their own — 48;2;43;43;43 is a grey, and a naive
  // scan reads its 43 as ansi yellow.
  for (const m of sgr.matchAll(/\u001b\[([0-9;]*)m/g)) {
    const params = m[1]!.split(";").map(Number);
    for (let i = 0; i < params.length; i++) {
      const n = params[i]!;
      if (n === 38 || n === 48) {
        // 38;5;n / 48;5;n take one operand, 38;2;r;g;b / 48;2;r;g;b take three.
        i += params[i + 1] === 5 ? 2 : 4;
        continue;
      }
      if (((n >= 40 && n <= 47) || (n >= 100 && n <= 107)) && !GREY_BG.has(n)) {
        return false;
      }
    }
  }
  return true;
}

describe("bands carry no hue", () => {
  for (const theme of BUILTIN_THEMES) {
    for (const depth of DEPTHS) {
      it(`${theme.name} at ${depth}`, () => {
        setTheme(theme.palette, { roles: theme.roles });
        const bg = theme.palette.bg;
        const ceiling =
          bg !== undefined && bg.kind === "rgb"
            ? chroma([bg.r, bg.g, bg.b]) + CHROMA_MARGIN
            : CHROMA_MARGIN;
        for (const token of ["code", "user"] as const) {
          const plain = resolveStyle(token, depth);
          expect(
            backgroundsAreNeutral(plain.open, ceiling),
            `${token} -> ${JSON.stringify(plain.open)}`,
          ).toBe(true);
          const hovered = resolveHovered(token, depth);
          if (hovered !== undefined) {
            expect(
              backgroundsAreNeutral(hovered.open, ceiling),
              `${token} hovered -> ${JSON.stringify(hovered.open)}`,
            ).toBe(true);
          }
        }
        const thought = resolveHovered("thought", depth);
        expect(
          backgroundsAreNeutral(thought?.open ?? "", ceiling),
          `thought hovered -> ${JSON.stringify(thought?.open)}`,
        ).toBe(true);
      });
    }
  }
});
