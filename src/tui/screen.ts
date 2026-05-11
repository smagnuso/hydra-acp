// Screen layer: owns terminal-kit setup, layout, and the live render of
// header + scrollback + prompt + banner. Receives `KeyEvent`s from the user
// and delegates them to an `InputDispatcher` (held by the app), then
// redraws.

import type { Terminal } from "terminal-kit";
import { stripHydraSessionPrefix } from "../core/session.js";
import type { FormattedLine, Style } from "./format.js";
import type { InputDispatcher, KeyEvent, KeyName } from "./input.js";

export interface ScreenOptions {
  term: Terminal;
  dispatcher: InputDispatcher;
  onKey: (events: KeyEvent[]) => void;
}

interface BannerState {
  status: string;
  planMode: boolean;
  hint: string;
  queued: number;
}

interface HeaderState {
  agent: string;
  cwd: string;
  sessionId: string;
  usage?: UsageState;
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
  private repaintPaused = 0;
  private repaintPending = false;
  private permissionPrompt: PermissionPromptSpec | null = null;
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
  private resizeHandler: () => void;
  private keyHandler: (name: string, _matches: string[], data: { isCharacter?: boolean }) => void;
  private mouseHandler: (name: string, data: unknown) => void;
  private started = false;

  constructor(opts: ScreenOptions) {
    this.term = opts.term;
    this.dispatcher = opts.dispatcher;
    this.onKey = opts.onKey;
    this.resizeHandler = () => this.repaint();
    this.keyHandler = (name, _matches, data) => this.handleKey(name, data);
    this.mouseHandler = (name) => this.handleMouse(name);
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.term.fullscreen(true);
    // mouse: "button" enables wheel + click reporting so we can intercept
    // mouse-wheel events for scrollback. terminal-kit emits these through
    // the same "key" channel as MOUSE_WHEEL_UP / MOUSE_WHEEL_DOWN names.
    this.term.grabInput({ mouse: "button" });
    this.term.hideCursor(false);
    this.term.on("key", this.keyHandler);
    this.term.on("mouse", this.mouseHandler);
    this.term.on("resize", this.resizeHandler);
    this.repaint();
  }

  stop(): void {
    if (!this.started) {
      return;
    }
    this.started = false;
    this.term.off("key", this.keyHandler);
    this.term.off("mouse", this.mouseHandler);
    this.term.off("resize", this.resizeHandler);
    this.term.grabInput(false);
    this.term.hideCursor(false);
    this.term.fullscreen(false);
    this.term("\n");
  }

  appendLines(lines: FormattedLine[]): void {
    if (lines.length === 0) {
      return;
    }
    this.streamingActive = false;
    this.lines.push(...lines);
    this.repaint();
  }

  appendLine(line: FormattedLine): void {
    this.streamingActive = false;
    this.lines.push(line);
    this.repaint();
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
    if (existing) {
      const delta = newLines.length - existing.count;
      this.lines.splice(existing.start, existing.count, ...newLines);
      existing.count = newLines.length;
      if (delta !== 0) {
        for (const [k, range] of this.keyedBlocks) {
          if (k !== key && range.start > existing.start) {
            range.start += delta;
          }
        }
      }
    } else {
      this.keyedBlocks.set(key, {
        start: this.lines.length,
        count: newLines.length,
      });
      this.lines.push(...newLines);
    }
    this.streamingActive = false;
    this.repaint();
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
    if (this.streamingActive && this.lines.length > 0) {
      const last = this.lines[this.lines.length - 1];
      if (last) {
        last.body += first ?? "";
      }
    } else {
      const initial: FormattedLine = {
        prefix,
        body: first ?? "",
        bodyStyle,
      };
      if (prefixStyle !== undefined) {
        initial.prefixStyle = prefixStyle;
      }
      this.lines.push(initial);
    }
    const continuationPrefix = " ".repeat(prefix.length);
    for (const piece of rest) {
      this.lines.push({
        prefix: continuationPrefix,
        body: piece,
        bodyStyle,
      });
    }
    this.streamingActive = true;
    this.repaint();
  }

  setHeader(header: Partial<HeaderState>): void {
    this.header = { ...this.header, ...header };
    this.repaint();
  }

  setBanner(banner: Partial<BannerState>): void {
    this.banner = { ...this.banner, ...banner };
    this.drawBanner();
    this.placeCursor();
  }

  clearScrollback(): void {
    this.lines = [];
    this.keyedBlocks.clear();
    this.streamingActive = false;
    this.repaint();
  }

  // Forget an upsert key without touching scrollback. The next upsertLines
  // for this key will append at the bottom instead of splicing in place —
  // used to scope a logical block (e.g. an agent's plan) to one turn so
  // the next turn starts a fresh block below.
  clearKey(key: string): void {
    this.keyedBlocks.delete(key);
  }

