// Runs a child process in the foreground, with the terminal handed over to
// it: suspend the caller's screen, let the child own the tty, restore the
// screen when it exits.
//
// This is the path a $EDITOR-shaped editor needs. The detached
// stdio-ignored spawn used for GUI editors gives a terminal editor
// /dev/null on all three fds, so it draws nothing and dies.

import type { ChildProcess, SpawnOptions } from "node:child_process";
import { CLEAR_SCREEN_HOME } from "./ansi.js";

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface ForegroundSpec {
  program: string;
  args: readonly string[];
  cwd?: string;
  // One-line notice printed on the cleared screen before the child starts,
  // so a slow-launching editor doesn't look like a hang. Include the
  // trailing newline.
  banner?: string;
}

export interface ForegroundDeps {
  // Tear the caller's screen down: leave the alt screen, release the input
  // grab, restore cooked mode. Screen.stop() does all three.
  suspend: () => void;
  // Re-enter and repaint from model state. Screen.start().
  resume: () => void;
  // Surfaced after resume, so it lands on a live screen.
  notify?: (message: string) => void;
  spawn?: SpawnFn;
  write?: (text: string) => void;
}

export interface ForegroundOutcome {
  exitCode: number | null;
  error?: Error;
}

// SIGQUIT has no meaning on Windows, and process.on() for it would just
// never fire; SIGINT is emulated there and does.
const PARKED_SIGNALS: NodeJS.Signals[] =
  process.platform === "win32" ? ["SIGINT"] : ["SIGINT", "SIGQUIT"];

// The child stays in our process group — it has to, since a process in a
// background group that reads the tty gets SIGTTIN'd to a stop — so ^C
// inside the editor delivers SIGINT to us as well, where the TUI's own
// handler would cancel the turn or exit out from under the editor. Park
// every listener for the duration and install a no-op in its place: with
// zero listeners node applies the default action and the process dies,
// which is the failure being avoided.
//
// SIGTSTP is deliberately not parked. ^Z in the editor should stop the
// whole job, and the `fg` that follows resumes the editor, not us.
function parkSignals(): () => void {
  const parked = PARKED_SIGNALS.map((signal) => {
    const listeners = process.listeners(signal) as NodeJS.SignalsListener[];
    for (const listener of listeners) {
      process.off(signal, listener);
    }
    const noop = (): void => undefined;
    process.on(signal, noop);
    return { signal, listeners, noop };
  });
  return () => {
    for (const { signal, listeners, noop } of parked) {
      process.off(signal, noop);
      for (const listener of listeners) {
        process.on(signal, listener);
      }
    }
  };
}

// Never rejects: a spawn failure resolves with `error` set, having already
// restored the screen. Because this awaits the child, a nonzero exit is
// reportable — the detached path structurally cannot see one.
export async function runForegroundChild(
  spec: ForegroundSpec,
  deps: ForegroundDeps,
): Promise<ForegroundOutcome> {
  const spawnFn =
    deps.spawn ?? ((await import("node:child_process")).spawn as SpawnFn);
  const write = deps.write ?? ((text: string) => void process.stdout.write(text));
  const unpark = parkSignals();
  deps.suspend();
  write(CLEAR_SCREEN_HOME);
  if (spec.banner !== undefined) {
    write(spec.banner);
  }
  return await new Promise<ForegroundOutcome>((resolve) => {
    let settled = false;
    const settle = (outcome: ForegroundOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        deps.resume();
      } finally {
        unpark();
      }
      if (outcome.error) {
        deps.notify?.(`${spec.program} failed: ${outcome.error.message}`);
      } else if (outcome.exitCode !== null && outcome.exitCode !== 0) {
        deps.notify?.(`${spec.program} exited ${outcome.exitCode}`);
      }
      resolve(outcome);
    };
    try {
      const child = spawnFn(spec.program, spec.args, {
        stdio: "inherit",
        cwd: spec.cwd,
      });
      child.on("exit", (code) => settle({ exitCode: code }));
      child.on("error", (err) => settle({ exitCode: null, error: err }));
    } catch (err) {
      settle({ exitCode: null, error: err as Error });
    }
  });
}
