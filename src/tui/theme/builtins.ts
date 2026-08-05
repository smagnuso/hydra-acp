// The shipped themes.
//
// Compiled in rather than loaded as JSON because tsup bundles to a single file:
// shipped JSON would need copying to dist and resolving by path at runtime.
// Being TypeScript also means a typo in a colour fails the build.
//
// A note on how these are filled in, because it is not what you might expect
// from the slot names. The sixteen slots borrow the ANSI vocabulary because it
// is familiar, but they are OUR palette feeding OUR roles — they are not a
// terminal's ANSI table. So a built-in fills them so the roles read correctly,
// which sometimes means departing from how the upstream theme maps its ANSI
// slots.
//
// Solarized is the sharp case. Its published ANSI mapping repurposes the bright
// slots for the base grey ramp, so `brightYellow` is a grey. Copied verbatim,
// `roles.active` — the busy indicator, the thing that must be noticeable —
// would render grey and be indistinguishable from idle. So the accents go in
// the bright slots instead.

import { ansi, parseColor, type Color } from "./color.js";
import {
  DEFAULT_PALETTE,
  type ColorOverride,
  type Palette,
} from "./index.js";

/** Parse a hex literal that is known-good, i.e. one written in this file. */
function hex(value: string): Color {
  const c = parseColor(value);
  if (c === null) {
    throw new Error(`built-in theme has a malformed colour: ${value}`);
  }
  return c;
}

