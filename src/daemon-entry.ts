#!/usr/bin/env node
// Standalone daemon binary. Spawned detached by `hydra daemon start`
// (see spawnDaemonDetached in core/daemon-bootstrap.ts). Kept separate
// from cli.js so the resident daemon process doesn't parse-and-hold
// the TUI / CLI-verb / shim code it will never execute.
//
// `hydra daemon start --foreground` still runs the daemon in-process
// via runDaemonStart for dev ergonomics; this entry is only used for
// the detached-spawn path that end users hit.
import { loadConfig } from "./core/config.js";
import { ensureServiceToken } from "./core/service-token.js";
import { startDaemon } from "./daemon/server.js";

async function main(): Promise<void> {
  process.title = "hydra-acp-daemon";
  const { installGlobalTlsTrust } = await import("./core/tls-trust.js");
  installGlobalTlsTrust();
  const config = await loadConfig();
  const serviceToken = await ensureServiceToken();
  const handle = await startDaemon(config, serviceToken);
  process.stdout.write(
    `hydra-acp daemon listening on ${config.daemon.host}:${config.daemon.port}\n`,
  );

  const SHUTDOWN_HARD_TIMEOUT_MS = 10_000;
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      process.stderr.write("Second signal received; exiting immediately.\n");
      process.exit(1);
    }
    shuttingDown = true;
    process.stdout.write("Shutting down...\n");
    const killer = setTimeout(() => {
      process.stderr.write(
        `Graceful shutdown did not complete within ${SHUTDOWN_HARD_TIMEOUT_MS}ms; forcing exit.\n`,
      );
      process.exit(1);
    }, SHUTDOWN_HARD_TIMEOUT_MS);
    killer.unref();
    try {
      await handle.shutdown();
    } catch (err) {
      process.stderr.write(
        `shutdown failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    clearTimeout(killer);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  // Ignore SIGHUP so terminal-window close doesn't orphan agents.
  process.on("SIGHUP", () => undefined);
}

main().catch((err) => {
  process.stderr.write(
    `hydra-acp-daemon: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
