// Screen layer: owns terminal-kit setup, layout, and the live render of
// scrollback + prompt + sessionbar + banner. Receives `KeyEvent`s from the
// user and delegates them to an `InputDispatcher` (held by the app), then
// redraws.

import stringWidth from "string-width";
import type { Terminal } from "terminal-kit";
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
import { withSync } from "./sync.js";

export interface ScreenOptions {
  term: Terminal;
  dispatcher: InputDispatcher;
  onKey: (events: KeyEvent[]) => void;
  // Invoked with the keyed-block key under a left-click, when full mouse
  // capture is on and the click lands on a row owned by an upserted block
  // (e.g. "tools:3", "plan", "editdiff:<id>"). Lets the app toggle a
  // single block's expand/collapse. Clicks on unkeyed rows are ignored.
  onBlockClick?: (key: string) => void;
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
}

// Tiny modal used by the TUI to confirm a destructive exit (e.g. "agent
// is still working — interrupt before quitting?"). Two-line layout:
// the question, then a one-line hint listing the accepted keys.
export interface ConfirmPromptSpec {
  question: string;
  hint: string;
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

export interface CompletionItem {
  name: string;
  description?: string;
}

const SESSIONBAR_ROWS = 1;
const BANNER_ROWS = 1;
const SEPARATOR_ROWS = 1;
export const MAX_PROMPT_ROWS = 8;
const MAX_QUEUED_ROWS = 5;
const MAX_PERMISSION_ROWS = 12;
const MAX_OPTIONS_ROWS = 12;
const MAX_HELP_ROWS = 30;
const MAX_COMPLETION_ROWS = 6;
const MAX_CHIP_ROWS = 4;
const CONFIRM_PROMPT_ROWS = 2;
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

export class Screen {
  private term: Terminal;
  private dispatcher: InputDispatcher;
  private onKey: (events: KeyEvent[]) => void;
  private onBlockClick: ((key: string) => void) | undefined;
  private onBlockVisible: ((key: string) => void) | undefined;
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
  private lastRepaintAt = 0;
  private throttledRepaintTimer: NodeJS.Timeout | null = null;
  private contentRepaintThrottleMs: number;
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
  // Per-row signature of what was painted to each terminal row on the
  // previous repaint. drawX methods funnel through paintRow(), which
  // skips the moveTo+eraseLineAfter+write sequence when the new
  // signature matches the previous frame. Eliminates flicker during
  // the 1Hz busy-tick: only rows whose content actually changed
  // (banner elapsed, tools-block summary) get re-emitted instead of
  // every visible row. Cleared on dimension change.
  private lastFrameRows = new Map<number, string>();
  private lastFrameW = 0;
  private lastFrameH = 0;
  private permissionPrompt: PermissionPromptSpec | null = null;
  private optionsPrompt: OptionsPromptSpec | null = null;
  private confirmPrompt: ConfirmPromptSpec | null = null;
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
  // Right-side banner slot. Three sources, in priority order:
  //   1. Active scrollback search term (auto, from this.scrollbackSearch)
  //   2. External search indicator pushed by the app while prompt-
  //      history reverse-search is active (gives that mode visible
  //      feedback for its otherwise-hidden query)
  //   3. Transient notification set via notify(), auto-cleared after
  //      durationMs
  private bannerNotification: string | null = null;
  private bannerNotificationTimer: NodeJS.Timeout | null = null;
  private bannerSearchIndicator: string | null = null;
  private banner: BannerState = {
    status: "ready",
    currentMode: undefined,
    hint: "⇧⇥ mode · ⌃P pick · ⌃G guide · ⌃D detach",
    queued: 0,
  };
  private sessionbar: SessionbarState = { agent: "?", cwd: "?", sessionId: "?" };
  private lastWindowTitle: string | null = null;
  private resizeHandler: () => void;
  private keyHandler: (name: string, _matches: string[], data: { isCharacter?: boolean }) => void;
  private mouseHandler: (name: string, data: unknown) => void;
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
  private pasteBuffer = "";
  private rawStdinHandler: (chunk: Buffer) => void;
  private mouseEnabled: boolean;
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
    this.onKey = opts.onKey;
    this.onBlockClick = opts.onBlockClick;
    this.onBlockVisible = opts.onBlockVisible;
    this.contentRepaintThrottleMs =
      opts.repaintThrottleMs ?? DEFAULT_CONTENT_REPAINT_THROTTLE_MS;
    this.maxScrollbackLines =
      opts.maxScrollbackLines ?? DEFAULT_MAX_SCROLLBACK_LINES;
    this.mouseEnabled = opts.mouse ?? false;
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
    this.lastFrameRows.clear();
    this.lastFrameW = 0;
    this.lastFrameH = 0;
    this.lastWindowTitle = null;
    // Disable auto-wrap (DECAWM). Our row painter assumes each row starts
    // with a moveTo + eraseLineAfter, so any character that overflows the
    // right margin should be clipped, not wrapped onto the next physical
    // row. Without this, a wide-unicode body whose visible width exceeds
    // our wrap budget would bleed onto the row below, and paintRow's
    // sig-based skip can leave that bleed uncleared indefinitely.
    process.stdout.write("\x1b[?7l");
    // mouse: "button" enables wheel + click reporting so we can intercept
    // mouse-wheel events for scrollback. terminal-kit emits these through
    // the same "key" channel as MOUSE_WHEEL_UP / MOUSE_WHEEL_DOWN names.
    // Skip mouse capture when disabled via config so click-drag text
    // selection works without shift; the trade-off is wheel scrollback.
    if (this.mouseEnabled) {
      this.term.grabInput({ mouse: "button" });
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
    if (this.throttledRepaintTimer) {
      clearTimeout(this.throttledRepaintTimer);
      this.throttledRepaintTimer = null;
    }
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
    if (!opts.keepFullscreen) {
      // Restore auto-wrap so the host shell behaves normally after exit.
      // Only needed on the way out — the picker doesn't re-enable it,
      // so leaving auto-wrap disabled across the picker round-trip is
      // fine (start() will re-disable on resume anyway).
      process.stdout.write("\x1b[?7h");
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
    process.stdout.write("\x1b[?2004h");
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
    process.stdout.write("\x1b[>4;2m");
    process.stdout.write("\x1b[>5;1m");
    process.stdout.write("\x1b[>1u");
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
    process.stdout.write("\x1b[?2004l");
    process.stdout.write("\x1b[>4;0m");
    process.stdout.write("\x1b[>5;0m");
    process.stdout.write("\x1b[<u");
    // Force normal cursor key mode (DECCKM off) + numeric keypad mode
    // (DECPAM off). Alt-screen enable enables application cursor mode
    // on iTerm, which makes arrows send \x1bOA. The picker uses
    // terminal-kit's osx-256color config which only recognizes \x1b[A,
    // so without this reset arrows don't reach the picker's key handler.
    process.stdout.write("\x1b[?1l");
    process.stdout.write("\x1b>");
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
    process.stdout.write("\x1b[?w");
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
      process.stdout.write("\x1b[=0;0w");
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
        process.stdout.write("\x1b[=24;1w");
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
    if (text.includes("\x1b[200~")) {
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
    const startMarker = "\x1b[200~";
    const endMarker = "\x1b[201~";
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
      this.term.grabInput({ mouse: "button" });
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
  private bannerRightContent(): { text: string; kind: "search" | "notify" } | null {
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
    return null;
  }

  clearScrollback(): void {
    this.lines = [];
    this.keyedBlocks.clear();
    this.wrapCache.clear();
    this.wrapCacheWidth = 0;
    this.streamingActive = false;
    this.scrollOffset = 0;
    this.repaint();
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

  redraw(): void {
    this.repaint();
  }

  // Forced clean-slate repaint. Drops the per-row signature cache, the
  // window-title cache, the wrap cache, and clears the terminal before
  // painting. Wired to ^L so the user can recover when something has
  // corrupted the visible state and the per-row sig check otherwise
  // short-circuits the re-emit.
  fullRedraw(): void {
    this.lastFrameRows.clear();
    this.lastFrameW = 0;
    this.lastFrameH = 0;
    this.lastWindowTitle = null;
    this.wrapCache.clear();
    this.wrapCacheWidth = 0;
    // Re-assert DECAWM-off in case something turned it back on.
    process.stdout.write("\x1b[?7l");
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
    this.permissionPrompt = spec ? { ...spec } : null;
    this.repaint();
  }

  // Interactive session-options modal (^O). Takes over the prompt area
  // like the permission modal. Pass null to dismiss.
  setOptionsPrompt(spec: OptionsPromptSpec | null): void {
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
    this.confirmPrompt = spec ? { ...spec } : null;
    this.repaint();
  }

  // Multi-row help cheatsheet that takes over the prompt area. Used by
  // the ^G hotkey to surface every binding without dropping the user
  // out of the session. Pass null to dismiss.
  setHelpPrompt(spec: HelpPromptSpec | null): void {
    this.helpPrompt = spec
      ? { ...spec, entries: [...spec.entries] }
      : null;
    this.repaint();
  }

  isHelpPromptActive(): boolean {
    return this.helpPrompt !== null;
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
    // terminal-kit emits MOUSE_WHEEL_{UP,DOWN} (and MOUSE_LEFT_BUTTON_*,
    // etc.) on the "mouse" event channel, not "key", when grabInput's
    // mouse: "button" is set.
    if (name === "MOUSE_WHEEL_UP") {
      this.scrollBy(3);
      return;
    }
    if (name === "MOUSE_WHEEL_DOWN") {
      this.scrollBy(-3);
      return;
    }
    // Left-click on a keyed scrollback block toggles that single block's
    // expand/collapse via the app. Only consulted under full mouse
    // capture (this path is unreachable in wheel-only/selective mode,
    // which never reports button events). Clicks on unkeyed rows fall
    // through silently so they don't disturb anything.
    if (name === "MOUSE_LEFT_BUTTON_PRESSED" && this.onBlockClick) {
      const y =
        data && typeof data === "object" && "y" in data
          ? Number((data as { y: unknown }).y)
          : NaN;
      if (Number.isFinite(y)) {
        const key = this.keyAtRow(y);
        if (key !== null) {
          this.onBlockClick(key);
        }
      }
    }
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
      SEPARATOR_ROWS - // separator between banner and sessionbar
      BANNER_ROWS -
      SEPARATOR_ROWS - // separator above prompt
      this.chipRows() -
      this.queuedRows() -
      this.completionRows();
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
    if (!this.started) {
      return;
    }
    if (this.repaintPaused > 0) {
      this.repaintPending = true;
      return;
    }
    if (this.contentRepaintThrottleMs <= 0) {
      this.repaint();
      return;
    }
    const now = Date.now();
    const elapsed = now - this.lastRepaintAt;
    if (elapsed >= this.contentRepaintThrottleMs) {
      if (this.throttledRepaintTimer) {
        clearTimeout(this.throttledRepaintTimer);
        this.throttledRepaintTimer = null;
      }
      this.repaint();
      return;
    }
    if (this.throttledRepaintTimer !== null) {
      return;
    }
    this.throttledRepaintTimer = setTimeout(() => {
      this.throttledRepaintTimer = null;
      this.repaint();
    }, this.contentRepaintThrottleMs - elapsed);
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
    if (row < 1 || row > this.term.height) {
      return;
    }
    if (this.lastFrameRows.get(row) === signature) {
      return;
    }
    this.lastFrameRows.set(row, signature);
    this.term.moveTo(1, row);
    paint();
    this.term.styleReset();
    this.term.eraseLineAfter();
  }

  private repaint(): void {
    if (!this.started) {
      return;
    }
    if (this.repaintPaused > 0) {
      this.repaintPending = true;
      return;
    }
    this.lastRepaintAt = Date.now();
    if (this.throttledRepaintTimer) {
      clearTimeout(this.throttledRepaintTimer);
      this.throttledRepaintTimer = null;
    }
    const w = this.term.width;
    const h = this.term.height;
    if (w < 20 || h < 8) {
      return;
    }
    if (w !== this.lastFrameW || h !== this.lastFrameH) {
      this.lastFrameRows.clear();
      this.lastFrameW = w;
      this.lastFrameH = h;
    }
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
      // Total bottom reservation = promptRows + 2*SEPARATOR_ROWS +
      // BANNER_ROWS + SESSIONBAR_ROWS.
      const separatorAbovePromptRow =
        h - promptRows - BANNER_ROWS - SEPARATOR_ROWS - SESSIONBAR_ROWS;
      this.drawSeparator(separatorAbovePromptRow);
      this.drawPrompt();
      this.drawBanner();
      this.drawSeparator(h - SESSIONBAR_ROWS);
      this.drawSessionbar();
      this.placeCursor();
      if (
        this.permissionPrompt ||
        this.optionsPrompt ||
        this.confirmPrompt ||
        this.helpPrompt
      ) {
        this.term.hideCursor(false);
      }
      this.lastPromptRows = promptRows;
    });
  }

  private drawSessionbar(): void {
    const w = this.term.width;
    const row = this.term.height;
    const sid = shortId(this.sessionbar.sessionId);
    const title = this.sessionbar.title?.trim();
    const agentCell = formatAgentWithModel(this.sessionbar.agent, this.sessionbar.model);
    const cwdDisplay = shortenHomePath(this.sessionbar.cwd);
    const usage = formatUsage(this.sessionbar.usage);
    const sig = `sbar|${w}|${sid}|${agentCell}|${cwdDisplay}|${title ?? ""}|${usage ?? ""}`;
    this.paintRow(row, sig, () => {
      // Layout: <sid · agent(model) · cwd · title>           <usage>
      // Left side is bullet-separated; usage is right-aligned with a
      // small margin from the right edge. cwd and title share whatever
      // horizontal room is left after the fixed pieces and the usage
      // reservation, with title getting priority over a long cwd so it
      // always keeps a sliver.
      const usageReserve = usage ? usage.length + 3 : 0;
      const fixed =
        sid.length +
        " · ".length +
        agentCell.length +
        " · ".length +
        (title ? " · ".length : 0) +
        usageReserve;
      const variableRoom = Math.max(8, w - fixed);
      let cwdRoom: number;
      let titleRoom: number;
      if (title) {
        const titleMin = Math.min(title.length, 8);
        cwdRoom = Math.min(cwdDisplay.length, Math.max(8, variableRoom - titleMin));
        titleRoom = Math.max(0, variableRoom - cwdRoom);
      } else {
        titleRoom = 0;
        cwdRoom = variableRoom;
      }
      // noFormat on the user-controlled cells (agent name, cwd, title) so a
      // literal `^X` in any of them isn't eaten as terminal-kit markup.
      this.term
        .yellow(sid)(" · ")
        .cyan.noFormat(agentCell)(" · ")
        .dim.noFormat(truncate(cwdDisplay, cwdRoom));
      if (title) {
        this.term(" · ").bold.noFormat(truncate(title, titleRoom));
      }
      // Clear the gap between end-of-left-content and start-of-usage
      // before moving over. paintRow doesn't pre-clear the row, so a
      // previous frame's longer title (or a prior session's title)
      // would leak its trailing characters into this frame's gap.
      // Same fix drawBanner() uses for its right slot.
      this.term.eraseLineAfter();
      if (usage) {
        // Land the final char at col w-1, not w: paintRow's trailing
        // eraseLineAfter sits at col w with "pending wrap" set, and on
        // most terminals EL 0 erases that column — clipping our last
        // character (e.g. "$5.15" → "$5.1"). Same fix drawBanner() uses
        // for its right slot.
        const visibleWidth = stringWidth(usage);
        const col = Math.max(1, w - visibleWidth);
        this.term.moveTo(col, row).eraseLineAfter();
        this.term.dim.noFormat(usage);
      }
    });
  }

  private drawSeparator(row: number): void {
    const w = this.term.width;
    this.paintRow(row, `sep|${w}`, () => {
      this.term.dim("─".repeat(w));
    });
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
    for (let i = 0; i < visibleRows; i++) {
      const row = top + i;
      const sliceIdx = i - padTop;
      const line = sliceIdx >= 0 ? slice[sliceIdx] : undefined;
      const activeCol = this.activeMatchCol(line, matchInfo);
      const sig = formattedLineSig(
        "sb",
        w,
        line,
        this.scrollbackHighlight,
        activeCol,
      );
      this.paintRow(row, sig, () => {
        if (line) {
          this.writeFormattedLine(line, w, activeCol, activeLength);
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
      SEPARATOR_ROWS -
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
      SEPARATOR_ROWS -
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
      SEPARATOR_ROWS -
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
      SEPARATOR_ROWS -
      SESSIONBAR_ROWS +
      1;
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
          this.term.brightWhite("> ");
        } else if (gutter === "newline") {
          this.term.dim("· ");
        } else {
          this.term("  ");
        }
        // noFormat so literal `^X` typed by the user is rendered verbatim
        // and not interpreted as terminal-kit's color/style markup.
        this.term.noFormat(slice);
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
      SEPARATOR_ROWS -
      SESSIONBAR_ROWS +
      1;
    this.paintRow(top, `confirm|q|${w}|${spec.question}`, () => {
      this.term.brightYellow(` ? ${truncate(spec.question, w - 4)}`);
    });
    this.paintRow(top + 1, `confirm|h|${w}|${spec.hint}`, () => {
      this.term.dim(` ${truncate(spec.hint, w - 2)}`);
    });
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
      SEPARATOR_ROWS -
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
      SEPARATOR_ROWS -
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

  private drawBanner(): void {
    const row = this.term.height - SESSIONBAR_ROWS - SEPARATOR_ROWS;
    const w = this.term.width;
    // Use the rendered elapsed string in the sig (not raw ms), so a tick
    // landing within the same displayed-second skips the repaint. Tied to
    // formatElapsed exactly: identical sig ⇒ identical bytes.
    const elapsedStr =
      this.banner.status === "busy" &&
      this.banner.elapsedMs !== undefined &&
      this.banner.elapsedMs >= 1000
        ? formatElapsed(this.banner.elapsedMs)
        : "";
    const right = this.bannerRightContent();
    const rightSig = right ? `${right.kind}|${right.text}` : "";
    const stalled = this.banner.status === "busy" && this.banner.stalled === true;
    const sig =
      `bnr|${w}|${this.banner.status}|${elapsedStr}|${stalled ? "1" : "0"}|` +
      `${this.banner.queued}|${this.scrollOffset}|` +
      `${this.banner.currentMode ?? ""}|${this.banner.hint}|` +
      rightSig;
    this.paintRow(row, sig, () => {
      const dot = this.banner.status === "busy" ? "●" : "○";
      if (this.banner.status === "busy") {
        if (stalled) {
          this.term.brightRed(`${dot} stalled`);
        } else {
          this.term.brightYellow(`${dot} ${this.banner.status}`);
        }
        if (elapsedStr) {
          this.term(" ").dim(elapsedStr);
        }
      } else if (this.banner.status === "disconnected") {
        this.term.brightRed(`${dot} ${this.banner.status}`);
      } else if (this.banner.status === "cold") {
        this.term.brightMagenta(`${dot} ${this.banner.status}`);
      } else {
        this.term.brightGreen(`${dot} ${this.banner.status}`);
      }
      if (this.banner.queued > 0) {
        this.term(" · ").brightYellow(`${this.banner.queued} queued`);
      }
      if (this.scrollOffset > 0) {
        this.term(" · ").brightCyan(`↑ ${this.scrollOffset}`);
      }
      const hint = this.banner.currentMode
        ? this.banner.hint.replace(
            "⇧⇥ mode",
            `⇧⇥ mode: ${this.banner.currentMode}`,
          )
        : this.banner.hint;
      this.term(" · ").dim(hint);
      // Clear the gap between end-of-hint and start-of-right-slot before
      // moving over. paintRow doesn't pre-clear the row, so a previous
      // frame whose right text started at a column to the LEFT of this
      // frame's right text would leak its leading characters into the
      // gap (e.g. a "thoughts hidden" frame followed by "thoughts shown"
      // — the shorter label starts one column further right, and without
      // this erase the stranded "t" remains visible).
      this.term.eraseLineAfter();
      if (right) {
        // Right-aligned, but with a 1-col gap on the very right edge.
        // The outer paintRow trailing eraseLineAfter sits at col w with
        // "pending wrap" after the last char is written, and on most
        // terminals EL 0 erases that column — which would clip our last
        // character (e.g. "thoughts hidden" → "thoughts hidde"). Landing
        // the final char at col w-1 keeps the stray erase off our text.
        // string-width handles wide glyphs (emoji + CJK).
        const visibleWidth = stringWidth(right.text);
        const col = Math.max(1, w - visibleWidth);
        this.term.moveTo(col, row).eraseLineAfter();
        if (right.kind === "search") {
          this.term.brightCyan.noFormat(right.text);
        } else {
          this.term.brightYellow.noFormat(right.text);
        }
      }
    });
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
        SEPARATOR_ROWS -
        SESSIONBAR_ROWS +
        1;
      const optionRow = top + 3 + this.permissionPrompt.selectedIndex;
      const lastUsableRow =
        this.term.height - BANNER_ROWS - SEPARATOR_ROWS - SESSIONBAR_ROWS;
      this.term.moveTo(2, Math.min(optionRow, lastUsableRow));
      return;
    }
    if (this.optionsPrompt) {
      const rows = this.optionsRows();
      const top =
        this.term.height -
        rows -
        BANNER_ROWS -
        SEPARATOR_ROWS -
        SESSIONBAR_ROWS +
        1;
      // title precedes the option rows
      const optionRow = top + 1 + this.optionsPrompt.selectedIndex;
      const lastUsableRow =
        this.term.height - BANNER_ROWS - SEPARATOR_ROWS - SESSIONBAR_ROWS;
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
        SEPARATOR_ROWS -
        SESSIONBAR_ROWS +
        1;
      this.term.moveTo(2, top);
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
        SEPARATOR_ROWS -
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
      SEPARATOR_ROWS -
      SESSIONBAR_ROWS +
      1;
    const row = top + Math.max(0, layout.cursorVisualRow - layout.windowStart);
    const col = layout.cursorVisualCol + 3; // gutter (2) + 1-based column
    const lastPromptRow =
      this.term.height - BANNER_ROWS - SEPARATOR_ROWS - SESSIONBAR_ROWS;
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
      SEPARATOR_ROWS -
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
    writeRow(`opts|hint|${w}`, () => {
      this.term.dim(" ↑/↓ choose · Enter this session · s save default · Esc close");
    });
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
    // they stay in this.lines so toggling back on restores them.
    const isThought = (line: FormattedLine): boolean =>
      this.hideThoughts && line.bodyStyle === "thought";
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
    const room = Math.max(1, width - prefixCols);
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
  ): void {
    if (line.prefix) {
      writeStyled(this.term, line.prefix, line.prefixStyle ?? line.bodyStyle);
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
    if (this.scrollbackHighlight !== null && !line.ansi) {
      writeBodyWithHighlight(
        this.term,
        bodyText,
        line.bodyStyle,
        this.scrollbackHighlight,
        activeMatchCol,
        activeMatchLength,
      );
    } else {
      writeStyled(this.term, bodyText, line.bodyStyle);
    }
    if (line.fillRow) {
      const visible = line.ansi ? stringWidth(bodyText) : cellWidth(bodyText);
      const pad = remaining - visible;
      if (pad > 0) {
        writeStyled(this.term, " ".repeat(pad), line.bodyStyle);
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
): string {
  const active = activeCol === null ? "" : `a${activeCol}`;
  if (!line) {
    return `${zone}|${width}|empty|${highlight ?? ""}|${active}`;
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
    `${highlight ?? ""}|${active}|${img}`
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
): void {
  if (text.length === 0) {
    return;
  }
  if (term.length === 0) {
    writeStyled(termObj, text, style);
    return;
  }
  const haystack = text.toLowerCase();
  let i = 0;
  while (i < text.length) {
    const next = haystack.indexOf(term, i);
    if (next === -1) {
      writeStyled(termObj, text.slice(i), style);
      return;
    }
    if (next > i) {
      writeStyled(termObj, text.slice(i, next), style);
    }
    const isActive = activeCol !== null && next === activeCol;
    writeStyled(
      termObj,
      text.slice(next, next + term.length),
      isActive ? "search-highlight-active" : "search-highlight",
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
    style === "heading-3"
  );
}

function writeStyled(term: Terminal, text: string, style: Style | undefined): void {
  if (text.length === 0) {
    return;
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
      term.green.noFormat(text);
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
      term.brightYellow.noFormat(text);
      return;
    case "plan-done":
      term.green.noFormat(text);
      return;
    case "plan-pending":
      term.dim.noFormat(text);
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

function matchTkMarkupAt(text: string, i: number): MarkupMatch | null {
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
function* segmentForWidth(text: string): IterableIterator<WidthSegment> {
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
    "\x1b[?1000l", // mouse button reporting off
    "\x1b[?1002l", // mouse drag reporting off
    "\x1b[?1003l", // mouse any-motion reporting off
    "\x1b[?1006l", // SGR mouse mode off
    "\x1b[?1015l", // urxvt mouse mode off
    "\x1b[=0;0w", // MasterBandit selective mouse reporting off
    "\x1b[?2004l", // bracketed paste off
    "\x1b[>4;0m", // xterm modifyOtherKeys off
    "\x1b[>5;0m", // xterm formatOtherKeys off
    "\x1b[<u", // pop kitty keyboard stack
    "\x1b[?1l", // DECCKM off: arrows send CSI A/B/C/D not SS3 O A/B/C/D
    "\x1b>", // DECPAM off: numeric keypad mode
    "\x1b[?7h", // auto-wrap on
    "\x1b[?25h", // show cursor
    "\x1b]9;4;0\x07", // clear OSC 9;4 progress indicator
    "\x1b[?1049l", // leave alternate screen
  ].join("");
  try {
    process.stdout.write(seq);
  } catch {
    // stdout might already be closed — nothing else we can do.
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
    return null;
  }
  return null;
}
