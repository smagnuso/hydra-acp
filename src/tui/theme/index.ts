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

const palette = {
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
} as const;

// Grayscale levels (0-255) for the background bands. Not palette colours:
// these feed terminal-kit's grayscale quantisation, which resolveStyle applies
// against the terminal's depth. Once a theme can set `bg`, these become
// derived — band(bg, step) — and the direction of the lift follows bg's
// luminance so a light theme works from one key.
const bands = {
  user: 43,
  code: 28,
  hoverThought: 25,
} as const;

/** A palette colour used as a foreground. */
const fgL = (c: Color): Layer => ({
  open: (depth) => fgOpen(c, depth),
  close: fgReset,
});
/** A palette colour used as a background. */
const bgL = (c: Color): Layer => ({
  open: (depth) => bgOpen(c, depth),
  close: bgReset,
});

// Attributes are not colours and are not themeable: bold/dim/inverse carry
// structure (a heading is bold, secondary text recedes) and letting a theme
// unbold the rules would produce garbage for no gain. They compose with roles
// at the token level.
const attr = (on: number, off: number): Layer => ({
  open: () => `${CSI}${on}m`,
  close: `${CSI}${off}m`,
});
const bold = attr(1, 22);
const dim = attr(2, 22);
const inverse = attr(7, 27);

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
const roles = {
  // Text.
  fg: [] as Layer[],
  fgStrong: [fgL(palette.brightWhite)],
  muted: [dim],
  // The gray a thought sits in: quieter than muted, still legible.
  subtle: [fgL(palette.brightBlack)],
  emphasis: [bold],

  // State.
  active: [fgL(palette.brightYellow)],
  warn: [fgL(palette.yellow)],
  ok: [fgL(palette.green)],
  error: [fgL(palette.brightRed)],
  errorSoft: [fgL(palette.red)],
  cold: [fgL(palette.brightMagenta)],

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
} satisfies Record<string, Layer[]>;

/** The opening bytes of a role, for callers that splice colour into a string. */
/**
 * The opening bytes of a role, for callers that splice colour into a string
 * rather than bracketing text with it — the inline-span openers below.
 *
 * Fixed at 256-colour depth. Inline spans are baked into a FormattedLine's
 * body once, at parse time, where the terminal is not in scope; quantising is
 * the choice that renders somewhere on every terminal rather than emitting
 * 24-bit at one that cannot read it. Only matters for an explicitly-themed
 * palette, since ansi slots are depth-independent.
 */
function openOf(role: Layer[]): string {
  return role.map((l) => l.open("ansi256")).join("");
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
const SPAN_CODE = openOf(roles.accent);
const SPAN_CODE_QUIET = openOf(roles.info);
const SPAN_LINK = SPAN_CODE + SGR_UNDERLINE;
const THOUGHT_BASE = openOf(roles.subtle);

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
  codeOpen: SPAN_CODE,
  // Links are cyan + underlined.
  linkOpen: SPAN_LINK,
  base: "",
};

/**
 * Inline spans inside a thought. Code goes plain cyan rather than bright so
 * spans stay in the thought's gray register instead of punching out of it.
 */
