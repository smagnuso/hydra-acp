// Input dispatcher: pure state machine for the prompt buffer. Accepts
// abstract `KeyEvent`s, exposes the buffer/cursor/plan-mode state, and emits
// semantic effects (send / cancel / exit / plan-toggle). The screen layer is
// responsible for translating terminal-kit key names into KeyEvents and
// rendering the state.

export type KeyName =
  | "enter"
  | "alt-enter"
  | "shift-tab"
  | "tab"
  | "up"
  | "down"
  | "left"
  | "right"
  | "home"
  | "end"
  | "backspace"
  | "delete"
  | "ctrl-a"
  | "ctrl-b"
  | "ctrl-c"
  | "ctrl-d"
  | "ctrl-e"
  | "ctrl-f"
  | "ctrl-k"
  | "ctrl-l"
  | "ctrl-n"
  | "ctrl-o"
  | "ctrl-p"
  | "ctrl-u"
  | "ctrl-w"
  | "ctrl-y"
  | "escape";

export type KeyEvent =
  | { type: "char"; ch: string }
  | { type: "key"; name: KeyName }
  | { type: "paste"; text: string };

export type InputEffect =
  | { type: "send"; text: string; planMode: boolean }
  | { type: "queue-edit"; index: number; text: string }
  | { type: "queue-remove"; index: number }
  // `prefill: true` (emitted by Escape) asks the app to drop the cancelled
  // turn's text back into the prompt buffer if no queued items will run
  // afterwards. Plain ^C cancel uses prefill=false (default).
  | { type: "cancel"; prefill?: boolean }
  | { type: "exit" }
  | { type: "plan-toggle"; on: boolean }
  | { type: "redraw-banner" }
  | { type: "redraw" }
  | { type: "scroll-to-top" }
  | { type: "scroll-to-bottom" }
  | { type: "switch-session" }
  | { type: "toggle-tools" };

export interface InputState {
  buffer: string[];
  row: number;
  col: number;
  planMode: boolean;
  historyIndex: number;
  queueIndex: number;
}

export interface InputOptions {
  history?: string[];
  planMode?: boolean;
}

export class InputDispatcher {
  private buffer: string[] = [""];
  private row = 0;
  private col = 0;
  private planMode = false;
  private historyIndex = -1;
  // Queue editing: when the user walks Up past row 0 with queued prompts
  // present, the most-recently-queued item lands in the buffer and
  // queueIndex tracks which slot of `queue` is being edited. Enter submits
  // the edit (queue-edit) or, on an empty buffer, drops the slot
  // (queue-remove). -1 means not editing a queue slot.
  private queueIndex = -1;
  private savedDraft: { buffer: string[]; row: number; col: number } | null =
    null;
  private history: string[] = [];
  // Waiting queue snapshot (excludes the in-flight head). Newest item lives
  // at the end so Up walks the array right-to-left.
  private queue: string[] = [];
  private turnRunning = false;
  // Single-slot kill ring. The most recent killed text (^U, ^K, ^W) lands
  // here so ^Y can yank it back. Standard readline keeps a stack; we
  // only keep one slot because that's what 99% of yank uses look like.
  private killBuffer = "";

  constructor(opts: InputOptions = {}) {
    this.history = [...(opts.history ?? [])];
    this.planMode = opts.planMode ?? false;
  }

  state(): InputState {
    return {
      buffer: [...this.buffer],
      row: this.row,
      col: this.col,
      planMode: this.planMode,
      historyIndex: this.historyIndex,
      queueIndex: this.queueIndex,
    };
  }

  setTurnRunning(running: boolean): void {
    this.turnRunning = running;
  }

  setHistory(history: string[]): void {
    this.history = [...history];
    this.historyIndex = -1;
    this.savedDraft = null;
  }

  // Snapshot of the waiting queue (head excluded). Called by the app after
  // every queue mutation so Up/Down can walk a fresh view. queueIndex is
  // only invalidated when it falls outside the new bounds — staying in
  // bounds preserves the user's edit if the queue grew or stayed put.
  setQueue(queue: string[]): void {
    this.queue = [...queue];
    if (this.queueIndex >= this.queue.length) {
      this.queueIndex = -1;
    }
  }

  // Replace the contents of the first row, leaving subsequent rows alone.
  // Used by slash-command completion: the partial /foo gets swapped for the
  // matched command name. Cursor moves to the end of the replacement.
  replaceFirstLine(text: string): void {
    this.buffer[0] = text;
    if (this.row === 0) {
      this.col = text.length;
    }
  }

