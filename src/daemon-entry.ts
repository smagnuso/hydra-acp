#!/usr/bin/env node
// Standalone daemon binary. Spawned detached by `hydra daemon start`
// (see spawnDaemonDetached in core/daemon-bootstrap.ts). Kept separate
// from cli.js so the resident daemon process doesn't parse-and-hold
// the TUI / CLI-verb / shim code it will never execute.
//
// `hydra daemon start --foreground` still runs the daemon in-process
// via runDaemonStart for dev ergonomics; this entry is only used for
// the detached-spawn path that end users hit.
import { loadGlobalConfig } from "./core/config.js";
import { recordDaemonBootFailure } from "./core/daemon-boot-log.js";
import { ensureServiceToken } from "./core/service-token.js";
import { shutdownDaemonProcess } from "./daemon/process-shutdown.js";
import { startDaemon, type DaemonHandle } from "./daemon/server.js";

async function main(): Promise<void> {
  process.title = "hydra-acp-daemon";
  const { installGlobalTlsTrust } = await import("./core/tls-trust.js");
  installGlobalTlsTrust();
  // Global, never a directory overlay: the daemon outlives the cwd it was
  // launched from. HYDRA_ACP_HOME still applies (it's inherited through
  // spawnDaemonDetached's scrubInheritedEnv), so a `home` set by a
  // directory config does re-root this process — that's the one knob
  // meant to cross the boundary.
  const config = await loadGlobalConfig();
  const serviceToken = await ensureServiceToken();
  // The API route and the signals both reach the same exit sequence. The
  // handle exists only once startDaemon returns, so the route reaches it
  // through this slot.
  let handle: DaemonHandle | undefined;
  const stop = (): void => {
    if (handle) {
      void shutdownDaemonProcess(handle);
    }
  };
  handle = await startDaemon(config, serviceToken, { requestShutdown: stop });
  process.stdout.write(
    `hydra-acp daemon listening on ${config.daemon.host}:${config.daemon.port}\n`,
  );

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  // Ignore SIGHUP so terminal-window close doesn't orphan agents.
  process.on("SIGHUP", () => undefined);
}

main().catch((err) => {
  const detail =
    err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`hydra-acp-daemon: ${detail}\n`);
  // Under spawnDaemonDetached that stderr write goes nowhere, so persist
  // the reason before exiting; waitForDaemonReady reads it back rather
  // than reporting a bare readiness timeout.
  void recordDaemonBootFailure(detail)
    .catch(() => undefined)
    .finally(() => process.exit(1));
});
