// Input dispatcher: pure state machine for the prompt buffer. Accepts
// abstract `KeyEvent`s, exposes the buffer/cursor/plan-mode state, and emits
// semantic effects (send / cancel / exit / plan-toggle). The screen layer is
// responsible for translating terminal-kit key names into KeyEvents and
// rendering the state.

export type KeyName =
  | "enter"
  | "alt-enter"
  | "shift-enter"
  | "ctrl-enter"
  | "alt-b"
  | "alt-f"
  | "alt-n"
  | "alt-tab"
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
  | "ctrl-g"
  | "ctrl-k"
  | "ctrl-l"
  | "ctrl-n"
  | "ctrl-o"
  | "ctrl-p"
  | "ctrl-r"
  | "ctrl-s"
  | "ctrl-u"
  | "ctrl-v"
  | "ctrl-t"
  | "ctrl-w"
  | "ctrl-x"
  | "ctrl-y"
  | "escape";

// One attached image, ready to be sent as an ACP image content block. data
// is base64-encoded raw bytes (PNG/JPEG/etc.); mimeType matches. name and
// sizeBytes are display-only — chips and banners surface them, but the
// outgoing wire block only carries data + mimeType.
export interface Attachment {
  mimeType: string;
  data: string;
  name?: string;
  sizeBytes: number;
}

export type KeyEvent =
  | { type: "char"; ch: string }
  | { type: "key"; name: KeyName }
  | { type: "paste"; text: string }
  // Emitted by the screen layer when a bracketed-paste payload is
  // recognised as image file path(s) — drag-and-drop from a file
  // manager produces this. The dispatcher ignores it (no text buffer
  // mutation); the app intercepts the event to read the files and
  // call addAttachment.
  | { type: "attachment-paths"; paths: string[] };

export type InputEffect =
  // `text` is the wire form (paste placeholders expanded to their original
  // text); `displayText` is the as-typed form (placeholders intact). Equal
  // when no large pastes are in the buffer. History recording uses
  // displayText so up-arrow recall stays compact; the daemon gets text.
  | {
      type: "send";
      text: string;
      displayText: string;
      planMode: boolean;
      attachments: Attachment[];
    }
  // Amend the in-flight turn — interrupt and replace via
  // hydra-acp/prompt/amend. App falls through to "send" if no turn is
  // running or the daemon doesn't advertise the capability.
  | {
      type: "amend";
      text: string;
      displayText: string;
      planMode: boolean;
      attachments: Attachment[];
    }
  | {
      type: "queue-edit";
      index: number;
      text: string;
      displayText: string;
      attachments: Attachment[];
    }
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
  | { type: "next-live-session" }
  | { type: "toggle-options" }
  | { type: "toggle-thoughts" }
  | { type: "toggle-mouse" }
  | { type: "show-help" }
  // Dispatcher → app: please acquire an image from the named source
  // (currently only the system clipboard) and call addAttachment().
  // Emitted by ctrl-v. The dispatcher stays synchronous; the app owns
  // the shell-out and the file I/O.
  | { type: "attachment-request"; source: "clipboard" }
  // Emitted when prompt-history reverse-search runs out — either no
  // history entry matched the query, or the user advanced ^R past the
  // oldest match. The app hands the query off to the screen's
  // scrollback search so the user keeps walking through scrollback
  // without having to press anything extra.
  | { type: "escalate-search"; query: string };

export interface InputState {
  buffer: string[];
  row: number;
  col: number;
  planMode: boolean;
  historyIndex: number;
  queueIndex: number;
  // Images attached to the current draft. The chip zone renders one
  // chip per entry; send() snapshots and clears.
  attachments: Attachment[];
  // Non-null while reverse-i-search is engaged on prompt history.
  // Exposed so the screen can surface the query in the banner —
  // otherwise the prompt area shows only the matched entry, with no
  // hint of what's being searched for.
  historySearchQuery: string | null;
}

export interface InputOptions {
  history?: string[];
  planMode?: boolean;
  // Defaults to true. Set false in inputs that aren't prompts destined
  // for the agent (e.g. the picker's find/search box) — a placeholder
  // would silently break the search query.
  collapsePastes?: boolean;
}

