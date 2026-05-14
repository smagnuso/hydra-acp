// Screen layer: owns terminal-kit setup, layout, and the live render of
// header + scrollback + prompt + banner. Receives `KeyEvent`s from the user
// and delegates them to an `InputDispatcher` (held by the app), then
// redraws.

import stringWidth from "string-width";
import type { Terminal } from "terminal-kit";
import wrapAnsi from "wrap-ansi";
import { formatAgentWithModel, formatCost } from "../core/agent-display.js";
import { shortenHomePath } from "../core/paths.js";
import { stripHydraSessionPrefix } from "../core/session.js";
import type { FormattedLine, Style } from "./format.js";
import type { InputDispatcher, KeyEvent, KeyName } from "./input.js";

export interface ScreenOptions {
  term: Terminal;
  dispatcher: InputDispatcher;
  onKey: (events: KeyEvent[]) => void;
  // Minimum ms between full-screen repaints driven by content events.
  // 0 disables throttling. User-action repaints (scroll, modal, resize,
  // /clear, ^L) bypass this regardless. Default 1000 (1 Hz).
  repaintThrottleMs?: number;
  // Cap on logical lines retained in scrollback. Oldest are dropped on
  // overflow. Default 10_000.
  maxScrollbackLines?: number;
  // When true (default), grabInput captures mouse events so the wheel
  // can drive scrollback. When false, the wheel does nothing but text
  // selection works with plain click-drag (no shift required).
  mouse?: boolean;
}

interface BannerState {
  status: string;
  planMode: boolean;
  hint: string;
  queued: number;
  // Elapsed time the current turn has been running, in milliseconds.
  // Surfaced as "running · 1m 30s" in the banner so the user has
  // continuous feedback that the agent is alive even when it falls
  // silent mid-thought.
  elapsedMs?: number;
}

interface HeaderState {
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
  options: Array<{ label: string }>;
  selectedIndex: number;
}

// Tiny modal used by the TUI to confirm a destructive exit (e.g. "agent
// is still working — interrupt before quitting?"). Two-line layout:
// the question, then a one-line hint listing the accepted keys.
export interface ConfirmPromptSpec {
  question: string;
  hint: string;
}

export interface CompletionItem {
  name: string;
  description?: string;
}

const HEADER_ROWS = 2;
const BANNER_ROWS = 1;
const SEPARATOR_ROWS = 1;
const MAX_PROMPT_ROWS = 8;
const MAX_QUEUED_ROWS = 5;
const MAX_PERMISSION_ROWS = 12;
const MAX_COMPLETION_ROWS = 6;
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

export class Screen {
  private term: Terminal;
  private dispatcher: InputDispatcher;
  private onKey: (events: KeyEvent[]) => void;
  private lines: FormattedLine[] = [];
  // Tracks contiguous blocks of lines that callers may want to mutate in
  // place (e.g. tool-call rows that update from "pending" to "completed",
  // or the agent's plan as entries get checked off). Each block is keyed
  // by an opaque caller-chosen string and remembers its start index and
  // current line count so subsequent upserts splice in-place — adjusting
  // the starts of any later keyed blocks if the size changes.
  private keyedBlocks = new Map<string, { start: number; count: number }>();
  private streamingActive = false;
  private lastPromptRows = 0;
  private queuedTexts: string[] = [];
  private lastQueueEditingIndex = -1;
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
  private confirmPrompt: ConfirmPromptSpec | null = null;
  private completions: CompletionItem[] = [];
  // Scrollback offset: 0 = pinned to bottom (live), N = N wrapped lines
  // above the bottom. Mouse wheel and PgUp/PgDn adjust this; new content
  // pushes the view down naturally when at 0.
  private scrollOffset = 0;
  private banner: BannerState = {
    status: "ready",
    planMode: false,
    hint: "⇧⇥ plan · ⌥⏎ newline · ⌃P pick · ⌃C cancel · ⌃D quit",
    queued: 0,
  };
  private header: HeaderState = { agent: "?", cwd: "?", sessionId: "?" };
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

