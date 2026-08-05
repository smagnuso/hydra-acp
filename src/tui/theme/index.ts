// Style token -> SGR bytes.
//
// This is the single place that knows what colour a semantic style is. It
// replaces the pair of parallel switch statements that used to live in
// screen.ts (a base arm and a hover arm), which had to be kept in agreement
// by hand.
//
// Colours are hardcoded here for now, exactly reproducing what terminal-kit's
// style chains emitted before. A future change replaces the literals with a
// palette/role lookup; nothing outside this directory needs to move for that.
//
// Why bytes and not terminal-kit chains: a token that resolves to an explicit
// { open, close } pair can be composed. Hover is "band + the token's own
// open"; an inline markdown span can re-emit its row's base colour by asking
// for the same token again. Chains can't be inspected or composed, which is
// why the old code had to transcribe each style's colour into several places.

import type { Style } from "../format.js";

const ESC = "\x1b";
const CSI = `${ESC}[`;

/** An SGR sequence pair: what to emit before text, and after it. */
export interface SgrPair {
  open: string;
  close: string;
}

/**
 * How a style is rendered.
 *
 * `markup` selects the writer: styles that carry caret markup from
 * format.ts (`^Ccode^:`, `^+bold^:`) must go through terminal-kit's
 * markup-interpreting call so the carets become SGR; every other style
 * uses `.noFormat` so a caret the user typed stays a literal caret.
 */
export interface StyleRender extends SgrPair {
  markup: boolean;
  /**
   * Rewrite the text before writing it. Only the hovered `thought` style uses
   * this, to neutralise a baked foreground-reset that would fight its band.
   */
  transform?: (text: string) => string;
}

// ---------------------------------------------------------------------------
// Colour depth
// ---------------------------------------------------------------------------

/**
 * Whether the terminal takes 24-bit colour, as decided by terminal-kit's own
 * termconfig.
 *
 * We read terminal-kit's answer rather than sniffing COLORTERM ourselves so
 * grayscale bands land on the same bytes they did when terminal-kit's
 * `bgColorGrayscale` handler produced them. Its handler branches on exactly
 * these two flags (lib/Terminal.js, `colorGrayscale`).
 */
export function supports24Bit(term: unknown): boolean {
  const esc = (term as { esc?: { color24bits?: { na?: boolean; fb?: boolean } } })
    .esc;
  const c24 = esc?.color24bits;
  if (!c24) {
    return false;
  }
  return !c24.na && !c24.fb;
}

/**
 * Background grayscale, mirroring terminal-kit's `bgColorGrayscale(g)`.
 *
 * `g` is 0-255. On a 24-bit terminal that maps straight through; otherwise it
 * quantises onto the 256-colour cube's grayscale ramp. The quantisation is
 * terminal-kit's, reproduced rather than improved on: rounding to 0-25 then
 * offsetting by 231 puts 43 on index 235 and 28 on index 234, and those are
 * the shades the user-message and code bands have always been.
 */
export function bgGrayscale(g: number, trueColor: boolean): SgrPair {
  const close = `${CSI}49m`;
  if (trueColor) {
    return { open: `${CSI}48;2;${g};${g};${g}m`, close };
  }
  const step = Math.round((g * 25) / 255);
  const idx = step === 0 ? 16 : step === 25 ? 231 : step + 231;
  return { open: `${CSI}48;5;${idx}m`, close };
}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

// A style is a stack of layers. Opens are emitted in order and closes in
// reverse, which is what terminal-kit's chain did: `bold.red` opened 1 then
// 31 and closed 39 then 22. Keeping the order means the emitted bytes are
// unchanged, not merely equivalent.

type Layer = SgrPair;

const bold: Layer = { open: `${CSI}1m`, close: `${CSI}22m` };
const dim: Layer = { open: `${CSI}2m`, close: `${CSI}22m` };
const inverse: Layer = { open: `${CSI}7m`, close: `${CSI}27m` };

const fg = (code: number): Layer => ({
  open: `${CSI}${code}m`,
  close: `${CSI}39m`,
});
const bg = (code: number): Layer => ({
  open: `${CSI}${code}m`,
  close: `${CSI}49m`,
});

// Named so the table below reads as colour, not as numbers.
const black = fg(30);
const red = fg(31);
const green = fg(32);
const cyan = fg(36);
const white = fg(37);
const brightBlack = fg(90);
const brightBlue = fg(94);
const brightYellow = fg(93);
const brightCyan = fg(96);
const brightWhite = fg(97);

const bgRed = bg(41);
const bgBrightYellow = bg(103);

