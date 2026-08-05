// Ask the terminal what its background colour is, with OSC 11.
//
// The band reference — what the code and user stripes are derived a step off of
// — is a fact about the terminal, and every other way of getting it is a guess.
// COLORFGBG is absent more often than present. A theme's own `bg` describes what
// it was DESIGNED for, not what is in front of you. `tui.themeBackground` works
// but has to be typed by hand, and defaults to being wrong.
//
// OSC 11 is the terminal telling us directly:
//
//     ->  ESC ] 11 ; ? BEL
//     <-  ESC ] 11 ; rgb:0000/0000/0000 BEL
//
// Why this and not mode 2031 (`CSI ? 2031 h` + DSR 996), which reports
// dark/light and pushes a notification when the OS theme flips: 2031 is not
// implemented by VTE or by tmux, so it answers nothing on a mainstream Linux
// setup. OSC 11 answers in both, and answers with a colour rather than a bit —
// so bands derive from the real background instead of from a stand-in black.
//
// What it costs: a round trip before the TUI can take the keyboard, bounded by a
// timeout. What it risks: a reply arriving after we stop listening, which would
// land in whatever reads stdin next as literal text — see scrubOsc11.

import { parseColor, rgb, type Color } from "./color.js";

/** How long to wait for a reply before giving up and falling back. */
const DEFAULT_TIMEOUT_MS = 200;

const OSC11_QUERY = "\u001b]11;?\u0007";

/**
 * An OSC 11 reply, anywhere in `data`.
 *
 * Terminals vary in both the payload and the terminator: the colour may be
 * `rgb:RRRR/GGGG/BBBB` (16 bits per channel, xterm's own form), `rgb:RR/GG/BB`,
 * or `#RRGGBB`, and the string may end with BEL or with ST (`ESC \`). Accepting
 * all of them is cheaper than deciding which terminal we are talking to.
 *
 * Returns undefined for anything unrecognised, including a reply that is present
 * but malformed — a wrong background is worse than no background, because it
 * flips the direction the bands are derived in.
 */
export function parseOsc11(data: string): Color | undefined {
  const m = /\u001b\]11;([^\u0007\u001b]*)(?:\u0007|\u001b\\)/.exec(data);
  if (m === null) {
    return undefined;
  }
  const body = m[1]!.trim();
  const hex = /^#([0-9a-f]+)$/i.exec(body);
  if (hex !== null) {
    return parseColor(body) ?? undefined;
  }
  const spec = /^rgba?:([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)/i.exec(body);
  if (spec === null) {
    return undefined;
  }
  // Each component is 1-4 hex digits at the SAME width, scaled to 8 bits.
  // "0000" and "00" are both zero; "ffff" and "ff" are both 255. Truncating to
  // the leading two digits happens to work for 4-digit values and is wrong for
  // 1- and 3-digit ones, so scale properly.
  const chan = (s: string): number | undefined => {
    if (s.length === 0 || s.length > 4) {
      return undefined;
    }
    const max = 16 ** s.length - 1;
    return Math.round((parseInt(s, 16) / max) * 255);
  };
  const r = chan(spec[1]!);
  const g = chan(spec[2]!);
  const b = chan(spec[3]!);
  if (r === undefined || g === undefined || b === undefined) {
    return undefined;
  }
  return rgb(r, g, b);
}

/**
 * Remove an OSC 11 reply from a string.
 *
 * For a reply that arrives after we have stopped waiting. By then the TUI owns
 * stdin, and the sequence would be decoded as a burst of keypresses — dropping
 * `ESC]11;rgb:...` into the composer as literal text, which is a far worse
 * outcome than not knowing the background. The input path scrubs rather than
 * trusting the timeout to have been generous enough.
 */
export function scrubOsc11(data: string): string {
  return data.replace(/\u001b\]11;[^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "");
}

/** Whether `data` contains anything that looks like an OSC 11 reply. */
export function hasOsc11(data: string): boolean {
  return /\u001b\]11;/.test(data);
}

interface SenseStreams {
  input: {
    isTTY?: boolean;
    setRawMode?: (mode: boolean) => unknown;
    on: (event: "data", fn: (chunk: Buffer | string) => void) => unknown;
    off?: (event: "data", fn: (chunk: Buffer | string) => void) => unknown;
    removeListener?: (
      event: "data",
      fn: (chunk: Buffer | string) => void,
    ) => unknown;
    resume?: () => unknown;
    pause?: () => unknown;
    isPaused?: () => boolean;
  };
  output: { isTTY?: boolean; write: (s: string) => unknown };
}

