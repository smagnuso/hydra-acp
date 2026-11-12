// Local rows and peer rows differ in type but share the fields used here.
export type SessionRow = Record<string, unknown>;

export interface SessionStreamFrame {
  sessions: SessionRow[];
  removed: string[];
  cursor: number;
}

// updatedAt moves on every transcript chunk. Counting it would resend a
// session's row on every tick that another session caused.
function signature(entry: SessionRow): string {
  const { updatedAt: _updatedAt, ...rest } = entry;
  return JSON.stringify(rest);
}

// Per-connection memory of what a client has been sent, so each tick emits
// only rows that changed and ids that left.
export class SessionStreamDiff {
  private known = new Map<string, string>();

  constructor(private readonly warmOnly: boolean) {}

  // `deleted` is the store's own deletion list; it is only trusted for an
  // unfiltered stream. A warm-only stream infers departures instead, since
  // a session going cold deletes nothing.
  next(
    entries: SessionRow[],
    deleted: string[],
    cursor: number,
  ): SessionStreamFrame | null {
    const sessions: SessionRow[] = [];
    const present = new Set<string>();
    for (const entry of entries) {
      present.add(String(entry.sessionId));
      const sig = signature(entry);
      if (this.known.get(String(entry.sessionId)) !== sig) {
        this.known.set(String(entry.sessionId), sig);
        sessions.push(entry);
      }
    }
    const removed: string[] = [];
    if (this.warmOnly) {
      for (const id of [...this.known.keys()]) {
        if (!present.has(id)) {
          this.known.delete(id);
          removed.push(id);
        }
      }
    } else {
      for (const id of deleted) {
        if (this.known.delete(id)) {
          removed.push(id);
        }
      }
    }
    if (sessions.length === 0 && removed.length === 0) {
      return null;
    }
    return { sessions, removed, cursor };
  }
}