function flatten(layers: Layer[]): SgrPair {
  return {
    open: layers.map((l) => l.open).join(""),
    close: layers
      .slice()
      .reverse()
      .map((l) => l.close)
      .join(""),
  };
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

/**
 * A style's layers. `grayBg` is separate from `layers` because its bytes
 * depend on colour depth and so can't be a constant.
 */
interface StyleSpec {
  layers?: Layer[];
  grayBg?: number;
  markup?: boolean;
}

const STYLES: Record<string, StyleSpec> = {
  // Quiet full-width band marking the start of a user turn. Bold on a
  // grayscale lift rather than a colour, so it reads as a boundary rather
  // than a highlight stripe.
  user: { grayBg: 43, layers: [bold] },

  // Agent prose takes the terminal's default foreground: it's the bulk of
  // the transcript, and anything else fights the user's theme.
  agent: { markup: true },

  thought: { layers: [brightBlack], markup: true },

  tool: { layers: [brightBlue] },

  // Completed, queued and cancelled all read as "not the thing to look at",
  // so they share dim; running is the only tool state that gets colour.
  "tool-status-ok": { layers: [dim] },
  "tool-status-pending": { layers: [dim] },
  "tool-status-cancelled": { layers: [dim] },
  "tool-status-running": { layers: [brightYellow] },
  "tool-status-fail": { layers: [bold, red] },

  plan: { layers: [brightYellow], markup: true },
  "plan-done": { layers: [green], markup: true },
  "plan-pending": { layers: [dim], markup: true },

  system: { layers: [brightYellow] },
  info: { layers: [cyan] },
  dim: { layers: [dim] },

  // Editor-like block: dark band with an explicit white foreground, so a
  // `diff` fence can let context lines sit neutral while cli-highlight's
  // red/green +/- overlay on top. A different shade from the user band so
  // the two are never confused.
  code: { grayBg: 28, layers: [white] },

  "heading-1": { layers: [bold, brightYellow], markup: true },
  "heading-2": { layers: [bold, brightCyan], markup: true },
  "heading-3": { layers: [bold], markup: true },

  // Loud enough to find inside any base style without being unreadable on a
  // light terminal.
  "search-highlight": { layers: [bgBrightYellow, black] },
  // The one match the search cursor is on, distinct from its siblings.
  "search-highlight-active": { layers: [bgRed, brightWhite] },
  // Inverse video stays legible over every base style and can't collide with
  // the two search treatments when both land on one row.
  "selection-highlight": { layers: [inverse] },
};

const EMPTY: StyleRender = { open: "", close: "", markup: false };

/** Resolve a style to the bytes that wrap its text. */
export function resolveStyle(
  style: Style | undefined,
  trueColor: boolean,
): StyleRender {
  if (style === undefined) {
    return EMPTY;
  }
  const spec = STYLES[style];
  if (spec === undefined) {
    return EMPTY;
  }
  const layers: Layer[] = [];
  if (spec.grayBg !== undefined) {
    layers.push(bgGrayscale(spec.grayBg, trueColor));
  }
  if (spec.layers) {
    layers.push(...spec.layers);
  }
  return { ...flatten(layers), markup: spec.markup === true };
}

/**
 * Whether a style's text carries caret markup.
 *
 * Two callers need this and they must agree. writeStyled uses it to pick the
 * writer; wrap/truncate use it to subtract caret markers when measuring
 * visible width, because `^Cfoo^:` occupies 7 JS characters and 3 columns —
 * get it wrong and a span near the right edge wraps early. Both now read the
 * same field, so a style can't be markup-bearing for one and not the other.
 */
export function styleUsesMarkup(style: Style | undefined): boolean {
  if (style === undefined) {
    return false;
  }
  return STYLES[style]?.markup === true;
}

/**
 * Styles that gain a background band when the row is hovered.
 *
 * This list is deliberately partial, matching what the old hover switch
 * happened to cover. Notably `plan` and `plan-done` are absent while
 * `plan-pending` is present, and `user`, `system`, `info` and the headings
 * are absent too — so hovering a row of plan entries today highlights only
 * the pending ones. That looks like an oversight rather than a decision, but
 * widening it is a visible change, so it is preserved here and left for a
 * follow-up.
 */
const HOVER_BANDED = new Set<Style>([
  "dim",
  "tool",
  "tool-status-ok",
  "tool-status-pending",
  "tool-status-cancelled",
  "tool-status-running",
  "tool-status-fail",
  "plan-pending",
]);

/**
 * The shared hover band: 256-colour index 236, a step off most default
 * backgrounds — enough to see the row change, not enough to read as a
 * selection. Emitted as an explicit index rather than via grayscale so it
 * doesn't drift with colour depth; hover needs to be the same weight
 * everywhere.
 */
const HOVER_BAND: SgrPair = { open: `${CSI}48;5;236m`, close: `${CSI}49m` };

/**
 * Resolve a style as it renders on a hovered row.
 *
 * Returns undefined when the style has no hover treatment, in which case the
 * caller renders it exactly as an unhovered row.
 */
export function resolveHovered(
  style: Style | undefined,
  trueColor: boolean,
): StyleRender | undefined {
  if (style === undefined) {
    return undefined;
  }

  if (style === "thought") {
    // Lift the dim brightBlack baseline to the default foreground so the
    // thought stays readable on the band, and swap each baked "^K"
    // (set fg -> brightBlack) for SGR 39 (default fg, leaves bg alone) so
    // prose after an inline code span returns to default fg without "^:"
    // dropping the band.
    //
    // The alternation consumes "^^" first: that pair must survive verbatim
    // for terminal-kit to emit one literal caret, and matching it first
    // stops the "K" in "^^K" being read as a codeReset.
    //
    // No close sequence — this leaks the band to end of row and depends on
    // the painter's styleReset to stop it smearing. Faithful to the previous
    // behaviour; a band that closed here would be the correct fix but is a
    // visible change.
    return {
      open: bgGrayscale(25, trueColor).open,
      close: "",
      markup: true,
      transform: (text) =>
        text.replace(/\^\^|\^K/g, (m) => (m === "^K" ? `${CSI}39m` : m)),
    };
  }

  if (style === "code") {
    // Grayscale hover snapped against the 256-colour ramp: any lift subtle
    // enough rounded back to the baseline, any lift the ramp could resolve
    // read as a full highlight. So this is a 24-bit value the ramp can't
    // approximate away — the same luminance as the baseline band but cooler,
    // so hover reads as a hue shift rather than a brightness one. Emitted
    // unconditionally, including on terminals that only do 256 colours.
    return {
      open: `${CSI}48;2;22;25;36m`,
      close: `${CSI}49m`,
      markup: false,
    };
  }

  if (!HOVER_BANDED.has(style)) {
    return undefined;
  }
  const base = resolveStyle(style, trueColor);
  return {
    open: HOVER_BAND.open + base.open,
    close: base.close + HOVER_BAND.close,
    markup: base.markup,
  };
}
