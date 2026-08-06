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

import { ansi, isDark, parseColor, type Color } from "./color.js";
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
  /**
   * The same theme for the opposite background, when there is one. Suggested by
   * themeBackgroundMismatch when a theme is being used on the wrong kind of
   * terminal — the one thing `themeBackground` cannot fix, since a light theme's
   * foregrounds stay unreadable on black however the bands derive.
   *
   * Whether a theme IS light is not recorded here: it is measured from the
   * palette's own `bg`, which cannot drift from the palette the way a flag can.
   */
  counterpart?: string;
  palette: Palette;
  /** Role overrides, for a theme that needs more than a palette. */
  roles?: Record<string, ColorOverride>;
}

// dracula: draculatheme.com
//
// The bright slots carry dracula's ICONIC colours, not its published bright ANSI
// variants. Those variants (#a4ffff, #d6acff, #ffffa5) are pale washes with a
// minimum channel around 170 — they exist to be "more visible on a dark
// background", which for a hand-crafted pastel palette means closer to white.
//
// Most roles read from the bright slots, so copying the variants verbatim put
// accent, active, reference and every heading within a hair of the #f8f8f2
// foreground and rendered dracula near-monochrome. Same trap as solarized's grey
// brightYellow, one layer along: there the variants were greys, here they are
// near-whites, and both times the fix is that OUR bright slots exist to feed
// roles rather than to reproduce a terminal's ANSI table.
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
    // The one variant worth keeping: dracula's comment colour, which is exactly
    // what `subtle` and `muted` want.
    brightBlack: "#6272a4",
    brightRed: "#ff5555",
    brightGreen: "#50fa7b",
    brightYellow: "#f1fa8c",
    brightBlue: "#bd93f9",
    brightMagenta: "#ff79c6",
    brightCyan: "#8be9fd",
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

// catppuccin mocha: catppuccin.com. The default on a dark terminal, and the same
// default herdr ships, which is the point — two tools from the same ecosystem
// sitting side by side should not look like two different products.
//
// This palette is a deliberate exception to the near-white accent guard in
// load.test.ts, and it is worth being precise about why, because the guard exists
// for a real bug. Mocha's accents sit 65-85 from its own foreground; dracula's
// published bright variants, the ones that made it render near-monochrome, sat 85.
// By that measure they are the same kind of colour, and no threshold admits one
// while excluding the other.
//
// What differs is intent. Dracula's brights were a mistake — its ICONIC colours
// are high-contrast and were sitting unused while pale "more visible on a dark
// background" variants got copied in by mistake. Catppuccin has no such
// alternative: low contrast between accent and text IS the palette, chosen
// deliberately, and it is the most widely used palette there is. Shipping it means
// accepting that the guard encodes a preference rather than a law, so the
// exemption names these slots explicitly instead of loosening the rule for
// everyone.
const CATPPUCCIN_MOCHA = palette(
  {
    black: "#45475a", // surface1
    red: "#f38ba8",
    green: "#a6e3a1",
    yellow: "#f9e2af",
    blue: "#89b4fa",
    magenta: "#f5c2e7", // pink
    cyan: "#94e2d5", // teal
    white: "#bac2de", // subtext1
    brightBlack: "#6c7086", // overlay0 — the comment grey muted/subtle want
    brightRed: "#eba0ac", // maroon
    brightGreen: "#a6e3a1",
    // Peach, not the pale yellow: `active` is the busy indicator and `warn` is the
    // yellow above, and those two have to be told apart at a glance.
    brightYellow: "#fab387",
    brightBlue: "#b4befe", // lavender
    brightMagenta: "#cba6f7", // mauve
    brightCyan: "#89dceb", // sky
    brightWhite: "#cdd6f4", // text
  },
  { bg: "#1e1e2e", fg: "#cdd6f4" },
);