  // Public seed for the buffer (used for Escape pre-fill). Treated like a
  // fresh draft: nav state and any saved draft are cleared, cursor lands
  // at the end so the user can edit immediately.
  setBuffer(text: string): void {
    this.loadEntry(text);
    this.historyIndex = -1;
    this.queueIndex = -1;
    this.savedDraft = null;
  }

  feed(event: KeyEvent): InputEffect[] {
    if (event.type === "char") {
      this.insertChar(event.ch);
      return [];
    }
    if (event.type === "paste") {
      this.insertText(event.text);
      return [];
    }
    return this.handleKey(event.name);
  }

  private handleKey(name: KeyName): InputEffect[] {
    switch (name) {
      case "enter":
        return this.send();
      case "alt-enter":
        this.insertNewline();
        return [];
      case "shift-tab":
        this.planMode = !this.planMode;
        return [
          { type: "plan-toggle", on: this.planMode },
          { type: "redraw-banner" },
        ];
      case "tab":
        this.insertText("  ");
        return [];
      case "up":
        return this.handleUp();
      case "down":
        return this.handleDown();
      case "left":
        this.moveLeft();
        return [];
      case "right":
        this.moveRight();
        return [];
      case "ctrl-a":
        this.col = 0;
        return [];
      case "ctrl-e":
        this.col = this.currentLine().length;
        return [];
      case "home":
        return this.handleHome();
      case "end":
        return this.handleEnd();
      case "ctrl-b":
        this.moveLeft();
        return [];
      case "ctrl-f":
        this.moveRight();
        return [];
      case "ctrl-k":
        this.killToEnd();
        return [];
      case "ctrl-n":
        return this.handleDown();
      case "ctrl-o":
        return [{ type: "toggle-tools" }];
      case "backspace":
        this.backspace();
        return [];
      case "delete":
        this.deleteForward();
        return [];
      case "ctrl-c":
        return this.handleCtrlC();
      case "ctrl-d":
        // Standard readline: EOF on empty buffer, delete-forward otherwise
        // (no-op at end-of-buffer when there's nothing to delete).
        if (this.bufferIsEmpty()) {
          return [{ type: "exit" }];
        }
        this.deleteForward();
        return [];
      case "ctrl-l":
        return [{ type: "redraw" }];
      case "ctrl-p":
        return [{ type: "switch-session" }];
      case "ctrl-u":
        this.killLine();
        return [];
      case "ctrl-w":
        this.killWord();
        return [];
      case "ctrl-y":
        this.yank();
        return [];
      case "escape":
        // Modal flows (permission prompt, exit confirm) intercept Escape
        // before it reaches here. Outside those, Escape during a turn
        // cancels with prefill — the app drops the cancelled turn's
        // text back into the buffer if nothing else is queued.
        if (this.turnRunning) {
          return [{ type: "cancel", prefill: true }];
        }
        return [];
    }
  }

  private currentLine(): string {
    return this.buffer[this.row] ?? "";
  }

  private setCurrentLine(line: string): void {
    this.buffer[this.row] = line;
  }

  private bufferText(): string {
    return this.buffer.join("\n");
  }

  private bufferIsEmpty(): boolean {
    return this.buffer.length === 1 && this.buffer[0] === "";
  }

  private clearBuffer(): void {
    this.buffer = [""];
    this.row = 0;
    this.col = 0;
    this.historyIndex = -1;
    this.queueIndex = -1;
    this.savedDraft = null;
  }

  private insertChar(ch: string): void {
    if (ch.length === 0) {
      return;
    }
    if (ch.includes("\n")) {
      this.insertText(ch);
      return;
    }
    const line = this.currentLine();
    this.setCurrentLine(line.slice(0, this.col) + ch + line.slice(this.col));
    this.col += ch.length;
  }

  private insertText(text: string): void {
    const lines = text.split("\n");
    if (lines.length === 1) {
      this.insertChar(lines[0] ?? "");
      return;
    }
    const cur = this.currentLine();
    const before = cur.slice(0, this.col);
    const after = cur.slice(this.col);
    const first = lines[0] ?? "";
    const last = lines[lines.length - 1] ?? "";
    const middle = lines.slice(1, -1);
    this.setCurrentLine(before + first);
    const newRows = [...middle, last + after];
    this.buffer.splice(this.row + 1, 0, ...newRows);
    this.row += lines.length - 1;
    this.col = last.length;
  }

