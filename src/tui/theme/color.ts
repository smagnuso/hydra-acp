// Colour values, and the arithmetic a sparse theme needs.
//
// The rest of the theme deals in SGR byte pairs. This module deals in colours
// as values, which is what makes derivation possible: you cannot lighten
// "\x1b[31m", but you can lighten #cc0000.
//
// Two representations, deliberately:
//
//   ansi(n)  — "slot n of the terminal's own 16 colours". Emits the legacy
//              30-37 / 90-97 codes, so it renders in whatever the user has
//              configured. This is the default palette, and it is why an
//              unthemed hydra adapts to a light terminal for free.
//   rgb(...) — an explicit colour, from a theme file. Emits 24-bit on
//              terminals that take it and quantises to the 256-colour cube
//              otherwise.
//
// Keeping ansi as a first-class case rather than resolving the 16 slots to hex
// matters: resolving them would pin the palette to one terminal's idea of
// "red" and break every user who has themed their terminal already.

/** A colour slot in the terminal's own 16, 0-15. */
export interface AnsiColor {
  kind: "ansi";
  index: number;
}

/** An explicit 8-bit-per-channel colour. */
export interface RgbColor {
  kind: "rgb";
  r: number;
  g: number;
  b: number;
}

export type Color = AnsiColor | RgbColor;

const clamp255 = (n: number): number =>
  Math.max(0, Math.min(255, Math.round(n)));

export function ansi(index: number): AnsiColor {
  if (!Number.isInteger(index) || index < 0 || index > 15) {
    throw new Error(`ansi() takes 0-15, got ${index}`);
  }
  return { kind: "ansi", index };
}

export function rgb(r: number, g: number, b: number): RgbColor {
  return { kind: "rgb", r: clamp255(r), g: clamp255(g), b: clamp255(b) };
}

/**
 * Parse `#rgb`, `#rrggbb`, or `rgb(r,g,b)`. Returns null on anything else so a
 * malformed theme can be reported rather than silently rendering black.
 */
export function parseColor(text: string): Color | null {
  const s = text.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s);
  if (hex) {
    const h = hex[1]!;
    if (h.length === 3) {
      return rgb(
        parseInt(h[0]! + h[0]!, 16),
        parseInt(h[1]! + h[1]!, 16),
        parseInt(h[2]! + h[2]!, 16),
      );
    }
    return rgb(
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16),
    );
  }
  const fn = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(s);
  if (fn) {
    return rgb(Number(fn[1]), Number(fn[2]), Number(fn[3]));
  }
  return null;
}

// ---------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------

const CSI = "\x1b[";

/**
 * Quantise an RGB colour onto the xterm 256-colour palette.
 *
 * Considers both the 6x6x6 cube and the 24-step gray ramp and picks whichever
 * is closer, because the cube's gray diagonal is coarse — #808080 lands much
 * better on the ramp than on the nearest cube cell.
 */
export function quantize256(c: RgbColor): number {
  const cubeAxis = (v: number): number => {
    // xterm's cube levels are 0, 95, 135, 175, 215, 255 — not evenly spaced.
    const levels = [0, 95, 135, 175, 215, 255];
    let best = 0;
    for (let i = 1; i < levels.length; i++) {
      if (Math.abs(levels[i]! - v) < Math.abs(levels[best]! - v)) {
        best = i;
      }
    }
    return best;
  };
  const levels = [0, 95, 135, 175, 215, 255];
  const ri = cubeAxis(c.r);
  const gi = cubeAxis(c.g);
  const bi = cubeAxis(c.b);
  const cubeIdx = 16 + 36 * ri + 6 * gi + bi;
  const cubeErr =
    (levels[ri]! - c.r) ** 2 +
    (levels[gi]! - c.g) ** 2 +
    (levels[bi]! - c.b) ** 2;

  // Gray ramp: indices 232-255 are 8, 18, ... 238.
  const grayValue = (c.r + c.g + c.b) / 3;
  let gStep = Math.round((grayValue - 8) / 10);
  gStep = Math.max(0, Math.min(23, gStep));
  const grayLevel = 8 + gStep * 10;
  const grayErr =
    (grayLevel - c.r) ** 2 + (grayLevel - c.g) ** 2 + (grayLevel - c.b) ** 2;

  return grayErr < cubeErr ? 232 + gStep : cubeIdx;
}

/**
 * `c` on the 256-colour grayscale ramp, whatever its hue.
 *
 * quantize256 picks the ramp only when the ramp is the closer match, which is
 * right for a colour. For a band it is not: a tinted slate lands in the cube and
 * gains a visible cast at 256 colours, and there is no need for one — the ramp's
 * 10-unit steps are finer than the step a band is.
 */