  redraw(): void {
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
    this.repaint();
  }

  // While a permission prompt is active, the prompt area is replaced with
  // an interactive options list. Pass null to dismiss.
  setPermissionPrompt(spec: PermissionPromptSpec | null): void {
    this.permissionPrompt = spec ? { ...spec } : null;
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
    this.lines.push({ body: "" });
    this.streamingActive = false;
    this.repaint();
  }

  // The dispatcher is the source of truth for prompt state. If the prompt
  // row count changed (alt+enter added a line, backspace joined two), the
  // separator and scrollback bottom shift, so we need a full repaint;
  // otherwise an in-place prompt redraw is enough. (Queued-zone changes
  // already trigger a full repaint via setQueuedPrompts.)
  refreshPrompt(): void {
    if (this.promptRows() !== this.lastPromptRows) {
      this.repaint();
      return;
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
    const wrapped = this.wrapLines(this.lines, this.term.width);
    const visible = this.scrollbackVisibleRows();
    return Math.max(0, wrapped.length - visible);
  }

  private repaint(): void {
    if (this.repaintPaused > 0) {
      this.repaintPending = true;
      return;
    }
    const w = this.term.width;
    const h = this.term.height;
    if (w < 20 || h < 8) {
      return;
    }
    this.term.clear();
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
    this.term.moveTo(1, 1).eraseLineAfter();
    const usage = formatUsage(this.header.usage);
    const cwdRoom = Math.max(8, w - 40 - (usage ? usage.length + 3 : 0));
    this.term
      .bold("hydra")(" · ")
      .cyan(this.header.agent)(" · ")
      .dim(truncate(this.header.cwd, cwdRoom))(" · ")
      .yellow(shortId(this.header.sessionId));
    if (usage) {
      const col = Math.max(1, w - usage.length + 1);
      this.term.moveTo(col, 1);
      this.term.dim(usage);
    }
  }

  private drawSeparator(row: number): void {
    if (row < 1 || row > this.term.height) {
      return;
    }
    this.term.moveTo(1, row).eraseLineAfter();
    this.term.dim("─".repeat(this.term.width));
  }

  private drawScrollback(): void {
    const w = this.term.width;
    const top = HEADER_ROWS + SEPARATOR_ROWS;
    const visibleRows = this.scrollbackVisibleRows();
    if (visibleRows <= 0) {
      return;
    }
    const wrapped = this.wrapLines(this.lines, w);
    // Clamp scrollOffset in case content shrank or window resized.
    const max = Math.max(0, wrapped.length - visibleRows);
    if (this.scrollOffset > max) {
      this.scrollOffset = max;
    }
    const end = wrapped.length - this.scrollOffset;
    const start = Math.max(0, end - visibleRows);
    const slice = wrapped.slice(start, end);
    for (let i = 0; i < visibleRows; i++) {
      const row = top + i;
      this.term.moveTo(1, row).eraseLineAfter();
      const line = slice[i];
      if (line) {
        this.writeFormattedLine(line, w);
      }
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
      this.term.moveTo(1, row).eraseLineAfter();
      const item = this.completions[i];
      if (!item) {
        continue;
      }
      const isLast = i === rows - 1 && this.completions.length > MAX_COMPLETION_ROWS;
      if (isLast) {
        this.term.dim(
          `  + ${this.completions.length - MAX_COMPLETION_ROWS + 1} more match(es)`,
        );
        continue;
      }
      const namePadded = item.name.padEnd(nameWidth);
      const desc = item.description ?? "";
      const remaining = w - namePadded.length - 4;
      const truncated = remaining > 0 ? truncate(desc, remaining) : "";
      this.term("  ").brightCyan(namePadded);
      if (truncated.length > 0) {
        this.term("  ").dim(truncated);
      }
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
    for (let i = 0; i < rows; i++) {
      const row = queuedTop + i;
      this.term.moveTo(1, row).eraseLineAfter();
      const text = this.queuedTexts[i];
      if (text === undefined) {
        continue;
      }
      const isLast =
        i === rows - 1 && this.queuedTexts.length > MAX_QUEUED_ROWS;
      const overflow = this.queuedTexts.length - MAX_QUEUED_ROWS;
      const summary = isLast
        ? `+ ${overflow + 1} more queued`
        : truncate(firstLine(text), w - 4);
      const display = ` ⏳ ${summary}`;
      const padded = display + " ".repeat(Math.max(0, w - display.length));
      this.term.bgBlue.brightWhite(padded);
    }
  }

  private drawPrompt(): void {
    if (this.permissionPrompt) {
      this.drawPermissionPrompt();
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
      this.term.moveTo(1, row).eraseLineAfter();
      if (!vr) {
        continue;
      }
      // Gutter: "> " on the very first visual row, "· " on the start of a
      // logical newline, blank on a soft-wrap continuation.
      if (vr.bufferIdx === 0 && vr.startCol === 0) {
        this.term.brightWhite("> ");
      } else if (vr.startCol === 0) {
        this.term.dim("· ");
      } else {
        this.term("  ");
      }
      const line = state.buffer[vr.bufferIdx] ?? "";
      this.term(line.slice(vr.startCol, vr.endCol));
    }
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
    const writeRow = (paint: () => void): void => {
      if (row >= top + rows) {
        return;
      }
      this.term.moveTo(1, row).eraseLineAfter();
      paint();
      row += 1;
    };
    writeRow(() => {
      this.term.brightYellow(` 🔒 ${truncate(spec.title, w - 5)}`);
    });
    writeRow(() => {
      this.term.dim(" This action requires approval");
    });
    writeRow(() => {
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
      writeRow(() => {
        if (isSel) {
          this.term.brightCyan(body);
        } else {
          this.term.dim(body);
        }
      });
    }
    writeRow(() => {
      this.term.dim(" ↑/↓ choose · Enter submit · Esc cancel · 1–9 quick-pick");
    });
  }

  private drawBanner(): void {
    const row = this.term.height;
    this.term.moveTo(1, row).eraseLineAfter();
    const dot = this.banner.status === "running" ? "●" : "○";
    const planLabel = this.banner.planMode ? "plan: ON " : "plan: off";
    if (this.banner.status === "running") {
      this.term.brightYellow(`${dot} ${this.banner.status}`);
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
      this.term.brightMagenta(planLabel);
    } else {
      this.term.dim(planLabel);
    }
    this.term(" · ").dim(this.banner.hint);
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

  private wrapLines(lines: FormattedLine[], width: number): FormattedLine[] {
    if (width <= 4) {
      return lines;
    }
    const out: FormattedLine[] = [];
    for (const line of lines) {
      const prefix = line.prefix ?? "";
      const room = Math.max(1, width - prefix.length);
      const chunks = wrap(line.body, room);
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
        out.push(wrappedLine);
      }
    }
    return out;
  }

  private writeFormattedLine(line: FormattedLine, width: number): void {
    if (line.prefix) {
      writeStyled(this.term, line.prefix, line.prefixStyle ?? line.bodyStyle);
    }
    const remaining = Math.max(0, width - (line.prefix?.length ?? 0));
    writeStyled(this.term, truncate(line.body, remaining), line.bodyStyle);
  }
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
  switch (style) {
    case "user":
      term.brightCyan(text);
      return;
    case "agent":
      term(text);
      return;
    case "thought":
      term.dim.italic(text);
      return;
    case "tool":
      term.brightBlue(text);
      return;
    case "tool-status-ok":
      term.green(text);
      return;
    case "tool-status-fail":
      term.bold.red(text);
      return;
    case "tool-status-pending":
      // "queued" — work hasn't started yet; subdued so running calls
      // stand out next to it.
      term.dim.yellow(text);
      return;
    case "tool-status-running":
      // Bold so an in-flight tool call jumps out of a column of queued
      // and completed siblings.
      term.bold.yellow(text);
      return;
    case "tool-status-cancelled":
      term.dim(text);
      return;
    case "plan":
      term.magenta(text);
      return;
    case "plan-done":
      term.green(text);
      return;
    case "plan-pending":
      term.dim(text);
      return;
    case "system":
      term.brightYellow(text);
      return;
    case "info":
      term.cyan(text);
      return;
    case "dim":
      term.dim(text);
      return;
    default:
      term(text);
  }
}

function wrap(text: string, width: number): string[] {
  if (width <= 0) {
    return [text];
  }
  if (text.length === 0) {
    return [""];
  }
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

function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  if (max <= 1) {
    return text.slice(0, max);
  }
  return text.slice(0, max - 1) + "…";
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

function formatCost(amount: number, currency: string | undefined): string {
  const sign = currency === "USD" || currency === undefined ? "$" : "";
  const decimals = amount >= 1 ? 2 : 4;
  return `${sign}${amount.toFixed(decimals)}${
    currency && currency !== "USD" ? ` ${currency}` : ""
  }`;
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
    case "CTRL_P":
      return "ctrl-p";
    case "CTRL_U":
      return "ctrl-u";
    case "CTRL_W":
      return "ctrl-w";
    case "ESCAPE":
      return "escape";
    default:
      return null;
  }
}
