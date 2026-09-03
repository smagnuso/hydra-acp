// Generic multi-keystroke ("chord") prefix-key matcher — e.g. emacs/readline
// style Ctrl+X Ctrl+E. Stateful: feed() consumes one token at a time and
// reports whether to forward it immediately, swallow it because a chord is
// now armed, or drop it because an armed prefix's next key didn't complete
// any registered chord within the timeout.
//
// feed() is only for tokens that could themselves be a chord prefix or
// completion (a mapped KeyName, or a raw terminal-kit key name) — never for
// printable characters. A stray prefix key followed by ordinary typing must
// not eat the first character, so callers should call clear() and forward
// character tokens unconditionally instead of routing them through feed().
export interface ChordTable<T> {
  readonly chords: ReadonlyMap<T, ReadonlyMap<T, T>>;
  readonly timeoutMs: number;
}

export type ChordFeedResult<T> =
  | { kind: "pass"; token: T }
  | { kind: "armed" }
  | { kind: "aborted" };

export class ChordMatcher<T> {
  private pending: { prefix: T; armedAt: number } | null = null;

  constructor(
    private readonly table: ChordTable<T>,
    private readonly now: () => number = Date.now,
  ) {}

  get isArmed(): boolean {
    return this.pending !== null;
  }

  clear(): void {
    this.pending = null;
  }

  feed(token: T): ChordFeedResult<T> {
    if (this.pending) {
      const { prefix, armedAt } = this.pending;
      this.pending = null;
      const inWindow = this.now() - armedAt <= this.table.timeoutMs;
      const resolved = inWindow
        ? this.table.chords.get(prefix)?.get(token)
        : undefined;
      return resolved !== undefined
        ? { kind: "pass", token: resolved }
        : { kind: "aborted" };
    }
    if (this.table.chords.has(token)) {
      this.pending = { prefix: token, armedAt: this.now() };
      return { kind: "armed" };
    }
    return { kind: "pass", token };
  }
}

// Builds a ChordTable from flat [prefix, next, resolved] triples.
export function buildChordTable<T>(
  entries: ReadonlyArray<readonly [T, T, T]>,
  timeoutMs: number,
): ChordTable<T> {
  const chords = new Map<T, Map<T, T>>();
  for (const [prefix, next, resolved] of entries) {
    let inner = chords.get(prefix);
    if (!inner) {
      inner = new Map();
      chords.set(prefix, inner);
    }
    inner.set(next, resolved);
  }
  return { chords, timeoutMs };
}

// Gap allowed between a chord's prefix and its completion key. Generous
// enough to type "Ctrl+X Ctrl+E" deliberately without racing a timer, tight
// enough that an unrelated Ctrl+key minutes later can't complete a stale
// chord.
export const CHORD_TIMEOUT_MS = 1500;

// Raw terminal-kit key names (as delivered by "key" events, e.g. "CTRL_X")
// aren't mapped to the app's KeyName union until they reach `Screen` or a
// composer's own translation — but `runModalPrompt` (prompt-utils.ts) and
// the session picker's raw dispatch (picker.ts) both consume raw names
// directly, ahead of any such mapping. This table lets both share one chord
// registry instead of each inventing its own. `mapKeyName` (screen.ts) has
// a matching case for "CTRL_X_CTRL_E" so a chord resolved here still reaches
// an InputDispatcher via the normal raw-name -> KeyName path (see how
// picker.ts's composer/findComposer translate raw names today).
export const RAW_KEY_CHORD_TABLE: ChordTable<string> = buildChordTable(
  [["CTRL_X", "CTRL_E", "CTRL_X_CTRL_E"]],
  CHORD_TIMEOUT_MS,
);
