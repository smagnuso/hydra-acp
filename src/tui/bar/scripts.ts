// `script` slot entries (see BarSlotEntry in core/config.ts) run a shell
// command on a timer and cache its stdout for the render path to read
// synchronously — resolveSide() never spawns anything itself.

import { exec } from "node:child_process";
import type { BarSideConfig } from "../../core/config.js";
import type { BarLayoutConfig } from "./types.js";

const EXEC_TIMEOUT_MS = 3_000;
const EXEC_MAX_BUFFER = 64 * 1024;

/**
 * Walk every side of an (already `"..."`-expanded) bar config and collect
 * each distinct `script` command to its effective refresh interval: the
 * entry's own `refreshMs` if set, else `defaultRefreshMs`. A command that
 * appears more than once — same command, possibly different regions or
 * different `refreshMs` — collapses to one entry, keyed by the literal
 * command string, using the minimum of any conflicting `refreshMs` values
 * so the most demanding region is never starved.
 */
export function collectScriptCommands(
  cfg: BarLayoutConfig,
  defaultRefreshMs: number,
): Map<string, number> {
  const out = new Map<string, number>();
  const visitSide = (side: BarSideConfig): void => {
    for (const entry of side) {
      if (typeof entry === "string" || entry.script === undefined) {
        continue;
      }
      const refreshMs = entry.refreshMs ?? defaultRefreshMs;
      const existing = out.get(entry.script);
      out.set(
        entry.script,
        existing === undefined ? refreshMs : Math.min(existing, refreshMs),
      );
    }
  };
  visitSide(cfg.composer.top.left);
  visitSide(cfg.composer.top.right);
  visitSide(cfg.composer.bottom.left);
  visitSide(cfg.composer.bottom.right);
  visitSide(cfg.sessionbar.left);
  visitSide(cfg.sessionbar.right);
  return out;
}

// Collapses a command's stdout to one line so it fits the single terminal
// row a slot occupies, rather than silently dropping everything past the
// first line. A future caller that wants "first line only" instead should
// change this, not add a config knob for it.
function sanitize(stdout: string): string | null {
  const collapsed = stdout.trim().replace(/\s+/g, " ");
  return collapsed.length === 0 ? null : collapsed;
}

export interface ScriptRunner {
  /**
   * Fire any due, not-already-running command in `commands`. Safe to call
   * every tick regardless of tick granularity: a command is only spawned
   * once its own `refreshMs` has elapsed since its last spawn.
   */
  poll(commands: ReadonlyMap<string, number>, now: number): void;
}

/**
 * Stateful runner: tracks in-flight commands and their last spawn time so
 * a slow command is never run twice concurrently, and a fast tick cadence
 * doesn't re-spawn a command before its own interval is up.
 */
export function createScriptRunner(opts: {
  cwd: () => string | null;
  onOutput: (command: string, output: string | null) => void;
}): ScriptRunner {
  const inFlight = new Set<string>();
  const lastRun = new Map<string, number>();

  const run = (command: string): void => {
    inFlight.add(command);
    exec(
      command,
      {
        cwd: opts.cwd() ?? undefined,
        timeout: EXEC_TIMEOUT_MS,
        maxBuffer: EXEC_MAX_BUFFER,
      },
      (err, stdout) => {
        inFlight.delete(command);
        opts.onOutput(command, err ? null : sanitize(stdout));
      },
    );
  };

  return {
    poll(commands, now) {
      for (const [command, refreshMs] of commands) {
        if (inFlight.has(command)) {
          continue;
        }
        const last = lastRun.get(command);
        if (last !== undefined && now - last < refreshMs) {
          continue;
        }
        lastRun.set(command, now);
        run(command);
      }
    },
  };
}