interface Sixteen {
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

function palette(slots: Sixteen, extras: { bg: string; fg: string }): Palette {
  const out: Record<string, Color> = {};
  for (const [k, v] of Object.entries(slots)) {
    out[k] = hex(v);
  }
  out.bg = hex(extras.bg);
  out.fg = hex(extras.fg);
  return out as Palette;
}

export interface BuiltinTheme {
  name: string;
  /** Shown in the picker. */
  description: string;
  /** Whether the palette expects a light terminal background. */
  light: boolean;
  palette: Palette;
  /** Role overrides, for a theme that needs more than a palette. */
  roles?: Record<string, ColorOverride>;
}

// dracula: draculatheme.com
const DRACULA = palette(
  {
    black: "#21222c",
    red: "#ff5555",
    green: "#50fa7b",
    yellow: "#f1fa8c",
    blue: "#bd93f9",
    magenta: "#ff79c6",
    cyan: "#8be9fd",
    white: "#f8f8f2",
    brightBlack: "#6272a4",
    brightRed: "#ff6e6e",
    brightGreen: "#69ff94",
    brightYellow: "#ffffa5",
    brightBlue: "#d6acff",
    brightMagenta: "#ff92df",
    brightCyan: "#a4ffff",
    brightWhite: "#ffffff",
  },
  { bg: "#282a36", fg: "#f8f8f2" },
);

// nord: nordtheme.com. Bright slots take nord7/nord5/nord6 where the palette
// has a lighter sibling, and repeat the accent where it does not — nord defines
// one shade per hue.
const NORD = palette(
  {
    black: "#3b4252",
    red: "#bf616a",
    green: "#a3be8c",
    yellow: "#ebcb8b",
    blue: "#81a1c1",
    magenta: "#b48ead",
    cyan: "#88c0d0",
    white: "#e5e9f0",
    brightBlack: "#4c566a",
    brightRed: "#bf616a",
    brightGreen: "#a3be8c",
    brightYellow: "#ebcb8b",
    brightBlue: "#81a1c1",
    brightMagenta: "#b48ead",
    brightCyan: "#8fbcbb",
    brightWhite: "#eceff4",
  },
  { bg: "#2e3440", fg: "#d8dee9" },
);

// gruvbox dark: github.com/morhetz/gruvbox
const GRUVBOX_DARK = palette(
  {
    black: "#282828",
    red: "#cc241d",
    green: "#98971a",
    yellow: "#d79921",
    blue: "#458588",
    magenta: "#b16286",
    cyan: "#689d6a",
    white: "#a89984",
    brightBlack: "#928374",
    brightRed: "#fb4934",
    brightGreen: "#b8bb26",
    brightYellow: "#fabd2f",
    brightBlue: "#83a598",
    brightMagenta: "#d3869b",
    brightCyan: "#8ec07c",
    brightWhite: "#ebdbb2",
  },
  { bg: "#282828", fg: "#ebdbb2" },
);

// solarized light: ethanschoonover.com/solarized
//
// Deliberately NOT solarized's ANSI mapping — see the note at the top of this
// file. The accents go in the bright slots so busy/error/ok stay visible; the
// base ramp fills black/white/brightBlack, which is where the roles that want a
// grey (subtle, and the dim attribute) draw from.
const SOLARIZED_LIGHT = palette(
  {
    black: "#073642",
    red: "#dc322f",
    green: "#859900",
    yellow: "#b58900",
    blue: "#268bd2",
    magenta: "#d33682",
    cyan: "#2aa198",
    white: "#657b83",
    brightBlack: "#93a1a1",
    brightRed: "#cb4b16",
    brightGreen: "#859900",
    brightYellow: "#b58900",
    brightBlue: "#268bd2",
    brightMagenta: "#6c71c4",
    brightCyan: "#2aa198",
    brightWhite: "#073642",
  },
  { bg: "#fdf6e3", fg: "#657b83" },
);

// mono: no hue at all. Every slot is the terminal's own foreground, so the
// distinctions that survive are the ones attributes already carry — bold for
// emphasis and failure, dim for anything receding — plus the glyphs (● ○ ✓ ⚠).
//
// This is why role overrides had to exist before mono could: a palette alone
// makes error, ok and active the same colour and therefore indistinguishable.
// NO_COLOR is the stronger option (no escapes at all); mono keeps the weight.
const MONO_PALETTE: Palette = (() => {
  const out: Record<string, Color> = {};
  for (const key of Object.keys(DEFAULT_PALETTE)) {
    out[key] = ansi(7);
  }
  return out as unknown as Palette;
})();

// solarized dark: the same accents on the dark base ramp. Same departure from
// the published ANSI mapping as the light variant — accents in the bright slots
// so the busy indicator is not a grey.
//
// Shipped because `themeBackground` can only fix the BANDS. A light theme's
// foregrounds are chosen for a light background, so solarized-light on a dark
// terminal stays hard to read however the bands are derived. The answer to
// "solarized on my black terminal" is this, not a knob.
const SOLARIZED_DARK = palette(
  {
    black: "#073642",
    red: "#dc322f",
    green: "#859900",
    yellow: "#b58900",
    blue: "#268bd2",
    magenta: "#d33682",
    cyan: "#2aa198",
    white: "#93a1a1",
    brightBlack: "#586e75",
    brightRed: "#cb4b16",
    brightGreen: "#859900",
    brightYellow: "#b58900",
    brightBlue: "#268bd2",
    brightMagenta: "#6c71c4",
    brightCyan: "#2aa198",
    brightWhite: "#fdf6e3",
  },
  { bg: "#002b36", fg: "#839496" },
);

export const BUILTIN_THEMES: BuiltinTheme[] = [
  {
    name: "terminal",
    description: "your terminal's own 16 colours (default)",
    light: false,
    palette: DEFAULT_PALETTE,
  },
  {
    name: "dracula",
    description: "dark, high contrast, purple-leaning",
    light: false,
    palette: DRACULA,
  },
  {
    name: "nord",
    description: "dark, cool, low contrast",
    light: false,
    palette: NORD,
  },
  {
    name: "gruvbox-dark",
    description: "dark, warm, retro",
    light: false,
    palette: GRUVBOX_DARK,
  },
  {
    name: "solarized-dark",
    description: "dark, low contrast",
    light: false,
    palette: SOLARIZED_DARK,
  },
  {
    name: "solarized-light",
    description: "light",
    light: true,
    palette: SOLARIZED_LIGHT,
  },
  {
    name: "mono",
    description: "no colour; weight and glyphs only",
    light: false,
    palette: MONO_PALETTE,
    roles: {
      // Nothing here adds a hue. These lift the states that must stand out to
      // the brightest slot, and push the quiet ones down, so the hierarchy
      // survives without colour.
      subtle: ansiRole(8),
      muted: ansiRole(8),
      fg: ansiRole(7),
      fgStrong: ansiRole(15),
      active: ansiRole(15),
      error: ansiRole(15),
      warn: ansiRole(15),
      ok: ansiRole(7),
      cold: ansiRole(7),
      accent: ansiRole(15),
      info: ansiRole(7),
      reference: ansiRole(15),
      focus: ansiRole(15),
      // The roles that pair a foreground WITH a background have to be set as
      // pairs. A uniform palette collapses them — every slot being the same
      // colour makes "white text on blue" into white on white — and no single
      // slot assignment fixes it, because `red` is a foreground for errorSoft
      // and a background for matchActive at the same time.
      selection: { bg: ansi(8), fg: ansi(15) },
      selectionBand: { bg: ansi(8) },
      cursor: { bg: ansi(15), fg: ansi(0) },
      promptCursor: { bg: ansi(15), fg: ansi(0) },
      match: { bg: ansi(15), fg: ansi(0) },
      // Distinguishable from `match`, which is the whole point of the active
      // one: mid grey rather than white.
      matchActive: { bg: ansi(7), fg: ansi(0) },
    },
  },
];

/** A role override pinned to one of the terminal's own slots. */
function ansiRole(index: number): ColorOverride {
  return { fg: ansi(index) };
}

export function builtinTheme(name: string): BuiltinTheme | undefined {
  return BUILTIN_THEMES.find((t) => t.name === name);
}

export function builtinNames(): string[] {
  return BUILTIN_THEMES.map((t) => t.name);
}
