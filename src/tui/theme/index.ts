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
const SGR_DIM = `${CSI}2m`;
export const SGR_UNDERLINE = `${CSI}4m`;
const SGR_CYAN = `${CSI}36m`;
const SGR_BRIGHT_BLACK = `${CSI}90m`;
const SGR_BRIGHT_CYAN = `${CSI}96m`;

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
export const PROSE_INLINE_OPTS: InlineOpts = {
  codeOpen: SGR_BRIGHT_CYAN,
  // Links are cyan + underlined.
  linkOpen: SGR_BRIGHT_CYAN + SGR_UNDERLINE,
  base: "",
};

/**
 * Inline spans inside a thought. Code goes plain cyan rather than bright so
 * spans stay in the thought's gray register instead of punching out of it.
 */
export const THOUGHT_INLINE_OPTS: InlineOpts = {
  codeOpen: SGR_CYAN,
  linkOpen: SGR_BRIGHT_CYAN + SGR_UNDERLINE,
  base: SGR_BRIGHT_BLACK,
};

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
    codeOpen: style === "heading-2" ? brightYellow.open : SGR_BRIGHT_CYAN,
    linkOpen: SGR_BRIGHT_CYAN + SGR_UNDERLINE,
    base: resolveStyle(style, false).open,
  };
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

const brightRed = fg(91);

const bgRed = bg(41);
const bgBlue = bg(44);
const bgWhite = bg(47);
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
  // In-place progress line (binary download, install).
  | "status-progress";

/** Anything the theme can resolve: a scrollback style or a piece of chrome. */
export type ThemeToken = Style | ChromeToken;

