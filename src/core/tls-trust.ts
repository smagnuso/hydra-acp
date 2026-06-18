// TOFU-style TLS trust for `hydra://` connections.
//
// The daemon may be fronted by a self-signed cert (LAN, mDNS, anything
// without a public CA). We want self-signed to Just Work without
// disabling validation process-wide, so this module pins the cert's
// sha256 fingerprint on first login (SSH `known_hosts` style):
//
//   1. login flow captures the leaf cert with `fetchPeerFingerprint`,
//      shows it to the user, and stores it in remotes.json alongside
//      the session token.
//   2. `installGlobalTlsTrust` swaps undici's global dispatcher for one
//      whose TLS connector consults the pin map first. Pinned hosts
//      validate by fingerprint (any chain accepted as long as the
//      fingerprint matches). Unpinned hosts go through the default
//      connector, so CA-signed certs / public HTTPS endpoints behave
//      exactly as before.
//   3. `wsTlsOptions` builds the equivalent { rejectUnauthorized,
//      checkServerIdentity } pair for the `ws` library so wss://
//      upgrades honor the same pins.

import { createHash } from "node:crypto";
import * as tls from "node:tls";
import {
  Agent,
  Dispatcher,
  buildConnector,
  getGlobalDispatcher,
  setGlobalDispatcher,
} from "undici";
import { hostKey, type RemotesStore } from "./remotes-store.js";

// In-memory pin map. Keyed by "host:port" to match RemotesStore. The
// fingerprint is the sha256 of the leaf certificate's DER, lowercase
// hex (no separators).
const pinMap = new Map<string, string>();
let dispatcherInstalled = false;

export function setPin(host: string, port: number, fingerprint: string): void {
  pinMap.set(hostKey(host, port), normalizeFp(fingerprint));
}

export function clearPin(host: string, port: number): void {
  pinMap.delete(hostKey(host, port));
}

export function getPin(host: string, port: number): string | undefined {
  return pinMap.get(hostKey(host, port));
}

// Repopulates the pin map from a freshly-loaded RemotesStore. Called
// at startup once per process (after RemotesStore.load) so cached
// pins are available before the first outbound request.
export function loadPinsFromStore(store: RemotesStore): void {
  pinMap.clear();
  for (const e of store.list()) {
    if (e.entry.pinnedFingerprint) {
      setPin(e.host, e.port, e.entry.pinnedFingerprint);
    }
  }
}

// Opens a raw TLS connection without cert validation, captures the
// leaf cert's fingerprint, and tears the connection down. Used at
// login time so we can present the fingerprint to the user before any
// secrets cross the wire.
export async function fetchPeerFingerprint(
  host: string,
  port: number,
  opts: { timeoutMs?: number } = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  return new Promise<string>((resolve, reject) => {
    const socket = tls.connect({
      host,
      port,
      servername: host,
      rejectUnauthorized: false,
      autoSelectFamily: true,
    });
    let settled = false;
    const finish = (err: Error | null, fp?: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch {
        // best effort
      }
      if (err) {
        reject(err);
      } else if (fp) {
        resolve(fp);
      }
    };
    const timer = setTimeout(() => {
      finish(new Error(`TLS connect to ${host}:${port} timed out`));
    }, timeoutMs);
    socket.once("secureConnect", () => {
      const cert = socket.getPeerCertificate(false);
      if (!cert || !cert.raw) {
        finish(new Error(`${host}:${port} did not present a TLS certificate`));
        return;
      }
      finish(null, sha256Hex(cert.raw));
    });
    socket.once("error", (err) => finish(err));
  });
}

