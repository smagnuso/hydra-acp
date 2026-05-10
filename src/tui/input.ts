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
  | "ctrl-c"
  | "ctrl-d"
  | "ctrl-l"
  | "ctrl-u"
  | "ctrl-w";

export type KeyEvent =
  | { type: "char"; ch: string }
  | { type: "key"; name: KeyName }
  | { type: "paste"; text: string };

export type InputEffect =
  | { type: "send"; text: string; planMode: boolean }
  | { type: "cancel" }
  | { type: "exit" }
  | { type: "plan-toggle"; on: boolean }
  | { type: "redraw-banner" }
  | { type: "redraw" };

export interface InputState {
  buffer: string[];
  row: number;
  col: number;
  planMode: boolean;
  historyIndex: number;
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
  private savedDraft: { buffer: string[]; row: number; col: number } | null =
    null;
  private history: string[] = [];
  private turnRunning = false;

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
      case "home":
        this.col = 0;
        return [];
      case "end":
        this.col = this.currentLine().length;
        return [];
      case "backspace":
        this.backspace();
        return [];
      case "delete":
        this.deleteForward();
        return [];
      case "ctrl-c":
        return this.handleCtrlC();
      case "ctrl-d":
        return this.bufferIsEmpty() ? [{ type: "exit" }] : [];
      case "ctrl-l":
        return [{ type: "redraw" }];
      case "ctrl-u":
        this.killLine();
        return [];
      case "ctrl-w":
        this.killWord();
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
    this.setCurrentLine(line.slice(this.col));
    this.col = 0;
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
    this.setCurrentLine(line.slice(0, i) + line.slice(this.col));
    this.col = i;
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

  // Up scrolls back through history when the cursor is on the first line of
  // the buffer; otherwise it just moves the cursor up one line.
  private handleUp(): InputEffect[] {
    if (this.row > 0) {
      this.row -= 1;
      this.col = Math.min(this.col, this.currentLine().length);
      return [];
    }
    if (this.history.length === 0) {
      return [];
    }
    if (this.historyIndex === -1) {
      this.savedDraft = {
        buffer: [...this.buffer],
        row: this.row,
        col: this.col,
      };
      this.historyIndex = this.history.length - 1;
    } else if (this.historyIndex > 0) {
      this.historyIndex -= 1;
    } else {
      return [];
    }
    this.loadHistoryEntry(this.historyIndex);
    return [];
  }

  // Down advances within history; when we walk off the end, restore the
  // saved draft. When already on a multi-line buffer's middle row, just
  // moves the cursor down.
  private handleDown(): InputEffect[] {
    if (this.row < this.buffer.length - 1 && this.historyIndex === -1) {
      this.row += 1;
      this.col = Math.min(this.col, this.currentLine().length);
      return [];
    }
    if (this.historyIndex === -1) {
      return [];
    }
    if (this.historyIndex < this.history.length - 1) {
      this.historyIndex += 1;
      this.loadHistoryEntry(this.historyIndex);
      return [];
    }
    this.historyIndex = -1;
    if (this.savedDraft) {
      this.buffer = [...this.savedDraft.buffer];
      this.row = this.savedDraft.row;
      this.col = this.savedDraft.col;
      this.savedDraft = null;
    } else {
      this.clearBuffer();
    }
    return [];
  }

  private loadHistoryEntry(index: number): void {
    const entry = this.history[index] ?? "";
    this.buffer = entry.split("\n");
    if (this.buffer.length === 0) {
      this.buffer = [""];
    }
    this.row = this.buffer.length - 1;
    this.col = (this.buffer[this.row] ?? "").length;
  }

  private send(): InputEffect[] {
    const text = this.bufferText();
    if (text.trim().length === 0) {
      return [];
    }
    const planMode = this.planMode;
    this.clearBuffer();
    return [{ type: "send", text, planMode }];
  }

  private handleCtrlC(): InputEffect[] {
    if (this.turnRunning) {
      return [{ type: "cancel" }];
    }
    if (!this.bufferIsEmpty()) {
      this.clearBuffer();
      return [];
    }
    return [{ type: "exit" }];
  }
}
