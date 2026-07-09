// Single-line text buffer with cursor, kill ring, and undo/redo. The
// shared foundation for one-line prompt inputs (picker rename, cwd
// prompt). Multi-line / composer semantics live in InputDispatcher;
// this primitive deliberately stays small so both call sites get
// identical readline behavior without dragging in prompt-only concerns
// (history, queue, attachments, effects, paste-token atoms).
//
// Callers own their own Enter / Esc / Tab semantics and rendering. The
// handleKey() helper covers the standard readline set so a caller can
// forward every un-handled terminal-kit key to the editor and get
// motion + editing for free.

const UNDO_LIMIT = 500;

interface Snapshot {
  text: string;
  cursor: number;
}

export class LineEditor {
  private buffer: string;
  private cur: number;
  private killBuf = "";
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];

  constructor(initial = "") {
    this.buffer = initial;
    this.cur = initial.length;
  }

  get text(): string {
    return this.buffer;
  }

  get cursor(): number {
    return this.cur;
  }

  // Public setter for cases where the caller replaces the whole buffer
  // (tab-completion, path insertion). Cursor lands at the end. Set
  // recordUndo=true to make the swap undoable.
  setText(text: string, opts: { recordUndo?: boolean } = {}): void {
    if (opts.recordUndo) {
      this.recordEdit();
    }
    this.buffer = text;
    this.cur = text.length;
  }

  clearUndoHistory(): void {
    this.undoStack = [];
    this.redoStack = [];
  }

  private snap(): Snapshot {
    return { text: this.buffer, cursor: this.cur };
  }

  private restore(s: Snapshot): void {
    this.buffer = s.text;
    this.cur = s.cursor;
  }

  private recordEdit(): void {
    this.undoStack.push(this.snap());
    if (this.undoStack.length > UNDO_LIMIT) {
      this.undoStack.shift();
    }
    this.redoStack = [];
  }

  undo(): boolean {
    const prev = this.undoStack.pop();
    if (prev === undefined) {
      return false;
    }
    this.redoStack.push(this.snap());
    this.restore(prev);
    return true;
  }

  redo(): boolean {
    const next = this.redoStack.pop();
    if (next === undefined) {
      return false;
    }
    this.undoStack.push(this.snap());
    this.restore(next);
    return true;
  }

  moveLeft(): void {
    if (this.cur > 0) {
      this.cur -= 1;
    }
  }

  moveRight(): void {
    if (this.cur < this.buffer.length) {
      this.cur += 1;
    }
  }

  moveHome(): void {
    this.cur = 0;
  }

  moveEnd(): void {
    this.cur = this.buffer.length;
  }

  moveWordBackward(): void {
    let i = this.cur;
    while (i > 0 && /\s/.test(this.buffer[i - 1] ?? "")) {
      i -= 1;
    }
    while (i > 0 && !/\s/.test(this.buffer[i - 1] ?? "")) {
      i -= 1;
    }
    this.cur = i;
  }

  moveWordForward(): void {
    const n = this.buffer.length;
    let i = this.cur;
    while (i < n && /\s/.test(this.buffer[i] ?? "")) {
      i += 1;
    }
    while (i < n && !/\s/.test(this.buffer[i] ?? "")) {
      i += 1;
    }
    this.cur = i;
  }

  insertText(text: string): void {
    if (text.length === 0) {
      return;
    }
    this.recordEdit();
    this.buffer =
      this.buffer.slice(0, this.cur) + text + this.buffer.slice(this.cur);
    this.cur += text.length;
  }

  backspace(): void {
    if (this.cur === 0) {
      return;
    }
    this.recordEdit();
    this.buffer =
      this.buffer.slice(0, this.cur - 1) + this.buffer.slice(this.cur);
    this.cur -= 1;
  }

  deleteForward(): void {
    if (this.cur >= this.buffer.length) {
      return;
    }
    this.recordEdit();
    this.buffer =
      this.buffer.slice(0, this.cur) + this.buffer.slice(this.cur + 1);
  }

  // ^U — kill from cursor back to start of line. Standard readline.
  killLine(): void {
    if (this.cur === 0) {
      return;
    }
    this.recordEdit();
    this.killBuf = this.buffer.slice(0, this.cur);
    this.buffer = this.buffer.slice(this.cur);
    this.cur = 0;
  }

  // ^K — kill from cursor to end.
  killToEnd(): void {
    if (this.cur >= this.buffer.length) {
      return;
    }
    this.recordEdit();
    this.killBuf = this.buffer.slice(this.cur);
    this.buffer = this.buffer.slice(0, this.cur);
  }

  // ^W — kill previous word. Skips trailing whitespace, then non-space.
  // No-op at column 0.
  killWord(): void {
    if (this.cur === 0) {
      return;
    }
    let i = this.cur;
    while (i > 0 && /\s/.test(this.buffer[i - 1] ?? "")) {
      i -= 1;
    }
    while (i > 0 && !/\s/.test(this.buffer[i - 1] ?? "")) {
      i -= 1;
    }
    if (i === this.cur) {
      return;
    }
    this.recordEdit();
    this.killBuf = this.buffer.slice(i, this.cur);
    this.buffer = this.buffer.slice(0, i) + this.buffer.slice(this.cur);
    this.cur = i;
  }

  yank(): void {
    if (this.killBuf.length === 0) {
      return;
    }
    this.insertText(this.killBuf);
  }

  // Route a terminal-kit-shaped key event through the editor. Returns
  // true if the key was consumed. Callers handle Enter / Esc / Tab / and
  // any caller-specific keys themselves; anything left over goes here
  // and the caller repaints if the return is true.
  //
  // ^_ (0x1f) undo and Alt-_ (\x1b_ / \x1b\x1f) redo are matched here
  // because terminal-kit doesn't name them.
  handleKey(name: string, isCharacter: boolean): boolean {
    if (isCharacter) {
      this.insertText(name);
      return true;
    }
    switch (name) {
      case "LEFT":
      case "CTRL_B":
        this.moveLeft();
        return true;
      case "RIGHT":
      case "CTRL_F":
        this.moveRight();
        return true;
      case "HOME":
      case "CTRL_A":
        this.moveHome();
        return true;
      case "END":
      case "CTRL_E":
        this.moveEnd();
        return true;
      case "ALT_B":
      case "META_B":
        this.moveWordBackward();
        return true;
      case "ALT_F":
      case "META_F":
        this.moveWordForward();
        return true;
      case "BACKSPACE":
        this.backspace();
        return true;
      case "DELETE":
        this.deleteForward();
        return true;
      case "CTRL_U":
        this.killLine();
        return true;
      case "CTRL_K":
        this.killToEnd();
        return true;
      case "CTRL_W":
        this.killWord();
        return true;
      case "CTRL_Y":
        this.yank();
        return true;
      case "\x1f":
        this.undo();
        return true;
      case "\x1b_":
      case "\x1b\x1f":
        this.redo();
        return true;
    }
    return false;
  }
}