// Keyed by ThemeToken rather than string so a token declared in a union but
// missing an entry here is a compile error rather than something that silently
// resolves to unstyled.
const STYLES: Record<ThemeToken, StyleSpec> = {
  // Quiet full-width band marking the start of a user turn. Bold on a
  // grayscale lift rather than a colour, so it reads as a boundary rather
  // than a highlight stripe.
  user: { grayBg: 43, layers: [bold] },

  // Agent prose takes the terminal's default foreground: it's the bulk of
  // the transcript, and anything else fights the user's theme.
  agent: { inlineSgr: true },

  thought: { layers: [brightBlack], inlineSgr: true },

  tool: { layers: [brightBlue] },

  // Completed, queued and cancelled all read as "not the thing to look at",
  // so they share dim; running is the only tool state that gets colour.
  "tool-status-ok": { layers: [dim] },
  "tool-status-pending": { layers: [dim] },
  "tool-status-cancelled": { layers: [dim] },
  "tool-status-running": { layers: [brightYellow] },
  "tool-status-fail": { layers: [bold, red] },

  plan: { layers: [brightYellow], inlineSgr: true },
  "plan-done": { layers: [green], inlineSgr: true },
  "plan-pending": { layers: [dim], inlineSgr: true },

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
  "local-heading": { layers: [bold] },
  "local-item": { layers: [cyan] },

  // Outcome of a slash command, or a passive state change the user did not ask
  // about.
  notice: { layers: [cyan] },

  // Green, matching plan-done, which is the success colour everywhere else.
  // This was brightYellow, i.e. the busy accent, for a line that reports a
  // finished write.
  "notice-ok": { layers: [green] },

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
  "notice-error": { layers: [red] },

  // A live number the user reads rather than acts on. Its own token because
  // the context gadget flips it to tool-status-fail past 90%, making it the
  // calm arm of a two-state health indicator rather than decoration.
  metric: { layers: [cyan] },

  // De-emphasised: rules and separators, scaffolding labels, provenance tags,
  // overflow counters, and a block's own recessed caption. "Not the point",
  // whatever the row happens to contain.
  muted: { layers: [dim] },

  // Verbatim tool input and output. Content the user expanded on purpose, so
  // not de-emphasis: this is the unhighlighted sibling of `code`, chosen when
  // no language could be inferred for the payload.
  "tool-output": { layers: [dim] },

  // The quiescent arm of a state enum whose other arms are
  // tool-status-running / -fail / -cancelled: idle, ready, awaiting approval,
  // fetching, a turn that finished cleanly, a peer session with nothing to
  // say. Separate because restyling it changes a signal, not a decoration.
  "status-idle": { layers: [dim] },

  // --- chrome -------------------------------------------------------------

  // Box edges recede so the content inside them reads first. role: muted
  "box-border": { layers: [dim] },
  // The box holding keyboard focus, so a stack of them is readable at a
  // glance. role: focus
  "box-border-focused": { layers: [brightBlue] },
  // A clickable label inside a border, under the pointer. Bold rather than a
  // colour so it reads as "this bit is a target" without a second hue in the
  // frame. role: muted + emphasis
  "box-border-hover": { layers: [dim, bold] },
  // role: focus + emphasis
  "box-border-focused-hover": { layers: [brightBlue, bold] },
  // The one coloured part of the frame, so a stack of overlays stays legible.
  // role: accent
  "box-title": { layers: [brightCyan] },

  // A banner or modal's headline. role: emphasis
  "modal-title": { layers: [brightWhite, bold] },
  // Label half of a label/value pair; the value is left unstyled, the same
  // scaffolding-vs-data split the sidebar uses. role: muted
  "modal-label": { layers: [dim] },
  // Value half, where it needs to stand out (a command to run, a URL).
  // role: emphasis
  "modal-value": { layers: [brightWhite] },
  // Attention without failure: "authentication required". role: warn
  "modal-note": { layers: [brightYellow] },
  // A banner reporting something that already went wrong. role: error
  "modal-error": { layers: [brightRed] },
  // Keybinding hints, footers, elision notes. role: muted
  "modal-hint": { layers: [dim] },
  // Transient status: an action in flight, "searching…", "no matches". Reads
  // the same as a hint today but it reports state rather than offering
  // guidance. role: muted
  "modal-status": { layers: [dim] },
  // The key column of a hotkey table. role: accent
  "modal-key": { layers: [brightCyan] },

  // Validation failure on an input field. Renders plain red where
  // modal-error is bright red: an inconsistency inherited from the two files,
  // now at least visible and separately tunable. role: error
  "input-error": { layers: [red] },
  // Block cursor in a text field. role: cursor
  "input-cursor": { layers: [bgWhite] },
  // An inline prompt the picker overlays on its own status row: the `/` search
  // filter, a kill confirmation, a rename. Yellow because it is asking for
  // something. role: warn
  "prompt-text": { layers: [brightYellow] },
  // Its block cursor, on the same hue as the text. Note this is a different
  // colour from input-cursor (bgWhite) — two surfaces picked differently, now
  // visible in one place rather than buried in two files. role: warn
  "prompt-cursor": { layers: [bgBrightYellow] },
  // Confirming something irreversible ("kill + delete abc123? [y/N]"). Shares
  // bright red with modal-error but means the opposite thing: this is a
  // question about to be answered, not a report of something already broken.
  // Separated so the two can diverge. role: error
  "prompt-destructive": { layers: [brightRed] },

  // Selected row of a modal list. role: selection
  "list-selected": { layers: [brightWhite, bgBlue] },
  // Secondary text under a row. role: muted
  "list-description": { layers: [dim] },
  // Column-header row above a list. role: muted
  "list-header": { layers: [dim] },

  // In-place progress, which is a busy state. role: busy
  "status-progress": { layers: [brightYellow] },

  // Editor-like block: dark band with an explicit white foreground, so a
  // `diff` fence can let context lines sit neutral while cli-highlight's
  // red/green +/- overlay on top. A different shade from the user band so
  // the two are never confused.
  code: { grayBg: 28, layers: [white] },

  "heading-1": { layers: [bold, brightYellow], inlineSgr: true },
  "heading-2": { layers: [bold, brightCyan], inlineSgr: true },
  "heading-3": { layers: [bold], inlineSgr: true },

  // Loud enough to find inside any base style without being unreadable on a
  // light terminal.
  "search-highlight": { layers: [bgBrightYellow, black] },
  // The one match the search cursor is on, distinct from its siblings.
  "search-highlight-active": { layers: [bgRed, brightWhite] },
  // Inverse video stays legible over every base style and can't collide with
  // the two search treatments when both land on one row.
  "selection-highlight": { layers: [inverse] },
};

const EMPTY: StyleRender = { open: "", close: "", inlineSgr: false };

/** Resolve a style to the bytes that wrap its text. */
export function resolveStyle(
  style: ThemeToken | undefined,
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
  return { ...flatten(layers), inlineSgr: spec.inlineSgr === true };
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
  const r = resolveStyle(token, supports24Bit(term));
  term.noFormat(r.open + text + r.close);
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
const HOVER_BAND: SgrPair = { open: `${CSI}48;5;236m`, close: `${CSI}49m` };

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
  trueColor: boolean,
): StyleRender | undefined {
  if (style === undefined) {
    return undefined;
  }

  if (style === "thought") {
    const band = bgGrayscale(25, trueColor).open;
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
      open: band,
      close: `${CSI}49m`,
      inlineSgr: true,
      transform: (text) =>
        restoreBandAfterResets(
          text.split(SGR_BRIGHT_BLACK).join(`${CSI}39m`),
          band,
        ),
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
      inlineSgr: false,
    };
  }

  if (!HOVER_BANDED.has(style)) {
    return undefined;
  }
  const base = resolveStyle(style, trueColor);
  return {
    open: HOVER_BAND.open + base.open,
    close: base.close + HOVER_BAND.close,
    inlineSgr: base.inlineSgr,
    // A span inside the body closes with a full reset, which would drop the
    // band for the rest of the row. Only span-bearing styles need this;
    // plan-pending is the one that reaches it today.
    transform: base.inlineSgr
      ? (text) => restoreBandAfterResets(text, HOVER_BAND.open)
      : undefined,
  };
}
