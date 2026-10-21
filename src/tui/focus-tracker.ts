import { FOCUS_IN, FOCUS_OUT } from "./ansi.js";

// Terminals emit FOCUS_IN before the click that caused it, so a press within
// this window of a focus gain is the focusing click and gets swallowed.
const FOCUS_GRACE_MS = 200;
// Clipboard helpers can flicker focus; clicks right after our own copy are not focusing clicks.
const OWN_COPY_SLACK_MS = 1000;

export class FocusTracker {
  private isFocused = true;
  private focusInAt = 0;
  private ownCopyAt = 0;

  get focused(): boolean {
    return this.isFocused;
  }

  // Null until the first FOCUS_IN.
  msSinceFocusIn(now = Date.now()): number | null {
    return this.focusInAt === 0 ? null : now - this.focusInAt;
  }

  noteOwnCopy(now = Date.now()): void {
    this.ownCopyAt = now;
  }

  // Strips focus markers from `text` and updates state.
  consume(text: string): { text: string; changed: boolean } {
    if (!text.includes(FOCUS_IN) && !text.includes(FOCUS_OUT)) {
      return { text, changed: false };
    }
    const before = this.isFocused;
    while (true) {
      const inIdx = text.indexOf(FOCUS_IN);
      const outIdx = text.indexOf(FOCUS_OUT);
      const which =
        inIdx === -1 ? outIdx :
        outIdx === -1 ? inIdx :
        Math.min(inIdx, outIdx);
      if (which === -1) {
        break;
      }
      this.isFocused = which === inIdx;
      if (this.isFocused) {
        this.focusInAt = Date.now();
      }
      text = text.slice(0, which) + text.slice(which + FOCUS_IN.length);
    }
    return { text, changed: this.isFocused !== before };
  }

  // True when a button event should be treated as not-yet-focused input.
  shouldDropButtonEvent(now = Date.now()): boolean {
    if (now - this.ownCopyAt < OWN_COPY_SLACK_MS) {
      return false;
    }
    return !this.isFocused || now - this.focusInAt < FOCUS_GRACE_MS;
  }
}
