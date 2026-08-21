import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { invokedBinName } from "./bin-name.js";
import type { HydraConfig } from "./config.js";
import { computeConfigDigest } from "./config-digest.js";
import { scrubInheritedEnv, setExtraScrubbedEnv } from "./scrub-env.js";
import { isProcessAlive, readDaemonPidFile } from "./daemon-pidfile.js";
import { paths } from "./paths.js";
import type { RemoteTarget } from "./remote-target.js";

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
  // Identity first, and exactly: a daemon rooted in a different
  // HYDRA_ACP_HOME reads a different auth token and a different session
  // store, which is the case the WS handshake would fail on. Reported
  // directly since this field exists rather than inferred from a hash of
  // unrelated settings.
  if (health.home !== undefined && health.home !== paths.home()) {
    return "mismatch";
  }
  if (health.configDigest === undefined) {
    return "mismatch";
  }
  // Only restart-tier keys are in the digest, so this now means "the
  // daemon is bound differently than your config describes" rather than
  // "some setting changed". Everything else either re-reads (tier live)
  // or is reported as drift (tier warn).
  return health.configDigest === computeConfigDigest(config)
    ? "match"
    : "mismatch";
}

export async function ensureDaemonReachable(
  config: HydraConfig,
  target?: RemoteTarget,
): Promise<void> {
  const probe = await probeDaemon(config);
  if (probe === "mismatch") {
    const bin = invokedBinName();
    throw new Error(
      `config changed since daemon started — run \`${bin} daemon restart\` to apply.`,
    );
  }
  if (probe === "missing") {
    process.stderr.write("hydra-acp: daemon not running; starting it...\n");
    spawnDaemonDetached(config);
    await waitForDaemonReady(config);
  }
  // When TLS is configured, config.daemon.port hosts the TLS
  // terminator and Fastify binds a separate loopback ephemeral port
  // that's only discoverable via the pidfile. A target synthesized
  // BEFORE the daemon started points at the TLS port with a plain
  // http:// scheme, which fetches fail against with "fetch failed"
  // (TLS handshake on a plain HTTP request). If the caller passed
  // its pre-resolved target, patch its URLs to point at the
  // now-known loopback port so the very next fetch/WS dial lands
  // on the real Fastify listener.
  if (target !== undefined) {
    const info = await readDaemonPidFile();
    if (info && isProcessAlive(info.pid)) {
      const loopback = `http://127.0.0.1:${info.loopbackPort}`;
      target.baseUrl = loopback;
      target.wsUrl = `ws://127.0.0.1:${info.loopbackPort}/acp`;
    }
    await waitForUrlReady(`${target.baseUrl}/v1/health`);
  }
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
  // The daemon's resolved HYDRA_ACP_HOME. Absent from daemons older than
  // this field, which probeDaemon treats as "can't tell" and falls back
  // to the digest for.
  home?: string;
  // Tier-"warn" keys that differ from what the daemon booted with.
  // Advisory: the daemon is healthy, these just won't apply until it
  // restarts. Absent on older daemons.
  driftedKeys?: string[];
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
      home?: unknown;
      driftedKeys?: unknown;
    };
    return {
      version: typeof body.version === "string" ? body.version : undefined,
      configDigest:
        typeof body.configDigest === "string" ? body.configDigest : undefined,
      home: typeof body.home === "string" ? body.home : undefined,
      driftedKeys: Array.isArray(body.driftedKeys)
        ? body.driftedKeys.filter((k): k is string => typeof k === "string")
        : undefined,
    };
  } catch {
    return undefined;
  }
}

/**
 * Start a detached daemon.
 *
 * `config` is only used for its scrub list — see below. It's a parameter
 * rather than a fresh `loadConfig()` because every caller already has one,
 * and re-reading here could disagree with the config the caller validated.
 */
export function spawnDaemonDetached(config?: HydraConfig): void {
  // The daemon has its own bundle (`dist/daemon.js`) sitting next to
  // the CLI bundle (`dist/cli.js`). Resolve it relative to this module
  // so we don't depend on PATH containing the npm-installed bin dir.
  // Dev-mode (`tsx src/cli.ts`) users should use `daemon start
  // --foreground`; spawning a .ts child from node without tsx would
  // fail, and forcing tsx in the parent's execPath here isn't worth
  // the complexity.
  const here = dirname(fileURLToPath(import.meta.url));
  const daemonBundle = resolve(here, "./daemon.js");
  // Scrub HERE, in the process that is still inside the pane, rather than
  // relying only on the daemon filtering its children.
  //
  // Two reasons this is worth doing in addition to the child-spawn scrub:
  //
  //  1. It cleans the DAEMON's own environment, not just what it hands on.
  //     Anything reading process.env directly — a path not routed through
  //     AgentInstance/ChildSupervisor, or code written later — is then
  //     protected without having to remember this rule.
  //  2. It makes "the daemon must not resolve a terminal host" true by
  //     construction instead of by convention. A daemon with no pane
  //     identity in its environment cannot detect one, so the invariant
  //     can't quietly rot.
  //
  // It does NOT replace the child-spawn scrub, because hydra doesn't
  // control how the daemon gets started in general: a systemd unit,
  // `nohup hydra daemon start --foreground &`, a container, a wrapper
  // script, or simply an older build all bypass this path. The scrub at
  // the child-spawn seam is the load-bearing one precisely because it
  // holds regardless of provenance.
  if (config) {
    setExtraScrubbedEnv(config.daemon.scrubEnv);
  }
  const child = spawn(process.execPath, [daemonBundle], {
    detached: true,
    stdio: "ignore",
    env: scrubInheritedEnv(),
  });
  child.unref();
}

async function pingUrl(url: string, timeoutMs = 500): Promise<boolean> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Connection: "close" },
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function waitForUrlReady(
  url: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pingUrl(url)) {
      return;
    }
    await sleep(150);
  }
  throw new Error(
    `hydra-acp daemon did not answer ${url} within ${timeoutMs}ms`,
  );
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
