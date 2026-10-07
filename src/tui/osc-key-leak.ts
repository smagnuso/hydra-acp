// A palette reply that reaches us as keystrokes instead of as an OSC sequence.
//
// Behind a multiplexer, a reply that arrives after its request has been given up
// on is not parsed as a reply at all: the layers below re-encode it as input.
// With the kitty keyboard protocol on, `ESC ] 4;150;rgb:... ESC \` becomes
// Alt+] (CSI 93;3u), the literal text, then Alt+\ (CSI 92;3u), and the three
// pieces can land in separate reads. Elsewhere it arrives as a bracketed paste of
// the bare text. Either way the OSC filter never sees an ESC ], and the text is
// typed into the composer.

const HEX = "[0-9a-fA-F]";
const REPLY = `(?:4;\\d+|1[01]);(?:rgb:${HEX}{1,4}/${HEX}{1,4}/${HEX}{1,4}|#${HEX}{6})`;

const ALT_FORM = new RegExp(
  `\\x1b\\[93;3u${REPLY}(?:\\x1b\\[92;3u|\\x07)`,
  "g",
);
const PASTE_FORM = new RegExp(`\\x1b\\[200~${REPLY}\\x1b\\[201~`, "g");

// A read that stops partway through the Alt form. Only the opening Alt+] and the
// characters a reply can contain are held, so ordinary input is never delayed.
const HELD_TAIL =
  /\x1b\[9(?:3(?:;3?)?)?$|\x1b\[93;3u[0-9;a-fA-F:/#rgb]{0,48}(?:\x1b(?:\[(?:9(?:2(?:;3?)?)?)?)?)?$/;

const MAX_HELD = 80;

export class OscKeyLeakFilter {
  private carry = "";

  /** Whether a partial reply is being held back for the next read. */
  holding(): boolean {
    return this.carry.length > 0;
  }

  /** Release whatever is held, unmodified. */
  take(): string {
    const held = this.carry;
    this.carry = "";
    return held;
  }

  /**
   * Remove leaked replies from `text`. With `hold` set, an incomplete one at the
   * end is kept back and rejoined with the next read.
   */
  push(text: string, hold = true): string {
    let t = this.carry + text;
    this.carry = "";
    t = t.replace(ALT_FORM, "").replace(PASTE_FORM, "");
    if (hold) {
      const m = HELD_TAIL.exec(t);
      if (m !== null && t.length - m.index <= MAX_HELD) {
        this.carry = t.slice(m.index);
        t = t.slice(0, m.index);
      }
    }
    return t;
  }
}
