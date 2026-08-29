// Shared exec-poll-cache primitive: run a shell command on a timer and hand
// its raw stdout to a callback, deduped by command string so a slow command
// never runs twice concurrently and a fast tick cadence doesn't re-spawn one
// before its own interval is up. Composer-bar script slots (bar/scripts.ts)
// squash output to a single line; a future sidebar process gadget would
// reuse this with a multi-line-preserving `sanitize`.

import { exec } from "node:child_process";

const EXEC_TIMEOUT_MS = 3_000;
const EXEC_MAX_BUFFER = 64 * 1024;

export interface ProcessRunner {
  /**
   * Fire any due, not-already-running command in `commands`. Safe to call
   * every tick regardless of tick granularity: a command is only spawned
   * once its own refresh interval has elapsed since its last spawn.
   */
  poll(commands: ReadonlyMap<string, number>, now: number): void;
}

export function createProcessRunner(opts: {
  cwd: () => string | null;
  // Extra env vars for a given command's subprocess (e.g. a scoped daemon
  // token), merged over the inherited environment. Omit for the default
  // "just inherit process.env" behavior.
  envFor?: (command: string) => Record<string, string> | undefined;
  sanitize: (stdout: string) => string | null;
  onOutput: (command: string, output: string | null) => void;
}): ProcessRunner {
  const inFlight = new Set<string>();
  const lastRun = new Map<string, number>();

  const run = (command: string): void => {
    inFlight.add(command);
    const extraEnv = opts.envFor?.(command);
    exec(
      command,
      {
        cwd: opts.cwd() ?? undefined,
        timeout: EXEC_TIMEOUT_MS,
        maxBuffer: EXEC_MAX_BUFFER,
        env: extraEnv ? { ...process.env, ...extraEnv } : undefined,
      },
      (err, stdout) => {
        inFlight.delete(command);
        opts.onOutput(command, err ? null : opts.sanitize(stdout));
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
