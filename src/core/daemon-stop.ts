// Stopping the daemon process, per platform.
//
// On POSIX a SIGTERM runs the daemon's graceful shutdown (close sessions,
// flush history, remove the pidfile, stop agents). On Windows Node turns
// process.kill(pid, "SIGTERM") into an immediate TerminateProcess, so none of
// that ran: sessions were not closed, history and meta writes were not
// flushed, and the pidfile was left behind. There the daemon is asked to stop
// through its API instead, and only force-killed (with taskkill /T, which also
// takes any agent processes) when it will not, or cannot, do it itself, for
// example a daemon from before the endpoint existed.

import { spawnSync } from "node:child_process";
import { unlinkSync } from "node:fs";
import { setTimeout as sleepMs } from "node:timers/promises";

import { isProcessAlive, readDaemonPidFile } from "./daemon-pidfile.js";
import { paths } from "./paths.js";
import { readServiceToken } from "./service-token.js";

export type ShutdownRequest = "accepted" | "refused" | "unreachable";

export interface StopDeps {
  platform?: NodeJS.Platform;
  // Ask the daemon, through its API, to shut itself down.
  requestShutdown: () => Promise<ShutdownRequest>;
  isAlive: (pid: number) => boolean;
  // POSIX: deliver SIGTERM.
  signal: (pid: number) => void;
  // Windows: end the process and everything it started.
  killTree: (pid: number) => void;
  sleep: (ms: number) => Promise<void>;
  // How long a daemon that accepted the request gets to exit. The daemon
  // force-exits at 10s on its own, so this only needs to be a little longer.
  gracefulWaitMs?: number;
}

export type StopOutcome =
  // Windows: it accepted the request and exited.
  | { how: "graceful" }
  // POSIX: SIGTERM was sent. The daemon is shutting down but may not have
  // exited yet; the caller decides whether to wait.
  | { how: "signalled" }
  // Windows: it was terminated, with its agents.
  | { how: "forced"; reason: "refused" | "unreachable" | "timeout" };

export async function stopDaemonProcess(
  pid: number,
  deps: StopDeps,
): Promise<StopOutcome> {
  const platform = deps.platform ?? process.platform;
  if (platform !== "win32") {
    deps.signal(pid);
    return { how: "signalled" };
  }
  const answer = await deps.requestShutdown();
  if (answer === "accepted") {
    const deadline = Date.now() + (deps.gracefulWaitMs ?? 15_000);
    while (Date.now() < deadline) {
      if (!deps.isAlive(pid)) {
        return { how: "graceful" };
      }
      await deps.sleep(100);
    }
    deps.killTree(pid);
    return { how: "forced", reason: "timeout" };
  }
  deps.killTree(pid);
  return { how: "forced", reason: answer };
}

// POST /v1/daemon/shutdown on the daemon's loopback listener, with the
// service token. "refused" covers every HTTP answer other than 202: a daemon
// that predates the route (404), a different token (401/403), or one that
// cannot stop itself (501).
export async function requestDaemonShutdown(
  timeoutMs = 2_000,
): Promise<ShutdownRequest> {
  const info = await readDaemonPidFile();
  if (!info) {
    return "unreachable";
  }
  let token: string | undefined;
  try {
    token = await readServiceToken();
  } catch {
    token = undefined;
  }
  if (!token) {
    return "refused";
  }
  try {
    const response = await fetch(
      `http://127.0.0.1:${info.loopbackPort}/v1/daemon/shutdown`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, Connection: "close" },
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    return response.status === 202 ? "accepted" : "refused";
  } catch {
    return "unreachable";
  }
}

export function killProcessTree(pid: number): void {
  const result = spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
    stdio: "ignore",
    windowsHide: true,
  });
  if (result.error) {
    throw result.error;
  }
  // A killed daemon never removed its own pidfile, which would leave
  // `daemon status` reporting a stale one. Only once the process is gone,
  // so a failed kill does not hide a daemon that is still running.
  if (!isProcessAlive(pid)) {
    try {
      unlinkSync(paths.pidFile());
    } catch {
      void 0;
    }
  }
}

export function realStopDeps(): StopDeps {
  return {
    requestShutdown: () => requestDaemonShutdown(),
    isAlive: isProcessAlive,
    signal: (pid) => process.kill(pid, "SIGTERM"),
    killTree: killProcessTree,
    sleep: (ms) => sleepMs(ms),
  };
}