  private insertNewline(): void {
    const line = this.currentLine();
    const before = line.slice(0, this.col);
    const after = line.slice(this.col);
    this.setCurrentLine(before);
    this.buffer.splice(this.row + 1, 0, after);
    this.row += 1;
    this.col = 0;
  }

  private backspace(): void {
    if (this.col > 0) {
      const line = this.currentLine();
      this.setCurrentLine(line.slice(0, this.col - 1) + line.slice(this.col));
      this.col -= 1;
      return;
    }
    if (this.row === 0) {
      return;
    }
    const prev = this.buffer[this.row - 1] ?? "";
    const cur = this.currentLine();
    this.buffer.splice(this.row, 1);
    this.row -= 1;
    this.col = prev.length;
    this.buffer[this.row] = prev + cur;
  }

  private deleteForward(): void {
    const line = this.currentLine();
    if (this.col < line.length) {
      this.setCurrentLine(line.slice(0, this.col) + line.slice(this.col + 1));
      return;
    }
    if (this.row < this.buffer.length - 1) {
      const next = this.buffer[this.row + 1] ?? "";
      this.buffer.splice(this.row + 1, 1);
      this.setCurrentLine(line + next);
    }
  }

  private killLine(): void {
    const line = this.currentLine();
    const killed = line.slice(0, this.col);
    if (killed.length > 0) {
      this.killBuffer = killed;
    }
    this.setCurrentLine(line.slice(this.col));
    this.col = 0;
  }

  private killToEnd(): void {
    const line = this.currentLine();
    const killed = line.slice(this.col);
    if (killed.length > 0) {
      this.killBuffer = killed;
    }
    this.setCurrentLine(line.slice(0, this.col));
  }

  private killWord(): void {
    const line = this.currentLine();
    if (this.col === 0) {
      this.backspace();
      return;
    }
    let i = this.col;
    while (i > 0 && /\s/.test(line[i - 1] ?? "")) {
      i -= 1;
    }
    while (i > 0 && !/\s/.test(line[i - 1] ?? "")) {
      i -= 1;
    }
    const killed = line.slice(i, this.col);
    if (killed.length > 0) {
      this.killBuffer = killed;
    }
    this.setCurrentLine(line.slice(0, i) + line.slice(this.col));
    this.col = i;
  }

  private yank(): void {
    if (this.killBuffer.length === 0) {
      return;
    }
    this.insertText(this.killBuffer);
  }

  private moveLeft(): void {
    if (this.col > 0) {
      this.col -= 1;
      return;
    }
    if (this.row > 0) {
      this.row -= 1;
      this.col = this.currentLine().length;
    }
  }

  private moveRight(): void {
    if (this.col < this.currentLine().length) {
      this.col += 1;
      return;
    }
    if (this.row < this.buffer.length - 1) {
      this.row += 1;
      this.col = 0;
    }
  }

  // Up walks the navigation stack from newest to oldest: pending queue
  // items first (so the user can edit something they just enqueued),
  // then prompt history. Cursor movement within a multi-line buffer
  // takes priority when not already navigating.
  private handleUp(): InputEffect[] {
    if (this.row > 0) {
      this.row -= 1;
      this.col = Math.min(this.col, this.currentLine().length);
      return [];
    }
    if (this.queueIndex === -1 && this.historyIndex === -1) {
      if (this.queue.length === 0 && this.history.length === 0) {
        return [];
      }
      this.savedDraft = {
        buffer: [...this.buffer],
        row: this.row,
        col: this.col,
      };
      if (this.queue.length > 0) {
        this.queueIndex = this.queue.length - 1;
        this.loadEntry(this.queue[this.queueIndex] ?? "");
      } else {
        this.historyIndex = this.history.length - 1;
        this.loadEntry(this.history[this.historyIndex] ?? "");
      }
      return [];
    }
    if (this.queueIndex >= 0) {
      if (this.queueIndex > 0) {
        this.queueIndex -= 1;
        this.loadEntry(this.queue[this.queueIndex] ?? "");
        return [];
      }
      // Past the oldest queue slot — cross into history if any.
      if (this.history.length === 0) {
        return [];
      }
      this.queueIndex = -1;
      this.historyIndex = this.history.length - 1;
      this.loadEntry(this.history[this.historyIndex] ?? "");
      return [];
    }
    if (this.historyIndex > 0) {
      this.historyIndex -= 1;
      this.loadEntry(this.history[this.historyIndex] ?? "");
    }
    return [];
  }

