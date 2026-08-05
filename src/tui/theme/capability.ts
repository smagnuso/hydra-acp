// How much colour to emit, and whether to emit any.
//
// Split from color.ts because that file is pure arithmetic and this one reads
// the environment. Two entry points, deliberately:
//
//   depthForStream()   — for CLI output: `hydra daemon status`, `hydra cat`,
//                        the pre-TUI stderr warnings. Sniffs env and isTTY,
//                        because there is no terminal object to ask.
//   depthForTerminal() — for the TUI, which has a live terminal-kit instance
//                        that already did its own detection. Asking it keeps
//                        our colours consistent with anything terminal-kit
//                        draws itself, and means grayscale bands land on the
//                        bytes they always have.
//
// Both honour NO_COLOR, which is the one rule that has to hold everywhere: a
// user who sets it wants no colour from any surface, TUI included.

import type { ColorDepth } from "./color.js";

export type { ColorDepth };

interface Env {
  [key: string]: string | undefined;
}

/**
 * NO_COLOR per https://no-color.org: set and non-empty disables colour. An
 * empty value is explicitly NOT a disable, so `NO_COLOR=` behaves as unset.
 */
function noColor(env: Env): boolean {
  const v = env.NO_COLOR;
  return v !== undefined && v !== "";
}

/**
 * FORCE_COLOR, mirroring the convention supports-color established, since
 * that is what the ecosystem's tooling sets.
 *
 * Returns undefined when unset, so callers can tell "no opinion" from
 * "explicitly off".
 */
function forceColor(env: Env): ColorDepth | undefined {
  const v = env.FORCE_COLOR;
  if (v === undefined) {
    return undefined;
  }
  switch (v) {
    case "0":
    case "false":
      return "none";
    case "1":
      return "ansi16";
    case "2":
      return "ansi256";
    case "3":
      return "truecolor";
    default:
      // Set but not a recognised level (including empty, and "true"): treat as
      // "colour on, work the depth out from the environment".
      return undefined;
  }
}

/** Whether FORCE_COLOR is asking for colour without naming a level. */
function forcedOn(env: Env): boolean {
  const v = env.FORCE_COLOR;
  return v !== undefined && v !== "0" && v !== "false";
}

/** Depth implied by TERM / COLORTERM alone, ignoring TTY and NO_COLOR. */
function depthFromEnv(env: Env): ColorDepth {
  const colorterm = (env.COLORTERM ?? "").toLowerCase();
  if (colorterm === "truecolor" || colorterm === "24bit") {
    return "truecolor";
  }
  const term = (env.TERM ?? "").toLowerCase();
  // `-direct` is terminfo's name for a direct-colour entry; several terminals
  // ship `xterm-direct` rather than setting COLORTERM.
  if (term.includes("truecolor") || term.includes("direct")) {
    return "truecolor";
  }
  if (term.includes("256")) {
    return "ansi256";
  }
  return "ansi16";
}

/**
 * Depth for a plain output stream.
 *
 * Order matters: NO_COLOR beats FORCE_COLOR (an explicit opt-out should not be
 * overridable by tooling that sets FORCE_COLOR for unrelated reasons), and
 * FORCE_COLOR beats the TTY check (which is its whole purpose — colour into a
 * pipe, on request).
 */
export function depthForStream(
  stream: { isTTY?: boolean } = process.stdout,
  env: Env = process.env,
): ColorDepth {
  if (noColor(env)) {
    return "none";
  }
  const forced = forceColor(env);
  if (forced !== undefined) {
    return forced;
  }
  if (forcedOn(env)) {
    return depthFromEnv(env);
  }
  // A terminal that says it cannot do colour is believed even on a TTY.
  if ((env.TERM ?? "").toLowerCase() === "dumb") {
    return "none";
  }
  if (stream.isTTY !== true) {
    return "none";
  }
  return depthFromEnv(env);
}

/** Whether any colour should be emitted to `stream`. */
export function colorEnabled(
  stream: { isTTY?: boolean } = process.stdout,
  env: Env = process.env,
): boolean {
  return depthForStream(stream, env) !== "none";
}

/**
 * Whether a multiplexer sits in the way and will not forward 24-bit colour.
 *
 * COLORTERM inside tmux describes the OUTER terminal — tmux passes the variable
 * through whether or not it will pass the escapes through. An unconfigured tmux
 * advertises 256 colours and no RGB:
 *
 *     $ tmux info | grep -E 'RGB|Tc'
 *       RGB: [missing]
 *       Tc:  [missing]
 *
 * Emitting 24-bit at it means tmux re-maps the sequences itself, which is how a
 * carefully derived slate band arrives as something else entirely. So the
 * COLORTERM upgrade is withheld for the default `screen*` TERM that tmux sets
 * when nobody has configured it otherwise.
 *
 * A user who HAS configured truecolor passthrough sets `default-terminal` to
 * something else (`tmux-256color` conventionally) alongside the RGB terminal
 * feature, and that case is allowed through — the changed TERM is the signal
 * that someone made a decision.
 */
function multiplexerBlocks24Bit(env: Env): boolean {
  if (!inTmux(env)) {
    return false;
  }
  return (env.TERM ?? "").toLowerCase().startsWith("screen");
}

