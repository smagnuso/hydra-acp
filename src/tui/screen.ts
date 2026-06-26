// Screen layer: owns terminal-kit setup, layout, and the live render of
// scrollback + prompt + sessionbar + banner. Receives `KeyEvent`s from the
// user and delegates them to an `InputDispatcher` (held by the app), then
// redraws.

import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve as resolvePath } from "node:path";
import stringWidth from "string-width";
import type { Terminal } from "terminal-kit";
import { RepaintScheduler, RowPainter } from "./screen/painter.js";
import wrapAnsi from "wrap-ansi";
import { formatAgentWithModel, formatCost } from "../core/agent-display.js";
import { shortenHomePath } from "../core/paths.js";
import { stripHydraSessionPrefix } from "../core/session.js";
import { formatSize, parseImageDropPaste } from "./attachments.js";
import { formatElapsed } from "./format.js";
import type { FormattedLine, Style } from "./format.js";

export { formatElapsed };
import type {
  Attachment,
  InputDispatcher,
  KeyEvent,
  KeyName,
} from "./input.js";
import {
  columnToOffset,
  columnToOffsetFromSegments,
} from "./column-mapping.js";
import { type ClipboardTarget, writeClipboard } from "./clipboard.js";
import { withSync } from "./sync.js";
import {
  ALT_SCREEN_LEAVE,
  AUTOWRAP_OFF,
  AUTOWRAP_ON,
  BRACKETED_PASTE_OFF,
  BRACKETED_PASTE_ON,
  DECCKM_OFF,
  DECPAM_OFF,
  FOCUS_IN,
  FOCUS_OUT,
  FOCUS_TRACK_OFF,
  FOCUS_TRACK_ON,
  FORMAT_OTHER_KEYS_OFF,
  FORMAT_OTHER_KEYS_ON,
  KITTY_KBD_POP,
  KITTY_KBD_PUSH,
  MODIFY_OTHER_KEYS_OFF,
  MODIFY_OTHER_KEYS_ON,
  MOUSE_ANY_MOTION_OFF,
  MOUSE_BUTTON_OFF,
  MOUSE_SGR_OFF,
  MOUSE_URXVT_OFF,
  MOUSE_X10_OFF,
  PASTE_END,
  PASTE_START,
  POINTER_SHAPE_DEFAULT,
  POINTER_SHAPE_POINTER,
  SELECTIVE_MOUSE_OFF,
  SELECTIVE_MOUSE_PROBE,
  SELECTIVE_MOUSE_WHEEL_ONLY,
  SHOW_CURSOR,
} from "./ansi.js";

// Maximum gap, in milliseconds, between two left-button presses on the
// same cell that still counts as a double-click for word-snap selection.
const DOUBLE_CLICK_MAX_MS = 500;
// Same-cell tolerance for double-click: presses within this many cells
// (Chebyshev distance) of the prior release still qualify. A strict 0
// would defeat the gesture on terminals that wobble by a single column.
const DOUBLE_CLICK_MAX_DIST = 1;
// ASCII-word-character regex for double-click word snap. We deliberately
// restrict to ASCII for this version (per spec) — Unicode word boundary
// expansion would require ICU or per-codepoint category tables.
const ASCII_WORD_RE = /[A-Za-z0-9_]/;
// Path-token characters scanned for the double-click "open file" gesture.
// Wider than ASCII_WORD_RE: includes the filesystem separators, dots,
// hyphens, tildes, and pluses that appear in real paths. The optional
// `:<linenumber>` suffix is matched separately after the token boundary.
const PATH_TOKEN_RE = /[A-Za-z0-9_./\-~+@]/;
// ANSI SGR pattern used when stripping styling escapes from extracted
// selection text so the clipboard payload is clean plaintext.
const ANSI_STRIP_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

export interface ScreenOptions {
  term: Terminal;
  dispatcher: InputDispatcher;
  onKey: (events: KeyEvent[]) => void;
  // Invoked with the keyed-block key under a left-click, when full mouse
  // capture is on and the click lands on a row owned by an upserted block
  // (e.g. "tools:3", "plan", "editdiff:<id>"). Lets the app toggle a
  // single block's expand/collapse. `rowOffset` is the 0-based index of
  // the clicked terminal row within that block (0 = top line of the
  // block). Clicks on unkeyed rows are ignored.
  onBlockClick?: (key: string, rowOffset: number) => void;
  // Invoked on a double-click that lands on a row owned by a keyed
  // block, BEFORE the screen's own open-file scan of the row text.
  // Lets the app override the gesture with authoritative knowledge of
  // what the block is showing (e.g. a tool call's recorded file path,
  // an edit-diff block's target). Return true to claim the gesture —
  // the screen then skips its own path-token scan and the word-snap
  // copy fallback. Return false to fall through to the default
  // double-click handling. Coordinates match onBlockClick.
  onBlockDoubleClick?: (key: string, rowOffset: number) => boolean;
  // Invoked for every mouse button-press, drag-motion, and button-release
  // event while mouse capture is on. Wheel events are NOT routed here —
  // they continue to drive scrollback internally. Coordinates are 1-based
  // (terminal-kit native: top-left is x=1, y=1) and refer to the
  // physical terminal cell under the pointer. The caller maps that
  // cell back to scrollback content via the screen's row→line mapping
  // (see keyAtRow / mouseCellToScrollback).
  //
  // Press/release for buttons other than the left button are still
  // reported (kind "press" / "release" with button !== "left") so a
  // future right-click menu can hook in without further plumbing.
  // When mouse capture is off (selective wheel-only mode or no mouse),
  // this callback is never invoked.
  onMouse?: (ev: MouseEvent) => void;
  // Invoked when the pointer moves over a keyed block. Returning a non-null
  // Set of block keys widens the hover-highlight to every row whose
  // blockKey is in that Set (instead of just the row's own block). Used to
  // light up a whole thought run together — clicking any member expands
  // them all, so hover should preview that grouping. Return null/undefined
  // to use the default per-block scope.
  onHoverRun?: (key: string) => Set<string> | null | undefined;
  // Invoked once with a keyed-block key the first time any of its rows are
  // painted in the visible window, for blocks registered via
  // notifyWhenVisible(). Used to lazily load deferred content (e.g. fetch a
  // diff body only when it scrolls into view).
  onBlockVisible?: (key: string) => void;
  // Minimum ms between full-screen repaints driven by content events.
  // 0 disables throttling. User-action repaints (scroll, modal, resize,
  // /clear, ^L) bypass this regardless. Default 1000 (1 Hz).
  repaintThrottleMs?: number;
  // Cap on logical lines retained in scrollback. Oldest are dropped on
  // overflow. Default 10_000.
  maxScrollbackLines?: number;
  // When true, grabInput captures mouse events so the wheel can drive
  // scrollback. When false (default), the wheel does nothing but text
  // selection works with plain click-drag (no shift required).
  mouse?: boolean;
  // Whether the in-app text-selection feature is enabled. Independent
  // of `mouse` so users with conflicting muscle memory can opt out
  // even when mouse capture is on. When undefined, defaults to the
  // resolved value of `mouse` (selection follows capture). Downstream
  // interaction code reads this via isInAppSelectionEnabled().
  inAppSelection?: boolean;
  // Which selection buffer(s) an in-app copy targets ("primary" |
  // "clipboard" | "both"). Defaults to "both". Passed straight to
  // writeClipboard when a selection is finalized.
  selectionClipboard?: ClipboardTarget;
  // Optional command (string or pre-split argv, with %f / %n
  // placeholders) spawned when a double-click lands on a token that
  // names an existing file. See HydraConfig.tui.openFileCommand.
  // Undefined disables the gesture so the normal word-snap copy path
  // runs unchanged.
  openFileCommand?: string | readonly string[];
  // When true (default), emit OSC 9;4 progress-bar codes so the host
  // terminal can render an indeterminate busy indicator while a turn is
  // running (taskbar pulse on Windows Terminal, dock badge on Konsole,
  // etc.). When false, no progress sequences are written.
  progressIndicator?: boolean;
  // View-only mode. When true: the composer pane is suppressed (all
  // prompt rows return to scrollback), the OSC window title carries
  // " [VIEW ONLY]", and a "🔒 read-only" badge appears in the banner.
  // No keystroke can produce a prompt because the app's onKey gates
  // dispatcher.feed; the screen-side suppression is what removes the
  // visual affordance and frees the vertical real-estate.
  readonly?: boolean;
  // Invoked when the user presses Ctrl+Z (raw 0x1a byte) while not in a
  // bracketed paste. The Screen does not handle suspend itself — the
  // host (app.ts) is responsible for calling screen.stop(), raising
  // SIGTSTP, and screen.start()'ing on SIGCONT. Optional: when unset,
  // ^Z is silently dropped (it would otherwise be passed through as
  // a Ctrl+Z keystroke, which no current binding consumes).
  onSuspend?: () => void;
}

interface BannerState {
  status: string;
  currentMode: string | undefined;
  hint: string;
  queued: number;
  // Elapsed time the current turn has been running, in milliseconds.
  // Surfaced as "running · 1m 30s" in the banner so the user has
  // continuous feedback that the agent is alive even when it falls
  // silent mid-thought.
  elapsedMs?: number;
  // True when the turn is busy but no session/update has arrived for
  // longer than the stall threshold (see STALL_THRESHOLD_MS in app.ts).
  // When set alongside status="busy", the dot+label paints red and the
  // word "stalled" replaces "busy" so a hung upstream is visible at a
  // glance rather than hiding behind a quietly-ticking elapsed clock.
  stalled?: boolean;
}

interface SessionbarState {
  agent: string;
  cwd: string;
  sessionId: string;
  title?: string;
  usage?: UsageState;
  // Last known model id, rendered as "<agent>(<model>)" in the bar. Kept
  // separate from `agent` so the TUI can update it independently when
  // current_model_update arrives mid-session.
  model?: string;
}

export interface UsageState {
  used?: number;
  size?: number;
  costAmount?: number;
  costCurrency?: string;
}

export interface PermissionPromptSpec {
  title: string;
  // Single-line summary of what's being accessed (path / command / url).
  // Empty when the agent gave nothing beyond the title.
  detail?: string;
  options: Array<{ label: string }>;
  selectedIndex: number;
}

// Interactive session-options modal opened by ^O. Each row shows its
// current value (e.g. on/off, edit/diff, amend/enqueue); the app cycles
// one in place and re-renders without closing, so several can be changed
// in one visit. Dismissed by passing null to setOptionsPrompt.
export interface OptionsPromptSpec {
  title: string;
  options: Array<{ label: string; value: string }>;
  selectedIndex: number;
  // Bottom-line hint shown under the rows. When omitted, the renderer uses
  // the legacy hint tailored to the ^O session-options modal — the modal
  // this widget was originally built for. The ^Q questions modal sets its
  // own hint with the dispatch / save / discard keys.
  hint?: string;
}

// Tiny modal used by the TUI to confirm a destructive exit (e.g. "agent
// is still working — interrupt before quitting?"). Two-line layout:
// the question, then a one-line hint listing the accepted keys.
export interface ConfirmPromptSpec {
  question: string;
  hint: string;
}

// Modal shown once per attach when the daemon's shouldCompact says
// yes AND this attach is what woke the session. Same arrow/enter +
// hotkey UX as the permission prompt so muscle memory transfers.
// Dismissed by Enter on the selected option, y/n quick-pick, or Esc.
export interface CompactionPromptSpec {
  // E.g. "This session has ~85K tokens of history above the compaction watermark."
  message: string;
  options: Array<{ label: string; key: "y" | "n" }>;
  selectedIndex: number;
}

// Modal that displays a hotkey cheatsheet. `entries` is an ordered list
// of [keys, description] pairs (or null for a visual separator) and is
// rendered as a left-padded two-column block above the prompt area.
// The caller dismisses by passing null to setHelpPrompt.
export interface HelpPromptSpec {
  title: string;
  entries: ReadonlyArray<readonly [string, string] | null>;
  hint: string;
}

// Mouse event surfaced to the app via ScreenOptions.onMouse. Coordinates
// are 1-based (top-left cell is x=1, y=1) and refer to the physical
// terminal cell under the pointer. `kind` is normalized:
//   - "press"   button just went down
//   - "move"    pointer moved to a new cell. Fires for both
//               drag-motion (button held) and plain hover (no button)
//               — we grab in ?1003 any-motion mode so the screen can
//               drive OS pointer-shape on hover.
//   - "release" button just came up
// `button` is the button involved ("left" | "middle" | "right" | "other").
// For "move" events, `button` reflects the button being held during the
// drag as reported by the terminal. `name` is the raw terminal-kit
// event name in case the caller wants to disambiguate further.
export interface MouseEvent {
  kind: "press" | "move" | "release";
  button: "left" | "middle" | "right" | "other";
  // 1-based terminal cell (top-left is {x:1, y:1}).
  x: number;
  y: number;
  // Raw terminal-kit event name, e.g. "MOUSE_LEFT_BUTTON_PRESSED",
  // "MOUSE_DRAG", "MOUSE_LEFT_BUTTON_RELEASED".
  name: string;
}

export interface CompletionItem {
  name: string;
  description?: string;
}

const SESSIONBAR_ROWS = 1;
// Banner row was its own line above the sessionbar; its contents
// (status, queued/scroll indicators, hint chunks, transient
// search/compaction toast) have all folded into the prompt-above
// separator. Kept as a named 0 so all the bottom-chrome math expressions
// still read coherently without an arithmetic rewrite.
const BANNER_ROWS = 0;
const SEPARATOR_ROWS = 1;
// One-row separator below the prompt and above the sessionbar. Holds the
// hint chunks (⇧⇥ mode · ⌃P pick · ⌃G guide · ⌃D detach) and the transient
// right-slot (search / compaction / synthesis toast). The top separator
// (above the prompt) carries status + sid + usage instead. Named
// BANNER_SEPARATOR_ROWS for backward compatibility with all the bottom-
// chrome row math expressions that already account for it.
const BANNER_SEPARATOR_ROWS = 1;
export const MAX_PROMPT_ROWS = 8;
const MAX_QUEUED_ROWS = 5;
const MAX_PERMISSION_ROWS = 12;
const MAX_OPTIONS_ROWS = 12;
const MAX_HELP_ROWS = 30;
const MAX_COMPLETION_ROWS = 6;
const MAX_CHIP_ROWS = 4;
const CONFIRM_PROMPT_ROWS = 2;
// message line + options line + hint line
// Compaction prompt is dynamic — see compactionRows() — but at least
// 5 (title + question + 2 options + hint). Kept here only for tests
// that need a baseline guard.
const COMPACTION_PROMPT_MIN_ROWS = 5;
void COMPACTION_PROMPT_MIN_ROWS;
// Default minimum interval between content-driven repaints (agent text
// chunks, tool/plan upserts, elapsed ticks). Without this we full-redraw
// 10–50× per second during streaming, which is wasteful and made flicker
// more visible. User-action repaints (scrolling, modal open/close, /clear)
// bypass the throttle. Override via `tui.repaintThrottleMs` in config.
const DEFAULT_CONTENT_REPAINT_THROTTLE_MS = 1000;
// Default cap on logical lines retained in scrollback. Override via
// `tui.maxScrollbackLines` in config.
const DEFAULT_MAX_SCROLLBACK_LINES = 10_000;

// Recognise a chunk that is just a bare URL (optionally with a trailing
// newline). Some terminals deliver link drag-drops as raw keystrokes
// rather than bracketed paste; without this, each char would be typed
// and a trailing \n would submit the prompt before the URL was visible.
const BARE_URL_RE = /^(https?|ftp):\/\/\S+$/;
function matchBareUrl(text: string): string | null {
  const stripped = text.replace(/\r\n?$|\n$/, "");
  return BARE_URL_RE.test(stripped) ? stripped : null;
}

// Map a terminal-kit mouse-event name to its MouseEvent.button label.
// Drag/release-without-button (MOUSE_BUTTON_RELEASED, MOUSE_DRAG) default
// to "left" because that's overwhelmingly the held button — terminals
// report drag with the original button encoded in the SGR byte but
// terminal-kit collapses unknown buttons; refining this would require
// parsing the raw sequence ourselves.
function mouseButtonFromEventName(name: string): MouseEvent["button"] {
  if (name.includes("LEFT")) {
    return "left";
  }
  if (name.includes("RIGHT")) {
    return "right";
  }
  if (name.includes("MIDDLE")) {
    return "middle";
  }
  if (name === "MOUSE_DRAG" || name === "MOUSE_BUTTON_RELEASED") {
    return "left";
  }
  return "other";
}

export class Screen {
  private term: Terminal;
  private dispatcher: InputDispatcher;
  private onKey: (events: KeyEvent[]) => void;
  private onBlockClick: ((key: string, rowOffset: number) => void) | undefined;
  private onBlockDoubleClick:
    | ((key: string, rowOffset: number) => boolean)
    | undefined;
  private onMouse: ((ev: MouseEvent) => void) | undefined;
  private onHoverRun:
    | ((key: string) => Set<string> | null | undefined)
    | undefined;
  private onBlockVisible: ((key: string) => void) | undefined;
  private onSuspend: (() => void) | undefined;
  // Keyed blocks awaiting a one-shot "became visible" notification.
  private pendingVisibleKeys = new Set<string>();
  private lines: FormattedLine[] = [];
  // Tracks contiguous blocks of lines that callers may want to mutate in
  // place (e.g. tool-call rows that update from "pending" to "completed",
  // or the agent's plan as entries get checked off). Each block is keyed
  // by an opaque caller-chosen string and remembers its start index and
  // current line count so subsequent upserts splice in-place — adjusting
  // the starts of any later keyed blocks if the size changes.
  private keyedBlocks = new Map<string, { start: number; count: number }>();
  // When set, the named block is kept at the bottom of scrollback: any
  // subsequent append/upsert that lands new content after it triggers a
  // float that slides the sticky block back to the end. Used so the
  // agent's plan stays anchored at the bottom of the current turn even
  // as tool calls / agent text accumulate below it. Surviving past
  // `clearKey(stickyBottomKey)` is a no-op since the block is gone.
  private stickyBottomKey: string | null = null;
  private streamingActive = false;
  // When true, lines with bodyStyle="thought" are skipped at draw time
  // (they remain in `this.lines` so toggling back on reveals them again).
  // Set via setHideThoughts; the app drives this from the ^T hotkey and
  // the tui.showThoughts config.
  private hideThoughts = false;
  private lastPromptRows = 0;
  private queuedTexts: string[] = [];
  private lastQueueEditingIndex = -1;
  // Attachments on the current draft, pushed by the app whenever the
  // dispatcher mutates. The chip zone (drawAttachmentChipZone) renders
  // one row per attachment plus, in iTerm2-capable terminals, an inline
  // thumbnail. Capped at MAX_CHIP_ROWS in the visible zone — additional
  // chips collapse into an overflow row.
  private attachments: Attachment[] = [];
  private repaintPaused = 0;
  private repaintPending = false;
  private contentRepaintThrottleMs: number;
  private readonly painter: RowPainter;
  private readonly scheduler: RepaintScheduler;
  private maxScrollbackLines: number;
  // Wrap memoization: each FormattedLine that lands in this.lines gets a
  // monotonic id assigned via trackLine(); wrapCache holds the pre-wrapped
  // FormattedLine[] for that id at wrapCacheWidth. Width changes flush the
  // whole cache; in-place body mutation (streaming) and splices invalidate
  // affected ids. Result: steady-state repaints only wrap newly-appended
  // lines, not the entire history.
  private nextLineId = 1;
  private lineIds = new WeakMap<FormattedLine, number>();
  private wrapCache = new Map<number, FormattedLine[]>();
  private wrapCacheWidth = 0;
  // For each wrapped chunk (produced by wrapOne), record the source
  // line's id and the col offset where this chunk starts in the source
  // body. Used by the active-match highlight in scrollback search to
  // map currentMatch (sourceLineId, sourceCol) onto the wrapped chunk
  // that owns it without scanning the wrap cache.
  private wrapOrigin = new WeakMap<
    FormattedLine,
    { sourceLineId: number; sourceColOffset: number }
  >();
  // Per-row signature cache + repaint throttle state live in the
  // shared RowPainter / RepaintScheduler (src/tui/screen/painter.ts);
  // see paintRow() / scheduleRepaint() below for the local delegates.
  private permissionPrompt: PermissionPromptSpec | null = null;
  private optionsPrompt: OptionsPromptSpec | null = null;
  private confirmPrompt: ConfirmPromptSpec | null = null;
  private compactionPrompt: CompactionPromptSpec | null = null;
  private helpPrompt: HelpPromptSpec | null = null;
  private completions: CompletionItem[] = [];
  // Scrollback offset: 0 = pinned to bottom (live), N = N wrapped lines
  // above the bottom. Mouse wheel and PgUp/PgDn adjust this; new content
  // pushes the view down naturally when at 0.
  private scrollOffset = 0;
  // Scrollback search state. While active the prompt area is taken over
  // by a single-row search input (drawSearchPrompt) and matches in the
  // visible scrollback are rendered with a background-highlight style.
  // baselineScroll captures the scrollOffset at the moment the user
  // engaged search so cancel can restore the view.
  private scrollbackSearch: {
    term: string;
    matchIndex: number;
    matches: Array<{ lineIdx: number; col: number }>;
    baselineScroll: number;
  } | null = null;
  // Lowercased search term used by drawScrollback to drive per-row
  // highlight rendering. Mirrors scrollbackSearch?.term but cached as a
  // separate field so the per-row signature can include it cheaply.
  private scrollbackHighlight: string | null = null;
  // Source-anchored selection region. Stored in normalized form
  // (start <= end by sourceLineId, then by offset) so renderers don't
  // re-normalize on every row. Selection points are {sourceLineId,
  // offset} (T5 model) — stable across scroll and re-wrap, so the
  // highlight stays attached to the same characters as the viewport
  // moves. Cleared only by clearSelection(); scroll/resize do not
  // disturb it.
  private selection: {
    startLineId: number;
    startOffset: number;
    endLineId: number;
    endOffset: number;
  } | null = null;
  // Per-paint cache mapping each selected source line's id to the
  // selected [start,end) offset window within that line (full body for
  // interior lines) plus whether the selection continues past it.
  // Rebuilt at the top of drawScrollback so selectionRangeForChunk is an
  // O(1) lookup that never orders by raw line id — ids are NOT monotonic
  // with display order (upsertLines reassigns higher ids to re-rendered
  // streaming blocks that keep their original, higher-up slot).
  private selectionRenderBounds:
    | Map<number, { start: number; end: number; toEnd: boolean }>
    | null = null;
   // Right-side banner slot. Four sources, in priority order:
   //   1. Active scrollback search term (auto, from this.scrollbackSearch)
   //   2. External search indicator pushed by the app while prompt-
   //      history reverse-search is active (gives that mode visible
   //      feedback for its otherwise-hidden query)
   //   3. Transient notification set via notify(), auto-cleared after
   //      durationMs
   //   4. Persistent compaction status indicator (set via
   //      setCompactionIndicator); stays until explicitly cleared or
   //      replaced by a transient notify() call that takes priority.
   private bannerNotification: string | null = null;
   private bannerNotificationTimer: NodeJS.Timeout | null = null;
   private bannerSearchIndicator: string | null = null;
   private compactionIndicator: string | null = null;
    private synthesisIndicator: string | null = null;
    // Bottom-of-screen "btw" overlay pane. Closed by default; when open,
    // reserves `btwOverlayHeight` rows from the bottom (1 separator + 1
  // header + height-2 content). The main scrollback area shrinks to make
  // room. Rendered purely with termkit helpers — no ACP knowledge.
  private btwOverlayOpen = false;
  // Maximum height the overlay can grow to. Actual height auto-sizes to
  // 1 (header) + content rows. When content is empty AND overlay is open,
  // the overlay reserves zero rows and the prompt-above separator carries
  // the btw label instead (see drawPromptSeparator).
  private btwOverlayMaxHeight = 12;
  private btwOverlayLines: FormattedLine[] = [];
  private btwOverlayLabel = "";
  private btwOverlayStatus: "busy" | "done" | "cancelled" | "errored" = "busy";
  // Session id of the forked btw fork and a running usage snapshot,
  // rendered into the overlay header alongside the [<label>]. Reset on
  // open/close so a previous fork's numbers don't bleed into the next
  // /btw invocation. Kept here rather than recomputed from the buffer
  // because usage_update events carry no visible representation and
  // would otherwise be discarded.
  private btwOverlaySessionId: string | null = null;
  private btwOverlayUsage: UsageState | undefined = undefined;
  // Which pane is the ESC target. Drives the visual focus indicator on the
  // overlay header and, when "btw", dims the main input prompt to signal
  // that ESC will act on the overlay (T7). Typing always goes to the main
  // buffer regardless of focus.
  private focusedPane: "main" | "btw" = "main";

  private banner: BannerState = {
    status: "ready",
    currentMode: undefined,
    hint: "⇧⇥ mode · ⌃P pick · ⌃G guide · ⌃D detach",
    queued: 0,
  };
  // Click hit-regions for the banner hint chunks ("⇧⇥ mode", "⌃P pick",
  // "⌃G guide"). Recomputed on every drawBanner so layout shifts (status
  // changes, queued count, scrollOffset) keep the regions accurate.
  // Each entry is the inclusive 1-based column range on `row`. `null`
  // when the banner hasn't been painted yet.
  private bannerHits: {
    row: number;
    mode: [number, number] | null;
    pick: [number, number] | null;
    guide: [number, number] | null;
    detach: [number, number] | null;
  } | null = null;
  private hoveredBannerHit: "mode" | "pick" | "guide" | "detach" | null = null;
  private hoveredBlockKey: string | null = null;
  private hoveredSubKey: string | null = null;
  // Expanded set of block keys that should all paint hovered when the
  // pointer is on any one of them. Populated by onHoverRun (e.g. a
  // contiguous thought run). null = scope to just hoveredBlockKey.
  private hoveredRunKeys: Set<string> | null = null;
  private sessionbar: SessionbarState = { agent: "?", cwd: "?", sessionId: "?" };
  private lastWindowTitle: string | null = null;
  private resizeHandler: () => void;
  private keyHandler: (name: string, _matches: string[], data: { isCharacter?: boolean }) => void;
  private mouseHandler: (name: string, data: unknown) => void;
  // Cell of the most recent left-button press, used to qualify a block
  // click: we only toggle a block when the release lands on the same cell
  // (a clean click), so a press-drag-release (text selection, even within
  // one block) never toggles. Cleared on release.
  private pressCell: { x: number; y: number } | null = null;
  // Source-anchored origin of the active drag gesture. Set on left-button
  // press when in-app selection is on, used as the anchor passed to
  // setSelection on every subsequent drag motion. Cleared on release.
  private selectionAnchor: { sourceLineId: number; offset: number } | null = null;
  // True iff a drag motion arrived between press and release. Drives
  // the finalize-vs-dismiss decision: dragStarted → copy; otherwise a
  // plain click clears any prior selection.
  private selectionDragStarted = false;
  // Set when a press is recognised as the second click of a double-click
  // and the anchor lands on a word character. Causes release to finalize
  // (copy) without requiring a drag, and suppresses the block-click
  // toggle that would otherwise fire for a press+release on the same cell.
  private doubleClickPending = false;
  // Timestamp + cell of the most recent left-button release, used to
  // decide whether the next press qualifies as a double-click.
  private lastLeftClick: { x: number; y: number; t: number } | null = null;
  // Single-click block toggles are deferred by DOUBLE_CLICK_MAX_MS so a
  // follow-up click on the same cell can override the gesture (e.g. open
  // a file path under the cursor) without first toggling the block and
  // then immediately untoggling it. The timer fires the toggle if no
  // double-click arrives in time; handleSelectionPress cancels it when
  // it does. Null when no toggle is pending.
  private pendingBlockClick:
    | { timer: ReturnType<typeof setTimeout>; key: string; rowOffset: number }
    | null = null;
  private started = false;
  // Bracketed-paste-mode state. terminal-kit doesn't natively support
  // bracketed paste, so on start() we enable the mode in the terminal
  // (\x1b[?2004h) and wrap the stdin data listener with our own that
  // splits out paste content (delimited by \x1b[200~ … \x1b[201~) from
  // regular keystrokes. Paste content gets dispatched as a single
  // "paste" KeyEvent so input.ts can insert newlines into the buffer
  // instead of treating each \n as an Enter that submits the prompt.
  private terminalKitStdinHandler: ((chunk: Buffer) => void) | null = null;
  private pasteActive = false;
  // True while the terminal window has focus. Tracked via DECSET 1004
  // focus reporting; mouse button events are dropped when false so a
  // click that's only meant to focus the window doesn't accidentally
  // trigger an action. Defaults to true because terminals that don't
  // support 1004 never emit FOCUS_IN/OUT — we'd lock ourselves out
  // otherwise. Wheel and motion still pass through (natural scroll
  // works even on an unfocused window in most desktops).
  private terminalFocused = true;
  // Wall-clock ms of the most recent FOCUS_IN. The terminal typically
  // emits FOCUS_IN BEFORE the click that caused it, so simply checking
  // terminalFocused at press time is too late: the press already looks
  // focused. We instead drop every press within FOCUS_GRACE_MS of a
  // FOCUS_IN, which discards the focusing click without affecting
  // subsequent intentional clicks. 200ms is comfortably above the wire
  // latency between the two events (sub-ms in practice) and well below
  // any deliberate user double-click cadence.
  private lastFocusInAt = 0;
  private pasteBuffer = "";
  private rawStdinHandler: (chunk: Buffer) => void;
  private mouseEnabled: boolean;
  // Last OS pointer-shape we asked the terminal to render via OSC 22.
  // Used to debounce writes so we only emit on transitions (entering
  // or leaving a clickable row) rather than every cell-crossing motion
  // event. Terminals that ignore OSC 22 silently swallow the write.
  private currentPointerShape: "default" | "pointer" = "default";
  // In-app selection feature flag. Mirrors the resolved config value
  // (see resolveInAppSelection in core/config.ts). Independent of
  // mouseEnabled; flipping mouse capture does NOT auto-flip this.
  private inAppSelectionEnabled: boolean;
  // Which selection buffer(s) a finalized copy targets. See ScreenOptions.
  private selectionClipboard: ClipboardTarget;
  private openFileCommand: readonly string[] | null;
  private progressIndicatorEnabled: boolean;
  // Listeners registered on process via installEmergencyCleanup so an
  // ungraceful exit (SIGTERM, SIGHUP, uncaughtException) still restores
  // mouse capture / alt-screen / kitty stack / cursor visibility — the
  // graceful stop() path isn't guaranteed to run in those cases and
  // would otherwise leave the host terminal wedged.
  private emergencyCleanupInstalled = false;
  private onProcessExit: (() => void) | null = null;
  private onProcessSignal: ((sig: NodeJS.Signals) => void) | null = null;
  private onProcessUncaught: ((err: Error) => void) | null = null;
  // Selective Mouse Reporting (MasterBandit `CSI = w` / `CSI ? w`). Probed
  // on start() when mouseEnabled is false — terminals that support it let
  // us receive wheel-up/down without claiming the mouse for clicks (so the
  // host terminal still does native text selection on click+drag).
  private selectiveMouseSupported = false;
  private selectiveMouseProbing = false;
  private selectiveMouseProbeTimer: NodeJS.Timeout | null = null;
  // Last OSC 9;4 state we wrote (3 = indeterminate, 0 = remove). Used to
  // suppress redundant writes when setBanner runs but `status` didn't
  // actually change, and to re-emit on start() if a picker round-trip
  // cleared the host terminal's indicator.
  private lastProgressState: 0 | 3 = 0;

