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
import {
  ansi,
  band,
  bgOpen,
  bgReset,
  fgOpen,
  fgReset,
  type Color,
  type ColorDepth,
} from "./color.js";
import { depthForTerminal } from "./capability.js";

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
 */
export interface StyleRender extends SgrPair {
  /**
   * Whether this style's body carries inline SGR spans emitted by format.ts
   * (`code`, **bold**, links). Drives two things: the trailing reset below,
   * and whether width measurement has to treat escape sequences as
   * zero-width.
   */
  inlineSgr: boolean;
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
 * Background grayscale, mirroring terminal-kit's `bgColorGrayscale(g)`.
 *
 * `g` is 0-255. On a 24-bit terminal that maps straight through; otherwise it
 * quantises onto the 256-colour cube's grayscale ramp. The quantisation is
 * terminal-kit's, reproduced rather than improved on: rounding to 0-25 then
 * offsetting by 231 puts 43 on index 235 and 28 on index 234, and those are
 * the shades the user-message and code bands have always been.
 */
export function bgGrayscale(g: number, depth: ColorDepth): SgrPair {
  const close = `${CSI}49m`;
  if (depth === "truecolor") {
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

// `open` is a function of colour depth because a palette colour may be an
// explicit RGB value, which emits 24-bit on terminals that take it and
// quantises otherwise. Attributes and the 16 ansi slots ignore the argument.
interface Layer {
  open: (depth: ColorDepth) => string;
  close: string;
  /**
   * What this layer sets. An override needs to know: giving a role a new colour
   * has to replace its foreground layer and leave its attributes alone, since
   * attributes carry structure (a heading is bold) rather than colour.
   */
  kind: "fg" | "bg" | "attr";
}

// ---------------------------------------------------------------------------
// Tier 0: palette
// ---------------------------------------------------------------------------

// The colours available, and nothing about what they mean.
//
// Sixteen slots, defaulting to the terminal's own ansi palette rather than to
// hex, so an unthemed hydra inherits whatever the user has already configured —
// including on a light terminal. A theme substitutes explicit colours here and
// nothing below this line changes.
//
// fg-vs-bg is a usage decision, not a palette entry: `bgBlue` used to be its
// own slot alongside `blue`, which meant the same colour was written twice.

/** A full set of palette slots. A theme supplies some or all of these. */
export type Palette = Record<PaletteSlot, Color> & PaletteExtras;

/**
 * Optional slots a theme may declare beyond the 16 colours.
 *
 * `bg` is a DECLARATION, not an instruction: hydra does not paint a
 * full-screen background (that would fight terminal transparency and per-pane
 * tmux colour). It is the reference point the background bands are derived
 * from, so declaring it is what makes a light theme's bands step the right way.
 *
 * `fg` makes otherwise-unstyled text explicit. Left unset, unstyled text keeps
 * inheriting the terminal's foreground, which is why an unthemed hydra adapts
 * to a light terminal for free.
 */
export interface PaletteExtras {
  bg?: Color;
  fg?: Color;
}

export type PaletteSlot =
  | "black" | "red" | "green" | "yellow" | "blue" | "magenta" | "cyan" | "white"
  | "brightBlack" | "brightRed" | "brightGreen" | "brightYellow"
  | "brightBlue" | "brightMagenta" | "brightCyan" | "brightWhite";

export const DEFAULT_PALETTE: Palette = {
  black: ansi(0),
  red: ansi(1),
  green: ansi(2),
  yellow: ansi(3),
  blue: ansi(4),
  magenta: ansi(5),
  cyan: ansi(6),
  white: ansi(7),
  brightBlack: ansi(8),
  brightRed: ansi(9),
  brightGreen: ansi(10),
  brightYellow: ansi(11),
  brightBlue: ansi(12),
  brightMagenta: ansi(13),
  brightCyan: ansi(14),
  brightWhite: ansi(15),
};

// The palette the token table is currently built against. Swapped by setTheme,
// which rebuilds everything downstream — see ActiveTheme.
let palette: Palette = DEFAULT_PALETTE;

// Grayscale levels (0-255) for the background bands. Not palette colours:
// these feed terminal-kit's grayscale quantisation, which resolveStyle applies
// against the terminal's depth. Once a theme can set `bg`, these become
// derived — band(bg, step) — and the direction of the lift follows bg's
// luminance so a light theme works from one key.
/**
 * Background bands: the user-turn stripe, the code block, and the hover tints.
 *
 * Derived from `bg` when a theme declares one, so the lift follows its
 * luminance — lighter on a dark background, darker on a light one. Without that
 * flip a light theme's bands head toward white and vanish.
 *
 * The steps are chosen so a theme declaring pure black reproduces the legacy
 * absolute levels exactly (lighten(#000, 0.17) === 43). With no `bg` at all
 * those levels are used directly, which is both the previous behaviour and the
 * right answer: with the terminal's own background unknown, an absolute dark
 * band is the best guess available.
 */
const BAND_STEPS = {
  user: 0.17,
  code: 0.11,
  hoverThought: 0.1,
  hoverRow: 0.19,
  // A step further off the background than `code`, so hovering a fenced block
  // brightens it. This used to be a hardcoded 24-bit #161924 — chosen to be a
  // hue shift rather than a brightness one, because the 256-colour ramp rounded
  // any subtle lift back onto the baseline. That made it the one band the theme
  // could not reach: fixed on every palette, near-black under a light one, and
  // carrying a cast of its own, which is the thing bands must not do.
  hoverCode: 0.2,
} as const;

const LEGACY_BANDS = {
  user: 43,
  code: 28,
  hoverThought: 25,
  // Two ramp steps above `code` (28 rounds to index 234, this to 236), so the
  // lift survives quantisation with no background to derive from.
  hoverCode: 48,
} as const;

/** A band is either a derived colour or a legacy absolute grayscale level. */
type Band = Color | number;

/**
 * What the bands are derived from.
 *
 * A theme's `bg` is its statement about the background it was DESIGNED for, not
 * a description of the terminal in front of you. Deriving bands from it means a
 * light theme paints pale bands, which is right on a cream terminal and reads as
 * a white block on a black one — and nothing in here knows which you have.
 *
 * So an explicit reference wins: `tui.themeBackground`, or the COLORFGBG hint.
 * Both describe reality. The theme's claim is the fallback, and the legacy
 * absolute levels are the fallback to that, for when nothing is known.
 */
let bandReference: Color | undefined;
// The terminal's own foreground, from OSC 10, when it answered.
//
// Used for one thing: a band is derived from the background and so moves toward
// the text sitting on it, and for a theme that declares no `fg` that text is the
// TERMINAL's foreground — a value we were previously deriving bands in complete
// ignorance of. Knowing it lets band() back the lift off before the text becomes
// hard to read. A theme that declares its own `fg` states what sits on its bands,
// so this does not apply there.
let terminalForeground: Color | undefined;

/**
 * What text will sit on a band, when knowing that is both possible and useful.
 *
 * Only for a theme that declares no `fg`. A theme that declares one has stated
 * what sits on its bands and has been designed as a whole — and its code band
 * carries `codeText` rather than `fg` anyway, so `fg` would be the wrong answer
 * there. Applying the clamp to themed palettes also broke the invariant that a
 * theme declaring pure black reproduces the legacy absolute band levels exactly.
 *
 * So this is narrowly the case the clamp was justified for: we are deferring to
 * the terminal's foreground, and now we can measure it instead of hoping.
 */
function bandTextColor(): Color | undefined {
  return palette.fg === undefined ? terminalForeground : undefined;
}

function bandBase(): Color | undefined {
  return bandReference ?? palette.bg;
}

function buildBands(): Record<
  "user" | "code" | "hoverThought" | "hoverCode",
  Band
> {
  const bg = bandBase();
  if (bg === undefined) {
    return LEGACY_BANDS;
  }
  const over = bandTextColor();
  return {
    user: band(bg, BAND_STEPS.user, over),
    code: band(bg, BAND_STEPS.code, over),
    hoverThought: band(bg, BAND_STEPS.hoverThought, over),
    hoverCode: band(bg, BAND_STEPS.hoverCode, over),
  };
}

// The hover tint with no `bg` declared: 256-colour index 236, a step off most
// default backgrounds. Deliberately NOT part of `bands`, because a number there
// means a grayscale LEVEL (0-255) fed through bgGrayscale, and 236 is an index
// into the cube. Conflating the two quantises it to a different shade.
const HOVER_ROW_LITERAL: SgrPair = {
  open: `${CSI}48;5;236m`,
  close: bgReset,
};

let bands = buildBands();

/** A palette colour used as a foreground. */
const fgL = (c: Color): Layer => ({
  open: (depth) => fgOpen(c, depth),
  close: fgReset,
  kind: "fg",
});
/** A palette colour used as a background. */
const bgL = (c: Color): Layer => ({
  open: (depth) => bgOpen(c, depth),
  close: bgReset,
  kind: "bg",
});
/**
 * A background band. Same as bgL but quantises onto grey rather than by hue —
 * see bgParams's `neutral`, and bandLayer for why a band is not a colour.
 */
const bandBgL = (c: Color): Layer => ({
  open: (depth) => bgOpen(c, depth, true),
  close: bgReset,
  kind: "bg",
});

// Attributes are not colours and are not themeable: bold/dim/inverse carry
// structure (a heading is bold, secondary text recedes) and letting a theme
// unbold the rules would produce garbage for no gain. They compose with roles
// at the token level.
const attr = (on: number, off: number): Layer => ({
  open: () => `${CSI}${on}m`,
  close: `${CSI}${off}m`,
  kind: "attr",
});
const bold = attr(1, 22);
const dim = attr(2, 22);
const inverse = attr(7, 27);
// Only reached by highlight.js's `emphasis` and `link` scopes. Note format.ts
// deliberately renders markdown italic as underline instead, because SGR 3 is
// unreliable — tmux drops it and some terminals show it as inverse video. That
// argument applies here too; these keep italic/underline only because it is
// what cli-highlight already emitted.
const italic = attr(3, 23);
const underline = attr(4, 24);

// ---------------------------------------------------------------------------
// Tier 1: roles
// ---------------------------------------------------------------------------

// What a colour MEANS, independent of which token is using it. This is the
// layer a theme is expected to set: "make errors orange" is one edit here
// rather than seven in the token table below.
//
// Roles are arrays so a token can compose them (`[...roles.emphasis,
// ...roles.active]` for a bold yellow heading) rather than needing a role per
// combination.
//
// Two sets of near-duplicates are preserved deliberately, because collapsing
// them would change rendering and that is a separate decision:
//
//   error / errorSoft  — bright red vs plain red. Seven tokens mean "something
//     is wrong" and inherited three different renderings from their original
//     call sites. Whether that is a real hierarchy (a failed command is milder
//     than a broken tool call) or an accident is an open question.
//   reference / focus  — both bright blue. One names a thing (a tool, a file
//     path), the other marks which box has keyboard focus. Unrelated meanings
//     that happen to share a colour.
function buildRoles() {
  return {
  // Text. `fg` is the terminal's own foreground, i.e. deliberately unstyled —
  // used where the normal case should not draw the eye (a Ready status), where
  // removing emphasis IS the signal (a hovered hint chunk), and by the
  // highlight.js scopes that carry no colour of their own.
  fg: palette.fg === undefined ? ([] as Layer[]) : [fgL(palette.fg)],
  fgStrong: [fgL(palette.brightWhite)],
  // Scaffolding: labels, rules, hints. Two dozen tokens use this.
  //
  // A theme that names its own colours gets its grey here rather than `dim` over
  // the body colour. Dim alone is a weak signal — some terminals ignore SGR 2
  // and most render it inconsistently — so a sidebar label and its value ended
  // up differing by an attribute the terminal might drop, which read as flat.
  // Every real theme already carries a purpose-made secondary colour in
  // brightBlack (dracula's #6272a4, nord3, gruvbox's #928374, solarized base1),
  // so labels now differ from values by hue and not just by weight.
  //
  // `dim` stays on top so the three tiers remain distinct: a value in the body
  // colour, a thought in the grey, scaffolding in the dimmed grey. And `dim`
  // alone is still the answer for the terminal palette, where there is no grey
  // to name — which keeps that theme byte-identical.
  muted:
    palette.fg === undefined ? [dim] : [dim, fgL(palette.brightBlack)],
  // The gray a thought sits in: quieter than a value, louder than scaffolding.
  subtle: [fgL(palette.brightBlack)],
  emphasis: [bold],

  // State.
  active: [fgL(palette.brightYellow)],
  warn: [fgL(palette.yellow)],
  ok: [fgL(palette.green)],
  error: [fgL(palette.brightRed)],
  errorSoft: [fgL(palette.red)],
  cold: [fgL(palette.brightMagenta)],

  // Git working-tree status. Its own family rather than borrowing ok / reference /
  // muted, for the reason syntax has its own: those three are a CLASSIFICATION of
  // files, not a status ladder, and the fact that "staged" happened to land on the
  // same green as "succeeded" was a coincidence of both wanting green. Sharing the
  // role made the coincidence load-bearing — recolouring success moved the git
  // list, and recolouring the git list moved plan-done, notice-ok and meter-fill.
  //
  // The default colours are unchanged, so this costs nothing to adopt: it only
  // separates what a theme can now say independently.
  gitStaged: [fgL(palette.green)],
  gitDirty: [fgL(palette.brightBlue)],
  // Keeps `muted`'s shape, dim attribute included: untracked files recede.
  gitUntracked:
    palette.fg === undefined ? [dim] : [dim, fgL(palette.brightBlack)],

  // Reference and navigation.
  accent: [fgL(palette.brightCyan)],
  info: [fgL(palette.cyan)],
  reference: [fgL(palette.brightBlue)],
  focus: [fgL(palette.brightBlue)],

  // Bands and highlights. Composites, because a band is a background and the
  // foreground that stays legible on it.
  selectionBand: [bgL(palette.blue)],
  selection: [bgL(palette.blue), fgL(palette.brightWhite)],
  cursor: [bgL(palette.white)],
  promptCursor: [bgL(palette.brightYellow)],
  match: [bgL(palette.brightYellow), fgL(palette.black)],
  matchActive: [bgL(palette.red), fgL(palette.brightWhite)],
  invert: [inverse],
  // The base text colour inside a code band. Explicit rather than the
  // terminal default, because a syntax span closes back to it.
  codeText: [fgL(palette.white)],

  // Syntax highlighting has its own role family rather than borrowing the
  // general ones, even where the colours currently coincide. `string` is
  // yellow and so is `warn`; `regexp` is red and so is `errorSoft`; `comment`
  // is the same gray as `subtle`. Sharing them would mean retinting a warning
  // also retinted every string literal — the borrowed-token problem the
  // sidebar had, which is worth not reintroducing.
  //
  // Twelve slots for twenty-two highlight.js scopes. That is the normal shape
  // for this domain; editor themes carry a comparable set.
  syntaxKeyword: [fgL(palette.brightBlue)],
  syntaxType: [fgL(palette.brightCyan)],
  syntaxBuiltin: [fgL(palette.cyan)],
  syntaxLiteral: [fgL(palette.blue)],
  syntaxNumber: [fgL(palette.brightGreen)],
  syntaxString: [fgL(palette.yellow)],
  syntaxRegexp: [fgL(palette.red)],
  syntaxComment: [fgL(palette.brightBlack)],
  syntaxClass: [fgL(palette.brightYellow)],
  syntaxMeta: [fgL(palette.magenta)],
  // Same colour as codeText, so these render as plain code today. Kept as
  // roles so a theme can give them one.
  syntaxVariable: [fgL(palette.white)],
  // A diff's +/- lines. Deliberately not roles.ok / roles.error: deletion
  // happens to match `error` exactly but addition is a brighter green than
  // `ok`, and a half-match is worse than none. A diff marker is its own
  // signal anyway.
  diffAdded: [fgL(palette.brightGreen)],
  diffRemoved: [fgL(palette.brightRed)],
  // A documentation tag inside a comment (`@param`, `@returns`).
  syntaxDoctag: [fgL(palette.green)],
  // Markup emphasis inside a fence, e.g. a ```markdown block.
  syntaxEmphasis: [italic],
  syntaxStrong: [bold],
  syntaxLink: [underline],
  };
}

/**
 * A colour override for a role or an element.
 *
 * Replaces colour, never attributes: a bold heading given a new colour stays
 * bold, because bold is structure. That is the same reason attributes are not
 * in the palette.
 *
 * A bare colour string means `fg`, except on a target that has no foreground of
 * its own (the cursor and band roles), where it means `bg` — that is the only
 * thing it could sensibly mean there. Targets with both, like `selection`, take
 * the object form to reach the background.
 */
export interface ColorOverride {
  fg?: Color;
  bg?: Color;
}

/**
 * Apply an override to a layer stack.
 *
 * Rewrites the layers of the matching kind in place, so ordering — which
 * decides the emitted byte order — is preserved. A colour the stack does not
 * already have is appended.
 */
function withOverride(layers: Layer[], o: ColorOverride): Layer[] {
  let sawFg = false;
  let sawBg = false;
  const out = layers.map((l) => {
    if (l.kind === "fg" && o.fg !== undefined) {
      sawFg = true;
      return fgL(o.fg);
    }
    if (l.kind === "bg" && o.bg !== undefined) {
      sawBg = true;
      return bgL(o.bg);
    }
    if (l.kind === "fg") sawFg = true;
    if (l.kind === "bg") sawBg = true;
    return l;
  });
  if (o.fg !== undefined && !sawFg) {
    out.push(fgL(o.fg));
  }
  if (o.bg !== undefined && !sawBg) {
    out.unshift(bgL(o.bg));
  }
  return out;
}

/** True when a stack has a foreground layer, i.e. a bare string means `fg`. */
export function stackTakesFg(layers: Layer[]): boolean {
  return layers.some((l) => l.kind === "fg") || !layers.some((l) => l.kind === "bg");
}

/** Every role name, inferred from the builder so the two cannot drift. */
type Roles = ReturnType<typeof buildRoles>;
export type RoleName = keyof Roles;

let roleOverrides: Partial<Record<string, ColorOverride>> = {};
let elementOverrides: Partial<Record<string, ColorOverride>> = {};

function applyRoleOverrides(base: Roles): Roles {
  if (Object.keys(roleOverrides).length === 0) {
    return base;
  }
  const out = { ...base } as Record<string, Layer[]>;
  for (const [name, o] of Object.entries(roleOverrides)) {
    if (o === undefined || out[name] === undefined) {
      continue;
    }
    out[name] = withOverride(out[name]!, o);
  }
  return out as Roles;
}

let roles: Roles = applyRoleOverrides(buildRoles());

/** The opening bytes of a role, for callers that splice colour into a string. */
/**
 * Colour depth for sequences baked into text at parse time: the inline-span
 * openers and the syntax theme.
 *
 * Those are emitted where no terminal is in scope, so the depth has to come
 * from somewhere else. It is a property of the one terminal this process draws
 * to, so it lives here and is set once at startup.
 *
 * 256-colour is the safe default — it renders somewhere on every terminal,
 * whereas 24-bit at a terminal that cannot read it renders as garbage.
 *
 * Getting this wrong is visible: a row's base colour is resolved at PAINT time
 * with the real depth, while a span's closer re-asserts that base from here. If
 * the two disagree, text after an inline span shifts colour — an exact
 * `#657b83` before it and a quantised `rgb(95,135,135)` after, which reads as a
 * blue tinge for the rest of the line.
 */
let inlineDepth: ColorDepth = "ansi256";

/**
 * Tell the theme what the terminal can actually do, so parse-time sequences
 * match paint-time ones. Call once, before anything is parsed.
 */
export function setInlineDepth(depth: ColorDepth): void {
  if (depth === inlineDepth) {
    return;
  }
  inlineDepth = depth;
  // Everything baked from a role has to be rebuilt, and the highlight cache
  // holds already-coloured output, so bump the revision to miss it.
  spans = buildSpans();
  syntaxCache = undefined;
  active = {
    prose: buildProseInlineOpts(),
    thought: buildThoughtInlineOpts(),
    revision: active.revision + 1,
  };
}

/** The opening bytes of a role, for callers that splice colour into a string. */
function openOf(role: Layer[]): string {
  return role.map((l) => l.open(inlineDepth)).join("");
}

// ---------------------------------------------------------------------------
// Inline spans
// ---------------------------------------------------------------------------

// Inline markdown spans (`code`, **bold**, *italic*, links) used to be
// expressed as terminal-kit caret markup — format.ts emitted "^C" and
// terminal-kit turned it into ESC[96m at paint time. These are the same
// sequences, emitted directly.
//
// Values are terminal-kit's, verified against the library rather than assumed,
// so the migration off carets did not change a single byte. Two are easy to
// get wrong: "^-" was dim ON (SGR 2), not bold off (SGR 22); and "^:" was a
// full reset (SGR 0), not a targeted close.
export const SGR_RESET = `${CSI}0m`;
export const SGR_BOLD = `${CSI}1m`;
export const SGR_UNDERLINE = `${CSI}4m`;

// Inline spans take their colour from roles like everything else: `accent` for
// a code span or a link, `info` for the quieter code span inside a thought,
// and `subtle` for the gray a thought's prose returns to.
function buildSpans() {
  const code = openOf(roles.accent);
  return {
    code,
    codeQuiet: openOf(roles.info),
    link: code + SGR_UNDERLINE,
    thoughtBase: openOf(roles.subtle),
  };
}
let spans = buildSpans();

/**
 * How a row styles the inline spans inside it.
 *
 * Only the openers vary per row. Closers are computed rather than configured:
 * a span ends with a full reset followed by whatever state enclosed it, which
 * is the row's `base` plus any spans still open around it. That composition is
 * why closers cannot be fixed strings — the correct one for a code span
 * depends on whether it sits inside a bold span, which the row cannot know.
 */
export interface InlineOpts {
  codeOpen: string;
  linkOpen: string;
  /** SGR that re-establishes the row's own style, absent any span. */
  base: string;
}

/**
 * Inline spans for agent prose, whose base is the terminal's default
 * foreground — so a plain reset is the right closer and nothing needs
 * restoring.
 */
function buildProseInlineOpts(): InlineOpts {
  return {
    codeOpen: spans.code,
    // Links are cyan + underlined.
    linkOpen: spans.link,
    // The agent token's own colour, which a span has to close back to. Empty on
    // the default palette, so prose keeps inheriting the terminal — but a theme
    // that declares `fg` must not have its prose fall back to the terminal's
    // foreground after every **bold** or `code` span.
    //
    // This was hardcoded to "" while `agent` had no colour of its own. Giving it
    // one without fixing this left prose reverting to the terminal default after
    // the first span and recovering on the next wrapped row, because that row
    // re-emits the token's open: green to end of line, correct on the next.
    base: openOf(roles.fg),
  };
}

/**
 * Inline spans inside a thought. Code goes plain cyan rather than bright so
 * spans stay in the thought's gray register instead of punching out of it.
 */
function buildThoughtInlineOpts(): InlineOpts {
  return {
    codeOpen: spans.codeQuiet,
    linkOpen: spans.link,
    base: spans.thoughtBase,
  };
}

/** Inline-span options for agent prose. Re-read after a theme swap. */
export function proseInlineOpts(): InlineOpts {
  return active.prose;
}

/** Inline-span options for a thought. Re-read after a theme swap. */
export function thoughtInlineOpts(): InlineOpts {
  return active.thought;
}

/**
 * Inline spans for a row whose base style carries its own colour: plan
 * entries and headings.
 *
 * The base comes straight from the style table, so a span's closer restores
 * whatever that style opened with and nothing has to be restated here.
 *
 * One deviation: heading-2 opens inline code in bright yellow instead of
 * bright cyan, because the heading itself is bright cyan and a bright-cyan
 * span inside it would be invisible.
 */
export function inlineOptsFor(style: Style): InlineOpts {
  return {
    // heading-2 is itself `accent`, so a code span inside it would vanish;
    // `active` is the one other colour already in the heading vocabulary.
    codeOpen: style === "heading-2" ? openOf(roles.active) : spans.code,
    linkOpen: spans.link,
    base: resolveStyle(style, inlineDepth).open,
  };
}

// ---------------------------------------------------------------------------
// Tier 2: tokens (the table below)
// ---------------------------------------------------------------------------

function flatten(layers: Layer[], depth: ColorDepth): SgrPair {
  return {
    open: layers.map((l) => l.open(depth)).join(""),
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
 * A style's layers. The background band is separate from `layers` because its
 * bytes depend on colour depth, and because it may be a derived colour or a
 * legacy absolute grayscale level.
 */
interface StyleSpec {
  layers?: Layer[];
  band?: Band;
  /** Body carries inline SGR spans from format.ts. */
  inlineSgr?: boolean;
}

/**
 * Tokens for the TUI's own furniture: box borders, modal contents, list rows,
 * banners, input cursors, progress lines.
 *
 * Separate from `Style` because these can never be a FormattedLine's
 * bodyStyle — there is no scrollback line for a box border. Keeping them out
 * of that union stops it advertising ~40 members it cannot hold, while
 * `ThemeToken` gives the resolver and the theme table a single key space.
 *
 * The `// role:` notes record which palette role each token should draw from
 * once the palette layer lands. They are written now because the intent is
 * obvious while reading the call site and much less obvious afterwards.
 */
export type ChromeToken =
  // Shared modal box drawn by prompt-utils: corners, edges, title strip.
  // The -focused variants exist because the picker draws several boxes at
  // once and tints the one holding keyboard focus; -hover marks a clickable
  // label embedded in a border (the picker's cwd and agent•model fragments).
  | "box-border"
  | "box-border-focused"
  | "box-border-hover"
  | "box-border-focused-hover"
  | "box-title"
  // Contents of a modal or banner.
  | "modal-title"
  | "modal-label"
  | "modal-value"
  | "modal-note"
  | "modal-error"
  | "modal-hint"
  | "modal-status"
  | "modal-key"
  // A text input's validation message and cursor, and an inline prompt
  // (search filter, kill confirmation, rename) with its block cursor.
  | "input-error"
  | "input-cursor"
  | "prompt-text"
  | "prompt-cursor"
  | "prompt-destructive"
  // A selectable list inside a modal.
  | "list-selected"
  | "list-description"
  | "list-header"
  // A selectable option in an in-prompt modal, where selection is marked by
  // colour rather than a background band.
  | "modal-option"
  | "modal-option-selected"
  // The sessionbar and the rules above and below the prompt.
  | "bar-text"
  | "bar-indicator"
  | "rule"
  | "rule-pad"
  | "rule-meta"
  | "hint-hover"
  // Slash-command / file completion popup.
  | "completion-name"
  | "completion-desc"
  // An attached-file chip on the prompt row.
  | "attachment"
  // Queued prompts waiting to be sent.
  | "queue-row"
  | "queue-cursor"
  | "queue-blank"
  // The prompt composer.
  | "composer-gutter"
  | "composer-inactive"
  | "composer-continuation"
  // Messages written straight to the terminal outside any frame: before the
  // TUI starts, or while tearing it down.
  | "cli-warn"
  // Text with no styling of its own: the value half of a label/value pair, the
  // agent cell in the sessionbar, a session row, composer text.
  | "content";

/**
 * Syntax-highlighting scopes, named after highlight.js's own so they map 1:1
 * onto what the highlighter emits rather than onto a vocabulary we invented.
 *
 * A third union for the same reason ChromeToken is separate from Style: these
 * are never a FormattedLine's bodyStyle. They style runs *inside* a code
 * block's body, which is why they resolve differently from every other token —
 * see SYNTAX_THEME below.
 */
export type SyntaxToken =
  | "syntax-addition"
  | "syntax-attr"
  | "syntax-attribute"
  | "syntax-built_in"
  | "syntax-builtin-name"
  | "syntax-bullet"
  | "syntax-class"
  | "syntax-code"
  | "syntax-comment"
  | "syntax-default"
  | "syntax-deletion"
  | "syntax-doctag"
  | "syntax-emphasis"
  | "syntax-formula"
  | "syntax-function"
  | "syntax-keyword"
  | "syntax-link"
  | "syntax-literal"
  | "syntax-meta"
  | "syntax-meta-keyword"
  | "syntax-meta-string"
  | "syntax-name"
  | "syntax-number"
  | "syntax-params"
  | "syntax-quote"
  | "syntax-regexp"
  | "syntax-section"
  | "syntax-selector-attr"
  | "syntax-selector-class"
  | "syntax-selector-id"
  | "syntax-selector-pseudo"
  | "syntax-selector-tag"
  | "syntax-string"
  | "syntax-strong"
  | "syntax-subst"
  | "syntax-symbol"
  | "syntax-tag"
  | "syntax-template-tag"
  | "syntax-template-variable"
  | "syntax-title"
  | "syntax-type"
  | "syntax-variable";

/** Anything the theme can resolve. */
export type ThemeToken = Style | ChromeToken | SyntaxToken;

// Keyed by ThemeToken rather than string so a token declared in a union but
// missing an entry here is a compile error rather than something that silently
// resolves to unstyled.
function buildStyles(): Record<ThemeToken, StyleSpec> {
  return {
  // Quiet full-width band marking the start of a user turn. Bold on a
  // grayscale lift rather than a colour, so it reads as a boundary rather
  // than a highlight stripe.
  user: { band: bands.user, layers: [...roles.emphasis] },

  // Agent prose takes the terminal's default foreground: it's the bulk of
  // the transcript, and anything else fights the user's theme.
  // `roles.fg`, not "no layers": with the default palette that role is empty,
  // so prose keeps taking the terminal's own foreground — which is what should
  // happen, since it is the bulk of the transcript and adapts to a light
  // terminal for free. But a theme that declares `fg` means it, and prose is
  // the main thing it means it about.
  agent: { layers: [...roles.fg], inlineSgr: true },

  thought: { layers: [...roles.subtle], inlineSgr: true },

  tool: { layers: [...roles.reference] },

  // Completed, queued and cancelled all read as "not the thing to look at",
  // so they share dim; running is the only tool state that gets colour.
  "tool-status-ok": { layers: [...roles.muted] },
  "tool-status-pending": { layers: [...roles.muted] },
  "tool-status-cancelled": { layers: [...roles.muted] },
  "tool-status-running": { layers: [...roles.active] },
  "tool-status-fail": { layers: [...roles.emphasis, ...roles.errorSoft] },

  plan: { layers: [...roles.active], inlineSgr: true },
  "plan-done": { layers: [...roles.ok], inlineSgr: true },
  "plan-pending": { layers: [...roles.muted], inlineSgr: true },

  // Lines the TUI itself emits, as opposed to anything relayed from the
  // agent. Split out of the former `system` / `info` / `dim` tokens, which
  // between them covered section headings, list rows, passive notices, hard
  // failures, live metrics, chrome, tool output and idle state. Nine roles
  // sharing three colours meant none of them could be retinted without
  // dragging the others along.
  //
  // Several still render identically, which is fine and is the same shape the
  // tool-status tokens already have: distinct meanings, shared default.

  // `/help`-style section heading and the rows beneath it.
  //
  // Bold rather than coloured. It used to be brightYellow, which is the busy
  // accent this TUI uses everywhere else (plan, tool-status-running, the busy
  // status label, the queue counter), so a static list heading was wearing
  // "something is happening". Bold is what heading-3 does and competes with
  // no state colour, and it reads as a heading above the cyan rows.
  "local-heading": { layers: [...roles.emphasis] },
  "local-item": { layers: [...roles.info] },

  // Outcome of a slash command, or a passive state change the user did not ask
  // about.
  notice: { layers: [...roles.info] },

  // Green, matching plan-done, which is the success colour everywhere else.
  // This was brightYellow, i.e. the busy accent, for a line that reports a
  // finished write.
  "notice-ok": { layers: [...roles.ok] },

  // Things the user has to act on: a usage error, a missing precondition, a
  // failed export. These used to be cyan — identical to the `/help` listing —
  // so "/export failed: HTTP 500" was indistinguishable from a table of
  // commands, while `btw startup failed` a few lines away in the same file
  // was correctly red.
  //
  // Plain red, not the bold red of tool-status-fail. Bold red is reserved for
  // the agent's work failing: a tool broke, a turn stopped. This is the
  // milder "your command did not run", which covers both hard failures and
  // usage mistakes, so it should not shout as loudly as a broken tool call.
  "notice-error": { layers: [...roles.errorSoft] },

  // A live number the user reads rather than acts on. Its own token because
  // the context gadget flips it to tool-status-fail past 90%, making it the
  // calm arm of a two-state health indicator rather than decoration.
  metric: { layers: [...roles.info] },

  // De-emphasised: rules and separators, scaffolding labels, provenance tags,
  // overflow counters, and a block's own recessed caption. "Not the point",
  // whatever the row happens to contain.
  muted: { layers: [...roles.muted] },

  // Verbatim tool input and output. Content the user expanded on purpose, so
  // not de-emphasis: this is the unhighlighted sibling of `code`, chosen when
  // no language could be inferred for the payload.
  "tool-output": { layers: [...roles.muted] },

  // Session state, one enum across every surface that reports it: the
  // separator's headline, the btw overlay header, and the sidebar's activity
  // and live-session rows.
  //
  // `status-active` means a turn is in flight — which spans reasoning, text
  // streaming AND tool execution, since it is driven by pendingTurns going
  // 0->1. It is deliberately not called "thinking": that is only the label
  // the activity gadget prints, and naming the token after it would invite
  // using it for reasoning alone. It is also not "busy", which implies load
  // rather than something happening.
  //
  // `tool-status-running` stays separate and keeps its name: it is scoped to a
  // single tool call, and ACP itself says in_progress/running for tool state.
  //
  // `status-alert` covers stalled, disconnected, cancelled and errored — all
  // "something is wrong", all one signal.
  //
  // `status-ready` and `status-idle` are both "nothing is happening" and
  // differ only by surface: ready is the separator's headline, at full
  // brightness because the normal case should not draw the eye; idle is one
  // sidebar row among many, so it recedes. A wart, kept knowingly.
  // role: fg / muted / active / muted / active / error / cold
  "status-ready": { layers: [...roles.fg] },
  "status-active": { layers: [...roles.active] },
  // Blocked on the user, e.g. sitting on a permission prompt. Deliberately
  // not red: red means failure everywhere else and a waiting session has not
  // failed. Renders like idle today but is a distinct state and now tunable.
  "status-waiting": { layers: [...roles.muted] },
  // Prompts typed but not yet sent. Not active — pending — but it earns the
  // accent because it is outstanding work the user should notice.
  "status-queued": { layers: [...roles.active] },
  "status-alert": { layers: [...roles.error] },
  "status-cold": { layers: [...roles.cold] },

  // Working-tree state. Previously borrowed plan-done / tool / plan-pending,
  // which meant retinting plan entries also recoloured git status.
  // role: ok / accent / muted
  "git-staged": { layers: [...roles.gitStaged] },
  "git-dirty": { layers: [...roles.gitDirty] },
  "git-untracked": { layers: [...roles.gitUntracked] },

  // A path in a list of touched files. Previously borrowed `tool`.
  // role: accent
  "file-path": { layers: [...roles.reference] },

  // The context-window gauge, and the same gauge past 90% where it becomes
  // the warning that a compaction is imminent. Previously borrowed plan-done
  // and tool-status-fail. role: ok / error
  "meter-fill": { layers: [...roles.ok] },
  "meter-warn": { layers: [...roles.emphasis, ...roles.errorSoft] },

  // Sidebar furniture: the rule between gadget blocks, the gutter glyph, and
  // a block's title row. Split from `muted` so the sidebar frame can be tinted
  // without touching table rules and provenance tags in the transcript.
  // role: muted
  "sidebar-rule": { layers: [...roles.muted] },
  "sidebar-title": { layers: [...roles.muted] },
  // A value in the sidebar — an agent name, a model, a session's label.
  //
  // The body colour, which is what the info gadget's values already had by
  // omitting a style entirely. Naming it does two things: it says the plainness
  // is a decision rather than an oversight, and it gives the sessions list
  // something to match. Those labels were reading as scaffolding because they
  // were literally styled as it.
  "sidebar-value": { layers: [...roles.fg] },

  // The quiescent arm of a state enum whose other arms are
  // tool-status-running / -fail / -cancelled: idle, ready, awaiting approval,
  // fetching, a turn that finished cleanly, a peer session with nothing to
  // say. Separate because restyling it changes a signal, not a decoration.
  "status-idle": { layers: [...roles.muted] },

  // --- chrome -------------------------------------------------------------

  // Box edges recede so the content inside them reads first. role: muted
  "box-border": { layers: [...roles.muted] },
  // The box holding keyboard focus, so a stack of them is readable at a
  // glance. role: focus
  "box-border-focused": { layers: [...roles.focus] },
  // A clickable label inside a border, under the pointer. Bold rather than a
  // colour so it reads as "this bit is a target" without a second hue in the
  // frame. role: muted + emphasis
  "box-border-hover": { layers: [...roles.muted, ...roles.emphasis] },
  // role: focus + emphasis
  "box-border-focused-hover": { layers: [...roles.focus, ...roles.emphasis] },
  // The one coloured part of the frame, so a stack of overlays stays legible.
  // role: accent
  "box-title": { layers: [...roles.accent] },

  // A banner or modal's headline. role: emphasis
  "modal-title": { layers: [...roles.fgStrong, ...roles.emphasis] },
  // Label half of a label/value pair; the value is left unstyled, the same
  // scaffolding-vs-data split the sidebar uses. role: muted
  "modal-label": { layers: [...roles.muted] },
  // Value half, where it needs to stand out (a command to run, a URL).
  // role: emphasis
  "modal-value": { layers: [...roles.fgStrong] },
  // Attention without failure: "authentication required". role: warn
  "modal-note": { layers: [...roles.active] },
  // A banner reporting something that already went wrong. role: error
  "modal-error": { layers: [...roles.error] },
  // Keybinding hints, footers, elision notes. role: muted
  "modal-hint": { layers: [...roles.muted] },
  // Transient status: an action in flight, "searching…", "no matches". Reads
  // the same as a hint today but it reports state rather than offering
  // guidance. role: muted
  "modal-status": { layers: [...roles.muted] },
  // The key column of a hotkey table. role: accent
  "modal-key": { layers: [...roles.accent] },

  // Validation failure on an input field. Renders plain red where
  // modal-error is bright red: an inconsistency inherited from the two files,
  // now at least visible and separately tunable. role: error
  "input-error": { layers: [...roles.errorSoft] },
  // Block cursor in a text field. role: cursor
  "input-cursor": { layers: [...roles.cursor] },
  // An inline prompt the picker overlays on its own status row: the `/` search
  // filter, a kill confirmation, a rename. Yellow because it is asking for
  // something. role: warn
  "prompt-text": { layers: [...roles.active] },
  // Its block cursor, on the same hue as the text. Note this is a different
  // colour from input-cursor (bgWhite) — two surfaces picked differently, now
  // visible in one place rather than buried in two files. role: warn
  "prompt-cursor": { layers: [...roles.promptCursor] },
  // Confirming something irreversible ("kill + delete abc123? [y/N]"). Shares
  // bright red with modal-error but means the opposite thing: this is a
  // question about to be answered, not a report of something already broken.
  // Separated so the two can diverge. role: error
  "prompt-destructive": { layers: [...roles.error] },

  // Selected row of a modal list. role: selection
  "list-selected": { layers: [...roles.selection] },
  // Secondary text under a row. role: muted
  "list-description": { layers: [...roles.muted] },
  // Column-header row above a list. role: muted
  "list-header": { layers: [...roles.muted] },

  // Unselected and selected rows of an in-prompt modal. These mark selection
  // with colour instead of list-selected's background band, because the modal
  // is drawn inline over the prompt rather than in a box of its own.
  // role: muted / warn
  "modal-option": { layers: [...roles.muted] },
  "modal-option-selected": { layers: [...roles.active] },

  // Identity strings in the sessionbar: cwd and session title. Bold rather
  // than coloured, matching the sidebar policy that identity reads the same
  // whatever it says and so should not compete with state. role: emphasis
  "bar-text": { layers: [...roles.emphasis] },
  // "you are not looking at the live tail": the scrollback offset and the
  // search indicator. role: accent
  "bar-indicator": { layers: [...roles.accent] },
  // The ── glyphs of a rule. role: emphasis
  rule: { layers: [...roles.emphasis] },
  // Padding either side of a rule. Separate from rule-meta because it carries
  // no information at all. role: muted
  "rule-pad": { layers: [...roles.muted] },
  // Subordinate data sitting in a rule: the short session id and its
  // separators. role: muted
  "rule-meta": { layers: [...roles.muted] },
  // A hint chunk in the bottom rule under the pointer. Full brightness rather
  // than a colour: the surrounding chunks are dim, so removing the dimming is
  // itself the hover signal. role: fg
  "hint-hover": { layers: [...roles.fg] },

  // Completion popup: the candidate and its description. role: accent / muted
  "completion-name": { layers: [...roles.accent] },
  "completion-desc": { layers: [...roles.muted] },

  // An attached-file chip. Plain yellow, not the bright yellow the busy accent
  // uses, so a pending attachment does not read as work in flight. role: warn
  attachment: { layers: [...roles.warn] },

  // Queued prompts, painted as a full-width blue band so a stack of them reads
  // as one block. The cursor marks which row an edit would land on.
  // role: selection
  "queue-row": { layers: [...roles.selection] },
  "queue-cursor": { layers: [...roles.selectionBand, ...roles.active] },
  "queue-blank": { layers: [...roles.selectionBand] },

  // The composer's "> " gutter when it holds focus, and everything about it
  // when an overlay has taken focus away. role: fg / muted
  "composer-gutter": { layers: [...roles.fgStrong] },
  "composer-inactive": { layers: [...roles.muted] },
  // The "· " marker starting a logical newline. role: muted
  "composer-continuation": { layers: [...roles.muted] },

  // --- syntax highlighting -------------------------------------------------

  // Several scopes share a role, which is highlight.js's granularity rather
  // than a decision here: `attr`/`attribute`, `section`/`tag`, and
  // `function`/`title` are the same thing under different language grammars.
  "syntax-addition": { layers: [...roles.diffAdded] },
  "syntax-attr": { layers: [...roles.syntaxBuiltin] },
  "syntax-attribute": { layers: [...roles.syntaxBuiltin] },
  "syntax-built_in": { layers: [...roles.syntaxBuiltin] },
  "syntax-builtin-name": { layers: [...roles.fg] },
  "syntax-bullet": { layers: [...roles.fg] },
  "syntax-class": { layers: [...roles.syntaxClass] },
  "syntax-code": { layers: [...roles.fg] },
  "syntax-comment": { layers: [...roles.syntaxComment] },
  "syntax-default": { layers: [...roles.fg] },
  "syntax-deletion": { layers: [...roles.diffRemoved] },
  "syntax-doctag": { layers: [...roles.syntaxDoctag] },
  "syntax-emphasis": { layers: [...roles.syntaxEmphasis] },
  "syntax-formula": { layers: [...roles.fg] },
  "syntax-function": { layers: [...roles.syntaxString] },
  "syntax-keyword": { layers: [...roles.syntaxKeyword] },
  "syntax-link": { layers: [...roles.syntaxLink] },
  "syntax-literal": { layers: [...roles.syntaxLiteral] },
  "syntax-meta": { layers: [...roles.syntaxMeta] },
  "syntax-meta-keyword": { layers: [...roles.fg] },
  "syntax-meta-string": { layers: [...roles.fg] },
  "syntax-name": { layers: [...roles.syntaxType] },
  "syntax-number": { layers: [...roles.syntaxNumber] },
  "syntax-params": { layers: [...roles.syntaxVariable] },
  "syntax-quote": { layers: [...roles.fg] },
  "syntax-regexp": { layers: [...roles.syntaxRegexp] },
  "syntax-section": { layers: [...roles.syntaxBuiltin] },
  "syntax-selector-attr": { layers: [...roles.fg] },
  "syntax-selector-class": { layers: [...roles.fg] },
  "syntax-selector-id": { layers: [...roles.fg] },
  "syntax-selector-pseudo": { layers: [...roles.fg] },
  "syntax-selector-tag": { layers: [...roles.fg] },
  "syntax-string": { layers: [...roles.syntaxString] },
  "syntax-strong": { layers: [...roles.syntaxStrong] },
  "syntax-subst": { layers: [...roles.fg] },
  "syntax-symbol": { layers: [...roles.syntaxMeta] },
  "syntax-tag": { layers: [...roles.syntaxBuiltin] },
  "syntax-template-tag": { layers: [...roles.fg] },
  "syntax-template-variable": { layers: [...roles.fg] },
  "syntax-title": { layers: [...roles.syntaxString] },
  "syntax-type": { layers: [...roles.syntaxType] },
  "syntax-variable": { layers: [...roles.syntaxVariable] },

  // Text with no styling of its own.
  //
  // Not the same as writing it unstyled. On the default palette this resolves to
  // nothing and the text inherits the terminal, which is what should happen. But
  // a theme that declares `fg` means it about this text too, and an unstyled
  // write ignores it — the visible symptom being a themed transcript with an
  // unthemed sessionbar, wearing whatever foreground the terminal happens to
  // have. role: fg
  content: { layers: [...roles.fg] },

  // A bare warning printed outside any frame ("no sessions found", a daemon
  // version mismatch on stderr). Plain yellow, not the bright yellow of the
  // busy accent — nothing is in flight. role: warn
  "cli-warn": { layers: [...roles.warn] },

  // Editor-like block: dark band with an explicit white foreground, so a
  // `diff` fence can let context lines sit neutral while cli-highlight's
  // red/green +/- overlay on top. A different shade from the user band so
  // the two are never confused.
  code: { band: bands.code, layers: [...roles.codeText] },

  "heading-1": { layers: [...roles.emphasis, ...roles.active], inlineSgr: true },
  "heading-2": { layers: [...roles.emphasis, ...roles.accent], inlineSgr: true },
  "heading-3": { layers: [...roles.emphasis], inlineSgr: true },

  // Loud enough to find inside any base style without being unreadable on a
  // light terminal.
  "search-highlight": { layers: [...roles.match] },
  // The one match the search cursor is on, distinct from its siblings.
  "search-highlight-active": { layers: [...roles.matchActive] },
  // Inverse video stays legible over every base style and can't collide with
  // the two search treatments when both land on one row.
  "selection-highlight": { layers: [...roles.invert] },
  };
}

let STYLES = buildStyles();

// ---------------------------------------------------------------------------
// The active theme
// ---------------------------------------------------------------------------

/**
 * Everything derived from a palette, rebuilt as a unit when the theme changes.
 *
 * Rebuilding rather than resolving lazily is deliberate. A lazy scheme would
 * avoid the rebuild but capture palette lookups in closures, which is exactly
 * the kind of thing that half-updates and produces a screen mixing two themes.
 * A swap is rare and the table is small.
 *
 * `revision` exists so consumers holding derived state can tell it is stale
 * without needing to be notified — format.ts keys its highlight cache on it,
 * so old-theme output is never reused.
 */
interface ActiveTheme {
  prose: InlineOpts;
  thought: InlineOpts;
  revision: number;
}

let active: ActiveTheme = {
  prose: buildProseInlineOpts(),
  thought: buildThoughtInlineOpts(),
  revision: 0,
};

// Built on first use rather than here: buildSyntaxTheme walks SYNTAX_TOKENS,
// which is declared further down. Eager construction would depend on
// declaration order within this file, which is exactly the kind of coupling
// that breaks the moment someone reorders it.
let syntaxCache: Record<string, (code: string) => string> | undefined;

/**
 * Swap the palette and rebuild everything derived from it.
 *
 * Does not repaint: the caller decides when, since a theme change during an
 * interactive picker wants a redraw and one during startup does not.
 *
 * Note what this cannot reach: inline spans and syntax colours are baked into
 * a FormattedLine's body when it is parsed, so scrollback already on screen
 * keeps its old span colours until those lines are re-parsed. Everything
 * resolved at paint time — every token, all chrome — updates on the next draw.
 */
export function setTheme(
  next: Palette,
  overrides: {
    roles?: Partial<Record<string, ColorOverride>>;
    elements?: Partial<Record<string, ColorOverride>>;
    /**
     * The terminal's actual background, when it is known. Overrides the theme's
     * own `bg` for band derivation only — nothing paints it.
     */
    background?: Color;
    /**
     * The terminal's actual foreground, when it is known. Used only to keep a
     * band from creeping too close to the text on it, and only for a theme that
     * declares no `fg` of its own — see terminalForeground.
     */
    foreground?: Color;
  } = {},
): void {
  palette = next;
  roleOverrides = overrides.roles ?? {};
  elementOverrides = overrides.elements ?? {};
  bandReference = overrides.background;
  terminalForeground = overrides.foreground;
  bands = buildBands();
  roles = applyRoleOverrides(buildRoles());
  spans = buildSpans();
  STYLES = buildStyles();
  syntaxCache = undefined;
  active = {
    prose: buildProseInlineOpts(),
    thought: buildThoughtInlineOpts(),
    revision: active.revision + 1,
  };
}

/** Every role name a theme may override. */
export function roleNames(): string[] {
  return Object.keys(buildRoles()).sort();
}

/** Every element (token) name a theme may override. */
export function elementNames(): string[] {
  return Object.keys(STYLES).sort();
}

/** Whether a bare colour string on this role means `fg` rather than `bg`. */
export function roleTakesFg(name: string): boolean {
  const r = buildRoles() as Record<string, Layer[]>;
  const layers = r[name];
  return layers === undefined ? true : stackTakesFg(layers);
}

/** Whether a bare colour string on this element means `fg` rather than `bg`. */
export function elementTakesFg(name: string): boolean {
  const spec = STYLES[name as ThemeToken];
  if (spec === undefined) {
    return true;
  }
  if (spec.band !== undefined) {
    // A band-bearing element (a user turn, a code block) has a background
    // already, but a bare string should still recolour its text.
    return true;
  }
  return stackTakesFg(spec.layers ?? []);
}

/** Bumped on every setTheme, for consumers caching derived output. */
export function themeRevision(): number {
  return active.revision;
}

/** The active cli-highlight theme. Re-read after a theme swap. */
export function syntaxTheme(): Record<string, (code: string) => string> {
  syntaxCache ??= buildSyntaxTheme();
  return syntaxCache;
}

/** A band as a Layer, whichever of the two forms it takes. */
function bandLayer(b: Band): Layer {
  if (typeof b === "number") {
    // Legacy absolute grayscale, quantised by bgGrayscale against the depth.
    return {
      open: (depth) => bgGrayscale(b, depth).open,
      close: bgReset,
      kind: "bg",
    };
  }
  // Neutral: a band is a step off the background, so it quantises onto the grey
  // ramp rather than by hue. Without that, a theme whose background carries a
  // cast has that cast amplified on the way down — solarized's #002b36 derives a
  // teal-tinted slate, which is right at 24 bits and arrives as ansi cyan at 4.
  return bandBgL(b);
}

const EMPTY: StyleRender = { open: "", close: "", inlineSgr: false };

/** Resolve a style to the bytes that wrap its text. */
export function resolveStyle(
  style: ThemeToken | undefined,
  depth: ColorDepth,
): StyleRender {
  // "none" is a depth like any other: every token resolves to nothing, so
  // NO_COLOR needs no branch anywhere downstream.
  if (depth === "none") {
    return EMPTY;
  }
  if (style === undefined) {
    // No style at all is not the same as no colour. A FormattedLine may leave
    // bodyStyle unset on purpose — the sidebar's field values do, following its
    // policy that identity strings earn no colour — and on the default palette
    // that correctly means "inherit the terminal". A theme that declares `fg`
    // means it about this text too, so it gets the same treatment as a token
    // that names no foreground of its own.
    return roles.fg.length === 0
      ? EMPTY
      : { ...flatten(roles.fg, depth), inlineSgr: false };
  }
  const spec = STYLES[style];
  if (spec === undefined) {
    return EMPTY;
  }
  let layers: Layer[] = [];
  const override = elementOverrides[style];
  if (spec.band !== undefined) {
    // An element override's `bg` replaces the band outright rather than sitting
    // beside it — two backgrounds on one run is not a thing.
    layers.push(
      override?.bg !== undefined ? bgL(override.bg) : bandLayer(spec.band),
    );
  }
  if (spec.layers) {
    layers.push(...spec.layers);
  }
  if (override !== undefined) {
    // The band already consumed `bg` above, if there was one.
    layers = withOverride(
      layers,
      spec.band !== undefined ? { fg: override.fg } : override,
    );
  }
  // A token that names no foreground of its own takes the theme's.
  //
  // Without this, every attribute-only token — `rule` and `bar-text` and
  // `heading-3` are just bold, the two dozen muted ones are just dim, `user` is
  // a band plus bold — renders at whatever foreground the TERMINAL has. On the
  // default palette that is exactly right and this is a no-op, since roles.fg is
  // empty. On a theme that declares `fg` it is the difference between a themed
  // TUI and a half-themed one.
  //
  // Skipped when the token sets a background through a role rather than a band:
  // a block cursor or a selection stripe has already decided its own contrast,
  // and forcing the theme's foreground onto it would paint white on white. A
  // band is different — it is a subtle boundary whose text should stay in the
  // normal reading colour, which is why `user` wants this and `input-cursor`
  // does not.
  if (roles.fg.length > 0 && !layers.some((l) => l.kind === "fg")) {
    const setsOwnBackground = (spec.layers ?? []).some((l) => l.kind === "bg");
    if (!setsOwnBackground) {
      layers.push(...roles.fg);
    }
  }
  return {
    ...flatten(layers, depth),
    inlineSgr: spec.inlineSgr === true,
  };
}

/**
 * Whether a style's text carries inline SGR spans.
 *
 * Two callers need this and they must agree. writeStyled uses it to decide
 * whether to append the trailing reset; wrap/truncate use it to treat escape
 * sequences as zero-width when measuring, because `ESC[96mfoo ESC[0m`
 * occupies 14 JS characters and 3 columns — get it wrong and a span near the
 * right edge wraps early. Both read the same field, so a style cannot be
 * span-bearing for one and not the other.
 */
export function styleCarriesInlineSgr(style: Style | undefined): boolean {
  if (style === undefined) {
    return false;
  }
  return STYLES[style]?.inlineSgr === true;
}

/**
 * The slice of terminal-kit `paint` needs. Structural on purpose: this module
 * stays free of a terminal-kit import so the theme table can be read and
 * tested without one.
 */
interface PaintTarget {
  noFormat: (text: string) => unknown;
  esc?: { color24bits?: { na?: boolean; fb?: boolean } };
}

/**
 * Write `text` styled as `token`.
 *
 * The chrome counterpart to writeStyled. It is deliberately much smaller:
 * furniture has no hover state, carries no inline spans, and needs none of
 * the trailing-reset replication that scrollback bodies do. All it does is
 * bracket the text in the token's sequences.
 *
 * Always `.noFormat`, so a caret or a stray escape in a path, a branch name
 * or an agent-supplied label is written literally rather than being read as a
 * style command.
 */
export function paint(
  term: PaintTarget,
  token: ThemeToken,
  text: string,
): void {
  if (text.length === 0) {
    return;
  }
  term.noFormat(styled(token, text, depthForTerminal(term)));
}

/**
 * The same thing as a string, for callers with no terminal-kit instance to
 * ask — notably the pre-TUI stderr warnings, which run before a terminal is
 * constructed.
 *
 * Depth defaults to 256-colour: the conservative choice that renders somewhere
 * rather than emitting 24-bit at a terminal that cannot read it. Callers that
 * know better (and that have already decided colour is wanted at all) pass it.
 */
export function styled(
  token: ThemeToken,
  text: string,
  depth: ColorDepth = "ansi256",
): string {
  const r = resolveStyle(token, depth);
  return r.open + text + r.close;
}

/**
 * Every scope cli-highlight knows about.
 *
 * Completeness is load-bearing, not tidiness: cli-highlight resolves a scope as
 * `theme[scope] || DEFAULT_THEME[scope] || plain`, and its DEFAULT_THEME is
 * chalk-based. Any scope left out would fall through to chalk — unthemeable,
 * and closing with SGR 39, which on a code band drops the rest of the line to
 * the terminal's default foreground. `doctag` did exactly that.
 */
const SYNTAX_TOKENS: SyntaxToken[] = [
  "syntax-addition",
  "syntax-attr",
  "syntax-attribute",
  "syntax-built_in",
  "syntax-builtin-name",
  "syntax-bullet",
  "syntax-class",
  "syntax-code",
  "syntax-comment",
  "syntax-default",
  "syntax-deletion",
  "syntax-doctag",
  "syntax-emphasis",
  "syntax-formula",
  "syntax-function",
  "syntax-keyword",
  "syntax-link",
  "syntax-literal",
  "syntax-meta",
  "syntax-meta-keyword",
  "syntax-meta-string",
  "syntax-name",
  "syntax-number",
  "syntax-params",
  "syntax-quote",
  "syntax-regexp",
  "syntax-section",
  "syntax-selector-attr",
  "syntax-selector-class",
  "syntax-selector-id",
  "syntax-selector-pseudo",
  "syntax-selector-tag",
  "syntax-string",
  "syntax-strong",
  "syntax-subst",
  "syntax-symbol",
  "syntax-tag",
  "syntax-template-tag",
  "syntax-template-variable",
  "syntax-title",
  "syntax-type",
  "syntax-variable",
];

/**
 * A cli-highlight theme: highlight.js scope -> a function that wraps a run of
 * code in that scope's colour.
 *
 * Two things make this different from every other token consumer.
 *
 * It closes back to `codeText` rather than to the default foreground. A code
 * block sits on its own band with an explicit white base, so a span that closed
 * to SGR 39 would drop the rest of the line to whatever the user's default
 * foreground happens to be. This used to be patched up afterwards by rewriting
 * every `\x1b[39m` in the highlighter's output to `\x1b[37m`; emitting the
 * right closer in the first place is the same bytes without the rewrite.
 *
 * And it resolves at a fixed 256-colour depth, because highlighting runs at
 * parse time where no terminal is in scope — the same constraint the inline
 * span openers have. Immaterial while the palette is the terminal's own ansi
 * slots, since those are depth-independent; an explicitly-themed syntax palette
 * on a truecolor terminal would be quantised. Threading depth in from the app
 * layer would fix it.
 */
export function buildSyntaxTheme(): Record<string, (code: string) => string> {
  const base = openOf(roles.codeText);
  const theme: Record<string, (code: string) => string> = {};
  for (const token of SYNTAX_TOKENS) {
    const { open, close } = resolveStyle(token, inlineDepth);
    const scope = token.slice("syntax-".length);
    if (open === "") {
      // No colour of its own: pass text through rather than bracketing it in
      // empty escapes.
      theme[scope] = (code) => code;
      continue;
    }
    // Rewrite only the foreground half of the close. A scope that set a colour
    // has to land back on the band's base rather than the terminal default; a
    // scope that set an attribute (highlight.js `emphasis` is italic, `strong`
    // is bold) has to emit that attribute's own off-code, or the attribute
    // leaks to the end of the line. A scope that set both gets both.
    const shut = close.split(fgReset).join(base);
    theme[scope] = (code) => open + code + shut;
  }
  return theme;
}

/**
 * Styles that gain a background band when the row is hovered.
 *
 * Partial on purpose. Hover marks a *clickable* block — it is driven by
 * blockKey and it also sets the pointer cursor — so only styles that appear
 * inside a keyed, clickable block belong here:
 *
 *  - tool rows and plan entries live in keyed blocks, so they band.
 *  - `agent` and the headings live in `agent:`-prefixed blocks, which the
 *    pointer handler skips outright ("no click or hover affordance"), so a
 *    band would advertise something that does not exist.
 *  - `user` and the local-/notice-/metric- tokens are appended unkeyed and
 *    can never be hovered at all.
 *  - `thought` and `code` are hoverable but get their own treatment above.
 *  - the search and selection styles are applied to slices of a row rather
 *    than being a row's base style; their band comes from the base.
 *  - the sidebar-only tokens (git-*, meter-*, file-path, sidebar-*, and the
 *    status-* family) are absent because the sidebar painter passes
 *    hovered: false. They were split out of tokens that ARE banded
 *    (plan-done, tool, muted, tool-status-running), and dropping the band
 *    with them is deliberate: those predecessors needed it for their
 *    transcript duty, which these successors do not have.
 */
const HOVER_BANDED = new Set<Style>([
  // All three successors of the old `dim` token: each appears inside a keyed
  // block (a tool block's truncation trailer, its output rows, a diff header
  // waiting on a fetch), so all three have to band or a hovered tool block
  // would highlight in stripes.
  "muted",
  "tool-output",
  "status-idle",
  "tool",
  "tool-status-ok",
  "tool-status-pending",
  "tool-status-cancelled",
  "tool-status-running",
  "tool-status-fail",
  // All three plan states, so hovering a checklist highlights the whole
  // thing. Previously only plan-pending banded, which lit up the not-yet-
  // started entries and left the in-progress and completed ones flat.
  "plan",
  "plan-done",
  "plan-pending",
]);

/**
 * The shared hover band: 256-colour index 236, a step off most default
 * backgrounds — enough to see the row change, not enough to read as a
 * selection. Emitted as an explicit index rather than via grayscale so it
 * doesn't drift with colour depth; hover needs to be the same weight
 * everywhere.
 */
function hoverBand(depth: ColorDepth): SgrPair {
  const bg = bandBase();
  if (bg === undefined) {
    return HOVER_ROW_LITERAL;
  }
  const layer = bgL(band(bg, BAND_STEPS.hoverRow, bandTextColor()));
  return { open: layer.open(depth), close: layer.close };
}

/**
 * Resolve a style as it renders on a hovered row.
 *
 * Returns undefined when the style has no hover treatment, in which case the
 * caller renders it exactly as an unhovered row.
 */
/**
 * Re-assert a background band after every full reset in `text`.
 *
 * Inline spans close with SGR 0, which clears the background along with
 * everything else. On an unhovered row that is exactly right. On a hovered
 * one the band was emitted once, before the body, so each reset would strip
 * it from that point to the end of the row — a hovered thought or plan entry
 * containing any inline span would show the band only up to its first span.
 */
function restoreBandAfterResets(text: string, band: string): string {
  return text.split(SGR_RESET).join(SGR_RESET + band);
}

export function resolveHovered(
  style: Style | undefined,
  depth: ColorDepth,
): StyleRender | undefined {
  if (style === undefined) {
    return undefined;
  }

  if (style === "thought") {
    const bandOpen = bandLayer(bands.hoverThought).open(depth);
    // Lift the dim brightBlack baseline to the default foreground so the
    // thought stays readable on the band. Every place the body restores
    // brightBlack (a span closing back to the row's base) becomes SGR 39 —
    // default foreground, leaving the background alone.
    //
    // Closing the band here does not shrink it: the trailing padding is a
    // separate hovered write that re-emits the band for itself, so coverage
    // across the empty columns is unaffected and the row no longer depends on
    // the painter's styleReset to stop the background smearing.
    return {
      open: bandOpen,
      close: bgReset,
      inlineSgr: true,
      transform: (text) =>
        restoreBandAfterResets(
          text.split(spans.thoughtBase).join(`${CSI}39m`),
          bandOpen,
        ),
    };
  }

  if (style === "code") {
    // A brightness step off the code band, derived from the theme's background
    // like every other band. The lift is large enough to survive the 256-colour
    // ramp's 10-unit rounding, which is what the hardcoded 24-bit value it
    // replaced was working around — at the cost of being the one band a theme
    // could not reach. Note it does NOT restate the code band's foreground:
    // hover paints over a row that already opened with it.
    return {
      open: bandLayer(bands.hoverCode).open(depth),
      close: bgReset,
      inlineSgr: false,
    };
  }

  if (!HOVER_BANDED.has(style)) {
    return undefined;
  }
  const base = resolveStyle(style, depth);
  const hb = hoverBand(depth);
  return {
    open: hb.open + base.open,
    close: base.close + hb.close,
    inlineSgr: base.inlineSgr,
    // A span inside the body closes with a full reset, which would drop the
    // band for the rest of the row. Only span-bearing styles need this;
    // plan-pending is the one that reaches it today.
    transform: base.inlineSgr
      ? (text) => restoreBandAfterResets(text, hb.open)
      : undefined,
  };
}