  constructor(opts: ScreenOptions) {
    this.term = opts.term;
    this.dispatcher = opts.dispatcher;
    this.onKey = opts.onKey;
    this.contentRepaintThrottleMs =
      opts.repaintThrottleMs ?? DEFAULT_CONTENT_REPAINT_THROTTLE_MS;
    this.maxScrollbackLines =
      opts.maxScrollbackLines ?? DEFAULT_MAX_SCROLLBACK_LINES;
    this.mouseEnabled = opts.mouse ?? true;
    this.resizeHandler = () => this.repaint();
    this.keyHandler = (name, _matches, data) => this.handleKey(name, data);
    this.mouseHandler = (name) => this.handleMouse(name);
    this.rawStdinHandler = (chunk) => this.handleRawStdin(chunk);
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.term.fullscreen(true);
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
    this.repaint();
  }

  stop(): void {
    if (!this.started) {
      return;
    }
    this.started = false;
    this.uninstallBracketedPaste();
    this.term.off("key", this.keyHandler);
    if (this.mouseEnabled) {
      this.term.off("mouse", this.mouseHandler);
    }
    this.term.off("resize", this.resizeHandler);
    this.term.grabInput(false);
    this.term.hideCursor(false);
    // Restore auto-wrap so the host shell behaves normally after exit.
    process.stdout.write("\x1b[?7h");
    this.term.fullscreen(false);
    this.term("\n");
  }

