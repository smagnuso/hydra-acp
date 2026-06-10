// Row-level paint primitives shared by screen.ts and picker.ts.
//
// RowPainter holds the per-row signature cache that lets render
// passes skip unchanged rows: callers funnel every row through
// paintRow(row, sig, paint), and identical sigs short-circuit
// the moveTo + paint + styleReset + eraseLineAfter sequence.
// The sig must capture every input that affects the visible
// output for that row.
//
// RepaintScheduler coalesces rapid scheduleRepaint() calls into
// at most one repaint per throttle window, deferring the rest
// to the trailing edge. screen.ts uses it for streaming content;
// picker.ts does not need it (its renders are key-driven and
// already synchronous).

import type { Terminal } from "terminal-kit";

export class RowPainter {
  private lastFrameRows = new Map<number, string>();
  private lastFrameW = 0;
  private lastFrameH = 0;

  constructor(private readonly term: Terminal) {}

  // Drop all cached signatures so the next paintRow call for any
  // row is guaranteed to emit. Called by forced full redraws
  // (e.g. ^L, alternate-screen entry, mode swaps) and by stop().
  clearCache(): void {
    this.lastFrameRows.clear();
    this.lastFrameW = 0;
    this.lastFrameH = 0;
  }

  // Discard the cache when the terminal has been resized — the
  // previous frame is gone from the user's perspective and every
  // row must be re-emitted. Returns true on dimension change.
  ensureSize(w: number, h: number): boolean {
    if (w !== this.lastFrameW || h !== this.lastFrameH) {
      this.lastFrameRows.clear();
      this.lastFrameW = w;
      this.lastFrameH = h;
      return true;
    }
    return false;
  }

  // Funnel for every row a caller renders. Order matters: we
  // move, draw the new content over the old, reset SGR, then
  // erase from the cursor to end of line. Erasing BEFORE paint
  // would blank the row first — visible as a per-row flash on
  // banner ticks and single-char prompt edits, since some
  // terminals still render incrementally inside DEC 2026
  // brackets. The styleReset stops the trailing erase from
  // inheriting the paint's last SGR (e.g. a bgBlue selection
  // slice) and painting the rest of the line in that colour.
  paintRow(row: number, signature: string, paint: () => void): void {
    if (row < 1 || row > this.term.height) {
      return;
    }
    if (this.lastFrameRows.get(row) === signature) {
      return;
    }
    this.lastFrameRows.set(row, signature);
    this.term.moveTo(1, row);
    paint();
    this.term.styleReset();
    this.term.eraseLineAfter();
  }
}

export interface RepaintSchedulerDeps {
  // Suppress scheduling once the host has been stopped — a timer
  // that fires after stop() would write escape sequences into
  // the host shell.
  isStarted(): boolean;
  // While paused, scheduleRepaint records intent but does not
  // queue a paint; the host resumes by checking its own pending
  // flag.
  isRepaintPaused(): boolean;
  markRepaintPending(): void;
  throttleMs(): number;
  // Action to invoke when the trailing-edge timer fires, or when
  // schedule() decides to paint synchronously.
  doRepaint(): void;
}

export class RepaintScheduler {
  private lastRepaintAt = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: RepaintSchedulerDeps) {}

  // Test-only inspector used by screen.test.ts to confirm a
  // timer was queued/cancelled at the right points in the
  // lifecycle. Not part of the public contract.
  get pendingTimer(): NodeJS.Timeout | null {
    return this.timer;
  }

  schedule(): void {
    if (!this.deps.isStarted()) {
      return;
    }
    if (this.deps.isRepaintPaused()) {
      this.deps.markRepaintPending();
      return;
    }
    const throttle = this.deps.throttleMs();
    if (throttle <= 0) {
      this.deps.doRepaint();
      return;
    }
    const now = Date.now();
    const elapsed = now - this.lastRepaintAt;
    if (elapsed >= throttle) {
      this.cancel();
      this.deps.doRepaint();
      return;
    }
    if (this.timer !== null) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.deps.doRepaint();
    }, throttle - elapsed);
  }

  // Called by the host at the start of an actual repaint so the
  // throttle window resets and any trailing-edge timer is dropped
  // (its work is already being done).
  noteRepaintStart(): void {
    this.lastRepaintAt = Date.now();
    this.cancel();
  }

  cancel(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