export function quantize256Grey(c: RgbColor): number {
  const level = (c.r + c.g + c.b) / 3;
  if (level <= 4) {
    return 16;
  }
  if (level >= 247) {
    return 231;
  }
  const step = Math.max(0, Math.min(23, Math.round((level - 8) / 10)));
  return 232 + step;
}

/**
 * How much colour a terminal can show.
 *
 * "none" is a real depth rather than a separate enabled flag, so switching
 * colour off is the same code path as any other depth: every token resolves to
 * empty and nothing downstream needs a branch.
 */
export type ColorDepth = "none" | "ansi16" | "ansi256" | "truecolor";

// Default RGB for the 16 ansi slots, used only to quantise an explicitly
// themed colour down to a 16-colour terminal. Approximate by nature: these
// slots are terminal-configurable, so this is xterm's defaults standing in for
// "whatever the user actually has".
const ANSI16_RGB: Array<[number, number, number]> = [
  [0, 0, 0],
  [128, 0, 0],
  [0, 128, 0],
  [128, 128, 0],
  [0, 0, 128],
  [128, 0, 128],
  [0, 128, 128],
  [192, 192, 192],
  [128, 128, 128],
  [255, 0, 0],
  [0, 255, 0],
  [255, 255, 0],
  [0, 0, 255],
  [255, 0, 255],
  [0, 255, 255],
  [255, 255, 255],
];

// The four slots that carry no hue. A near-grey colour is matched against only
// these, because nearest-RGB alone does not protect it: the greys in the table
// sit at 128 and 192, so a dark grey is equidistant from mid grey and from any
// of the dark hues at 128. `#40414c` — the dracula code band — tied exactly
// between bright black and dark cyan, and index order handed it to cyan. A
// grey band arrived as a saturated teal stripe.
const ANSI16_GREYS = [0, 8, 7, 15];

// How close the channels have to be for a colour to count as grey. Generous on
// purpose: the colours that reach here are bands and dark chrome derived from a
// background, which carry a slight tint from it (dracula's band is 64/65/76,
// a spread of 12) and are meant to read as neutral.
const GREY_CHROMA = 24;

// Above this, a slot's bright counterpart is the better match.
const ANSI16_BRIGHT = 170;

/**
 * The nearest of the four grey ansi slots to `c`, ignoring its hue.
 *
 * Used for near-greys, and for any background marked neutral — see bgParams.
 */
export function quantizeGrey16(c: RgbColor): number {
  let best = 0;
  let bestErr = Infinity;
  for (const i of ANSI16_GREYS) {
    const [r, g, b] = ANSI16_RGB[i]!;
    const err = (r - c.r) ** 2 + (g - c.g) ** 2 + (b - c.b) ** 2;
    if (err < bestErr) {
      bestErr = err;
      best = i;
    }
  }
  return best;
}

/**
 * The nearest of the 16 ansi slots to `c`.
 *
 * Two paths, because one metric cannot serve both. A near-grey is matched
 * against the four grey slots by distance — see ANSI16_GREYS. Anything with a
 * hue keeps its hue, by thresholding each channel against the MIDPOINT of the
 * colour's own range rather than against a fixed 128.
 *
 * Nearest-RGB across all sixteen slots, which this used to be, is wrong for
 * both. It sent dracula's `#40414c` code band to dark cyan on an exact tie with
 * bright black, so every fenced block wore a cyan stripe. And it collapsed the
 * palette on the way past: `#50fa7b` green landed on grey 8, `#ff79c6` pink and
 * `#f1fa8c` yellow both on white 7. Hand-tuned pastels sit near the middle of
 * the cube, where the nearest of sixteen corners is usually a grey — so the
 * theme arrived as no theme at all. Preserving the hue and letting brightness be
 * approximate is the right trade at 4 bits: hue is what carries the meaning.
 */
export function quantize16(c: RgbColor): number {
  const max = Math.max(c.r, c.g, c.b);
  const min = Math.min(c.r, c.g, c.b);
  if (max - min <= GREY_CHROMA) {
    return quantizeGrey16(c);
  }
  // Which channels are "on" for this colour, relative to its own range. The
  // bits are the ansi slot order: red 1, green 2, blue 4, so red+green is
  // yellow (3) and green+blue is cyan (6).
  const mid = (max + min) / 2;
  const hue =
    (c.r >= mid ? 1 : 0) | (c.g >= mid ? 2 : 0) | (c.b >= mid ? 4 : 0);
  return max >= ANSI16_BRIGHT ? hue + 8 : hue;
}

