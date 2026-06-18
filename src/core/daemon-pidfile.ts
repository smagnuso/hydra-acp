// Read/write helpers for ~/.hydra-acp/daemon.pid.
//
// The pid file is the discovery channel between the daemon process
// and any co-resident CLI invocation (`hydra extension`, the TUI,
// `daemon status`, the bootstrap probe, …). The daemon writes it on
// startup and deletes it on clean shutdown; callers consult it to
// learn (a) whether a daemon is up, (b) what URL to dial it on.
//
// The daemon can bind two listeners at once (a public TLS terminator
// on `host:port` and a plain HTTP Fastify on `127.0.0.1:loopbackPort`).
// Co-resident callers always dial the loopback URL — no TLS trust
// story, no certificate to install, no dispatcher to wire up. Remote
// `hydra://` clients hit the public listener and go through the
// existing TOFU pinning flow.

import * as fsp from "node:fs/promises";
import { paths } from "./paths.js";

export interface DaemonPidInfo {
  pid: number;
  // Configured `daemon.host` — the address advertised to off-box
  // clients via `hydra session share`. May be a wildcard (0.0.0.0)
  // when the operator wants LAN access; callers that need a dialable
  // address should use `loopbackPort` instead.
  host: string;
  // Configured `daemon.port`. When TLS is enabled this is the port
  // the public TLS terminator is bound to; when TLS is off it equals
  // `loopbackPort` (Fastify is the only listener).
  port: number;
  // Loopback port serving plain HTTP. Always present. Equal to
  // `port` when TLS is off; an ephemeral port when TLS is on (the
  // public TCP listener decrypts and forwards bytes to this one).
  loopbackPort: number;
  startedAt: string;
}

export async function readDaemonPidFile(): Promise<DaemonPidInfo | undefined> {
  try {
    const raw = await fsp.readFile(paths.pidFile(), "utf8");
    const parsed = JSON.parse(raw) as Partial<DaemonPidInfo>;
    if (
      typeof parsed.pid !== "number" ||
      typeof parsed.host !== "string" ||
      typeof parsed.port !== "number"
    ) {
      return undefined;
    }
    return {
      pid: parsed.pid,
      host: parsed.host,
      port: parsed.port,
      // Older daemons didn't write loopbackPort. Treat the configured
      // port as loopback in that case so upgrades don't strand callers
      // — the old daemon was plain HTTP only, so :port served loopback
      // requests directly.
      loopbackPort:
        typeof parsed.loopbackPort === "number"
          ? parsed.loopbackPort
          : parsed.port,
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "",
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
}

export async function writeDaemonPidFile(info: DaemonPidInfo): Promise<void> {
  await fsp.writeFile(paths.pidFile(), JSON.stringify(info) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
