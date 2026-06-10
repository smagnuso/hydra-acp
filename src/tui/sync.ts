// DEC private mode 2026 — synchronized output. Modern terminals (Kitty,
// WezTerm, Ghostty, recent iTerm / Konsole / VTE, tmux >= 3.4) treat
// the BSU…ESU bracket as one atomic frame, so a multi-row repaint
// commits as a single frame instead of waterfalling row-by-row.
// Unsupported terminals discard the sequences harmlessly. A depth
// counter flattens nested withSync calls to a single outer bracket so
// inner leaf paints can stay wrapped without churning the wire.

import { SYNC_BEGIN, SYNC_END } from "./ansi.js";

let depth = 0;

export function beginSync(): void {
  if (depth === 0) {
    process.stdout.write(SYNC_BEGIN);
  }
  depth++;
}

export function endSync(): void {
  if (depth === 0) {
    return;
  }
  depth--;
  if (depth === 0) {
    process.stdout.write(SYNC_END);
  }
}

export function withSync(fn: () => void): void {
  beginSync();
  try {
    fn();
  } finally {
    endSync();
  }
}
