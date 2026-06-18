// A RemoteTarget bundles everything needed to talk to a hydra daemon
// — REST base URL, WS URL, bearer token, and a few flags for UX
// decisions (daemon autostart, exit-hint wording). Code that used to
// thread `config.daemon.{host,port,tls}` + `serviceToken` separately
// now takes a single RemoteTarget instead, so the same code paths work
// for local (service-token) and remote (password-issued session-token)
// connections.

import * as os from "node:os";
import { DEFAULT_DAEMON_PORT, type HydraConfig } from "./config.js";
import {
  ensureServiceToken,
  readServiceToken,
} from "./service-token.js";
import {
  type ParsedHydraUrl,
  isLoopbackHost,
  transportFor,
} from "./remote-url.js";
import { RemotesStore } from "./remotes-store.js";
import { promptPassword } from "./prompt-password.js";
import { invokedBinName } from "./bin-name.js";
import { isProcessAlive, readDaemonPidFile } from "./daemon-pidfile.js";
import {
  fetchPeerFingerprint,
  formatFingerprint,
  getPin,
  installGlobalTlsTrust,
  loadPinsFromStore,
  setPin,
} from "./tls-trust.js";

export interface RemoteTarget {
  // "http://127.0.0.1:55514" or "https://abc.ngrok.app" — no trailing
  // slash, no path component. Append "/v1/..." for REST calls.
  baseUrl: string;
  // "ws://127.0.0.1:55514/acp" or "wss://abc.ngrok.app/acp". Full URL
  // including the /acp path so callers don't reassemble it.
  wsUrl: string;
  // Bearer presented as `Authorization: Bearer <token>` (REST) and
  // as `Sec-WebSocket-Protocol: hydra-acp-token.<token>` (WS upgrade).
  // The daemon's CompositeTokenValidator accepts either the service
  // token or a password-issued session token, so this field carries
  // both kinds uniformly.
  token: string;
  // Short human-readable label for log lines, exit hints, error
  // messages. "127.0.0.1:55514" for local, "abc.ngrok.app" for remote
  // (port elided when default for the scheme).
  display: string;
  // True for loopback hosts. Used to gate the daemon-autostart path
  // (`ensureDaemonReachable` only makes sense when the daemon is on
  // this machine) and to choose the wording of post-exit "To resume:"
  // hints.
  isLocal: boolean;
}

// Resolve the local daemon as a RemoteTarget. Reads
// config.daemon.{host,port,tls} + the service-token file. This is the
// "old" code path packaged in the new shape — same UX, same behavior.
// Auto-creates the service token on first run, matching the previous
// ensureServiceToken() contract used by the TUI entry point.
export async function resolveLocalTarget(
  config: HydraConfig,
): Promise<RemoteTarget> {
  const token = await ensureServiceToken();
  // Prefer the pidfile-reported loopback port. The daemon may be
  // bound on a wildcard with TLS in front for off-box clients; the
  // plain-HTTP loopback Fastify lives on an ephemeral port that's
  // only discoverable via the pidfile. Falling back to the
  // configured host:port keeps us working before the daemon has
  // written its pidfile (e.g. the autostart path probing whether
  // there's anything to talk to).
  const info = await readDaemonPidFile();
  if (info && isProcessAlive(info.pid)) {
    return {
      baseUrl: `http://127.0.0.1:${info.loopbackPort}`,
      wsUrl: `ws://127.0.0.1:${info.loopbackPort}/acp`,
      token,
      display: `${info.host}:${info.port}`,
      isLocal: true,
    };
  }
  const configuredHost = config.daemon.host;
  const dialHost =
    configuredHost === "0.0.0.0" ||
    configuredHost === "::" ||
    configuredHost === "0.0.0.0/0"
      ? "127.0.0.1"
      : configuredHost;
  const port = config.daemon.port;
  // No pidfile → daemon not running. Synthesize a plain-HTTP URL
  // for the autostart-and-probe loop; once the daemon writes its
  // pidfile this branch is never taken again.
  return {
    baseUrl: `http://${dialHost}:${port}`,
    wsUrl: `ws://${dialHost}:${port}/acp`,
    token,
    display: `${configuredHost}:${port}`,
    isLocal: isLoopbackHost(dialHost),
  };
}