// Pastes with more than this many lines get collapsed to a placeholder
// in the visible buffer; the original text is stored and expanded back
// on submit.
export const PASTE_LINE_THRESHOLD = 10;

// Matches the placeholder anywhere in a line. The same shape is used
// (anchored) for atomic deletion / cursor jumps over the token.
const PASTE_TOKEN_RE = /\[pasted #(\d+) \+\d+ lines\]/g;
const PASTE_TOKEN_LEFT_RE = /\[pasted #(\d+) \+\d+ lines\]$/;
const PASTE_TOKEN_RIGHT_RE = /^\[pasted #(\d+) \+\d+ lines\]/;

function formatPasteToken(id: number, lineCount: number): string {
  return `[pasted #${id} +${lineCount} lines]`;
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
  // Active reverse-incremental search over `history`. Set when ^r is
  // pressed; cleared when the user accepts (Enter / typing / arrows)
  // or cancels (ESC). `query` is the lowercased substring matched
  // against history entries; `matchIndices` are history indices in
  // newest→oldest order; `cursor` is the current index into that list.
  // `savedDraft` snapshots the buffer/cursor at the moment search
  // began so ESC can restore it.
  private historySearch: {
    query: string;
    matchIndices: number[];
    cursor: number;
    savedDraft: { buffer: string[]; row: number; col: number };
  } | null = null;
  // Waiting queue snapshot (excludes the in-flight head). Newest item lives
  // at the end so Up walks the array right-to-left.
  private queue: string[] = [];
  private turnRunning = false;
  // Single-slot kill ring. The most recent killed text (^U, ^K, ^W) lands
  // here so ^Y can yank it back. Standard readline keeps a stack; we
  // only keep one slot because that's what 99% of yank uses look like.
  private killBuffer = "";
  // Images attached to the current draft. Cleared in the same paths
  // that clear the text buffer (clearBuffer, after send). Queue
  // navigation snapshots/restores them alongside savedDraft so up/down
  // through queued items doesn't drop chips.
  private attachments: Attachment[] = [];
  // Snapshot of `attachments` taken when the user starts walking
  // history/queue with chips already attached. Restored alongside the
  // text draft when the walk ends. Distinct from savedDraft because
  // queue slots (which may carry their own attachments — though we
  // don't surface that yet) shouldn't blend with the current draft's.
  private savedAttachments: Attachment[] | null = null;
  // Map of paste id → original text for placeholder tokens currently in
  // the buffer (or recoverable via history walks within this session).
  // Persists across sends — never cleared by clearBuffer/setBuffer, so
  // up-arrow recall of a placeholder can still reanimate on resubmit.
  private pastes = new Map<number, string>();
  private nextPasteId = 1;
  private collapsePastes: boolean;

  constructor(opts: InputOptions = {}) {
    this.history = [...(opts.history ?? [])];
    this.planMode = opts.planMode ?? false;
    this.collapsePastes = opts.collapsePastes ?? true;
  }

  // Buffer text with paste placeholders expanded back to their original
  // content. Used by callers that bypass the send/amend effects (e.g.
  // picker.ts reads composer text directly).
  expandedText(): string {
    return this.expandPastes(this.bufferText());
  }

  state(): InputState {
    return {
      buffer: [...this.buffer],
      row: this.row,
      col: this.col,
      planMode: this.planMode,
      historyIndex: this.historyIndex,
      queueIndex: this.queueIndex,
      attachments: [...this.attachments],
      historySearchQuery: this.historySearch?.query ?? null,
    };
  }

  // App calls this after asynchronously acquiring an image (drag-drop
  // file read, clipboard shellout). The dispatcher just records it;
  // chip rendering and capability gating live in the app/screen layer.
  addAttachment(attachment: Attachment): void {
    this.attachments.push(attachment);
  }

  removeAttachment(index: number): void {
    if (index < 0 || index >= this.attachments.length) {
      return;
    }
    this.attachments.splice(index, 1);
  }

  setTurnRunning(running: boolean): void {
    this.turnRunning = running;
  }

  setHistory(history: string[]): void {
    this.history = [...history];
    this.historyIndex = -1;
    this.savedDraft = null;
    this.historySearch = null;
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
  // at the end so the user can edit immediately. Attachments restore
  // alongside the text so a cancelled turn's chips land back in the
  // draft together with the typed prompt.
  setBuffer(text: string, attachments: Attachment[] = []): void {
    this.loadEntry(text);
    this.historyIndex = -1;
    this.queueIndex = -1;
    this.savedDraft = null;
    this.savedAttachments = null;
    this.historySearch = null;
    this.attachments = [...attachments];
  }

  feed(event: KeyEvent): InputEffect[] {
    // Reverse-i-search owns ^r (advance), Escape (cancel restoring
    // draft), Backspace (shrink the query), and printable chars / paste
    // (extend the query). Enter exits search keeping the matched entry
    // and submits it; arrows / other keys exit keeping the match and
    // process normally.
    if (this.historySearch !== null) {
      if (event.type === "char") {
        return this.mutateHistorySearchQuery(
          this.historySearch.query + event.ch.toLowerCase(),
        );
      }
      if (event.type === "paste") {
        return this.mutateHistorySearchQuery(
          this.historySearch.query +
            event.text.replace(/\n/g, " ").toLowerCase(),
        );
      }
      if (event.type === "key") {
        if (event.name === "ctrl-r") {
          return this.advanceHistorySearch();
        }
        if (event.name === "ctrl-s") {
          this.retreatHistorySearch();
          return [];
        }
        if (event.name === "escape" || event.name === "ctrl-c") {
          // ^c inside history search peels the search layer first (matching
          // Escape) — restoring the saved draft — instead of falling through
          // to handleCtrlC and exiting. A second ^c with no search active
          // then follows the normal peel-or-exit ladder.
          this.cancelHistorySearch();
          return [];
        }
        if (event.name === "backspace") {
          if (this.historySearch.query.length === 0) {
            // Nothing left to shrink — cancel and restore the draft so
            // backspace at this point reads as "undo my ^r".
            this.cancelHistorySearch();
            return [];
          }
          return this.mutateHistorySearchQuery(
            this.historySearch.query.slice(0, -1),
          );
        }
        // Enter / arrows / other keys: exit search keeping the loaded
        // entry in the buffer, then process the key normally so the
        // user can submit, move the cursor, or invoke another command
        // on the matched text.
        this.historySearch = null;
      }
    }
    if (event.type === "char") {
      this.insertChar(event.ch);
      return [];
    }
    if (event.type === "paste") {
      const lineCount = event.text.split("\n").length;
      if (this.collapsePastes && lineCount > PASTE_LINE_THRESHOLD) {
        const id = this.nextPasteId++;
        this.pastes.set(id, event.text);
        this.insertText(formatPasteToken(id, lineCount));
      } else {
        this.insertText(event.text);
      }
      return [];
    }
    if (event.type === "attachment-paths") {
      // App-handled out-of-band; the dispatcher has no text mutation to
      // do here. Returning [] keeps feed()'s contract tidy if the app
      // ever forwards this event through.
      return [];
    }
    return this.handleKey(event.name);
  }

  private handleKey(name: KeyName): InputEffect[] {
    switch (name) {
      case "enter":
        return this.send();
      case "shift-enter":
      case "ctrl-enter":
        // Ctrl+Enter is the gnome-terminal-friendly fallback for
        // Shift+Enter — gnome's libvte doesn't reliably distinguish
        // Shift+Enter from plain Enter without the kitty keyboard
        // protocol, but Ctrl+Enter has a unique byte (0x0a) that any
        // terminal can send. Both chords map to the same effect.
        return this.amend();
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
      case "ctrl-g":
        return [{ type: "show-help" }];
      case "alt-b":
        this.moveWordBackward();
        return [];
      case "alt-f":
        this.moveWordForward();
        return [];
      case "ctrl-k":
        this.killToEnd();
        return [];
      case "ctrl-n":
        return this.handleDown();
      case "ctrl-o":
        return [{ type: "toggle-options" }];
      case "backspace":
        this.backspace();
        return [];
      case "delete":
        this.deleteForward();
        return [];
      case "ctrl-c":
        return this.handleCtrlC();
      case "ctrl-d": {
        // ^d detaches only on an empty buffer. While any text remains it
        // acts as delete-forward (a no-op at end-of-buffer) — never a
        // detach — so the user must clear the prompt before ^d exits.
        if (this.bufferIsEmpty()) {
          return [{ type: "exit" }];
        }
        this.deleteForward();
        return [];
      }
      case "ctrl-l":
        return [{ type: "redraw" }];
      case "ctrl-p":
        return [{ type: "switch-session" }];
      case "ctrl-t":
        return [{ type: "toggle-thoughts" }];
      case "alt-n":
      case "alt-tab":
        return [{ type: "next-live-session" }];
      case "ctrl-r":
        return this.startHistorySearch();
      case "ctrl-s":
        // Outside history search, ^S aliases Shift+Enter / Ctrl+Enter
        // (amend the in-flight turn). The chord exists because some
        // terminals — notably libvte/gnome-terminal without the kitty
        // keyboard protocol — don't deliver Shift+Enter reliably, so
        // ^S gives those users a working alternative.
        // Caveat: terminals with XON/XOFF flow control enabled
        // (`stty -ixon` not set) will swallow ^S before it reaches us.
        // Inside history search, this case never runs — feed() peels
        // ^S there and routes it to retreatHistorySearch.
        return this.amend();
      case "ctrl-u":
        this.killLine();
        return [];
      case "ctrl-v":
        return [{ type: "attachment-request", source: "clipboard" }];
      case "ctrl-w":
        this.killWord();
        return [];
      case "ctrl-x":
        return [{ type: "toggle-mouse" }];
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

  // Substitute every [pasted #N +M lines] token with its stored original
  // text. Unknown ids (orphaned placeholders from outside this process)
  // are left as the literal token string — the safe fallback.
  private expandPastes(text: string): string {
    return text.replace(PASTE_TOKEN_RE, (match, idStr: string) => {
      const id = parseInt(idStr, 10);
      const stored = this.pastes.get(id);
      return stored !== undefined ? stored : match;
    });
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
    this.savedAttachments = null;
    this.historySearch = null;
    this.attachments = [];
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
      const before = line.slice(0, this.col);
      const m = before.match(PASTE_TOKEN_LEFT_RE);
      if (m !== null) {
        this.pastes.delete(parseInt(m[1]!, 10));
        this.setCurrentLine(
          line.slice(0, this.col - m[0].length) + line.slice(this.col),
        );
        this.col -= m[0].length;
        return;
      }
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
      const after = line.slice(this.col);
      const m = after.match(PASTE_TOKEN_RIGHT_RE);
      if (m !== null) {
        this.pastes.delete(parseInt(m[1]!, 10));
        this.setCurrentLine(
          line.slice(0, this.col) + line.slice(this.col + m[0].length),
        );
        return;
      }
      this.setCurrentLine(line.slice(0, this.col) + line.slice(this.col + 1));
      return;
    }
    if (this.row < this.buffer.length - 1) {
      const next = this.buffer[this.row + 1] ?? "";
      this.buffer.splice(this.row + 1, 1);
      this.setCurrentLine(line + next);
    }
  }

  // ^U: kill from cursor to start of current line. At col 0 with a line
  // above:
  //   - If the current line is empty, collapse it (kill just the
  //     newline) so the cursor lands at the end of the previous line.
  //     Don't slurp that line's contents.
  //   - Otherwise, kill the previous line entirely + the joining
  //     newline, so ^U from the start of a non-empty line walks up
  //     line-by-line.
  // Single-line behavior is unchanged.
  private killLine(): void {
    if (this.col > 0) {
      const line = this.currentLine();
      this.killBuffer = line.slice(0, this.col);
      this.setCurrentLine(line.slice(this.col));
      this.col = 0;
      return;
    }
    if (this.row === 0) {
      return;
    }
    if (this.currentLine().length === 0) {
      this.killBuffer = "\n";
      this.buffer.splice(this.row, 1);
      this.row -= 1;
      this.col = this.currentLine().length;
      return;
    }
    const prev = this.buffer[this.row - 1] ?? "";
    this.killBuffer = prev + "\n";
    this.buffer.splice(this.row - 1, 1);
    this.row -= 1;
  }

  // ^K: kill from cursor to end of current line. At end-of-line with a
  // line below:
  //   - If the current line is empty, collapse it (kill just the
  //     newline) so what was the next line takes its place. Don't slurp
  //     that line's contents.
  //   - Otherwise, kill the joining newline + the entire next line, so
  //     ^K from the end of a non-empty line walks down line-by-line.
  // Single-line behavior is unchanged.
  private killToEnd(): void {
    const line = this.currentLine();
    if (this.col < line.length) {
      this.killBuffer = line.slice(this.col);
      this.setCurrentLine(line.slice(0, this.col));
      return;
    }
    if (this.row >= this.buffer.length - 1) {
      return;
    }
    if (line.length === 0) {
      this.killBuffer = "\n";
      this.buffer.splice(this.row, 1);
      return;
    }
    const next = this.buffer[this.row + 1] ?? "";
    this.killBuffer = "\n" + next;
    this.buffer.splice(this.row + 1, 1);
  }

  private killWord(): void {
    const line = this.currentLine();
    if (this.col === 0) {
      this.backspace();
      return;
    }
    const before = line.slice(0, this.col);
    const m = before.match(PASTE_TOKEN_LEFT_RE);
    if (m !== null) {
      // Kill the whole placeholder as one word. The map entry stays
      // alive so a subsequent ^Y yanks a working token, not a literal
      // string that would be sent verbatim.
      this.killBuffer = m[0];
      const i = this.col - m[0].length;
      this.setCurrentLine(line.slice(0, i) + line.slice(this.col));
      this.col = i;
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
      const before = this.currentLine().slice(0, this.col);
      const m = before.match(PASTE_TOKEN_LEFT_RE);
      if (m !== null) {
        this.col -= m[0].length;
        return;
      }
      this.col -= 1;
      return;
    }
    if (this.row > 0) {
      this.row -= 1;
      this.col = this.currentLine().length;
    }
  }

  private moveRight(): void {
    const line = this.currentLine();
    if (this.col < line.length) {
      const after = line.slice(this.col);
      const m = after.match(PASTE_TOKEN_RIGHT_RE);
      if (m !== null) {
        this.col += m[0].length;
        return;
      }
      this.col += 1;
      return;
    }
    if (this.row < this.buffer.length - 1) {
      this.row += 1;
      this.col = 0;
    }
  }

  private moveWordBackward(): void {
    if (this.col === 0) {
      if (this.row === 0) {
        return;
      }
      this.row -= 1;
      this.col = this.currentLine().length;
      return;
    }
    const line = this.currentLine();
    // Skip trailing whitespace first so a placeholder ending just before
    // a space still gets jumped over atomically (mirrors moveWordForward
    // skipping leading whitespace).
    let i = this.col;
    while (i > 0 && /\s/.test(line[i - 1] ?? "")) {
      i -= 1;
    }
    const before = line.slice(0, i);
    const m = before.match(PASTE_TOKEN_LEFT_RE);
    if (m !== null) {
      this.col = i - m[0].length;
      return;
    }
    while (i > 0 && !/\s/.test(line[i - 1] ?? "")) {
      i -= 1;
    }
    this.col = i;
  }

  private moveWordForward(): void {
    const line = this.currentLine();
    if (this.col >= line.length) {
      if (this.row >= this.buffer.length - 1) {
        return;
      }
      this.row += 1;
      this.col = 0;
      return;
    }
    // Walk past leading whitespace first so alt-f from before a placeholder
    // still lands at its end (and not on the space between cursor and `[`).
    let i = this.col;
    while (i < line.length && /\s/.test(line[i] ?? "")) {
      i += 1;
    }
    const after = line.slice(i);
    const m = after.match(PASTE_TOKEN_RIGHT_RE);
    if (m !== null) {
      this.col = i + m[0].length;
      return;
    }
    while (i < line.length && !/\s/.test(line[i] ?? "")) {
      i += 1;
    }
    this.col = i;
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
      this.savedAttachments = [...this.attachments];
      this.attachments = [];
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
      this.attachments = this.savedAttachments ?? [];
      this.savedAttachments = null;
    } else {
      this.clearBuffer();
    }
  }

  // Engage reverse-incremental search over prompt history. Uses the
  // current buffer text as the search query. With an empty buffer we
  // enter search mode in an "empty query, no match shown" state — the
  // banner indicator lights up, and as the user types we extend the
  // query and load top matches. We deliberately do NOT auto-load the
  // most recent entry on an empty ^R (that's a surprise — Up-arrow
  // already walks history if that's what they wanted). With a
  // non-empty query that has no history match, escalate straight to
  // scrollback search so the typed term searches session output.
  private startHistorySearch(): InputEffect[] {
    const query = this.bufferText().toLowerCase();
    if (query.length === 0) {
      this.historySearch = {
        query: "",
        matchIndices: [],
        cursor: 0,
        savedDraft: {
          buffer: [...this.buffer],
          row: this.row,
          col: this.col,
        },
      };
      return [];
    }
    const matchIndices = this.findHistoryMatches(query);
    if (matchIndices.length === 0) {
      // Buffer text stays put so cancelling the resulting scrollback
      // search returns the user to what they typed.
      return [{ type: "escalate-search", query }];
    }
    this.historySearch = {
      query,
      matchIndices,
      cursor: 0,
      savedDraft: {
        buffer: [...this.buffer],
        row: this.row,
        col: this.col,
      },
    };
    this.loadEntry(this.history[matchIndices[0]!] ?? "");
    return [];
  }

  // ^R advance. At the oldest match with a non-empty query, falls
  // through to scrollback search (same escalate path as a never-
  // matched startHistorySearch). With an empty query at the oldest
  // match (i.e. the user walked all history with no filter), advance
  // is a no-op so the buffer stays on the oldest entry.
  private advanceHistorySearch(): InputEffect[] {
    if (this.historySearch === null) {
      return [];
    }
    const search = this.historySearch;
    const atOldest = search.cursor >= search.matchIndices.length - 1;
    if (atOldest) {
      if (search.query.length === 0) {
        return [];
      }
      // Restore the original draft so cancelling the upcoming
      // scrollback search lands the user back on the text they typed,
      // not the oldest history entry.
      const query = search.query;
      const draft = search.savedDraft;
      this.historySearch = null;
      this.buffer = [...draft.buffer];
      this.row = draft.row;
      this.col = draft.col;
      return [{ type: "escalate-search", query }];
    }
    search.cursor += 1;
    const idx = search.matchIndices[search.cursor]!;
    this.loadEntry(this.history[idx] ?? "");
    return [];
  }

  // ^S retreat — walk toward newer matches. No-op at the newest match
  // (no wrap, mirroring ^R no-wrap at the oldest).
  private retreatHistorySearch(): void {
    if (this.historySearch === null) {
      return;
    }
    if (this.historySearch.cursor === 0) {
      return;
    }
    this.historySearch.cursor -= 1;
    const idx = this.historySearch.matchIndices[this.historySearch.cursor]!;
    this.loadEntry(this.history[idx] ?? "");
  }

  // Backspace / typing within search mode mutates the query and
  // re-searches. When the new query is empty, restore the saved
  // draft buffer (typically empty) and stay in search mode — the
  // user can keep typing. When the new query has matches, load the
  // top one. When the new query has no matches, escalate to scrollback
  // search so the typed term applies there instead.
  private mutateHistorySearchQuery(newQuery: string): InputEffect[] {
    if (this.historySearch === null) {
      return [];
    }
    if (newQuery.length === 0) {
      this.historySearch.query = "";
      this.historySearch.matchIndices = [];
      this.historySearch.cursor = 0;
      const draft = this.historySearch.savedDraft;
      this.buffer = [...draft.buffer];
      this.row = draft.row;
      this.col = draft.col;
      return [];
    }
    const matchIndices = this.findHistoryMatches(newQuery);
    if (matchIndices.length === 0) {
      const draft = this.historySearch.savedDraft;
      this.historySearch = null;
      this.buffer = [...draft.buffer];
      this.row = draft.row;
      this.col = draft.col;
      return [{ type: "escalate-search", query: newQuery }];
    }
    this.historySearch.query = newQuery;
    this.historySearch.matchIndices = matchIndices;
    this.historySearch.cursor = 0;
    this.loadEntry(this.history[matchIndices[0]!] ?? "");
    return [];
  }

  private findHistoryMatches(query: string): number[] {
    const out: number[] = [];
    for (let i = this.history.length - 1; i >= 0; i--) {
      const entry = this.history[i] ?? "";
      if (query.length === 0 || entry.toLowerCase().includes(query)) {
        out.push(i);
      }
    }
    return out;
  }

  private cancelHistorySearch(): void {
    if (this.historySearch === null) {
      return;
    }
    const draft = this.historySearch.savedDraft;
    this.historySearch = null;
    this.buffer = [...draft.buffer];
    this.row = draft.row;
    this.col = draft.col;
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
    const displayText = this.bufferText();
    const text = this.expandPastes(displayText);
    // Submitting while editing a queued slot routes the change back into
    // the queue (edit or remove) instead of starting a new turn. Empty
    // text with attachments still counts as a removal — an attachment-
    // only queue slot is not something we support today.
    if (this.queueIndex >= 0 && this.queueIndex < this.queue.length) {
      const index = this.queueIndex;
      const attachments = [...this.attachments];
      this.clearBuffer();
      if (text.trim().length === 0) {
        return [{ type: "queue-remove", index }];
      }
      return [{ type: "queue-edit", index, text, displayText, attachments }];
    }
    if (text.trim().length === 0 && this.attachments.length === 0) {
      return [];
    }
    const planMode = this.planMode;
    const attachments = [...this.attachments];
    this.clearBuffer();
    return [{ type: "send", text, displayText, planMode, attachments }];
  }

  // Shift+Enter (also Ctrl+Enter / ^S): amend the in-flight turn.
  // While editing a queued slot, this is the "drop and amend" chord:
  // emit queue-remove for the slot AND amend with the loaded (possibly
  // edited) text, so the queued prompt becomes the amendment for the
  // running turn in a single keystroke. Empty buffer + no attachments
  // on a slot collapses to just queue-remove (matches empty-Enter).
  // Outside queue editing, an empty draft is a no-op. The app decides
  // whether to route the amend through amend_prompt or fall through to
  // a regular send when no turn is in flight.
  private amend(): InputEffect[] {
    const displayText = this.bufferText();
    const text = this.expandPastes(displayText);
    if (this.queueIndex >= 0 && this.queueIndex < this.queue.length) {
      const index = this.queueIndex;
      const planMode = this.planMode;
      const attachments = [...this.attachments];
      const empty = text.trim().length === 0 && attachments.length === 0;
      this.clearBuffer();
      if (empty) {
        return [{ type: "queue-remove", index }];
      }
      return [
        { type: "queue-remove", index },
        { type: "amend", text, displayText, planMode, attachments },
      ];
    }
    if (text.trim().length === 0 && this.attachments.length === 0) {
      return [];
    }
    const planMode = this.planMode;
    const attachments = [...this.attachments];
    this.clearBuffer();
    return [{ type: "amend", text, displayText, planMode, attachments }];
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
    //   1. Editing a queued slot → emit queue-remove for that slot
    //      and restore the original draft. One-shot cancel rather than
    //      the old "clear text, then Enter on empty buffer" two-step.
    //   2. Fresh draft with text/attachments → clear both.
    //   3. Empty draft, no slot, turn running → cancel.
    //   4. Empty draft, no slot, idle → exit.
    if (this.queueIndex >= 0) {
      const index = this.queueIndex;
      this.queueIndex = -1;
      this.restoreDraft();
      return [{ type: "queue-remove", index }];
    }
    if (!this.bufferIsEmpty() || this.attachments.length > 0) {
      this.buffer = [""];
      this.row = 0;
      this.col = 0;
      this.attachments = [];
      this.historyIndex = -1;
      this.savedDraft = null;
      this.savedAttachments = null;
      return [];
    }
    if (this.turnRunning) {
      return [{ type: "cancel" }];
    }
    return [{ type: "exit" }];
  }
}
