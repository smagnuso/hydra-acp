// Which TerminalHost are we inside?
//
// ---------------------------------------------------------------------
// PRECEDENCE: INNERMOST WINS
//
// These things NEST, and routinely: a multiplexer inside an emulator, or one
// multiplexer inside another. So more than one candidate can `detect()` true
// at once, and picking the wrong one means writing into a pane we aren't in —
// the exact bug class this area has already produced once.
//
// The innermost host is the right answer because it's the one that actually
// owns our pane. "Innermost" isn't derivable from env presence, so it's
// encoded as the order of CANDIDATES: most specific first, first match wins.
//
// Note this is the opposite policy from env scrubbing, which unions ALL
// candidates regardless of detection (core/scrub-env.ts). Different
// questions: detection asks "who do I talk to", scrubbing asks "what must
// not outlive this pane".
// ---------------------------------------------------------------------
//
// RESOLUTION IS OPT-IN. initTerminalHost() has to be called explicitly —
// nothing here reads the ambient environment on demand.
//
// That's not ceremony. The report funnels live inside Screen, so anything
// that constructs a Screen and pushes a session bar would otherwise report:
// including the test suite. `screen.test.ts` alone drives those funnels 13
// times, so running `pnpm test` from a shell inside a managed pane used to
// register a phantom `hydra` agent on the developer's own pane, pinned at
// `working` forever — the tests never call teardown, and a hydra pane has no
// screen-scrape fallback to correct it. Gating on an explicit init from
// runTuiApp means only the real TUI ever reports. Guarding on
// `process.env.VITEST` instead would have fixed the symptom for vitest and
// left the hazard for every other embedder of Screen.

import { herdrCandidate } from "./herdr.js";
import { paseoCandidate } from "./paseo.js";
import { tmuxCandidate } from "./tmux.js";
import type { TerminalHost, TerminalHostCandidate } from "./types.js";

/**
 * Most specific first — EXCEPT paseo, deliberately out of "innermost wins"
 * order. See the precedence note above for the general rule; this is the
 * documented exception to it.
 *
 * paseo goes FIRST, ahead of herdr and tmux, even though its terminal is
 * ordinarily the outermost box a multiplexer would run inside (so strict
 * innermost-wins would put it last). Verified live: Paseo's own daemon does
 * not scrub pane-scoped variables (TMUX, TMUX_PANE, and presumably the
 * herdr/zellij/etc. equivalents) from its OWN inherited environment before
 * spawning terminals — the same "daemon outlives the shell that started it"
 * bug class core/scrub-env.ts exists to prevent on Hydra's side, just not
 * fixed on theirs. A Paseo daemon started inside a tmux pane leaks that
 * pane's stale identity into every terminal it creates afterward, so
 * TMUX_PANE reads as present even though nothing is actually nested — tmux
 * would otherwise win detection and reports would go to a pane the user
 * isn't even looking at, silently, with paseo's own real signal ignored.
 *
 * The tradeoff this accepts: a user who deliberately runs tmux (or herdr)
 * INSIDE a real Paseo terminal loses per-pane granularity — activity reports
 * to the one Paseo terminal-level indicator instead of the specific nested
 * pane. That's a real but rare setup (Paseo terminals are ordinarily used as
 * a single plain shell), and it degrades to "coarser, not silent" rather
 * than "silent," so it's the better failure mode of the two. Revisit this
 * ordering if/when Paseo scrubs its own daemon's environment before spawning
 * terminals.
 */
export const CANDIDATES: readonly TerminalHostCandidate[] = [
  paseoCandidate,
  herdrCandidate,
  tmuxCandidate,
];

let active: TerminalHost | null = null;

/**
 * Resolve and activate the terminal host for this process.
 *
 * Called once from runTuiApp; paired with releaseTerminalHost() on exit.
 * Returns the host (or null when we aren't inside a recognised one) so the
 * caller can log which integration is live.
 */
export function initTerminalHost(
  env: NodeJS.ProcessEnv = process.env,
): TerminalHost | null {
  for (const candidate of CANDIDATES) {
    let detected = false;
    try {
      detected = candidate.detect(env);
    } catch {
      // A candidate that throws while probing is simply not a match. It
      // must not be able to prevent later candidates from being tried.
      continue;
    }
    if (detected) {
      try {
        active = candidate.create();
      } catch {
        active = null;
      }
      return active;
    }
  }
  active = null;
  return null;
}

/** The active host, or null. Cheap; safe to call per frame. */
export function terminalHost(): TerminalHost | null {
  return active;
}

/**
 * Install a host directly, bypassing detection.
 *
 * For a config-supplied adapter module (explicit config beats detection) and
 * for tests.
 */
export function setTerminalHost(host: TerminalHost | null): void {
  active = host;
}

export function __resetTerminalHostForTests(): void {
  active = null;
}
