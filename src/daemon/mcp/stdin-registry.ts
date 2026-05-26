// Per-session MCP endpoint registry for piped stdin.
//
// When a client opens a session with `_meta.mcpStdin: true` (`hydra cat
// --stream`), the daemon mints a fresh capability token, embeds the
// matching `Authorization: Bearer <token>` in the `mcpServers` entry
// passed to the spawned agent, and registers the (token → session) pair
// here. The agent connects to `/mcp/stdin` with that bearer; the route
// handler looks up the session and routes MCP requests to the
// per-session McpServer instance.
//
// Lifetime: the session's onClose hook calls unregister(), which tears
// down the transport so any in-flight MCP request returns cleanly and
// no token outlives its session.
//
// The token is the auth credential: 32 random bytes hex-encoded. The
// daemon never logs it. It is visible to the spawned agent process (in
// its mcpServers config) and to anyone with access to the daemon's
// in-memory state — i.e. the same trust boundary that already governs
// session WS tokens.

import type { Session } from "../../core/session.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export interface RegisteredEndpoint {
  // Populated by complete(). Undefined during the brief window after
  // reserve() but before complete() — i.e. while manager.create() is
  // running. The route handler awaits sessionReady when this is undefined.
  session: Session | undefined;
  // Resolves when complete() runs. Always defined for entries in the
  // registry; rejecting it lets a failed manager.create() unblock any
  // in-flight MCP request with an error instead of hanging.
  sessionReady: Promise<Session>;
  // Lazily populated on first MCP request. The McpServer + transport are
  // long-lived for the session's lifetime; subsequent requests reuse the
  // same transport so the agent's MCP state (initialize, listed tools,
  // long-poll subscriptions) survives.
  server?: McpServer;
  transport?: StreamableHTTPServerTransport;
}

export interface Reservation {
  complete: (session: Session) => void;
  abandon: (reason?: Error) => void;
}

export class StdinMcpRegistry {
  private byToken = new Map<string, RegisteredEndpoint>();

  // Reserve a token slot before the session exists. Used by acp-ws when
  // we need to inject the bearer into the agent's mcpServers BEFORE
  // manager.create() returns — claude-acp connects to /mcp/stdin during
  // session/new initialization (eagerly), so the route handler must be
  // able to find the token by the time the agent's first request lands.
  reserve(token: string): Reservation {
    if (this.byToken.has(token)) {
      throw new Error(`stdin MCP token already bound`);
    }
    let resolveSession!: (session: Session) => void;
    let rejectSession!: (err: Error) => void;
    const sessionReady = new Promise<Session>((resolve, reject) => {
      resolveSession = resolve;
      rejectSession = reject;
    });
    // Swallow unhandled rejections — abandon() is allowed even when no
    // route handler is currently awaiting sessionReady.
    sessionReady.catch(() => undefined);
    const entry: RegisteredEndpoint = { session: undefined, sessionReady };
    this.byToken.set(token, entry);
    return {
      complete: (session) => {
        entry.session = session;
        resolveSession(session);
      },
      abandon: (reason) => {
        this.byToken.delete(token);
        rejectSession(reason ?? new Error("stdin MCP reservation abandoned"));
      },
    };
  }

  // Convenience for callers that already have the session in hand (and
  // for tests). Equivalent to reserve() + complete() back-to-back.
  bind(token: string, session: Session): void {
    const { complete } = this.reserve(token);
    complete(session);
  }

  lookup(token: string): RegisteredEndpoint | undefined {
    return this.byToken.get(token);
  }

  attachTransport(
    token: string,
    server: McpServer,
    transport: StreamableHTTPServerTransport,
  ): void {
    const ep = this.byToken.get(token);
    if (!ep) {
      return;
    }
    ep.server = server;
    ep.transport = transport;
  }

  async unbind(token: string): Promise<void> {
    const ep = this.byToken.get(token);
    if (!ep) {
      return;
    }
    this.byToken.delete(token);
    if (ep.transport) {
      try {
        await ep.transport.close();
      } catch {
        // Closing an already-closed transport is harmless; swallow so a
        // double-unbind from racy close handlers doesn't bubble.
      }
    }
    if (ep.server) {
      try {
        await ep.server.close();
      } catch {
        // Same as above.
      }
    }
  }

  size(): number {
    return this.byToken.size;
  }
}
