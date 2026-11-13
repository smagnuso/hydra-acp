import { setTimeout as sleep } from "node:timers/promises";
import { styled } from "../../tui/theme/index.js";
import { depthForStream } from "../../tui/theme/capability.js";
import { paths } from "../../core/paths.js";
import {
  isProcessAlive,
  readDaemonPidFile,
  type DaemonPidInfo,
} from "../../core/daemon-pidfile.js";
import { loadConfig, loadGlobalConfig } from "../../core/config.js";
import { ensureServiceToken } from "../../core/service-token.js";
import { shutdownDaemonProcess } from "../../daemon/process-shutdown.js";
import { startDaemon, type DaemonHandle } from "../../daemon/server.js";
import {
  realStopDeps,
  stopDaemonProcess,
  type StopOutcome,
} from "../../core/daemon-stop.js";
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
  // Global, not the client's directory overlay: the --foreground branch
  // below BECOMES the long-lived daemon in this process, and a daemon
  // configured from whatever directory it happened to be started in would
  // behave differently from a detached one. A `home` from a directory
  // config still applies, via HYDRA_ACP_HOME.
  const config = await loadGlobalConfig();
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
    // The handle exists only once startDaemon returns, so the API route
    // reaches the exit sequence through this slot.
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
    // Ignore SIGHUP — the daemon must survive terminal closes. Terminal
    // emulators (e.g. iTerm2) send SIGHUP to all descendant processes when
    // a window closes, even across session boundaries; Node.js's default
    // SIGHUP action is to terminate, which would orphan every live agent.
    process.on("SIGHUP", () => undefined);
    return;
  }

  spawnDaemonDetached(config);
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
    const outcome = await stopDaemonProcess(info.pid, realStopDeps());
    process.stdout.write(`${describeStop(info.pid, outcome)}\n`);
  } catch (err) {
    process.stderr.write(`Failed to signal daemon: ${(err as Error).message}\n`);
  }
}

function describeStop(pid: number, outcome: StopOutcome): string {
  switch (outcome.how) {
    case "signalled":
      return `Sent SIGTERM to daemon pid ${pid}`;
    case "graceful":
      return `Stopped daemon pid ${pid}`;
    case "forced":
      return outcome.reason === "timeout"
        ? `Daemon pid ${pid} did not exit when asked; terminated it and its agents`
        : `Terminated daemon pid ${pid} and its agents (it could not be asked to shut down cleanly)`;
  }
}

export async function runDaemonRestart(): Promise<void> {
  const config = await loadConfig();
  await ensureServiceToken();
  const info = await readPidFile();
  if (info && isProcessAlive(info.pid)) {
    process.stdout.write(`Stopping daemon pid ${info.pid}...\n`);
    let outcome: StopOutcome;
    try {
      outcome = await stopDaemonProcess(info.pid, realStopDeps());
    } catch (err) {
      process.stderr.write(
        `Failed to signal daemon: ${(err as Error).message}\n`,
      );
      process.exit(1);
    }
    if (outcome.how !== "graceful" && !(await waitForExit(info.pid))) {
      process.stderr.write(
        `Daemon pid ${info.pid} did not exit within 15s of SIGTERM; aborting restart. See \`hydra daemon logs\`.\n`,
      );
      process.exit(1);
    }
  } else {
    process.stdout.write("No running daemon found; starting a fresh one.\n");
  }
  spawnDaemonDetached(config);
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

// Longer than the daemon's own 10s hard-exit so a slow but healthy shutdown is not mistaken for a hang.
async function waitForExit(pid: number, timeoutMs = 15_000): Promise<boolean> {
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

  // Tier-"warn" keys the daemon snapshotted at boot and can't re-read.
  // Distinct from a digest mismatch, which now means only that the daemon
  // is BOUND differently than config.json describes. Drift is advisory:
  // the daemon is healthy and everything else already re-read itself.
  const drifted = health.driftedKeys ?? [];

  if (versionMatch && configMatch && drifted.length === 0) {
    process.stdout.write(`Version: ${HYDRA_VERSION}\n`);
    return;
  }

  process.stdout.write(`CLI version:    ${HYDRA_VERSION}\n`);
  process.stdout.write(`Daemon version: ${health.version}\n`);
  // `cli-warn` is the same token app.ts uses for the identical warning on
  // stderr. Depth comes from the stream: this output is routinely piped, and
  // "none" resolves the token to nothing rather than needing a branch here.
  const depth = depthForStream(process.stdout);
  const warn = (msg: string): string => styled("cli-warn", msg, depth);
  if (!versionMatch) {
    process.stdout.write(
      warn(
        "Version mismatch — run `hydra-acp daemon restart` to upgrade the daemon.\n",
      ),
    );
  }
  if (versionMatch && !configMatch) {
    process.stdout.write(
      warn(
        "Daemon is bound differently than config.json describes (host/port/TLS) — run `hydra-acp daemon restart` to apply.\n",
      ),
    );
  }
  if (drifted.length > 0) {
    process.stdout.write(
      warn(
        `These settings changed since the daemon started and need a restart to apply: ${drifted.join(", ")}.\n`,
      ),
    );
  }
}

type PidInfo = DaemonPidInfo;

async function readPidFile(): Promise<PidInfo | undefined> {
  return readDaemonPidFile();
}
