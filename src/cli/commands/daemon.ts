import * as fsp from "node:fs/promises";
import { paths } from "../../core/paths.js";
import { loadConfig } from "../../core/config.js";
import { startDaemon } from "../../daemon/server.js";

export async function runDaemonStart(): Promise<void> {
  const config = await loadConfig();
  const handle = await startDaemon(config);
  process.stdout.write(
    `acp-hydra daemon listening on ${config.daemon.host}:${config.daemon.port}\n`,
  );

  const shutdown = async (): Promise<void> => {
    process.stdout.write("Shutting down...\n");
    await handle.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
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

export async function runDaemonStatus(): Promise<void> {
  const info = await readPidFile();
  if (!info) {
    process.stdout.write("Daemon: not running\n");
    return;
  }
  const alive = isProcessAlive(info.pid);
  process.stdout.write(
    `Daemon: ${alive ? "running" : "stale pid file"} pid=${info.pid} ` +
      `host=${info.host} port=${info.port} started=${info.startedAt}\n`,
  );
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
