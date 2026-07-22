import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { invokedBinName } from "./bin-name.js";
import type { HydraConfig } from "./config.js";
import { computeConfigDigest } from "./config-digest.js";
import { isProcessAlive, readDaemonPidFile } from "./daemon-pidfile.js";

// Read the daemon's pidfile to learn the plain-HTTP loopback URL it's
// serving on. Returns undefined when no daemon is running (pidfile
// absent or pid is dead). Co-resident callers dial this URL directly;
// it's always plain HTTP on 127.0.0.1 so no TLS trust story is needed
// even when the daemon also exposes a TLS terminator for off-box
// clients.
async function loopbackHealthUrl(): Promise<string | undefined> {
  const info = await readDaemonPidFile();
  if (!info) {
    return undefined;
  }
  if (!isProcessAlive(info.pid)) {
    return undefined;
  }
  return `http://127.0.0.1:${info.loopbackPort}/v1/health`;
}

// Result of probing the daemon port against our local config.
//   "match"    — a daemon answered and its configDigest equals ours;
//                safe to talk to it.
//   "missing"  — nothing answered; we can spawn our own daemon here.
//   "mismatch" — something answered but with a different configDigest
//                (different HOME / different token / drifted config).
//                Refusing to adopt it is critical: the WS handshake
//                would fail at the bearer-token check and the shim
//                would loop in "connection lost; reconnecting" until
//                the caller's timeout. Surface a clear error instead.
export type DaemonProbe = "match" | "missing" | "mismatch";

export async function probeDaemon(config: HydraConfig): Promise<DaemonProbe> {
  const health = await fetchDaemonHealth(config, 500);
  if (!health) {
    return "missing";
  }
  if (health.configDigest === undefined) {
    return "mismatch";
  }
  return health.configDigest === computeConfigDigest(config)
    ? "match"
    : "mismatch";
}

export async function ensureDaemonReachable(config: HydraConfig): Promise<void> {
  const probe = await probeDaemon(config);
  if (probe === "match") {
    return;
  }
  if (probe === "mismatch") {
    const bin = invokedBinName();
    throw new Error(
      `config changed since daemon started — run \`${bin} daemon restart\` to apply.`,
    );
  }
  process.stderr.write("hydra-acp: daemon not running; starting it...\n");
  spawnDaemonDetached();
  await waitForDaemonReady(config);
}

export async function pingHealth(_config: HydraConfig): Promise<boolean> {
  const url = await loopbackHealthUrl();
  if (!url) {
    return false;
  }
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(500),
      headers: { Connection: "close" },
    });
    return response.ok;
  } catch {
    return false;
  }
}

export interface DaemonHealth {
  version?: string;
  configDigest?: string;
}

export async function fetchDaemonHealth(
  _config: HydraConfig,
  timeoutMs = 1_000,
): Promise<DaemonHealth | undefined> {
  const url = await loopbackHealthUrl();
  if (!url) {
    return undefined;
  }
  try {
    // Connection: close prevents undici from pooling the socket on
    // keep-alive. The post-TUI exit path calls this right before
    // returning, and a pooled socket keeps the event loop alive long
    // enough to leave the shell hung after the "Continue:" line prints.
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Connection: "close" },
    });
    if (!response.ok) {
      return undefined;
    }
    const body = (await response.json()) as {
      version?: unknown;
      configDigest?: unknown;
    };
    return {
      version: typeof body.version === "string" ? body.version : undefined,
      configDigest:
        typeof body.configDigest === "string" ? body.configDigest : undefined,
    };
  } catch {
    return undefined;
  }
}

export function spawnDaemonDetached(): void {
  // The daemon has its own bundle (`dist/daemon.js`) sitting next to
  // the CLI bundle (`dist/cli.js`). Resolve it relative to this module
  // so we don't depend on PATH containing the npm-installed bin dir.
  // Dev-mode (`tsx src/cli.ts`) users should use `daemon start
  // --foreground`; spawning a .ts child from node without tsx would
  // fail, and forcing tsx in the parent's execPath here isn't worth
  // the complexity.
  const here = dirname(fileURLToPath(import.meta.url));
  const daemonBundle = resolve(here, "./daemon.js");
  const child = spawn(process.execPath, [daemonBundle], {
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