// Build a RemoteTarget from a parsed hydra:// URL and an already-
// acquired bearer token. This is the construction helper used by
// `hydra session attach` once the password flow (or service-token
// shortcut on loopback) has yielded a token. The URL parser already
// resolved the port and loopback flag, so all the formatting decisions
// live here.
export function targetFromParsedUrl(
  parsed: ParsedHydraUrl,
  token: string,
): RemoteTarget {
  const { httpScheme, wsScheme } = transportFor(parsed.host);
  return {
    baseUrl: `${httpScheme}://${parsed.host}:${parsed.port}`,
    wsUrl: `${wsScheme}://${parsed.host}:${parsed.port}/acp`,
    token,
    display: displayFor(parsed),
    isLocal: parsed.isLoopback,
  };
}

// Re-export parseHydraUrl so callers can do
// `import { parseHydraUrl } from "./remote-target.js"` if it's more
// natural at the call site. Cheap; no runtime cost.
export { parseHydraUrl } from "./remote-url.js";

export interface ResolveRemoteDeps {
  // Injected so tests can drive the resolver without a real daemon
  // running. Defaults to the global fetch / interactive prompt at
  // call sites.
  fetchImpl?: typeof fetch;
  promptImpl?: (prompt: string) => Promise<string>;
  // Used for the y/n trust prompt when the daemon presents a cert
  // that doesn't validate against the system trust store. Defaults
  // to a stdin readline. Tests override to drive TOFU deterministically.
  confirmImpl?: (prompt: string) => Promise<boolean>;
  // Single injectable hook for the TLS TOFU step: probe the host
  // and report whether the cert is trusted by the system, untrusted
  // (capture its fingerprint + DN summary), or unreachable. Defaults
  // to a real tls.connect() probe followed by fetchPeerFingerprint
  // when the probe reports an untrusted-cert error.
  tlsHandshakeImpl?: (host: string, port: number) => Promise<TlsHandshakeResult>;
  // Override the credentials store. Tests pass a pre-loaded instance;
  // production paths fall through to RemotesStore.load().
  store?: RemotesStore;
  // Tells the local-service-token shortcut whether to even look. Set
  // false to force the password flow on loopback (useful when the
  // user has explicitly logged out, or for end-to-end tests of the
  // password path against the local daemon).
  preferServiceToken?: boolean;
  // Whether the resolver may prompt the user for a password when no
  // cached credential exists. Defaults to true (interactive TUI
  // path). The shim and cat entry points pass false because they're
  // non-interactive (stdin is wired to JSON-RPC framing, not a
  // human); they raise NoCachedCredentialError instead so the caller
  // can surface a clean error pointing at the interactive login
  // path.
  allowPrompt?: boolean;
}

// Thrown by resolveRemoteTarget when allowPrompt is false and there's
// no cached credential to fall back to. Carries enough information
// for the caller to print a useful "run this command to log in"
// message without re-parsing anything.
export class NoCachedCredentialError extends Error {
  readonly host: string;
  readonly port: number;
  constructor(host: string, port: number) {
    const portSuffix = port === DEFAULT_DAEMON_PORT ? "" : `:${port}`;
    super(
      `No cached credentials for ${host}:${port}. ` +
        `Run \`${invokedBinName()} --session hydra://${host}${portSuffix}/\` once in a terminal to log in.`,
    );
    this.name = "NoCachedCredentialError";
    this.host = host;
    this.port = port;
  }
}

