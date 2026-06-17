// HTTP route + MCP server factory for piped-stdin sessions.
//
// The agent connects to /mcp/hydra-acp-stdin with `Authorization: Bearer <token>`
// where the token was minted at session/new time and embedded in the
// `mcpServers` entry handed to the agent. We look the token up in the
// shared McpTokenRegistry to recover the session, then lazily build an
// McpServer + StreamableHTTPServerTransport pair on the first request
// and reuse them for the session's lifetime so the agent's MCP state
// (initialize, list tools, in-flight long-polls) survives across
// requests. Cleanup runs via a disposer registered with the token
// registry — when the session ends, the transport + server close and
// the lazy-cache entry drops.
//
// We bypass the daemon's bearer-token middleware via `skipAuth: true`
// because the daemon's tokens belong to a different trust domain — this
// route's token is per-session capability scoped to one McpServer.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Session } from "../../core/session.js";
import type { StreamGrepOptions as RawStreamGrepOptions } from "../../core/stream-buffer.js";
import { mcpJsonResult } from "./helpers.js";
import { extractBearer } from "./bearer.js";
import type { McpTokenRegistry } from "./token-registry.js";

interface BuiltPair {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

function buildMcpServer(session: Session): McpServer {
  const server = new McpServer(
    { name: "hydra-acp-stdin", version: "1.0.0" },
    {
      instructions:
        "Piped input from `hydra cat --stream` is exposed here as a byte stream. " +
        "Use `tail` for the latest N bytes (good for finding the end of a log), " +
        "`head` for the first N bytes (good for headers/preamble), " +
        "`read` for windowed reads against an absolute byte cursor, " +
        "`wait_for_more` to block until new bytes arrive past a cursor, and " +
        "`info` for the current cursors/capacity/closed status. " +
        "Byte payloads come back base64-encoded.",
    },
  );

  server.registerTool(
    "tail",
    {
      description:
        "Return the most recent `bytes` bytes of piped stdin (capped server-side, default 64 KiB max). `truncated:true` means older bytes existed but have been evicted from the ring.",
      inputSchema: {
        bytes: z
          .number()
          .int()
          .min(1)
          .describe("How many trailing bytes to return."),
      },
    },
    async ({ bytes }) => {
      const r = session.streamTail(bytes);
      return mcpJsonResult(r);
    },
  );

  server.registerTool(
    "head",
    {
      description:
        "Return the first `bytes` bytes of piped stdin (capped server-side, default 64 KiB max). `truncated:true` means the head has already been evicted from the ring and the returned bytes start at the oldest still-resident cursor.",
      inputSchema: {
        bytes: z
          .number()
          .int()
          .min(1)
          .describe("How many leading bytes to return."),
      },
    },
    async ({ bytes }) => {
      const r = session.streamHead(bytes);
      return mcpJsonResult(r);
    },
  );

  server.registerTool(
    "read",
    {
      description:
        "Read up to `max_bytes` bytes starting at absolute byte `cursor`. Returns `{bytes, nextCursor, gap?, eof?}` — `gap` is the number of bytes silently skipped because the ring had evicted them; `eof:true` means the producer closed and there is nothing left to read.",
      inputSchema: {
        cursor: z
          .number()
          .int()
          .min(0)
          .describe(
            "Absolute byte offset to start reading from. Use 0 to read from the very beginning (may produce a gap if old bytes have been evicted).",
          ),
        max_bytes: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "Optional cap on how many bytes to return. Server caps at 64 KiB regardless.",
          ),
        wait_ms: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "If no bytes are available, block up to this many ms for more (capped server-side at 60_000).",
          ),
      },
    },
    async ({ cursor, max_bytes, wait_ms }) => {
      const r = await session.streamRead(cursor, max_bytes, wait_ms);
      return mcpJsonResult(r);
    },
  );

  server.registerTool(
    "wait_for_more",
    {
      description:
        "Block until bytes are available past `cursor`, the stream closes, or `timeout_ms` elapses. Returns one of {data, eof, timeout} plus the current `writeCursor`. Use this when you've consumed everything up to a cursor and want to wait for more without busy-polling.",
      inputSchema: {
        cursor: z
          .number()
          .int()
          .min(0)
          .describe("The cursor you've already consumed up to."),
        timeout_ms: z
          .number()
          .int()
          .min(0)
          .describe("Maximum ms to block (server caps at 60_000)."),
      },
    },
    async ({ cursor, timeout_ms }) => {
      const outcome = await session.streamWaitFor(cursor, timeout_ms);
      const info = session.streamInfo();
      return mcpJsonResult({ outcome, writeCursor: info.writeCursor, closed: info.closed });
    },
  );

  server.registerTool(
    "grep",
    {
      description:
        "Scan piped stdin line-by-line and return lines matching `pattern`. Prefer this over `read` when the question is 'find lines that mention X' — it filters server-side so you don't pull and decode 64 KiB base64 windows. Returns `{matches: [{cursor, line, before?, after?}], truncated, nextCursor, gap?, scannedBytes, eof?}`. Lines come back as decoded UTF-8 strings (not base64). When `truncated:true`, re-call with `cursor: nextCursor` to resume.",
      inputSchema: {
        pattern: z
          .string()
          .min(1)
          .describe(
            "Search pattern. Treated as a JavaScript regular expression by default (set `regex:false` for a literal substring match).",
          ),
        regex: z
          .boolean()
          .optional()
          .describe("Default true. Pass false to treat `pattern` as a literal substring."),
        case_insensitive: z
          .boolean()
          .optional()
          .describe("Default false. Pass true for case-insensitive matching."),
        invert: z
          .boolean()
          .optional()
          .describe("Default false. Pass true to return lines that do NOT match the pattern."),
        max_matches: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Default 100. Capped server-side at 1000."),
        max_bytes: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Default 64 KiB output. Capped server-side at 256 KiB."),
        context_before: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Default 0. Number of lines before each match to include (capped at 20)."),
        context_after: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Default 0. Number of lines after each match to include (capped at 20)."),
        cursor: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "Optional absolute byte offset to start scanning from. Omit to scan from the oldest still-resident byte. Pass the `nextCursor` from a previous truncated call to resume.",
          ),
      },
    },
    async (args) => {
      const opts: RawStreamGrepOptions = { pattern: args.pattern };
      if (args.regex !== undefined) {
        opts.regex = args.regex;
      }
      if (args.case_insensitive !== undefined) {
        opts.caseInsensitive = args.case_insensitive;
      }
      if (args.invert !== undefined) {
        opts.invert = args.invert;
      }
      if (args.max_matches !== undefined) {
        opts.maxMatches = args.max_matches;
      }
      if (args.max_bytes !== undefined) {
        opts.maxBytes = args.max_bytes;
      }
      if (args.context_before !== undefined) {
        opts.contextBefore = args.context_before;
      }
      if (args.context_after !== undefined) {
        opts.contextAfter = args.context_after;
      }
      if (args.cursor !== undefined) {
        opts.cursor = args.cursor;
      }
      const r = session.streamGrep(opts);
      return mcpJsonResult(r as unknown as Record<string, unknown>);
    },
  );

  server.registerTool(
    "info",
    {
      description:
        "Report cursor / capacity / closed state of the stdin ring. Cheap; safe to call repeatedly.",
      inputSchema: {},
    },
    async () => {
      const r = session.streamInfo();
      return mcpJsonResult(r);
    },
  );


  return server;
}

