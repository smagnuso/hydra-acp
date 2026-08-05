// The `colorblind` theme exists for a functional reason, so it gets a functional
// test: the pairs that carry meaning have to stay distinguishable to eyes with the
// common colour vision deficiencies.
//
// Checking "the two colours differ" would be worthless — red and green differ.
// What matters is whether they still differ AFTER the eye has collapsed the
// red-green axis. So this simulates dichromacy and measures the pairs on the other
// side of that transform.
//
// The same check is run against dracula, which is expected to FAIL it. That is not
// a criticism of dracula: it is what makes this test meaningful rather than
// vacuous, and it is the reason the colorblind theme is worth shipping.

import { describe, expect, it } from "vitest";
import { builtinTheme } from "./builtins.js";
import { setTheme, resolveStyle, type ThemeToken } from "./index.js";

/** sRGB -> linear, since the dichromacy matrices operate on linear light. */
function toLinear(v: number): number {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function toSrgb(v: number): number {
  const c = Math.max(0, Math.min(1, v));
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.round(s * 255);
}

// Viénot-Brettel-Mollon reduced matrices: the standard cheap simulation, applied
// to linear RGB. Deuteranopia is the common one (~6% of men), protanopia rarer
// (~2%); both collapse red against green, along slightly different axes.
const DICHROMACY = {
  deuteranopia: [
    [0.33066007, 0.66933993, 0],
    [0.33066007, 0.66933993, 0],
    [-0.02785538, 0.02785538, 1],
  ],
  protanopia: [
    [0.170556992, 0.829443014, 0],
    [0.170556991, 0.829443008, 0],
    [-0.004517144, 0.004517144, 1],
  ],
} as const;

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function simulate(c: Rgb, kind: keyof typeof DICHROMACY): Rgb {
  const m = DICHROMACY[kind];
  const [r, g, b] = [toLinear(c.r), toLinear(c.g), toLinear(c.b)];
  return {
    r: toSrgb(m[0]![0]! * r + m[0]![1]! * g + m[0]![2]! * b),
    g: toSrgb(m[1]![0]! * r + m[1]![1]! * g + m[1]![2]! * b),
    b: toSrgb(m[2]![0]! * r + m[2]![1]! * g + m[2]![2]! * b),
  };
}

function distance(a: Rgb, b: Rgb): number {
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}

/** The foreground a token resolves to, as rgb. */
function fgOf(token: ThemeToken): Rgb {
  const m = /38;2;(\d+);(\d+);(\d+)/.exec(resolveStyle(token, "truecolor").open);
  if (m === null) {
    throw new Error(`${token} has no rgb foreground`);
  }
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
}

function load(name: string): void {
  const t = builtinTheme(name)!;
  setTheme(t.palette, { roles: t.roles });
}

// The pairs whose members mean OPPOSITE things and appear side by side. Not every
// pair of colours in the theme: `warn` against `error` is deliberately allowed to
// collapse, because mistaking a warning for an error costs a moment and mistaking
// a failure for a success costs more. Spending the palette's separation on the
// second is the trade this theme makes.
const PAIRS: Array<[string, ThemeToken, ThemeToken]> = [
  // notice-error resolves through errorSoft rather than error, which is how the
  // first version of this theme passed a check on `error` while the line the user
  // actually reads collapsed to 52.
  ["success vs failure", "notice-ok", "notice-error"],
  ["success vs hard failure", "notice-ok", "tool-status-fail"],
  // A running tool and a failed one sit in the same block, one line apart.
  ["running vs failed", "tool-status-running", "tool-status-fail"],
  ["diff + vs -", "syntax-addition", "syntax-deletion"],
  ["git staged vs dirty", "git-staged", "git-dirty"],
];

// Below this, two colours are too close for a dichromat to rely on. Calibrated
// with margin on both sides: an ordinary red/green palette collapses these pairs
// to around 86, and this theme's WEAKEST pair manages 135.
const MIN_SEPARATION = 100;

describe("the colorblind theme keeps meaning off the red/green axis", () => {
  for (const kind of ["deuteranopia", "protanopia"] as const) {
    for (const [label, a, b] of PAIRS) {
      it(`${label}, under ${kind}`, () => {
        load("colorblind");
        const d = distance(
          simulate(fgOf(a), kind),
          simulate(fgOf(b), kind),
        );
        expect(d, `${label} separation`).toBeGreaterThan(MIN_SEPARATION);
      });
    }
  }

  // What makes the above a real measurement. A conventional palette encodes these
  // pairs as red versus green, which is precisely the distinction these eyes do
  // not make, so the pairs collapse. If this ever starts passing, the simulation
  // has stopped simulating anything.
  it("and a conventional palette does not", () => {
    load("dracula");
    const collapsed: string[] = [];
    for (const [label, a, b] of PAIRS) {
      const d = distance(
        simulate(fgOf(a), "deuteranopia"),
        simulate(fgOf(b), "deuteranopia"),
      );
      if (d < MIN_SEPARATION) {
        collapsed.push(`${label} (${d.toFixed(0)})`);
      }
    }
    expect(collapsed.length).toBeGreaterThan(0);
  });
});
