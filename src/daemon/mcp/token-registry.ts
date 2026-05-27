// Shared token → session registry for HTTP MCP routes.
//
// Both /mcp/hydra-acp-stdin and /mcp/<extension-name> mint per-session bearer
// tokens, embed them in the agent's mcpServers config at session/new
// time, and look them up here when an MCP request arrives. The reserve →
// complete handshake exists because claude-acp eagerly initializes its
// configured MCP servers during session/new — the first /mcp/* request
// can land while the daemon is still inside manager.create(), before the
// Session object exists. reserve() lets the route handler park on
// sessionReady; complete() runs once the session is ready; abandon()
// unsticks the handler with an error if session creation fails.
//
// Subsystems that hold per-token state (stdin's per-session McpServer +
// transport, extension MCP's (token, extension-name) → transport cache)
// register disposers with addDisposer(). On unbind() those disposers
// fire in registration order and the entry is removed. The registry
// itself knows nothing about stdin vs. extension MCP — the disposer
// pattern is what lets one registry serve both.

import type { Session } from "../../core/session.js";

export interface TokenReservation {
  complete: (session: Session) => void;
  abandon: (reason?: Error) => void;
}

export interface TokenEntry {
  // undefined during the reserve → complete window (claude-acp's eager
  // MCP init can land here before manager.create() returns the session).
  // Always defined once complete() has run.
  session: Session | undefined;
  // Resolves once complete() runs; rejects if abandon() runs first.
  // Route handlers await this when they see session === undefined so a
  // failed manager.create() unblocks them rather than hanging.
  sessionReady: Promise<Session>;
  // Cleanup callbacks registered by subsystems holding per-token state.
  // Fired in registration order by unbind() (best-effort: a throwing
  // disposer doesn't prevent later disposers from running).
  disposers: Array<() => Promise<void>>;
}

export class McpTokenRegistry {
  private byToken = new Map<string, TokenEntry>();

  reserve(token: string): TokenReservation {
    if (this.byToken.has(token)) {
      throw new Error("mcp token already bound");
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
    const entry: TokenEntry = {
      session: undefined,
      sessionReady,
      disposers: [],
    };
    this.byToken.set(token, entry);
    return {
      complete: (session) => {
        entry.session = session;
        resolveSession(session);
      },
      abandon: (reason) => {
        this.byToken.delete(token);
        rejectSession(reason ?? new Error("mcp token reservation abandoned"));
      },
    };
  }

  // Convenience for callers that already have the session in hand (and
  // for tests). Equivalent to reserve() + complete() back-to-back.
  bind(token: string, session: Session): void {
    const { complete } = this.reserve(token);
    complete(session);
  }

  lookup(token: string): TokenEntry | undefined {
    return this.byToken.get(token);
  }

  // Register a cleanup callback for this token. No-op if the token is
  // not currently bound — late additions after unbind() would never fire
  // anyway, so dropping them silently is safer than throwing into an
  // unrelated cleanup path.
  addDisposer(token: string, dispose: () => Promise<void>): void {
    const entry = this.byToken.get(token);
    if (entry === undefined) {
      return;
    }
    entry.disposers.push(dispose);
  }

  async unbind(token: string): Promise<void> {
    const entry = this.byToken.get(token);
    if (entry === undefined) {
      return;
    }
    this.byToken.delete(token);
    // Fire in registration order. A throwing disposer is swallowed so
    // later disposers still run — partial cleanup beats none.
    for (const dispose of entry.disposers) {
      try {
        await dispose();
      } catch {
        // Intentional: see comment above.
      }
    }
  }

  size(): number {
    return this.byToken.size;
  }
}
