import * as os from "node:os";
import { HYDRA_VERSION } from "./hydra-version.js";
import { thisMachine } from "./machine.js";
import { PEER_NAME_PATTERN } from "./peer-store.js";
import { baseUrlFor } from "./peer-login.js";

// Facts about the running daemon and the machine it is on, served at
// GET /v1/system. Distinct from /v1/config, which describes configuration.
export interface SystemInfo {
  // thisMachine(): the identity stamped on exported bundles, which peers
  // see as importedFromMachine.
  machine: string;
  hydraVersion: string;
  startedAt: string;
  os: { platform: string; release: string; arch: string };
  node: string;
}

export function buildSystemInfo(startedAt: string): SystemInfo {
  return {
    machine: thisMachine(),
    hydraVersion: HYDRA_VERSION,
    startedAt,
    os: { platform: process.platform, release: os.release(), arch: process.arch },
    node: process.version,
  };
}

export type PeerSystemResult =
  // A 200 proves the token even when the body isn't one we understand.
  | { kind: "ok"; system?: SystemInfo }
  | { kind: "unauthorized" }
  // A peer that predates /v1/system answers 404.
  | { kind: "unsupported" }
  | { kind: "error"; message: string };

export async function fetchPeerSystem(opts: {
  host: string;
  port: number;
  token: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<PeerSystemResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(`${baseUrlFor(opts.host, opts.port)}/v1/system`, {
      headers: { Authorization: `Bearer ${opts.token}` },
      signal: opts.signal,
    });
  } catch (err) {
    return { kind: "error", message: (err as Error).message };
  }
  if (res.status === 401 || res.status === 403) {
    return { kind: "unauthorized" };
  }
  if (res.status === 404) {
    return { kind: "unsupported" };
  }
  if (!res.ok) {
    return { kind: "error", message: `HTTP ${res.status}` };
  }
  try {
    const body = (await res.json()) as SystemInfo;
    return typeof body?.machine === "string" ? { kind: "ok", system: body } : { kind: "ok" };
  } catch {
    return { kind: "ok" };
  }
}

function validName(s: string | undefined): s is string {
  return s !== undefined && s.length <= 64 && PEER_NAME_PATTERN.test(s);
}

// The peer's own machine name when it is a valid remote name, so a live
// remote and that machine's imported sessions share one name. Otherwise the
// host's first DNS label; an IP address yields nothing.
export function deriveRemoteName(
  machine: string | undefined,
  host: string,
): string | undefined {
  if (validName(machine)) {
    return machine;
  }
  if (/^[\d.]+$/.test(host) || host.includes(":")) {
    return undefined;
  }
  const label = host.split(".")[0];
  return validName(label) ? label : undefined;
}