// catppuccin frappé and macchiato: the two mid-dark flavours of the same family,
// between mocha (darkest) and latte (light). They differ from mocha almost only
// in how dark the base ramp is — the accents shift with it, staying legible
// against a lighter background — so the slot assignment below is mocha's, value
// for value, and the notes there apply unchanged.
//
// Each needs two of the three accent-guard exemptions mocha needs (pink and
// lavender), and notably not the third: macchiato's #eed49f yellow clears the
// bar at 107 where mocha's #f9e2af fails at 85. See the table in load.test.ts.
const CATPPUCCIN_FRAPPE = palette(
  {
    black: "#51576d", // surface1
    red: "#e78284",
    green: "#a6d189",
    yellow: "#e5c890",
    blue: "#8caaee",
    magenta: "#f4b8e4", // pink
    cyan: "#81c8be", // teal
    white: "#b5bfe2", // subtext1
    brightBlack: "#737994", // overlay0
    brightRed: "#ea999c", // maroon
    brightGreen: "#a6d189",
    // Peach, as in mocha: `active` is the busy indicator and `warn` is the
    // yellow above, and those two have to be told apart at a glance.
    brightYellow: "#ef9f76",
    brightBlue: "#babbf1", // lavender
    brightMagenta: "#ca9ee6", // mauve
    brightCyan: "#99d1db", // sky
    brightWhite: "#c6d0f5", // text
  },
  { bg: "#303446", fg: "#c6d0f5" },
);

const CATPPUCCIN_MACCHIATO = palette(
  {
    black: "#494d64", // surface1
    red: "#ed8796",
    green: "#a6da95",
    yellow: "#eed49f",
    blue: "#8aadf4",
    magenta: "#f5bde6", // pink
    cyan: "#8bd5ca", // teal
    white: "#b8c0e0", // subtext1
    brightBlack: "#6e738d", // overlay0
    brightRed: "#ee99a0", // maroon
    brightGreen: "#a6da95",
    brightYellow: "#f5a97f", // peach
    brightBlue: "#b7bdf8", // lavender
    brightMagenta: "#c6a0f6", // mauve
    brightCyan: "#91d7e3", // sky
    brightWhite: "#cad3f5", // text
  },
  { bg: "#24273a", fg: "#cad3f5" },
);

// catppuccin latte: the light member of the same family, and the neutral light
// theme this set was missing — solarized-light is a cream, this is close to white.
//
// The accents are latte's own, which are DARKER than mocha's rather than being
// the same hues: a pastel on white is invisible. That is also why brightWhite
// here is a dark grey — the slot names are ANSI vocabulary, but the slots feed
// roles, and `fgStrong` has to be the most emphatic foreground, which on a light
// background means the darkest.
const CATPPUCCIN_LATTE = palette(
  {
    black: "#ccd0da", // surface0
    red: "#d20f39",
    green: "#40a02b",
    yellow: "#df8e1d",
    blue: "#1e66f5",
    magenta: "#ea76cb", // pink
    cyan: "#179299", // teal
    white: "#5c5f77", // subtext1
    brightBlack: "#8c8fa1", // subtext0 — the grey for scaffolding
    brightRed: "#e64553", // maroon
    brightGreen: "#40a02b",
    brightYellow: "#fe640b", // peach
    brightBlue: "#7287fd", // lavender
    brightMagenta: "#8839ef", // mauve
    brightCyan: "#04a5e5", // sky
    brightWhite: "#4c4f69", // text: the darkest, per the note above
  },
  { bg: "#eff1f5", fg: "#4c4f69" },
);

// gruvbox light: morhetz/gruvbox's light hard variant. Same inversion as latte —
// the accents are gruvbox's `faded` set (darker) rather than its `bright` one,
// and brightWhite is the darkest foreground rather than the palest.
const GRUVBOX_LIGHT = palette(
  {
    black: "#ebdbb2", // light1
    red: "#9d0006",
    green: "#79740e",
    yellow: "#b57614",
    blue: "#076678",
    magenta: "#8f3f71",
    cyan: "#427b58",
    white: "#504945", // dark2
    brightBlack: "#7c6f64", // dark4: gruvbox's own comment grey for light bgs
    brightRed: "#cc241d",
    brightGreen: "#98971a",
    brightYellow: "#af3a03", // orange: warmer and darker than the yellow, which
    // on cream is nearly illegible as an accent
    brightBlue: "#458588",
    brightMagenta: "#b16286",
    brightCyan: "#689d6a",
    brightWhite: "#3c3836", // dark0
  },
  { bg: "#fbf1c7", fg: "#3c3836" },
);

