import * as fsp from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import chalk from "chalk";
import { paths } from "../../core/paths.js";
import { loadConfig } from "../../core/config.js";
import { ensureServiceToken } from "../../core/service-token.js";
import { startDaemon } from "../../daemon/server.js";
import {
  pingHealth,
  spawnDaemonDetached,
  waitForDaemonReady,
} from "../../core/daemon-bootstrap.js";
import { HYDRA_VERSION } from "../../core/hydra-version.js";
import type { HydraConfig } from "../../core/config.js";
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
    // Rename here so `killall hydra-daemon` finds the real daemon and
    // `killall hydra-tui` leaves it alone.
    process.title = "hydra-daemon";
    const handle = await startDaemon(config, serviceToken);
    process.stdout.write(
      `hydra-acp daemon listening on ${config.daemon.host}:${config.daemon.port}\n`,
    );

    const shutdown = async (): Promise<void> => {
      process.stdout.write("Shutting down...\n");
      await handle.shutdown();
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

  let daemonVersion: string | undefined;
  if (alive) {
    try {
      const config = await loadConfig();
      daemonVersion = await fetchDaemonVersion(config);
    } catch {
      void 0;
    }
  }

  if (daemonVersion === undefined) {
    process.stdout.write(`CLI version: ${HYDRA_VERSION}\n`);
    if (alive) {
      process.stdout.write(
        "Daemon version: unknown (health endpoint unreachable)\n",
      );
    }
    return;
  }

  if (daemonVersion === HYDRA_VERSION) {
    process.stdout.write(`Version: ${HYDRA_VERSION}\n`);
    return;
  }

  process.stdout.write(`CLI version:    ${HYDRA_VERSION}\n`);
  process.stdout.write(`Daemon version: ${daemonVersion}\n`);
  process.stdout.write(
    chalk.yellow(
      "Version mismatch — run `hydra-acp daemon restart` to upgrade the daemon.\n",
    ),
  );
}

async function fetchDaemonVersion(
  config: HydraConfig,
): Promise<string | undefined> {
  const protocol = config.daemon.tls ? "https" : "http";
  const url = `${protocol}://${config.daemon.host}:${config.daemon.port}/v1/health`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
    if (!response.ok) {
      return undefined;
    }
    const body = (await response.json()) as { version?: unknown };
    return typeof body.version === "string" ? body.version : undefined;
  } catch {
    return undefined;
  }
}

interface PidInfo {
  pid: number;
  host: string;
  port: number;
  startedAt: string;
}

async function readPidFile(): Promise<PidInfo | undefined> {
  try {
    const raw = await fsp.readFile(paths.pidFile(), "utf8");
    return JSON.parse(raw) as PidInfo;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
