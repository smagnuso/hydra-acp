import { setTimeout as sleep } from "node:timers/promises";
import chalk from "chalk";
import { paths } from "../../core/paths.js";
import {
  isProcessAlive,
  readDaemonPidFile,
  type DaemonPidInfo,
} from "../../core/daemon-pidfile.js";
import { loadConfig } from "../../core/config.js";
import { ensureServiceToken } from "../../core/service-token.js";
import { startDaemon } from "../../daemon/server.js";
import {
  fetchDaemonHealth,
  pingHealth,
  spawnDaemonDetached,
  waitForDaemonReady,
} from "../../core/daemon-bootstrap.js";
import { HYDRA_VERSION } from "../../core/hydra-version.js";
import { computeConfigDigest } from "../../core/config-digest.js";
import { flagBool } from "../parse-args.js";
import { runLogTail } from "./log-tail.js";

export async function runDaemonStart(
  flags: Record<string, string | boolean> = {},
): Promise<void> {
  const config = await loadConfig();
  const serviceToken = await ensureServiceToken();
  if (await pingHealth(config)) {
    const info = await readPidFile();
    process.stdout.write(
      `Daemon already running${info ? ` (pid ${info.pid})` : ""}. Run \`hydra-acp daemon restart\` to restart it.\n`,
    );
    return;
  }

  if (flagBool(flags, "foreground")) {
    // Only the foreground branch becomes the long-lived daemon — the
    // non-foreground branch is a transient parent that spawns a
    // detached child which re-enters this function with --foreground.
    // Rename here so `killall hydra-acp-daemon` finds the real daemon and
    // `killall hydra-tui` leaves it alone.
    process.title = "hydra-acp-daemon";
    const handle = await startDaemon(config, serviceToken);
    process.stdout.write(
      `hydra-acp daemon listening on ${config.daemon.host}:${config.daemon.port}\n`,
    );

    const SHUTDOWN_HARD_TIMEOUT_MS = 10_000;
    let shuttingDown = false;
    const shutdown = async (): Promise<void> => {
      // Second SIGTERM/SIGINT while a graceful shutdown is in flight
      // means the operator gave up waiting — exit immediately so they
      // can recover without resorting to SIGKILL.
      if (shuttingDown) {
        process.stderr.write("Second signal received; exiting immediately.\n");
        process.exit(1);
      }
      shuttingDown = true;
      process.stdout.write("Shutting down...\n");
      // Safety net: if a shutdown step hangs (extension child ignoring
      // SIGTERM, lingering WebSocket keeping app.close() pending, etc.)
      // force-exit so `hydra daemon restart` doesn't strand the
      // operator with a half-dead daemon.
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
    // Ignore SIGHUP — the daemon must survive terminal closes. Terminal
    // emulators (e.g. iTerm2) send SIGHUP to all descendant processes when
    // a window closes, even across session boundaries; Node.js's default
    // SIGHUP action is to terminate, which would orphan every live agent.
    process.on("SIGHUP", () => undefined);
    return;
  }

  spawnDaemonDetached();
  await waitForDaemonReady(config);
  const info = await readPidFile();
  process.stdout.write(
    `Daemon started on ${config.daemon.host}:${config.daemon.port}` +
      (info ? ` pid=${info.pid}` : "") +
      "\n",
  );
}

export async function runDaemonStop(): Promise<void> {
  const info = await readPidFile();
  if (!info) {
    process.stdout.write("No running daemon found.\n");
    return;
  }
  try {
    process.kill(info.pid, "SIGTERM");
    process.stdout.write(`Sent SIGTERM to daemon pid ${info.pid}\n`);
  } catch (err) {
    process.stderr.write(`Failed to signal daemon: ${(err as Error).message}\n`);
  }
}

export async function runDaemonRestart(): Promise<void> {
  const config = await loadConfig();
  await ensureServiceToken();
  const info = await readPidFile();
  if (info && isProcessAlive(info.pid)) {
    process.stdout.write(`Stopping daemon pid ${info.pid}...\n`);
    try {
      process.kill(info.pid, "SIGTERM");
    } catch (err) {
      process.stderr.write(
        `Failed to signal daemon: ${(err as Error).message}\n`,
      );
      process.exit(1);
    }
    if (!(await waitForExit(info.pid))) {
      process.stderr.write(
        `Daemon pid ${info.pid} did not exit after SIGTERM; aborting restart.\n`,
      );
      process.exit(1);
    }
  } else {
    process.stdout.write("No running daemon found; starting a fresh one.\n");
  }
  spawnDaemonDetached();
  await waitForDaemonReady(config);
  if (await pingHealth(config)) {
    const fresh = await readPidFile();
    process.stdout.write(
      `Daemon restarted on ${config.daemon.host}:${config.daemon.port}` +
        (fresh ? ` pid=${fresh.pid}` : "") +
        "\n",
    );
  }
}

async function waitForExit(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await sleep(50);
  }
  return false;
}

export async function runDaemonLogs(argv: string[]): Promise<void> {
  await runLogTail(
    paths.currentLogFile(),
    argv,
    "No daemon log file (daemon never ran?)",
  );
}

export async function runDaemonStatus(): Promise<void> {
  const info = await readPidFile();
  if (!info) {
    process.stdout.write("Daemon: not running\n");
    process.stdout.write(`CLI version: ${HYDRA_VERSION}\n`);
    return;
  }
  const alive = isProcessAlive(info.pid);
  process.stdout.write(
    `Daemon: ${alive ? "running" : "stale pid file"} pid=${info.pid} ` +
      `host=${info.host} port=${info.port} started=${info.startedAt}\n`,
  );

  let health: Awaited<ReturnType<typeof fetchDaemonHealth>>;
  let localDigest: string | undefined;
  if (alive) {
    try {
      const config = await loadConfig();
      health = await fetchDaemonHealth(config);
      localDigest = computeConfigDigest(config);
    } catch {
      void 0;
    }
  }

  if (!health || health.version === undefined) {
    process.stdout.write(`CLI version: ${HYDRA_VERSION}\n`);
    if (alive) {
      process.stdout.write(
        "Daemon version: unknown (health endpoint unreachable)\n",
      );
    }
    return;
  }

  const versionMatch = health.version === HYDRA_VERSION;
  const configMatch =
    health.configDigest !== undefined &&
    localDigest !== undefined &&
    health.configDigest === localDigest;

  if (versionMatch && configMatch) {
    process.stdout.write(`Version: ${HYDRA_VERSION}\n`);
    return;
  }

  process.stdout.write(`CLI version:    ${HYDRA_VERSION}\n`);
  process.stdout.write(`Daemon version: ${health.version}\n`);
  if (!versionMatch) {
    process.stdout.write(
      chalk.yellow(
        "Version mismatch — run `hydra-acp daemon restart` to upgrade the daemon.\n",
      ),
    );
  }
  if (versionMatch && !configMatch) {
    process.stdout.write(
      chalk.yellow(
        "Config changed since daemon started — run `hydra-acp daemon restart` to apply.\n",
      ),
    );
  }
}

type PidInfo = DaemonPidInfo;

async function readPidFile(): Promise<PidInfo | undefined> {
  return readDaemonPidFile();
}