// tokyo night: enkia/tokyo-night. Distinct from everything else here — dracula is
// purple, nord is cool grey, gruvbox is warm — this is deep blue.
const TOKYO_NIGHT = palette(
  {
    black: "#414868",
    red: "#f7768e",
    green: "#9ece6a",
    yellow: "#e0af68",
    blue: "#7aa2f7",
    magenta: "#bb9af7",
    cyan: "#7dcfff",
    white: "#a9b1d6",
    brightBlack: "#565f89", // the comment colour, which is what subtle/muted want
    brightRed: "#ff757f",
    brightGreen: "#73daca",
    brightYellow: "#ff9e64", // orange
    brightBlue: "#7aa2f7",
    brightMagenta: "#bb9af7",
    brightCyan: "#2ac3de",
    brightWhite: "#c0caf5",
  },
  { bg: "#1a1b26", fg: "#c0caf5" },
);

// one dark: atom's default, and the most widely recognised editor palette here.
const ONE_DARK = palette(
  {
    black: "#3f4451",
    red: "#e05561",
    green: "#8cc265",
    yellow: "#d18f52",
    blue: "#4aa5f0",
    magenta: "#c162de",
    cyan: "#42b3c2",
    white: "#abb2bf",
    brightBlack: "#5c6370", // one dark's comment grey
    brightRed: "#ff616e",
    brightGreen: "#a5e075",
    brightYellow: "#e5c07b",
    brightBlue: "#61afef",
    brightMagenta: "#c678dd",
    brightCyan: "#56b6c2",
    brightWhite: "#e6e6e6",
  },
  { bg: "#282c34", fg: "#abb2bf" },
);

// colorblind: the one theme here that exists for a functional reason rather than
// an aesthetic one.
//
// Hydra encodes state on the red/green axis in three places — ok vs error, a
// diff's + vs -, and git staged vs dirty — which is the single worst axis to use
// for anyone with deuteranopia or protanopia, the most common colour vision
// deficiencies. No palette swap fixes that, because the problem is not which red
// and green: it is that MEANING is carried by a distinction those eyes do not
// make. What has to move is the roles.
//
// So the palette below is an ordinary dark base drawn from the Okabe-Ito
// qualitative set (jfly.uni-koeln.de/color), whose colours are chosen to stay
// mutually distinguishable under all common forms of CVD, and the role overrides
// then take every state signal off red-versus-green:
//
//   ok        bluish green   error    vermillion
//   warn      orange         active   yellow
//   + lines   sky blue       - lines  vermillion
//   staged    blue           dirty    orange
//
// Blue-versus-orange is the standard accessible substitute for green-versus-red,
// and it is why accessible diff viewers colour additions blue.
//
// `ok` is NOT green, which is the part that surprised me. Okabe-Ito guarantees its
// seven colours are mutually distinguishable, and I first read that as licence to
// use its bluish green for success and its vermillion for failure. Simulating
// deuteranopia says otherwise: that pair separates by 118, and green against the
// reddish purple `errorSoft` uses collapses to 52 — worse than dracula's ordinary
// red/green, which manages 86. Okabe-Ito's guarantee leans on lightness as much as
// hue, and lightness is not what tells a success line from a failure line when
// they are the same weight and one line apart. Every pair that survives the
// simulation well is blue-family against orange-family, so success is sky blue
// here and green appears nowhere that carries meaning. colorblind.test.ts measures
// this rather than asserting it.
//
// What collapse is tolerated, deliberately: `warn` against `error`. Mistaking a
// warning for an error costs a moment; mistaking a failure for a success costs
// more. The pairs that mean OPPOSITE things are the ones held apart.
//
// Note this theme is only expressible because roles sit between the palette and
// the tokens, and because gitStaged stopped borrowing ok — on the old wiring,
// moving "staged" off green would have moved every success signal with it.
const OKABE_ITO = {
  orange: "#e69f00",
  skyBlue: "#56b4e9",
  bluishGreen: "#009e73",
  yellow: "#f0e442",
  blue: "#0072b2",
  vermillion: "#d55e00",
  reddishPurple: "#cc79a7",
} as const;

