// Flight recorder for raw terminal input. Keeps the last few reads in memory and
// writes them out only when something suspicious happens, so a rare leak can be
// diagnosed from the log without tracing every keystroke all day.

const MAX_READS = 40;
const MIN_DUMP_GAP_MS = 2000;

interface Read {
  at: number;
  text: string;
}

export function printable(text: string): string {
  return text.replace(
    /[^\x20-\x7e]/g,
    (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`,
  );
}

export class InputRecorder {
  private reads: Read[] = [];
  private lastDumpAt = -Infinity;

  constructor(private readonly now: () => number = Date.now) {}

  record(text: string): void {
    this.reads.push({ at: this.now(), text });
    if (this.reads.length > MAX_READS) {
      this.reads.shift();
    }
  }

  /** The recent reads, oldest first, with ages relative to now. Null if throttled. */
  snapshot(): Array<{ agoMs: number; read: string }> | null {
    const now = this.now();
    if (now - this.lastDumpAt < MIN_DUMP_GAP_MS) {
      return null;
    }
    this.lastDumpAt = now;
    return this.reads.map((r) => ({
      agoMs: now - r.at,
      read: printable(r.text),
    }));
  }
}
