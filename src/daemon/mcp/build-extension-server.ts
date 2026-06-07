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
//                  connection as hydra-acp/mcp_tools/invoke, with a
//                  timeout. Every error path (timeout, RPC reject,
//                  malformed result) is converted to an MCP isError:true
//                  response — the daemon never throws to the SDK.

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

export const DEFAULT_INVOKE_TIMEOUT_MS = 60_000;

export interface BuildExtensionServerOptions {
  // Override the per-call timeout. Tests pass a small value (e.g. 50ms)
  // to exercise the timeout path quickly; production uses the default.
  invokeTimeoutMs?: number;
}

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
  sessionId: string,
  options: BuildExtensionServerOptions = {},
): Server {
  const invokeTimeoutMs =
    options.invokeTimeoutMs ?? DEFAULT_INVOKE_TIMEOUT_MS;

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
    async (req): Promise<CallToolResult> => {
      const toolName = req.params.name;
      if (!toolsByName.has(toolName)) {
        return errorResult(`unknown tool: ${toolName}`);
      }
      try {
        const raw = await invokeWithTimeout(
          entry.connection,
          extensionName,
          toolName,
          req.params.arguments ?? {},
          sessionId,
          invokeTimeoutMs,
        );
        return normalizeToolResult(raw, toolName);
      } catch (err) {
        return errorResult(
          err instanceof Error ? err.message : String(err),
        );
      }
    },
  );

  return server;
}

async function invokeWithTimeout(
  connection: JsonRpcConnection,
  server: string,
  tool: string,
  args: unknown,
  sessionId: string,
  timeoutMs: number,
): Promise<unknown> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`extension timeout after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([
      connection.request("hydra-acp/mcp_tools/invoke", {
        server,
        tool,
        args,
        sessionId,
      }),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
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