const COLORBLIND = palette(
  {
    black: "#3a3a3a",
    red: OKABE_ITO.reddishPurple,
    green: OKABE_ITO.bluishGreen,
    yellow: OKABE_ITO.orange,
    blue: OKABE_ITO.blue,
    magenta: OKABE_ITO.reddishPurple,
    cyan: OKABE_ITO.skyBlue,
    white: "#d0d0d0",
    brightBlack: "#8a8a8a",
    brightRed: OKABE_ITO.vermillion,
    brightGreen: OKABE_ITO.bluishGreen,
    brightYellow: OKABE_ITO.yellow,
    brightBlue: OKABE_ITO.skyBlue,
    brightMagenta: OKABE_ITO.reddishPurple,
    brightCyan: OKABE_ITO.skyBlue,
    brightWhite: "#f0f0f0",
  },
  { bg: "#1c1c1c", fg: "#d0d0d0" },
);

/** A role override pinned to an explicit colour. */
function fgRole(value: string): ColorOverride {
  return { fg: hex(value) };
}

// kanagawa: rebelot/kanagawa.nvim, after Hokusai's wave. Muted ink tones on a
// near-black indigo. Its published ANSI mapping is used as-is — unusually for
// this file, every slot already lands where the roles want it.
const KANAGAWA = palette(
  {
    black: "#090618",
    red: "#c34043",
    green: "#76946a",
    yellow: "#c0a36e",
    blue: "#7e9cd8",
    magenta: "#957fb8",
    cyan: "#6a9589",
    white: "#c8c093",
    brightBlack: "#727169", // fujiGray, the comment colour muted/subtle want
    brightRed: "#e82424",
    brightGreen: "#98bb6c",
    brightYellow: "#e6c384",
    brightBlue: "#7fb4ca",
    brightMagenta: "#938aa9",
    brightCyan: "#7aa89f",
    brightWhite: "#dcd7ba",
  },
  { bg: "#1f1f28", fg: "#dcd7ba" },
);

// everforest dark, medium contrast: sainnhe/everforest. Warm greens and a soft
// background — the gentlest palette here, and it still clears the accent guard.
const EVERFOREST = palette(
  {
    black: "#343f44", // bg3
    red: "#e67e80",
    green: "#a7c080",
    // Orange for `warn`, and the yellow below for `active` — the reverse of the
    // substitution catppuccin needs, because everforest's warm tones sit unusually
    // close together. Orange #e69875 against red #e67e80 is 28 apart, so an orange
    // `active` put a RUNNING tool and a FAILED one at 28 in the same block, which
    // is the one confusion in this vocabulary that actually costs something.
    // Yellow moves that pair to 63 and pushes the collision onto warn-versus-error
    // instead: still close, but those are both "pay attention" and mistaking one
    // for the other costs a glance rather than a wrong conclusion.
    yellow: "#e69875",
    blue: "#7fbbb3", // everforest's blue reads as a desaturated aqua
    magenta: "#d699b6", // purple
    cyan: "#83c092", // aqua
    white: "#d3c6aa",
    brightBlack: "#859289", // grey1
    brightRed: "#e67e80",
    brightGreen: "#a7c080",
    brightYellow: "#dbbc7f",
    brightBlue: "#7fbbb3",
    brightMagenta: "#d699b6",
    brightCyan: "#83c092",
    brightWhite: "#d3c6aa",
  },
  { bg: "#2d353b", fg: "#d3c6aa" },
);