  // Enables bracketed paste mode on the terminal and rewires stdin so we
  // see the \x1b[200~/\x1b[201~ markers BEFORE terminal-kit's key
  // parser. Non-paste data is forwarded to terminal-kit unchanged; paste
  // content is buffered and dispatched as a single "paste" KeyEvent.
  private installBracketedPaste(): void {
    // Enable bracketed paste — terminals that don't support it ignore
    // the sequence harmlessly.
    process.stdout.write("\x1b[?2004h");
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

  private handleRawStdin(chunk: Buffer): void {
    // Use 'binary' encoding so each byte maps to a single code unit —
    // important because the paste markers are byte-precise and we need
    // to slice them out cleanly. UTF-8 multibyte chars within paste
    // content are reassembled by insertText when we hand off the
    // string. (binary preserves the byte sequence; node's binary↔Buffer
    // round-trip is lossless.)
    let text = chunk.toString("binary");
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
        this.onKey([{ type: "paste", text: pasted }]);
        continue;
      }
      const startIdx = text.indexOf(startMarker);
      if (startIdx === -1) {
        // No paste markers in this chunk — forward to terminal-kit as-is.
        if (this.terminalKitStdinHandler) {
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

  appendLines(lines: FormattedLine[]): void {
    if (lines.length === 0) {
      return;
    }
    this.streamingActive = false;
    this.lines.push(...lines);
    this.trackLines(lines);
    this.adjustScrollForLineChange(lines.length);
    this.trimScrollback();
    this.scheduleRepaint();
  }

  appendLine(line: FormattedLine): void {
    this.streamingActive = false;
    this.lines.push(line);
    this.trackLine(line);
    this.adjustScrollForLineChange(1);
    this.trimScrollback();
    this.scheduleRepaint();
  }

  // When scrolled away from the bottom, shift scrollOffset to keep the
  // user's visible window anchored on the same content as the lines
  // array grows. Without this, every new line silently scrolls the view
  // up by one row — the original bug the user reported.
  private adjustScrollForLineChange(delta: number): void {
    if (this.scrollOffset > 0 && delta !== 0) {
      this.scrollOffset = Math.max(0, this.scrollOffset + delta);
    }
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
    const existing = this.keyedBlocks.get(key);
    // Only reset the streaming flag when this op actually disturbs the
    // last line of scrollback. Mid-array splices (e.g. the 5-second
    // tools-block elapsed tick happening while agent text streams
    // below) must NOT mark streaming as stopped, or the next chunk
    // would be treated as a fresh utterance and get a blank-line
    // separator inserted mid-message.
    let touchesEnd = false;
    let scrollDelta = 0;
    if (existing) {
      const oldEnd = existing.start + existing.count;
      touchesEnd = oldEnd >= this.lines.length;
      const delta = newLines.length - existing.count;
      scrollDelta = delta;
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
    } else {
      // Appending a new block at the bottom always displaces whatever
      // was the last line.
      touchesEnd = true;
      scrollDelta = newLines.length;
      this.keyedBlocks.set(key, {
        start: this.lines.length,
        count: newLines.length,
      });
      this.lines.push(...newLines);
      this.trackLines(newLines);
    }
    if (touchesEnd) {
      this.streamingActive = false;
    }
    this.adjustScrollForLineChange(scrollDelta);
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
    let added = 0;
    if (this.streamingActive && this.lines.length > 0) {
      const last = this.lines[this.lines.length - 1];
      if (last) {
        this.forgetLine(last);
        last.body += first ?? "";
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
          added += 1;
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
      added += 1;
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
      added += 1;
    }
    this.streamingActive = true;
    this.adjustScrollForLineChange(added);
    this.trimScrollback();
    this.scheduleRepaint();
  }

  setHeader(header: Partial<HeaderState>): void {
    this.header = { ...this.header, ...header };
    this.syncWindowTitle();
    this.repaint();
  }

  // Push the current session title (or short session id, as fallback) to
  // the host terminal via OSC 2. Supported by xterm/foot/iTerm2/Alacritty/
  // most modern emulators; ignored harmlessly elsewhere.
  private syncWindowTitle(): void {
    const title = this.header.title?.trim();
    const fallback = shortId(this.header.sessionId) || "hydra";
    const raw = title && title.length > 0 ? title : fallback;
    // Strip control chars (including ESC) so a hostile title can't
    // close the escape sequence early and inject further sequences.
    const clean = raw.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 200);
    if (clean === this.lastWindowTitle) {
      return;
    }
    this.lastWindowTitle = clean;
    process.stdout.write(`\x1b]2;${clean}\x1b\\`);
  }

  clearWindowTitle(): void {
    this.lastWindowTitle = null;
    process.stdout.write("\x1b]2;\x1b\\");
  }

  setBanner(banner: Partial<BannerState>): void {
    this.banner = { ...this.banner, ...banner };
    this.drawBanner();
    this.placeCursor();
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

  // Forget an upsert key without touching scrollback. The next upsertLines
  // for this key will append at the bottom instead of splicing in place —
  // used to scope a logical block (e.g. an agent's plan) to one turn so
  // the next turn starts a fresh block below.
  clearKey(key: string): void {
    this.keyedBlocks.delete(key);
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
    this.adjustScrollForLineChange(-existing.count);
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

  // While a permission prompt is active, the prompt area is replaced with
  // an interactive options list. Pass null to dismiss.
  setPermissionPrompt(spec: PermissionPromptSpec | null): void {
    this.permissionPrompt = spec ? { ...spec } : null;
    this.repaint();
  }

  // Two-line confirmation modal that takes over the prompt area. Used to
  // ask "interrupt before exit?" when the user quits during an in-flight
  // turn that no one else is watching. Pass null to dismiss.
  setConfirmPrompt(spec: ConfirmPromptSpec | null): void {
    this.confirmPrompt = spec ? { ...spec } : null;
    this.repaint();
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
  // non-empty and the last line isn't already a spacer. Idempotent so callers
  // can request it freely at turn boundaries.
  ensureSeparator(): void {
    if (this.lines.length === 0) {
      return;
    }
    const last = this.lines[this.lines.length - 1];
    if (last && last.body === "" && (last.prefix === undefined || last.prefix === "")) {
      return;
    }
    const sep: FormattedLine = { body: "" };
    this.lines.push(sep);
    this.trackLine(sep);
    this.streamingActive = false;
    this.adjustScrollForLineChange(1);
    this.trimScrollback();
    this.scheduleRepaint();
  }

  // The dispatcher is the source of truth for prompt state. If the prompt
  // row count changed (alt+enter added a line, backspace joined two), the
  // separator and scrollback bottom shift, so we need a full repaint;
  // otherwise an in-place prompt redraw is enough. (Queued-zone changes
  // already trigger a full repaint via setQueuedPrompts.) Queue-edit
  // navigation may also change which queued row is marked, so check
  // for that and redraw just that zone in-place.
  refreshPrompt(): void {
    if (this.promptRows() !== this.lastPromptRows) {
      this.repaint();
      return;
    }
    const editingIndex = this.dispatcher.state().queueIndex;
    if (editingIndex !== this.lastQueueEditingIndex) {
      this.lastQueueEditingIndex = editingIndex;
      this.drawQueuedZone();
    }
    this.drawPrompt();
    this.placeCursor();
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

  private handleMouse(name: string): void {
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
  }

  scrollBy(delta: number): void {
    if (delta === 0) {
      return;
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
    if (this.scrollOffset === 0) {
      return;
    }
    this.scrollOffset = 0;
    this.repaint();
  }

  scrollToTop(): void {
    const max = this.maxScrollOffset();
    if (this.scrollOffset === max) {
      return;
    }
    this.scrollOffset = max;
    this.repaint();
  }

  private scrollPageSize(): number {
    return Math.max(1, this.scrollbackVisibleRows() - 2);
  }

  private scrollbackVisibleRows(): number {
    const top = HEADER_ROWS + SEPARATOR_ROWS;
    const bottom =
      this.term.height -
      this.promptRows() -
      BANNER_ROWS -
      SEPARATOR_ROWS -
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
  // moveTo+eraseLineAfter+paint when the row's signature matches the
  // previous frame's. The signature must capture everything that affects
  // visible output for that row (width, FormattedLine fields, banner
  // state, etc.) so identical sigs guarantee identical bytes.
  private paintRow(row: number, signature: string, paint: () => void): void {
    if (row < 1 || row > this.term.height) {
      return;
    }
    if (this.lastFrameRows.get(row) === signature) {
      return;
    }
    this.lastFrameRows.set(row, signature);
    this.term.moveTo(1, row).eraseLineAfter();
    paint();
  }

  private repaint(): void {
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
    // Don't call term.clear() here. Each draw* method moves to its row
    // and emits eraseLineAfter before writing, so every row is overwritten
    // anyway. The full-screen clear caused a visible black-flash flicker
    // on each repaint because there's a non-trivial gap between clearing
    // and the first row write. (Fullscreen alternate-screen mode means
    // the buffer starts clean; resize triggers a repaint that covers all
    // rows in the new size.)
    this.drawHeader();
    this.drawSeparator(HEADER_ROWS);
    this.drawScrollback();
    this.drawCompletionZone();
    this.drawQueuedZone();
    const promptRows = this.promptRows();
    // Separator goes on the row directly above the first prompt row.
    // drawPrompt computes its top as (h - promptRows - BANNER_ROWS + 1), so
    // the separator belongs at (h - promptRows - BANNER_ROWS).
    const separatorRow = h - promptRows - BANNER_ROWS;
    this.drawSeparator(separatorRow);
    this.drawPrompt();
    this.drawBanner();
    this.placeCursor();
    this.lastPromptRows = promptRows;
  }

  private drawHeader(): void {
    const w = this.term.width;
    const usage = formatUsage(this.header.usage);
    const sid = shortId(this.header.sessionId);
    const title = this.header.title?.trim();
    const agentCell = formatAgentWithModel(this.header.agent, this.header.model);
    const cwdDisplay = shortenHomePath(this.header.cwd);
    const sig = `hdr|${w}|${agentCell}|${cwdDisplay}|${sid}|${title ?? ""}|${usage ?? ""}`;
    this.paintRow(1, sig, () => {
      // Fixed pieces: "hydra · " + agent[(model)] + " · " + cwd + " · " +
      // sessionId [+ " · " + title] and the right-aligned usage block.
      const fixed =
        "hydra · ".length +
        agentCell.length +
        " · ".length +
        " · ".length +
        sid.length +
        (title ? " · ".length : 0) +
        (usage ? usage.length + 3 : 0);
      const variableRoom = Math.max(8, w - fixed);
      let cwdRoom: number;
      let titleRoom: number;
      if (title) {
        // cwd gets its natural width first (a small footprint that holds
        // the path), and title takes whatever's left. When cwd is so long
        // it would crowd out title, cap it so title still keeps a sliver.
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
        .bold("hydra")(" · ")
        .cyan.noFormat(agentCell)(" · ")
        .dim.noFormat(truncate(cwdDisplay, cwdRoom))(" · ")
        .yellow(sid);
      if (title) {
        this.term(" · ").bold.noFormat(truncate(title, titleRoom));
      }
      if (usage) {
        const col = Math.max(1, w - usage.length + 1);
        // paintRow already cleared row 1 before this callback ran, so
        // the gap between the left-side writes and the right-aligned
        // usage block is guaranteed blank. The extra eraseLineAfter
        // here is belt-and-suspenders: it bounds any future regression
        // in paintRow's signature cache (or a code path that draws to
        // row 1 outside paintRow) to "usage block redraws cleanly"
        // instead of "stale right-side bytes survive forever".
        this.term.moveTo(col, 1).eraseLineAfter();
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
    const top = HEADER_ROWS + SEPARATOR_ROWS;
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
    for (let i = 0; i < visibleRows; i++) {
      const row = top + i;
      const sliceIdx = i - padTop;
      const line = sliceIdx >= 0 ? slice[sliceIdx] : undefined;
      const sig = formattedLineSig("sb", w, line);
      this.paintRow(row, sig, () => {
        if (line) {
          this.writeFormattedLine(line, w);
        }
      });
    }
  }

  private queuedRows(): number {
    return Math.min(MAX_QUEUED_ROWS, this.queuedTexts.length);
  }

  private completionRows(): number {
    if (this.permissionPrompt) {
      // Completions are pointless when the prompt area is taken over by
      // the permission modal — the user can't be typing into it.
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
    const separatorRow = this.term.height - promptRows - BANNER_ROWS;
    const queuedRows = this.queuedRows();
    // Completion sits above queued (queued is closer to the separator).
    const completionBottom = separatorRow - 1 - queuedRows;
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

  private drawQueuedZone(): void {
    const rows = this.queuedRows();
    if (rows === 0) {
      return;
    }
    const w = this.term.width;
    const promptRows = this.promptRows();
    // Queued zone sits directly above the separator, which is directly
    // above the prompt. So queued bottom = separator - 1.
    const separatorRow = this.term.height - promptRows - BANNER_ROWS;
    const queuedBottom = separatorRow - 1;
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
    if (this.confirmPrompt) {
      this.drawConfirmPrompt();
      return;
    }
    const w = this.term.width;
    const room = Math.max(1, w - 2);
    const state = this.dispatcher.state();
    const visualRows = computePromptVisualRows(state.buffer, room);
    const layout = computePromptLayout(visualRows, state, MAX_PROMPT_ROWS);
    const top = this.term.height - layout.rendered - BANNER_ROWS + 1;
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
    const top = this.term.height - CONFIRM_PROMPT_ROWS - BANNER_ROWS + 1;
    this.paintRow(top, `confirm|q|${w}|${spec.question}`, () => {
      this.term.brightYellow(` ? ${truncate(spec.question, w - 4)}`);
    });
    this.paintRow(top + 1, `confirm|h|${w}|${spec.hint}`, () => {
      this.term.dim(` ${truncate(spec.hint, w - 2)}`);
    });
  }

  private drawPermissionPrompt(): void {
    const spec = this.permissionPrompt;
    if (!spec) {
      return;
    }
    const w = this.term.width;
    const rows = this.permissionRows();
    const top = this.term.height - rows - BANNER_ROWS + 1;
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
    writeRow(`perm|sub|${w}`, () => {
      this.term.dim(" This action requires approval");
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
          this.term.brightCyan(body);
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
    const row = this.term.height;
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
    const sig =
      `bnr|${w}|${this.banner.status}|${elapsedStr}|` +
      `${this.banner.queued}|${this.scrollOffset}|` +
      `${this.banner.planMode ? "1" : "0"}|${this.banner.hint}`;
    this.paintRow(row, sig, () => {
      const dot = this.banner.status === "busy" ? "●" : "○";
      const planLabel = this.banner.planMode ? "plan: ON " : "plan: off";
      if (this.banner.status === "busy") {
        this.term.brightYellow(`${dot} ${this.banner.status}`);
        if (elapsedStr) {
          this.term(" ").dim(elapsedStr);
        }
      } else if (this.banner.status === "disconnected") {
        this.term.brightRed(`${dot} ${this.banner.status}`);
      } else {
        this.term.brightGreen(`${dot} ${this.banner.status}`);
      }
      if (this.banner.queued > 0) {
        this.term(" · ").brightYellow(`${this.banner.queued} queued`);
      }
      if (this.scrollOffset > 0) {
        this.term(" · ").brightCyan(`↑ ${this.scrollOffset}`);
      }
      this.term(" · ");
      if (this.banner.planMode) {
        this.term.brightYellow(planLabel);
      } else {
        this.term.dim(planLabel);
      }
      this.term(" · ").dim(this.banner.hint);
    });
  }

  private placeCursor(): void {
    if (this.permissionPrompt) {
      // Park cursor on the selected option line — visual feedback while the
      // user navigates with arrows.
      const rows = this.permissionRows();
      const top = this.term.height - rows - BANNER_ROWS + 1;
      const optionRow = top + 3 + this.permissionPrompt.selectedIndex;
      this.term.moveTo(2, Math.min(optionRow, this.term.height - BANNER_ROWS));
      return;
    }
    if (this.confirmPrompt) {
      // Park cursor at the end of the question — there's no field to type
      // into, but a visible cursor reads as "waiting for your keypress".
      const top = this.term.height - CONFIRM_PROMPT_ROWS - BANNER_ROWS + 1;
      this.term.moveTo(2, top);
      return;
    }
    const w = this.term.width;
    const room = Math.max(1, w - 2);
    const state = this.dispatcher.state();
    const visualRows = computePromptVisualRows(state.buffer, room);
    const layout = computePromptLayout(visualRows, state, MAX_PROMPT_ROWS);
    const top = this.term.height - layout.rendered - BANNER_ROWS + 1;
    const row = top + Math.max(0, layout.cursorVisualRow - layout.windowStart);
    const col = layout.cursorVisualCol + 3; // gutter (2) + 1-based column
    this.term.moveTo(
      Math.min(col, this.term.width),
      Math.min(row, this.term.height - BANNER_ROWS),
    );
  }

  private promptRows(): number {
    if (this.permissionPrompt) {
      return this.permissionRows();
    }
    if (this.confirmPrompt) {
      return CONFIRM_PROMPT_ROWS;
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
    if (width <= 4) {
      const take = Math.min(needed, this.lines.length);
      return {
        rows: this.lines.slice(this.lines.length - take),
        exhausted: needed >= this.lines.length,
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
    for (let i = this.lines.length - 1; i >= 0; i--) {
      const wrapped = this.wrapOne(this.lines[i]!, width);
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
    return { rows, exhausted: stoppedAt === 0 };
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
    const room = Math.max(1, width - prefix.length);
    // Only the "agent" bodyStyle is routed through term-kit's markup-
    // interpreting writer (see writeStyled); every other style emits
    // text via .noFormat, so caret sequences are literal there and the
    // wrap budget must include them. Keeping stripMarkup off by default
    // preserves existing cwd/title/spec behavior.
    const stripMarkup = line.bodyStyle === "agent";
    const chunks = line.ansi
      ? wrapAnsiBody(line.body, room)
      : wrap(line.body, room, { stripMarkup });
    const wrapped: FormattedLine[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i] ?? "";
      const wrappedLine: FormattedLine = {
        prefix: i === 0 ? line.prefix : " ".repeat(prefix.length),
        body: chunk,
      };
      if (line.prefixStyle !== undefined) {
        wrappedLine.prefixStyle = line.prefixStyle;
      }
      if (line.bodyStyle !== undefined) {
        wrappedLine.bodyStyle = line.bodyStyle;
      }
      if (line.fillRow) {
        wrappedLine.fillRow = true;
      }
      if (line.ansi) {
        wrappedLine.ansi = true;
      }
      wrapped.push(wrappedLine);
    }
    if (id !== undefined) {
      this.wrapCache.set(id, wrapped);
    }
    return wrapped;
  }

  private writeFormattedLine(line: FormattedLine, width: number): void {
    if (line.prefix) {
      writeStyled(this.term, line.prefix, line.prefixStyle ?? line.bodyStyle);
    }
    const remaining = Math.max(0, width - (line.prefix?.length ?? 0));
    // ANSI lines are already wrapped to the visible-width budget by
    // wrap-ansi, so we don't truncate further — that would re-introduce
    // the char-counting bug the ansi path exists to avoid. Width for
    // fillRow padding is measured with string-width so escape bytes
    // don't shrink the apparent line. For "agent" bodyStyle, opt into
    // markup-aware truncate so a `^Cfoo^:` span isn't counted as 5 cols
    // and isn't cut between '^' and the style char.
    const stripMarkup = line.bodyStyle === "agent";
    const bodyText = line.ansi
      ? line.body
      : truncate(line.body, remaining, { stripMarkup });
    writeStyled(this.term, bodyText, line.bodyStyle);
    if (line.fillRow) {
      const visible = line.ansi ? stringWidth(bodyText) : bodyText.length;
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
): string {
  if (!line) {
    return `${zone}|${width}|empty`;
  }
  return (
    `${zone}|${width}|` +
    `${line.prefix ?? ""}|${line.prefixStyle ?? ""}|` +
    `${line.body}|${line.bodyStyle ?? ""}|` +
    `${line.ansi ? "1" : "0"}|${line.fillRow ? "1" : "0"}`
  );
}

interface PromptVisualRow {
  bufferIdx: number;
  startCol: number;
  endCol: number;
}

// Split each logical buffer line into visual rows of at most `room` chars
// each, so very long pasted/typed input soft-wraps in the prompt area
// instead of running off-screen. An empty buffer line still yields one
// visual row so the cursor has somewhere to land.
function computePromptVisualRows(buffer: string[], room: number): PromptVisualRow[] {
  const rows: PromptVisualRow[] = [];
  for (let i = 0; i < buffer.length; i++) {
    const line = buffer[i] ?? "";
    if (line.length === 0) {
      rows.push({ bufferIdx: i, startCol: 0, endCol: 0 });
      continue;
    }
    let pos = 0;
    while (pos < line.length) {
      const end = Math.min(line.length, pos + room);
      rows.push({ bufferIdx: i, startCol: pos, endCol: end });
      pos = end;
    }
  }
  if (rows.length === 0) {
    rows.push({ bufferIdx: 0, startCol: 0, endCol: 0 });
  }
  return rows;
}

interface PromptLayout {
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

function computePromptLayout(
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

function writeStyled(term: Terminal, text: string, style: Style | undefined): void {
  if (text.length === 0) {
    return;
  }
  // The "agent" style is the only one that opts INTO terminal-kit's
  // format processing — parseAgentMarkdown deliberately produces
  // `^+bold^:` / `^Cinline^:` markup that should be interpreted. Every
  // other style renders literal text (user input, code blocks, headings,
  // tool labels, etc.), so we route through `.noFormat` to keep stray
  // carets typed/emitted by the user from being eaten as markup
  // commands.
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
      term.dim.italic.noFormat(text);
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
      // Tinted dark-blue band for fenced code blocks. Different hue from
      // the user-text band so the two never get confused at a glance.
      (term as unknown as {
        bgColorGrayscale: {
          brightCyan: { noFormat: (g: number, t: string) => void };
        };
      }).bgColorGrayscale.brightCyan.noFormat(28, text);
      return;
    case "heading-1":
      term.bold.brightYellow.noFormat(text);
      return;
    case "heading-2":
      term.bold.brightCyan.noFormat(text);
      return;
    case "heading-3":
      term.bold.noFormat(text);
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
      yield { text: segment, width: stringWidth(segment) };
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
    out.push({ text: segment, width: stringWidth(segment) });
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
    const visible = stringWidth(text);
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
    const w = stringWidth(segment);
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

export function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) {
    return `${totalSec}s`;
  }
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) {
    return sec === 0 ? `${min}m` : `${min}m ${sec}s`;
  }
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin === 0 ? `${hr}h` : `${hr}h ${remMin}m`;
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

function mapKeyName(name: string): KeyName | null {
  switch (name) {
    case "ENTER":
    case "KP_ENTER":
      return "enter";
    case "ALT_ENTER":
    case "META_ENTER":
      return "alt-enter";
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
    case "CTRL_U":
      return "ctrl-u";
    case "CTRL_W":
      return "ctrl-w";
    case "CTRL_Y":
      return "ctrl-y";
    case "ESCAPE":
      return "escape";
    default:
      return null;
  }
}
