import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import type { HydraConfig } from "./config.js";

export async function ensureDaemonReachable(config: HydraConfig): Promise<void> {
  if (await pingHealth(config)) {
    return;
  }
  process.stderr.write("hydra-acp: daemon not running; starting it...\n");
  spawnDaemonDetached();
  await waitForDaemonReady(config);
}

export async function pingHealth(config: HydraConfig): Promise<boolean> {
  const protocol = config.daemon.tls ? "https" : "http";
  const url = `${protocol}://${config.daemon.host}:${config.daemon.port}/v1/health`;
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function spawnDaemonDetached(): void {
  const cliPath = process.argv[1];
  if (!cliPath) {
    throw new Error("Cannot determine hydra-acp binary path to spawn daemon");
  }
  const child = spawn(process.execPath, [cliPath, "daemon", "start"], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
}

export async function waitForDaemonReady(
  config: HydraConfig,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pingHealth(config)) {
      return;
    }
    await sleep(150);
  }
  throw new Error(
    `hydra-acp daemon did not become ready within ${timeoutMs}ms`,
  );
}