// matrix: green on black, with just enough non-green to keep the states apart.
//
// The interesting constraint is that a monochrome theme fights the role tier —
// `ok`, `warn` and `error` all want to be distinguishable, and a green screen
// has one hue to spend. So the non-green accents are kept for exactly the roles
// where confusion costs something (error red, warn yellow-green, info blue) and
// everything ambient stays in the rain: two greens plus the grey-green that
// `muted` and `subtle` read from.
const MATRIX = palette(
  {
    black: "#141c12",
    red: "#ff4b4b",
    green: "#1cc24b", // the dimmer rain green: `ok`, which is ambient
    yellow: "#e6ff57",
    blue: "#30b3ff",
    magenta: "#c770ff",
    cyan: "#24f6d9",
    white: "#2eff6a",
    brightBlack: "#8ca391", // rain grey: the one desaturated tone in the theme
    brightRed: "#ff4b4b",
    brightGreen: "#2eff6a",
    // Orange for `active`. The only warm tone here, which is the point: a busy
    // indicator has to break out of the green to register at all.
    brightYellow: "#ffa83d",
    brightBlue: "#30b3ff",
    brightMagenta: "#c770ff",
    brightCyan: "#00efff",
    brightWhite: "#62ff94",
  },
  { bg: "#0a0e0a", fg: "#62ff94" },
);

