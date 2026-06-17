// HTTP route + MCP server factory for compaction-recall tools.
//
// The agent connects to /mcp/hydra-acp-recall with `Authorization:
// Bearer <token>` where the token was minted at session/new time (and
// re-minted on compaction swap) and embedded in the agent's
// `mcpServers` entry. Mirrors the stdin-server.ts pattern: lookup token
// in McpTokenRegistry → recover Session → lazily build McpServer +
// transport on first request → cache per token → tear down on session
// close via tokenRegistry.addDisposer.
//
// Tool set is gated: recall_search / recall_range / recall_tool_calls
// register only when session.summarizedThroughEntry > 0. Sessions that
// have never been compacted see an empty tool list from this server —
// the route still answers initialize / list_tools cleanly so the agent
// doesn't error, it just gets nothing useful. Once compaction runs and
// the swap mints a fresh token, the next request hits cache-miss and
// the rebuild registers the tools.
//
// Why a separate route from /mcp/hydra-acp-stdin: recall tools are
// available to every session (TUI, cat, future clients); stdin tools
// are only minted for hydra cat. Bundling them would either leak
// stdin-only tools (tail/head/read/grep/info/wait_for_more) into TUI
// sessions or leave recall unreachable for non-cat sessions. Keeping
// them separate lets each route apply its own minting policy.
//
// Bypass the daemon's bearer-token middleware via `skipAuth: true` —
// this route's token is per-session capability scoped to one McpServer,
// different trust domain than the daemon's service tokens.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Session } from "../../core/session.js";
import { renderTranscript } from "../../core/history-transcript.js";
import { iterSessionUpdates, mcpJsonResult } from "./helpers.js";
import { extractBearer } from "./bearer.js";
import type { McpTokenRegistry } from "./token-registry.js";

