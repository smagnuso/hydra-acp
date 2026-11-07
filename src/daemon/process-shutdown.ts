// The daemon process's exit sequence, shared by the detached entry
// (daemon-entry.ts) and `hydra daemon start --foreground`, which used to carry
// one copy each. Both reach it from a signal or, since Windows has no usable
// SIGTERM, from POST /v1/daemon/shutdown.

import type { DaemonHandle } from "./server.js";

const SHUTDOWN_HARD_TIMEOUT_MS = 10_000;

export interface ProcessShutdownDeps {
  exit: (code: number) => never;
  out: (text: string) => void;
  err: (text: string) => void;
  hardTimeoutMs?: number;
}

const realDeps: ProcessShutdownDeps = {
  exit: (code) => process.exit(code),
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

let shuttingDown = false;

// For tests: shutdownDaemonProcess keeps its in-progress flag at module scope,
// as a signal handler has no other place to put it.
export function resetProcessShutdownForTests(): void {
  shuttingDown = false;
}

export async function shutdownDaemonProcess(
  handle: Pick<DaemonHandle, "shutdown">,
  deps: ProcessShutdownDeps = realDeps,
): Promise<void> {
  // A second request while a graceful shutdown is in flight means the
  // operator gave up waiting: exit now so they can recover without SIGKILL.
  if (shuttingDown) {
    deps.err("Second signal received; exiting immediately.\n");
    deps.exit(1);
  }
  shuttingDown = true;
  deps.out("Shutting down...\n");
  // If a step hangs (an extension child ignoring SIGTERM, a lingering
  // WebSocket keeping app.close() pending) force-exit so a restart does not
  // strand the operator with a half-dead daemon.
  const limit = deps.hardTimeoutMs ?? SHUTDOWN_HARD_TIMEOUT_MS;
  const killer = setTimeout(() => {
    deps.err(`Graceful shutdown did not complete within ${limit}ms; forcing exit.\n`);
    deps.exit(1);
  }, limit);
  killer.unref();
  try {
    await handle.shutdown();
  } catch (err) {
    deps.err(`shutdown failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }
  clearTimeout(killer);
  deps.exit(0);
}
