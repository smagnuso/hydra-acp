// Parses `hydra://host[:port]/[sessionId]` URLs used by `hydra session
// attach` and `hydra session share`. The scheme is intentionally
// transport-agnostic: this module decides which underlying scheme
// (http/https, ws/wss) and default port to use based on whether the
// host is loopback. ngrok, Tailscale, plain LAN, and a public VPS all
// produce the same hydra:// URL shape.

import { DEFAULT_DAEMON_PORT } from "./config.js";

export interface ParsedHydraUrl {
  // Raw hostname from the URL, with no brackets for IPv6 literals.
  host: string;
  // Resolved port. Defaults: loopback host -> DEFAULT_DAEMON_PORT,
  // non-loopback host -> 443 (HTTPS via tunnel/public TLS). An
  // explicit ":port" in the URL always wins.
  port: number;
  // Session id (the URL path with leading slashes stripped). Empty
  // path yields undefined, which callers treat as "no session
  // specified — open the picker on that host".
  sessionId: string | undefined;
  // True when the host is 127.0.0.1, ::1, or localhost. Drives the
  // scheme choice (http vs https) and whether the local daemon-
  // autostart path applies.
  isLoopback: boolean;
}

export interface HydraTransport {
  // "http" | "https" for REST. "ws" | "wss" for the /acp upgrade.
  // Mirrors the loopback check in cli/src/daemon/server.ts so client
  // and server agree on which hosts require TLS.
  httpScheme: "http" | "https";
  wsScheme: "ws" | "wss";
}

export function isLoopbackHost(host: string): boolean {
  return (
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "localhost" ||
    host === "[::1]"
  );
}

export function transportFor(host: string): HydraTransport {
  if (isLoopbackHost(host)) {
    return { httpScheme: "http", wsScheme: "ws" };
  }
  return { httpScheme: "https", wsScheme: "wss" };
}

export function parseHydraUrl(input: string): ParsedHydraUrl {
  if (typeof input !== "string" || input.length === 0) {
    throw new Error("expected a hydra:// URL");
  }
  // WHATWG URL accepts unknown schemes, but it treats `hydra://` as a
  // non-special scheme and won't populate `hostname`/`port`. Rewriting
  // to `http://` for the parse is the simplest workaround; we
  // re-validate the original scheme by hand below.
  if (!input.startsWith("hydra://")) {
    throw new Error(`expected hydra:// URL, got ${truncateForError(input)}`);
  }
  const rest = input.slice("hydra://".length);
  // Reject empty authority before WHATWG URL sees it; otherwise
  // "hydra:///x" parses as http:///x which WHATWG silently treats
  // as host="x".
  if (rest.length === 0 || rest.startsWith("/")) {
    throw new Error(`hydra:// URL is missing a host: ${truncateForError(input)}`);
  }
  // Pre-validate the port if present, since WHATWG URL throws a
  // generic TypeError for ports >65535 that would mask our specific
  // "invalid port" message.
  const portMatch = rest.match(/^[^/]*?:(\d+)(?:\/|$)/);
  if (portMatch) {
    const candidate = Number(portMatch[1]);
    if (!Number.isInteger(candidate) || candidate <= 0 || candidate > 65535) {
      throw new Error(`hydra:// URL has invalid port: ${portMatch[1]}`);
    }
  }
  const parsedAsHttp = safeParseUrl(`http://${rest}`);
  if (!parsedAsHttp) {
    throw new Error(`invalid hydra:// URL: ${truncateForError(input)}`);
  }
  const host = parsedAsHttp.hostname;
  if (!host) {
    throw new Error(`hydra:// URL is missing a host: ${truncateForError(input)}`);
  }
  const loopback = isLoopbackHost(host);
  let port: number;
  if (parsedAsHttp.port) {
    const parsedPort = Number(parsedAsHttp.port);
    if (!Number.isInteger(parsedPort) || parsedPort <= 0 || parsedPort > 65535) {
      throw new Error(`hydra:// URL has invalid port: ${parsedAsHttp.port}`);
    }
    port = parsedPort;
  } else {
    port = loopback ? DEFAULT_DAEMON_PORT : 443;
  }
  const rawPath = parsedAsHttp.pathname.replace(/^\/+/, "");
  const sessionId = rawPath === "" ? undefined : rawPath;
  return { host, port, sessionId, isLoopback: loopback };
}

// Inverse of parseHydraUrl. Used by `hydra session share` to print a
// URL the user can paste into `hydra session attach`. Omits the port
// when it matches the default for the chosen transport so URLs stay
// short for the common cases (loopback :55514, public :443).
export function formatHydraUrl(parts: {
  host: string;
  port?: number;
  sessionId?: string;
}): string {
  const loopback = isLoopbackHost(parts.host);
  const defaultPort = loopback ? DEFAULT_DAEMON_PORT : 443;
  const portSuffix =
    parts.port !== undefined && parts.port !== defaultPort
      ? `:${parts.port}`
      : "";
  const pathSuffix = parts.sessionId ? `/${parts.sessionId}` : "/";
  return `hydra://${parts.host}${portSuffix}${pathSuffix}`;
}

function safeParseUrl(input: string): URL | null {
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

function truncateForError(s: string): string {
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
}
