// Screen layer: owns terminal-kit setup, layout, and the live render of
// header + scrollback + prompt + banner. Receives `KeyEvent`s from the user
// and delegates them to an `InputDispatcher` (held by the app), then
// redraws.

import type { Terminal } from "terminal-kit";
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

const HEADER_ROWS = 2;
const BANNER_ROWS = 1;
const SEPARATOR_ROWS = 1;
const MAX_PROMPT_ROWS = 8;
const MAX_QUEUED_ROWS = 5;

export class Screen {
  private term: Terminal;
  private dispatcher: InputDispatcher;
  private onKey: (events: KeyEvent[]) => void;
  private lines: FormattedLine[] = [];
  private streamingActive = false;
  private lastPromptRows = 0;
  private queuedTexts: string[] = [];
  private banner: BannerState = {
    status: "ready",
    planMode: false,
    hint: "⇧⇥ plan · ⌥⏎ newline · ⌃C cancel · ⌃D quit",
    queued: 0,
  };
  private header: HeaderState = { agent: "?", cwd: "?", sessionId: "?" };
  private resizeHandler: () => void;
  private keyHandler: (name: string, _matches: string[], data: { isCharacter?: boolean }) => void;
  private started = false;

  constructor(opts: ScreenOptions) {
    this.term = opts.term;
    this.dispatcher = opts.dispatcher;
    this.onKey = opts.onKey;
    this.resizeHandler = () => this.repaint();
    this.keyHandler = (name, _matches, data) => this.handleKey(name, data);
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.term.fullscreen(true);
    this.term.grabInput({});
    this.term.hideCursor(false);
    this.term.on("key", this.keyHandler);
    this.term.on("resize", this.resizeHandler);
    this.repaint();
  }

  stop(): void {
    if (!this.started) {
      return;
    }
    this.started = false;
    this.term.off("key", this.keyHandler);
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
    this.streamingActive = false;
    this.repaint();
  }

  redraw(): void {
    this.repaint();
  }

  setQueuedPrompts(texts: string[]): void {
    this.queuedTexts = [...texts];
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
    const mapped = mapKeyName(name);
    if (mapped) {
      this.onKey([{ type: "key", name: mapped }]);
    }
  }

  private repaint(): void {
    const w = this.term.width;
    const h = this.term.height;
    if (w < 20 || h < 8) {
      return;
    }
    this.term.clear();
    this.drawHeader();
    this.drawSeparator(HEADER_ROWS);
    this.drawScrollback();
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
      .bold("acp-hydra")(" · ")
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
    const bottom =
      this.term.height -
      this.promptRows() -
      BANNER_ROWS -
      SEPARATOR_ROWS -
      this.queuedRows();
    const visibleRows = bottom - top + 1;
    if (visibleRows <= 0) {
      return;
    }
    const wrapped = this.wrapLines(this.lines, w);
    const start = Math.max(0, wrapped.length - visibleRows);
    const slice = wrapped.slice(start);
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
    const w = this.term.width;
    const promptRows = this.promptRows();
    const top = this.term.height - promptRows - BANNER_ROWS + 1;
    const state = this.dispatcher.state();
    for (let i = 0; i < promptRows; i++) {
      const row = top + i;
      this.term.moveTo(1, row).eraseLineAfter();
      if (i === 0) {
        this.term.brightWhite("> ");
      } else {
        this.term.dim("· ");
      }
      const lineText = state.buffer[i] ?? "";
      this.term(truncate(lineText, w - 2));
    }
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
    this.term(" · ");
    if (this.banner.planMode) {
      this.term.brightMagenta(planLabel);
    } else {
      this.term.dim(planLabel);
    }
    this.term(" · ").dim(this.banner.hint);
  }

  private placeCursor(): void {
    const promptRows = this.promptRows();
    const top = this.term.height - promptRows - BANNER_ROWS + 1;
    const state = this.dispatcher.state();
    const row = top + Math.min(state.row, promptRows - 1);
    const col = state.col + 3; // "> " or "· " gutter
    this.term.moveTo(Math.min(col, this.term.width), row);
  }

  private promptRows(): number {
    const state = this.dispatcher.state();
    return Math.min(MAX_PROMPT_ROWS, Math.max(1, state.buffer.length));
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
      term.red(text);
      return;
    case "tool-status-pending":
      term.yellow(text);
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
  let i = 0;
  while (i < text.length) {
    out.push(text.slice(i, i + width));
    i += width;
  }
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

function shortId(id: string): string {
  // Keep enough context to be recognizable: full id when short, otherwise
  // first segment + last 8 chars so the prefix (e.g. "hydra_session_") is
  // still visible.
  if (id.length <= 18) {
    return id;
  }
  const tail = id.slice(-8);
  const prefix = id.includes("_") ? id.slice(0, id.indexOf("_") + 1) : id.slice(0, 6);
  return `${prefix}…${tail}`;
}

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
    case "CTRL_C":
      return "ctrl-c";
    case "CTRL_D":
      return "ctrl-d";
    case "CTRL_L":
      return "ctrl-l";
    case "CTRL_U":
      return "ctrl-u";
    case "CTRL_W":
      return "ctrl-w";
    default:
      return null;
  }
}