/** SGR parameters that set `c` as the foreground. */
export function fgParams(c: Color, depth: ColorDepth): string {
  const slot = (index: number): string =>
    String(index < 8 ? 30 + index : 90 + (index - 8));
  if (c.kind === "ansi") {
    // Legacy codes, not 38;5;n — these are what the terminal maps to the
    // user's configured palette, and what the pre-theme code emitted.
    return slot(c.index);
  }
  if (depth === "truecolor") {
    return `38;2;${c.r};${c.g};${c.b}`;
  }
  if (depth === "ansi256") {
    return `38;5;${quantize256(c)}`;
  }
  return slot(quantize16(c));
}

/**
 * SGR parameters that set `c` as the background.
 *
 * `neutral` marks a background that is furniture rather than a colour: a band,
 * derived as a step off the theme's own background. Such a colour may inherit a
 * cast from what it was derived from — solarized's is `#002b36`, so its band is
 * a teal-tinted slate — and at 24 bits that reads as intended. At 4 bits there
 * is no tinted slate to be had, and quantising by hue turns the cast into ansi
 * cyan: a vivid stripe where a subtle one was asked for. So a neutral
 * background resolves to a grey slot there, which is the closest thing 4 bits
 * has to "a step off the background".
 */
export function bgParams(
  c: Color,
  depth: ColorDepth,
  neutral: boolean = false,
): string {
  const slot = (index: number): string =>
    String(index < 8 ? 40 + index : 100 + (index - 8));
  if (c.kind === "ansi") {
    return slot(c.index);
  }
  if (depth === "truecolor") {
    return `48;2;${c.r};${c.g};${c.b}`;
  }
  if (depth === "ansi256") {
    return `48;5;${neutral ? quantize256Grey(c) : quantize256(c)}`;
  }
  return slot(neutral ? quantizeGrey16(c) : quantize16(c));
}

export const fgReset = `${CSI}39m`;
export const bgReset = `${CSI}49m`;

export const fgOpen = (c: Color, depth: ColorDepth): string =>
  `${CSI}${fgParams(c, depth)}m`;
export const bgOpen = (
  c: Color,
  depth: ColorDepth,
  neutral: boolean = false,
): string => `${CSI}${bgParams(c, depth, neutral)}m`;

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

// What lets a two-key theme work. A theme that names `bg` and `fg` and nothing
// else still gets legible bands, and one that names `red` gets a bright red
// without having to pick one.

/**
 * Relative luminance, 0-1, per WCAG. Used to decide which direction "lighter"
 * is — the thing that makes a light theme work without a separate code path.
 *
 * An ansi colour has no value to measure, so it reports null: the caller has
 * to fall back rather than guess, since the user's terminal decides what
 * "black" actually is.
 */
export function luminance(c: Color): number | null {
  if (c.kind === "ansi") {
    return null;
  }
  const ch = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
}

/** True when a colour is dark enough that "lighter" means "away from it". */
export function isDark(c: Color, fallback: boolean = true): boolean {
  const l = luminance(c);
  return l === null ? fallback : l < 0.5;
}

/** Move `c` toward white by `amount` (0-1). */
export function lighten(c: Color, amount: number): Color {
  if (c.kind === "ansi") {
    return c;
  }
  return rgb(
    c.r + (255 - c.r) * amount,
    c.g + (255 - c.g) * amount,
    c.b + (255 - c.b) * amount,
  );
}

/** Move `c` toward black by `amount` (0-1). */
export function darken(c: Color, amount: number): Color {
  if (c.kind === "ansi") {
    return c;
  }
  return rgb(c.r * (1 - amount), c.g * (1 - amount), c.b * (1 - amount));
}

/** Blend `b` into `a` by `amount` (0 = all a, 1 = all b). */
export function mix(a: Color, b: Color, amount: number): Color {
  if (a.kind === "ansi" || b.kind === "ansi") {
    return a;
  }
  return rgb(
    a.r + (b.r - a.r) * amount,
    a.g + (b.g - a.g) * amount,
    a.b + (b.b - a.b) * amount,
  );
}

/**
 * The bright counterpart of a base colour.
 *
 * For an ansi slot this is the terminal's own bright slot (0-7 -> 8-15), which
 * is better than computing one: the user has already decided what their bright
 * red looks like. For an explicit colour there is nothing to defer to, so
 * lighten it.
 */
export function brighten(c: Color): Color {
  if (c.kind === "ansi") {
    return c.index < 8 ? ansi(c.index + 8) : c;
  }
  return lighten(c, 0.3);
}

/**
 * A background band a step off `bg`, for the user-message and code stripes.
 *
 * The lift direction follows `bg`'s luminance, which is what lets a light
 * theme work from one key: on a dark background the band is lighter, on a
 * light one it is darker. Without the flip, a light theme's bands would head
 * toward white and vanish.
 */
export function band(bg: Color, step: number): Color {
  if (bg.kind === "ansi") {
    return bg;
  }
  return isDark(bg) ? lighten(bg, step) : darken(bg, step);
}