export const THOUGHT_INLINE_OPTS: InlineOpts = {
  codeOpen: SPAN_CODE_QUIET,
  linkOpen: SPAN_LINK,
  base: THOUGHT_BASE,
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
    // heading-2 is itself `accent`, so a code span inside it would vanish;
    // `active` is the one other colour already in the heading vocabulary.
    codeOpen: style === "heading-2" ? openOf(roles.active) : SPAN_CODE,
    linkOpen: SPAN_LINK,
    base: resolveStyle(style, "ansi256").open,
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
  | "cli-warn";

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
  | "syntax-keyword"
  | "syntax-built_in"
  | "syntax-type"
  | "syntax-literal"
  | "syntax-number"
  | "syntax-string"
  | "syntax-regexp"
  | "syntax-comment"
  | "syntax-function"
  | "syntax-title"
  | "syntax-class"
  | "syntax-attr"
  | "syntax-attribute"
  | "syntax-variable"
  | "syntax-params"
  | "syntax-meta"
  | "syntax-symbol"
  | "syntax-section"
  | "syntax-tag"
  | "syntax-name"
  | "syntax-addition"
  | "syntax-deletion";

/** Anything the theme can resolve. */
export type ThemeToken = Style | ChromeToken | SyntaxToken;

// Keyed by ThemeToken rather than string so a token declared in a union but
// missing an entry here is a compile error rather than something that silently
// resolves to unstyled.
const STYLES: Record<ThemeToken, StyleSpec> = {
  // Quiet full-width band marking the start of a user turn. Bold on a
  // grayscale lift rather than a colour, so it reads as a boundary rather
  // than a highlight stripe.
  user: { grayBg: bands.user, layers: [...roles.emphasis] },

  // Agent prose takes the terminal's default foreground: it's the bulk of
  // the transcript, and anything else fights the user's theme.
  agent: { inlineSgr: true },

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
  "git-staged": { layers: [...roles.ok] },
  "git-dirty": { layers: [...roles.reference] },
  "git-untracked": { layers: [...roles.muted] },

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
  "syntax-keyword": { layers: [...roles.syntaxKeyword] },
  "syntax-built_in": { layers: [...roles.syntaxBuiltin] },
  "syntax-type": { layers: [...roles.syntaxType] },
  "syntax-literal": { layers: [...roles.syntaxLiteral] },
  "syntax-number": { layers: [...roles.syntaxNumber] },
  "syntax-string": { layers: [...roles.syntaxString] },
  "syntax-regexp": { layers: [...roles.syntaxRegexp] },
  "syntax-comment": { layers: [...roles.syntaxComment] },
  "syntax-function": { layers: [...roles.syntaxString] },
  "syntax-title": { layers: [...roles.syntaxString] },
  "syntax-class": { layers: [...roles.syntaxClass] },
  "syntax-attr": { layers: [...roles.syntaxBuiltin] },
  "syntax-attribute": { layers: [...roles.syntaxBuiltin] },
  "syntax-variable": { layers: [...roles.syntaxVariable] },
  "syntax-params": { layers: [...roles.syntaxVariable] },
  "syntax-meta": { layers: [...roles.syntaxMeta] },
  "syntax-symbol": { layers: [...roles.syntaxMeta] },
  "syntax-section": { layers: [...roles.syntaxBuiltin] },
  "syntax-tag": { layers: [...roles.syntaxBuiltin] },
  "syntax-name": { layers: [...roles.syntaxType] },
  "syntax-addition": { layers: [...roles.diffAdded] },
  "syntax-deletion": { layers: [...roles.diffRemoved] },

  // A bare warning printed outside any frame ("no sessions found", a daemon
  // version mismatch on stderr). Plain yellow, not the bright yellow of the
  // busy accent — nothing is in flight. role: warn
  "cli-warn": { layers: [...roles.warn] },

  // Editor-like block: dark band with an explicit white foreground, so a
  // `diff` fence can let context lines sit neutral while cli-highlight's
  // red/green +/- overlay on top. A different shade from the user band so
  // the two are never confused.
  code: { grayBg: bands.code, layers: [...roles.codeText] },

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

const EMPTY: StyleRender = { open: "", close: "", inlineSgr: false };

/** Resolve a style to the bytes that wrap its text. */
export function resolveStyle(
  style: ThemeToken | undefined,
  depth: ColorDepth,
): StyleRender {
  // "none" is a depth like any other: every token resolves to nothing, so
  // NO_COLOR needs no branch anywhere downstream.
  if (style === undefined || depth === "none") {
    return EMPTY;
  }
  const spec = STYLES[style];
  if (spec === undefined) {
    return EMPTY;
  }
  const layers: Layer[] = [];
  if (spec.grayBg !== undefined) {
    // Already depth-resolved by bgGrayscale, so its open ignores the argument.
    const gray = bgGrayscale(spec.grayBg, depth);
    layers.push({ open: () => gray.open, close: gray.close });
  }
  if (spec.layers) {
    layers.push(...spec.layers);
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
  const scopes: SyntaxToken[] = [
    "syntax-keyword",
    "syntax-built_in",
    "syntax-type",
    "syntax-literal",
    "syntax-number",
    "syntax-string",
    "syntax-regexp",
    "syntax-comment",
    "syntax-function",
    "syntax-title",
    "syntax-class",
    "syntax-attr",
    "syntax-attribute",
    "syntax-variable",
    "syntax-params",
    "syntax-meta",
    "syntax-symbol",
    "syntax-section",
    "syntax-tag",
    "syntax-name",
    "syntax-addition",
    "syntax-deletion",
  ];
  const theme: Record<string, (code: string) => string> = {};
  for (const scope of scopes) {
    const open = resolveStyle(scope, "ansi256").open;
    // cli-highlight keys on the bare scope name.
    theme[scope.slice("syntax-".length)] = (code) => open + code + base;
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
  depth: ColorDepth,
): StyleRender | undefined {
  if (style === undefined) {
    return undefined;
  }

  if (style === "thought") {
    const band = bgGrayscale(bands.hoverThought, depth).open;
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
          text.split(THOUGHT_BASE).join(`${CSI}39m`),
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
  const base = resolveStyle(style, depth);
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
