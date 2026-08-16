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
// Tool set is gated: search / range / tool_calls
// register only when session.summarizedThroughEntry > 0. Sessions that
// have never been compacted see an empty tool list from this server —
// the route still answers initialize / list_tools cleanly so the agent
// doesn't error, it just gets nothing useful. Once compaction runs and
// the swap mints a fresh token, the next request hits cache-miss and
// the rebuild registers the tools.
//
// History scope: recall tools consume session.getRecallHistorySnapshot(),
// which returns every spilled history.jsonl.N archive (gunzipped
// transparently) concatenated with the live history.jsonl. So the agent
// can reach turns that were trimmed off the live working set long ago,
// as long as the archives haven't rolled off the tier ring. Entry
// indices in this view are ephemeral: stable within one MCP session,
// but a tier eviction between calls can shift them. Not a concern in
// practice — tier evictions require hundreds of MB of write pressure —
// but callers should not persist entry ids across sessions.
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
import {
  type MergedToolCall,
  type SessionUpdate,
  normalizeToolName,
  readMetaToolName,
  readToolOutputText,
  renderTranscript,
} from "../../core/history-transcript.js";
import { classifyUpdate, mcpJsonResult } from "./helpers.js";
import { extractBearer } from "./bearer.js";
import type { McpTokenRegistry } from "./token-registry.js";