  // View-only mode. Set once at construction. When true, promptRows()
  // returns 0 (composer collapses, scrollback expands), drawPrompt()
  // bails before computing layout, and syncWindowTitle() appends
  // "[VIEW ONLY]" so the chrome makes the mode obvious.
  private readonly: boolean;

  constructor(opts: ScreenOptions) {
    this.term = opts.term;
    this.dispatcher = opts.dispatcher;
    // Wrap the host's onKey so any keystroke (including pastes and
    // attachment drops, which arrive on the same channel) dismisses
    // the live selection before the dispatcher sees the event.
    // Spec: selection must clear on any keystroke.
    const hostOnKey = opts.onKey;
    this.onKey = (events) => {
      if (this.selection !== null && events.length > 0) {
        this.clearSelection();
      }
      hostOnKey(events);
    };
    this.onBlockClick = opts.onBlockClick;
    this.onBlockDoubleClick = opts.onBlockDoubleClick;
    this.onMouse = opts.onMouse;
    this.onHoverRun = opts.onHoverRun;
    this.onBlockVisible = opts.onBlockVisible;
    this.onSuspend = opts.onSuspend;
    this.contentRepaintThrottleMs =
      opts.repaintThrottleMs ?? DEFAULT_CONTENT_REPAINT_THROTTLE_MS;
    this.painter = new RowPainter(this.term);
    this.scheduler = new RepaintScheduler({
      isStarted: () => this.started,
      isRepaintPaused: () => this.repaintPaused > 0,
      markRepaintPending: () => {
        this.repaintPending = true;
      },
      throttleMs: () => this.contentRepaintThrottleMs,
      doRepaint: () => this.repaint(),
    });
    this.maxScrollbackLines =
      opts.maxScrollbackLines ?? DEFAULT_MAX_SCROLLBACK_LINES;
    this.mouseEnabled = opts.mouse ?? false;
    this.inAppSelectionEnabled = opts.inAppSelection ?? this.mouseEnabled;
    this.selectionClipboard = opts.selectionClipboard ?? "both";
    // Normalize the openFileCommand union to a non-empty argv (or null
    // when disabled). String form is shell-style split on whitespace —
    // good enough for editor invocations without quoted spaces; users
    // who need a literal space in an arg pass the array form instead.
    const ofc = opts.openFileCommand;
    const ofcArgv =
      typeof ofc === "string"
        ? ofc.split(/\s+/).filter((s) => s.length > 0)
        : ofc;
    this.openFileCommand = ofcArgv && ofcArgv.length > 0 ? ofcArgv : null;
    this.progressIndicatorEnabled = opts.progressIndicator ?? true;
    this.readonly = opts.readonly ?? false;
    this.resizeHandler = () => this.repaint();
    this.keyHandler = (name, _matches, data) => this.handleKey(name, data);
    this.mouseHandler = (name, data) => this.handleMouse(name, data);
    this.rawStdinHandler = (chunk) => this.handleRawStdin(chunk);
  }

  // Starts (or resumes) the screen's painting + input pipeline. When
  // called fresh from the process entrypoint (no opts), enters the
  // alternate screen buffer and saves the host shell's cursor for
  // later restore. When resuming from a picker that ran with
  // `keepFullscreen: true` (`skipFullscreen: true`), we don't toggle
  // fullscreen — re-emitting CSI ? 1049 h while already in alt would
  // (a) clear the alt buffer, briefly showing black before our repaint
  // lands, and (b) overwrite the cursor save with the picker's last
  // cursor position, which then becomes wrong on final exit.
  start(opts: { skipFullscreen?: boolean } = {}): void {
    if (this.started) {
      return;
    }
    this.started = true;
    if (!opts.skipFullscreen) {
      this.term.fullscreen(true);
    }
    // Entering the alternate screen buffer gives us a blank slate. Drop
    // the per-row sig cache (and frame-size / window-title shadows) so the
    // upcoming repaint actually emits every row — without this, a
    // stop/start round-trip (e.g. the session picker) leaves paintRow
    // short-circuiting against signatures from the previous run and the
    // screen stays blank until something forces a fullRedraw.
    this.painter.clearCache();
    this.lastWindowTitle = null;
    // Disable auto-wrap (DECAWM). Our row painter assumes each row starts
    // with a moveTo + eraseLineAfter, so any character that overflows the
    // right margin should be clipped, not wrapped onto the next physical
    // row. Without this, a wide-unicode body whose visible width exceeds
    // our wrap budget would bleed onto the row below, and paintRow's
    // sig-based skip can leave that bleed uncleared indefinitely.
    process.stdout.write(AUTOWRAP_OFF);
    // mouse: "motion" enables wheel + button-press/release + drag
    // motion AND hover-without-button (xterm DEC mode ?1003). The
    // motion stream lets handleMouse update the OS pointer-shape
    // (OSC 22) as the user moves over clickable rows, giving a
    // browser-style "hand" affordance on terminals that honor it
    // (kitty, wezterm, ghostty, foot, xterm). ?1003 only fires when
    // the pointer crosses a cell boundary, so the wire cost is bounded
    // by mouse-velocity — fine on modern terminals.
    // Skip mouse capture when disabled via config so click-drag text
    // selection works without shift; the trade-off is wheel scrollback.
    if (this.mouseEnabled) {
      this.term.grabInput({ mouse: "motion" });
    } else {
      this.term.grabInput(true);
    }
    this.term.hideCursor(false);
    this.term.on("key", this.keyHandler);
    if (this.mouseEnabled) {
      this.term.on("mouse", this.mouseHandler);
    }
    this.term.on("resize", this.resizeHandler);
    this.installBracketedPaste();
    this.installSelectiveMouseReporting();
    this.installEmergencyCleanup();
    // Re-emit the progress indicator on entry. The OSC 9;4 state is
    // owned by the host terminal, not the alternate screen buffer, so
    // strictly we don't need to re-emit on a clean fullscreen swap —
    // but a picker round-trip cleared lastProgressState via stop(), so
    // forcing a fresh write when status is still "busy" gets the
    // taskbar pulsing again.
    this.lastProgressState = 0;
    this.writeProgressIndicator(this.banner.status === "busy" ? 3 : 0);
    this.repaint();
  }

  // Stops the screen's painting + input pipeline. When called from the
  // process-exit path (no opts), also leaves the alternate screen buffer
  // and re-enables auto-wrap so the host shell behaves normally. When
  // entering the session picker (`keepFullscreen: true`), we skip the
  // alt-screen toggle so the user doesn't see a frame of the host
  // shell's main-buffer content flash between the live session
  // tearing down and the picker painting from row 1 — the picker's
  // moveTo(1,1) + eraseDisplayBelow simply repaints over the same alt
  // screen buffer the live session was using.
  stop(opts: { keepFullscreen?: boolean } = {}): void {
    if (!this.started) {
      return;
    }
    if (this.bannerNotificationTimer) {
      clearTimeout(this.bannerNotificationTimer);
      this.bannerNotificationTimer = null;
    }
    // A throttled repaint queued just before stop would otherwise fire
    // AFTER we leave the alternate screen and write raw cursor-position
    // escapes into the host shell, scrambling it.
    this.scheduler.cancel();
    this.cancelPendingBlockClick();
    this.uninstallSelectiveMouseReporting();
    this.uninstallBracketedPaste();
    this.uninstallEmergencyCleanup();
    this.term.off("key", this.keyHandler);
    if (this.mouseEnabled) {
      this.term.off("mouse", this.mouseHandler);
    }
    this.term.off("resize", this.resizeHandler);
    this.term.grabInput(false);
    this.term.hideCursor(false);
    // Reset OS pointer-shape so the host shell doesn't inherit our
    // hand-pointer override. Harmless on terminals that don't support
    // OSC 22.
    if (this.currentPointerShape !== "default") {
      process.stdout.write(POINTER_SHAPE_DEFAULT);
      this.currentPointerShape = "default";
    }
    if (!opts.keepFullscreen) {
      // Restore auto-wrap so the host shell behaves normally after exit.
      // Only needed on the way out — the picker doesn't re-enable it,
      // so leaving auto-wrap disabled across the picker round-trip is
      // fine (start() will re-disable on resume anyway).
      process.stdout.write(AUTOWRAP_ON);
    }
    // Clear any progress indicator so the host terminal's taskbar /
    // dock badge doesn't keep pulsing after we exit (or while a picker
    // is up). The host owns this state independently of the alternate
    // screen, so it survives fullscreen(false) without explicit clear.
    this.writeProgressIndicator(0);
    // Flip `started` only after the final guarded writes (progress
    // indicator clear) so they aren't gated out. Anything that runs
    // after this point — late timer ticks, stray repaint callbacks —
    // is correctly rejected by paintRow/placeCursor/repaint.
    this.started = false;
    if (!opts.keepFullscreen) {
      // Converge the graceful exit on the same full reset the crash /
      // signal path uses. terminal-kit's grabInput(false) above leaves
      // SGR mouse mode (\x1b[?1006) enabled — it never disables it — so
      // a clean quit with mouse capture on would leave the host shell
      // subtly wedged until a manual `reset`. Running the shared
      // sequence here closes that gap and keeps both exit paths
      // identical. Sequences are idempotent, so the redundant
      // ?1049l/?7h/?25h are harmless; fullscreen(false) still runs after
      // to keep terminal-kit's own internal state in sync.
      emergencyTerminalReset();
      this.term.fullscreen(false);
      this.term("\n");
    }
  }

  // Enables bracketed paste mode + modifyOtherKeys on the terminal and
  // rewires stdin so we see the \x1b[200~/\x1b[201~ paste markers and
  // CSI-u modified-key sequences (Shift+Enter etc.) BEFORE terminal-kit's
  // key parser. Non-special data is forwarded to terminal-kit unchanged.
  private installBracketedPaste(): void {
    // Enable bracketed paste — terminals that don't support it ignore
    // the sequence harmlessly.
    process.stdout.write(BRACKETED_PASTE_ON);
    // Enable two key-reporting protocols so modified Enter arrives as
    // a CSI-u sequence (Shift+Enter = \x1b[13;2u). Different terminals
    // support different things:
    //   xterm modifyOtherKeys=2 + formatOtherKeys=1 — xterm-family
    //     (xterm, foot, gnome-terminal, etc.). Level 2 reports
    //     modifiers on every key (level 1 skips ones with ASCII
    //     representations like Enter). formatOtherKeys=1 picks the
    //     CSI-u format over the legacy CSI 27;… format.
    //   kitty keyboard protocol — kitty, ghostty, wezterm, alacritty,
    //     iterm2 3.5+. Single push (\x1b[>1u) enables disambiguating
    //     escape codes; Shift+Enter comes through as \x1b[13;2u.
    // Terminals that don't support either ignore the requests and
    // Shift+Enter just behaves like Enter — the right fallback. We
    // also intercept the legacy CSI 27;…~ format below in case
    // formatOtherKeys=1 is unsupported.
    process.stdout.write(MODIFY_OTHER_KEYS_ON);
    process.stdout.write(FORMAT_OTHER_KEYS_ON);
    process.stdout.write(KITTY_KBD_PUSH);
    process.stdout.write(FOCUS_TRACK_ON);
    const t = this.term as unknown as {
      stdin: NodeJS.ReadableStream;
      onStdin: (chunk: Buffer) => void;
    };
    if (!t.stdin || typeof t.onStdin !== "function") {
      return;
    }
    this.terminalKitStdinHandler = t.onStdin;
    t.stdin.removeListener("data", t.onStdin);
    t.stdin.on("data", this.rawStdinHandler);
  }

  private uninstallBracketedPaste(): void {
    process.stdout.write(BRACKETED_PASTE_OFF);
    process.stdout.write(MODIFY_OTHER_KEYS_OFF);
    process.stdout.write(FORMAT_OTHER_KEYS_OFF);
    process.stdout.write(KITTY_KBD_POP);
    process.stdout.write(FOCUS_TRACK_OFF);
    // Force normal cursor key mode (DECCKM off) + numeric keypad mode
    // (DECPAM off). Alt-screen enable enables application cursor mode
    // on iTerm, which makes arrows send \x1bOA. The picker uses
    // terminal-kit's osx-256color config which only recognizes \x1b[A,
    // so without this reset arrows don't reach the picker's key handler.
    process.stdout.write(DECCKM_OFF);
    process.stdout.write(DECPAM_OFF);
    const t = this.term as unknown as {
      stdin: NodeJS.ReadableStream;
    };
    if (!t.stdin || this.terminalKitStdinHandler === null) {
      return;
    }
    t.stdin.removeListener("data", this.rawStdinHandler);
    t.stdin.on("data", this.terminalKitStdinHandler);
    this.terminalKitStdinHandler = null;
    this.pasteActive = false;
    this.pasteBuffer = "";
  }

  // Probe for MasterBandit's Selective Mouse Reporting protocol. Sent
  // unconditionally on terminals that don't recognise it (silently
  // ignored). A supporting terminal replies with `\x1b[?<b>;<e> w` —
  // matched in handleRawStdin, which then enables wheel-only reporting.
  // Skipped when mouseEnabled is true: full mouse capture is already on
  // via terminal-kit and selective would just be dormant per spec.
  private installSelectiveMouseReporting(): void {
    if (this.mouseEnabled || this.selectiveMouseProbing || this.selectiveMouseSupported) {
      return;
    }
    this.selectiveMouseProbing = true;
    process.stdout.write(SELECTIVE_MOUSE_PROBE);
    // 250ms is comfortably longer than any local terminal's reply
    // latency. After the window we stop accepting probe replies; a
    // late-arriving reply would be passed through as junk, but in
    // practice replies are essentially synchronous.
    this.selectiveMouseProbeTimer = setTimeout(() => {
      this.selectiveMouseProbing = false;
      this.selectiveMouseProbeTimer = null;
    }, 250);
  }

  private uninstallSelectiveMouseReporting(): void {
    if (this.selectiveMouseProbeTimer) {
      clearTimeout(this.selectiveMouseProbeTimer);
      this.selectiveMouseProbeTimer = null;
    }
    this.selectiveMouseProbing = false;
    if (this.selectiveMouseSupported) {
      process.stdout.write(SELECTIVE_MOUSE_OFF);
      this.selectiveMouseSupported = false;
    }
  }

  private installEmergencyCleanup(): void {
    if (this.emergencyCleanupInstalled) {
      return;
    }
    this.emergencyCleanupInstalled = true;
    this.onProcessExit = () => emergencyTerminalReset();
    this.onProcessSignal = (sig) => {
      emergencyTerminalReset();
      process.off(sig, this.onProcessSignal!);
      process.kill(process.pid, sig);
    };
    this.onProcessUncaught = (err) => {
      emergencyTerminalReset();
      process.stderr.write(`\nuncaught: ${err.stack ?? err.message}\n`);
      process.exit(1);
    };
    process.on("exit", this.onProcessExit);
    process.on("SIGTERM", this.onProcessSignal);
    process.on("SIGHUP", this.onProcessSignal);
    process.on("uncaughtException", this.onProcessUncaught);
  }

  private uninstallEmergencyCleanup(): void {
    if (!this.emergencyCleanupInstalled) {
      return;
    }
    this.emergencyCleanupInstalled = false;
    if (this.onProcessExit) {
      process.off("exit", this.onProcessExit);
      this.onProcessExit = null;
    }
    if (this.onProcessSignal) {
      process.off("SIGTERM", this.onProcessSignal);
      process.off("SIGHUP", this.onProcessSignal);
      this.onProcessSignal = null;
    }
    if (this.onProcessUncaught) {
      process.off("uncaughtException", this.onProcessUncaught);
      this.onProcessUncaught = null;
    }
  }

