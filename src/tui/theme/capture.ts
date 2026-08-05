// Test-only helper: a real terminal-kit instance whose output is captured
// into a string instead of going to a tty.
//
// The Proxy mock in screen.test.ts swallows every style call, so it cannot
// see colour at all. The theme work needs the opposite: the exact bytes
// terminal-kit emits, including its capability-dependent choices (24-bit vs
// 256-colour grayscale). So we drive the genuine library against a fake
// stdout.
//
// `generic` selects the termconfig, which is what decides colour depth —
// pass "xterm-256color" or "xterm-truecolor" to exercise both branches.

import termkit from "terminal-kit";
import type { Terminal } from "terminal-kit";

export interface CapturingTerminal {
  term: Terminal;
  /** Bytes written since the last `take()`. */
  take: () => string;
}

// terminal-kit registers process exit listeners per instance, so a test that
// builds one per case trips MaxListenersExceededWarning. Instances are
// stateless for our purposes (we only ever ask them to write styled text), so
// share one per termconfig.
const cache = new Map<string, CapturingTerminal>();

export function createCapturingTerminal(
  generic: string = "xterm-256color",
): CapturingTerminal {
  const hit = cache.get(generic);
  if (hit) {
    hit.take();
    return hit;
  }
  const made = buildCapturingTerminal(generic);
  cache.set(generic, made);
  return made;
}

function buildCapturingTerminal(generic: string): CapturingTerminal {
  let buf = "";
  const stdout = {
    write: (s: string) => {
      buf += s;
      return true;
    },
    on: () => undefined,
    once: () => undefined,
    removeListener: () => undefined,
    emit: () => undefined,
    columns: 80,
    rows: 24,
    isTTY: true,
    // terminal-kit's asyncCleanup pokes _writableState on exit; give it
    // something so a captured run doesn't crash the process at teardown.
    _writableState: { needDrain: false },
  };
  const term = (
    termkit as unknown as {
      createTerminal: (opts: Record<string, unknown>) => Terminal;
    }
  ).createTerminal({
    stdin: process.stdin,
    stdout,
    generic,
    appId: "hydra-test",
    appName: "hydra-test",
    isTTY: true,
    isSSH: false,
    processSigwinch: false,
    preferProcessSigwinch: false,
  });
  return {
    term,
    take: () => {
      const out = buf;
      buf = "";
      return out;
    },
  };
}

/** Render escapes readable in snapshots: ESC[1m instead of a raw \x1b. */
export function visible(s: string): string {
  return s.replace(/\x1b/g, "ESC");
}
