// HTTP route + lazy transport cache for extension-contributed MCP
// servers.
//
// Each registered extension is served at /mcp/<extension-name>. The
// route resolves the bearer token via the shared McpTokenRegistry,
// resolves the extension name via ExtensionMcpRegistry, and lazily
// builds an MCP Server + StreamableHTTPServerTransport pair scoped to
// the (token, extension-name) pair.
//
// Eviction has three triggers:
//   1. Extension re-registers (hot reload) — onChange fires; we close
//      transports for that extName across all tokens so the agent
//      reconnects against the new spec.
//   2. Extension's connection drops — acp-ws calls registry.clear() →
//      same onChange path as (1).
//   3. Session ends — McpTokenRegistry.unbind() fires the disposer we
//      registered on first ensureTransport, which closes transports for
//      that token across all extensions.
//
// We bypass the daemon's bearer-token middleware via `skipAuth: true`
// because this route's token is a per-session capability scoped to one
// agent's MCP surface — different trust domain than the daemon's
// service token.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "node:crypto";
import type { ExtensionMcpRegistry } from "../../core/extension-mcp.js";
import { extractBearer } from "./bearer.js";
import {
  buildExtensionServer,
  type BuildExtensionServerOptions,
} from "./build-extension-server.js";
import type { McpTokenRegistry } from "./token-registry.js";

interface BuiltPair {
  server: Server;
  transport: StreamableHTTPServerTransport;
}

// Same conservative bound as /mcp/hydra-acp-stdin: agent spawn + eager-init is
// well under a second in practice, but we leave headroom for a slow
// claude-acp install.
const SESSION_READY_TIMEOUT_MS = 10_000;

export interface RegisterExtensionMcpRoutesOptions {
  buildOptions?: BuildExtensionServerOptions;
}

export function registerExtensionMcpRoutes(
  app: FastifyInstance,
  tokenRegistry: McpTokenRegistry,
  extensionMcp: ExtensionMcpRegistry,
  options: RegisterExtensionMcpRoutesOptions = {},
): void {
  // Per-registration lazy build cache, keyed (token, extName). Two-level
  // map so we can evict efficiently in either direction: by token (session
  // end → close everything that session built) or by extName (extension
  // re-register/disconnect → close everything pinned to that extension).
  const built = new Map<string, Map<string, BuiltPair>>();

  async function disposeBuiltPair(pair: BuiltPair): Promise<void> {
    try {
      await pair.transport.close();
    } catch {
      // intentional: closing an already-closed transport is fine
    }
    try {
      await pair.server.close();
    } catch {
      // intentional
    }
  }

  // Tear down all built transports for an extension across every token.
  // Fires on hot reload (onChange register/clear) so the agent
  // reconnects against the fresh spec.
  function evictExtension(extName: string): void {
    for (const tokenScope of built.values()) {
      const pair = tokenScope.get(extName);
      if (pair !== undefined) {
        tokenScope.delete(extName);
        void disposeBuiltPair(pair);
      }
    }
  }

  extensionMcp.onChange((extName) => {
    evictExtension(extName);
  });

  async function ensureTransport(
    token: string,
    extName: string,
  ): Promise<StreamableHTTPServerTransport | undefined> {
    let tokenScope = built.get(token);
    if (tokenScope === undefined) {
      tokenScope = new Map<string, BuiltPair>();
      built.set(token, tokenScope);
      // First-time we cache anything for this token: register a disposer
      // with the shared token registry. When the session ends, this
      // drops all (token, *) entries we own and closes their transports.
      tokenRegistry.addDisposer(token, async () => {
        const scope = built.get(token);
        if (scope === undefined) {
          return;
        }
        built.delete(token);
        for (const pair of scope.values()) {
          await disposeBuiltPair(pair);
        }
      });
    }

    const existing = tokenScope.get(extName);
    if (existing !== undefined) {
      return existing.transport;
    }

    const entry = extensionMcp.lookup(extName);
    if (entry === undefined) {
      return undefined;
    }

    const server = buildExtensionServer(extName, entry, options.buildOptions);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });
    await server.connect(transport);
    tokenScope.set(extName, { server, transport });
    return transport;
  }

  async function handle(
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const token = extractBearer(req);
    if (token === undefined) {
      reply.code(401).send({ error: "missing bearer token" });
      return;
    }
    const entry = tokenRegistry.lookup(token);
    if (entry === undefined) {
      reply.code(404).send({ error: "unknown mcp token" });
      return;
    }
    // Wait for the session to be ready if the reservation is still
    // pending. Same pattern as the stdin route — claude-acp can land
    // here mid-manager.create().
    if (entry.session === undefined) {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), SESSION_READY_TIMEOUT_MS);
      });
      const resolved = await Promise.race([
        entry.sessionReady.catch(() => undefined),
        timeout,
      ]);
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      if (resolved === undefined) {
        reply.code(503).send({ error: "session not ready" });
        return;
      }
    }

    const extName = (req.params as { name: string }).name;
    const transport = await ensureTransport(token, extName);
    if (transport === undefined) {
      reply.code(404).send({ error: `unknown mcp server: ${extName}` });
      return;
    }
    reply.hijack();
    await transport.handleRequest(req.raw, reply.raw, req.body);
  }

  const opts = { config: { skipAuth: true } };
  app.post("/mcp/:name", opts, async (req, reply) => {
    await handle(req, reply);
  });
  app.get("/mcp/:name", opts, async (req, reply) => {
    await handle(req, reply);
  });
  app.delete("/mcp/:name", opts, async (req, reply) => {
    await handle(req, reply);
  });
}