interface BuiltPair {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

// Mirrors the speaker classification helper inlined in stdin-server.ts
// for the `search` snippet metadata. Kept private because callers
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

// Per-call and whole-response ceilings on returned tool output. Sized
// off real sessions, where a whole session's output runs tens of KB and
// the largest single result is a couple of KB: generous enough that the
// common call returns complete, bounded enough that recalling twenty
// calls cannot blow the context the agent is trying to conserve.
const OUTPUT_PER_CALL_MAX_CHARS = 2_000;
const OUTPUT_TOTAL_MAX_CHARS = 20_000;

// Searchable text for one history entry.
//
// renderTranscript is the right renderer for conversation, but it is the
// wrong one for search over tool activity: it emits a tool line only for
// the opening `tool_call`, whose rawInput is empty, and drops
// tool_call_update entirely. Every command and every byte of output in a
// session was therefore invisible to `search`, which quietly reduced it
// to a search over assistant prose.
//
// Tool entries are matched against their own arguments and output instead,
// so a hit reports the entry that actually contains the text.
function renderEntryForSearch(
  entry: Parameters<typeof renderTranscript>[0][number],
  kind: string,
  update: Record<string, unknown>,
): string {
  if (kind !== "tool_call" && kind !== "tool_call_update") {
    return renderTranscript([entry]);
  }
  const parts: string[] = [];
  const name = readMetaToolName(update as SessionUpdate);
  if (name !== undefined) {
    parts.push(`Tool: ${name}`);
  } else if (typeof update.title === "string" && update.title.length > 0) {
    parts.push(`Tool: ${update.title}`);
  }
  const rawInput = update.rawInput;
  if (rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)) {
    for (const [key, value] of Object.entries(rawInput as Record<string, unknown>)) {
      if (typeof value === "string" && value.length > 0) {
        parts.push(`${key}=${value}`);
      }
    }
  }
  if (Array.isArray(update.locations)) {
    for (const loc of update.locations as Array<Record<string, unknown>>) {
      if (typeof loc?.path === "string" && loc.path.length > 0) {
        parts.push(loc.path);
      }
    }
  }
  const output = readToolOutputText(update as SessionUpdate);
  if (output !== undefined) {
    parts.push(output);
  }
  return parts.join("\n");
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
        "Use `search` to find entries by keyword, `range` to pull a contiguous slice verbatim, and `tool_calls` to enumerate prior tool invocations. " +
        "These tools only return results once the session has been compacted at least once.",
    },
  );

  // Always register the three recall tools so the MCP server's
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
      "search",
      {
        description:
          "Search this session's prior conversation history (the part that was compacted out of your working memory) by keyword. Covers assistant and user messages, the arguments of every tool call including full shell commands, and what those calls printed. Returns matching entry ids with short snippets so you can decide which to pull in full via `range`. Use this when the compaction summary mentions something but you need the verbatim detail.",
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
            note: "This session has no compacted history. `search` retrieves detail from entries that were summarized out of the working conversation; nothing has been summarized yet.",
          });
        }
        const matches: Array<{
          entryId: number;
          speaker: "user" | "agent" | "tool";
          snippet: string;
          timestamp?: string;
        }> = [];
        const needle = query.toLowerCase();
        // Newest-first streaming walk with early exit. The iterator opens
        // archives lazily — a query satisfied inside the live tail never
        // touches archive files at all.
        for await (const { entryId, entry } of session.iterRecallNewestFirst()) {
          const classified = classifyUpdate(entry);
          if (!classified) {
            continue;
          }
          const { kind, update } = classified;
          if ((kind === "tool_call" || kind === "tool_call_update") && !include_tool_calls) {
            continue;
          }
          const rendered = renderEntryForSearch(
            entry as unknown as Parameters<typeof renderTranscript>[0][number],
            kind,
            update,
          );
          const idx = rendered.toLowerCase().indexOf(needle);
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
        // Sort newest-first matches back into chronological order so
        // the response is stable regardless of walk direction.
        matches.sort((a, b) => a.entryId - b.entryId);
        // Truncation flag: hit the limit — there may be more matches we
        // stopped scanning for. Cheap to compute without a total count.
        const truncated = matches.length >= limit;
        return mcpJsonResult({ matches, total_matched: matches.length, truncated });
      },
    );

    server.registerTool(
      "range",
      {
        description:
          "Pull a contiguous range of prior conversation entries verbatim from this session's pre-compaction history, including each tool call's arguments and what it printed. Use after `search` narrows in on what you need. Capped at 50 entries per call.",
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
            note: "This session has no compacted history. `range` retrieves verbatim entries from the pre-compaction transcript; nothing has been compacted yet.",
          });
        }
        if (to_entry < from_entry) {
          throw new Error(
            `range: to_entry (${to_entry}) must be >= from_entry (${from_entry})`,
          );
        }
        const range_size = to_entry - from_entry + 1;
        if (range_size > 50) {
          throw new Error(
            `range: range size (${range_size}) exceeds maximum of 50 entries`,
          );
        }
        const total = await session.getRecallTotalCount();
        if (total === 0) {
          return mcpJsonResult({ text: "", entry_count: 0, truncated: false });
        }
        const clamped_from = Math.min(from_entry, total - 1);
        const clamped_to = Math.min(to_entry, total - 1);
        const truncated = clamped_from > from_entry || clamped_to < to_entry;
        if (clamped_from > clamped_to) {
          return {
            content: [{ type: "text", text: "" }],
            structuredContent: { text: "", entry_count: 0, truncated },
          };
        }
        // Slice fetches only the archives that overlap [from, to] and
        // streams them; a range near the live tail opens no archives.
        const slice = await session.sliceRecallHistory(clamped_from, clamped_to);
        // Output is included here but not in the seed: `range` is an
        // explicit pull, and without it `search` could match text that
        // the tool it points at could not then show.
        const text = renderTranscript(
          slice as unknown as Parameters<typeof renderTranscript>[0],
          {
            toolOutput: {
              maxPerCall: OUTPUT_PER_CALL_MAX_CHARS,
              maxTotal: OUTPUT_TOTAL_MAX_CHARS,
            },
          },
        );
        return {
          content: [{ type: "text", text }],
          structuredContent: { text, entry_count: slice.length, truncated },
        };
      },
    );

    server.registerTool(
      "tool_calls",
      {
        description:
          "Search this session's prior tool invocations by tool name, ACP kind, and/or file path. Returns when each tool was called, its arguments (including the full shell command), the result status, and what the call printed. Use this to recall which files were read/edited, what shell commands ran, and what they output.",
        inputSchema: {
          tool_name: z
            .string()
            .optional()
            .describe(
              "Case-insensitive substring of the tool name. Names vary by agent for the same tool (Bash, Terminal, bash), so prefer `kind` when you want every shell invocation.",
            ),
          kind: z
            .string()
            .optional()
            .describe(
              "ACP tool kind: execute (shell), read, edit, think, other. Agent-independent, unlike tool_name.",
            ),
          file_path: z.string().optional(),
          limit: z.number().int().min(1).max(100).optional(),
          include_output: z
            .boolean()
            .optional()
            .describe(
              "Include what each call printed (default true). Set false when you only need the commands and not their results.",
            ),
        },
      },
      async ({ tool_name, kind: kind_filter, file_path, limit = 20, include_output = true }) => {
        const session = await getSession();
        if (!session.summarizedThroughEntry || session.summarizedThroughEntry === 0) {
          return mcpJsonResult({
            calls: [],
            truncated: false,
            note: "This session has no compacted history. `tool_calls` retrieves tool invocations from the pre-compaction transcript; nothing has been compacted yet.",
          });
        }
        const hasToolName = typeof tool_name === "string" && tool_name.length > 0;
        const hasKind = typeof kind_filter === "string" && kind_filter.length > 0;
        const hasFilePath = typeof file_path === "string" && file_path.length > 0;
        if (!hasToolName && !hasKind && !hasFilePath) {
          throw new Error(
            "tool_calls: at least one of tool_name, kind, or file_path must be provided",
          );
        }
        // Coalesce tool_call + subsequent tool_call_update events for each
        // toolCallId. The initial tool_call typically ships with empty
        // rawInput; the real args (and locations[].path) arrive in
        // follow-up tool_call_update events. Merge them so filters see
        // the full picture.
        //
        // Streaming newest-first with early exit: once we have `limit`
        // completed calls (matching filters), we stop. Because we walk
        // backwards, the first tool_call_update we see for a given id
        // is the LATEST one (final status, most complete rawInput);
        // the initial tool_call event with the name lands last. We
        // merge symmetrically so ordering within an id doesn't matter.
        interface Merged {
          entryId: number;
          toolName: string;
          // Whether toolName came from a source that actually names the
          // tool, as opposed to the opening event's title. Agents rewrite
          // `title` to the command as a call runs, so a name taken from
          // any later event is the command wearing the name's slot.
          nameAuthoritative: boolean;
          kind?: string;
          rawInput: Record<string, unknown>;
          locations: string[];
          status: string;
          output?: string;
          timestamp?: string;
        }
        const merged = new Map<string, Merged>();
        // We only know a call is complete once we've walked past its
        // initial tool_call event, so we can't emit incrementally.
        // Instead we track how many *distinct* toolCallIds we've seen
        // and bail once we've collected ~2x the limit (rough guard
        // against pathological runs of updates without matching calls).
        const softCap = Math.max(limit * 4, 200);

        for await (const { entryId, entry } of session.iterRecallNewestFirst()) {
          const classified = classifyUpdate(entry);
          if (!classified) {
            continue;
          }
          const { kind, update } = classified;
          if (kind !== "tool_call" && kind !== "tool_call_update") {
            continue;
          }
          const id =
            typeof update.toolCallId === "string" && update.toolCallId.length > 0
              ? update.toolCallId
              : `__noid_${entryId}`;

          let m = merged.get(id);
          if (!m) {
            m = {
              entryId,
              toolName: "(unnamed)",
              nameAuthoritative: false,
              rawInput: {},
              locations: [],
              status: "in_progress",
            };
            merged.set(id, m);
          }
          // Keep the LOWEST entryId across all events for a call — that
          // matches the pre-streaming behavior (initial tool_call is
          // the anchor). Walking newest-first means the initial event
          // arrives last, so the smaller entryId always wins here.
          if (entryId < m.entryId) {
            m.entryId = entryId;
          }

          // Name resolution, in descending order of trust. The title
          // branch is gated on this being the OPENING event: walking
          // newest-first, an ungated "first title wins" lands on the
          // final update, whose title is the command text, and then no
          // tool_name filter can ever match it.
          if (!m.nameAuthoritative) {
            const metaName = readMetaToolName(update as SessionUpdate);
            if (metaName !== undefined) {
              m.toolName = metaName;
              m.nameAuthoritative = true;
            } else if (typeof update.name === "string" && update.name.length > 0) {
              m.toolName = update.name;
              m.nameAuthoritative = true;
            } else if (
              kind === "tool_call" &&
              typeof update.title === "string" &&
              update.title.length > 0
            ) {
              m.toolName = update.title;
              m.nameAuthoritative = true;
            }
          }

          if (m.kind === undefined && typeof update.kind === "string" && update.kind.length > 0) {
            m.kind = update.kind;
          }

          if (m.output === undefined) {
            const output = readToolOutputText(update as SessionUpdate);
            if (output !== undefined) {
              m.output = output;
            }
          }

          const ri = update.rawInput;
          if (ri && typeof ri === "object" && !Array.isArray(ri) && Object.keys(ri).length > 0) {
            for (const [k, v] of Object.entries(ri as Record<string, unknown>)) {
              // Newest-first walk means older tool_call_update writes
              // arrive later; don't overwrite a value we already have
              // (which is newer).
              if (m.rawInput[k] === undefined) {
                m.rawInput[k] = v;
              }
            }
          }

          if (Array.isArray(update.locations)) {
            for (const loc of update.locations as Array<Record<string, unknown>>) {
              const p = loc?.path;
              if (typeof p === "string" && p.length > 0 && !m.locations.includes(p)) {
                m.locations.push(p);
              }
            }
          }

          // First status we see (newest-first) is the final one — later
          // updates for the same call are earlier in wall-clock time.
          if (typeof update.status === "string" && m.status === "in_progress") {
            m.status = update.status;
          }

          if (entry.recordedAt !== undefined && m.timestamp === undefined) {
            m.timestamp = String(entry.recordedAt);
          }

          if (merged.size >= softCap) {
            break;
          }
        }

        // Emit oldest first (ascending entryId) to match pre-streaming
        // response ordering.
        const order = [...merged.keys()].sort(
          (a, b) => merged.get(a)!.entryId - merged.get(b)!.entryId,
        );

        const calls: Array<{
          entryId: number;
          tool: string;
          kind?: string;
          args: Record<string, unknown>;
          status: string;
          output?: string;
          outputBytes?: number;
          outputTruncated?: boolean;
          timestamp?: string;
        }> = [];
        let outputBudget = OUTPUT_TOTAL_MAX_CHARS;
        let outputBudgetExhausted = false;

        for (const id of order) {
          const m = merged.get(id)!;
          // The same rule the transcript renderer uses, so a name that is
          // really an echo of the command becomes its ACP kind here too.
          m.toolName = normalizeToolName({
            name: m.toolName,
            rawInput: m.rawInput,
            ...(m.kind !== undefined ? { kind: m.kind } : {}),
          } satisfies MergedToolCall);

          // Substring rather than equality: the same shell tool is "Bash"
          // to claude-acp, "Terminal" in its ACP title, and "bash" to
          // opencode, so an exact match makes the caller guess which
          // agent recorded the session.
          if (hasToolName && !m.toolName.toLowerCase().includes(tool_name!.toLowerCase())) {
            continue;
          }

          if (hasKind && (m.kind ?? "").toLowerCase() !== kind_filter!.toLowerCase()) {
            continue;
          }

          if (hasFilePath) {
            const fpLower = file_path!.toLowerCase();
            const pathKeys = ["file_path", "filePath", "path"];
            let pathMatch = false;
            for (const key of pathKeys) {
              const value = m.rawInput[key];
              if (typeof value === "string" && value.toLowerCase().includes(fpLower)) {
                pathMatch = true;
                break;
              }
            }
            if (!pathMatch) {
              for (const p of m.locations) {
                if (p.toLowerCase().includes(fpLower)) {
                  pathMatch = true;
                  break;
                }
              }
            }
            if (!pathMatch) {
              continue;
            }
          }

          const args: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(m.rawInput)) {
            if (typeof value === "string") {
              args[key] = value.length > 500 ? value.slice(0, 497) + "\u2026" : value;
            } else if (typeof value === "number" || typeof value === "boolean") {
              args[key] = value;
            }
          }
          if (m.locations.length > 0 && args.locations === undefined) {
            args.locations = m.locations;
          }

          const call: (typeof calls)[number] = {
            entryId: m.entryId,
            tool: m.toolName,
            args,
            status: m.status,
            timestamp: m.timestamp,
          };
          if (m.kind !== undefined) {
            call.kind = m.kind;
          }
          if (include_output && m.output !== undefined) {
            const full = m.output;
            const room = Math.min(OUTPUT_PER_CALL_MAX_CHARS, outputBudget);
            if (room <= 0) {
              outputBudgetExhausted = true;
            } else {
              const kept = full.length <= room ? full : full.slice(0, room - 1) + "…";
              call.output = kept;
              call.outputBytes = full.length;
              call.outputTruncated = kept.length < full.length;
              outputBudget -= kept.length;
            }
          }
          calls.push(call);

          if (calls.length >= limit) {
            break;
          }
        }

        const truncated = calls.length >= limit;
        return mcpJsonResult({
          calls,
          truncated,
          ...(outputBudgetExhausted ? { outputBudgetExhausted } : {}),
        });
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
