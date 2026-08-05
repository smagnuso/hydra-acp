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
// What it costs: a round trip before the TUI can take the keyboard, bounded by a
// timeout. What it risks: a reply arriving after we stop listening, which would
// land in whatever reads stdin next as literal text — see installReplyFilter.
//
// This file also implements mode 2031 (further down), which is the other half of
// the question: OSC 11 answers what the background IS, 2031 asks to be told when
// it CHANGES. They are not alternatives. OSC 11 is the one that carries a colour
// and the one that is widely implemented — VTE and tmux both answer it, and
// neither implements 2031 — so it stays the primary source, and a 2031
// notification is a trigger to ask again rather than an answer in itself.

import { parseColor, rgb, type Color } from "./color.js";
import { hasCprReport, scrubCprReports } from "../width-probe.js";

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

// ---------------------------------------------------------------------------
// Mode 2031: theme-change notifications
// ---------------------------------------------------------------------------

// OSC 11 answers "what is your background" once. Mode 2031 is the terminal
// promising to tell us when that answer CHANGES — which is the only way to react
// to someone flipping their OS light/dark setting mid-session:
//
//     ->  CSI ? 2031 h                 (enable; CSI ? 2031 l to disable)
//     <-  CSI ? 997 ; 1 n              (now dark)
//     <-  CSI ? 997 ; 2 n              (now light)
//
// The notification carries a bit, not a colour, so it is a trigger rather than an
// answer: on receiving one we re-ask OSC 11 and use the colour, falling back to
// the bit if nothing replies.
//
// Enabling an unimplemented DEC private mode is silently ignored, so this costs
// terminals without support one escape sequence at startup and one at exit.
// Support is real but not universal — ghostty, foot, contour, kitty have it;
// VTE (gnome-terminal) and tmux, as of testing, do not.

export const SCHEME_REPORTS_ON = "\u001b[?2031h";
export const SCHEME_REPORTS_OFF = "\u001b[?2031l";

export type ColorScheme = "dark" | "light";

/**
 * A mode 2031 notification, anywhere in `data`.
 *
 * `1` is dark and `2` is light. Any other parameter is ignored rather than
 * guessed at: the spec defines two values, and a third would mean we are talking
 * to something that does not mean what we think by this sequence.
 */
export function parseSchemeReport(data: string): ColorScheme | undefined {
  const m = /\u001b\[\?997;([12])n/.exec(data);
  if (m === null) {
    return undefined;
  }
  return m[1] === "1" ? "dark" : "light";
}

/** Remove every mode 2031 notification from a string. */
export function scrubSchemeReports(data: string): string {
  return data.replace(/\u001b\[\?997;\d+n/g, "");
}

/** The colour a scheme bit stands for, when OSC 11 will not say more. */
export function schemeBackground(scheme: ColorScheme): Color {
  // Same stand-ins tui.themeBackground's "dark"/"light" resolve to, chosen so the
  // derived bands land on the pre-theme absolute levels.
  return scheme === "dark" ? rgb(0, 0, 0) : rgb(255, 255, 255);
}

/** The one method of terminal-kit's we have to wrap. */
interface StdinDecoder {
  onStdin: (chunk: Buffer) => void;
}

/** What the input filter can hand back to the caller. */
export interface ReplyHandlers {
  /** A background colour arrived — a late OSC 11 reply, or one we asked for. */
  onBackground?: (color: Color) => void;
  /** The terminal reports its light/dark scheme changed (mode 2031). */
  onScheme?: (scheme: ColorScheme) => void;
}

/**
 * Intercept terminal replies before terminal-kit's input decoder sees them.
 *
 * Two jobs, one seam. Both OSC 11 replies and mode 2031 notifications are
 * *unrecognised* by terminal-kit: its keymap knows `ESC]4;` (colour register) and
 * `ESC]52;` (clipboard) and nothing else in this space. An unrecognised sequence
 * does not fall through harmlessly — the ESC becomes an ESCAPE keypress and the
 * remainder arrives as literal characters, typed into whatever has focus. So they
 * have to be removed whether or not anyone wants them, and once we are removing
 * them, routing them costs nothing.
 *
 * That makes this the delivery path for the live case too: after grabInput,
 * terminal-kit owns stdin, so senseBackground's raw-mode probe cannot be used
 * again. Writing an OSC 11 query and waiting for `onBackground` can.
 *
 * Wraps the `onStdin` property rather than filtering the stream, because
 * grabInput captures `this.onStdin` by reference when it registers the listener —
 * so this must be installed before the first grab, and once installed it covers
 * every later grab/release cycle (the picker, the prompts, the auth banner).
 *
 * Byte-preserving: latin1 round-trips arbitrary bytes, so multi-byte UTF-8 input
 * passes through unchanged.
 */
export function installReplyFilter(
  term: unknown,
  handlers: ReplyHandlers = {},
): void {
  if (term === null || typeof term !== "object") {
    return;
  }
  const t = term as StdinDecoder;
  const original = t.onStdin;
  if (typeof original !== "function") {
    return;
  }
  t.onStdin = function filtered(chunk: Buffer): void {
    const text = chunk.toString("latin1");
    if (
      !hasOsc11(text) &&
      !/\u001b\[\?997;/.test(text) &&
      !hasCprReport(text)
    ) {
      original.call(this, chunk);
      return;
    }
    const background = parseOsc11(text);
    const scheme = parseSchemeReport(text);
    // CPR replies are dropped without a handler: the only thing that asks for
    // one is the startup width probe, which has its own listener and is done by
    // the time this filter is live. A late one is an answer to a question nobody
    // still has, and passing it through would surface as a phantom
    // cursor-location event.
    const cleaned = scrubCprReports(scrubSchemeReports(scrubOsc11(text)));
    // The keystrokes go first: a redraw triggered by a scheme change should not
    // land between a keypress and its handler.
    if (cleaned.length > 0) {
      original.call(this, Buffer.from(cleaned, "latin1"));
    }
    if (background !== undefined) {
      handlers.onBackground?.(background);
    }
    if (scheme !== undefined) {
      handlers.onScheme?.(scheme);
    }
  };
}
