// HTTP route + MCP server factory for piped-stdin sessions.
//
// The agent connects to /mcp/stdin with `Authorization: Bearer <token>`
// where the token was minted at session/new time and embedded in the
// `mcpServers` entry handed to the agent. We look the token up in the
// StdinMcpRegistry to recover the session, then lazily build an
// McpServer + StreamableHTTPServerTransport pair on the first request
// and reuse them for the session's lifetime so the agent's MCP state
// (initialize, list tools, in-flight long-polls) survives across
// requests.
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
import type { StdinMcpRegistry } from "./stdin-registry.js";

const BEARER_PREFIX = "Bearer ";

function extractBearer(req: FastifyRequest): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== "string") {
    return undefined;
  }
  if (!header.startsWith(BEARER_PREFIX)) {
    return undefined;
  }
  const token = header.slice(BEARER_PREFIX.length).trim();
  return token.length > 0 ? token : undefined;
}

function buildMcpServer(session: Session): McpServer {
  const server = new McpServer(
    { name: "hydra-stdin", version: "1.0.0" },
    {
      instructions:
        "Piped input from `hydra cat --stream` is exposed here as a byte stream. " +
        "Use `tail_stdin` for the latest N bytes (good for finding the end of a log), " +
        "`head_stdin` for the first N bytes (good for headers/preamble), " +
        "`read_stdin` for windowed reads against an absolute byte cursor, " +
        "`wait_for_more` to block until new bytes arrive past a cursor, and " +
        "`stdin_info` for the current cursors/capacity/closed status. " +
        "Byte payloads come back base64-encoded.",
    },
  );

  server.registerTool(
    "tail_stdin",
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
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(r),
          },
        ],
        structuredContent: r,
      };
    },
  );

  server.registerTool(
    "head_stdin",
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
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(r),
          },
        ],
        structuredContent: r,
      };
    },
  );

  server.registerTool(
    "read_stdin",
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
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(r),
          },
        ],
        structuredContent: r,
      };
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
      const payload = { outcome, writeCursor: info.writeCursor, closed: info.closed };
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(payload),
          },
        ],
        structuredContent: payload,
      };
    },
  );

  server.registerTool(
    "grep_stdin",
    {
      description:
        "Scan piped stdin line-by-line and return lines matching `pattern`. Prefer this over `read_stdin` when the question is 'find lines that mention X' — it filters server-side so you don't pull and decode 64 KiB base64 windows. Returns `{matches: [{cursor, line, before?, after?}], truncated, nextCursor, gap?, scannedBytes, eof?}`. Lines come back as decoded UTF-8 strings (not base64). When `truncated:true`, re-call with `cursor: nextCursor` to resume.",
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
      const payload = r as unknown as Record<string, unknown>;
      return {
        content: [{ type: "text", text: JSON.stringify(r) }],
        structuredContent: payload,
      };
    },
  );

  server.registerTool(
    "stdin_info",
    {
      description:
        "Report cursor / capacity / closed state of the stdin ring. Cheap; safe to call repeatedly.",
      inputSchema: {},
    },
    async () => {
      const r = session.streamInfo();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(r),
          },
        ],
        structuredContent: r,
      };
    },
  );

  return server;
}

async function ensureTransport(
  token: string,
  session: Session,
  registry: StdinMcpRegistry,
): Promise<StreamableHTTPServerTransport> {
  const existing = registry.lookup(token);
  if (existing?.transport !== undefined) {
    return existing.transport;
  }
  const server = buildMcpServer(session);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await server.connect(transport);
  registry.attachTransport(token, server, transport);
  return transport;
}

// Bound on how long to wait for a reservation's session to be completed.
// Covers the window where the token has been embedded in the agent's
// mcpServers but manager.create() hasn't returned yet. Agent spawn +
// initialize is well under a second in practice; 10s is conservative.
const SESSION_READY_TIMEOUT_MS = 10_000;

async function handle(
  req: FastifyRequest,
  reply: FastifyReply,
  registry: StdinMcpRegistry,
): Promise<void> {
  const token = extractBearer(req);
  if (token === undefined) {
    reply.code(401).send({ error: "missing bearer token" });
    return;
  }
  const ep = registry.lookup(token);
  if (ep === undefined) {
    reply.code(404).send({ error: "unknown stdin token" });
    return;
  }
  let session: Session;
  if (ep.session !== undefined) {
    session = ep.session;
  } else {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), SESSION_READY_TIMEOUT_MS);
    });
    const resolved = await Promise.race([
      ep.sessionReady.catch(() => undefined),
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
  const transport = await ensureTransport(token, session, registry);
  reply.hijack();
  await transport.handleRequest(req.raw, reply.raw, req.body);
}

export function registerStdinMcpRoutes(
  app: FastifyInstance,
  registry: StdinMcpRegistry,
): void {
  const opts = { config: { skipAuth: true } };
  app.post("/mcp/stdin", opts, async (req, reply) => {
    await handle(req, reply, registry);
  });
  app.get("/mcp/stdin", opts, async (req, reply) => {
    await handle(req, reply, registry);
  });
  app.delete("/mcp/stdin", opts, async (req, reply) => {
    await handle(req, reply, registry);
  });
}
