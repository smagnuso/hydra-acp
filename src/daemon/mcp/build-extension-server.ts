// JSON-Schema → low-level MCP Server builder for extension-contributed
// tools. Drops below the high-level McpServer wrapper used by stdin so
// that input/output schemas can cross the wire as JSON Schema (verbatim
// from what the extension registered) instead of going through a Zod
// translation step that would force every extension to depend on a
// JS-specific library.
//
// Two request handlers:
//   tools/list  → returns the spec captured in the closure verbatim
//   tools/call  → forwards via JSON-RPC to the owning extension's
//                  connection as hydra-acp/mcp_tools/invoke. Errors
//                  (connection close, RPC reject, malformed result)
//                  are converted to MCP isError:true responses — the
//                  daemon never throws to the SDK.
//
// No per-call timeout: liveness comes from connection close (extension
// crash/disconnect rejects in-flight requests) and user cancel (agent
// turn cancel propagates to tools/call). Long-running extension tools
// (e.g. the planner's execute_plan, which blocks for the lifetime of
// a multi-task project) are first-class — they take as long as they
// take, and the user is the timeout.
//
// To keep agent-side MCP clients from imposing their OWN tool-call
// timeouts on long extension calls, we emit MCP `notifications/progress`
// on a heartbeat while a tools/call is in flight. Clients like opencode
// pass `resetTimeoutOnProgress: true` to the SDK callTool helper, so
// each heartbeat resets their per-call timer.
//
// The MCP TypeScript SDK only auto-includes a `_meta.progressToken` in
// the request when the caller also passes an `onprogress` handler —
// opencode passes `resetTimeoutOnProgress: true` but not `onprogress`,
// so requests arrive here without a progressToken even though the
// client wants timer resets. To work around that, when the client
// didn't supply a token we synthesize one from the JSON-RPC requestId
// (the client SDK's `_setupTimeout` keys timeoutInfo by messageId, and
// its progress-reset path does `Number(progressToken)` and resets if
// the lookup hits — see protocol.js _setupTimeout / handleProgress).
// Result: heartbeats reset the client's timer regardless of whether
// the client requested progress.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { JsonRpcConnection } from "../../acp/connection.js";
import type {
  ExtensionMcpEntry,
  ExtensionMcpToolSpec,
} from "../../core/extension-mcp.js";

export function buildExtensionServer(
  extensionName: string,
  entry: ExtensionMcpEntry,
  // Hydra sessionId this server instance is bound to. Forwarded to
  // the extension on every hydra-acp/mcp_tools/invoke so the
  // extension knows which session originated the call — agents don't
  // see hydra session ids, so the extension can't get this from the
  // agent's tool args. Without this an extension that needs to
  // operate on per-session state (like the planner managing a per-
  // session project board) wouldn't know which board to touch.
  //
  // Accepts either a string (sessionId known up front) or a resolver
  // (() => string | Promise<string>) used when the sessionId isn't
  // available at build time. The route handler uses the resolver form
  // so the agent's session/new MCP handshake (initialize / tools/list)
  // doesn't have to block on the daemon's session/new completing —
  // which it can't, since the daemon's session/new IS the call that's
  // waiting on the agent's session/new to return. tools/call is the
  // only place that actually needs the sessionId, and by the time
  // tools/call fires the session has long since been bound.
  sessionId: string | (() => string | Promise<string>),
): Server {
  const resolveSessionId: () => Promise<string> =
    typeof sessionId === "function"
      ? async () => sessionId()
      : async () => sessionId;

  const server = new Server(
    { name: extensionName, version: "1.0.0" },
    {
      capabilities: {
        // listChanged: false matches the v1 strategy — the daemon closes
        // transports on re-register; agents reconnect and re-list against
        // the new spec naturally. Flipping to true is the upgrade path
        // if any supported agent caches tools/list across reconnects.
        tools: { listChanged: false },
      },
      ...(entry.instructions !== undefined
        ? { instructions: entry.instructions }
        : {}),
    },
  );

  const toolsByName = new Map<string, ExtensionMcpToolSpec>(
    entry.tools.map((t) => [t.name, t]),
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: entry.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      ...(t.outputSchema !== undefined
        ? { outputSchema: t.outputSchema }
        : {}),
    })),
  }));

  server.setRequestHandler(
    CallToolRequestSchema,
    async (req, extra): Promise<CallToolResult> => {
      const toolName = req.params.name;
      if (!toolsByName.has(toolName)) {
        return errorResult(`unknown tool: ${toolName}`);
      }
      // Prefer a client-supplied progressToken when present; otherwise
      // fall back to the JSON-RPC requestId so the heartbeat addresses
      // notifications to a token the client SDK will still resolve
      // against its per-message timeout (see file header).
      const progressToken = extra._meta?.progressToken ?? extra.requestId;
      const stopHeartbeat = startProgressHeartbeat(
        progressToken,
        extra.sendNotification,
      );
      try {
        const resolvedSessionId = await resolveSessionId();
        const raw = await invokeExtension(
          entry.connection,
          extensionName,
          toolName,
          req.params.arguments ?? {},
          resolvedSessionId,
        );
        return normalizeToolResult(raw, toolName);
      } catch (err) {
        return errorResult(
          err instanceof Error ? err.message : String(err),
        );
      } finally {
        stopHeartbeat();
      }
    },
  );

  return server;
}

// Default heartbeat interval. Tuned so that clients with the SDK's
// default 60s `resetTimeoutOnProgress` window stay alive comfortably,
// and clients with shorter defaults (opencode's 30s) also stay alive
// without flooding the wire. Overridable for tests.
export const PROGRESS_HEARTBEAT_MS = 15_000;

export function startProgressHeartbeat(
  progressToken: string | number | undefined,
  sendNotification: (n: {
    method: "notifications/progress";
    params: { progressToken: string | number; progress: number; total?: number };
  }) => Promise<void>,
  intervalMs: number = PROGRESS_HEARTBEAT_MS,
): () => void {
  if (progressToken === undefined) {
    return () => undefined;
  }
  let tick = 0;
  const timer = setInterval(() => {
    tick += 1;
    void sendNotification({
      method: "notifications/progress",
      params: { progressToken, progress: tick },
    }).catch(() => {
      // Client disconnected or transport closed mid-call. Nothing to do —
      // the underlying extension call will resolve or be aborted via
      // connection close; either way the finally block will clear the
      // interval. Swallow to avoid an unhandled rejection log.
    });
  }, intervalMs);
  // Don't hold the daemon's event loop open for this timer.
  timer.unref?.();
  return () => clearInterval(timer);
}

async function invokeExtension(
  connection: JsonRpcConnection,
  server: string,
  tool: string,
  args: unknown,
  sessionId: string,
): Promise<unknown> {
  return await connection.request("hydra-acp/mcp_tools/invoke", {
    server,
    tool,
    args,
    sessionId,
  });
}

function normalizeToolResult(raw: unknown, toolName: string): CallToolResult {
  // Extensions are supposed to return the MCP CallToolResult shape
  // ({content: [...], structuredContent?, isError?}). Defensive checks
  // here cover the common malformed cases without trying to deep-validate
  // arbitrary JSON — the SDK and the agent surface their own errors
  // for shapes that pass these checks but fail deeper validation.
  if (raw === null || typeof raw !== "object") {
    return errorResult(`extension ${toolName} returned non-object`);
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.content)) {
    return errorResult(`extension ${toolName} omitted content array`);
  }
  return obj as CallToolResult;
}

function errorResult(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}