export const BUILTIN_THEMES: BuiltinTheme[] = [
  {
    name: "terminal",
    description: "your terminal's own 16 colours (default)",
    palette: DEFAULT_PALETTE,
  },
  {
    name: "dracula",
    description: "dark, high contrast, purple-leaning",
    palette: DRACULA,
  },
  {
    name: "nord",
    description: "dark, cool, low contrast",
    palette: NORD,
  },
  {
    name: "gruvbox-dark",
    description: "dark, warm, retro",
    counterpart: "gruvbox-light",
    palette: GRUVBOX_DARK,
  },
  {
    name: "catppuccin-mocha",
    description: "dark, soft pastel (the default on a dark terminal)",
    counterpart: "catppuccin-latte",
    palette: CATPPUCCIN_MOCHA,
  },
  {
    name: "catppuccin-macchiato",
    description: "dark, soft pastel, one step lighter than mocha",
    counterpart: "catppuccin-latte",
    palette: CATPPUCCIN_MACCHIATO,
  },
  {
    name: "catppuccin-frappe",
    description: "dark, soft pastel, the lightest of the dark flavours",
    counterpart: "catppuccin-latte",
    palette: CATPPUCCIN_FRAPPE,
  },
  {
    name: "catppuccin-latte",
    description: "light, soft pastel (the default on a light terminal)",
    counterpart: "catppuccin-mocha",
    palette: CATPPUCCIN_LATTE,
  },
  {
    name: "tokyo-night",
    description: "dark, deep blue",
    palette: TOKYO_NIGHT,
  },
  {
    name: "one-dark",
    description: "dark, the Atom default",
    palette: ONE_DARK,
  },
  {
    name: "kanagawa",
    description: "dark, muted ink tones",
    palette: KANAGAWA,
  },
  {
    name: "everforest",
    description: "dark, warm green, gentle contrast",
    palette: EVERFOREST,
  },
  {
    name: "matrix",
    description: "dark, green on black",
    palette: MATRIX,
  },
  {
    name: "gruvbox-light",
    description: "light, warm, retro",
    counterpart: "gruvbox-dark",
    palette: GRUVBOX_LIGHT,
  },
  {
    name: "colorblind",
    description: "dark, no meaning carried on the red/green axis",
    palette: COLORBLIND,
    roles: {
      // The state axis, moved to blue-versus-orange. See COLORBLIND above for why
      // success is not green and why these specific pairings.
      ok: fgRole(OKABE_ITO.skyBlue),
      error: fgRole(OKABE_ITO.vermillion),
      // The same hue as `error` rather than a second one: these are two
      // intensities of failure, not two different things, so a dichromat
      // collapsing them loses nothing. Spending a distinguishable colour here
      // would take it from a pair that needs it.
      errorSoft: fgRole(OKABE_ITO.vermillion),
      warn: fgRole(OKABE_ITO.orange),
      // Yellow, not orange: `active` is a running tool and `error` is a failed one,
      // and those appear in the same block a line apart. Orange against vermillion
      // separates by 54 under simulation; yellow manages 135.
      active: fgRole(OKABE_ITO.yellow),
      cold: fgRole(OKABE_ITO.reddishPurple),
      // A diff is the densest red/green in the app, and the one place the two
      // colours sit adjacent line by line.
      diffAdded: fgRole(OKABE_ITO.skyBlue),
      diffRemoved: fgRole(OKABE_ITO.vermillion),
      // The git list is a three-way classification, so it needs three
      // distinguishable colours rather than two plus a grey.
      gitStaged: fgRole(OKABE_ITO.blue),
      gitDirty: fgRole(OKABE_ITO.orange),
      // Syntax keeps hues but drops the red/green pairing: a deletion-coloured
      // regexp next to an addition-coloured number is noise, not signal.
      syntaxRegexp: fgRole(OKABE_ITO.reddishPurple),
      syntaxNumber: fgRole(OKABE_ITO.skyBlue),
    },
  },

  {
    name: "solarized-dark",
    description: "dark, low contrast",
    counterpart: "solarized-light",
    palette: SOLARIZED_DARK,
  },
  {
    name: "solarized-light",
    description: "light",
    counterpart: "solarized-dark",
    palette: SOLARIZED_LIGHT,
  },
  {
    name: "mono",
    description: "no colour; weight and glyphs only",
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

// The theme to use when the user has not chosen one.
//
// `terminal` was the unconditional default, and it has one property no curated
// palette has: it cannot be wrong. It uses the sixteen colours the terminal is
// already configured with, which by construction work against that terminal's
// background. Every curated palette instead ASSUMES a background, and assuming
// wrong is what produces pale bands on black or grey-on-grey text.
//
// Once the background is measured rather than assumed, that objection mostly
// goes: pick the theme that matches what the terminal actually is. So a known
// background selects a curated theme, and an unknown one still falls back to
// deferring to the user's own palette, which remains the only safe answer when
// nothing is known.
//
// What this still cannot see is whether the user's palette was CHOSEN. Someone
// with a carefully configured terminal profile looks identical from here to
// someone who never touched it, and this overrides both. That is why the choice
// is announced at startup and why pinning `tui.theme` silences it: the way out
// has to be visible, or the colours just mysteriously differ between machines.
export const AUTO_DARK = "catppuccin-mocha";
export const AUTO_LIGHT = "catppuccin-latte";

export function defaultThemeFor(background: Color | undefined): string {
  if (background === undefined) {
    return "terminal";
  }
  return isDark(background) ? AUTO_DARK : AUTO_LIGHT;
}

/**
 * The theme one step from `active` in `names`, wrapping at both ends.
 *
 * `step` is +1 for the next and -1 for the previous. Extracted from the modal's
 * key handler because the interesting cases are not the common one: wrapping
 * backwards off the first entry, and `active` not appearing in the list at all —
 * which happens whenever `tui.theme` is an inline object, since that resolves to
 * the name "custom" and the picker only lists named themes. Stepping from there
 * lands on the first entry going forward and the last going back.
 */
export function stepTheme(
  names: readonly string[],
  active: string,
  step: 1 | -1,
): string | undefined {
  if (names.length === 0) {
    return undefined;
  }
  const at = names.indexOf(active);
  if (at === -1) {
    // Handled explicitly rather than by letting -1 fall into the modulo below,
    // which lands on the SECOND entry going backwards — a result that is neither
    // intended nor obviously wrong on inspection.
    return step === 1 ? names[0] : names[names.length - 1];
  }
  return names[(at + step + names.length) % names.length];
}