  // Strip Selective Mouse Reporting sequences from a stdin chunk and
  // dispatch them. Returns the chunk with recognised sequences removed
  // so the remaining text can flow through the existing key/paste
  // pipeline. Matches:
  //   - `\x1b[?<b>;<e> w`            probe reply (any digits, mandatory ' w' suffix)
  //   - `\x1b[<64;<col>;<row>M`      wheel-up press
  //   - `\x1b[<65;<col>;<row>M`      wheel-down press
  private consumeSelectiveMouseSequences(text: string): string {
    // Fast path: nothing to do if neither pattern can be present.
    if (!text.includes("\x1b[")) {
      return text;
    }
    // Probe reply. Only meaningful while probing — outside that window
    // we let it fall through (no-op effect on terminal-kit either way).
    if (this.selectiveMouseProbing) {
      const probeRe = /\x1b\[\?(\d+);(\d+) w/;
      const m = probeRe.exec(text);
      if (m) {
        this.selectiveMouseProbing = false;
        if (this.selectiveMouseProbeTimer) {
          clearTimeout(this.selectiveMouseProbeTimer);
          this.selectiveMouseProbeTimer = null;
        }
        this.selectiveMouseSupported = true;
        // Enable wheel-only reporting: bmask 0x18 (wheel up | wheel down),
        // emask 0x1 (press). Matches the worked example in the spec.
        process.stdout.write(SELECTIVE_MOUSE_WHEEL_ONLY);
        text = text.slice(0, m.index) + text.slice(m.index + m[0].length);
      }
    }
    if (!this.selectiveMouseSupported) {
      return text;
    }
    // Wheel reports. Loop so a single chunk carrying multiple notches
    // (rapid scroll) is fully consumed.
    const wheelRe = /\x1b\[<(64|65);\d+;\d+M/g;
    let out = "";
    let lastEnd = 0;
    let m: RegExpExecArray | null;
    while ((m = wheelRe.exec(text)) !== null) {
      out += text.slice(lastEnd, m.index);
      const code = m[1];
      if (code === "64") {
        this.scrollBy(3);
      } else {
        this.scrollBy(-3);
      }
      lastEnd = m.index + m[0].length;
    }
    out += text.slice(lastEnd);
    return out;
  }

  private handleRawStdin(chunk: Buffer): void {
    // Use 'binary' encoding so each byte maps to a single code unit —
    // important because the paste markers are byte-precise and we need
    // to slice them out cleanly. UTF-8 multibyte chars within paste
    // content are reassembled by insertText when we hand off the
    // string. (binary preserves the byte sequence; node's binary↔Buffer
    // round-trip is lossless.)
    let text = chunk.toString("binary");
    // Peel off Selective Mouse Reporting probe replies and SGR wheel
    // reports before any other parsing — the rest of the pipeline would
    // otherwise treat them as junk key data.
    text = this.consumeSelectiveMouseSequences(text);
    // Strip every focus-in / focus-out marker before any other parsing.
    // The terminal can interleave them with normal input (e.g. a click
    // that focuses the window arrives as FOCUS_IN followed by the mouse
    // report) so we update state and pass the remaining bytes through.
    if (text.includes(FOCUS_IN) || text.includes(FOCUS_OUT)) {
      while (true) {
        const inIdx = text.indexOf(FOCUS_IN);
        const outIdx = text.indexOf(FOCUS_OUT);
        const which =
          inIdx === -1 ? outIdx :
          outIdx === -1 ? inIdx :
          Math.min(inIdx, outIdx);
        if (which === -1) {
          break;
        }
        const isIn = which === inIdx;
        this.terminalFocused = isIn;
        if (isIn) {
          this.lastFocusInAt = Date.now();
        }
        text = text.slice(0, which) + text.slice(which + FOCUS_IN.length);
      }
    }
    if (text.length === 0) {
      return;
    }
    // While a paste is in progress, defer entirely to the segment
    // handler so the paste-end marker is still detected and LFs inside
    // pasted content aren't misinterpreted as Ctrl+Enter.
    if (this.pasteActive) {
      this.handleRawStdinSegment(text);
      return;
    }
    // ^Z (SUB, 0x1a) — raw mode swallowed VSUSP so the kernel never
    // sent SIGTSTP. Only treat a chunk that is *exactly* the SUB byte
    // as a suspend request, otherwise a 0x1a embedded in a paste/key
    // burst would trip it. No current binding consumes Ctrl+Z, so
    // dropping the byte when onSuspend is unset is harmless.
    if (text === "\x1a" && this.onSuspend) {
      this.onSuspend();
      return;
    }
    // Ctrl+Z under modifyOtherKeys=2 / kitty keyboard. WezTerm honors
    // both protocols (which we enable at screen.start), so ^Z arrives
    // as the escaped form instead of the bare 0x1a byte — tmux strips
    // these protocols which is why it works there. Match the same
    // "exact chunk" rule as the raw byte path so an embedded code in a
    // paste/key burst doesn't accidentally suspend.
    if (
      this.onSuspend &&
      (text === "\x1b[27;5;122~" || text === "\x1b[122;5u")
    ) {
      this.onSuspend();
      return;
    }
    // Ctrl-_ (== Ctrl-/) — byte 0x1f. Universal readline "undo" chord.
    // terminal-kit has no name for this byte, so we intercept the raw
    // chunk here and route it to ctrl-underscore. Alt+Ctrl-_ (the meta-
    // prefixed form, our redo binding) arrives as the two-byte ESC 0x1f
    // sequence — match exactly so an unrelated paste containing 0x1f
    // doesn't trip it.
    if (text === "\x1f") {
      this.onKey([{ type: "key", name: "ctrl-underscore" }]);
      return;
    }
    if (text === "\x1b\x1f" || text === "\x1b_") {
      this.onKey([{ type: "key", name: "alt-underscore" }]);
      return;
    }
    // Two families of "modified key" sequences leak through terminal-kit
    // because it doesn't parse them, and would otherwise insert literal
    // "[27;2;73~" / "[13;2u" etc. into the buffer:
    //   1. Legacy modifyOtherKeys CSI-27 form (\x1b[27;<mod>;<code>~).
    //      xterm with modifyOtherKeys=2 reports EVERY modified key this
    //      way — Shift+letter, Ctrl+letter, Shift+Enter, etc. Generalized
    //      handler in handleCsi27Stdin maps known combos to key events
    //      and injects unmapped printable+shift as text.
    //   2. Kitty keyboard protocol CSI-u form (\x1b[<code>;<mod>u).
    //      Parameterized; we match a regex and look up (codepoint,
    //      modifier).
    // Both get filtered here BEFORE terminal-kit sees them.
    if (/\x1b\[27;\d+;\d+~/.test(text)) {
      this.handleCsi27Stdin(text);
      return;
    }
    // If the chunk contains a bracketed-paste start marker, route to the
    // segment handler before the LF heuristic below — terminals like
    // wezterm deliver the whole paste (start marker + LF-separated
    // content + end marker) in a single read, and the LFs inside the
    // payload must not be interpreted as Ctrl+Enter.
    if (text.includes(PASTE_START)) {
      this.handleRawStdinSegment(text);
      return;
    }
    // Bare LF — universal fallback for terminals without modifyOtherKeys
    // / kitty protocol that still need a way to distinguish Ctrl+Enter
    // from plain Enter. But a chunk with multiple LF-separated non-empty
    // segments isn't a keypress — it's an unbracketed multi-line paste
    // (terminal didn't send \x1b[200~ markers). Treating each LF as a
    // Ctrl+Enter there would submit each line as its own prompt (and, if
    // a modal had been dismissed mid-chunk, leak the pasted text into the
    // buffer and fire a send). Route such chunks through the paste path
    // so the whole thing lands as one text insert with embedded newlines.
    if (text.includes("\x0a")) {
      const parts = text.split("\x0a");
      const nonEmpty = parts.filter((p) => p.length > 0).length;
      if (nonEmpty > 1) {
        this.onKey([{ type: "paste", text: text.replace(/\r/g, "") }]);
        return;
      }
      for (let i = 0; i < parts.length; i++) {
        if (parts[i]!.length > 0) {
          this.handleRawStdin(Buffer.from(parts[i]!, "binary"));
        }
        if (i < parts.length - 1) {
          this.onKey([{ type: "key", name: "ctrl-enter" }]);
        }
      }
      return;
    }
    if (text.includes("\x1b[") && /\x1b\[\d+(?:;\d+)?u/.test(text)) {
      this.handleCsiUStdin(text);
      return;
    }
    this.handleRawStdinSegment(text);
  }

  // Walk `text` extracting every legacy modifyOtherKeys CSI-27 sequence
  // (\x1b[27;<mod>;<code>~). Each match is dispatched through
  // mapCsiUToKeyName; unmapped printable codes with no modifier or
  // shift are injected as text (Shift+I -> "I"), so xterm's
  // modifyOtherKeys=2 echo doesn't leak escape sequences into the
  // prompt. Other unmapped combos (Ctrl+symbol etc.) are dropped.
  private handleCsi27Stdin(text: string): void {
    const csi27 = /\x1b\[27;(\d+);(\d+)~/g;
    let lastEnd = 0;
    let m: RegExpExecArray | null;
    while ((m = csi27.exec(text)) !== null) {
      if (m.index > lastEnd) {
        this.handleRawStdin(
          Buffer.from(text.slice(lastEnd, m.index), "binary"),
        );
      }
      const mod = parseInt(m[1]!, 10);
      const code = parseInt(m[2]!, 10);
      const name = mapCsiUToKeyName(code, mod);
      if (name !== null) {
        this.onKey([{ type: "key", name }]);
      } else if ((mod === 1 || mod === 2) && code >= 32 && code < 127) {
        // Printable ASCII with no modifier or shift — the user typed a
        // character. xterm reports the already-shifted codepoint in the
        // CSI-27 form, so Shift+i arrives as code=73 ('I') and we just
        // forward it as text.
        this.handleRawStdinSegment(String.fromCharCode(code));
      }
      lastEnd = m.index + m[0].length;
    }
    if (lastEnd < text.length) {
      this.handleRawStdin(Buffer.from(text.slice(lastEnd), "binary"));
    }
  }

  // Walk `text` extracting every kitty CSI-u sequence. Each non-CSI-u
  // span is recursed back into handleRawStdin so paste markers and
  // legacy-modifyOtherKeys sequences in the same chunk still get
  // handled; each matched CSI-u is mapped to a KeyEvent (or dropped if
  // unmapped). Caller has already verified at least one match exists.
  private handleCsiUStdin(text: string): void {
    const csiU = /\x1b\[(\d+)(?:;(\d+))?u/g;
    let lastEnd = 0;
    let m: RegExpExecArray | null;
    while ((m = csiU.exec(text)) !== null) {
      if (m.index > lastEnd) {
        this.handleRawStdin(
          Buffer.from(text.slice(lastEnd, m.index), "binary"),
        );
      }
      const code = parseInt(m[1]!, 10);
      const mod = m[2] !== undefined ? parseInt(m[2], 10) : 1;
      const name = mapCsiUToKeyName(code, mod);
      if (name !== null) {
        this.onKey([{ type: "key", name }]);
      }
      lastEnd = m.index + m[0].length;
    }
    if (lastEnd < text.length) {
      this.handleRawStdin(Buffer.from(text.slice(lastEnd), "binary"));
    }
  }

  // Inner stdin-segment handler — paste-marker detection and forwarding
  // to terminal-kit. Split out so shift-enter interception can call it
  // for the non-shift-enter portions of a mixed chunk.
  private handleRawStdinSegment(text: string): void {
    const startMarker = PASTE_START;
    const endMarker = PASTE_END;
    while (text.length > 0) {
      if (this.pasteActive) {
        const endIdx = text.indexOf(endMarker);
        if (endIdx === -1) {
          this.pasteBuffer += text;
          return;
        }
        this.pasteBuffer += text.slice(0, endIdx);
        text = text.slice(endIdx + endMarker.length);
        this.pasteActive = false;
        // Normalize line endings; some terminals deliver \r within
        // paste content even though the source had \n.
        const pasted = Buffer.from(this.pasteBuffer, "binary")
          .toString("utf-8")
          .replace(/\r\n?/g, "\n");
        this.pasteBuffer = "";
        // Drag-drop file paths arrive through the same bracketed-paste
        // channel as text — but the entire paste is just absolute
        // path(s) to image files. Strict match means "Here's
        // /tmp/foo.png" still pastes as text; only a pure-paths paste
        // becomes an attachment.
        const paths = parseImageDropPaste(pasted);
        if (paths !== null) {
          this.onKey([{ type: "attachment-paths", paths }]);
        } else {
          this.onKey([{ type: "paste", text: pasted }]);
        }
        continue;
      }
      const startIdx = text.indexOf(startMarker);
      if (startIdx === -1) {
        // No paste markers in this chunk — forward to terminal-kit as-is,
        // unless the chunk is a bare URL (some terminals deliver link
        // drag-drops outside of bracketed paste, where each char would
        // otherwise be processed as a keystroke and a trailing newline
        // would submit the prompt).
        const url = matchBareUrl(text);
        if (url !== null) {
          this.onKey([{ type: "paste", text: url }]);
        } else if (this.terminalKitStdinHandler) {
          this.terminalKitStdinHandler(Buffer.from(text, "binary"));
        }
        return;
      }
      if (startIdx > 0 && this.terminalKitStdinHandler) {
        this.terminalKitStdinHandler(
          Buffer.from(text.slice(0, startIdx), "binary"),
        );
      }
      text = text.slice(startIdx + startMarker.length);
      this.pasteActive = true;
    }
  }

  // Current terminal column count. Markdown rendering (parseAgentMarkdown,
  // tables in particular) consults this so a too-wide block lays out
  // narrowly enough that the screen-layer wrap is a no-op. Returns 0 if the
  // terminal hasn't reported a width yet, in which case callers should fall
  // back to natural-width formatting.
  width(): number {
    return this.term.width || 0;
  }

  appendLines(lines: FormattedLine[]): void {
    if (lines.length === 0) {
      return;
    }
    this.streamingActive = false;
    this.lines.push(...lines);
    this.trackLines(lines);
    this.adjustScrollForRowChange(this.wrappedRowsOfMany(lines));
    this.moveStickyToEnd();
    this.trimScrollback();
    this.scheduleRepaint();
  }

  appendLine(line: FormattedLine): void {
    this.streamingActive = false;
    this.lines.push(line);
    this.trackLine(line);
    this.adjustScrollForRowChange(this.wrappedRowsOf(line));
    this.moveStickyToEnd();
    this.trimScrollback();
    this.scheduleRepaint();
  }

  // When scrolled away from the bottom, shift scrollOffset to keep the
  // user's visible window anchored on the same content as the lines
  // array grows. `delta` is measured in WRAPPED ROWS — the same unit
  // scrollOffset uses — so a single logical line that wraps to N rows
  // contributes N, not 1. Counting logical lines here was the original
  // bug: any wrapped append would slide the view up by N−1 rows.
  private adjustScrollForRowChange(delta: number): void {
    if (this.scrollOffset > 0 && delta !== 0) {
      this.scrollOffset = Math.max(0, this.scrollOffset + delta);
    }
  }

  // Wrapped-row count for a single line at the current terminal width.
  // Reuses the wrap cache, and synchronises the cache's width with the
  // current width so a resize that hasn't yet been picked up by
  // drawScrollback can't return stale counts during an insert.
  private wrappedRowsOf(line: FormattedLine): number {
    const w = this.term.width;
    if (this.wrapCacheWidth !== w) {
      this.wrapCache.clear();
      this.wrapCacheWidth = w;
    }
    return this.wrapOne(line, w).length;
  }

  private wrappedRowsOfMany(lines: FormattedLine[]): number {
    let n = 0;
    for (const line of lines) {
      n += this.wrappedRowsOf(line);
    }
    return n;
  }

  private trackLine(line: FormattedLine): void {
    this.lineIds.set(line, this.nextLineId++);
  }

  private trackLines(lines: FormattedLine[]): void {
    for (const line of lines) {
      this.trackLine(line);
    }
  }

  private forgetLine(line: FormattedLine): void {
    const id = this.lineIds.get(line);
    if (id !== undefined) {
      this.wrapCache.delete(id);
    }
  }

  // Drop oldest lines once scrollback exceeds the configured cap. Removes
  // their wrap-cache entries and shifts keyedBlocks indices in sync;
  // blocks whose lines fully fell off the head are dropped (a later
  // upsert for that key will start a fresh block at the bottom).
  private trimScrollback(): void {
    const overflow = this.lines.length - this.maxScrollbackLines;
    if (overflow <= 0) {
      return;
    }
    const removed = this.lines.splice(0, overflow);
    for (const line of removed) {
      this.forgetLine(line);
    }
    this.invalidateSelectionIfTouches(removed);
    for (const [key, range] of [...this.keyedBlocks.entries()]) {
      range.start -= overflow;
      if (range.start < 0) {
        this.keyedBlocks.delete(key);
      }
    }
  }

  // Append-or-replace a single-line block keyed by `key`. Thin wrapper
  // around upsertLines for the common one-row case (tool calls).
  upsertLine(key: string, line: FormattedLine): void {
    this.upsertLines(key, [line]);
  }

  // Append-or-replace a contiguous block of lines keyed by `key`. First
  // call appends; later calls splice the new lines in over the previous
  // ones. If the block changes size, the start indices of any later keyed
  // blocks are shifted to stay in sync with the new `lines` array.
  upsertLines(key: string, newLines: FormattedLine[]): void {
    if (newLines.length === 0) {
      return;
    }
    // Stamp each line with its owning key so a click can resolve it back
    // to the block even after clearKey forgets the keyedBlocks entry (the
    // lines stay painted, carrying the stamp).
    for (const line of newLines) {
      line.blockKey = key;
    }
    const existing = this.keyedBlocks.get(key);
    // Only reset the streaming flag when this op actually disturbs the
    // last line of scrollback. Mid-array splices (e.g. the 5-second
    // tools-block elapsed tick happening while agent text streams
    // below) must NOT mark streaming as stopped, or the next chunk
    // would be treated as a fresh utterance and get a blank-line
    // separator inserted mid-message.
    let touchesEnd = false;
    let rowDelta = 0;
    if (existing) {
      const oldEnd = existing.start + existing.count;
      touchesEnd = oldEnd >= this.lines.length;
      const oldRows = this.wrappedRowsOfMany(
        this.lines.slice(existing.start, oldEnd),
      );
      const delta = newLines.length - existing.count;
      const removed = this.lines.splice(
        existing.start,
        existing.count,
        ...newLines,
      );
      for (const line of removed) {
        this.forgetLine(line);
      }
      this.trackLines(newLines);
      this.invalidateSelectionIfTouches(removed);
      existing.count = newLines.length;
      if (delta !== 0) {
        for (const [k, range] of this.keyedBlocks) {
          if (k !== key && range.start > existing.start) {
            range.start += delta;
          }
        }
      }
      rowDelta = this.wrappedRowsOfMany(newLines) - oldRows;
    } else {
      // Appending a new block at the bottom always displaces whatever
      // was the last line.
      touchesEnd = true;
      this.keyedBlocks.set(key, {
        start: this.lines.length,
        count: newLines.length,
      });
      this.lines.push(...newLines);
      this.trackLines(newLines);
      rowDelta = this.wrappedRowsOfMany(newLines);
    }
    if (touchesEnd) {
      this.streamingActive = false;
    }
    this.adjustScrollForRowChange(rowDelta);
    // Upserting any non-sticky key may have pushed content past the
    // sticky block (new block tacked onto the end) — float the sticky
    // block back. Upserting the sticky key itself doesn't need this:
    // the splice happens at its existing position.
    if (key !== this.stickyBottomKey) {
      this.moveStickyToEnd();
    }
    this.trimScrollback();
    this.scheduleRepaint();
  }

  // Append fragments of a streaming message (e.g. agent_message_chunk). The
  // first fragment after a non-streaming event starts a new line; subsequent
  // fragments extend that line in place. Embedded newlines split into rows
  // (with a blank prefix on continuation rows so the gutter doesn't repeat).
  appendStreaming(
    text: string,
    prefix: string,
    bodyStyle: Style,
    prefixStyle?: Style,
  ): void {
    if (text.length === 0) {
      return;
    }
    const fragments = text.split("\n");
    const [first, ...rest] = fragments;
    let rowDelta = 0;
    if (this.streamingActive && this.lines.length > 0) {
      const last = this.lines[this.lines.length - 1];
      if (last) {
        // The in-place mutation can push the line over a wrap boundary,
        // so we measure rows before/after and account for the diff —
        // not just the new continuation lines below.
        const before = this.wrappedRowsOf(last);
        this.forgetLine(last);
        last.body += first ?? "";
        rowDelta += this.wrappedRowsOf(last) - before;
      }
    } else {
      // Fresh streaming utterance — insert a blank separator unless the
      // last line is already one, so successive agent messages (split by
      // tool calls, plan updates, thoughts, etc.) read as visually
      // distinct paragraphs instead of running together.
      if (this.lines.length > 0) {
        const last = this.lines[this.lines.length - 1];
        const isBlank =
          last && last.body === "" && (!last.prefix || last.prefix === "");
        if (!isBlank) {
          const sep: FormattedLine = { body: "" };
          this.lines.push(sep);
          this.trackLine(sep);
          rowDelta += this.wrappedRowsOf(sep);
        }
      }
      const initial: FormattedLine = {
        prefix,
        body: first ?? "",
        bodyStyle,
      };
      if (prefixStyle !== undefined) {
        initial.prefixStyle = prefixStyle;
      }
      this.lines.push(initial);
      this.trackLine(initial);
      rowDelta += this.wrappedRowsOf(initial);
    }
    const continuationPrefix = " ".repeat(prefix.length);
    for (const piece of rest) {
      const cont: FormattedLine = {
        prefix: continuationPrefix,
        body: piece,
        bodyStyle,
      };
      this.lines.push(cont);
      this.trackLine(cont);
      rowDelta += this.wrappedRowsOf(cont);
    }
    this.streamingActive = true;
    this.adjustScrollForRowChange(rowDelta);
    // The streaming chunk pushed lines onto the end of scrollback; if a
    // sticky block is set, slide it back to the bottom. This also resets
    // streamingActive — the next chunk starts a fresh line above the
    // sticky block rather than trying to extend a line that's no longer
    // the tail.
    this.moveStickyToEnd();
    this.trimScrollback();
    this.scheduleRepaint();
  }

  setSessionbar(sessionbar: Partial<SessionbarState>): void {
    this.sessionbar = { ...this.sessionbar, ...sessionbar };
    this.syncWindowTitle();
    this.repaint();
  }

  // Push the current session title (or short session id, as fallback) to
  // the host terminal via OSC 2. Supported by xterm/foot/iTerm2/Alacritty/
  // most modern emulators; ignored harmlessly elsewhere.
  private syncWindowTitle(): void {
    const title = this.sessionbar.title?.trim();
    const fallback = shortId(this.sessionbar.sessionId) || "hydra";
    const raw = title && title.length > 0 ? title : fallback;
    const tagged = this.readonly ? `${raw} [VIEW ONLY]` : raw;
    // Strip control chars (including ESC) so a hostile title can't
    // close the escape sequence early and inject further sequences.
    const clean = tagged.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 200);
    if (clean === this.lastWindowTitle) {
      return;
    }
    this.lastWindowTitle = clean;
    process.stdout.write(`\x1b]0;${clean}\x1b\\`);
  }

  clearWindowTitle(): void {
    this.lastWindowTitle = null;
    process.stdout.write("\x1b]0;\x1b\\");
  }

  setBanner(banner: Partial<BannerState>): void {
    this.banner = { ...this.banner, ...banner };
    this.writeProgressIndicator(this.banner.status === "busy" ? 3 : 0);
    this.syncedPartialRepaint(() => this.drawBanner());
  }

  // Wrap a partial repaint (banner-only, prompt-only, etc.) in a
  // synchronized-output bracket so the row swap is atomic on terminals
  // that support DEC 2026. Cursor movement (moveTo) is buffered inside
  // BSU/ESU, so the cursor appears at its final placeCursor position
  // without visibly visiting intermediate rows. We intentionally do NOT
  // hide the cursor here: ?25l/h (cursor visibility) is terminal *state*
  // applied immediately rather than buffered, so hiding inside a BSU/ESU
  // block causes a visible blink (cursor disappears → frame commits →
  // cursor reappears) on every banner tick — worse than any skitter.
  private syncedPartialRepaint(paint: () => void): void {
    // Mirrors paintRow's started-guard: a stale timer tick (banner
    // elapsed-time, notification timeout) firing after stop() must not
    // bleed BSU / ESU sequences to the host shell.
    if (!this.started) {
      return;
    }
    withSync(() => {
      this.term.hideCursor();
      paint();
      this.placeCursor();
    });
  }

  currentModeId(): string | undefined {
    return this.banner.currentMode;
  }

  // OSC 9;4 progress-bar control. State 3 = indeterminate (pulsing
  // taskbar / dock badge while a turn is running); state 0 = remove.
  // ConEmu-flavor sequence — supported by Windows Terminal, WezTerm,
  // Ghostty, Konsole, Black Box, Rio, and others; ignored harmlessly
  // by terminals that don't implement it. Disabled entirely when
  // tui.progressIndicator is false.
  private writeProgressIndicator(state: 0 | 3): void {
    if (!this.started) {
      return;
    }
    if (!this.progressIndicatorEnabled) {
      return;
    }
    if (state === this.lastProgressState) {
      return;
    }
    this.lastProgressState = state;
    process.stdout.write(`\x1b]9;4;${state}\x1b\\`);
  }

  // Transient right-side banner message. Cleared automatically after
  // durationMs (default 4s). Each call resets the timer, so rapid
  // successive notifications coalesce on the latest text. Active
  // scrollback / prompt-history search indicators take priority over
  // notifications, so a notification queued during search is held
  // behind it and visible once search exits — unless its timer fires
  // first, in which case it's dropped.
  notify(text: string, durationMs = 4000): void {
    if (this.bannerNotificationTimer) {
      clearTimeout(this.bannerNotificationTimer);
    }
    this.bannerNotification = text;
    this.bannerNotificationTimer = setTimeout(() => {
      this.bannerNotification = null;
      this.bannerNotificationTimer = null;
      this.syncedPartialRepaint(() => this.drawBanner());
    }, durationMs);
    this.syncedPartialRepaint(() => this.drawBanner());
  }

  // Persistent compaction status indicator shown in the right-side banner
  // slot (lower priority than search and transient notify). Pass null to
  // clear. Does not use a timer — the caller is responsible for clearing
  // when the phase ends (or when a transient notify supersedes it).
  setCompactionIndicator(text: string | null): void {
    if (this.compactionIndicator === text) {
      return;
    }
    this.compactionIndicator = text;
    this.syncedPartialRepaint(() => this.drawBanner());
  }

  // Persistent fork-synthesis status indicator shown in the right-side
  // banner slot (higher priority than compaction, lower than search and
  // transient notify). Pass null to clear. Does not use a timer — the
  // caller is responsible for clearing when synthesis completes or fails.
  setSynthesisIndicator(text: string | null): void {
    if (this.synthesisIndicator === text) {
      return;
    }
    this.synthesisIndicator = text;
    this.syncedPartialRepaint(() => this.drawBanner());
  }

  // Runtime toggle for terminal mouse capture. With capture on, the
  // wheel drives scrollback but text selection requires shift+drag
  // (terminals route mouse events to the app). With capture off, plain
  // click-drag selects text but the wheel does nothing in the app —
  // use PgUp/PgDn for scrollback instead. Bound to ^X so users can
  // flip on demand without a config reload + restart. Idempotent.
  //
  // Re-issuing grabInput() reinstalls terminal-kit's own stdin "data"
  // listener, so we have to redo the same listener swap that
  // installBracketedPaste() did at startup — otherwise our raw handler
  // and terminal-kit's both fire for every keystroke (each character
  // appears twice in the prompt).
  setMouseEnabled(enabled: boolean): void {
    if (this.mouseEnabled === enabled) {
      return;
    }
    this.mouseEnabled = enabled;
    if (!this.started) {
      return;
    }
    if (enabled) {
      this.term.grabInput({ mouse: "drag" });
      this.term.on("mouse", this.mouseHandler);
    } else {
      this.term.off("mouse", this.mouseHandler);
      this.term.grabInput(true);
    }
    this.reclaimStdinAfterGrabInput();
  }

  // After a grabInput() re-issue, terminal-kit has put its own "data"
  // listener back on stdin. Pull it back off and reinstall hydra's
  // rawStdinHandler — keeping the captured terminal-kit handler so our
  // bracketed-paste extractor can still delegate non-paste bytes to it.
  // No-op if installBracketedPaste() hasn't run yet (start() does it
  // before any toggle path can reach here).
  private reclaimStdinAfterGrabInput(): void {
    if (this.terminalKitStdinHandler === null) {
      return;
    }
    const t = this.term as unknown as {
      stdin: NodeJS.ReadableStream;
      onStdin: (chunk: Buffer) => void;
    };
    if (!t.stdin || typeof t.onStdin !== "function") {
      return;
    }
    // Refresh the captured reference — grabInput may have bound a new
    // closure even if it's functionally equivalent.
    this.terminalKitStdinHandler = t.onStdin;
    t.stdin.removeListener("data", t.onStdin);
    // Defensive: ensure rawStdinHandler isn't doubled either, in case
    // some future code path re-adds it.
    t.stdin.removeListener("data", this.rawStdinHandler);
    t.stdin.on("data", this.rawStdinHandler);
  }

  isMouseEnabled(): boolean {
    return this.mouseEnabled;
  }

  // Runtime toggle for the in-app selection feature. Independent of
  // mouse capture: downstream interaction code consults this flag
  // before treating press/drag/release as a selection gesture, so
  // turning it off restores native terminal selection (when mouse
  // capture is off) or shift+drag (when mouse capture is on)
  // without disturbing wheel-scrollback or any other mouse plumbing.
  setInAppSelectionEnabled(enabled: boolean): void {
    this.inAppSelectionEnabled = enabled;
  }

  isInAppSelectionEnabled(): boolean {
    return this.inAppSelectionEnabled;
  }

  // Set the active source-anchored selection. Endpoints are
  // {sourceLineId, offset} as produced by resolveCellToSource (T5).
  // The pair is normalized so the caller can pass them in either
  // order — useful for click+drag where anchor/focus order depends on
  // drag direction. A degenerate selection (anchor === focus) is
  // dropped: a zero-width highlight has nothing to paint and only
  // costs a repaint.
  setSelection(
    a: { sourceLineId: number; offset: number },
    b: { sourceLineId: number; offset: number },
  ): void {
    // Order by DISPLAY position (array index), not raw id — ids aren't
    // monotonic with on-screen order once a block has been re-rendered.
    const ia = this.lineIndexById(a.sourceLineId);
    const ib = this.lineIndexById(b.sourceLineId);
    const before = ia < ib || (ia === ib && a.offset <= b.offset);
    const start = before ? a : b;
    const end = before ? b : a;
    if (start.sourceLineId === end.sourceLineId && start.offset === end.offset) {
      this.clearSelection();
      return;
    }
    const next = {
      startLineId: start.sourceLineId,
      startOffset: start.offset,
      endLineId: end.sourceLineId,
      endOffset: end.offset,
    };
    const cur = this.selection;
    if (
      cur &&
      cur.startLineId === next.startLineId &&
      cur.startOffset === next.startOffset &&
      cur.endLineId === next.endLineId &&
      cur.endOffset === next.endOffset
    ) {
      return;
    }
    this.selection = next;
    this.repaint();
  }

  clearSelection(): void {
    if (this.selection === null) {
      return;
    }
    this.selection = null;
    this.repaint();
  }

  hasSelection(): boolean {
    return this.selection !== null;
  }

  getSelection(): {
    start: { sourceLineId: number; offset: number };
    end: { sourceLineId: number; offset: number };
  } | null {
    if (this.selection === null) {
      return null;
    }
    return {
      start: { sourceLineId: this.selection.startLineId, offset: this.selection.startOffset },
      end: { sourceLineId: this.selection.endLineId, offset: this.selection.endOffset },
    };
  }

  // Extract the active selection as plain text suitable for the
  // clipboard: slice each covered source line at the selection's
  // start/end offsets (partial first/last, full middle lines), join
  // with '\n', strip ANSI styling escapes so a highlighted code-block
  // body doesn't leak SGR bytes into the clipboard. Returns "" when
  // there is no active selection or the selection's lines are no
  // longer in scrollback (e.g. pruned by trimScrollback between
  // setSelection and the extract). The returned string contains no
  // trailing newline.
  getSelectionText(): string {
    const ext = this.selectionLineBounds();
    if (ext === null) {
      return "";
    }
    const out: string[] = [];
    // Walk in DISPLAY order (array index), not id order: a re-rendered
    // block sits at a low index but carries high ids, so an id-range scan
    // would pull in unrelated lines and miss selected ones.
    for (let i = ext.loIdx; i <= ext.hiIdx; i++) {
      const line = this.lines[i];
      if (!line) {
        continue;
      }
      const id = this.lineIds.get(line);
      const bounds = id === undefined ? undefined : ext.byId.get(id);
      if (!bounds) {
        continue;
      }
      const rawBody = line.body ?? "";
      let piece: string;
      if (line.ansi) {
        // ANSI bodies aren't selectable per-char; only their FULL body
        // appears here as an interior line. Partial-ansi endpoints are
        // skipped rather than emit a garbled half-stripped slice.
        piece =
          i === ext.loIdx || i === ext.hiIdx
            ? ""
            : rawBody.replace(ANSI_STRIP_RE, "");
      } else {
        piece = rawBody.slice(bounds.start, bounds.end);
        // Styled bodies route through the markup-interpreting writer, so
        // `^X` / `^[...]` style spans are visually zero-width but sit in
        // the source as code units. Offsets already land on markup
        // boundaries (segment-aware), so the slice contains whole markup
        // sequences only; strip them so the clipboard carries the visible
        // characters alone.
        if (bodyStyleUsesMarkup(line.bodyStyle)) {
          piece = stripTkMarkup(piece);
        }
      }
      out.push(piece);
    }
    return out.join("\n");
  }

  // Resolve the active selection into display order. Line ids are stable
  // identifiers but NOT ordered by display position (a streaming block
  // re-rendered via upsertLines is reassigned higher ids while keeping its
  // original, higher-up array slot), so the selection extent must be
  // computed from array indices. Returns the inclusive index range plus a
  // per-line-id map of the selected [start,end) offset window (full body
  // for interior lines) and whether the selection continues past it.
  private selectionLineBounds(): {
    loIdx: number;
    hiIdx: number;
    byId: Map<number, { start: number; end: number; toEnd: boolean }>;
  } | null {
    const sel = this.selection;
    if (sel === null) {
      return null;
    }
    const i1 = this.lineIndexById(sel.startLineId);
    const i2 = this.lineIndexById(sel.endLineId);
    if (i1 === -1 || i2 === -1) {
      return null;
    }
    let loIdx = i1;
    let hiIdx = i2;
    let loOff = sel.startOffset;
    let hiOff = sel.endOffset;
    if (i1 > i2) {
      loIdx = i2;
      hiIdx = i1;
      loOff = sel.endOffset;
      hiOff = sel.startOffset;
    }
    const byId = new Map<
      number,
      { start: number; end: number; toEnd: boolean }
    >();
    for (let i = loIdx; i <= hiIdx; i++) {
      const line = this.lines[i];
      if (!line) {
        continue;
      }
      const id = this.lineIds.get(line);
      if (id === undefined) {
        continue;
      }
      const bodyLen = (line.body ?? "").length;
      const start = i === loIdx ? Math.max(0, Math.min(bodyLen, loOff)) : 0;
      const end = i === hiIdx ? Math.max(0, Math.min(bodyLen, hiOff)) : bodyLen;
      byId.set(id, { start, end, toEnd: i < hiIdx });
    }
    return { loIdx, hiIdx, byId };
  }

  // For a wrapped chunk, returns the [start, end) code-unit range
  // within chunk.body that the active selection covers, plus a flag
  // indicating the selection extends to (or past) the end of this
  // chunk's source-line tail. Returns null when the chunk is outside
  // the selection or when no selection is active. ANSI-bodied chunks
  // are skipped — escape bytes inflate code-unit math and would land
  // the highlight in the wrong cells.
  private selectionRangeForChunk(
    line: FormattedLine,
  ): { start: number; end: number; toEndOfLine: boolean } | null {
    if (this.selection === null || line.ansi) {
      return null;
    }
    // Membership + per-line offset window come from the display-ordered
    // map — never compare raw line ids for order. drawScrollback caches it
    // once per paint; fall back to computing it if we're called outside a
    // paint (e.g. directly in tests).
    const bounds =
      this.selectionRenderBounds ?? this.selectionLineBounds()?.byId ?? null;
    if (bounds === null) {
      return null;
    }
    const origin = this.wrapOrigin.get(line);
    if (!origin) {
      return null;
    }
    const lineSel = bounds.get(origin.sourceLineId);
    if (!lineSel) {
      return null;
    }
    // Intersect the line's selected window with this chunk's window
    // [sourceColOffset, sourceColOffset + chunk.body.length).
    const chunkStart = origin.sourceColOffset;
    const chunkEnd = chunkStart + line.body.length;
    const interStart = Math.max(lineSel.start, chunkStart);
    const interEnd = Math.min(lineSel.end, chunkEnd);
    if (interEnd <= interStart) {
      return null;
    }
    return {
      start: interStart - chunkStart,
      end: interEnd - chunkStart,
      // True iff the selection extends past this chunk's end into
      // continuation chunks or to a later source line. drives whether
      // the fillRow padding should also be highlighted so a multi-row
      // selection reads as a continuous band rather than a jagged
      // right edge.
      toEndOfLine: lineSel.toEnd || lineSel.end > chunkEnd,
    };
  }

  // Pushed by the app each onKey tick to reflect prompt-history
  // reverse-search state in the banner — the only place that mode's
  // query is visible. Pass null when not searching.
  setBannerSearchIndicator(text: string | null): void {
    if (this.bannerSearchIndicator === text) {
      return;
    }
    this.bannerSearchIndicator = text;
    this.syncedPartialRepaint(() => this.drawBanner());
  }

  // Computes what (if anything) the right-side banner slot should show
  // this paint. Priority: scrollback search term > prompt-history
  // indicator > notification. Scrollback gets a "N/M" counter suffix
  // since the user can't see which match they're on from the highlight
  // alone; prompt-history's match is visible in the buffer, so no
  // counter needed there.
  private bannerRightContent(): { text: string; kind: "search" | "notify" | "synthesis" | "compaction" } | null {
    if (this.scrollbackSearch !== null) {
      const sb = this.scrollbackSearch;
      const counter =
        sb.matches.length > 0
          ? ` ${sb.matchIndex + 1}/${sb.matches.length}`
          : sb.term.length === 0
            ? ""
            : " 0/0";
      return { text: `🔍 ${sb.term}${counter}`, kind: "search" };
    }
    if (this.bannerSearchIndicator !== null) {
      return { text: `🔍 ${this.bannerSearchIndicator}`, kind: "search" };
    }
    if (this.bannerNotification !== null) {
      return { text: this.bannerNotification, kind: "notify" };
    }
    if (this.synthesisIndicator !== null) {
      return { text: this.synthesisIndicator, kind: "synthesis" };
    }
    if (this.compactionIndicator !== null) {
      return { text: this.compactionIndicator, kind: "compaction" };
    }
    return null;
  }

  clearScrollback(): void {
    this.lines = [];
    this.keyedBlocks.clear();
    this.wrapCache.clear();
    this.wrapCacheWidth = 0;
    this.streamingActive = false;
    this.scrollOffset = 0;
    if (this.selection !== null) {
      this.selection = null;
    }
    this.repaint();
  }

  // After a mutation that removed FormattedLines from this.lines, drop
  // the active selection if either endpoint pointed at one of the
  // removed lines — keeps "selection becomes invalid when source lines
  // are pruned or edited in place" honest. Cheap: O(removed) WeakMap
  // lookups, no full-scrollback scan.
  private invalidateSelectionIfTouches(removed: FormattedLine[]): void {
    if (this.selection === null) {
      return;
    }
    for (const line of removed) {
      const id = this.lineIds.get(line);
      if (
        id !== undefined &&
        (id === this.selection.startLineId || id === this.selection.endLineId)
      ) {
        this.selection = null;
        return;
      }
    }
  }

  // Toggle visibility of agent-thought lines without removing them from
  // storage. Idempotent — repeated calls with the same value are no-ops.
  // Reveals are immediate (a repaint runs) so the user sees thoughts
  // appear / disappear the moment they press ^T.
  setHideThoughts(hide: boolean): void {
    if (this.hideThoughts === hide) {
      return;
    }
    this.hideThoughts = hide;
    this.repaint();
  }

  // Forget an upsert key without touching scrollback. The next upsertLines
  // for this key will append at the bottom instead of splicing in place —
  // used to scope a logical block (e.g. an agent's plan) to one turn so
  // the next turn starts a fresh block below.
  clearKey(key: string): void {
    this.keyedBlocks.delete(key);
  }

  // Whether a keyed block currently exists in scrollback.
  hasKey(key: string): boolean {
    return this.keyedBlocks.has(key);
  }

  // Splice a keyed block's lines out of scrollback entirely (unlike
  // clearKey, which only forgets the key but leaves the lines painted).
  // Later blocks' start indices shift up by the removed count so they
  // stay aligned with the lines array. No-op if the key is unknown.
  removeKey(key: string): void {
    const block = this.keyedBlocks.get(key);
    if (!block) {
      return;
    }
    const end = block.start + block.count;
    const touchesEnd = end >= this.lines.length;
    const removedRows = this.wrappedRowsOfMany(
      this.lines.slice(block.start, end),
    );
    const removed = this.lines.splice(block.start, block.count);
    for (const line of removed) {
      this.forgetLine(line);
    }
    this.invalidateSelectionIfTouches(removed);
    this.keyedBlocks.delete(key);
    for (const [k, range] of this.keyedBlocks) {
      if (k !== key && range.start > block.start) {
        range.start -= block.count;
      }
    }
    if (touchesEnd) {
      this.streamingActive = false;
    }
    this.adjustScrollForRowChange(-removedRows);
    this.moveStickyToEnd();
    this.scheduleRepaint();
  }

  // Mark `key` as the sticky-bottom block. While set, whenever new content
  // lands after the block's lines (appendLines / appendStreaming / a new
  // upserted block) the screen floats this block back to the end so it
  // remains the last thing in scrollback. Pass null to disable. The key
  // doesn't need to refer to an existing block — the float is a no-op
  // until a block with that key is upserted.
  setStickyBottomKey(key: string | null): void {
    this.stickyBottomKey = key;
    this.moveStickyToEnd();
    this.scheduleRepaint();
  }

  // If a sticky-bottom block is configured and isn't already at the tail,
  // splice it out and re-push it at the end. Indices of the other keyed
  // blocks that sat after the sticky block shift up by sticky.count to
  // stay aligned with the lines array. Resets streamingActive because the
  // last line is now part of the sticky block — extending the buried
  // streaming line in place would corrupt the sticky content.
  private moveStickyToEnd(): void {
    if (this.stickyBottomKey === null) {
      return;
    }
    const sticky = this.keyedBlocks.get(this.stickyBottomKey);
    if (!sticky) {
      return;
    }
    const stickyEnd = sticky.start + sticky.count;
    if (stickyEnd >= this.lines.length) {
      return;
    }
    const stickyLines = this.lines.splice(sticky.start, sticky.count);
    for (const [k, range] of this.keyedBlocks) {
      if (k === this.stickyBottomKey) {
        continue;
      }
      if (range.start >= stickyEnd) {
        range.start -= sticky.count;
      }
    }
    sticky.start = this.lines.length;
    this.lines.push(...stickyLines);
    this.streamingActive = false;
  }

  // Splice a keyed block's lines out of scrollback entirely and drop the
  // key. Used when a placeholder block (e.g. "thinking…" with no tool
  // calls ever fired) shouldn't be kept as a historical artifact after
  // its turn ends. Indices of later keyed blocks are shifted in step
  // with the splice so they continue to point at the right rows.
  removeBlock(key: string): void {
    const existing = this.keyedBlocks.get(key);
    if (!existing) {
      return;
    }
    const touchesEnd =
      existing.start + existing.count >= this.lines.length;
    // Count wrapped rows before splicing so cached entries still
    // resolve; forgetLine below would clear them.
    const removedRows = this.wrappedRowsOfMany(
      this.lines.slice(existing.start, existing.start + existing.count),
    );
    const removed = this.lines.splice(existing.start, existing.count);
    for (const line of removed) {
      this.forgetLine(line);
    }
    this.invalidateSelectionIfTouches(removed);
    this.keyedBlocks.delete(key);
    for (const [, range] of this.keyedBlocks) {
      if (range.start > existing.start) {
        range.start -= existing.count;
      }
    }
    if (touchesEnd) {
      this.streamingActive = false;
    }
    this.adjustScrollForRowChange(-removedRows);
    this.scheduleRepaint();
  }

  // Among `candidates`, return the maximal run of keyed blocks that is
  // visually contiguous with `key` — i.e. consecutive (sorted by scrollback
  // position) with no OTHER keyed block lying between neighbours. Unkeyed
  // lines between members (e.g. separators) don't break contiguity. Used to
  // group thought blocks that were split by tool calls (the tools block
  // updates in place elsewhere, so the thoughts stay adjacent in
  // scrollback). Returns [] if `key` isn't a live keyed block.
  contiguousRun(key: string, candidates: Set<string>): string[] {
    if (!this.keyedBlocks.has(key)) {
      return [];
    }
    // Candidate blocks that currently exist, sorted by scrollback position.
    const members = [...candidates]
      .map((k) => {
        const b = this.keyedBlocks.get(k);
        return b ? { key: k, start: b.start, count: b.count } : null;
      })
      .filter((m): m is { key: string; start: number; count: number } => m !== null)
      .sort((a, b) => a.start - b.start);
    const idx = members.findIndex((m) => m.key === key);
    if (idx < 0) {
      return [];
    }
    // Is there any keyed block (not in `candidates`) occupying a position
    // strictly between the end of `a` and the start of `b`?
    const foreignBetween = (aEnd: number, bStart: number): boolean => {
      for (const [k, range] of this.keyedBlocks) {
        if (candidates.has(k)) {
          continue;
        }
        if (range.start >= aEnd && range.start < bStart) {
          return true;
        }
      }
      return false;
    };
    let lo = idx;
    while (
      lo > 0 &&
      !foreignBetween(
        members[lo - 1]!.start + members[lo - 1]!.count,
        members[lo]!.start,
      )
    ) {
      lo--;
    }
    let hi = idx;
    while (
      hi < members.length - 1 &&
      !foreignBetween(
        members[hi]!.start + members[hi]!.count,
        members[hi + 1]!.start,
      )
    ) {
      hi++;
    }
    return members.slice(lo, hi + 1).map((m) => m.key);
  }

  // Fold or unfold a contiguous run of blocks. When collapsing, the first
  // block's content is replaced with `leadLines` (e.g. a single "Thoughts"
  // line) and every line after it through the end of the last block — the
  // secondary blocks plus the separators between them — is marked
  // `collapsed` so it's skipped at draw time (the keyed blocks and their
  // lines stay in place, so nothing has to be re-inserted). When expanding,
  // the first block is restored to `leadLines` (its full content) and the
  // trailing range is un-marked. `runKeys` must be ordered by scrollback
  // position (as returned by contiguousRun).
  setRunCollapsed(
    runKeys: string[],
    collapsed: boolean,
    leadLines: FormattedLine[],
  ): void {
    if (runKeys.length === 0) {
      return;
    }
    const firstKey = runKeys[0]!;
    if (!this.keyedBlocks.has(firstKey)) {
      return;
    }
    // Replace the lead block's content first (handles splice + index shift
    // + line tracking + blockKey stamping for the lead line).
    this.upsertLines(firstKey, leadLines);
    const first = this.keyedBlocks.get(firstKey)!;
    // End of the last block in the run, after the lead-block resize.
    let lastEnd = first.start + first.count;
    for (const k of runKeys) {
      const b = this.keyedBlocks.get(k);
      if (b) {
        lastEnd = Math.max(lastEnd, b.start + b.count);
      }
    }
    for (let i = first.start + first.count; i < lastEnd; i++) {
      const line = this.lines[i];
      if (line) {
        line.collapsed = collapsed;
      }
    }
    this.scheduleRepaint();
  }

  redraw(): void {
    this.repaint();
  }

  // Forced clean-slate repaint. Drops the per-row signature cache, the
  // window-title cache, the wrap cache, and clears the terminal before
  // painting. Wired to ^L so the user can recover when something has
  // corrupted the visible state and the per-row sig check otherwise
  // short-circuits the re-emit.
  fullRedraw(): void {
    this.painter.clearCache();
    this.lastWindowTitle = null;
    this.wrapCache.clear();
    this.wrapCacheWidth = 0;
    // Re-assert DECAWM-off in case something turned it back on.
    process.stdout.write(AUTOWRAP_OFF);
    this.term.clear();
    this.repaint();
  }

  // While paused, append* methods buffer state but don't repaint. Calls are
  // counter-based so they nest safely. Resume triggers exactly one repaint
  // if any was requested while paused.
  pauseRepaint(): void {
    this.repaintPaused += 1;
  }

  resumeRepaint(): void {
    if (this.repaintPaused === 0) {
      return;
    }
    this.repaintPaused -= 1;
    if (this.repaintPaused === 0 && this.repaintPending) {
      this.repaintPending = false;
      this.repaint();
    }
  }

  setQueuedPrompts(texts: string[]): void {
    this.queuedTexts = [...texts];
    this.lastQueueEditingIndex = this.dispatcher.state().queueIndex;
    this.repaint();
  }

  // Force an immediate full repaint, bypassing the content throttle. For
  // user-driven actions (e.g. click-to-toggle a block) that must feel
  // instant rather than wait out the throttle window.
  repaintNow(): void {
    this.repaint();
  }

  // While a permission prompt is active, the prompt area is replaced with
  // an interactive options list. Pass null to dismiss.
  setPermissionPrompt(spec: PermissionPromptSpec | null): void {
    if (spec !== null && this.permissionPrompt === null) {
      this.clearSelection();
    }
    this.permissionPrompt = spec ? { ...spec } : null;
    this.repaint();
  }

  // Interactive session-options modal (^O). Takes over the prompt area
  // like the permission modal. Pass null to dismiss.
  setOptionsPrompt(spec: OptionsPromptSpec | null): void {
    if (spec !== null && this.optionsPrompt === null) {
      this.clearSelection();
    }
    this.optionsPrompt = spec
      ? { ...spec, options: spec.options.map((o) => ({ ...o })) }
      : null;
    this.repaint();
  }

  isOptionsPromptActive(): boolean {
    return this.optionsPrompt !== null;
  }

  // Two-line confirmation modal that takes over the prompt area. Pass
  // null to dismiss. Currently unused — kept as a generic primitive for
  // any future modal that needs a question + hint footer.
  setConfirmPrompt(spec: ConfirmPromptSpec | null): void {
    if (spec !== null && this.confirmPrompt === null) {
      this.clearSelection();
    }
    this.confirmPrompt = spec ? { ...spec } : null;
    this.repaint();
  }

  isCompactionPromptActive(): boolean {
    return this.compactionPrompt !== null;
  }

  // Read-only view of the current spec for callers that need to cycle
  // the selection (TUI key handler) or check which option is active.
  compactionPromptSpec(): CompactionPromptSpec | null {
    return this.compactionPrompt ? { ...this.compactionPrompt } : null;
  }

  // Compaction prompt shown once per attach when the unsummarized tail
  // is large enough that the daemon's shouldCompact heuristic fires.
  // Pass null to dismiss.
  setCompactionPrompt(spec: CompactionPromptSpec | null): void {
    if (spec !== null && this.compactionPrompt === null) {
      this.clearSelection();
    }
    this.compactionPrompt = spec ? { ...spec } : null;
    this.repaint();
  }

  // Multi-row help cheatsheet that takes over the prompt area. Used by
  // the ^G hotkey to surface every binding without dropping the user
  // out of the session. Pass null to dismiss.
  setHelpPrompt(spec: HelpPromptSpec | null): void {
    if (spec !== null && this.helpPrompt === null) {
      this.clearSelection();
    }
    this.helpPrompt = spec
      ? { ...spec, entries: [...spec.entries] }
      : null;
    this.repaint();
  }

  isHelpPromptActive(): boolean {
    return this.helpPrompt !== null;
  }

  // Open a bottom-of-screen overlay pane. `opts.height` is the MAX rows
  // the overlay may grow to (default 12); actual height auto-sizes to
  // (1 header + content rows). When content is empty, the overlay
  // reserves zero rows and the prompt-above separator carries the btw
  // label instead, so a still-waiting /btw doesn't leave a yawning empty
  // pane on screen.
  openBtwOverlay(opts?: { height?: number }): void {
    const maxHeight = opts?.height ?? 12;
    this.btwOverlayOpen = true;
    this.btwOverlayMaxHeight = maxHeight;
    this.focusedPane = "btw";
    this.btwOverlayLines = [];
    this.btwOverlaySessionId = null;
    this.btwOverlayUsage = undefined;
    this.scheduleRepaint();
  }

  // Update the overlay's session-id / usage snapshot, both surfaced in
  // the overlay header. Fields are independently optional so the caller
  // can set just one (e.g. sessionId once at fork-attach time, usage
  // repeatedly as usage_update events arrive). Pass `null` for sessionId
  // to clear it. Idempotent for unchanged values.
  setBtwOverlayMeta(meta: { sessionId?: string | null; usage?: UsageState }): void {
    let changed = false;
    if (meta.sessionId !== undefined && this.btwOverlaySessionId !== meta.sessionId) {
      this.btwOverlaySessionId = meta.sessionId;
      changed = true;
    }
    if (meta.usage !== undefined) {
      const prev = this.btwOverlayUsage;
      const next = meta.usage;
      if (
        !prev ||
        prev.used !== next.used ||
        prev.size !== next.size ||
        prev.costAmount !== next.costAmount ||
        prev.costCurrency !== next.costCurrency
      ) {
        this.btwOverlayUsage = { ...next };
        changed = true;
      }
    }
    if (changed) {
      this.scheduleRepaint();
    }
  }

  // Replace the overlay's content lines. Only the LAST (rows-1) entries
  // are visible at any given time (auto-height caps content to fit).
  // FormattedLine retains bodyStyle/fillRow so the overlay paints user
  // turns / tool labels / agent text with the same styling as the main
  // transcript.
  setBtwOverlayContent(lines: FormattedLine[]): void {
    if (this.btwOverlayLines.length === lines.length) {
      let identical = true;
      for (let i = 0; i < lines.length; i++) {
        if (this.btwOverlayLines[i] !== lines[i]) {
          identical = false;
          break;
        }
      }
      if (identical) {
        return;
      }
    }
    this.btwOverlayLines = [...lines];
    this.scheduleRepaint();
  }

  // Update the overlay's status label and style. The label is rendered in
  // the header ("── btw [<label>] ──") and the `style` drives the colour:
  // running → yellow, done → green, cancelled → dim, errored → red.
  setBtwOverlayStatus(s: { label: string; style: "busy" | "done" | "cancelled" | "errored" }): void {
    const sameLabel = this.btwOverlayLabel === s.label;
    const sameStyle = this.btwOverlayStatus === s.style;
    if (sameLabel && sameStyle) {
      return;
    }
    this.btwOverlayLabel = s.label;
    this.btwOverlayStatus = s.style;
    this.scheduleRepaint();
  }

  // Close the overlay pane, returning layout to its default state.
  // Content (lines, meta, status) is intentionally PRESERVED so a
  // subsequent `/btw` with no args can re-summon the same pane without
  // losing its scrollback. A fresh `/btw <prompt>` clears it via
  // openBtwOverlay().
  closeBtwOverlay(): void {
    if (!this.btwOverlayOpen) {
      return;
    }
    this.btwOverlayOpen = false;
    this.focusedPane = "main";
    this.scheduleRepaint();
  }

  // Re-show a previously-closed overlay pane along with its retained
  // content. Returns true if there was something to reopen, false if no
  // prior /btw has populated the buffer in this session.
  reopenBtwOverlay(): boolean {
    if (this.btwOverlayOpen) {
      return true;
    }
    if (this.btwOverlayLines.length === 0) {
      return false;
    }
    this.btwOverlayOpen = true;
    this.focusedPane = "btw";
    this.scheduleRepaint();
    return true;
  }

  hasBtwOverlayHistory(): boolean {
    return this.btwOverlayLines.length > 0;
  }

  // Toggle which pane is focused (main ↔ btw). Only has a visual effect
  // when the overlay is open — the focus indicator on the header flips.
  toggleFocusedPane(): void {
    this.focusedPane = this.focusedPane === "main" ? "btw" : "main";
    this.scheduleRepaint();
  }

  getFocusedPane(): "main" | "btw" {
    return this.focusedPane;
  }

  isOverlayOpen(): boolean {
    return this.btwOverlayOpen;
  }

  // Slash-command completion list shown directly above the separator. App
  // calls this after each keystroke; pass [] to dismiss. Suppressed when
  // the permission modal is active (the modal owns the prompt area).
  setCompletions(items: CompletionItem[]): void {
    const same =
      items.length === this.completions.length &&
      items.every((c, i) => {
        const prev = this.completions[i];
        return (
          prev !== undefined &&
          prev.name === c.name &&
          prev.description === c.description
        );
      });
    if (same) {
      return;
    }
    this.completions = [...items];
    this.repaint();
  }

  // Adds a blank spacer line to the scrollback, but only if scrollback is
  // non-empty and the last "real" line isn't already a spacer. Idempotent
  // so callers can request it freely at turn boundaries. When a sticky
  // block sits at the tail, the separator is inserted directly above it
  // and the "is there already a separator" check looks at the line above
  // the sticky block instead of the array tail. The sticky block's own
  // first line (if blank) doesn't count: that blank floats with the
  // plan to its eventual tail position, and the separator we're adding
  // here is for whatever content is *about* to be appended (which will
  // land at sticky.start and push the plan back via moveStickyToEnd).
  // `bodyStyle` tags the inserted blank so a draw-time filter can drop it
  // together with the block it precedes. Thoughts pass "thought" so the ^T
  // hide-thoughts filter removes the gap above a hidden thought instead of
  // leaving an orphaned blank line in scrollback.
  ensureSeparator(bodyStyle?: Style): void {
    if (this.lines.length === 0) {
      return;
    }
    const sticky =
      this.stickyBottomKey !== null
        ? this.keyedBlocks.get(this.stickyBottomKey)
        : undefined;
    const stickyAtEnd =
      sticky !== undefined &&
      sticky.start + sticky.count === this.lines.length;
    const probeIdx = stickyAtEnd
      ? (sticky as { start: number }).start - 1
      : this.lines.length - 1;
    if (probeIdx < 0) {
      return;
    }
    const probe = this.lines[probeIdx];
    if (probe && probe.body === "" && (probe.prefix === undefined || probe.prefix === "")) {
      return;
    }
    const sep: FormattedLine = { body: "" };
    if (bodyStyle !== undefined) {
      sep.bodyStyle = bodyStyle;
    }
    if (stickyAtEnd) {
      this.lines.splice((sticky as { start: number }).start, 0, sep);
      (sticky as { start: number }).start += 1;
    } else {
      this.lines.push(sep);
    }
    this.trackLine(sep);
    this.streamingActive = false;
    this.adjustScrollForRowChange(this.wrappedRowsOf(sep));
    this.trimScrollback();
    this.scheduleRepaint();
  }

  // The dispatcher is the source of truth for prompt state. If the prompt
  // row count changed (alt+enter added a line, backspace joined two), the
  // separator and scrollback bottom shift, so we need a full repaint;
  // otherwise an in-place prompt redraw is enough. (Queued-zone changes
  // already trigger a full repaint via setQueuedPrompts.) Queue-edit
  // navigation may also change which queued row is marked, so check
  // for that and redraw just that zone in-place. Wrap the per-keystroke
  // paint in withSync + hide the cursor so the user doesn't see it walk
  // across the prompt row each frame before snapping back to the typing
  // position; placeCursor + hideCursor(false) restore it at the end.
  refreshPrompt(): void {
    if (this.promptRows() !== this.lastPromptRows) {
      this.repaint();
      return;
    }
    this.syncedPartialRepaint(() => {
      const editingIndex = this.dispatcher.state().queueIndex;
      if (editingIndex !== this.lastQueueEditingIndex) {
        this.lastQueueEditingIndex = editingIndex;
        this.drawQueuedZone();
      }
      this.drawPrompt();
    });
  }

  private handleKey(name: string, data: { isCharacter?: boolean }): void {
    if (data.isCharacter) {
      this.onKey([{ type: "char", ch: name }]);
      return;
    }
    // Keyboard scroll-back navigation. Mouse wheel is handled separately
    // via the "mouse" event channel — see handleMouse.
    if (name === "PAGE_UP") {
      this.scrollBy(this.scrollPageSize());
      return;
    }
    if (name === "PAGE_DOWN") {
      this.scrollBy(-this.scrollPageSize());
      return;
    }
    const mapped = mapKeyName(name);
    if (mapped) {
      this.onKey([{ type: "key", name: mapped }]);
    }
  }

  private handleMouse(name: string, data?: unknown): void {
    // terminal-kit emits MOUSE_WHEEL_{UP,DOWN}, MOUSE_LEFT_BUTTON_*,
    // MOUSE_RIGHT_BUTTON_*, MOUSE_MIDDLE_BUTTON_*, and (with grabInput
    // mouse: "drag") MOUSE_DRAG on the "mouse" event channel, not "key".
    // Wheel events keep their existing scrollback behaviour and are NOT
    // forwarded to onMouse.
    if (name === "MOUSE_WHEEL_UP") {
      this.scrollBy(3);
      return;
    }
    if (name === "MOUSE_WHEEL_DOWN") {
      this.scrollBy(-3);
      return;
    }
    // When the terminal window doesn't have keyboard focus, drop every
    // button-related mouse event. The click that's about to give us
    // focus shouldn't also fire a banner action / block click /
    // selection start. Motion and drag still flow through so the
    // pointer-shape diff stays accurate. The first FOCUS_IN that
    // follows the focusing click will flip terminalFocused back to
    // true for the next event.
    const FOCUS_GRACE_MS = 200;
    const recentlyFocused =
      this.terminalFocused && Date.now() - this.lastFocusInAt < FOCUS_GRACE_MS;
    const unfocused = this.terminalFocused === false || recentlyFocused;
    if (
      unfocused &&
      (name.endsWith("_PRESSED") ||
        name.endsWith("_RELEASED") ||
        name === "MOUSE_MOTION" ||
        name === "MOUSE_DRAG")
    ) {
      return;
    }
    const cell = this.mouseCell(data);
    // Classify the event for the public onMouse surface. Coordinates are
    // 1-based (terminal-kit native) — see MouseEvent docstring.
    const button = mouseButtonFromEventName(name);
    let kind: MouseEvent["kind"] | null = null;
    if (name === "MOUSE_DRAG" || name === "MOUSE_MOTION") {
      kind = "move";
    } else if (name.endsWith("_PRESSED")) {
      kind = "press";
    } else if (name.endsWith("_RELEASED")) {
      kind = "release";
    }
    if (kind !== null && cell !== null && this.onMouse) {
      this.onMouse({ kind, button, x: cell.x, y: cell.y, name });
    }
    if (kind === "move") {
      const newHover = cell !== null ? this.bannerHitAt(cell.x, cell.y) : null;
      if (newHover !== this.hoveredBannerHit) {
        this.hoveredBannerHit = newHover;
        this.syncedPartialRepaint(() => this.drawBanner());
      }
    }
    // Update the OS pointer-shape based on what's under the pointer.
    // Any motion/press event with a valid cell drives the diff —
    // releases are skipped because they imply the user just confirmed
    // intent on whatever the press already armed. keyAtRow !== null
    // means the row belongs to a clickable scrollback block; that's
    // exactly the affordance we want to surface.
    if (cell !== null && kind !== "release") {
      const info = this.keyAndSubAtRow(cell.y);
      this.setPointerShape(info !== null ? "pointer" : "default");
      if (kind === "move") {
        const newKey = info?.key ?? null;
        const newSub = info?.sub ?? null;
        if (newKey !== this.hoveredBlockKey || newSub !== this.hoveredSubKey) {
          this.hoveredBlockKey = newKey;
          this.hoveredSubKey = newSub;
          this.hoveredRunKeys =
            newKey !== null && this.onHoverRun
              ? (this.onHoverRun(newKey) ?? null)
              : null;
          this.syncedPartialRepaint(() => this.drawScrollback());
        }
      }
    } else if (
      cell === null &&
      kind === "move" &&
      (this.hoveredBlockKey !== null ||
        this.hoveredSubKey !== null ||
        this.hoveredRunKeys !== null)
    ) {
      this.hoveredBlockKey = null;
      this.hoveredSubKey = null;
      this.hoveredRunKeys = null;
      this.syncedPartialRepaint(() => this.drawScrollback());
    }
    // Left-click on a keyed scrollback block toggles that single block's
    // expand/collapse via the app. We require a full click — press and
    // release on the SAME cell — so a press-drag-release (text selection,
    // even within a single block) never toggles. Only reachable under full
    // mouse capture (wheel-only/selective mode never reports button
    // events). Clicks on unkeyed rows fall through silently.
    if (name === "MOUSE_LEFT_BUTTON_PRESSED") {
      // If a previous click's toggle is still parked in the debounce
      // window AND this new press isn't a same-cell double-click of
      // it, the user has clearly moved on — fire the parked toggle
      // immediately instead of making them wait for the timer. The
      // double-click branch in handleSelectionPress will cancel the
      // pending toggle on its own when the cells match, so we only
      // flush in the "different cell / new gesture" case here.
      const last = this.lastLeftClick;
      const sameCell =
        last !== null &&
        cell !== null &&
        Math.abs(cell.x - last.x) <= DOUBLE_CLICK_MAX_DIST &&
        Math.abs(cell.y - last.y) <= DOUBLE_CLICK_MAX_DIST &&
        Date.now() - last.t <= DOUBLE_CLICK_MAX_MS;
      if (!sameCell) {
        this.flushPendingBlockClick();
      }
      this.pressCell = cell;
      this.handleSelectionPress(cell);
      return;
    }
    // Any non-left press (right/middle) is unambiguously "user moved
    // on": flush so the deferred toggle isn't still in flight when
    // the user, say, opens a context menu or middle-click-pastes.
    if (name.endsWith("_PRESSED") && name !== "MOUSE_LEFT_BUTTON_PRESSED") {
      this.flushPendingBlockClick();
    }
    if (name === "MOUSE_DRAG" && cell !== null) {
      this.handleSelectionDrag(cell);
      return;
    }
    if (
      name === "MOUSE_LEFT_BUTTON_RELEASED" ||
      name === "MOUSE_BUTTON_RELEASED"
    ) {
      const press = this.pressCell;
      this.pressCell = null;
      const selectionFinalize = this.inAppSelectionEnabled &&
        (this.selectionDragStarted || this.doubleClickPending);
      if (
        this.onBlockClick &&
        press !== null &&
        cell !== null &&
        cell.x === press.x &&
        cell.y === press.y &&
        !selectionFinalize
      ) {
        const key = this.keyAtRow(cell.y);
        if (key !== null) {
          // Scan upward to find the block's top row so we can report a
          // 0-based offset within the block. Relies on the invariant
          // that a given key occupies a contiguous run of rows.
          let firstRowY = cell.y;
          while (firstRowY > 1 && this.keyAtRow(firstRowY - 1) === key) {
            firstRowY -= 1;
          }
          this.schedulePendingBlockClick(key, cell.y - firstRowY);
        }
      }
      this.handleSelectionRelease(cell);
    }
  }

  // Left-button-press half of the selection gesture. Resolves the press
  // cell to a source anchor when the in-app selection feature is on
  // and qualifies a double-click candidate by comparing against the
  // previous release timestamp/cell. A double-click on an ASCII word
  // character immediately snaps the selection to that word's
  // boundaries; double-click on whitespace/punctuation is a no-op and
  // falls through to plain-click semantics. Bypassed entirely when the
  // feature is disabled so the existing wheel/block-click behaviour
  // stays unchanged.
  private handleSelectionPress(cell: { x: number; y: number } | null): void {
    this.selectionAnchor = null;
    this.selectionDragStarted = false;
    this.doubleClickPending = false;
    if (!this.inAppSelectionEnabled || cell === null) {
      return;
    }
    const anchor = this.resolveCellToSource(cell.x, cell.y);
    if (anchor === null) {
      // Press outside the scrollback area (banner, prompt, etc.) —
      // don't anchor; a drag from here can't produce a coherent
      // selection. Still dismiss any prior selection on the upcoming
      // release via the dragStarted=false path.
      this.lastLeftClick = null;
      return;
    }
    this.selectionAnchor = anchor;
    const now = Date.now();
    const last = this.lastLeftClick;
    const isDoubleClickCandidate =
      last !== null &&
      now - last.t <= DOUBLE_CLICK_MAX_MS &&
      Math.abs(cell.x - last.x) <= DOUBLE_CLICK_MAX_DIST &&
      Math.abs(cell.y - last.y) <= DOUBLE_CLICK_MAX_DIST;
    if (isDoubleClickCandidate) {
      // Any pending single-click toggle on the same cell is moot —
      // either we're about to open a file or word-snap, both of which
      // supersede the toggle. Cancel before either path runs so the
      // block doesn't flicker open/closed behind the gesture.
      this.cancelPendingBlockClick();
      // Block-level override: if the press landed on a keyed block and
      // the app supplies onBlockDoubleClick, give it first refusal.
      // The app has authoritative knowledge of what each block carries
      // (a tool's recorded file path, an edit-diff target) which beats
      // scraping the rendered row text. Return true claims the gesture.
      if (this.onBlockDoubleClick && cell !== null) {
        const blockKey = this.keyAtRow(cell.y);
        if (blockKey !== null) {
          let firstRowY = cell.y;
          while (firstRowY > 1 && this.keyAtRow(firstRowY - 1) === blockKey) {
            firstRowY -= 1;
          }
          const rowOffset = cell.y - firstRowY;
          if (this.onBlockDoubleClick(blockKey, rowOffset)) {
            // Mark the gesture as a double-click finalize so the
            // upcoming release skips scheduling a fresh block toggle.
            // Without this, the second release re-enters
            // schedulePendingBlockClick and the block expands ~500ms
            // after the file opens.
            this.doubleClickPending = true;
            this.lastLeftClick = null;
            return;
          }
        }
      }
      // Try the open-file gesture first: when the click landed on a
      // filesystem-path token, hand it to the configured editor command
      // and skip the word-snap/clipboard path entirely. When the token
      // isn't a file (or no command is configured) fall through to the
      // existing word-snap copy behaviour so the gesture remains useful.
      if (this.tryOpenFileAt(anchor)) {
        // See onBlockDoubleClick branch above — flag this as a
        // finalized double-click so the second release doesn't
        // schedule a delayed block toggle behind the opened file.
        this.doubleClickPending = true;
        this.lastLeftClick = null;
        return;
      }
      const word = this.wordBoundsAt(anchor);
      if (word !== null) {
        this.setSelection(
          { sourceLineId: anchor.sourceLineId, offset: word.start },
          { sourceLineId: anchor.sourceLineId, offset: word.end },
        );
        this.doubleClickPending = true;
      }
      // Reset chain so a triple-click is treated as a fresh single
      // click rather than another double — keeps the gesture simple
      // and predictable.
      this.lastLeftClick = null;
    }
  }

  // Drag-motion half of the gesture: extends the selection from the
  // recorded anchor to the cell currently under the pointer. Honors
  // the feature flag and ignores motion that doesn't resolve into the
  // scrollback area (e.g. drag into the prompt row).
  private handleSelectionDrag(cell: { x: number; y: number }): void {
    if (!this.inAppSelectionEnabled || this.selectionAnchor === null) {
      return;
    }
    if (this.doubleClickPending) {
      // A drag during a double-click would muddle the word-snap; the
      // word-grab gesture is intentionally release-only here.
      return;
    }
    const focus = this.resolveCellToSource(cell.x, cell.y);
    if (focus === null) {
      return;
    }
    this.selectionDragStarted = true;
    this.setSelection(this.selectionAnchor, focus);
  }

  // Release half of the gesture. Finalizes (extract + clipboard +
  // notify) when a real drag occurred or a word-grab double-click is
  // pending; otherwise treats the gesture as a plain click and
  // dismisses any prior selection. Always records the release for the
  // next press's double-click timing check.
  private handleSelectionRelease(cell: { x: number; y: number } | null): void {
    const dragStarted = this.selectionDragStarted;
    const doubleClick = this.doubleClickPending;
    this.selectionAnchor = null;
    this.selectionDragStarted = false;
    this.doubleClickPending = false;
    if (cell !== null) {
      this.lastLeftClick = { x: cell.x, y: cell.y, t: Date.now() };
    }
    if (!this.inAppSelectionEnabled) {
      return;
    }
    if (dragStarted || doubleClick) {
      this.finalizeSelection();
      return;
    }
    // Plain click (no drag, no word-grab): per spec, dismiss any prior
    // selection. Block-click toggle already ran above.
    if (this.selection !== null) {
      this.clearSelection();
    }
  }

  // ASCII word-boundary scan around the given source-line offset. Walks
  // left and right while ASCII_WORD_RE matches, returning the half-open
  // range [start, end). Returns null when the line is not in scrollback,
  // when the body is ANSI-escaped (offsets would be unreliable), or
  // when the character at the offset isn't a word character — matching
  // the spec's "double-click on whitespace/punctuation does nothing
  // beyond a normal click."
  private wordBoundsAt(
    pos: { sourceLineId: number; offset: number },
  ): { start: number; end: number } | null {
    const line = this.lineById(pos.sourceLineId);
    if (line === null || line.ansi) {
      return null;
    }
    const body = line.body ?? "";
    if (body.length === 0) {
      return null;
    }
    // Styled bodies (agent / heading / thought) carry zero-width
    // terminal-kit markup spans like `^Ccode^:`. Scanning the raw body
    // directly lets the `C` from `^C` (and similar style chars) count
    // as a word character, dragging the markup byte into the snapped
    // range. Result: selection contains stray `C` chars and the
    // offset math for rendering the inverse band is off by one. Mirror
    // the markup-strip pattern from pathTokenAt — scan boundaries on
    // the visible-only view, then project them back onto raw offsets.
    const { clean, rawToClean } = stripTkMarkupWithMap(body);
    if (clean.length === 0) {
      return null;
    }
    const cleanOffset =
      rawToClean[Math.min(pos.offset, rawToClean.length - 1)] ?? clean.length;
    let idx = Math.max(0, Math.min(clean.length - 1, cleanOffset));
    if (cleanOffset >= clean.length) {
      idx = clean.length - 1;
    }
    if (!ASCII_WORD_RE.test(clean[idx]!)) {
      return null;
    }
    let cleanStart = idx;
    while (cleanStart > 0 && ASCII_WORD_RE.test(clean[cleanStart - 1]!)) {
      cleanStart--;
    }
    let cleanEnd = idx + 1;
    while (cleanEnd < clean.length && ASCII_WORD_RE.test(clean[cleanEnd]!)) {
      cleanEnd++;
    }
    // Project clean indices back to raw offsets. The first raw index
    // whose rawToClean value equals cleanStart is the visible char's
    // position in the raw body; for cleanEnd we want the position past
    // the last visible char (i.e. the first raw index mapping to
    // cleanEnd, which sits at the boundary after the word and before
    // any trailing markup).
    let start = body.length;
    let end = body.length;
    for (let r = 0; r < rawToClean.length; r++) {
      if (rawToClean[r] === cleanStart && start === body.length) {
        start = r;
      }
      if (rawToClean[r] === cleanEnd && end === body.length) {
        end = r;
        break;
      }
    }
    return { start, end };
  }

  // Scan a path-like token around the given source-line offset. Walks
  // left/right while PATH_TOKEN_RE matches, then peeks at the trailing
  // ":<digits>" (and optional ":<digits>") suffix used by most compiler
  // / grep / stack-trace output. Returns the raw token text and an
  // optional line number, or null when the click landed off the
  // scrollback or on a non-path character.
  private pathTokenAt(
    pos: { sourceLineId: number; offset: number },
  ): { raw: string; line: number | null } | null {
    const line = this.lineById(pos.sourceLineId);
    if (line === null || line.ansi) {
      return null;
    }
    const rawBody = line.body ?? "";
    if (rawBody.length === 0) {
      return null;
    }
    // Styled bodies (agent/thought/etc.) carry zero-width terminal-kit
    // markup spans like `^Csrc/foo.ts^:` for inline `code`. Scanning
    // the raw body directly lets the `C` in `^C` slip into the path
    // token (it matches [A-Z]), and the result resolves to a bogus
    // path. Strip markup to a clean view and project the click offset
    // through, then scan there. For plain bodies this is a no-op
    // (stripTkMarkup returns the input unchanged when no `^` is
    // present).
    const { clean, rawToClean } = stripTkMarkupWithMap(rawBody);
    if (clean.length === 0) {
      return null;
    }
    const cleanOffset = rawToClean[Math.min(pos.offset, rawToClean.length - 1)] ?? clean.length;
    // Inline-markdown link sidecar: if the click landed inside a
    // [text](url) span, hand back the URL as the token. The render
    // dropped the markdown syntax so the text alone (often a relative
    // path) wouldn't resolve to the right file via cwd; the URL is
    // the authoritative pointer. file:// URLs collapse to their
    // absolute path here so the downstream stat/spawn path treats
    // them like any other absolute token.
    if (line.links) {
      for (const link of line.links) {
        if (cleanOffset >= link.start && cleanOffset < link.end) {
          const url = link.url;
          const raw = url.startsWith("file://") ? url.slice("file://".length) : url;
          return { raw, line: null };
        }
      }
    }
    let idx = Math.max(0, Math.min(clean.length - 1, cleanOffset));
    if (cleanOffset >= clean.length) {
      idx = clean.length - 1;
    }
    if (!PATH_TOKEN_RE.test(clean[idx]!)) {
      return null;
    }
    let start = idx;
    while (start > 0 && PATH_TOKEN_RE.test(clean[start - 1]!)) {
      start--;
    }
    let end = idx + 1;
    while (end < clean.length && PATH_TOKEN_RE.test(clean[end]!)) {
      end++;
    }
    let raw = clean.slice(start, end);
    // Strip trailing punctuation that's commonly adjacent to a path but
    // not part of it (period at end of sentence, etc.).
    raw = raw.replace(/[.]+$/, "");
    if (raw.length === 0) {
      return null;
    }
    let lineNum: number | null = null;
    // Optional ":<digits>" (and optional second ":<digits>") suffix.
    const suffix = clean.slice(end).match(/^:(\d+)(?::\d+)?/);
    if (suffix) {
      lineNum = Number.parseInt(suffix[1]!, 10);
    }
    return { raw, line: lineNum };
  }

  // Resolve a token to an existing absolute filesystem path, or null if
  // Resolve a path-shaped token to an absolute filesystem path. Two
  // tiers, depending on how unambiguous the token's "I am a path"
  // signal is:
  //
  //   Strong signal — absolute (/etc/hosts) or home-relative (~/foo):
  //     accept without stat-checking. The user clearly named a file,
  //     even if it doesn't exist yet. Letting non-existent paths through
  //     lets editors open a new buffer (the standard "create new file"
  //     flow), which matches how `code ~/notes/draft.md` works from a
  //     shell.
  //
  //   Weak signal — cwd-relative with a slash (src/foo):
  //     require statSync to succeed and report a regular file. Slashy
  //     non-paths are common in chat ("react/server-components",
  //     "agent/role"); without existence-gating we'd spawn an editor
  //     buffer for each one.
  //
  // Returns the absolute path on success, null when the token isn't
  // path-shaped enough or fails the weak-signal existence check.
  private resolvePathToken(raw: string): string | null {
    let expanded = raw;
    if (expanded === "~" || expanded.startsWith("~/")) {
      expanded = expanded === "~" ? homedir() : `${homedir()}/${expanded.slice(2)}`;
    }
    const strongSignal = isAbsolute(expanded) || raw.startsWith("~");
    const hasSeparator = expanded.includes("/");
    if (!strongSignal && !hasSeparator) {
      return null;
    }
    const base = isAbsolute(expanded)
      ? expanded
      : resolvePath(this.sessionbar.cwd, expanded);
    if (strongSignal) {
      return base;
    }
    try {
      const st = statSync(base);
      if (st.isFile()) {
        return base;
      }
    } catch {
      return null;
    }
    return null;
  }

  // Returns true when the click resolved to a real file and the
  // configured editor command was dispatched (whether or not the spawn
  // ultimately succeeds — failure is reported asynchronously via
  // notify()). Returns false to let the caller fall through to the
  // word-snap selection path.
  private tryOpenFileAt(
    pos: { sourceLineId: number; offset: number },
  ): boolean {
    if (this.openFileCommand === null) {
      return false;
    }
    const token = this.pathTokenAt(pos);
    if (token === null) {
      return false;
    }
    const suffix = token.line === null ? "" : `:${token.line}`;
    return this.tryOpenPathString(token.raw + suffix);
  }

  // Public entrypoint shared by the in-line word-click path and the
  // app's block double-click handler (which feeds an authoritative
  // token, e.g. a tool's detailFull path, instead of scraping it from
  // rendered text). Parses an optional `:<line>` / `:<line>:<col>`
  // suffix, resolves the bare path against cwd / ~, stat-checks it,
  // and spawns the configured command with %f / %n substitution.
  // Returns true iff a real file was resolved AND a spawn was attempted
  // (failures of the spawn itself surface via notify, not the return
  // value). Returns false when the feature is disabled, the token isn't
  // path-shaped, or no such file exists — so callers can fall through.
  tryOpenPathString(raw: string): boolean {
    if (this.openFileCommand === null) {
      return false;
    }
    let bare = raw;
    let lineNum: number | null = null;
    // Accept "path:line" and "path:line:col"; the column is ignored.
    const m = raw.match(/^(.*?):(\d+)(?::\d+)?$/);
    if (m) {
      bare = m[1]!;
      lineNum = Number.parseInt(m[2]!, 10);
    }
    const file = this.resolvePathToken(bare);
    if (file === null) {
      return false;
    }
    const lineStr = lineNum === null ? "" : String(lineNum);
    const [program, ...rest] = this.openFileCommand;
    if (!program) {
      return false;
    }
    let sawFilePlaceholder = false;
    const args: string[] = [];
    for (const arg of rest) {
      if (arg.includes("%f")) {
        sawFilePlaceholder = true;
      }
      // Drop args that reference %n when no line number is known —
      // otherwise a placeholder like "+%n" collapses to bare "+" and
      // emacsclient (and most editors) treat it as a filename. Args
      // that only carry %f or literal text still flow through.
      if (lineStr === "" && arg.includes("%n")) {
        continue;
      }
      args.push(arg.replaceAll("%f", file).replaceAll("%n", lineStr));
    }
    if (!sawFilePlaceholder) {
      args.push(file);
    }
    try {
      const child = spawn(program, args, {
        detached: true,
        stdio: "ignore",
        cwd: this.sessionbar.cwd,
      });
      child.on("error", (err) => {
        this.notify(`open file failed: ${(err as Error).message}`);
      });
      child.unref();
      const where = lineNum === null ? file : `${file}:${lineNum}`;
      this.notify(`opening ${where}`);
    } catch (err) {
      this.notify(`open file failed: ${(err as Error).message}`);
    }
    return true;
  }

  // Defer a block toggle by DOUBLE_CLICK_MAX_MS so a follow-up click on
  // the same cell can intercept the gesture (open-file under the cursor
  // takes priority over expand/collapse). When the timer fires without
  // a second click intervening the toggle runs unchanged. Replaces any
  // earlier pending toggle — if a press lands on a new cell before the
  // previous one fired, the previous block was clearly abandoned.
  private schedulePendingBlockClick(key: string, rowOffset: number): void {
    if (!this.onBlockClick) {
      return;
    }
    // No openFileCommand configured → double-click can't open anything,
    // so deferring the toggle would just add lag with no upside. Fire
    // the toggle synchronously, matching the pre-debounce behaviour.
    if (this.openFileCommand === null) {
      this.onBlockClick(key, rowOffset);
      return;
    }
    this.cancelPendingBlockClick();
    const handler = this.onBlockClick;
    const timer = setTimeout(() => {
      this.pendingBlockClick = null;
      handler(key, rowOffset);
    }, DOUBLE_CLICK_MAX_MS);
    // Don't hold the event loop open just for a pending UI toggle;
    // node shouldn't wait on this when the rest of the app has settled.
    if (typeof timer.unref === "function") {
      timer.unref();
    }
    this.pendingBlockClick = { timer, key, rowOffset };
  }

  // Clear any pending block-click toggle without firing it. Called when
  // a double-click is detected on the same cell (the second click is
  // about to do something else) and at teardown so a stray timer can't
  // poke at a stopped Screen.
  private cancelPendingBlockClick(): void {
    if (this.pendingBlockClick === null) {
      return;
    }
    clearTimeout(this.pendingBlockClick.timer);
    this.pendingBlockClick = null;
  }

  // Fire any deferred toggle immediately and clear the pending slot.
  // Used as a "the user moved on" shortcut: when the next press lands
  // on a different cell (i.e. clearly not a double-click of the prior
  // one), we don't want to make them wait out the remainder of the
  // debounce window before the first block reacts. Terminals only
  // emit motion while a button is held (xterm ?1002), so the next
  // press is the earliest signal we get that the previous click
  // wasn't going to become a double.
  private flushPendingBlockClick(): void {
    const pending = this.pendingBlockClick;
    if (pending === null) {
      return;
    }
    clearTimeout(pending.timer);
    this.pendingBlockClick = null;
    if (this.onBlockClick) {
      this.onBlockClick(pending.key, pending.rowOffset);
    }
  }

  // Reverse lookup: source line id → FormattedLine. O(n) over the
  // scrollback array; only used by infrequent gesture paths (double-
  // click word snap, selection-text extraction), so a Set/Map mirror
  // would be overkill here.
  private lineById(sourceLineId: number): FormattedLine | null {
    for (const line of this.lines) {
      if (this.lineIds.get(line) === sourceLineId) {
        return line;
      }
    }
    return null;
  }

  // Display-order index of the line carrying `sourceLineId`, or -1. Used
  // to order/bound the selection by on-screen position rather than by raw
  // id (ids are reassigned on re-render and aren't monotonic with order).
  private lineIndexById(sourceLineId: number): number {
    for (let i = 0; i < this.lines.length; i++) {
      const line = this.lines[i];
      if (line && this.lineIds.get(line) === sourceLineId) {
        return i;
      }
    }
    return -1;
  }

  // Hand a finalized selection to the system clipboard and surface a
  // brief notification indicating how much was captured. Fire-and-
  // forget: the gesture stays responsive; failures are reported via
  // notify() so the user knows when nothing landed. The highlight is
  // left on screen after copy — the user can scroll and inspect the
  // captured range, then dismiss it with any keystroke.
  private finalizeSelection(): void {
    const text = this.getSelectionText();
    if (text.length === 0) {
      // Could happen when the selection's source lines were pruned
      // between drag and release — silently do nothing.
      return;
    }
    void writeClipboard(text, { target: this.selectionClipboard }).then(
      (result) => {
        if (result.ok) {
          const chars = text.length;
          this.notify(
            `copied ${chars} char${chars === 1 ? "" : "s"} to clipboard`,
          );
        } else {
          this.notify(`clipboard copy failed: ${result.reason}`);
        }
      },
      (err) => {
        this.notify(`clipboard copy failed: ${(err as Error).message}`);
      },
    );
  }

  // Extract the 1-based {x, y} cell from a terminal-kit mouse event's data
  // payload, or null if absent/malformed.
  private mouseCell(data: unknown): { x: number; y: number } | null {
    if (!data || typeof data !== "object") {
      return null;
    }
    const d = data as { x?: unknown; y?: unknown };
    const x = Number(d.x);
    const y = Number(d.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return null;
    }
    return { x, y };
  }

  // Diffed write of the OS pointer-shape (OSC 22). Best-effort: the
  // sequence is honored by xterm, kitty, wezterm, ghostty, foot — other
  // terminals silently no-op. We only emit on transitions to keep the
  // wire quiet on every hover-cell crossing.
  private setPointerShape(shape: "default" | "pointer"): void {
    if (shape === this.currentPointerShape) {
      return;
    }
    this.currentPointerShape = shape;
    process.stdout.write(
      shape === "pointer" ? POINTER_SHAPE_POINTER : POINTER_SHAPE_DEFAULT,
    );
  }

  // Map a 1-based terminal row to the key of the block whose line is
  // painted there, or null. Mirrors drawScrollback's row→line mapping:
  // the same wrapTail slice and bottom-anchored padding, then reads the
  // blockKey stamped on the wrapped chunk. Reading the stamp (rather than
  // scanning keyedBlocks) means a click resolves even on a frozen block
  // whose key was already forgotten via clearKey — the line stays painted
  // and carries its stamp. Returns null for padding rows, rows outside
  // the scrollback area, or plainly-appended (unkeyed) lines.
  private keyAtRow(y: number): string | null {
    const w = this.term.width;
    const top = 1;
    const visibleRows = this.scrollbackVisibleRows();
    if (visibleRows <= 0) {
      return null;
    }
    const rowIdx = y - top;
    if (rowIdx < 0 || rowIdx >= visibleRows) {
      return null;
    }
    const { rows: wrapped } = this.wrapTail(w, visibleRows + this.scrollOffset);
    const end = wrapped.length - this.scrollOffset;
    const start = Math.max(0, end - visibleRows);
    const slice = wrapped.slice(start, end);
    const padTop = Math.max(0, visibleRows - slice.length);
    const sliceIdx = rowIdx - padTop;
    if (sliceIdx < 0 || sliceIdx >= slice.length) {
      return null;
    }
    const clicked = slice[sliceIdx];
    return clicked?.blockKey ?? null;
  }

  // Like keyAtRow but also returns the finer-grained hoverSubKey stamped
  // on the row (when the block opted into per-entry hover scoping). Used
  // by the mouse motion handler to decide which contiguous run of rows
  // brightens together.
  private keyAndSubAtRow(y: number): { key: string; sub: string | null } | null {
    const w = this.term.width;
    const top = 1;
    const visibleRows = this.scrollbackVisibleRows();
    if (visibleRows <= 0) return null;
    const rowIdx = y - top;
    if (rowIdx < 0 || rowIdx >= visibleRows) return null;
    const { rows: wrapped } = this.wrapTail(w, visibleRows + this.scrollOffset);
    const end = wrapped.length - this.scrollOffset;
    const start = Math.max(0, end - visibleRows);
    const slice = wrapped.slice(start, end);
    const padTop = Math.max(0, visibleRows - slice.length);
    const sliceIdx = rowIdx - padTop;
    if (sliceIdx < 0 || sliceIdx >= slice.length) return null;
    const clicked = slice[sliceIdx];
    if (!clicked?.blockKey) return null;
    return { key: clicked.blockKey, sub: clicked.hoverSubKey ?? null };
  }

  // Resolve a 1-based terminal cell (x, y) to a stable position in the
  // logical scrollback: the source line's monotonic id and a code-unit
  // offset into that line's body. Returns null for any cell outside the
  // scrollback region (banner, session bar, separators, chip zone,
  // completions, prompt, queued rows, modals) or for padding rows above
  // shorter histories. The mapping is anchored to source content via
  // wrapOrigin (populated by wrapOne), so a position survives scrolling
  // and re-wrapping at a new terminal width — callers can re-resolve
  // the same {sourceLineId, offset} after a repaint and find the same
  // character. Column-to-offset uses the width-aware helper from T2 and
  // snaps inside wide / composed glyphs to their cluster start.
  resolveCellToSource(
    x: number,
    y: number,
  ): { sourceLineId: number; offset: number } | null {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return null;
    }
    const w = this.term.width;
    const top = 1;
    const visibleRows = this.scrollbackVisibleRows();
    if (visibleRows <= 0) {
      return null;
    }
    const rowIdx = y - top;
    if (rowIdx < 0 || rowIdx >= visibleRows) {
      return null;
    }
    if (x < 1 || x > w) {
      return null;
    }
    const { rows: wrapped } = this.wrapTail(w, visibleRows + this.scrollOffset);
    const end = wrapped.length - this.scrollOffset;
    const start = Math.max(0, end - visibleRows);
    const slice = wrapped.slice(start, end);
    const padTop = Math.max(0, visibleRows - slice.length);
    const sliceIdx = rowIdx - padTop;
    if (sliceIdx < 0 || sliceIdx >= slice.length) {
      return null;
    }
    const chunk = slice[sliceIdx];
    if (!chunk) {
      return null;
    }
    const origin = this.wrapOrigin.get(chunk);
    if (!origin) {
      return null;
    }
    const prefixCols = cellWidth(chunk.prefix ?? "");
    const colInBody = x - 1 - prefixCols;
    if (colInBody < 0) {
      // Click landed in the gutter / continuation indent: anchor to the
      // chunk's start in the source rather than reporting non-selectable.
      return { sourceLineId: origin.sourceLineId, offset: origin.sourceColOffset };
    }
    // Styled bodies (agent / thoughts / headings) carry zero-width
    // caret-markup spans. The pure column→offset helper has no notion
    // of markup, so feed it a pre-segmented stream where `^X` / `^[...]`
    // spans are tagged as zero-width — the offset then lands at a
    // segment boundary and never inside a styling sequence. Plain
    // bodies stay on the grapheme-only fast path.
    const localOffset = bodyStyleUsesMarkup(chunk.bodyStyle)
      ? columnToOffsetFromSegments(segmentForWidth(chunk.body), colInBody)
      : columnToOffset(chunk.body, colInBody);
    return {
      sourceLineId: origin.sourceLineId,
      offset: origin.sourceColOffset + localOffset,
    };
  }

  scrollBy(delta: number): void {
    if (delta === 0) {
      return;
    }
    // Manual scroll (wheel / PgUp / PgDn) while a scrollback search is
    // engaged is taken as "I'm done searching, let me look around" —
    // accept the current match position and leave search mode so the
    // scroll itself takes effect on a clean state.
    if (this.scrollbackSearch !== null) {
      this.acceptScrollbackSearch();
    }
    const max = this.maxScrollOffset();
    const next = Math.min(max, Math.max(0, this.scrollOffset + delta));
    if (next === this.scrollOffset) {
      return;
    }
    this.scrollOffset = next;
    this.repaint();
  }

  scrollToBottom(): void {
    if (this.scrollbackSearch !== null) {
      this.acceptScrollbackSearch();
    }
    if (this.scrollOffset === 0) {
      return;
    }
    this.scrollOffset = 0;
    this.repaint();
  }

  scrollToTop(): void {
    if (this.scrollbackSearch !== null) {
      this.acceptScrollbackSearch();
    }
    const max = this.maxScrollOffset();
    if (this.scrollOffset === max) {
      return;
    }
    this.scrollOffset = max;
    this.repaint();
  }

  // True iff the user is scrolled above the live tail — gates the
  // app-level decision of whether ^r engages scrollback search vs.
  // prompt-history search.
  isScrolledBack(): boolean {
    return this.scrollOffset > 0;
  }

  // True iff a scrollback search is currently active. Used by the app
  // to decide whether to keep routing keys into search vs. the prompt
  // dispatcher.
  isScrollbackSearchActive(): boolean {
    return this.scrollbackSearch !== null;
  }

  // Engage scrollback reverse-search. Captures the current scroll
  // position so cancel can restore it, and seeds an empty search term
  // (the prompt row renders the search input immediately so the user
  // sees the entry). Idempotent: no-op when already active.
  enterScrollbackSearch(): void {
    if (this.scrollbackSearch !== null) {
      return;
    }
    this.scrollbackSearch = {
      term: "",
      matchIndex: 0,
      matches: [],
      baselineScroll: this.scrollOffset,
    };
    this.scrollbackHighlight = null;
    this.repaint();
  }

  // Update the search term and recompute matches. Walks `lines` from
  // the tail (newest) toward the head (oldest), pushing every case-
  // insensitive substring hit. Snaps the viewport to the newest match
  // when found. Called per keystroke; sub-millisecond on typical
  // scrollback sizes.
  updateScrollbackSearchTerm(term: string): void {
    if (this.scrollbackSearch === null) {
      return;
    }
    const lowered = term.toLowerCase();
    const matches: Array<{ lineIdx: number; col: number }> = [];
    if (lowered.length > 0) {
      for (let i = this.lines.length - 1; i >= 0; i--) {
        const line = this.lines[i];
        if (!line || line.body.length === 0) {
          continue;
        }
        // ANSI lines stay excluded — their escape bytes inflate col
        // positions and substring math against the raw body would
        // point at locations that don't line up with what's rendered.
        // Agent lines (caret markup) are included: most chat content
        // is agent-styled, and split-around-match still renders
        // sensibly because the search-highlight span overrides the
        // surrounding markup styling for its few chars.
        if (line.ansi) {
          continue;
        }
        const hay = line.body.toLowerCase();
        // Collect occurrences left-to-right (non-overlapping step),
        // then push to the global match list in reverse so within a
        // single line we walk right-to-left. Rightmost is "newest" by
        // reading order, so as ^r steps backward through scrollback
        // we visit it first before going further back on the same line.
        const lineCols: number[] = [];
        let pos = 0;
        while (pos < hay.length) {
          const found = hay.indexOf(lowered, pos);
          if (found === -1) {
            break;
          }
          lineCols.push(found);
          pos = found + lowered.length;
        }
        for (let j = lineCols.length - 1; j >= 0; j--) {
          matches.push({ lineIdx: i, col: lineCols[j]! });
        }
      }
    }
    this.scrollbackSearch.term = term;
    this.scrollbackSearch.matches = matches;
    this.scrollbackSearch.matchIndex = 0;
    this.scrollbackHighlight = lowered.length > 0 ? lowered : null;
    if (matches.length > 0) {
      this.scrollToMatch(matches[0]!);
    }
    this.repaint();
  }

  // Advance to the next-older match (called for repeated ^r). Stops at
  // the oldest match (does not wrap). No-op when there are no matches
  // or search is inactive.
  advanceScrollbackSearch(): void {
    if (this.scrollbackSearch === null || this.scrollbackSearch.matches.length === 0) {
      return;
    }
    const nextIdx = Math.min(
      this.scrollbackSearch.matches.length - 1,
      this.scrollbackSearch.matchIndex + 1,
    );
    if (nextIdx === this.scrollbackSearch.matchIndex) {
      return;
    }
    this.scrollbackSearch.matchIndex = nextIdx;
    this.scrollToMatch(this.scrollbackSearch.matches[nextIdx]!);
    this.repaint();
  }

  // Retreat to the previous (newer) match — ^s forward-search. Stops
  // at the newest match (no wrap).
  retreatScrollbackSearch(): void {
    if (this.scrollbackSearch === null || this.scrollbackSearch.matches.length === 0) {
      return;
    }
    if (this.scrollbackSearch.matchIndex === 0) {
      return;
    }
    this.scrollbackSearch.matchIndex -= 1;
    this.scrollToMatch(this.scrollbackSearch.matches[this.scrollbackSearch.matchIndex]!);
    this.repaint();
  }

  // Exit search keeping the viewport at the current match. Highlight is
  // cleared so subsequent scrollback content reads normally.
  acceptScrollbackSearch(): void {
    if (this.scrollbackSearch === null) {
      return;
    }
    this.scrollbackSearch = null;
    this.scrollbackHighlight = null;
    this.repaint();
  }

  // Exit search and restore the viewport to where the user was when
  // they engaged search.
  cancelScrollbackSearch(): void {
    if (this.scrollbackSearch === null) {
      return;
    }
    const baseline = this.scrollbackSearch.baselineScroll;
    this.scrollbackSearch = null;
    this.scrollbackHighlight = null;
    this.scrollOffset = baseline;
    this.repaint();
  }

  scrollbackSearchTerm(): string {
    return this.scrollbackSearch?.term ?? "";
  }

  // Source-line identity + col + term length for whichever match is
  // currently selected (advanced via ^r / retreated via ^s). Used by
  // drawScrollback to give the current match a distinct highlight
  // style without disturbing the bulk-highlight on the other matches.
  private currentMatchInfo(): { lineId: number; col: number; length: number } | null {
    if (this.scrollbackSearch === null || this.scrollbackSearch.matches.length === 0) {
      return null;
    }
    const match = this.scrollbackSearch.matches[this.scrollbackSearch.matchIndex];
    if (!match) {
      return null;
    }
    const sourceLine = this.lines[match.lineIdx];
    if (!sourceLine) {
      return null;
    }
    const lineId = this.lineIds.get(sourceLine);
    if (lineId === undefined) {
      return null;
    }
    return {
      lineId,
      col: match.col,
      length: this.scrollbackSearch.term.length,
    };
  }

  // If `line` is the wrapped chunk that contains the active match,
  // returns the col within the chunk's body where the match starts;
  // otherwise null. The chunk's source identity comes from
  // this.wrapOrigin which wrapOne populates for every wrapped chunk.
  private activeMatchCol(
    line: FormattedLine | undefined,
    info: { lineId: number; col: number; length: number } | null,
  ): number | null {
    if (!line || info === null) {
      return null;
    }
    const origin = this.wrapOrigin.get(line);
    if (!origin || origin.sourceLineId !== info.lineId) {
      return null;
    }
    const colInChunk = info.col - origin.sourceColOffset;
    if (colInChunk < 0 || colInChunk >= line.body.length) {
      return null;
    }
    return colInChunk;
  }

  // Position scrollOffset so the wrapped row containing the given
  // (lineIdx, col) lands on a visible row of the scrollback viewport.
  // Walks wrapTail to count wrapped rows between the target line and
  // the tail.
  private scrollToMatch(match: { lineIdx: number; col: number }): void {
    const w = this.term.width;
    const visibleRows = this.scrollbackVisibleRows();
    if (visibleRows <= 0) {
      return;
    }
    // Sum wrapped rows from the tail down to (and including) the match
    // line. Then add the wrapped-row offset *within* the match line
    // that contains the match column.
    let rowsBelowMatchLine = 0;
    for (let i = this.lines.length - 1; i > match.lineIdx; i--) {
      const line = this.lines[i];
      if (!line) {
        continue;
      }
      rowsBelowMatchLine += this.wrapOne(line, w).length;
    }
    const matchLine = this.lines[match.lineIdx];
    let rowsWithinMatchLine = 0;
    if (matchLine) {
      const wrapped = this.wrapOne(matchLine, w);
      let consumed = 0;
      for (let r = 0; r < wrapped.length; r++) {
        const piece = wrapped[r];
        if (!piece) {
          continue;
        }
        const bodyLen = piece.body.length;
        if (match.col < consumed + bodyLen) {
          rowsWithinMatchLine = wrapped.length - 1 - r;
          break;
        }
        consumed += bodyLen;
      }
    }
    // Target scrollOffset: place the match row in the middle of the
    // visible scrollback area so the user has context on both sides.
    const target = rowsBelowMatchLine + rowsWithinMatchLine;
    const desired = Math.max(0, target - Math.floor(visibleRows / 2));
    const max = this.maxScrollOffset();
    this.scrollOffset = Math.min(max, desired);
  }

  private scrollPageSize(): number {
    return Math.max(1, this.scrollbackVisibleRows() - 2);
  }

  private scrollbackVisibleRows(): number {
    const top = 1;
    const bottom =
      this.term.height -
      this.promptRows() -
      SESSIONBAR_ROWS -
      BANNER_SEPARATOR_ROWS - // separator between banner and sessionbar
      BANNER_ROWS -
      SEPARATOR_ROWS - // separator above prompt
      this.chipRows() -
      this.queuedRows() -
      this.completionRows() -
      this.btwOverlayRows();
    return Math.max(0, bottom - top + 1);
  }

  private maxScrollOffset(): number {
    const { rows } = this.wrapTail(
      this.term.width,
      Number.POSITIVE_INFINITY,
    );
    return Math.max(0, rows.length - this.scrollbackVisibleRows());
  }

  // Used by content mutators to coalesce rapid updates. Repaints fire
  // at most once per contentRepaintThrottleMs; if a paint happened
  // recently, schedule one for the remainder of the window. Setting the
  // throttle to 0 disables coalescing entirely.
  private scheduleRepaint(): void {
    this.scheduler.schedule();
  }

  // Funnel for every row that any drawX method renders. Skips emitting
  // moveTo + paint when the row's signature matches the previous frame's.
  // The signature must capture everything that affects visible output for
  // that row (width, FormattedLine fields, banner state, etc.) so
  // identical sigs guarantee identical bytes.
  //
  // Order matters: we move, draw the new content over the old, reset SGR,
  // then erase from the cursor to end of line. Erasing BEFORE paint
  // blanks the whole row first — visible as a per-row flash on banner
  // ticks and single-char prompt edits, since some terminals still
  // render incrementally inside DEC 2026 brackets. Overwriting first
  // and erasing only the trailing leftovers means the row is never
  // blank mid-frame. The styleReset stops the trailing erase from
  // inheriting the paint's last SGR (a bgBlue selection slice, etc.)
  // and painting the rest of the line in that colour.
  private paintRow(row: number, signature: string, paint: () => void): void {
    if (!this.started) {
      return;
    }
    this.painter.paintRow(row, signature, paint);
  }

  private repaint(): void {
    if (!this.started) {
      return;
    }
    if (this.repaintPaused > 0) {
      this.repaintPending = true;
      return;
    }
    this.scheduler.noteRepaintStart();
    const w = this.term.width;
    const h = this.term.height;
    if (w < 20 || h < 8) {
      return;
    }
    this.painter.ensureSize(w, h);
    // Wrap the whole frame in DEC 2026 synchronized output so terminals
    // that support it commit every row change atomically. Big repaints
    // (resize, /clear, scrollback scroll, modal open/close) used to land
    // as a row-by-row waterfall; with this bracket they appear as one
    // frame. Unsupported terminals discard the sequence harmlessly —
    // for those we also bracket the paint in hideCursor()/restore so
    // the cursor doesn't visibly bounce between drawX rows during the
    // walk. placeCursor at the end re-asserts visibility for normal /
    // scrollback-search / readonly; modal modes only moveTo, so we
    // re-show explicitly when one of them is active.
    withSync(() => {
      this.term.hideCursor();
      // Don't call term.clear() here. Each draw* method moves to its row
      // and emits eraseLineAfter before writing, so every row is
      // overwritten anyway. The full-screen clear caused a visible
      // black-flash flicker on each repaint because there's a non-trivial
      // gap between clearing and the first row write. (Fullscreen
      // alternate-screen mode means the buffer starts clean; resize
      // triggers a repaint that covers all rows in the new size.)
      this.drawScrollback();
      this.drawBtwOverlay();
      this.drawCompletionZone();
      this.drawQueuedZone();
      this.drawAttachmentChipZone();
      const promptRows = this.promptRows();
      // Stacking from the bottom:
      //   row h            sessionbar
      //   row h-1          separator (between banner and sessionbar)
      //   row h-2          banner
      //   rows above       prompt (promptRows tall)
      //   row above prompt separator
      // Total bottom reservation = promptRows + SEPARATOR_ROWS +
      // BANNER_ROWS + BANNER_SEPARATOR_ROWS + SESSIONBAR_ROWS.
      const separatorAbovePromptRow =
        h - promptRows - BANNER_ROWS - BANNER_SEPARATOR_ROWS - SESSIONBAR_ROWS;
      this.drawSeparator(separatorAbovePromptRow);
      this.drawPrompt();
      this.drawBottomSeparator(h - SESSIONBAR_ROWS);
      this.drawSessionbar();
      this.placeCursor();
      if (
        this.permissionPrompt ||
        this.optionsPrompt ||
        this.confirmPrompt ||
        this.compactionPrompt ||
        this.helpPrompt
      ) {
        this.term.hideCursor(false);
      }
      this.lastPromptRows = promptRows;
    });
  }

  private drawSessionbar(): void {
    // Leave the rightmost column unwritten so painting the bottom row
    // can't trigger an autowrap-induced scroll on terminals that scroll
    // when the last column of the last row is filled. Same -1 convention
    // the picker uses (picker.ts ROW_PREFIX_WIDTH/rowMaxWidth math).
    const w = Math.max(1, this.term.width - 1);
    const row = this.term.height;
    const title = this.sessionbar.title?.trim();
    const agentCell = formatAgentWithModel(this.sessionbar.agent, this.sessionbar.model);
    const cwdDisplay = shortenHomePath(this.sessionbar.cwd);
    const sig = `sbar|${w}|${agentCell}|${cwdDisplay}|${title ?? ""}`;
    this.paintRow(row, sig, () => {
      // Layout: <cwd · title> ........ <agent(model)>
      // agent(model) is right-aligned to the terminal's right edge;
      // cwd + title share whatever room is left on the left, with
      // title getting priority over a long cwd so it always keeps a
      // sliver. Usage / cost lives on the top (prompt-above) separator
      // and the session id lives there too, so they're not painted here.
      const agentWidth = stringWidth(agentCell);
      const minGap = 1;
      const leftRoom = Math.max(0, w - agentWidth - minGap);
      const titleSep = title ? " · " : "";
      const titleSepWidth = stringWidth(titleSep);
      let cwdRoom: number;
      let titleRoom: number;
      if (title) {
        const titleMin = Math.min(title.length, 8);
        cwdRoom = Math.min(
          cwdDisplay.length,
          Math.max(8, leftRoom - titleSepWidth - titleMin),
        );
        titleRoom = Math.max(0, leftRoom - cwdRoom - titleSepWidth);
      } else {
        titleRoom = 0;
        cwdRoom = leftRoom;
      }
      const cwdText = truncate(cwdDisplay, cwdRoom);
      const titleText = title ? truncate(title, titleRoom) : "";
      const leftWidth =
        stringWidth(cwdText) + (title ? titleSepWidth + stringWidth(titleText) : 0);
      const gap = Math.max(minGap, w - leftWidth - agentWidth);
      this.term.bold.noFormat(cwdText);
      if (title) {
        this.term(titleSep).bold.noFormat(titleText);
      }
      this.term(" ".repeat(gap));
      this.term.noFormat(agentCell);
    });
  }

  // Renders the rule above the prompt as a btw-style header carrying
  // ALL of the legacy banner chrome plus the session id. The legacy
  // banner row has been folded into this line, so layout is:
  //
  //   ── <Status>[ <elapsed>] · <sid>[ · N queued][ · ↑N] ───── <right> ──
  //
  // The right slot is either the transient bannerRightContent text
  // (active scrollback search, compaction toast, etc.) painted in its
  // kind colour, or — when nothing transient is active — the dim hint
  // chunks (mode / pick / guide / detach), with click-hit regions
  // recomputed so the same mouse targets still work. Status label
  // colour mirrors the btw header's convention: idle (Ready) paints in
  // the default colour, Busy yellow, Stalled / Disconnected red, Cold
  // magenta. The sid block is omitted when no session id is known.
  private drawSeparator(row: number): void {
    const w = this.term.width;
    const sid = shortId(this.sessionbar.sessionId);
    const status = this.banner.status;
    const stalled = status === "busy" && this.banner.stalled === true;
    let label: string;
    if (stalled) {
      label = "Stalled";
    } else if (status === "busy") {
      label = "Busy";
    } else {
      label = status.charAt(0).toUpperCase() + status.slice(1);
    }
    const elapsedStr =
      status === "busy" &&
      this.banner.elapsedMs !== undefined &&
      this.banner.elapsedMs >= 1000
        ? formatElapsed(this.banner.elapsedMs)
        : "";

    const auxChunks: Array<{ text: string; paint: () => void }> = [];
    if (this.banner.queued > 0) {
      const text = `${this.banner.queued} queued`;
      auxChunks.push({
        text,
        paint: () => {
          this.term.brightYellow(text);
        },
      });
    }
    if (this.scrollOffset > 0) {
      const text = `↑ ${this.scrollOffset}`;
      auxChunks.push({
        text,
        paint: () => {
          this.term.brightCyan(text);
        },
      });
    }

    const usageStr = formatUsage(this.sessionbar.usage) ?? "";

    const left = "── ";
    const elapsedInline = elapsedStr ? ` ${elapsedStr}` : "";
    const sidSep = sid ? " · " : "";
    const padBeforeMiddle = " ";
    const padAfterMiddle = usageStr ? " " : "";
    // No usage → drop the leading space in the closing tail so the
    // row ends flush instead of leaving a stray gap on the right edge.
    const tail = usageStr ? " ──" : "──";

    let leftWidth =
      left.length +
      stringWidth(label) +
      stringWidth(elapsedInline) +
      sidSep.length +
      stringWidth(sid);
    for (const c of auxChunks) {
      leftWidth += stringWidth(" · ") + stringWidth(c.text);
    }
    leftWidth += stringWidth(padBeforeMiddle);

    const rightWidth =
      stringWidth(padAfterMiddle) +
      stringWidth(usageStr) +
      stringWidth(tail);

    const middleCols = Math.max(0, w - leftWidth - rightWidth);
    const middle = "─".repeat(middleCols);

    const sig =
      `sep|${w}|${status}|${stalled ? 1 : 0}|${sid}|${elapsedStr}|` +
      `${this.banner.queued}|${this.scrollOffset}|${usageStr}`;

    this.paintRow(row, sig, () => {
      this.term.bold(left);
      if (stalled || status === "disconnected") {
        this.term.brightRed(label);
      } else if (status === "busy") {
        this.term.brightYellow(label);
      } else if (status === "cold") {
        this.term.brightMagenta(label);
      } else {
        this.term(label);
      }
      if (elapsedInline) {
        if (stalled) {
          this.term.brightRed.noFormat(elapsedInline);
        } else if (status === "busy") {
          this.term.brightYellow.noFormat(elapsedInline);
        } else {
          this.term.dim.noFormat(elapsedInline);
        }
      }
      if (sid) {
        this.term.dim(sidSep);
        this.term.dim(sid);
      }
      for (const c of auxChunks) {
        this.term.dim(" · ");
        c.paint();
      }
      this.term.dim(padBeforeMiddle);
      this.term.bold(middle);
      if (usageStr) {
        this.term.dim(padAfterMiddle);
        this.term.noFormat(usageStr);
      }
      this.term.bold(tail);
    });
  }

  // Bottom separator (one row above the sessionbar). Holds the hint
  // chunks on the right, swapped to the transient right-slot text
  // (search progress, compaction toast, synthesis toast) when one is
  // active. Click-hit ranges for mode / pick / guide / detach are
  // recorded against this row so the same mouse targets still work.
  private drawBottomSeparator(row: number): void {
    const w = this.term.width;
    const transient = this.bannerRightContent();
    const hintBase = this.banner.currentMode
      ? this.banner.hint.replace(
          "⇧⇥ mode",
          `⇧⇥ mode: ${this.banner.currentMode}`,
        )
      : this.banner.hint;

    const padAfterMiddle = " ";
    const tail = " ──";
    const rightText = transient ? transient.text : hintBase;
    const rightWidth =
      stringWidth(padAfterMiddle) +
      stringWidth(rightText) +
      stringWidth(tail);
    const middleCols = Math.max(0, w - rightWidth);
    const middle = "─".repeat(middleCols);

    const transientSig = transient ? `${transient.kind}|${transient.text}` : "";
    const hoverSig = transient ? "" : (this.hoveredBannerHit ?? "");
    const sig =
      `bsep|${w}|${this.banner.currentMode ?? ""}|${this.banner.hint}|${transientSig}|${hoverSig}`;

    this.paintRow(row, sig, () => {
      this.term.bold(middle);
      this.term.dim(padAfterMiddle);
      if (transient) {
        if (transient.kind === "search") {
          this.term.brightCyan.noFormat(transient.text);
        } else {
          this.term.brightYellow.noFormat(transient.text);
        }
      } else {
        const chunks = hintBase.split(" · ");
        const hovered = this.hoveredBannerHit;
        for (let i = 0; i < chunks.length; i++) {
          if (i > 0) this.term.dim(" · ");
          const c = chunks[i];
          let kind: "mode" | "pick" | "guide" | "detach" | null = null;
          if (c.includes("mode")) kind = "mode";
          else if (c.includes("pick")) kind = "pick";
          else if (c.includes("guide")) kind = "guide";
          else if (c.includes("detach")) kind = "detach";
          if (kind !== null && kind === hovered) {
            this.term.noFormat(c);
          } else {
            this.term.dim(c);
          }
        }
      }
      this.term.bold(tail);

      const hits: {
        mode: [number, number] | null;
        pick: [number, number] | null;
        guide: [number, number] | null;
        detach: [number, number] | null;
      } = { mode: null, pick: null, guide: null, detach: null };
      if (!transient) {
        let col = middleCols + stringWidth(padAfterMiddle) + 1;
        const chunks = hintBase.split(" · ");
        for (const chunk of chunks) {
          const cw = stringWidth(chunk);
          const range: [number, number] = [col, col + cw - 1];
          if (chunk.includes("mode") && hits.mode === null) {
            hits.mode = range;
          } else if (chunk.includes("pick") && hits.pick === null) {
            hits.pick = range;
          } else if (chunk.includes("guide") && hits.guide === null) {
            hits.guide = range;
          } else if (chunk.includes("detach") && hits.detach === null) {
            hits.detach = range;
          }
          col += cw + stringWidth(" · ");
        }
      }
      this.bannerHits = { row, ...hits };
    });
  }

  // Compose the header segments so paintBtwHeader can paint the dashes
  // dim, "By the way" status-coloured, the sid yellow, and the usage dim
  // — same colour conventions as the bottom sessionbar. A single
  // signature string is derived from all parts for repaint coalescing.
  //
  // Layout (left → right):
  //   "── "  "By the way"  " · "  <sid>  <middle dashes>  " <usage> "  "──"
  // The <sid> block (and its " · " separator) is omitted when no fork
  // sessionId is known; the <usage> block is omitted when no usage
  // snapshot has arrived.
  private buildBtwHeaderSegments(): {
    left: string;
    label: string;
    sidSep: string;
    sid: string;
    sidTrail: string;
    middle: string;
    usage: string;
    right: string;
    signature: string;
  } {
    const w = this.term.width;
    const label = "By the way";
    const left = "── ";
    const sid = this.btwOverlaySessionId
      ? shortId(this.btwOverlaySessionId)
      : "";
    const sidSep = sid ? " · " : " ";
    const sidTrail = sid ? " " : "";
    const usageStr = formatUsage(this.btwOverlayUsage);
    const usage = usageStr ? ` ${usageStr} ` : "";
    const right = usageStr ? "──" : "";
    const consumed =
      left.length +
      stringWidth(label) +
      sidSep.length +
      stringWidth(sid) +
      sidTrail.length +
      stringWidth(usage) +
      right.length;
    const middle = "─".repeat(Math.max(0, w - consumed));
    const signature =
      `${w}|${sid}|${this.btwOverlayStatus}|${usageStr ?? ""}`;
    return { left, label, sidSep, sid, sidTrail, middle, usage, right, signature };
  }

  private paintBtwHeader(segments: {
    left: string;
    label: string;
    sidSep: string;
    sid: string;
    sidTrail: string;
    middle: string;
    usage: string;
    right: string;
  }): void {
    // Dashes always dim — they're the separator. The "By the way" label
    // carries the status colour so an at-a-glance scan of the screen
    // shows colour ONLY where there's actual state: yellow while
    // running, regular (default) when done, red on cancel/error.
    this.term.bold(segments.left);
    switch (this.btwOverlayStatus) {
      case "busy":
        this.term.brightYellow(segments.label);
        break;
      case "done":
        this.term(segments.label);
        break;
      case "cancelled":
      case "errored":
        this.term.brightRed(segments.label);
        break;
      default:
        this.term(segments.label);
    }
    this.term.dim(segments.sidSep);
    if (segments.sid) {
      this.term.dim(segments.sid);
      this.term.dim(segments.sidTrail);
    }
    this.term.bold(segments.middle);
    if (segments.usage) {
      this.term.noFormat(segments.usage);
    }
    this.term.bold(segments.right);
  }

  private drawScrollback(): void {
    const w = this.term.width;
    const top = 1;
    const visibleRows = this.scrollbackVisibleRows();
    if (visibleRows <= 0) {
      return;
    }
    const { rows: wrapped, exhausted } = this.wrapTail(
      w,
      visibleRows + this.scrollOffset,
    );
    // Clamp scrollOffset when content shrank/resized — only knowable when
    // wrapTail walked the entire array. If exhausted is false we have at
    // least `needed` rows, so scrollOffset is necessarily valid.
    if (exhausted) {
      const max = Math.max(0, wrapped.length - visibleRows);
      if (this.scrollOffset > max) {
        this.scrollOffset = max;
      }
    }
    const end = wrapped.length - this.scrollOffset;
    const start = Math.max(0, end - visibleRows);
    const slice = wrapped.slice(start, end);
    // Anchor content to the bottom of the scrollback area so a fresh
    // session shows its first lines just above the prompt and new
    // content grows upward — the user can always look at the row above
    // the prompt for the latest text.
    const padTop = Math.max(0, visibleRows - slice.length);
    const matchInfo = this.currentMatchInfo();
    const activeLength = matchInfo?.length ?? 0;
    // Rebuild the display-ordered selection bounds once per paint so each
    // selectionRangeForChunk lookup below is O(1) and order-correct.
    this.selectionRenderBounds = this.selectionLineBounds()?.byId ?? null;
    for (let i = 0; i < visibleRows; i++) {
      const row = top + i;
      const sliceIdx = i - padTop;
      const line = sliceIdx >= 0 ? slice[sliceIdx] : undefined;
      const activeCol = this.activeMatchCol(line, matchInfo);
      const selRange = line ? this.selectionRangeForChunk(line) : null;
      const inHoverScope =
        line !== undefined &&
        line.blockKey !== undefined &&
        (line.blockKey === this.hoveredBlockKey ||
          (this.hoveredRunKeys !== null &&
            this.hoveredRunKeys.has(line.blockKey)));
      const hovered =
        inHoverScope &&
        // When the hovered row carries a subKey, only rows with the same
        // subKey light up. Lines that opt out of subKey scoping (header
        // rows, blocks where the whole thing is one click target) always
        // brighten together with the block.
        (this.hoveredSubKey === null ||
          (line!.hoverSubKey ?? null) === this.hoveredSubKey);
      const sig =
        formattedLineSig(
          "sb",
          w,
          line,
          this.scrollbackHighlight,
          activeCol,
          selRange,
        ) + (hovered ? "|H" : "");
      this.paintRow(row, sig, () => {
        if (line) {
          this.writeFormattedLine(line, w, activeCol, activeLength, selRange, hovered);
        }
      });
    }
    // Fire one-shot visibility callbacks for any registered keyed block
    // whose rows are in the painted slice. Done after the paint loop so the
    // callback (which typically upserts new content) doesn't mutate state
    // mid-draw; the upsert schedules its own repaint.
    if (this.onBlockVisible && this.pendingVisibleKeys.size > 0) {
      const visible = new Set<string>();
      for (const r of slice) {
        if (r.blockKey !== undefined) {
          visible.add(r.blockKey);
        }
      }
      const fire: string[] = [];
      for (const key of this.pendingVisibleKeys) {
        if (visible.has(key)) {
          fire.push(key);
        }
      }
      for (const key of fire) {
        this.pendingVisibleKeys.delete(key);
        this.onBlockVisible(key);
      }
    }
  }

  // Register a keyed block to receive a single onBlockVisible callback the
  // next time any of its rows are painted in the visible window. If it's
  // already on screen the pending repaint fires it promptly; otherwise it
  // waits until the block scrolls into view. No-op without an onBlockVisible
  // handler.
  notifyWhenVisible(key: string): void {
    if (!this.onBlockVisible) {
      return;
    }
    this.pendingVisibleKeys.add(key);
    this.scheduleRepaint();
  }

  private queuedRows(): number {
    return Math.min(MAX_QUEUED_ROWS, this.queuedTexts.length);
  }

  private chipRows(): number {
    return Math.min(MAX_CHIP_ROWS, this.attachments.length);
  }

  setAttachments(attachments: Attachment[]): void {
    // No-op when the list is identical to what we last rendered —
    // refreshPrompt fires on every dispatcher mutation so we'd
    // otherwise repaint and reflow the prompt area for unchanged
    // state. Reference equality of underlying entries is enough
    // because the dispatcher snapshots into a fresh array but the
    // entries are stable across reads.
    if (
      this.attachments.length === attachments.length &&
      this.attachments.every((a, i) => a === attachments[i])
    ) {
      return;
    }
    this.attachments = [...attachments];
    this.repaint();
  }

  private completionRows(): number {
    if (
      this.permissionPrompt ||
      this.optionsPrompt ||
      this.confirmPrompt ||
      this.helpPrompt
    ) {
      // Completions are pointless when the prompt area is taken over by
      // a modal — the user can't be typing into it.
      return 0;
    }
    return Math.min(MAX_COMPLETION_ROWS, this.completions.length);
  }

  private drawCompletionZone(): void {
    const rows = this.completionRows();
    if (rows === 0) {
      return;
    }
    const w = this.term.width;
    const promptRows = this.promptRows();
    const separatorRow =
      this.term.height -
      promptRows -
      SESSIONBAR_ROWS -
      BANNER_SEPARATOR_ROWS -
      BANNER_ROWS;
    const queuedRows = this.queuedRows();
    const chipRows = this.chipRows();
    // Stacking, bottom-to-top above the separator:
    //   separator – 1            chips (closest to prompt)
    //   – chipRows               queued
    //   – queuedRows             completion (top)
    const completionBottom = separatorRow - 1 - queuedRows - chipRows;
    const completionTop = completionBottom - rows + 1;
    // Width of the longest command name so descriptions line up.
    let nameWidth = 0;
    for (const item of this.completions.slice(0, rows)) {
      if (item.name.length > nameWidth) {
        nameWidth = item.name.length;
      }
    }
    for (let i = 0; i < rows; i++) {
      const row = completionTop + i;
      const item = this.completions[i];
      const isLast = i === rows - 1 && this.completions.length > MAX_COMPLETION_ROWS;
      const overflow = this.completions.length - MAX_COMPLETION_ROWS + 1;
      const sig = item
        ? isLast
          ? `comp|${w}|overflow|${overflow}`
          : `comp|${w}|${nameWidth}|${item.name}|${item.description ?? ""}`
        : `comp|${w}|empty`;
      this.paintRow(row, sig, () => {
        if (!item) {
          return;
        }
        if (isLast) {
          this.term.dim(`  + ${overflow} more match(es)`);
          return;
        }
        const namePadded = item.name.padEnd(nameWidth);
        const desc = item.description ?? "";
        const remaining = w - namePadded.length - 4;
        const truncated = remaining > 0 ? truncate(desc, remaining) : "";
        this.term("  ").brightCyan(namePadded);
        if (truncated.length > 0) {
          this.term("  ").dim(truncated);
        }
      });
    }
  }

  // Chip zone: one row per attached image, sitting between the queued
  // zone and the separator (closest to the user's draft). Each row
  // shows "📎 <name> · <size>" plus, in iTerm2-capable terminals, a
  // tiny inline thumbnail at the end. Overflow collapses into a
  // single "+ N more attached" row.
  private drawAttachmentChipZone(): void {
    const rows = this.chipRows();
    if (rows === 0) {
      return;
    }
    const w = this.term.width;
    const promptRows = this.promptRows();
    const separatorRow =
      this.term.height -
      promptRows -
      SESSIONBAR_ROWS -
      BANNER_SEPARATOR_ROWS -
      BANNER_ROWS;
    const chipBottom = separatorRow - 1;
    const chipTop = chipBottom - rows + 1;
    const iterm = this.isIterm2();
    for (let i = 0; i < rows; i++) {
      const row = chipTop + i;
      const isLast = i === rows - 1 && this.attachments.length > MAX_CHIP_ROWS;
      const overflow = this.attachments.length - MAX_CHIP_ROWS;
      const att = this.attachments[i];
      const label = att
        ? `${att.name ?? "image"} · ${formatSize(att.sizeBytes)}`
        : "";
      // Sig: row content + iterm flag + a data fingerprint (sizeBytes
      // is enough — base64 strings of the same image are equal).
      const sig = isLast
        ? `chip|${w}|overflow|${overflow}`
        : att
          ? `chip|${w}|${iterm ? "i" : "t"}|${label}|${att.sizeBytes}`
          : `chip|${w}|empty`;
      this.paintRow(row, sig, () => {
        if (isLast) {
          this.term.dim(`  📎 + ${overflow + 1} more attached`);
          return;
        }
        if (!att) {
          return;
        }
        this.term("  ").yellow(`📎 ${label}`);
        if (iterm) {
          // Trailing space keeps a visible gap between the label and
          // the thumbnail in terminals where the image renders at the
          // current cursor with no margin.
          this.term(" ");
          this.writeIterm2Image(att.data, 1);
        }
      });
    }
  }

  private isIterm2(): boolean {
    const env = process.env;
    return env.LC_TERMINAL === "iTerm2" || env.TERM_PROGRAM === "iTerm.app";
  }

  // Emits the iTerm2 OSC 1337 inline image escape at the current
  // cursor position. Wraps in DCS-passthrough when tmux is detected
  // (requires `set -g allow-passthrough on` in the user's tmux conf).
  // Caller is responsible for knowing iTerm2 is the active terminal.
  private writeIterm2Image(base64: string, heightCells: number): void {
    process.stdout.write(
      buildIterm2ImageEscape(base64, heightCells, Boolean(process.env.TMUX)),
    );
  }

  private drawQueuedZone(): void {
    const rows = this.queuedRows();
    if (rows === 0) {
      return;
    }
    const w = this.term.width;
    const promptRows = this.promptRows();
    // Queued zone sits above the chip zone (chips are visually closest
    // to the user's draft and occupy the rows immediately above the
    // separator).
    const separatorRow =
      this.term.height -
      promptRows -
      SESSIONBAR_ROWS -
      BANNER_SEPARATOR_ROWS -
      BANNER_ROWS;
    const chipRows = this.chipRows();
    const queuedBottom = separatorRow - 1 - chipRows;
    const queuedTop = queuedBottom - rows + 1;
    const editingIndex = this.dispatcher.state().queueIndex;
    for (let i = 0; i < rows; i++) {
      const row = queuedTop + i;
      const text = this.queuedTexts[i];
      const isLast =
        i === rows - 1 && this.queuedTexts.length > MAX_QUEUED_ROWS;
      const overflow = this.queuedTexts.length - MAX_QUEUED_ROWS;
      const summary =
        text === undefined
          ? ""
          : isLast
            ? `+ ${overflow + 1} more queued`
            : truncate(firstLine(text), w - 4);
      // Mark the slot the user is currently editing — the marker takes
      // the column the leading space normally holds, so total width
      // (and the truncate budget above) stay the same.
      const editing = !isLast && i === editingIndex;
      const sig =
        text === undefined
          ? `queued|${w}|empty`
          : `queued|${w}|${editing ? "edit" : isLast ? "ovf" : "row"}|${summary}`;
      this.paintRow(row, sig, () => {
        if (text === undefined) {
          return;
        }
        const rest = `⏳ ${summary}`;
        const padded = rest + " ".repeat(Math.max(0, w - 1 - rest.length));
        if (editing) {
          this.term.bgBlue.brightYellow("▸");
        } else {
          this.term.bgBlue(" ");
        }
        // noFormat: the queued summary contains user-typed prompt text, so
        // literal `^X` should not be interpreted as terminal-kit markup.
        this.term.bgBlue.brightWhite.noFormat(padded);
      });
    }
  }

  private drawPrompt(): void {
    if (this.permissionPrompt) {
      this.drawPermissionPrompt();
      return;
    }
    if (this.optionsPrompt) {
      this.drawOptionsPrompt();
      return;
    }
    if (this.confirmPrompt) {
      this.drawConfirmPrompt();
      return;
    }
    if (this.compactionPrompt) {
      this.drawCompactionPrompt();
      return;
    }
    if (this.helpPrompt) {
      this.drawHelpPrompt();
      return;
    }
    if (this.readonly) {
      // View-only mode reserves zero prompt rows (promptRows() returns 0),
      // so there's nothing to paint — the scrollback already absorbed
      // those rows. Bail before computing layout so we don't trip over
      // a zero-height window.
      return;
    }
    const w = this.term.width;
    const room = Math.max(1, w - 2);
    const state = this.dispatcher.state();
    const visualRows = computePromptVisualRows(state.buffer, room);
    const layout = computePromptLayout(visualRows, state, MAX_PROMPT_ROWS);
    const top =
      this.term.height -
      layout.rendered -
      BANNER_ROWS -
      BANNER_SEPARATOR_ROWS -
      SESSIONBAR_ROWS +
      1;
    // The prompt area is always painted bright — typing always routes to
    // the main input regardless of pane focus, so dimming the prompt would
    // misleadingly suggest typing is disabled. The focus indicator lives
    // on the overlay header (▶ prefix) instead.
    const overlayFocused = false;
    for (let i = 0; i < layout.rendered; i++) {
      const vr = visualRows[layout.windowStart + i];
      const row = top + i;
      let gutter: "first" | "newline" | "wrap" = "wrap";
      let slice = "";
      if (vr) {
        if (vr.bufferIdx === 0 && vr.startCol === 0) {
          gutter = "first";
        } else if (vr.startCol === 0) {
          gutter = "newline";
        }
        slice = (state.buffer[vr.bufferIdx] ?? "").slice(vr.startCol, vr.endCol);
      }
      const sig = vr
        ? `prompt|${this.term.width}|${gutter}|${slice}`
        : `prompt|${this.term.width}|empty`;
      this.paintRow(row, sig, () => {
        if (!vr) {
          return;
        }
        // Gutter: "> " on the very first visual row, "· " on the start of a
        // logical newline, blank on a soft-wrap continuation.
        if (gutter === "first") {
          if (overlayFocused) {
            this.term.dim("> ");
          } else {
            this.term.brightWhite("> ");
          }
        } else if (gutter === "newline") {
          this.term.dim("· ");
        } else {
          this.term("  ");
        }
        // noFormat so literal `^X` typed by the user is rendered verbatim
        // and not interpreted as terminal-kit's color/style markup.
        if (overlayFocused) {
          this.term.dim(slice);
        } else {
          this.term.noFormat(slice);
        }
      });
    }
  }

  private drawConfirmPrompt(): void {
    const spec = this.confirmPrompt;
    if (!spec) {
      return;
    }
    const w = this.term.width;
    const top =
      this.term.height -
      CONFIRM_PROMPT_ROWS -
      BANNER_ROWS -
      BANNER_SEPARATOR_ROWS -
      SESSIONBAR_ROWS +
      1;
    this.paintRow(top, `confirm|q|${w}|${spec.question}`, () => {
      this.term.brightYellow(` ? ${truncate(spec.question, w - 4)}`);
    });
    this.paintRow(top + 1, `confirm|h|${w}|${spec.hint}`, () => {
      this.term.dim(` ${truncate(spec.hint, w - 2)}`);
    });
  }

  private drawCompactionPrompt(): void {
    const spec = this.compactionPrompt;
    if (!spec) {
      return;
    }
    const w = this.term.width;
    const rows = this.compactionRows();
    const top =
      this.term.height -
      rows -
      BANNER_ROWS -
      BANNER_SEPARATOR_ROWS -
      SESSIONBAR_ROWS +
      1;
    let row = top;
    const writeRow = (sig: string, paint: () => void): void => {
      if (row >= top + rows) {
        return;
      }
      this.paintRow(row, sig, paint);
      row += 1;
    };
    // Yellow header matches the "active background work" convention
    // and the permission prompt's brightYellow title — both interrupt
    // the user for a decision.
    writeRow(`cpct|msg|${w}|${spec.message}`, () => {
      this.term.brightYellow(` ${truncate(spec.message, w - 2)}`);
    });
    writeRow(`cpct|q|${w}`, () => {
      this.term(" Compact now to reduce future per-turn token cost?");
    });
    for (let i = 0; i < spec.options.length; i++) {
      if (row >= top + rows - 1) {
        break;
      }
      const opt = spec.options[i];
      if (!opt) {
        continue;
      }
      const isSel = i === spec.selectedIndex;
      const marker = isSel ? "\u276f" : " ";
      const body = ` ${marker} ${i + 1}. ${truncate(opt.label, w - 8)}`;
      writeRow(`cpct|o|${w}|${i}|${isSel ? "1" : "0"}|${opt.label}`, () => {
        if (isSel) {
          this.term.brightYellow(body);
        } else {
          this.term.dim(body);
        }
      });
    }
    writeRow(`cpct|hint|${w}`, () => {
      this.term.dim(" \u2191/\u2193 choose \u00b7 Enter submit \u00b7 Esc cancel \u00b7 y/n quick-pick");
    });
  }

  private compactionRows(): number {
    if (!this.compactionPrompt) {
      return 0;
    }
    // title + question + N options + hint = 3 + N
    return 3 + this.compactionPrompt.options.length;
  }

  private drawHelpPrompt(): void {
    const spec = this.helpPrompt;
    if (!spec) {
      return;
    }
    const w = this.term.width;
    const rows = this.helpRows();
    const top =
      this.term.height -
      rows -
      BANNER_ROWS -
      BANNER_SEPARATOR_ROWS -
      SESSIONBAR_ROWS +
      1;
    let row = top;
    const writeRow = (sig: string, paint: () => void): void => {
      if (row >= top + rows) {
        return;
      }
      this.paintRow(row, sig, paint);
      row += 1;
    };
    writeRow(`help|t|${w}|${spec.title}`, () => {
      this.term.brightYellow(` ❓ ${truncate(spec.title, w - 5)}`);
    });
    const keysWidth = Math.min(
      24,
      Math.max(
        ...spec.entries.map((e) => (e === null ? 0 : e[0].length)),
        4,
      ),
    );
    for (const entry of spec.entries) {
      if (row >= top + rows - 1) {
        break;
      }
      if (entry === null) {
        writeRow(`help|sep|${w}|${row}`, () => undefined);
        continue;
      }
      const [keys, desc] = entry;
      const paddedKeys = keys.padEnd(keysWidth);
      writeRow(`help|e|${w}|${keys}|${desc}`, () => {
        this.term(" ");
        this.term.brightCyan.noFormat(paddedKeys);
        this.term.noFormat(` ${truncate(desc, w - 2 - keysWidth - 1)}`);
      });
    }
    writeRow(`help|hint|${w}|${spec.hint}`, () => {
      this.term.dim(` ${truncate(spec.hint, w - 2)}`);
    });
  }

  private helpRows(): number {
    if (!this.helpPrompt) {
      return 0;
    }
    // title + N entries (including separators) + hint
    return Math.min(MAX_HELP_ROWS, 2 + this.helpPrompt.entries.length);
  }

  private drawPermissionPrompt(): void {
    const spec = this.permissionPrompt;
    if (!spec) {
      return;
    }
    const w = this.term.width;
    const rows = this.permissionRows();
    const top =
      this.term.height -
      rows -
      BANNER_ROWS -
      BANNER_SEPARATOR_ROWS -
      SESSIONBAR_ROWS +
      1;
    let row = top;
    const writeRow = (sig: string, paint: () => void): void => {
      if (row >= top + rows) {
        return;
      }
      this.paintRow(row, sig, paint);
      row += 1;
    };
    writeRow(`perm|t|${w}|${spec.title}`, () => {
      this.term.brightYellow(` 🔒 ${truncate(spec.title, w - 5)}`);
    });
    const sub = spec.detail && spec.detail.length > 0
      ? spec.detail
      : "This action requires approval";
    writeRow(`perm|sub|${w}|${sub}`, () => {
      this.term.dim(` ${truncate(sub, w - 2)}`);
    });
    writeRow(`perm|q|${w}`, () => {
      this.term(" Do you want to proceed?");
    });
    for (let i = 0; i < spec.options.length; i++) {
      if (row >= top + rows - 1) {
        break;
      }
      const opt = spec.options[i];
      if (!opt) {
        continue;
      }
      const isSel = i === spec.selectedIndex;
      const marker = isSel ? "❯" : " ";
      const body = ` ${marker} ${i + 1}. ${truncate(opt.label, w - 8)}`;
      writeRow(`perm|o|${w}|${i}|${isSel ? "1" : "0"}|${opt.label}`, () => {
        if (isSel) {
          this.term.brightYellow(body);
        } else {
          this.term.dim(body);
        }
      });
    }
    writeRow(`perm|hint|${w}`, () => {
      this.term.dim(" ↑/↓ choose · Enter submit · Esc cancel · 1–9 quick-pick");
    });
  }

  // Plain-text reproduction of everything drawBanner paints before the
  // hint chunks. Used to derive the start column of the hint so we can
  // map left-clicks back to the chunk under the pointer. Must stay in
  // sync with drawBanner's left-side paints — adding a new prefix
  // element there means appending it here too. Status / elapsed have
  // moved into the prompt-above separator, so they're no longer part of
  // the prefix.
  private computeBannerPrefixText(): string {
    const parts: string[] = [];
    if (this.banner.queued > 0) {
      parts.push(`${this.banner.queued} queued`);
    }
    if (this.scrollOffset > 0) {
      parts.push(`↑ ${this.scrollOffset}`);
    }
    return parts.length > 0 ? parts.join(" · ") + " · " : "";
  }

  // Public: which clickable banner chunk (if any) contains the given
  // 1-based terminal cell? Returns null for clicks outside the banner
  // row or in non-clickable areas (status dot, queued, scroll indicator,
  // "detach" chunk, the gap before the right-side slot, etc.).
  bannerHitAt(x: number, y: number): "mode" | "pick" | "guide" | "detach" | null {
    const hits = this.bannerHits;
    if (!hits || y !== hits.row) {
      return null;
    }
    const inRange = (r: [number, number] | null): boolean =>
      r !== null && x >= r[0] && x <= r[1];
    if (inRange(hits.mode)) return "mode";
    if (inRange(hits.pick)) return "pick";
    if (inRange(hits.guide)) return "guide";
    if (inRange(hits.detach)) return "detach";
    return null;
  }

  private drawBanner(): void {
    // Banner state now spans two rows: status/sid/usage live on the
    // prompt-above separator, and hint chunks / transient right-slot
    // live on the bottom separator (one row above the sessionbar).
    // Partial repaints fan out to both — paintRow's signature short-
    // circuits no-op rewrites so the cost is negligible.
    const h = this.term.height;
    const promptRows = this.promptRows();
    const separatorAbovePromptRow =
      h - promptRows - BANNER_ROWS - BANNER_SEPARATOR_ROWS - SESSIONBAR_ROWS;
    this.drawSeparator(separatorAbovePromptRow);
    this.drawBottomSeparator(h - SESSIONBAR_ROWS);
  }


  private placeCursor(): void {
    if (!this.started) {
      return;
    }
    if (this.permissionPrompt) {
      // Park cursor on the selected option line — visual feedback while the
      // user navigates with arrows.
      const rows = this.permissionRows();
      const top =
        this.term.height -
        rows -
        BANNER_ROWS -
        BANNER_SEPARATOR_ROWS -
        SESSIONBAR_ROWS +
        1;
      const optionRow = top + 3 + this.permissionPrompt.selectedIndex;
      const lastUsableRow =
        this.term.height - BANNER_ROWS - BANNER_SEPARATOR_ROWS - SESSIONBAR_ROWS;
      this.term.moveTo(2, Math.min(optionRow, lastUsableRow));
      return;
    }
    if (this.optionsPrompt) {
      const rows = this.optionsRows();
      const top =
        this.term.height -
        rows -
        BANNER_ROWS -
        BANNER_SEPARATOR_ROWS -
        SESSIONBAR_ROWS +
        1;
      // title precedes the option rows
      const optionRow = top + 1 + this.optionsPrompt.selectedIndex;
      const lastUsableRow =
        this.term.height - BANNER_ROWS - BANNER_SEPARATOR_ROWS - SESSIONBAR_ROWS;
      this.term.moveTo(2, Math.min(optionRow, lastUsableRow));
      return;
    }
    if (this.confirmPrompt) {
      // Park cursor at the end of the question — there's no field to type
      // into, but a visible cursor reads as "waiting for your keypress".
      const top =
        this.term.height -
        CONFIRM_PROMPT_ROWS -
        BANNER_ROWS -
        BANNER_SEPARATOR_ROWS -
        SESSIONBAR_ROWS +
        1;
      this.term.moveTo(2, top);
      return;
    }
    if (this.compactionPrompt) {
      // Park cursor on the selected option row — same as the permission
      // prompt — so it reads as visual feedback for the selection
      // rather than a stray cell overlapping the message text.
      // Layout: top row = message, +1 = question, +2 = first option.
      const rows = this.compactionRows();
      const top =
        this.term.height -
        rows -
        BANNER_ROWS -
        BANNER_SEPARATOR_ROWS -
        SESSIONBAR_ROWS +
        1;
      const optionRow = top + 2 + this.compactionPrompt.selectedIndex;
      const lastUsableRow =
        this.term.height - BANNER_ROWS - BANNER_SEPARATOR_ROWS - SESSIONBAR_ROWS;
      this.term.moveTo(2, Math.min(optionRow, lastUsableRow));
      return;
    }
    if (this.helpPrompt) {
      // Park on the title row; there is no input here, but the cursor
      // visually anchors the modal.
      const rows = this.helpRows();
      const top =
        this.term.height -
        rows -
        BANNER_ROWS -
        BANNER_SEPARATOR_ROWS -
        SESSIONBAR_ROWS +
        1;
      this.term.moveTo(2, top);
      return;
    }
    if (this.scrollbackSearch) {
      // Hide the cursor entirely — the prompt area shows the user's
      // existing buffer unchanged, and their typing actually lands in
      // the banner search overlay. A visible cursor in either spot
      // would mislead, plus most terminals draw the cursor as a
      // colored block which tinted the 🔍 emoji it sat on top of.
      this.term.hideCursor(true);
      return;
    }
    if (this.readonly) {
      // View-only: no composer to park on. Without this branch the
      // fall-through below puts the cursor on the row where the prompt
      // *would* be — which in readonly is the separator slid down by
      // promptRows()=0, so the user sees a stray block on the dim line.
      this.term.hideCursor(true);
      return;
    }
    // Outside of scrollback search, ensure the cursor is visible —
    // re-asserting on every paint is cheap and recovers from a stale
    // hide if the previous frame was in search mode.
    this.term.hideCursor(false);
    const w = this.term.width;
    const room = Math.max(1, w - 2);
    const state = this.dispatcher.state();
    const visualRows = computePromptVisualRows(state.buffer, room);
    const layout = computePromptLayout(visualRows, state, MAX_PROMPT_ROWS);
    const top =
      this.term.height -
      layout.rendered -
      BANNER_ROWS -
      BANNER_SEPARATOR_ROWS -
      SESSIONBAR_ROWS +
      1;
    const row = top + Math.max(0, layout.cursorVisualRow - layout.windowStart);
    const col = layout.cursorVisualCol + 3; // gutter (2) + 1-based column
    const lastPromptRow =
      this.term.height - BANNER_ROWS - BANNER_SEPARATOR_ROWS - SESSIONBAR_ROWS;
    this.term.moveTo(
      Math.min(col, this.term.width),
      Math.min(row, lastPromptRow),
    );
  }

  private promptRows(): number {
    if (this.permissionPrompt) {
      return this.permissionRows();
    }
    if (this.optionsPrompt) {
      return this.optionsRows();
    }
    if (this.confirmPrompt) {
      return CONFIRM_PROMPT_ROWS;
    }
    if (this.compactionPrompt) {
      return this.compactionRows();
    }
    if (this.helpPrompt) {
      return this.helpRows();
    }
    if (this.readonly) {
      // View-only mode: no composer, no prompt area — the rows become
      // additional scrollback so the user can see more transcript.
      return 0;
    }
    const w = this.term.width;
    const room = Math.max(1, w - 2);
    const state = this.dispatcher.state();
    const visualRows = computePromptVisualRows(state.buffer, room);
    return Math.min(MAX_PROMPT_ROWS, Math.max(1, visualRows.length));
  }

  private permissionRows(): number {
    if (!this.permissionPrompt) {
      return 0;
    }
    // title + blank + question + N options + hint = 4 + N
    return Math.min(
      MAX_PERMISSION_ROWS,
      4 + this.permissionPrompt.options.length,
    );
  }

  private optionsRows(): number {
    if (!this.optionsPrompt) {
      return 0;
    }
    // title + N options + hint = 2 + N
    return Math.min(MAX_OPTIONS_ROWS, 2 + this.optionsPrompt.options.length);
  }

  private drawOptionsPrompt(): void {
    const spec = this.optionsPrompt;
    if (!spec) {
      return;
    }
    const w = this.term.width;
    const rows = this.optionsRows();
    const top =
      this.term.height -
      rows -
      BANNER_ROWS -
      BANNER_SEPARATOR_ROWS -
      SESSIONBAR_ROWS +
      1;
    let row = top;
    const writeRow = (sig: string, paint: () => void): void => {
      if (row >= top + rows) {
        return;
      }
      this.paintRow(row, sig, paint);
      row += 1;
    };
    writeRow(`opts|t|${w}|${spec.title}`, () => {
      this.term.brightYellow(` ⚙ ${truncate(spec.title, w - 5)}`);
    });
    // Align the value column just past the longest label so values line
    // up in a tidy right-hand column.
    const labelWidth = Math.max(
      ...spec.options.map((o) => o.label.length),
      0,
    );
    for (let i = 0; i < spec.options.length; i++) {
      if (row >= top + rows - 1) {
        break;
      }
      const opt = spec.options[i];
      if (!opt) {
        continue;
      }
      const isSel = i === spec.selectedIndex;
      const marker = isSel ? "❯" : " ";
      const prefix = ` ${marker} ${i + 1}. `;
      const paddedLabel = opt.label.padEnd(labelWidth);
      const room = w - prefix.length - 3;
      const body = `${prefix}${truncate(`${paddedLabel}  ${opt.value}`, room)}`;
      writeRow(
        `opts|o|${w}|${i}|${isSel ? "1" : "0"}|${opt.value}|${opt.label}`,
        () => {
          if (isSel) {
            this.term.brightYellow(body);
          } else {
            this.term.dim(body);
          }
        },
      );
    }
    const hint =
      spec.hint ??
      "↑/↓ choose · Enter this session · s save default · Esc close";
    writeRow(`opts|hint|${w}|${hint}`, () => {
      this.term.dim(` ${hint}`);
    });
  }

  private btwOverlayRows(): number {
    if (!this.btwOverlayOpen) return 0;
    // Defensive: if any caller ever opens the overlay without seeding
    // content, reserve zero rows rather than render an isolated header
    // floating above the prompt separator. The /btw handler seeds the
    // user prompt synchronously with open, so in practice this branch is
    // only hit on the very first repaint between open and seed.
    if (this.btwOverlayLines.length === 0) return 0;
    // Header + content, capped by max. Count WRAPPED rows so that long
    // lines reserve the rows they actually paint into — without this the
    // overlay clips at the right margin (DECAWM is off) and silently
    // drops the wrap continuations.
    const maxContent = Math.max(0, this.btwOverlayMaxHeight - 1);
    const w = this.term.width;
    const wrappedCount = this.wrapBtwTail(w, maxContent).length;
    return Math.min(this.btwOverlayMaxHeight, 1 + wrappedCount);
  }

  // Walk btwOverlayLines from the tail, wrapping each via wrapOne, until
  // we have at least `needed` wrapped rows (or run out of source lines).
  // Returns the collected wrapped rows in original (top-down) order.
  // Mirrors wrapTail's tail-walk pattern but over the overlay buffer and
  // without the thought-filter. wrapOne skips its cache for lines that
  // aren't in lineIds (overlay lines aren't), so this re-wraps every
  // repaint — fine, since the overlay is bounded by btwOverlayMaxHeight.
  private wrapBtwTail(width: number, needed: number): FormattedLine[] {
    if (width <= 4) {
      const take = Math.min(needed, this.btwOverlayLines.length);
      return this.btwOverlayLines.slice(this.btwOverlayLines.length - take);
    }
    if (needed <= 0 || this.btwOverlayLines.length === 0) {
      return [];
    }
    const batches: FormattedLine[][] = [];
    let total = 0;
    for (let i = this.btwOverlayLines.length - 1; i >= 0; i--) {
      const line = this.btwOverlayLines[i]!;
      const wrapped = this.wrapOne(line, width);
      batches.push(wrapped);
      total += wrapped.length;
      if (total >= needed) {
        break;
      }
    }
    const rows: FormattedLine[] = [];
    for (let i = batches.length - 1; i >= 0; i--) {
      rows.push(...batches[i]!);
    }
    // Trim from the head so we keep exactly the LAST `needed` rows.
    if (rows.length > needed) {
      return rows.slice(rows.length - needed);
    }
    return rows;
  }

  private drawBtwOverlay(): void {
    if (!this.btwOverlayOpen) {
      return;
    }
    const rows = this.btwOverlayRows();
    if (rows === 0) {
      // Empty + open → the prompt-above separator carries the label
      // instead; nothing to draw here. drawPromptSeparator handles it.
      return;
    }
    const w = this.term.width;
    const h = this.term.height;
    const separatorAbovePromptRow =
      h - this.promptRows() - BANNER_ROWS - BANNER_SEPARATOR_ROWS - SESSIONBAR_ROWS;
    const zoneRows = this.chipRows() + this.queuedRows() + this.completionRows();
    const overlayBottom = separatorAbovePromptRow - 1 - zoneRows;
    const overlayTop = overlayBottom - rows + 1;
    // Row layout (top → bottom):
    //   overlayTop                  header (acts as top separator)
    //   overlayTop+1 ... overlayBottom   content rows (rows-1 of them)
    // No bottom separator — the existing separator above prompt does it.
    const contentRows = rows - 1;
    const headerRow = overlayTop;
    const segments = this.buildBtwHeaderSegments();
    this.paintRow(headerRow, `btw|h|${segments.signature}`, () => {
      this.paintBtwHeader(segments);
    });
    // Paint the content rows below the header. Show the LAST `contentRows`
    // WRAPPED rows top-down, so long lines flow onto continuation rows
    // instead of getting clipped at the right margin. Each line carries
    // its own FormattedLine fields (prefix/body/bodyStyle/fillRow) so
    // user-text bands, tool labels, etc. render with the same styling as
    // the main transcript.
    const wrappedTail = this.wrapBtwTail(w, contentRows);
    for (let i = 0; i < contentRows; i++) {
      const row = headerRow + 1 + i;
      const lineIdx = wrappedTail.length - contentRows + i;
      const line = lineIdx >= 0 ? wrappedTail[lineIdx] : undefined;
      const sig = formattedLineSig(`btw|c${i}`, w, line);
      this.paintRow(row, sig, () => {
        if (line) {
          this.writeFormattedLine(line, w);
        } else {
          this.term.noFormat(" ".repeat(w));
        }
      });
    }
  }

  // Walk this.lines from the tail, accumulating wrapped rows via the
  // wrap cache, until we have at least `needed` rows or run out. Returns
  // the collected rows in original (top-down) order plus an `exhausted`
  // flag that's true iff we reached the head of this.lines. The hot path
  // (drawScrollback) only ever asks for `visibleRows + scrollOffset`
  // rows, so a 10k-line scrollback costs ~50 cache hits per repaint
  // instead of 10k. With `needed = Infinity` this walks everything and
  // doubles as a total-row counter for maxScrollOffset.
  private wrapTail(
    width: number,
    needed: number,
  ): { rows: FormattedLine[]; exhausted: boolean } {
    // bodyStyle === "thought" is the source of truth for thought-rendered
    // lines (set by appendStreaming in the agent-thought path). When
    // hideThoughts is on, skip those entries at measure / draw time;
    // they stay in this.lines so toggling back on restores them. Lines
    // explicitly marked `collapsed` (a folded thought run's secondary
    // lines + separators) are likewise skipped but always, regardless of
    // hideThoughts.
    const isThought = (line: FormattedLine): boolean =>
      line.collapsed === true ||
      (this.hideThoughts && line.bodyStyle === "thought");
    if (width <= 4) {
      const visible: FormattedLine[] = [];
      for (const line of this.lines) {
        if (isThought(line)) {
          continue;
        }
        visible.push(line);
      }
      const take = Math.min(needed, visible.length);
      return {
        rows: visible.slice(visible.length - take),
        exhausted: needed >= visible.length,
      };
    }
    if (this.wrapCacheWidth !== width) {
      this.wrapCache.clear();
      this.wrapCacheWidth = width;
    }
    if (needed <= 0 || this.lines.length === 0) {
      return { rows: [], exhausted: true };
    }
    const batches: FormattedLine[][] = [];
    let total = 0;
    let stoppedAt = 0;
    let sawOldest = false;
    for (let i = this.lines.length - 1; i >= 0; i--) {
      const line = this.lines[i]!;
      if (isThought(line)) {
        if (i === 0) {
          sawOldest = true;
        }
        continue;
      }
      const wrapped = this.wrapOne(line, width);
      batches.push(wrapped);
      total += wrapped.length;
      stoppedAt = i;
      if (total >= needed) {
        break;
      }
    }
    const rows: FormattedLine[] = [];
    for (let i = batches.length - 1; i >= 0; i--) {
      rows.push(...batches[i]!);
    }
    return { rows, exhausted: stoppedAt === 0 || sawOldest };
  }

  private wrapOne(line: FormattedLine, width: number): FormattedLine[] {
    const id = this.lineIds.get(line);
    if (id !== undefined) {
      const cached = this.wrapCache.get(id);
      if (cached) {
        return cached;
      }
    }
    const prefix = line.prefix ?? "";
    // Measure the gutter by visible columns (honoring ambiguous-width mode),
    // not code-unit length, so an ambiguous-width marker like "· " reserves
    // the columns it actually paints and the continuation indent matches.
    const prefixCols = cellWidth(prefix);
    // Reserve the rightmost terminal column. Writing into column `w`
    // (with autowrap on) latches the terminal's deferred-wrap flag; the
    // next paint step then drops or shifts the trailing glyph, which
    // shows up as words losing their last character ("gives up" → "gives
    // u"). Shaving one column from the wrap budget keeps every wrapped
    // chunk strictly inside w-1 so the terminal never armed the
    // deferred-wrap state. Same -1 convention picker.ts uses
    // (rowMaxWidth = termWidth - ROW_PREFIX_WIDTH - 1).
    const room = Math.max(1, width - prefixCols - 1);
    // The "agent", "thought", and "heading-*" bodyStyles are routed through
    // term-kit's markup-interpreting writer (see writeStyled); every other
    // style emits text via .noFormat, so caret sequences are literal there
    // and the wrap budget must include them. Keeping stripMarkup off by
    // default preserves existing cwd/title/spec behavior.
    const stripMarkup = bodyStyleUsesMarkup(line.bodyStyle);
    const chunks = line.ansi
      ? wrapAnsiBody(line.body, room)
      : wrap(line.body, room, { stripMarkup });
    const wrapped: FormattedLine[] = [];
    // Walk the source body to recover each chunk's starting col. wrap()
    // doesn't return offsets, but chunks are sequential portions and
    // indexOf from the previous chunk's end finds each one (even when
    // wrap dropped whitespace at a break — indexOf skips past it).
    let scanPos = 0;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i] ?? "";
      const wrappedLine: FormattedLine = {
        prefix: i === 0 ? line.prefix : " ".repeat(prefixCols),
        body: chunk,
      };
      if (line.prefixStyle !== undefined) {
        wrappedLine.prefixStyle = line.prefixStyle;
      }
      if (line.bodyStyle !== undefined) {
        wrappedLine.bodyStyle = line.bodyStyle;
      }
      if (line.blockKey !== undefined) {
        wrappedLine.blockKey = line.blockKey;
      }
      if (line.hoverSubKey !== undefined) {
        wrappedLine.hoverSubKey = line.hoverSubKey;
      }
      if (line.fillRow) {
        wrappedLine.fillRow = true;
      }
      if (line.ansi) {
        wrappedLine.ansi = true;
      }
      // Attach the iTerm2 inline image only to the first wrapped row.
      // Wrapping a body that carries an image should produce a tiny
      // body (filename), so wrap rarely splits it — but if it did,
      // emitting the OSC on each continuation would draw the same
      // image twice.
      if (i === 0 && line.iterm2Image) {
        wrappedLine.iterm2Image = line.iterm2Image;
      }
      if (id !== undefined && chunk.length > 0) {
        const found = line.body.indexOf(chunk, scanPos);
        const colOffset = found === -1 ? scanPos : found;
        this.wrapOrigin.set(wrappedLine, {
          sourceLineId: id,
          sourceColOffset: colOffset,
        });
        scanPos = colOffset + chunk.length;
      }
      wrapped.push(wrappedLine);
    }
    if (id !== undefined) {
      this.wrapCache.set(id, wrapped);
    }
    return wrapped;
  }

  private writeFormattedLine(
    line: FormattedLine,
    width: number,
    activeMatchCol: number | null = null,
    activeMatchLength: number = 0,
    selectionRange: { start: number; end: number; toEndOfLine: boolean } | null = null,
    hovered: boolean = false,
  ): void {
    if (line.prefix) {
      writeStyled(this.term, line.prefix, line.prefixStyle ?? line.bodyStyle, hovered);
    }
    const remaining = Math.max(0, width - cellWidth(line.prefix ?? ""));
    // ANSI lines are already wrapped to the visible-width budget by
    // wrap-ansi, so we don't truncate further — that would re-introduce
    // the char-counting bug the ansi path exists to avoid. Width for
    // fillRow padding is measured with string-width so escape bytes
    // don't shrink the apparent line. For bodyStyles that emit caret
    // markup ("agent", "heading-*"), opt into markup-aware truncate so a
    // `^Cfoo^:` span isn't counted as 5 cols and isn't cut between '^'
    // and the style char.
    const stripMarkup = bodyStyleUsesMarkup(line.bodyStyle);
    const bodyText = line.ansi
      ? line.body
      : truncate(line.body, remaining, { stripMarkup });
    // Scrollback search active: split the visible body around case-
    // insensitive matches of the search term so each match renders
    // with the search-highlight style while the rest keeps the base
    // bodyStyle. ANSI bodies skip the split (escape bytes would
    // confuse substring math). Agent / caret-markup bodies do
    // participate — the highlight overrides surrounding markup for
    // the matched chars, which produces sensible output for the
    // common case (matches landing in plain prose, not inside markup
    // spans). When activeMatchCol is set, the occurrence at that
    // exact col renders with the louder "search-highlight-active"
    // style so the user knows which match ^r/^s is pointing at.
    // Selection highlight layers on top of the base style and on top
    // of search-match highlighting. Split bodyText into [before, sel,
    // after]; each piece falls through to the search-highlight writer
    // when search is active, otherwise to plain writeStyled. The sel
    // piece always renders as "selection-highlight" so the inverse
    // band is unmistakable regardless of base style or whether a
    // search match also lands inside the range.
    const renderPiece = (text: string, baseOffset: number) => {
      if (text.length === 0) {
        return;
      }
      if (this.scrollbackHighlight !== null && !line.ansi) {
        const adjustedActive =
          activeMatchCol !== null && activeMatchCol >= baseOffset
            ? activeMatchCol - baseOffset
            : null;
        writeBodyWithHighlight(
          this.term,
          text,
          line.bodyStyle,
          this.scrollbackHighlight,
          adjustedActive,
          activeMatchLength,
          hovered,
        );
      } else {
        writeStyled(this.term, text, line.bodyStyle, hovered);
      }
    };
    if (selectionRange !== null && !line.ansi) {
      const selStart = Math.max(0, Math.min(bodyText.length, selectionRange.start));
      const selEnd = Math.max(selStart, Math.min(bodyText.length, selectionRange.end));
      const usesMarkup = bodyStyleUsesMarkup(line.bodyStyle);
      renderPiece(bodyText.slice(0, selStart), 0);
      if (selEnd > selStart) {
        let selText = bodyText.slice(selStart, selEnd);
        if (usesMarkup) {
          // Body carries caret-markup spans (^+bold^:, ^Ccode^:, etc.)
          // emitted by applyInlineMarkup. Strip them so the inverse
          // band reads as one uniform color regardless of which span
          // the selection happens to cross — leaving the markup in
          // would either print carets literally (noFormat) or invert
          // each span's own fg color (bold stays default, code flips
          // to a cyan band), making the selection look striped.
          selText = stripTkMarkup(selText);
        }
        writeStyled(this.term, selText, "selection-highlight", hovered);
      }
      let after = bodyText.slice(selEnd);
      if (usesMarkup && selEnd > selStart) {
        // The inverse writer ends with a full SGR reset, dropping any
        // markup span (e.g. `^Ccode^:`) that opened before the
        // selection and closes after it — the trailing piece would
        // render without its original color. Prepend the cumulative
        // caret-markup tokens from text[0..selEnd] so the same writer
        // call replays the style stack right before printing the
        // visible tail. Tokens are zero-width so this adds no chars.
        const prime = tkMarkupTokensOnly(bodyText.slice(0, selEnd));
        if (prime.length > 0) {
          after = prime + after;
        }
      }
      renderPiece(after, selEnd);
    } else if (this.scrollbackHighlight !== null && !line.ansi) {
      writeBodyWithHighlight(
        this.term,
        bodyText,
        line.bodyStyle,
        this.scrollbackHighlight,
        activeMatchCol,
        activeMatchLength,
        hovered,
      );
    } else {
      writeStyled(this.term, bodyText, line.bodyStyle, hovered);
    }
    if (line.fillRow) {
      const visible = line.ansi ? stringWidth(bodyText) : cellWidth(bodyText);
      const pad = remaining - visible;
      if (pad > 0) {
        // When the selection extends past this chunk's body (multi-
        // row selection), paint the padding with the same highlight
        // so the band reads as a continuous rectangle across wraps
        // and lines instead of stopping at the end of each text run.
        const fillStyle: Style | undefined =
          selectionRange !== null && selectionRange.toEndOfLine
            ? "selection-highlight"
            : line.bodyStyle;
        writeStyled(this.term, " ".repeat(pad), fillStyle, hovered);
      }
    }
    // Defensive reset: if the body contained terminal-kit markup
    // (`^+bold^:` etc.) and our char-counting wrap/truncate split it
    // mid-span, the dangling open would otherwise leak bold/color into
    // every subsequent row's eraseLineAfter + writes. Emitting an SGR
    // reset here costs ~4 bytes per row and bounds the damage to the
    // affected row. ANSI-bearing lines always get a reset since
    // highlighter output may end mid-token after wrap-ansi splits it.
    if (line.ansi || line.body.includes("^")) {
      this.term.styleReset();
    }
    // iTerm2 inline thumbnail (only emitted on iTerm2 — host terminals
    // silently ignore the OSC). The image renders at the current
    // cursor with heightCells rows; iTerm2 may advance the cursor
    // beyond our row, but the next paintRow's moveTo resets it for
    // the row below. Net effect: the image visually overlays this row
    // and a few rows below, with subsequent paint calls untouched.
    if (line.iterm2Image && this.isIterm2()) {
      this.writeIterm2Image(
        line.iterm2Image.data,
        line.iterm2Image.heightCells,
      );
    }
  }
}

// Compact, deterministic key for a row's rendered FormattedLine. Captures
// every field that affects writeFormattedLine output bytes; identical sigs
// guarantee identical output, so paintRow can skip the re-emit. `zone`
// distinguishes which draw block painted the row so a scrollback row's
// sig can't accidentally match a completion row's.
function formattedLineSig(
  zone: string,
  width: number,
  line: FormattedLine | undefined,
  highlight: string | null = null,
  activeCol: number | null = null,
  selectionRange: { start: number; end: number; toEndOfLine: boolean } | null = null,
): string {
  const active = activeCol === null ? "" : `a${activeCol}`;
  const sel = selectionRange === null
    ? ""
    : `s${selectionRange.start}:${selectionRange.end}${selectionRange.toEndOfLine ? "f" : ""}`;
  if (!line) {
    return `${zone}|${width}|empty|${highlight ?? ""}|${active}|${sel}`;
  }
  // iTerm2 image fingerprint: heightCells + base64 length is enough —
  // identical base64s of the same length are de-facto identical images
  // and the user's attachments don't get mutated in place. Including
  // the full base64 would explode the sig string for no benefit.
  const img = line.iterm2Image
    ? `i${line.iterm2Image.heightCells}:${line.iterm2Image.data.length}`
    : "";
  return (
    `${zone}|${width}|` +
    `${line.prefix ?? ""}|${line.prefixStyle ?? ""}|` +
    `${line.body}|${line.bodyStyle ?? ""}|` +
    `${line.ansi ? "1" : "0"}|${line.fillRow ? "1" : "0"}|` +
    `${highlight ?? ""}|${active}|${sel}|${img}`
  );
}

export interface PromptVisualRow {
  bufferIdx: number;
  startCol: number;
  endCol: number;
}

// Split each logical buffer line into visual rows of at most `room` chars
// each, so very long pasted/typed input soft-wraps in the prompt area
// instead of running off-screen. Breaks prefer the last whitespace in
// the window so wraps land on word boundaries; an unbroken run wider
// than `room` falls back to a hard wrap. The trailing whitespace stays
// on the upstream row, keeping [startCol, endCol) a contiguous partition
// of the line — the cursor-positioning logic in computePromptLayout
// depends on that invariant.
export function computePromptVisualRows(buffer: string[], room: number): PromptVisualRow[] {
  const rows: PromptVisualRow[] = [];
  for (let i = 0; i < buffer.length; i++) {
    const line = buffer[i] ?? "";
    if (line.length === 0) {
      rows.push({ bufferIdx: i, startCol: 0, endCol: 0 });
      continue;
    }
    let pos = 0;
    while (pos < line.length) {
      if (line.length - pos <= room) {
        rows.push({ bufferIdx: i, startCol: pos, endCol: line.length });
        pos = line.length;
        break;
      }
      let breakAt = -1;
      for (let j = pos + room - 1; j >= pos; j--) {
        const c = line[j];
        if (c === " " || c === "\t") {
          breakAt = j + 1;
          break;
        }
      }
      if (breakAt === -1) {
        breakAt = pos + room;
      }
      rows.push({ bufferIdx: i, startCol: pos, endCol: breakAt });
      pos = breakAt;
    }
  }
  if (rows.length === 0) {
    rows.push({ bufferIdx: 0, startCol: 0, endCol: 0 });
  }
  return rows;
}

export interface PromptLayout {
  // Visual row index (into the unwindowed visualRows array) the cursor
  // sits on, and its column within that row.
  cursorVisualRow: number;
  cursorVisualCol: number;
  // First visual row to actually draw; allows scrolling the prompt
  // window when the buffer exceeds MAX_PROMPT_ROWS so the cursor stays
  // visible.
  windowStart: number;
  // Number of visual rows we'll render this frame.
  rendered: number;
}

export function computePromptLayout(
  visualRows: PromptVisualRow[],
  state: { buffer: string[]; row: number; col: number },
  maxRows: number,
): PromptLayout {
  let cursorVisualRow = 0;
  let cursorVisualCol = 0;
  // Find the visual row containing (state.row, state.col). If the cursor
  // sits exactly at the boundary between two soft-wrapped rows (col equals
  // an interior row's endCol) prefer the next row — that matches what the
  // user expects after typing the wrapping character.
  let lastMatchIdx = -1;
  for (let i = 0; i < visualRows.length; i++) {
    const vr = visualRows[i];
    if (!vr || vr.bufferIdx !== state.row) {
      continue;
    }
    lastMatchIdx = i;
    if (state.col >= vr.startCol && state.col < vr.endCol) {
      cursorVisualRow = i;
      cursorVisualCol = state.col - vr.startCol;
      lastMatchIdx = -1;
      break;
    }
  }
  if (lastMatchIdx !== -1) {
    const vr = visualRows[lastMatchIdx];
    if (vr) {
      cursorVisualRow = lastMatchIdx;
      cursorVisualCol = state.col - vr.startCol;
    }
  }
  const rendered = Math.min(maxRows, Math.max(1, visualRows.length));
  let windowStart = 0;
  if (visualRows.length > rendered) {
    // Keep the cursor row inside the visible window. Anchor the window to
    // the cursor's row when possible, then clamp so we don't scroll past
    // either end of the buffer.
    windowStart = Math.max(
      0,
      Math.min(visualRows.length - rendered, cursorVisualRow - (rendered - 1)),
    );
    if (cursorVisualRow < windowStart) {
      windowStart = cursorVisualRow;
    }
    if (cursorVisualRow >= windowStart + rendered) {
      windowStart = cursorVisualRow - rendered + 1;
    }
  }
  return { cursorVisualRow, cursorVisualCol, windowStart, rendered };
}

// Splits `text` around case-insensitive occurrences of `term` and emits
// each piece via writeStyled — base `style` for surrounding text,
// "search-highlight" for matches. When activeCol is non-null, the
// occurrence that starts at that exact col renders with the louder
// "search-highlight-active" style instead, so the user can spot which
// match the ^r/^s cursor is currently pointing at. When `term` is empty
// or absent the function degrades to a single writeStyled call. Matches
// do not overlap (we advance past each match's full length).
function writeBodyWithHighlight(
  termObj: Terminal,
  text: string,
  style: Style | undefined,
  term: string,
  activeCol: number | null = null,
  _activeLength: number = 0,
  hovered: boolean = false,
): void {
  if (text.length === 0) {
    return;
  }
  if (term.length === 0) {
    writeStyled(termObj, text, style, hovered);
    return;
  }
  const haystack = text.toLowerCase();
  let i = 0;
  while (i < text.length) {
    const next = haystack.indexOf(term, i);
    if (next === -1) {
      writeStyled(termObj, text.slice(i), style, hovered);
      return;
    }
    if (next > i) {
      writeStyled(termObj, text.slice(i, next), style, hovered);
    }
    const isActive = activeCol !== null && next === activeCol;
    writeStyled(
      termObj,
      text.slice(next, next + term.length),
      isActive ? "search-highlight-active" : "search-highlight",
      hovered,
    );
    i = next + term.length;
  }
}

// Body styles that route through terminal-kit's markup-interpreting writer
// in writeStyled. Wrap/truncate must subtract their caret markers when
// computing visible width, or `^Cfoo^:` (7 JS chars) inflates the budget
// by 4 and a long span near the right edge wraps too early.
function bodyStyleUsesMarkup(style: Style | undefined): boolean {
  return (
    style === "agent" ||
    // Thoughts switched to the markup-interpreting writer (writeStyled's
    // "thought" case uses term.brightBlack without .noFormat), so their
    // caret spans (^ccode^K, ^+bold^-) are zero-width on screen. wrap/
    // truncate must strip them too or thought lines wrap several columns
    // short of the margin whenever they contain inline code/bold.
    style === "thought" ||
    style === "heading-1" ||
    style === "heading-2" ||
    style === "heading-3" ||
    // Plan entries route through applyInlineMarkup in formatPlan so inline
    // `code`/**bold** in entry content renders styled instead of as literal
    // backticks/asterisks. Width-budgeting must strip these carets too.
    style === "plan" ||
    style === "plan-done" ||
    style === "plan-pending"
  );
}

function writeStyled(
  term: Terminal,
  text: string,
  style: Style | undefined,
  hovered: boolean = false,
): void {
  if (text.length === 0) {
    return;
  }
  if (hovered) {
    switch (style) {
      case "tool-status-ok":
      case "tool-status-pending":
      case "tool-status-cancelled":
      case "dim":
        term.noFormat(text);
        return;
      case "plan-pending":
        term(text);
        return;
      case "thought":
        // The thought markdown bakes "^K" (set fg → brightBlack) after every
        // inline `code` span so the dim gray base holds at rest. On hover
        // we want the line to stay at default fg after each code span, so
        // swap "^K" for "^:" (full reset → terminal default fg).
        term(text.replace(/\^K/g, "^:"));
        return;
      case "code":
        // Lift the grayscale bg from 28 → 60 so the band visibly responds
        // to hover on top of the cli-highlight ANSI bytes in the body.
        (term as unknown as {
          bgColorGrayscale: {
            white: { noFormat: (g: number, t: string) => void };
          };
        }).bgColorGrayscale.white.noFormat(60, text);
        return;
    }
  }
  // "agent" and "heading-1/2/3" opt INTO terminal-kit's format processing —
  // parseAgentMarkdown produces `^+bold^:` / `^Cinline^:` markup that
  // should be interpreted (headings emit per-level closers via
  // headingInlineOptsFor so the outer bold + color restore after each
  // inline span). Every other style renders literal text (user input,
  // code blocks, tool labels, etc.), so we route through `.noFormat` to
  // keep stray carets typed/emitted by the user from being eaten as
  // markup commands.
  switch (style) {
    case "user":
      // Subtle dim-gray band — bold + default foreground (white on dark
      // themes) on a soft #303030-ish background. Earlier attempts at
      // "lighter" gray pushed contrast in the wrong direction or made
      // the band feel like a highlight stripe rather than a quiet
      // boundary marker. 256-color index 236 is a touch lighter than
      // most terminals' default bg, enough to read as a row of its own
      // without screaming.
      //
      // Param/text order matters: terminal-kit's chain consumes param-
      // taking methods immediately when invoked early (emitting `on`
      // without `off`), turning the screen gray. Passing all params +
      // the text to the FINAL call keeps the chain intact so the off
      // sequence fires after the text.
      // bgColorGrayscale(g) takes 0–255 (24-bit grayscale if the terminal
      // supports it, otherwise rounds to the nearest 256-color step).
      // Gives finer steps than the fixed 256-color grayscale ramp where
      // 235 → 236 was a perceptible jump.
      (term as unknown as {
        bgColorGrayscale: {
          bold: { noFormat: (g: number, t: string) => void };
        };
      }).bgColorGrayscale.bold.noFormat(43, text);
      return;
    case "agent":
      term(text);
      return;
    case "thought":
      // Bright-black (gray). noFormat removed so caret markup (^+bold^-,
      // ^Ccode^K) is interpreted; applyInlineMarkup escapes literal ^ → ^^.
      term.brightBlack(text);
      return;
    case "tool":
      term.brightBlue.noFormat(text);
      return;
    case "tool-status-ok":
      term.dim.noFormat(text);
      return;
    case "tool-status-fail":
      term.bold.red.noFormat(text);
      return;
    case "tool-status-pending":
      // "queued" — work hasn't started yet; subdued so running calls
      // stand out next to it.
      term.dim.noFormat(text);
      return;
    case "tool-status-running":
      // Bright yellow so an in-flight tool call jumps out of a column of
      // queued and completed siblings, and matches the banner's busy hue.
      term.brightYellow.noFormat(text);
      return;
    case "tool-status-cancelled":
      term.dim.noFormat(text);
      return;
    case "plan":
      // noFormat dropped so caret markup emitted by applyInlineMarkup
      // (planInlineOptsFor in format.ts closes inline spans with the row's
      // base color so brightYellow/green/dim is restored after the span)
      // is interpreted.
      term.brightYellow(text);
      return;
    case "plan-done":
      term.green(text);
      return;
    case "plan-pending":
      term.dim(text);
      return;
    case "system":
      term.brightYellow.noFormat(text);
      return;
    case "info":
      term.cyan.noFormat(text);
      return;
    case "dim":
      term.dim.noFormat(text);
      return;
    case "code":
      // Dark grayscale band with a plain-white default foreground so
      // code reads like an editor block (and `diff` fences let context
      // lines stand neutral while +/- pick up cli-highlight's red/green
      // overlay). Different hue from the user-text band so the two never
      // get confused at a glance.
      (term as unknown as {
        bgColorGrayscale: {
          white: { noFormat: (g: number, t: string) => void };
        };
      }).bgColorGrayscale.white.noFormat(28, text);
      return;
    case "heading-1":
      // noFormat dropped so caret markup emitted by applyInlineMarkup is
      // interpreted; each heading level's headingInlineOptsFor (format.ts)
      // closes inline spans with the heading's base attrs so bold + color
      // are restored after the span.
      term.bold.brightYellow(text);
      return;
    case "heading-2":
      term.bold.brightCyan(text);
      return;
    case "heading-3":
      term.bold(text);
      return;
    case "search-highlight":
      // Bright yellow background with black foreground. The combination
      // is loud enough to spot inside any base style (dim, info, agent)
      // without being unreadable on light terminal themes.
      term.bgBrightYellow.black.noFormat(text);
      return;
    case "selection-highlight":
      // Classic inverse-video band for the active text selection.
      // Reads as a selection across every base style (agent markup,
      // code blocks, dim, thoughts) and stays distinct from the
      // yellow-bg search-highlight / red-bg search-highlight-active
      // treatments so the two layers don't collide visually when both
      // are active on the same row.
      term.inverse.noFormat(text);
      return;
    case "search-highlight-active":
      // The single "current" match — visually distinct from the
      // generic yellow-bg highlight so the user can spot which match
      // ^r/^s is pointing at without scanning the whole row. Red bg
      // with bright white fg jumps out against both light and dark
      // terminal themes.
      term.bgRed.brightWhite.noFormat(text);
      return;
    default:
      term.noFormat(text);
  }
}

// ANSI-aware wrap. Delegates to wrap-ansi which counts visible width
// (ignoring SGR escape sequences) when splitting, so syntax-highlighted
// code blocks don't get truncated early or split mid-escape. `hard: true`
// hard-breaks lines that exceed `width` even when no break-friendly
// character is available (long unspaced tokens — typical for code).
function wrapAnsiBody(text: string, width: number): string[] {
  if (width <= 0) {
    return [text];
  }
  if (text.length === 0) {
    return [""];
  }
  return wrapAnsi(text, width, { hard: true, trim: false }).split("\n");
}

// Wide-character detection. ASCII printable + space; anything else may have
// visible width != string length (CJK 2-col, emoji ZWJ sequences, fullwidth
// punctuation, combining marks). When false, char-count math is exact and
// the fast path is safe; when true we fall back to grapheme + string-width.
const NON_ASCII = /[^\x20-\x7e]/;
const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// East-Asian "Ambiguous" width handling. string-width's default counts
// ambiguous glyphs (em-dash —, smart quotes “ ”, ellipsis …, middle-dot ·)
// as 1 col, which matches most modern terminals. Terminals configured for
// CJK locales (or `setw -g utf8 on`-style setups) render them as 2 cols; on
// those, the default under-counts and wrapped lines bleed past the right
// margin. setAmbiguousWide(true) makes the whole wrap/truncate budget treat
// ambiguous glyphs as 2 cols so the layout matches what the terminal draws.
let ambiguousWide = false;
export function setAmbiguousWide(wide: boolean): void {
  ambiguousWide = wide;
}

// Resolve the user's ambiguousWidth config to a concrete boolean. "auto" sniffs
// the environment: CJK locales (ja/ko/zh in LC_ALL/LC_CTYPE/LANG) and known
// wide-by-default emulators (Apple Terminal.app) get wide; everything else
// gets narrow. Pure function — takes env as input so it's trivially testable.
export function resolveAmbiguousWide(
  mode: "auto" | "narrow" | "wide",
  env: NodeJS.ProcessEnv,
): boolean {
  if (mode === "wide")
    return true;
  if (mode === "narrow")
    return false;
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || "";
  if (/^(ja|ko|zh)(_|\.|@|$)/i.test(locale))
    return true;
  if (env.TERM_PROGRAM === "Apple_Terminal")
    return true;
  return false;
}
// Single source of truth for visible-column measurement across the wrap and
// truncate paths. Honors the ambiguous-width mode above.
function cellWidth(text: string): number {
  return stringWidth(text, { ambiguousIsNarrow: !ambiguousWide });
}

// terminal-kit caret-markup recognizer. applyInlineMarkup() in format.ts
// rewrites markdown for the "agent" bodyStyle into terminal-kit's `^X`
// markup so term(text) can render styled spans inline:
//   ^^         literal "^"            (1 visible col -- one caret renders)
//   ^X         single-char SGR style  (0 visible cols)
//   ^[#color]  extended color/style   (0 visible cols)
// At render time these are zero-width style commands. Width-budgeting
// routines (wrap/truncate) must skip them when stripMarkup is on, or
// long bullet bodies wrap/truncate too early and can split mid-markup,
// producing visible-text corruption near code/bold spans.
const TK_MARKUP_STYLE_CHAR = /[a-zA-Z+\-:_!#/]/;

interface MarkupMatch {
  text: string;
  width: number;
}

export function matchTkMarkupAt(text: string, i: number): MarkupMatch | null {
  if (text.charCodeAt(i) !== 0x5e /* ^ */) {
    return null;
  }
  const c = text[i + 1];
  if (c === undefined) {
    return null;
  }
  if (c === "^") {
    return { text: "^^", width: 1 };
  }
  if (c === "[") {
    const end = text.indexOf("]", i + 2);
    if (end !== -1) {
      return { text: text.slice(i, end + 1), width: 0 };
    }
  }
  if (TK_MARKUP_STYLE_CHAR.test(c)) {
    return { text: text.slice(i, i + 2), width: 0 };
  }
  return null;
}

// Drop every terminal-kit caret-markup span from `text`, leaving only the
// visible characters. Escaped carets (`^^`) collapse back to a single `^`.
// Used when copying a styled scrollback line to the clipboard so the
// payload is plain text — the same grammar that wrap/truncate already
// recognize, with no parallel definition.
// Like stripTkMarkup but also returns a raw→clean offset map so callers
// that started with an index into the raw (markup-bearing) text can
// project it onto the cleaned view. rawToClean[i] is the index in the
// clean string of the visible char at raw position i (or, for raw
// positions inside a zero-width markup span, the clean index where the
// next visible char will appear). Length is text.length + 1 so the
// past-the-end raw index also maps cleanly.
export function stripTkMarkupWithMap(text: string): {
  clean: string;
  rawToClean: number[];
} {
  const rawToClean = new Array<number>(text.length + 1).fill(0);
  let clean = "";
  let i = 0;
  while (i < text.length) {
    rawToClean[i] = clean.length;
    const m = matchTkMarkupAt(text, i);
    if (m) {
      if (m.width > 0) {
        clean += "^";
      }
      // Every raw byte inside the markup span maps to the same clean
      // index — its trailing edge (where the next visible char lands).
      for (let k = 1; k < m.text.length; k++) {
        rawToClean[i + k] = clean.length;
      }
      i += m.text.length;
      continue;
    }
    clean += text[i];
    i += 1;
  }
  rawToClean[text.length] = clean.length;
  return { clean, rawToClean };
}

export function stripTkMarkup(text: string): string {
  if (!text.includes("^"))
    return text;
  let out = "";
  let i = 0;
  while (i < text.length) {
    const m = matchTkMarkupAt(text, i);
    if (m) {
      if (m.width > 0)
        out += "^";
      i += m.text.length;
      continue;
    }
    out += text[i];
    i += 1;
  }
  return out;
}

// Extract only the zero-width caret-markup tokens from `text`, preserving
// order. Used to "prime" terminal-kit's style state after a selection band
// stripped the visible text: feeding the markup-only string back through
// the markup writer re-applies the toggle/color spans that were active at
// the splice point so the trailing piece keeps its original styling.
// Literal `^^` (a visible caret) is dropped since it has no styling effect.
function tkMarkupTokensOnly(text: string): string {
  if (!text.includes("^")) {
    return "";
  }
  let out = "";
  let i = 0;
  while (i < text.length) {
    const m = matchTkMarkupAt(text, i);
    if (m) {
      if (m.width === 0) {
        out += m.text;
      }
      i += m.text.length;
      continue;
    }
    i += 1;
  }
  return out;
}

function hasTkMarkup(text: string): boolean {
  if (!text.includes("^")) {
    return false;
  }
  for (let i = 0; i < text.length; i++) {
    if (matchTkMarkupAt(text, i)) {
      return true;
    }
  }
  return false;
}

interface WidthSegment {
  text: string;
  width: number;
}

// Walk `text` yielding either a markup span (emitted as one indivisible
// segment of width 0 or 1) or a single grapheme cluster (width measured
// via string-width). Used by the markup-aware wrap/truncate paths so a
// `^Cfoo^:` span is never split across rows and is excluded from the
// visible-column budget.
export function* segmentForWidth(text: string): IterableIterator<WidthSegment> {
  let i = 0;
  while (i < text.length) {
    const m = matchTkMarkupAt(text, i);
    if (m) {
      yield { text: m.text, width: m.width };
      i += m.text.length;
      continue;
    }
    // Walk graphemes only up to the next markup boundary so the
    // segmenter doesn't fuse a stray '^' with adjacent text.
    let runEnd = text.length;
    let probe = text.indexOf("^", i);
    while (probe !== -1 && probe < text.length) {
      if (matchTkMarkupAt(text, probe)) {
        runEnd = probe;
        break;
      }
      probe = text.indexOf("^", probe + 1);
    }
    if (runEnd === i) {
      // Bare '^' that isn't valid markup; render as 1 visible col.
      yield { text: "^", width: 1 };
      i += 1;
      continue;
    }
    for (const { segment } of SEGMENTER.segment(text.slice(i, runEnd))) {
      yield { text: segment, width: cellWidth(segment) };
    }
    i = runEnd;
  }
}

export interface WrapOptions {
  // When true, treat terminal-kit caret markup (`^X`, `^^`, `^[#...]`)
  // as zero-width style commands -- only "agent" bodyStyle text needs
  // this since it's the only style routed through term(text)'s markup-
  // interpreting writer. Default false preserves the historical
  // char-count behavior for cwd/title/spec call sites that render
  // through .noFormat (markup shows literally there).
  stripMarkup?: boolean;
}

// Build the iTerm2 OSC 1337 inline-image escape, optionally wrapped in
// tmux DCS-passthrough. Pure function — exported for unit tests so the
// wrap math (doubling every ESC inside the passthrough payload, ESC \
// terminator, not BEL) can be verified without a real terminal.
export function buildIterm2ImageEscape(
  base64: string,
  heightCells: number,
  insideTmux: boolean,
): string {
  const inner = `\x1b]1337;File=inline=1;height=${heightCells};preserveAspectRatio=1:${base64}\x07`;
  if (!insideTmux) {
    return inner;
  }
  // Tmux DCS-passthrough: prefix with ESC P tmux ;, double every ESC
  // inside the payload, terminate with ESC \ (ST). Without this, tmux
  // swallows the OSC and the host terminal sees nothing.
  const doubled = inner.replace(/\x1b/g, "\x1b\x1b");
  return `\x1bPtmux;${doubled}\x1b\\`;
}

export function wrap(
  text: string,
  width: number,
  opts: WrapOptions = {},
): string[] {
  if (width <= 0) {
    return [text];
  }
  if (text.length === 0) {
    return [""];
  }
  const stripMarkup = opts.stripMarkup === true && hasTkMarkup(text);
  if (!stripMarkup && !NON_ASCII.test(text)) {
    return wrapAscii(text, width);
  }
  return wrapVisible(text, width, stripMarkup);
}

function wrapAscii(text: string, width: number): string[] {
  const out: string[] = [];
  let remaining = text;
  while (remaining.length > width) {
    // Prefer breaking at the last whitespace within the window so words
    // stay intact. Falls back to a hard break when no whitespace fits —
    // e.g. a long URL or path with no spaces.
    const window = remaining.slice(0, width + 1);
    let breakAt = -1;
    for (let i = Math.min(width, window.length - 1); i >= 0; i--) {
      if (window[i] === " ") {
        breakAt = i;
        break;
      }
    }
    if (breakAt <= 0) {
      out.push(remaining.slice(0, width));
      remaining = remaining.slice(width);
    } else {
      out.push(remaining.slice(0, breakAt));
      // Drop the breaking space so continuation lines start with text,
      // not a leading space.
      remaining = remaining.slice(breakAt + 1);
    }
  }
  out.push(remaining);
  return out;
}

// Visible-width-aware wrap. Walks graphemes (and optionally caret-markup
// spans) budgeting by string-width so a CJK char counts as 2 cols, a
// regional-indicator flag as 2, and a `^Cfoo^:` span as just the visible
// "foo" (3 cols). Without this, a body of 80 CJK chars (160 visible
// cols) would render past the right margin and paintRow's sig-based
// skip would never erase that bleed; with markup, the same effect
// happens around inline code/bold spans in agent bullets.
function wrapVisible(
  text: string,
  width: number,
  stripMarkup: boolean,
): string[] {
  const out: string[] = [];
  const segments: WidthSegment[] = stripMarkup
    ? [...segmentForWidth(text)]
    : graphemeSegments(text);
  let i = 0;
  while (i < segments.length) {
    let chunk = "";
    let chunkW = 0;
    let lastSpaceI = -1;
    let chunkAtLastSpace = "";
    while (i < segments.length) {
      const s = segments[i]!;
      if (chunkW + s.width > width) {
        // Mirror wrapAscii's window+1 behavior: a space that *would*
        // push us one col over is still a valid break point. Without
        // this, a chunk that ends exactly on the budget would carry
        // its trailing space into the next chunk as a leading space.
        if (s.text === " " && s.width === 1) {
          lastSpaceI = i;
          chunkAtLastSpace = chunk;
        }
        break;
      }
      if (s.text === " " && s.width === 1) {
        lastSpaceI = i;
        chunkAtLastSpace = chunk;
      }
      chunk += s.text;
      chunkW += s.width;
      i += 1;
    }
    if (i >= segments.length) {
      out.push(chunk);
      break;
    }
    if (lastSpaceI >= 0) {
      out.push(chunkAtLastSpace);
      i = lastSpaceI + 1;
    } else if (chunk.length === 0) {
      // Single grapheme wider than width — emit it anyway so we make
      // forward progress. The terminal will clip it (with DECAWM off)
      // or wrap it (without), but either way the next iteration moves on.
      out.push(segments[i]!.text);
      i += 1;
    } else {
      out.push(chunk);
    }
  }
  return out;
}

function graphemeSegments(text: string): WidthSegment[] {
  const out: WidthSegment[] = [];
  for (const { segment } of SEGMENTER.segment(text)) {
    out.push({ text: segment, width: cellWidth(segment) });
  }
  return out;
}

export interface TruncateOptions {
  // See WrapOptions.stripMarkup -- same semantics for truncate.
  stripMarkup?: boolean;
}

export function truncate(
  text: string,
  max: number,
  opts: TruncateOptions = {},
): string {
  if (max <= 0) {
    return "";
  }
  const stripMarkup = opts.stripMarkup === true && hasTkMarkup(text);
  if (!stripMarkup && text.length <= max && !NON_ASCII.test(text)) {
    return text;
  }
  if (!stripMarkup) {
    const visible = cellWidth(text);
    if (visible <= max) {
      return text;
    }
    if (max <= 1) {
      return takeByWidth(text, max);
    }
    return takeByWidth(text, max - 1) + "…";
  }
  // Markup-aware path: segmentForWidth yields ^X spans with width 0 (or
  // 1 for ^^) so they don't consume budget, and stays indivisible so a
  // truncate can't cut between '^' and the style char.
  const segments = [...segmentForWidth(text)];
  let visible = 0;
  for (const s of segments) {
    visible += s.width;
  }
  if (visible <= max) {
    return text;
  }
  if (max <= 1) {
    return takeFromSegments(segments, max);
  }
  return takeFromSegments(segments, max - 1) + "…";
}

function takeByWidth(text: string, budget: number): string {
  if (budget <= 0) {
    return "";
  }
  let out = "";
  let used = 0;
  for (const { segment } of SEGMENTER.segment(text)) {
    const w = cellWidth(segment);
    if (used + w > budget) {
      break;
    }
    out += segment;
    used += w;
  }
  return out;
}

function takeFromSegments(segments: WidthSegment[], budget: number): string {
  if (budget <= 0) {
    return "";
  }
  let out = "";
  let used = 0;
  for (const s of segments) {
    if (used + s.width > budget) {
      break;
    }
    out += s.text;
    used += s.width;
  }
  return out;
}

function firstLine(text: string): string {
  const idx = text.indexOf("\n");
  return idx === -1 ? text : `${text.slice(0, idx)} ↵`;
}

// Re-export for clarity at call sites that read `shortId(id)`. The shared
// helper lives in core/session.ts alongside the prefix constant.
const shortId = stripHydraSessionPrefix;

function formatUsage(usage: UsageState | undefined): string | null {
  if (!usage) {
    return null;
  }
  const parts: string[] = [];
  if (typeof usage.used === "number") {
    if (typeof usage.size === "number" && usage.size > 0) {
      parts.push(`${formatTokens(usage.used)}/${formatTokens(usage.size)}`);
    } else {
      parts.push(formatTokens(usage.used));
    }
  } else if (typeof usage.size === "number") {
    parts.push(`/${formatTokens(usage.size)}`);
  }
  if (typeof usage.costAmount === "number") {
    parts.push(formatCost(usage.costAmount, usage.costCurrency));
  }
  return parts.length === 0 ? null : parts.join(" · ");
}



function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(1)}k`;
  }
  return `${n}`;
}

export function mapKeyName(name: string): KeyName | null {
  switch (name) {
    case "ENTER":
    case "KP_ENTER":
      return "enter";
    case "ALT_ENTER":
    case "META_ENTER":
      return "alt-enter";
    case "SHIFT_ENTER":
      return "shift-enter";
    case "CTRL_ENTER":
      return "ctrl-enter";
    case "CTRL_J":
      // gnome-terminal etc. send the LF byte (0x0a) for Ctrl+Enter.
      // Our raw-stdin handler usually catches that before terminal-kit
      // sees it, but if anything slips through (e.g. a non-paste chunk
      // we didn't pre-process), terminal-kit identifies the byte as
      // CTRL_J. Route to ctrl-enter so the behavior is consistent.
      return "ctrl-enter";
    case "ALT_B":
    case "META_B":
      return "alt-b";
    case "ALT_F":
    case "META_F":
      return "alt-f";
    case "ALT_N":
    case "META_N":
      return "alt-n";
    case "ALT_TAB":
    case "META_TAB":
      return "alt-tab";
    case "CTRL_T":
      return "ctrl-t";
    case "SHIFT_TAB":
      return "shift-tab";
    case "TAB":
      return "tab";
    case "UP":
      return "up";
    case "DOWN":
      return "down";
    case "LEFT":
      return "left";
    case "RIGHT":
      return "right";
    case "HOME":
      return "home";
    case "END":
      return "end";
    case "BACKSPACE":
      return "backspace";
    case "DELETE":
      return "delete";
    case "CTRL_A":
      return "ctrl-a";
    case "CTRL_B":
      return "ctrl-b";
    case "CTRL_C":
      return "ctrl-c";
    case "CTRL_D":
      return "ctrl-d";
    case "CTRL_E":
      return "ctrl-e";
    case "CTRL_F":
      return "ctrl-f";
    case "CTRL_G":
      return "ctrl-g";
    case "CTRL_K":
      return "ctrl-k";
    case "CTRL_L":
      return "ctrl-l";
    case "CTRL_N":
      return "ctrl-n";
    case "CTRL_O":
      return "ctrl-o";
    case "CTRL_P":
      return "ctrl-p";
    case "CTRL_Q":
      return "ctrl-q";
    case "CTRL_R":
      return "ctrl-r";
    case "CTRL_S":
      return "ctrl-s";
    case "CTRL_U":
      return "ctrl-u";
    case "CTRL_V":
      return "ctrl-v";
    case "CTRL_W":
      return "ctrl-w";
    case "CTRL_X":
      return "ctrl-x";
    case "CTRL_Y":
      return "ctrl-y";
    case "ESCAPE":
      return "escape";
    default:
      return null;
  }
}

// Synchronous best-effort restore of every terminal mode the screen
// enables. Called from process exit handlers — graceful stop() also
// undoes these, but SIGTERM / SIGHUP / uncaughtException bypass it and
// would otherwise leave iTerm wedged with mouse capture or kitty stack
// stuck pushed. Sequences are idempotent: writing them when the mode
// isn't set is harmless.
export function emergencyTerminalReset(): void {
  const seq = [
    MOUSE_X10_OFF, // mouse button reporting off
    MOUSE_BUTTON_OFF, // mouse drag reporting off
    MOUSE_ANY_MOTION_OFF, // mouse any-motion reporting off
    MOUSE_SGR_OFF, // SGR mouse mode off
    MOUSE_URXVT_OFF, // urxvt mouse mode off
    SELECTIVE_MOUSE_OFF, // MasterBandit selective mouse reporting off
    BRACKETED_PASTE_OFF, // bracketed paste off
    MODIFY_OTHER_KEYS_OFF, // xterm modifyOtherKeys off
    FORMAT_OTHER_KEYS_OFF, // xterm formatOtherKeys off
    KITTY_KBD_POP, // pop kitty keyboard stack
    DECCKM_OFF, // DECCKM off: arrows send CSI A/B/C/D not SS3 O A/B/C/D
    DECPAM_OFF, // DECPAM off: numeric keypad mode
    AUTOWRAP_ON, // auto-wrap on
    SHOW_CURSOR, // show cursor
    POINTER_SHAPE_DEFAULT, // reset OS pointer-shape (OSC 22)
    "\x1b]9;4;0\x07", // clear OSC 9;4 progress indicator
    ALT_SCREEN_LEAVE, // leave alternate screen
  ].join("");
  try {
    process.stdout.write(seq);
  } catch {
    // stdout might already be closed — nothing else we can do.
  }
}

// terminal-kit stores width/height as plain properties: `undefined` until
// the first size probe, and `Infinity` whenever stdout isn't a TTY (see
// Terminal.js onResize — "the size is virtually infinite"). The render
// path does arithmetic on these (e.g. padEnd(width)), and `Infinity` or
// `NaN` there throws `RangeError: Invalid string length`, killing the
// TUI on startup. Redefine width/height as accessors that keep the raw
// terminal-kit value (so live resizes still flow through the setter) but
// always hand callers a finite, positive number. Idempotent.
export function guardTerminalDimensions(term: Terminal): void {
  const dims: ReadonlyArray<readonly ["width" | "height", number]> = [
    ["width", 80],
    ["height", 24],
  ];
  for (const [prop, fallback] of dims) {
    const existing = Object.getOwnPropertyDescriptor(term, prop);
    // Already guarded (accessor installed) — nothing to do.
    if (existing && existing.get) {
      continue;
    }
    const backing = Symbol(`raw-${prop}`);
    const store = term as unknown as Record<symbol, unknown>;
    store[backing] = existing ? existing.value : undefined;
    Object.defineProperty(term, prop, {
      configurable: true,
      enumerable: true,
      get(): number {
        const v = (this as Record<symbol, unknown>)[backing];
        return typeof v === "number" && Number.isFinite(v) && v > 0
          ? v
          : fallback;
      },
      set(v: unknown): void {
        (this as Record<symbol, unknown>)[backing] = v;
      },
    });
  }
}

// Kitty keyboard protocol modifier codes are 1 + bitfield of
// shift(1) | alt(2) | ctrl(4) | super(8) | hyper(16) | meta(32).
// We only care about plain (1), shift (2), alt (3), ctrl (5).
export function mapCsiUToKeyName(code: number, mod: number): KeyName | null {
  // Full Ctrl+a–z table. h/i/j/m alias to backspace/tab/ctrl-enter/enter
  // because those are the bytes those combos produce in terminals
  // without modifyOtherKeys, and users press them expecting that
  // behavior regardless of whether xterm chose to escape the keystroke.
  const CTRL_LETTERS: Record<number, KeyName> = {
    97: "ctrl-a",
    98: "ctrl-b",
    99: "ctrl-c",
    100: "ctrl-d",
    101: "ctrl-e",
    102: "ctrl-f",
    103: "ctrl-g",
    104: "backspace",
    105: "tab",
    106: "ctrl-enter",
    107: "ctrl-k",
    108: "ctrl-l",
    109: "enter",
    110: "ctrl-n",
    111: "ctrl-o",
    112: "ctrl-p",
    113: "ctrl-q",
    114: "ctrl-r",
    115: "ctrl-s",
    116: "ctrl-t",
    117: "ctrl-u",
    118: "ctrl-v",
    119: "ctrl-w",
    120: "ctrl-x",
    121: "ctrl-y",
  };
  if (mod === 5) {
    return CTRL_LETTERS[code] ?? null;
  }
  if (code === 27) {
    return "escape";
  }
  if (code === 9) {
    if (mod === 2) {
      return "shift-tab";
    }
    if (mod === 3) {
      return "alt-tab";
    }
    if (mod === 1) {
      return "tab";
    }
    return null;
  }
  if (code === 13) {
    if (mod === 2) {
      return "shift-enter";
    }
    if (mod === 3) {
      return "alt-enter";
    }
    if (mod === 5) {
      return "ctrl-enter";
    }
    if (mod === 1) {
      return "enter";
    }
    return null;
  }
  if (code === 127 && mod === 1) {
    return "backspace";
  }
  // Ctrl-_ (readline undo) and Alt-_ (our redo). codepoint 95 = '_'.
  // Some terminals advertise these as code 47 ('/') with ctrl, since
  // Ctrl-/ and Ctrl-_ collapse to the same byte 0x1f outside the
  // protocol; we accept both spellings.
  if ((code === 95 || code === 47) && mod === 5) {
    return "ctrl-underscore";
  }
  if ((code === 95 || code === 47) && mod === 7) {
    return "alt-underscore";
  }
  if (mod === 3) {
    if (code === 98 || code === 66) {
      return "alt-b";
    }
    if (code === 102 || code === 70) {
      return "alt-f";
    }
    if (code === 110 || code === 78) {
      return "alt-n";
    }
    if (code === 95) {
      return "alt-underscore";
    }
    return null;
  }
  return null;
}