/**
 * Whether tmux is in the way.
 *
 * Also a 256-colour floor: tmux has done 256 colours for its entire history,
 * and the `screen` TERM it sets by default advertises 8. Believing that TERM
 * costs a tmux user every themed colour.
 */
function inTmux(env: Env): boolean {
  return env.TMUX !== undefined && env.TMUX !== "";
}

/** The shape of terminal-kit's own capability answer that we read. */
interface TerminalCaps {
  esc?: {
    color24bits?: { na?: boolean; fb?: boolean };
    color256?: { na?: boolean; fb?: boolean };
  };
}

/**
 * Depth for the TUI.
 *
 * terminal-kit's own answer is the starting point — it has resolved a termconfig
 * and its answer governs anything it draws itself — but it is not sufficient. It
 * predates COLORTERM and decides 24-bit purely from TERM, which in practice means
 * it says NO to almost every terminal that can actually do it:
 *
 *     xterm-256color   24bit usable: false   <- gnome-terminal, most others
 *     screen           24bit usable: false   <- tmux
 *     xterm-direct     24bit usable: false   <- terminfo's own direct-colour entry
 *     xterm-truecolor  24bit usable: true    <- essentially only this
 *
 * Deferring to it alone meant every theme rendered as a 256-colour
 * approximation: dracula's #6272a4 comment quantised to #5f5faf, its #8be9fd
 * cyan to #87d7ff. Close enough to look deliberate and wrong enough to look off.
 *
 * So COLORTERM is honoured on top, which is the signal terminals actually set
 * today. Only ever an UPGRADE, and only from 256 — a terminal terminal-kit
 * believes cannot do 256 is not told to emit 24-bit on the strength of an
 * environment variable.
 */
export function depthForTerminal(
  term: unknown,
  env: Env = process.env,
): ColorDepth {
  if (noColor(env)) {
    return "none";
  }
  // Tolerate a null/undefined terminal: this runs on every write, and
  // throwing here would take the TUI down over a capability probe.
  const esc = (term as TerminalCaps | null | undefined)?.esc;
  const usable = (c?: { na?: boolean; fb?: boolean }): boolean =>
    c !== undefined && !c.na && !c.fb;

  // terminal-kit's own answer, which is the FLOOR.
  const own: ColorDepth = usable(esc?.color24bits)
    ? "truecolor"
    : usable(esc?.color256)
      ? "ansi256"
      : "ansi16";

  // ...and its CEILING, which is a different question and reads a different
  // field. `na` is terminal-kit saying the capability is absent; `fb` is it
  // saying it will fall back, which is not the same claim and must not be read
  // as one. Conflating them dropped the whole TUI to 4-bit inside tmux, where
  // TERM=screen reports `color256: { fb: true }`: every themed colour went
  // through quantize16, and dracula's grey code band came out as ansi slot 6,
  // a cyan stripe across every fenced block.
  // Only the 256 field caps us. A `na` on color24bits is not a ceiling: that is
  // the field terminal-kit fills in from TERM alone, and TERM is exactly what
  // understates 24-bit support — respecting it here would undo the COLORTERM
  // upgrade for every terminal that needs it.
  const ceiling: ColorDepth =
    esc?.color256?.na === true ? "ansi16" : "truecolor";

  // What the environment claims, with the 24-bit claim withheld behind an
  // unconfigured multiplexer and a 256 floor applied inside one.
  const fromEnv = depthFromEnv(env);
  const claimed: ColorDepth =
    fromEnv === "truecolor" && multiplexerBlocks24Bit(env)
      ? "ansi256"
      : inTmux(env) && fromEnv === "ansi16"
        ? "ansi256"
        : fromEnv;

  const order: ColorDepth[] = ["none", "ansi16", "ansi256", "truecolor"];
  const rank = (d: ColorDepth): number => order.indexOf(d);
  return order[
    Math.min(Math.max(rank(own), rank(claimed)), rank(ceiling))
  ] as ColorDepth;
}

/**
 * Whether the terminal's background is dark or light, per COLORFGBG.
 *
 * Several terminals (rxvt, konsole, some others) export `fg;bg` as ANSI slot
 * indices, which vim and friends have long used for exactly this question. It is
 * absent more often than present, so it is a hint and not an answer — but it is
 * free, and it is the only signal available without asking the terminal
 * directly.
 *
 * Returns undefined when unset or unparseable rather than guessing: a wrong
 * guess here paints a light band on a dark terminal, which is the thing this
 * exists to prevent.
 */
export function backgroundHint(
  env: Env = process.env,
): "dark" | "light" | undefined {
  const raw = env.COLORFGBG;
  if (raw === undefined || raw === "") {
    return undefined;
  }
  // "fg;bg" or "fg;default;bg" — the background is always the last field.
  const last = raw.split(";").pop()?.trim() ?? "";
  if (!/^\d+$/.test(last)) {
    return undefined;
  }
  const slot = Number(last);
  if (slot > 15) {
    return undefined;
  }
  // 0-6 are the dark half of the ansi block; 8 is bright black, still dark.
  // 7 (white) and 9-15 (the bright colours) read as light.
  return slot <= 6 || slot === 8 ? "dark" : "light";
}
