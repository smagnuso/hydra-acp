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
  const host = config.daemon.host;
  const port = config.daemon.port;
  const tls = !!config.daemon.tls;
  const httpScheme = tls ? "https" : "http";
  const wsScheme = tls ? "wss" : "ws";
  return {
    baseUrl: `${httpScheme}://${host}:${port}`,
    wsUrl: `${wsScheme}://${host}:${port}/acp`,
    token,
    display: `${host}:${port}`,
    isLocal: isLoopbackHost(host),
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
  const { httpScheme, wsScheme } = transportFor(parsed.port);
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
  const preferServiceToken = deps.preferServiceToken ?? true;
  const allowPrompt = deps.allowPrompt ?? true;

  // Loopback shortcut: same-machine attach reuses the service token
  // so a user who set up the daemon doesn't have to set a password.
  if (parsed.isLoopback && preferServiceToken) {
    const serviceToken = await readServiceToken();
    if (serviceToken) {
      return targetFromParsedUrl(parsed, serviceToken);
    }
  }

  const store = deps.store ?? (await RemotesStore.load());
  const cached = store.get(parsed.host, parsed.port);
  if (cached) {
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
  const password = await promptImpl(`Password for ${display}: `);
  if (password.length === 0) {
    throw new Error("Password is required to attach to a remote daemon.");
  }

  const { httpScheme } = transportFor(parsed.port);
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
  });
  return targetFromParsedUrl(parsed, body.session_token);
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