// Resolve a hydra:// URL to a RemoteTarget. The flow:
//   1. For loopback hosts, try the local service token first so the
//      same-machine attach works zero-config (matching the existing
//      TUI behavior). If the service-token file isn't present, fall
//      through to the password path.
//   2. Look up the credentials store. If a non-expired token exists
//      for this host:port, use it.
//   3. Otherwise prompt the user for a password, POST it to
//      /v1/auth/login on the target daemon, and cache the returned
//      session token.
// Throws on auth failure, network failure, or user cancellation.
export async function resolveRemoteTarget(
  parsed: ParsedHydraUrl,
  deps: ResolveRemoteDeps = {},
): Promise<RemoteTarget> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const promptImpl = deps.promptImpl ?? promptPassword;
  const confirmImpl = deps.confirmImpl ?? promptYesNo;
  const tlsHandshakeImpl = deps.tlsHandshakeImpl ?? defaultTlsHandshake;
  const preferServiceToken = deps.preferServiceToken ?? true;
  const allowPrompt = deps.allowPrompt ?? true;

  // Loopback shortcut: a `hydra://127.0.0.1/<id>` URL is a same-box
  // attach. The TLS terminator does bind loopback, but routing
  // through it (a) requires the cert to cover 127.0.0.1 and (b) is
  // wasteful for a connection that never leaves the kernel. Swap in
  // the daemon's plain-HTTP loopback URL (from the pidfile) so the
  // attach Just Works regardless of TLS config — same behavior as
  // bare `--session <id>`.
  if (parsed.isLoopback && preferServiceToken) {
    const serviceToken = await readServiceToken();
    if (serviceToken) {
      return loopbackTargetForUrl(parsed, serviceToken);
    }
  }

  const store = deps.store ?? (await RemotesStore.load());
  // Hydrate the in-memory pin map from the store before the first
  // outbound request, and install the pin-aware dispatcher exactly
  // once. Subsequent calls are cheap no-ops.
  loadPinsFromStore(store);
  installGlobalTlsTrust();

  const cached = store.get(parsed.host, parsed.port);
  if (cached) {
    if (cached.pinnedFingerprint) {
      setPin(parsed.host, parsed.port, cached.pinnedFingerprint);
    }
    return targetFromParsedUrl(parsed, cached.token);
  }

  if (!allowPrompt) {
    // Non-interactive path (shim / cat). The caller will catch this
    // and surface a friendlier "log in first" message — but the
    // error itself is plain English so it still reads sensibly if
    // bubbled raw.
    throw new NoCachedCredentialError(parsed.host, parsed.port);
  }

  const display = displayFor(parsed);
  const { httpScheme } = transportFor(parsed.host);

  // TOFU step: if we're about to talk TLS to a host we've never seen,
  // try a chain-validating probe first. If it fails specifically
  // because the cert isn't trusted, capture the fingerprint, show it
  // to the user, and pin on confirmation. We do this BEFORE asking
  // for a password so credentials never cross an unverified channel.
  let capturedPin: string | undefined;
  if (httpScheme === "https" && getPin(parsed.host, parsed.port) === undefined) {
    const probe = await tlsHandshakeImpl(parsed.host, parsed.port);
    if (probe.kind === "untrusted") {
      const summary =
        probe.subject || probe.issuer
          ? `\n  subject: ${probe.subject ?? "(unknown)"}\n  issuer:  ${probe.issuer ?? "(unknown)"}`
          : "";
      process.stderr.write(
        `The certificate presented by ${display} is not signed by a trusted CA.\n` +
          `  sha256: ${formatFingerprint(probe.fingerprint)}${summary}\n`,
      );
      const ok = await confirmImpl(`Trust this certificate for ${display}? [y/N]: `);
      if (!ok) {
        throw new Error(`Aborted: certificate for ${display} not trusted.`);
      }
      setPin(parsed.host, parsed.port, probe.fingerprint);
      capturedPin = probe.fingerprint;
    } else if (probe.kind === "error") {
      throw new Error(
        `Could not connect to ${display} for TLS handshake: ${probe.message}`,
      );
    }
  }

  const password = await promptImpl(`Password for ${display}: `);
  if (password.length === 0) {
    throw new Error("Password is required to attach to a remote daemon.");
  }

  const baseUrl = `${httpScheme}://${parsed.host}:${parsed.port}`;
  const response = await fetchImpl(`${baseUrl}/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      password,
      label: defaultLabel(),
    }),
  });
  if (response.status === 401) {
    throw new Error(`Wrong password for ${display}.`);
  }
  if (response.status === 403) {
    throw new Error(
      `No password is configured on ${display}. Run \`hydra-acp auth password\` on the daemon host first.`,
    );
  }
  if (response.status === 429) {
    throw new Error(
      `Too many failed login attempts on ${display}; try again later.`,
    );
  }
  if (!response.ok) {
    throw new Error(`Login to ${display} failed: HTTP ${response.status}`);
  }
  const body = (await response.json()) as {
    session_token?: string;
    expires_at?: string;
  };
  if (!body.session_token || !body.expires_at) {
    throw new Error(`Login to ${display} returned a malformed response.`);
  }
  await store.set(parsed.host, parsed.port, {
    token: body.session_token,
    expiresAt: body.expires_at,
    label: defaultLabel(),
    ...(capturedPin
      ? { pinnedFingerprint: capturedPin, pinnedAt: new Date().toISOString() }
      : {}),
  });
  return targetFromParsedUrl(parsed, body.session_token);
}

// Result of the TOFU handshake step:
//   trusted   — chain validated against the system trust store.
//   untrusted — chain validation failed because the cert is self-
//               signed / unknown CA. Carries the leaf cert's sha256
//               (lowercase hex) and the parsed subject/issuer DNs so
//               the caller can show them to the user before asking
//               whether to pin.
//   error     — anything else (DNS failure, connection refused, …).
export type TlsHandshakeResult =
  | { kind: "trusted" }
  | { kind: "untrusted"; fingerprint: string; subject?: string; issuer?: string }
  | { kind: "error"; message: string };