  // Down reverses the Up walk: history (older → newer), then queue
  // (oldest → newest), then restore the original draft. Within a
  // multi-line buffer, plain cursor movement still wins when no
  // navigation is in progress.
  private handleDown(): InputEffect[] {
    if (
      this.row < this.buffer.length - 1 &&
      this.historyIndex === -1 &&
      this.queueIndex === -1
    ) {
      this.row += 1;
      this.col = Math.min(this.col, this.currentLine().length);
      return [];
    }
    if (this.historyIndex >= 0) {
      if (this.historyIndex < this.history.length - 1) {
        this.historyIndex += 1;
        this.loadEntry(this.history[this.historyIndex] ?? "");
        return [];
      }
      this.historyIndex = -1;
      if (this.queue.length > 0) {
        this.queueIndex = 0;
        this.loadEntry(this.queue[this.queueIndex] ?? "");
        return [];
      }
      this.restoreDraft();
      return [];
    }
    if (this.queueIndex >= 0) {
      if (this.queueIndex < this.queue.length - 1) {
        this.queueIndex += 1;
        this.loadEntry(this.queue[this.queueIndex] ?? "");
        return [];
      }
      this.queueIndex = -1;
      this.restoreDraft();
      return [];
    }
    return [];
  }

  private restoreDraft(): void {
    if (this.savedDraft) {
      this.buffer = [...this.savedDraft.buffer];
      this.row = this.savedDraft.row;
      this.col = this.savedDraft.col;
      this.savedDraft = null;
    } else {
      this.clearBuffer();
    }
  }

  private loadEntry(text: string): void {
    this.buffer = text.split("\n");
    if (this.buffer.length === 0) {
      this.buffer = [""];
    }
    this.row = this.buffer.length - 1;
    this.col = (this.buffer[this.row] ?? "").length;
  }

  private send(): InputEffect[] {
    const text = this.bufferText();
    // Submitting while editing a queued slot routes the change back into
    // the queue (edit or remove) instead of starting a new turn.
    if (this.queueIndex >= 0 && this.queueIndex < this.queue.length) {
      const index = this.queueIndex;
      this.clearBuffer();
      if (text.trim().length === 0) {
        return [{ type: "queue-remove", index }];
      }
      return [{ type: "queue-edit", index, text }];
    }
    if (text.trim().length === 0) {
      return [];
    }
    const planMode = this.planMode;
    this.clearBuffer();
    return [{ type: "send", text, planMode }];
  }

  // Home: jump to the very start of the prompt buffer. If we're already
  // there, fall through to scrolling the scrollback to its top.
  private handleHome(): InputEffect[] {
    if (this.row !== 0 || this.col !== 0) {
      this.row = 0;
      this.col = 0;
      return [];
    }
    return [{ type: "scroll-to-top" }];
  }

  // End: jump to the end of the last line of the prompt buffer. Already
  // there → scroll the scrollback to the bottom (newest).
  private handleEnd(): InputEffect[] {
    const lastRow = this.buffer.length - 1;
    const lastCol = (this.buffer[lastRow] ?? "").length;
    if (this.row !== lastRow || this.col !== lastCol) {
      this.row = lastRow;
      this.col = lastCol;
      return [];
    }
    return [{ type: "scroll-to-bottom" }];
  }

  private handleCtrlC(): InputEffect[] {
    // ^C peels one layer at a time:
    //   1. Buffer has text → clear it (preserve queueIndex so Enter on
    //      the now-empty buffer can still emit queue-remove).
    //   2. Empty buffer but editing a queue slot → drop the slot
    //      pointer and restore the saved draft.
    //   3. Empty buffer, no slot, turn running → cancel.
    //   4. Empty buffer, no slot, idle → exit.
    if (!this.bufferIsEmpty()) {
      this.buffer = [""];
      this.row = 0;
      this.col = 0;
      if (this.queueIndex === -1) {
        this.historyIndex = -1;
        this.savedDraft = null;
      }
      return [];
    }
    if (this.queueIndex >= 0) {
      this.queueIndex = -1;
      this.restoreDraft();
      return [];
    }
    if (this.turnRunning) {
      return [{ type: "cancel" }];
    }
    return [{ type: "exit" }];
  }
}
