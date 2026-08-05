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

/** The shape of terminal-kit's own capability answer that we read. */
interface TerminalCaps {
  esc?: {
    color24bits?: { na?: boolean; fb?: boolean };
    color256?: { na?: boolean; fb?: boolean };
  };
}

/**
 * Depth for the TUI, taken from terminal-kit's detection rather than redone.
 *
 * The TUI is an alt-screen app on a TTY, so the only environment question left
 * is NO_COLOR. Everything else defers to terminal-kit: it has already resolved
 * a termconfig, its answer is what governs anything it draws on its own, and
 * matching it is what keeps the grayscale bands on the bytes they have always
 * emitted.
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
  if (usable(esc?.color24bits)) {
    return "truecolor";
  }
  if (usable(esc?.color256)) {
    return "ansi256";
  }
  return "ansi16";
}