interface BuiltPair {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

// Mirrors the speaker classification helper inlined in stdin-server.ts
// for the recall_search snippet metadata. Kept private because callers
// outside this file shouldn't need to categorize update kinds.
function getSpeaker(
  kind: string,
): "user" | "agent" | "tool" {
  switch (kind) {
    case "prompt_received":
      return "user";
    case "tool_call":
    case "tool_call_update":
      return "tool";
    default:
      return "agent";
  }
}

// 150-char window centered on the match index. Mirrors the stdin server
// implementation; could move to helpers.ts later if a third caller
// appears.
function makeSnippet(text: string, matchIndex: number): string {
  const ellipsisCount = "\u2026".length * 2;
  const targetLen = 150 - ellipsisCount;
  if (text.length <= targetLen) {
    return text;
  }
  const half = Math.floor(targetLen / 2);
  let start = matchIndex - half;
  if (start < 0) {
    start = 0;
  }
  const end = start + targetLen;
  if (end > text.length) {
    start = text.length - targetLen;
    if (start < 0) {
      start = 0;
    }
  }
  let snippet = text.slice(start, end);
  if (start > 0) {
    snippet = "\u2026" + snippet;
  }
  if (end < text.length) {
    snippet = snippet + "\u2026";
  }
  return snippet;
}

// getSession resolves to the Session at tool-call time. The route binds
// this lazily so initialize / tools/list responses don't wait on the
// reservation — only actual tool invocations do. This breaks the
// resurrect deadlock where the agent's session/load probes MCP servers
// before the Session object can exist (Session needs loadResult,
// loadResult requires session/load to return). See registerRecallMcpRoutes
// for the binding.
export function buildRecallMcpServer(
  getSession: () => Promise<Session>,
): McpServer {
  const server = new McpServer(
    { name: "hydra-acp-recall", version: "1.0.0" },
    {
      instructions:
        "Search and retrieve detail from this session's pre-compaction history. " +
        "After a compaction summary replaces earlier conversation in working memory, these tools let you page back specifics on demand. " +
        "Use `recall_search` to find entries by keyword, `recall_range` to pull a contiguous slice verbatim, and `recall_tool_calls` to enumerate prior tool invocations. " +
        "These tools only return results once the session has been compacted at least once.",
    },
  );

  // Always register the three recall_* tools so the MCP server's
  // tools/list handler is wired (the SDK only attaches the handler
  // when at least one tool is registered, so an "empty if uncompacted"
  // build-time gate would make the server respond with "Method not
  // found" to list_tools — agents can't gracefully handle that).
  // Behavior is gated at CALL time: when summarizedThroughEntry === 0,
  // the tools return a short "no compacted history yet" result instead
  // of doing the work. After compaction, the swap path mints a fresh
  // token; the cache-miss rebuilds with the same shape, and the
  // gate-by-call now reports real results.
  {
    server.registerTool(
      "recall_search",
      {
        description:
          "Search this session's prior conversation history (the part that was compacted out of your working memory) by keyword. Returns matching entry ids with short snippets so you can decide which to pull in full via recall_range. Use this when the compaction summary mentions something but you need the verbatim detail.",
        inputSchema: {
          query: z.string().min(1).describe("Case-insensitive substring to search for."),
          limit: z
            .number()
            .int()
            .min(1)
            .max(50)
            .optional()
            .describe("Maximum number of matches to return (default 10, max 50)."),
          include_tool_calls: z
            .boolean()
            .optional()
            .describe("Whether to include tool_call entries in the search (default true)."),
        },
      },
      async ({ query, limit = 10, include_tool_calls = true }) => {
        const session = await getSession();
        if (!session.summarizedThroughEntry || session.summarizedThroughEntry === 0) {
          return mcpJsonResult({
            matches: [],
            total_matched: 0,
            truncated: false,
            note: "This session has no compacted history. recall_search retrieves detail from entries that were summarized out of the working conversation; nothing has been summarized yet.",
          });
        }
        const history = await session.getHistorySnapshot();
        const matches: Array<{
          entryId: number;
          speaker: "user" | "agent" | "tool";
          snippet: string;
          timestamp?: string;
        }> = [];

        for (const { entryId, entry, kind } of iterSessionUpdates(history)) {
          if (kind === "tool_call" && !include_tool_calls) {
            continue;
          }

          const rendered = renderTranscript([entry] as unknown as Parameters<
            typeof renderTranscript
          >[0]);

          const idx = rendered.toLowerCase().indexOf(query.toLowerCase());
          if (idx < 0) {
            continue;
          }

          const speaker = getSpeaker(kind);
          const snippet = makeSnippet(rendered, idx);
          const timestamp =
            typeof entry.recordedAt === "number" ? String(entry.recordedAt) : undefined;

          matches.push({ entryId, speaker, snippet, timestamp });

          if (matches.length >= limit) {
            break;
          }
        }

        const truncated = matches.length >= limit && matches.length < history.length;
        return mcpJsonResult({ matches, total_matched: matches.length, truncated });
      },
    );

    server.registerTool(
      "recall_range",
      {
        description:
          "Pull a contiguous range of prior conversation entries verbatim from this session's pre-compaction history. Use after recall_search narrows in on what you need. Capped at 50 entries per call.",
        inputSchema: {
          from_entry: z
            .number()
            .int()
            .min(0)
            .describe("Zero-based index of the first entry to include (inclusive)."),
          to_entry: z
            .number()
            .int()
            .min(0)
            .describe("Zero-based index of the last entry to include (inclusive)."),
        },
      },
      async ({ from_entry, to_entry }) => {
        const session = await getSession();
        if (!session.summarizedThroughEntry || session.summarizedThroughEntry === 0) {
          return mcpJsonResult({
            text: "",
            entry_count: 0,
            truncated: false,
            note: "This session has no compacted history. recall_range retrieves verbatim entries from the pre-compaction transcript; nothing has been compacted yet.",
          });
        }
        if (to_entry < from_entry) {
          throw new Error(
            `recall_range: to_entry (${to_entry}) must be >= from_entry (${from_entry})`,
          );
        }
        const range_size = to_entry - from_entry + 1;
        if (range_size > 50) {
          throw new Error(
            `recall_range: range size (${range_size}) exceeds maximum of 50 entries`,
          );
        }
        const history = await session.getHistorySnapshot();
        const clamped_from = Math.min(from_entry, history.length - 1);
        const clamped_to = Math.min(to_entry, history.length - 1);
        const truncated = clamped_from > from_entry || clamped_to < to_entry;
        if (clamped_from > clamped_to) {
          return {
            content: [{ type: "text", text: "" }],
            structuredContent: { text: "", entry_count: 0, truncated },
          };
        }
        const slice = history.slice(clamped_from, clamped_to + 1);
        const text = renderTranscript(slice as unknown as Parameters<typeof renderTranscript>[0]);
        return {
          content: [{ type: "text", text }],
          structuredContent: { text, entry_count: slice.length, truncated },
        };
      },
    );

    server.registerTool(
      "recall_tool_calls",
      {
        description:
          "Search this session's prior tool invocations by tool name and/or file path. Returns when each tool was called, the arguments, and the result status. Use this to recall which files were read/edited, what shell commands ran, etc.",
        inputSchema: {
          tool_name: z.string().optional(),
          file_path: z.string().optional(),
          limit: z.number().int().min(1).max(100).optional(),
        },
      },
      async ({ tool_name, file_path, limit = 20 }) => {
        const session = await getSession();
        if (!session.summarizedThroughEntry || session.summarizedThroughEntry === 0) {
          return mcpJsonResult({
            calls: [],
            truncated: false,
            note: "This session has no compacted history. recall_tool_calls retrieves tool invocations from the pre-compaction transcript; nothing has been compacted yet.",
          });
        }
        const hasToolName = typeof tool_name === "string" && tool_name.length > 0;
        const hasFilePath = typeof file_path === "string" && file_path.length > 0;
        if (!hasToolName && !hasFilePath) {
          throw new Error(
            "recall_tool_calls: at least one of tool_name or file_path must be provided",
          );
        }
        const history = await session.getHistorySnapshot();
        const calls: Array<{
          entryId: number;
          tool: string;
          args: Record<string, unknown>;
          status: string;
          timestamp?: string;
        }> = [];

        for (const { entryId, entry, kind, update } of iterSessionUpdates(history)) {
          if (kind !== "tool_call") {
            continue;
          }

          let toolName: string;
          if (typeof update.name === "string" && update.name.length > 0) {
            toolName = update.name;
          } else if (typeof update.title === "string" && update.title.length > 0) {
            toolName = update.title;
          } else {
            toolName = "(unnamed)";
          }

          if (tool_name !== undefined && toolName.toLowerCase() !== tool_name.toLowerCase()) {
            continue;
          }

          const rawInput = update.rawInput as Record<string, unknown> | undefined;
          const args: Record<string, unknown> = {};

          if (rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)) {
            for (const [key, value] of Object.entries(rawInput)) {
              if (typeof value === "string") {
                args[key] = value.length > 500 ? value.slice(0, 497) + "\u2026" : value;
              } else if (typeof value === "number" || typeof value === "boolean") {
                args[key] = value;
              }
            }
          }

          if (hasFilePath && rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)) {
            const fpLower = file_path!.toLowerCase();
            const pathKeys = ["file_path", "path"];
            let pathMatch = false;
            for (const key of pathKeys) {
              const value = rawInput[key];
              if (typeof value === "string" && value.toLowerCase() === fpLower) {
                pathMatch = true;
                break;
              }
            }
            if (!pathMatch) {
              continue;
            }
          }

          let status = "in_progress";
          if (typeof update.status === "string") {
            status = update.status;
          }

          const timestamp =
            typeof entry.recordedAt === "number" ? String(entry.recordedAt) : undefined;

          calls.push({ entryId, tool: toolName, args, status, timestamp });

          if (calls.length >= limit) {
            break;
          }
        }

        const truncated = calls.length >= limit;
        return mcpJsonResult({ calls, truncated });
      },
    );
  }

  return server;
}