export function sha256Hex(buf: Buffer | Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

// Human-readable fingerprint: groups of two hex chars separated by
// colons, like ssh-keygen / openssl x509 -fingerprint output. The
// underlying storage form is the unseparated lowercase hex string.
export function formatFingerprint(hex: string): string {
  const clean = normalizeFp(hex);
  const matched = clean.match(/.{2}/g);
  return matched ? matched.join(":") : clean;
}

function normalizeFp(fp: string): string {
  return fp.replace(/:/g, "").toLowerCase();
}

// Installs a global undici dispatcher that routes pinned hosts
// through a fingerprint-verifying TLS connector and everything else
// through the default connector. Idempotent — subsequent calls are
// cheap no-ops so callers don't have to coordinate.
export function installGlobalTlsTrust(): void {
  if (dispatcherInstalled) {
    return;
  }
  dispatcherInstalled = true;

  // Capture whatever dispatcher was already installed (typically
  // Node's bundled one backing globalThis.fetch). Unpinned hosts get
  // delegated straight to it so Node's native fetch + RedirectHandler
  // pipeline stays fully intact — wrapping unpinned traffic in our
  // own v8 Agent breaks cross-version composition (e.g. 302s stop
  // following).
  const original = getGlobalDispatcher();
  const pinnedAgent = new Agent({
    connect: buildConnector({
      // chain validation is bypassed because the pin IS our root of
      // trust; if the fingerprint doesn't match, we reject below.
      rejectUnauthorized: false,
      autoSelectFamily: true,
      checkServerIdentity: (servername, cert) =>
        verifyAgainstPins(servername, cert),
    }),
  });

  const proxy = new Dispatcher();
  proxy.dispatch = (
    opts: Dispatcher.DispatchOptions,
    handler: Dispatcher.DispatchHandler,
  ): boolean => {
    const host = hostFromOrigin(opts.origin);
    const target = host && hasPinForHost(host) ? pinnedAgent : original;
    return target.dispatch(opts, handler);
  };
  proxy.close = ((): Promise<void> =>
    Promise.all([pinnedAgent.close(), original.close()]).then(
      () => undefined,
    )) as typeof proxy.close;
  proxy.destroy = ((err?: Error | null): Promise<void> =>
    Promise.all([
      pinnedAgent.destroy(err ?? null),
      original.destroy(err ?? null),
    ]).then(() => undefined)) as typeof proxy.destroy;

  setGlobalDispatcher(proxy);
}

function hostFromOrigin(origin: unknown): string | null {
  if (!origin) {
    return null;
  }
  try {
    return new URL(String(origin)).hostname;
  } catch {
    return null;
  }
}



// Pin lookup is by host alone (not host:port) because the TLS layer
// doesn't surface the port in checkServerIdentity callbacks. If two
// daemons on the same host but different ports both have pins, both
// must present a cert matching one of the pins — fine in practice.
function hasPinForHost(host: string): boolean {
  for (const key of pinMap.keys()) {
    if (splitKey(key)?.host === host) {
      return true;
    }
  }
  return false;
}

function verifyAgainstPins(
  servername: string,
  cert: tls.PeerCertificate,
): Error | undefined {
  if (!cert || !cert.raw) {
    return new Error(`TLS peer ${servername} did not present a certificate`);
  }
  const fp = sha256Hex(cert.raw);
  for (const [key, pinned] of pinMap.entries()) {
    const split = splitKey(key);
    if (split && split.host === servername && pinned === fp) {
      return undefined;
    }
  }
  return new Error(
    `TLS pin mismatch for ${servername} (cert sha256 ${formatFingerprint(fp)})`,
  );
}

function splitKey(key: string): { host: string; port: number } | null {
  const colon = key.lastIndexOf(":");
  if (colon < 0) {
    return null;
  }
  const host = key.slice(0, colon);
  const port = Number(key.slice(colon + 1));
  if (!Number.isInteger(port)) {
    return null;
  }
  return { host, port };
}

// Builds the per-connection tls options to pass to `new WebSocket(url,
// protocols, options)` for wss:// upgrades. Returns an empty object
// when the host isn't pinned so the ws library uses its defaults.
export function wsTlsOptions(host: string): {
  rejectUnauthorized?: boolean;
  autoSelectFamily?: boolean;
  checkServerIdentity?: (
    servername: string,
    cert: tls.PeerCertificate,
  ) => Error | undefined;
} {
  if (!hasPinForHost(host)) {
    return { autoSelectFamily: true };
  }
  return {
    rejectUnauthorized: false,
    autoSelectFamily: true,
    checkServerIdentity: (servername, cert) =>
      verifyAgainstPins(servername, cert),
  };
}

// Test-only escape hatch. Lets tests reset the dispatcher-installed
// flag without monkey-patching the module's internals.
export function _resetForTests(): void {
  pinMap.clear();
  dispatcherInstalled = false;
}