async function defaultTlsHandshake(
  host: string,
  port: number,
): Promise<TlsHandshakeResult> {
  const probe = await probeChainValidation(host, port);
  if (probe.kind !== "untrusted") {
    return probe;
  }
  const fingerprint = await fetchPeerFingerprint(host, port);
  return {
    kind: "untrusted",
    fingerprint,
    ...(probe.subject !== undefined ? { subject: probe.subject } : {}),
    ...(probe.issuer !== undefined ? { issuer: probe.issuer } : {}),
  };
}

type ProbeResult =
  | { kind: "trusted" }
  | { kind: "untrusted"; subject?: string; issuer?: string }
  | { kind: "error"; message: string };

async function probeChainValidation(
  host: string,
  port: number,
  timeoutMs = 10_000,
): Promise<ProbeResult> {
  const tls = await import("node:tls");
  return new Promise<ProbeResult>((resolve) => {
    let settled = false;
    const finish = (result: ProbeResult): void => {
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
      resolve(result);
    };
    const socket = tls.connect({ host, port, servername: host });
    const timer = setTimeout(
      () => finish({ kind: "error", message: `TLS connect timed out after ${timeoutMs}ms` }),
      timeoutMs,
    );
    socket.once("secureConnect", () => finish({ kind: "trusted" }));
    socket.once("error", (err: NodeJS.ErrnoException) => {
      // Node surfaces "cert isn't trusted" via these codes. Anything
      // else is a non-cert problem and the caller will translate it
      // into a hard error.
      const code = err.code ?? "";
      const untrusted =
        code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
        code === "SELF_SIGNED_CERT_IN_CHAIN" ||
        code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
        code === "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" ||
        code === "UNABLE_TO_GET_ISSUER_CERT" ||
        code === "CERT_HAS_EXPIRED" ||
        code === "ERR_TLS_CERT_ALTNAME_INVALID";
      if (untrusted) {
        const peer = socket.getPeerCertificate(false);
        finish({
          kind: "untrusted",
          subject: peer?.subject ? formatDn(peer.subject as Record<string, string | string[]>) : undefined,
          issuer: peer?.issuer ? formatDn(peer.issuer as Record<string, string | string[]>) : undefined,
        });
        return;
      }
      finish({ kind: "error", message: err.message });
    });
  });
}

function formatDn(dn: Record<string, string | string[]> | undefined): string {
  if (!dn) {
    return "";
  }
  const parts: string[] = [];
  for (const [k, v] of Object.entries(dn)) {
    const value = Array.isArray(v) ? v.join(", ") : v;
    parts.push(`${k}=${value}`);
  }
  return parts.join(", ");
}

// Build a loopback target from a `hydra://127.0.0.1/<id>` URL,
// consulting the pidfile so we land on the plain-HTTP ephemeral
// port the daemon's Fastify actually serves. Falls back to the
// parsed URL's port when the pidfile is missing (so the autostart
// path during boot still finds something to dial).
async function loopbackTargetForUrl(
  parsed: ParsedHydraUrl,
  token: string,
): Promise<RemoteTarget> {
  const info = await readDaemonPidFile();
  const alive = info && isProcessAlive(info.pid);
  const port = alive ? info.loopbackPort : parsed.port;
  const display = parsed.port === DEFAULT_DAEMON_PORT
    ? parsed.host
    : `${parsed.host}:${parsed.port}`;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/acp`,
    token,
    display,
    isLocal: true,
  };
}

async function promptYesNo(prompt: string): Promise<boolean> {
  process.stdout.write(prompt);
  return new Promise<boolean>((resolve) => {
    let buf = "";
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl === -1) {
        return;
      }
      process.stdin.removeListener("data", onData);
      process.stdin.pause();
      const answer = buf.slice(0, nl).trim().toLowerCase();
      resolve(answer === "y" || answer === "yes");
    };
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

function defaultLabel(): string {
  // The daemon shows this in `hydra-acp auth list`. Use the host's
  // own short hostname so the daemon operator can tell which machine
  // issued the token.
  try {
    const name = os.hostname();
    return name.length > 0 ? name : "remote";
  } catch {
    return "remote";
  }
}

function displayFor(parsed: ParsedHydraUrl): string {
  if (parsed.port === DEFAULT_DAEMON_PORT) {
    return parsed.host;
  }
  return `${parsed.host}:${parsed.port}`;
}