// Bound on how long to wait for a reservation's session to be completed.
// Mirrors the stdin-server constant — both routes face the same race
// (agent's first MCP request can land mid session/new).
const SESSION_READY_TIMEOUT_MS = 10_000;

export function registerRecallMcpRoutes(
  app: FastifyInstance,
  tokenRegistry: McpTokenRegistry,
): void {
  const builtPerToken = new Map<string, BuiltPair>();

  async function ensureTransport(
    token: string,
    getSession: () => Promise<Session>,
  ): Promise<StreamableHTTPServerTransport> {
    const existing = builtPerToken.get(token);
    if (existing !== undefined) {
      return existing.transport;
    }
    const server = buildRecallMcpServer(getSession);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });
    await server.connect(transport);
    const pair: BuiltPair = { server, transport };
    builtPerToken.set(token, pair);
    tokenRegistry.addDisposer(token, async () => {
      builtPerToken.delete(token);
      try {
        await transport.close();
      } catch {
        // intentional
      }
      try {
        await server.close();
      } catch {
        // intentional
      }
    });
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
      reply.code(404).send({ error: "unknown recall token" });
      return;
    }
    // Do NOT block on sessionReady here. initialize / tools/list don't
    // need the Session — the tool closures resolve it at call time via
    // getSession (which awaits sessionReady with a generous bound).
    // This eliminates the resurrect deadlock: the agent's session/load
    // probes MCP servers BEFORE the Session can exist (Session
    // construction needs loadResult; loadResult is the session/load
    // response). Pre-fix, every resurrect spent two 10s timeouts here.
    const getSession = async (): Promise<Session> => {
      if (entry.session !== undefined) {
        return entry.session;
      }
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
        throw new Error("recall: session not ready");
      }
      return resolved;
    };
    const transport = await ensureTransport(token, getSession);
    reply.hijack();
    await transport.handleRequest(req.raw, reply.raw, req.body);
  }

  const opts = { config: { skipAuth: true } };
  app.post("/mcp/hydra-acp-recall", opts, async (req, reply) => {
    await handle(req, reply);
  });
  app.get("/mcp/hydra-acp-recall", opts, async (req, reply) => {
    await handle(req, reply);
  });
  app.delete("/mcp/hydra-acp-recall", opts, async (req, reply) => {
    await handle(req, reply);
  });
}
