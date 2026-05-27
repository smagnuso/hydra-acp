// Registry of MCP servers contributed by extensions and transformers.
//
// Mirror of ExtensionCommandRegistry (slash commands) for MCP tools. An
// extension calls hydra-acp/register_mcp_tools over its JsonRpcConnection
// and the daemon binds those tools at /mcp/<extension-name>. The route
// param is always the extension's processIdentity.name — extensions don't
// get to choose; cardinality is one MCP server per extension, same
// posture as "/hydra <name> <verb>".
//
// Per-token transport caching lives in the route handler's closure (see
// cli/src/daemon/mcp/extension-route.ts), not here. This registry only
// holds the registration data + change notifications so the route can
// invalidate its cache on hot reload.
//
// Used by:
//   - extension-route.ts: looks up a registration by name on each request
//   - acp-ws.ts: session/new enumerates list() to mint mcpServers entries
//   - acp-ws.ts: hydra-acp/register_mcp_tools handler calls register/clear
//   - acp-ws.ts: connection.onClose calls clear(extName)

import type { JsonRpcConnection } from "../acp/connection.js";

export interface ExtensionMcpToolSpec {
  name: string;
  description: string;
  // JSON Schema. Passed through to the agent verbatim; the daemon does
  // not validate tool-call arguments against it. Extensions validate (or
  // not) on their side.
  inputSchema: object;
  outputSchema?: object;
}

export interface ExtensionMcpEntry {
  connection: JsonRpcConnection;
  instructions?: string;
  tools: ExtensionMcpToolSpec[];
}

export type ExtensionMcpChangeKind = "register" | "clear";

export class ExtensionMcpRegistry {
  private byName = new Map<string, ExtensionMcpEntry>();
  private changeHandlers: Array<
    (extName: string, kind: ExtensionMcpChangeKind) => void
  > = [];

  // Set-the-whole-spec semantics, same as ExtensionCommandRegistry. A
  // second register for the same extName overwrites tools + instructions
  // wholesale; the change notification lets the route evict any cached
  // transports built against the old spec.
  register(
    extName: string,
    connection: JsonRpcConnection,
    instructions: string | undefined,
    tools: ExtensionMcpToolSpec[],
  ): void {
    this.byName.set(extName, {
      connection,
      instructions,
      tools: [...tools],
    });
    this.fireChanged(extName, "register");
  }

  clear(extName: string): void {
    if (this.byName.delete(extName)) {
      this.fireChanged(extName, "clear");
    }
  }

  lookup(extName: string): ExtensionMcpEntry | undefined {
    return this.byName.get(extName);
  }

  // List of currently-registered extension names. Used by session-create
  // to decide whether to mint an extension-MCP token and which mcpServers
  // entries to emit.
  list(): string[] {
    return Array.from(this.byName.keys());
  }

  onChange(
    handler: (extName: string, kind: ExtensionMcpChangeKind) => void,
  ): () => void {
    this.changeHandlers.push(handler);
    return () => {
      const i = this.changeHandlers.indexOf(handler);
      if (i >= 0) {
        this.changeHandlers.splice(i, 1);
      }
    };
  }

  private fireChanged(extName: string, kind: ExtensionMcpChangeKind): void {
    for (const h of this.changeHandlers) {
      try {
        h(extName, kind);
      } catch {
        // A misbehaving handler shouldn't poison registration for others.
      }
    }
  }
}