/**
 * Query the terminal's background colour. Resolves undefined when it does not
 * answer in time, which is the normal outcome for a terminal that does not
 * implement OSC 11 and must therefore cost nothing but the timeout.
 *
 * Runs before the TUI grabs input, so it does its own minimal raw-mode setup and
 * puts the stream back exactly as it found it. Only ever resolves — a failure
 * here must never be the reason the TUI does not start.
 */
export async function senseBackground(
  streams: SenseStreams = { input: process.stdin, output: process.stdout },
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Color | undefined> {
  const { input, output } = streams;
  if (input.isTTY !== true || output.isTTY !== true) {
    return undefined;
  }
  return await new Promise<Color | undefined>((resolve) => {
    let buf = "";
    let done = false;
    const wasPaused = input.isPaused?.() ?? false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const onData = (chunk: Buffer | string): void => {
      buf += typeof chunk === "string" ? chunk : chunk.toString("latin1");
      const found = parseOsc11(buf);
      if (found !== undefined) {
        finish(found);
        return;
      }
      // A reply that is present but unparseable is still an answer: stop waiting
      // rather than holding startup open for the full timeout.
      if (hasOsc11(buf) && /\u0007|\u001b\\/.test(buf)) {
        finish(undefined);
      }
    };

    const finish = (result: Color | undefined): void => {
      if (done) {
        return;
      }
      done = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      try {
        (input.off ?? input.removeListener)?.call(input, "data", onData);
        // Raw mode and flow are restored to what they were: the caller sets up
        // its own input handling next, and inheriting state from a probe is the
        // kind of thing that turns into a keyboard that does not work.
        input.setRawMode?.(false);
        if (wasPaused) {
          input.pause?.();
        }
      } catch {
        // Restoring is best-effort. A terminal that cannot be put back is not a
        // reason to fail startup.
      }
      resolve(result);
    };

    try {
      input.setRawMode?.(true);
      input.resume?.();
      input.on("data", onData);
      output.write(OSC11_QUERY);
    } catch {
      finish(undefined);
      return;
    }
    timer = setTimeout(() => finish(undefined), timeoutMs);
    // Never hold the process open on the timeout alone.
    (timer as unknown as { unref?: () => void }).unref?.();
  });
}

/** The one method of terminal-kit's we have to wrap. */
interface StdinDecoder {
  onStdin: (chunk: Buffer) => void;
}

/**
 * Drop a late OSC 11 reply before terminal-kit's input decoder sees it.
 *
 * senseBackground stops listening after its timeout, but the terminal may answer
 * afterwards, and by then the TUI owns stdin. terminal-kit's keymap knows
 * `ESC]4;` (colour register) and `ESC]52;` (clipboard) and NOT `ESC]11;`, so an
 * unrecognised reply does not fall through harmlessly: the ESC becomes an ESCAPE
 * keypress and `]11;rgb:0000/0000/0000` arrives as sixteen literal characters,
 * typed into whatever has focus. A dropped answer is invisible; that is not.
 *
 * Wraps the `onStdin` property rather than filtering the stream, because
 * grabInput captures `this.onStdin` by reference when it registers the listener —
 * so this must be installed before the first grab, and once installed it covers
 * every later grab/release cycle (the picker, the prompts, the auth banner).
 *
 * Byte-preserving: latin1 round-trips arbitrary bytes, so multi-byte UTF-8 input
 * passes through unchanged.
 */
export function installOsc11Scrub(term: unknown): void {
  if (term === null || typeof term !== "object") {
    return;
  }
  const t = term as StdinDecoder;
  const original = t.onStdin;
  if (typeof original !== "function") {
    return;
  }
  t.onStdin = function scrubbed(chunk: Buffer): void {
    const text = chunk.toString("latin1");
    if (!hasOsc11(text)) {
      original.call(this, chunk);
      return;
    }
    const cleaned = scrubOsc11(text);
    if (cleaned.length === 0) {
      return;
    }
    original.call(this, Buffer.from(cleaned, "latin1"));
  };
}