// Bound on how long to wait for a reservation's session to be completed.
// Covers the window where the token has been embedded in the agent's
// mcpServers but manager.create() hasn't returned yet. Agent spawn +
// initialize is well under a second in practice; 10s is conservative.
const SESSION_READY_TIMEOUT_MS = 10_000;

export function registerStdinMcpRoutes(
  app: FastifyInstance,
  tokenRegistry: McpTokenRegistry,
): void {
  // Per-registration lazy build cache. Lives for the lifetime of the
  // route registration (i.e. the daemon process). Tests get a fresh cache
  // per harness because they re-register.
  const builtPerToken = new Map<string, BuiltPair>();

  async function ensureTransport(
    token: string,
    session: Session,
  ): Promise<StreamableHTTPServerTransport> {
    const existing = builtPerToken.get(token);
    if (existing !== undefined) {
      return existing.transport;
    }
    const server = buildMcpServer(session);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });
    await server.connect(transport);
    const pair: BuiltPair = { server, transport };
    builtPerToken.set(token, pair);
    // Tear down on session end. Closing an already-closed transport or
    // server is harmless (the SDK swallows it), but we still wrap in
    // try/catch so a single failure doesn't leak the cache entry.
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
      reply.code(404).send({ error: "unknown stdin token" });
      return;
    }
    let session: Session;
    if (entry.session !== undefined) {
      session = entry.session;
    } else {
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
      session = resolved;
    }
    const transport = await ensureTransport(token, session);
    reply.hijack();
    await transport.handleRequest(req.raw, reply.raw, req.body);
  }

  const opts = { config: { skipAuth: true } };
  app.post("/mcp/hydra-acp-stdin", opts, async (req, reply) => {
    await handle(req, reply);
  });
  app.get("/mcp/hydra-acp-stdin", opts, async (req, reply) => {
    await handle(req, reply);
  });
  app.delete("/mcp/hydra-acp-stdin", opts, async (req, reply) => {
    await handle(req, reply);
  });
}
