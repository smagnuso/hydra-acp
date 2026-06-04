import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { nanoid } from "nanoid";
import { JsonRpcConnection } from "../acp/connection.js";
import { wsToMessageStream } from "../acp/ws-stream.js";
import { SessionManager, type ResurrectParams } from "../core/session-manager.js";
import { resolveModelId } from "../core/model-resolve.js";
import { Session, type AttachedClient } from "../core/session.js";
import {
  AmendPromptParams,
  CancelPromptParams,
  InitializeParams,
  SessionAttachParams,
  SessionCancelParams,
  SessionDetachParams,
  SessionListParams,
  SessionNewParams,
  SessionPromptParams,
  UpdatePromptParams,
  extractHydraMeta,
  HYDRA_META_KEY,
  mergeMeta,
  sessionListEntryToWire,
  buildHydraSessionMeta,
  type LiveSessionMetaExtras,
  type SessionListEntry,
  type InitializeResult,
  type SessionListResult,
  JsonRpcErrorCodes,
  ACP_PROTOCOL_VERSION,
  AGENT_INSTALL_PROGRESS_METHOD,
  type AgentInstallProgressParams,
} from "../acp/types.js";
import { listAgents, type AgentInstallProgress, type Registry } from "../core/registry.js";
import {
  tokenFromUpgradeRequest,
  type TokenValidator,
  type ProcessTokenRegistry,
  type ProcessIdentity,
} from "./auth.js";
import type { TransformerManager, TransformerRef } from "../core/transformer-manager.js";
import type {
  ExtensionCommandRegistry,
  ExtensionCommandSpec,
} from "../core/extension-commands.js";
import type {
  ExtensionMcpRegistry,
  ExtensionMcpToolSpec,
} from "../core/extension-mcp.js";
import { HYDRA_CAT_CLIENT_NAME, HYDRA_VERSION } from "../core/hydra-version.js";
import { randomBytes } from "node:crypto";
import type { McpTokenRegistry } from "./mcp/token-registry.js";

interface ClientState {
  clientId: string;
  processIdentity: ProcessIdentity | undefined;
  // clientInfo from the connection's initialize call. Threaded into
  // manager.create on session/new so the originating process is
  // persisted with the session (used by list-view filters).
  clientInfo?: { name: string; version?: string };
  attached: Map<
    string,
    {
      sessionId: string;
      clientId: string;
      // When true, this attachment was made with SessionAttachParams.readonly.
      // Mutating JSON-RPC methods (session/prompt, session/cancel, etc.)
      // sent for this sessionId from this connection are rejected with
      // PermissionDenied (-32011).
      readonly: boolean;
    }
  >;
}

export interface AcpWsDeps {
  validator: TokenValidator;
  manager: SessionManager;
  defaultAgent: string;
  // When provided, used to resolve per-process identity (name, kind) from
  // the connection token. Enables kind-based method gating and version
  // reporting back to extension/transformer managers.
  processRegistry?: ProcessTokenRegistry;
  // Callbacks for version reporting after a process calls initialize with
  // clientInfo.version. Called at most once per connection.
  onExtensionVersion?: (name: string, version: string) => void;
  onTransformerVersion?: (name: string, version: string) => void;
  // TransformerManager for registering transformer connections after
  // hydra-acp/transformer/initialize completes.
  transformers?: TransformerManager;
  // Daemon-wide registry of process-name → registered command list.
  // The hydra-acp/commands/register handler binds the connection here so
  // Session.handleSlashCommand can later route "/hydra <name> <verb>"
  // calls back to the originating extension/transformer.
  extensionCommands?: ExtensionCommandRegistry;
  // Shared per-session MCP bearer-token registry. Used by stdin streaming
  // (`hydra cat --stream`, when `_meta.hydra-acp.mcpStdin: true`) and the
  // extension MCP plug-point.
  mcpTokenRegistry?: McpTokenRegistry;
  // Daemon-wide registry of extension-contributed MCP servers. The
  // hydra-acp/mcp_tools/register handler binds the registration here so
  // /mcp/<extension-name> resolves to the right connection.
  extensionMcp?: ExtensionMcpRegistry;
  // Lazy getter for the daemon's externally-reachable origin (scheme +
  // host + port). Lazy because the bound port isn't known until after
  // `app.listen` returns, which happens after this registration runs.
  getDaemonOrigin?: () => string;
  // Agent registry, exposed over ACP via `hydra-acp/agents/list` so a
  // protocol-only client can enumerate selectable agents without the
  // REST `GET /v1/agents` endpoint.
  registry?: Registry;
}

export function registerAcpWsEndpoint(
  app: FastifyInstance,
  deps: AcpWsDeps,
): void {
  app.get("/acp", { websocket: true }, async (socket: WebSocket, request) => {
    const token = tokenFromUpgradeRequest({
      headers: request.headers as NodeJS.Dict<string | string[]>,
      url: request.url,
    });
    if (!token || !(await deps.validator.validate(token))) {
      socket.close(4401, "Unauthorized");
      return;
    }

    const processIdentity = deps.processRegistry?.resolve(token);

    const stream = wsToMessageStream(socket);
    const connection = new JsonRpcConnection(stream);
    const state: ClientState = {
      clientId: `hydra_client_${nanoid(12)}`,
      processIdentity,
      attached: new Map(),
    };

    connection.onClose(() => {
      for (const att of state.attached.values()) {
        const session = deps.manager.get(att.sessionId);
        // Viewer attachments have no Session in manager.sessions — the
        // get() returns undefined and detach is a no-op. Only live and
        // resurrected sessions actually need the detach call.
        session?.detach(att.clientId);
      }
      state.attached.clear();
      // NB: we deliberately do NOT reap on raw WS close. `cat` always
      // closes its socket on exit but only sends session/detach when not
      // --detach (cat.ts), so reaping here would tear down --detach
      // sessions too. Reaping lives in the session/detach handler, which
      // only non-detach cat reaches — matching cat's documented
      // "closed pipe takes the session with it; --detach keeps it."
    });

    // Refuse mutating JSON-RPC methods on a read-only attachment.
    // Caller passes the sessionId from the request params; the
    // per-attachment readonly bit (set during session/attach) decides.
    // No-op for connections that haven't attached to that session, or
    // attached non-readonly — existing checks downstream handle those.
    const denyIfReadonly = (sessionId: string, method: string): void => {
      const att = state.attached.get(sessionId);
      if (att?.readonly) {
        const err = new Error(
          `${method} not permitted on a read-only attachment`,
        ) as Error & { code: number };
        err.code = JsonRpcErrorCodes.PermissionDenied;
        throw err;
      }
    };

    connection.onRequest("initialize", async (raw) => {
      const params = InitializeParams.parse(raw ?? {});
      // Capture clientInfo so a later session/new on this connection can
      // tag the session with its originating process. Hydra-internal CLI
      // commands (and clients like hydra-acp-cat) set clientInfo.name on
      // initialize; the picker / `sessions list` use it to hide
      // ancillary sessions by default.
      if (params.clientInfo?.name) {
        state.clientInfo = {
          name: params.clientInfo.name,
          ...(params.clientInfo.version !== undefined
            ? { version: params.clientInfo.version }
            : {}),
        };
      }
      // If the connecting process reported a version and the daemon knows its
      // identity, push the version back to the appropriate manager.
      const version = params.clientInfo?.version;
      if (version && processIdentity) {
        if (processIdentity.kind === "extension") {
          deps.onExtensionVersion?.(processIdentity.name, version);
        } else {
          deps.onTransformerVersion?.(processIdentity.name, version);
        }
      }
      return buildInitializeResult();
    });

    // Extensions and transformers register slash-command verbs they handle
    // via this method. Once registered, "/hydra <process-name> <verb>"
    // typed in any session routes to this connection as a
    // hydra-acp/commands/invoke request. Registrations drop on
    // disconnect — Session sees the entry vanish from the registry.
    // Re-calling overwrites the prior registration for this name.
    if (processIdentity && deps.extensionCommands) {
      const registry = deps.extensionCommands;
      connection.onRequest("hydra-acp/commands/register", async (raw) => {
        const params = (raw ?? {}) as { commands?: unknown };
        const commands = Array.isArray(params.commands)
          ? (params.commands
              .map((c): ExtensionCommandSpec | undefined => {
                if (!c || typeof c !== "object") {
                  return undefined;
                }
                const obj = c as {
                  verb?: unknown;
                  argsHint?: unknown;
                  description?: unknown;
                };
                if (typeof obj.verb !== "string" || obj.verb.length === 0) {
                  return undefined;
                }
                const spec: ExtensionCommandSpec = { verb: obj.verb };
                if (typeof obj.argsHint === "string") {
                  spec.argsHint = obj.argsHint;
                }
                if (typeof obj.description === "string") {
                  spec.description = obj.description;
                }
                return spec;
              })
              .filter((s): s is ExtensionCommandSpec => s !== undefined))
          : [];
        registry.register(processIdentity.name, connection, commands);
        return { ok: true, registered: commands.length };
      });
      connection.onClose(() => {
        registry.clear(processIdentity.name);
      });
    }

    // Extensions and transformers register MCP tools they handle via this
    // method. Once registered, /mcp/<process-name> routes inbound MCP
    // requests back to this connection as hydra-acp/mcp_tools/invoke.
    // Registrations drop on disconnect — the route's onChange listener
    // evicts any cached transports built against the old spec. Re-calling
    // overwrites the prior tools/instructions for this name.
    if (processIdentity && deps.extensionMcp) {
      const mcpRegistry = deps.extensionMcp;
      connection.onRequest("hydra-acp/mcp_tools/register", async (raw) => {
        const params = (raw ?? {}) as {
          instructions?: unknown;
          tools?: unknown;
        };
        const instructions =
          typeof params.instructions === "string"
            ? params.instructions
            : undefined;
        const tools = Array.isArray(params.tools)
          ? (params.tools
              .map((t): ExtensionMcpToolSpec | undefined => {
                if (!t || typeof t !== "object") {
                  return undefined;
                }
                const obj = t as {
                  name?: unknown;
                  description?: unknown;
                  inputSchema?: unknown;
                  outputSchema?: unknown;
                };
                if (typeof obj.name !== "string" || obj.name.length === 0) {
                  return undefined;
                }
                if (typeof obj.description !== "string") {
                  return undefined;
                }
                if (
                  obj.inputSchema === null ||
                  typeof obj.inputSchema !== "object"
                ) {
                  return undefined;
                }
                const spec: ExtensionMcpToolSpec = {
                  name: obj.name,
                  description: obj.description,
                  inputSchema: obj.inputSchema as object,
                };
                if (
                  obj.outputSchema !== null &&
                  typeof obj.outputSchema === "object"
                ) {
                  spec.outputSchema = obj.outputSchema as object;
                }
                return spec;
              })
              .filter((s): s is ExtensionMcpToolSpec => s !== undefined))
          : [];
        if (tools.length === 0) {
          throw new Error("register_mcp_tools requires at least one tool");
        }
        mcpRegistry.register(
          processIdentity.name,
          connection,
          instructions,
          tools,
        );
        return { ok: true, registered: tools.length };
      });
      connection.onClose(() => {
        mcpRegistry.clear(processIdentity.name);
      });
    }

    // hydra-acp/transformer/initialize is only registered for transformer connections.
    // Extension and client connections receive MethodNotFound if they attempt
    // to call it, enforcing the kind boundary at the method-registration layer.
    if (processIdentity?.kind === "transformer") {
      connection.onRequest("hydra-acp/transformer/initialize", async (raw) => {
        const params = (raw ?? {}) as {
          intercepts?: unknown;
          transformerConfig?: unknown;
        };
        const intercepts = Array.isArray(params.intercepts)
          ? (params.intercepts as unknown[]).filter(
              (v): v is string => typeof v === "string",
            )
          : [];
        if (deps.transformers) {
          deps.transformers.registerConnection(
            processIdentity.name,
            connection,
            intercepts,
          );
          // Retroactively wire into live sessions that use this transformer
          // by default. Covers sessions that opened before the transformer
          // process was ready (daemon restart, transformer crash+recovery).
          if (deps.manager?.defaultTransformers.includes(processIdentity.name)) {
            const ref = deps.transformers.resolveChain([processIdentity.name])[0];
            if (ref) {
              for (const session of deps.manager.liveSessions()) {
                session.addTransformer(ref);
              }
            }
          }
        }
        return { ack: true };
      });

      connection.onClose(() => {
        deps.transformers?.deregisterConnection(processIdentity.name);
      });

      // Outbox: transformer emits an ACP message back into the system.
      connection.onRequest("hydra-acp/message/emit", async (raw) => {
        const params = (raw ?? {}) as {
          sessionId?: unknown;
          method?: unknown;
          envelope?: unknown;
          route?: unknown;
          respondsTo?: unknown;
        };
        const sessionId = typeof params.sessionId === "string" ? params.sessionId : undefined;
        const method = typeof params.method === "string" ? params.method : undefined;
        const envelope = params.envelope;
        const route = params.route;

        if (!sessionId || !method) {
          throw Object.assign(new Error("emit_message requires sessionId and method"), { code: -32602 });
        }

        const session = deps.manager.get(sessionId);
        if (!session) {
          throw Object.assign(new Error(`session ${sessionId} not found`), { code: JsonRpcErrorCodes.SessionNotFound });
        }

        // respondsTo discharges an outstanding processing claim regardless of
        // route. The result is delivered to the original requester.
        const respondsTo = typeof params.respondsTo === "string"
          ? params.respondsTo
          : undefined;
        if (respondsTo) {
          session.dischargeClaim(respondsTo, envelope);
          return { ok: true };
        }

        if (route === "chain") {
          const response = await session.emitToChain(processIdentity.name, method, envelope);
          // Surface the agent's response (for request methods) so the
          // transformer can use it — typically to discharge a parked
          // processing claim with the modified prompt's actual result.
          // `undefined` for session/update notifications.
          return { ok: true, response };
        }

        if (route === "daemon") {
          const response = await session.emitToChain(processIdentity.name, method, envelope);
          return { ok: true, response };
        }

        throw Object.assign(new Error(`unsupported route: ${JSON.stringify(route)}`), { code: -32602 });
      });

      // Attach the calling transformer to an existing session's chain.
      // Mirror of the `transformers` field in `session/new`'s _meta, but
      // as a runtime call. Lets transformers self-install when their
      // slash command fires on a session that wasn't configured to
      // include them in defaultTransformers — the invocation itself is
      // the opt-in.
      //
      // A transformer can ONLY attach itself. The ref is resolved from
      // processIdentity.name (set at connection time), not from any
      // field in the request — so a transformer cannot inject a
      // different transformer into a session's chain via this method.
      //
      // Idempotent: addTransformer checks for existing entries by name
      // and updates rather than duplicating.
      connection.onRequest("hydra-acp/transformer/attach", async (raw) =>
        handleTransformerAttach(raw, processIdentity.name, deps),
      );

      // Spawn a child session on behalf of the transformer. Returns the new
      // session's hydra id so the transformer can await or close it later.
      connection.onRequest("hydra-acp/child_session/spawn", async (raw) => {
        const params = (raw ?? {}) as {
          agentId?: unknown;
          cwd?: unknown;
          parentSessionId?: unknown;
          interactive?: unknown;
        };
        const agentId = typeof params.agentId === "string"
          ? params.agentId
          : deps.defaultAgent;
        let cwd = typeof params.cwd === "string"
          ? params.cwd
          : undefined;
        const parentSessionId = typeof params.parentSessionId === "string"
          ? params.parentSessionId
          : undefined;

        // Inherit cwd from the parent when omitted. The common transformer
        // pattern is "spawn a child in the same place as my parent"; the
        // alternative forces the transformer to fetch the parent's cwd
        // through a separate round-trip just to echo it back.
        if (!cwd && parentSessionId) {
          const parent = deps.manager.get(parentSessionId);
          if (parent) {
            cwd = parent.cwd;
          }
        }

        if (!cwd) {
          throw Object.assign(
            new Error(
              "child_session/spawn requires cwd (or a parentSessionId pointing at a live session whose cwd we can inherit)",
            ),
            { code: -32602 },
          );
        }

        // Children spawned by transformers are non-interactive by default:
        // they exist to do automated work driven by the transformer, not
        // to host a human at a composer. This keeps them out of the
        // default `hydra-acp session` listing (visible only via --all).
        // The transformer can override via the `interactive` param if it
        // wants the child to be promotable to a normal session.
        const interactive =
          typeof params.interactive === "boolean"
            ? params.interactive
            : false;
        const child = await deps.manager.create({
          agentId,
          cwd,
          parentSessionId,
          interactive,
          transformChain: [], // children start with no chain by default
        });
        return { childSessionId: child.sessionId };
      });

      // Branch a local session into a new one that shares context up to
      // the chosen turn boundary. forkAt defaults to the latest
      // turn_complete; agentId defaults to the source's agent; cwd
      // defaults to the source's cwd. The new session is written with
      // upstreamSessionId="" so its first attach triggers seedFromImport
      // (same wire shape as an imported session).
      connection.onRequest("hydra-acp/session/fork", async (raw) => {
        const params = (raw ?? {}) as {
          sessionId?: unknown;
          forkAt?: unknown;
          cwd?: unknown;
          agentId?: unknown;
        };
        if (typeof params.sessionId !== "string") {
          throw Object.assign(
            new Error("fork_session requires sessionId"),
            { code: JsonRpcErrorCodes.InvalidParams },
          );
        }
        const forkAt = typeof params.forkAt === "string" ? params.forkAt : undefined;
        const cwd = typeof params.cwd === "string" ? params.cwd : undefined;
        const agentId = typeof params.agentId === "string" ? params.agentId : undefined;
        return await deps.manager.forkSession(params.sessionId, {
          ...(forkAt !== undefined ? { forkAt } : {}),
          ...(cwd !== undefined ? { cwd } : {}),
          ...(agentId !== undefined ? { agentId } : {}),
        });
      });

      // Delete a session record (and, if live, close the agent first).
      // Mirror the HTTP DELETE /v1/sessions/:id route so ACP clients
      // (TUI, slack, future extensions) can purge a session without
      // dropping to the REST API. Persists a tombstone via
      // SessionManager so the periodic agent sync doesn't reimport the
      // upstream session under a fresh hydra id.
      connection.onRequest("hydra-acp/session/delete", async (raw) => {
        const params = (raw ?? {}) as { sessionId?: unknown };
        if (typeof params.sessionId !== "string") {
          throw Object.assign(
            new Error("hydra-acp/session/delete requires sessionId"),
            { code: JsonRpcErrorCodes.InvalidParams },
          );
        }
        const id =
          (await deps.manager.resolveCanonicalId(params.sessionId)) ??
          params.sessionId;
        const live = deps.manager.get(id);
        if (live) {
          await live.close({ deleteRecord: true });
          return { deleted: true, sessionId: id };
        }
        const removed = await deps.manager.deleteRecord(id);
        if (!removed) {
          throw Object.assign(
            new Error(`session ${id} not found`),
            { code: JsonRpcErrorCodes.SessionNotFound },
          );
        }
        return { deleted: true, sessionId: id };
      });

      connection.onRequest("hydra-acp/child_session/await", async (raw) => {
        const params = (raw ?? {}) as {
          childSessionId?: unknown;
          until?: unknown;
          timeoutMs?: unknown;
        };
        const childSessionId = typeof params.childSessionId === "string"
          ? params.childSessionId
          : undefined;
        const until = params.until === "idle" ? "idle" : "turn_complete";
        const timeoutMs = typeof params.timeoutMs === "number"
          ? Math.min(params.timeoutMs, 30 * 60_000)
          : 5 * 60_000;

        if (!childSessionId) {
          throw Object.assign(new Error("await_child requires childSessionId"), { code: -32602 });
        }
        const child = deps.manager.get(childSessionId);
        if (!child) {
          throw Object.assign(
            new Error(`child session ${childSessionId} not found`),
            { code: JsonRpcErrorCodes.SessionNotFound },
          );
        }

        return new Promise((resolve) => {
          const entries: unknown[] = [];
          let unsubscribe: (() => void) | undefined;

          const finish = (): void => {
            clearTimeout(timer);
            unsubscribe?.();
            resolve({ entries });
          };

          // Collect recordable updates; resolve when the stop condition fires.
          unsubscribe = child.onBroadcast((entry) => {
            entries.push(entry);
            if (until === "turn_complete") {
              const upd = (entry.params as { update?: { sessionUpdate?: string } } | undefined)
                ?.update;
              if (upd?.sessionUpdate === "turn_complete") {
                finish();
              }
            }
          });

          // For "idle", the transformer will also receive session.idle via
          // hydra-acp/transformer/session_event on the child's chain. await_child with
          // until:"idle" times out if no activity and the child closes naturally.

          const timer = setTimeout(finish, timeoutMs);
          if (typeof timer.unref === "function") {
            timer.unref();
          }

          // Also resolve if the child session closes.
          child.onClose(() => finish());
        });
      });

      connection.onRequest("hydra-acp/child_session/close", async (raw) => {
        const params = (raw ?? {}) as { childSessionId?: unknown };
        const childSessionId = typeof params.childSessionId === "string"
          ? params.childSessionId
          : undefined;
        if (!childSessionId) {
          throw Object.assign(new Error("close_child_session requires childSessionId"), { code: -32602 });
        }
        const child = deps.manager.get(childSessionId);
        if (child) {
          await child.close({ deleteRecord: false });
        }
        return { ok: true };
      });

      // Keep-alive: resets the abandonment timer for an outstanding processing claim.
      connection.onRequest("hydra-acp/connection/keep_alive", async (raw) => {
        const params = (raw ?? {}) as {
          token?: unknown;
          sessionId?: unknown;
          estimatedRemainingMs?: unknown;
        };
        const token = typeof params.token === "string" ? params.token : undefined;
        const sessionId = typeof params.sessionId === "string" ? params.sessionId : undefined;
        const estimatedRemainingMs = typeof params.estimatedRemainingMs === "number"
          ? params.estimatedRemainingMs
          : undefined;
        if (token && sessionId) {
          const session = deps.manager.get(sessionId);
          session?.keepAliveClaim(token, estimatedRemainingMs);
        }
        return { ok: true };
      });
    }

    // Fetch one externalized tool-content body by sha256 (the lean
    // `toolContent: "references"` fetch-on-expand path). Mirrors the REST
    // GET /v1/sessions/:id/tools/:hash but over the client's existing WS
    // connection, which is the channel the TUI has. Registered for every
    // client connection (not just transformers).
    connection.onRequest("hydra-acp/session/tool_content", async (raw) => {
      const params = (raw ?? {}) as { sessionId?: unknown; hash?: unknown };
      if (typeof params.sessionId !== "string" || typeof params.hash !== "string") {
        throw Object.assign(
          new Error("hydra-acp/session/tool_content requires sessionId and hash"),
          { code: JsonRpcErrorCodes.InvalidParams },
        );
      }
      const id =
        (await deps.manager.resolveCanonicalId(params.sessionId)) ??
        params.sessionId;
      const content = await deps.manager.loadToolBlob(id, params.hash);
      if (content === null) {
        throw Object.assign(
          new Error("tool content not found"),
          { code: JsonRpcErrorCodes.SessionNotFound },
        );
      }
      return { content };
    });

    connection.onRequest("session/new", async (raw) => {
      const params = SessionNewParams.parse(raw);
      const hydraMeta = extractHydraMeta(
        (raw as { _meta?: Record<string, unknown> } | undefined)?._meta,
      );
      // Resolve transformer chain: prefer names from the client's _meta,
      // fall back to the daemon's defaultTransformers config.
      const transformerNames =
        Array.isArray(hydraMeta.transformers) &&
        hydraMeta.transformers.every((t): t is string => typeof t === "string")
          ? (hydraMeta.transformers as string[])
          : (deps.manager.defaultTransformers ?? []);
      const transformChain = deps.transformers?.resolveChain(transformerNames) ?? [];
      // If the client requested in-memory stdin streaming, mint a bearer
      // token now and inject an HTTP MCP descriptor into the agent's
      // mcpServers so the agent sees a `hydra-acp-stdin` server with the
      // tail/read/wait/info tools.
      //
      // We must RESERVE the token in the registry BEFORE manager.create
      // returns: claude-acp eagerly initializes MCP servers during
      // session/new (inside manager.create), so the agent's first
      // request to /mcp/hydra-acp-stdin lands while we're still awaiting the
      // session. The route handler awaits the reservation's
      // sessionReady promise, which we resolve via complete() once the
      // session object exists.
      let stdinToken: string | undefined;
      let stdinReservation: { complete: (s: Session) => void; abandon: (e?: Error) => void } | undefined;
      let augmentedMcpServers = params.mcpServers;
      if (
        hydraMeta.mcpStdin === true &&
        deps.mcpTokenRegistry !== undefined &&
        deps.getDaemonOrigin !== undefined
      ) {
        stdinToken = randomBytes(32).toString("hex");
        stdinReservation = deps.mcpTokenRegistry.reserve(stdinToken);
        const url = `${deps.getDaemonOrigin()}/mcp/hydra-acp-stdin`;
        const descriptor = {
          name: "hydra-acp-stdin",
          type: "http",
          url,
          headers: [
            { name: "Authorization", value: `Bearer ${stdinToken}` },
          ],
        };
        augmentedMcpServers = [...(params.mcpServers ?? []), descriptor];
      }
      // Mint one per-session token covering every currently-registered
      // extension MCP server, and append one descriptor per extension.
      // Same reserve→complete/abandon pattern as stdin: claude-acp eagerly
      // initializes mcpServers during session/new, so the agent's first
      // /mcp/<extname> request can land before manager.create returns.
      // Late-registered extensions are invisible to this session — same
      // posture as register_commands today.
      let extMcpToken: string | undefined;
      let extMcpReservation:
        | { complete: (s: Session) => void; abandon: (e?: Error) => void }
        | undefined;
      if (
        deps.extensionMcp !== undefined &&
        deps.mcpTokenRegistry !== undefined &&
        deps.getDaemonOrigin !== undefined
      ) {
        const extNames = deps.extensionMcp.list();
        if (extNames.length > 0) {
          extMcpToken = randomBytes(32).toString("hex");
          extMcpReservation = deps.mcpTokenRegistry.reserve(extMcpToken);
          const origin = deps.getDaemonOrigin();
          const descriptors = extNames.map((name) => ({
            name,
            type: "http",
            url: `${origin}/mcp/${name}`,
            headers: [
              { name: "Authorization", value: `Bearer ${extMcpToken}` },
            ],
          }));
          augmentedMcpServers = [
            ...(augmentedMcpServers ?? []),
            ...descriptors,
          ];
        }
      }
      let session: Session;
      try {
        session = await deps.manager.create({
          cwd: params.cwd,
          agentId: hydraMeta.agentId ?? deps.defaultAgent,
          mcpServers: augmentedMcpServers,
          title: hydraMeta.title,
          agentArgs: hydraMeta.agentArgs,
          model: hydraMeta.model,
          onInstallProgress: makeInstallProgressForwarder(connection),
          transformChain,
          originatingClient: state.clientInfo,
          ...(hydraMeta.interactive !== undefined
            ? { interactive: hydraMeta.interactive }
            : {}),
        });
      } catch (err) {
        if (stdinReservation !== undefined) {
          stdinReservation.abandon(err instanceof Error ? err : undefined);
        }
        if (extMcpReservation !== undefined) {
          extMcpReservation.abandon(err instanceof Error ? err : undefined);
        }
        throw err;
      }
      if (
        stdinToken !== undefined &&
        stdinReservation !== undefined &&
        deps.mcpTokenRegistry !== undefined
      ) {
        const token = stdinToken;
        const registry = deps.mcpTokenRegistry;
        stdinReservation.complete(session);
        session.onClose(() => {
          void registry.unbind(token);
        });
      }
      if (
        extMcpToken !== undefined &&
        extMcpReservation !== undefined &&
        deps.mcpTokenRegistry !== undefined
      ) {
        const token = extMcpToken;
        const registry = deps.mcpTokenRegistry;
        extMcpReservation.complete(session);
        session.onClose(() => {
          void registry.unbind(token);
        });
      }
      const client = bindClientToSession(connection, session, state);
      // No conversation history to replay on a fresh session, but
      // buildStateSnapshotReplay() still emits synthetic state snapshots
      // (at minimum the hydra verbs in available_commands_update) so a
      // protocol-only client sees the current command set right after
      // session/new — without depending on hydra's `_meta`.
      const { entries: replay } = await session.attach(client, "full");
      state.attached.set(session.sessionId, {
        sessionId: session.sessionId,
        clientId: client.clientId,
        readonly: false,
      });
      // Defer until after the response goes out. On session/new the
      // client only learns the new sessionId from the response, so
      // session/update notifications fired *before* the response would
      // refer to a session the client hasn't registered yet — well-behaved
      // JSON-RPC clients (agent-shell, Zed) drop those as "for unknown
      // session". setImmediate runs once the current request handler has
      // returned and the framework has flushed the response.
      setImmediate(() => {
        void (async () => {
          for (const note of replay) {
            await connection
              .notify(note.method, note.params)
              .catch(() => undefined);
          }
        })();
      });
      const modesPayload = buildModesPayload(session);
      const modelsPayload = buildModelsPayload(session);
      return {
        sessionId: session.sessionId,
        ...(modesPayload ? { modes: modesPayload } : {}),
        ...(modelsPayload ? { models: modelsPayload } : {}),
        configOptions: session.buildConfigOptions(),
        // session/new is a core ACP spec method, so the per-attachment
        // clientId rides under _meta["hydra-acp"] rather than top-level.
        // Deferred-echo clients (TUI's queue work) read it from there to
        // recognize their own prompt_queue_added events.
        _meta: buildResponseMeta(deps.manager, session, {
          clientId: client.clientId,
        }),
      };
    });

    connection.onRequest("session/attach", async (raw) => {
      const params = SessionAttachParams.parse(raw);
      // Some extensions (slack, notifier) send clientInfo.version here rather
      // than in initialize — capture it either way.
      const attachVersion = (params as { clientInfo?: { version?: string } })
        .clientInfo?.version;
      if (attachVersion && processIdentity) {
        if (processIdentity.kind === "extension") {
          deps.onExtensionVersion?.(processIdentity.name, attachVersion);
        } else {
          deps.onTransformerVersion?.(processIdentity.name, attachVersion);
        }
      }
      // Hydra-specific attach options ride under _meta["hydra-acp"], not
      // top-level — session/attach exposes only RFD #533's own fields at
      // the top level.
      const hydraAttach = extractHydraMeta(params._meta);
      const hydraHints = hydraAttach.resume;
      const readonly = hydraAttach.readonly === true;
      app.log.info(
        `session/attach sessionId=${params.sessionId} hasResumeHints=${!!hydraHints} readonly=${readonly}`,
      );
      // Without explicit hydraHints (the shim's reconnect path provides
      // the canonical id), the session id may have been typed by a human
      // from `sessions list` — accept the prefix-stripped form by resolving
      // to whichever form actually exists.
      const lookupId = hydraHints
        ? params.sessionId
        : (await deps.manager.resolveCanonicalId(params.sessionId)) ??
          params.sessionId;
      let session = deps.manager.get(lookupId);
      // Read-only viewer path: cold session + readonly=true streams
      // history from disk without resurrecting an agent. The connection
      // gets a viewer attachment in state.attached (readonly=true) so
      // session/detach and onClose cleanup work uniformly, and so
      // denyIfReadonly is in effect for any subsequent mutating method.
      // No Session object is created in manager.sessions; the session
      // stays cold.
      if (!session && readonly) {
        const fromDisk = await deps.manager.loadFromDisk(lookupId);
        if (!fromDisk) {
          const err = new Error(
            `session ${params.sessionId} not found`,
          ) as Error & { code: number };
          err.code = JsonRpcErrorCodes.SessionNotFound;
          throw err;
        }
        const history = await deps.manager.loadHistory(lookupId);
        const viewerClientId = params.clientId ?? `cli_${nanoid(8)}`;
        state.attached.set(fromDisk.hydraSessionId, {
          sessionId: fromDisk.hydraSessionId,
          clientId: viewerClientId,
          readonly: true,
        });
        app.log.info(
          `session/attach OK (viewer) sessionId=${fromDisk.hydraSessionId} clientId=${viewerClientId} attachedCount=${state.attached.size} replayed=${history.length}`,
        );
        for (const entry of history) {
          await connection
            .notify(entry.method, entry.params)
            .catch(() => undefined);
        }
        return {
          sessionId: fromDisk.hydraSessionId,
          clientId: viewerClientId,
          connectedClients: [viewerClientId],
          // No Session.attach() ran, so no history policy was applied —
          // the viewer always gets full history. Report "full" so the
          // wire shape matches the normal attach response.
          historyPolicy: "full" as const,
          replayed: history.length,
          _meta: buildViewerResponseMeta(fromDisk),
        };
      }
      if (!session) {
        // Always consult disk so the resurrected session has its full
        // persisted state (title, snapshot fields, createdAt). When
        // resume hints are present they override the freshest known
        // identity fields (upstream id / cwd / agent) — the originating
        // client's view is fresher than what was on disk last write.
        const fromDisk = await deps.manager.loadFromDisk(lookupId);
        let resurrectParams = fromDisk;
        if (hydraHints) {
          // Identity fields come from the hints (they're fresher than disk);
          // snapshot fields (currentUsage, agentModes, agentModels, etc.) must
          // flow through from disk so cumulativeCost and other restored state
          // survive the resurrect.
          resurrectParams = {
            ...fromDisk,
            hydraSessionId: params.sessionId,
            upstreamSessionId: hydraHints.upstreamSessionId,
            agentId: hydraHints.agentId,
            cwd: hydraHints.cwd,
            ...(hydraHints.title !== undefined ? { title: hydraHints.title } : {}),
            ...(hydraHints.agentArgs !== undefined
              ? { agentArgs: hydraHints.agentArgs }
              : {}),
          };
        }
        if (!resurrectParams) {
          const err = new Error(
            `session ${params.sessionId} not found and no resume hints provided`,
          ) as Error & { code: number };
          err.code = JsonRpcErrorCodes.SessionNotFound;
          throw err;
        }
        // Backfill originatingClient from the attaching connection's
        // initialize when disk has none. Catches sessions created before
        // the shim started stamping clientInfo: the next attach through
        // a tagged connection promotes them out of the "anonymous" pool
        // instead of leaving them invisible in `sessions list` forever.
        const resurrectWithOriginator = resurrectParams.originatingClient
          ? resurrectParams
          : { ...resurrectParams, originatingClient: state.clientInfo };
        session = await deps.manager.resurrect({
          ...resurrectWithOriginator,
          onInstallProgress: makeInstallProgressForwarder(connection),
        });
        wireDefaultTransformers(session, deps);
      }
      const client = bindClientToSession(
        connection,
        session,
        state,
        params.clientInfo,
        params.clientId,
      );
      const drip = hydraAttach.replayMode === "drip";
      const { entries: replay, appliedPolicy } = await session.attach(
        client,
        params.historyPolicy,
        {
          afterMessageId: params.afterMessageId,
          raw: drip,
          // Lean clients opt into ref-form tool content via _meta; default
          // stays inline so existing/third-party clients are unaffected.
          ...(hydraAttach.toolContent !== undefined
            ? { toolContent: hydraAttach.toolContent }
            : {}),
        },
      );
      state.attached.set(session.sessionId, {
        sessionId: session.sessionId,
        clientId: client.clientId,
        readonly,
      });
      app.log.info(
        `session/attach OK sessionId=${session.sessionId} clientId=${client.clientId} attachedCount=${state.attached.size} requestedPolicy=${params.historyPolicy} appliedPolicy=${appliedPolicy} replayed=${replay.length} readonly=${readonly}${drip ? " replayMode=drip" : ""}`,
      );
      if (drip) {
        // Decouple the emit from the response: a dripped replay can span
        // the full wall-clock duration of the original turn(s), so we
        // return immediately and stream the notifications afterward,
        // honoring each entry's recordedAt delta (scaled by dripSpeed,
        // capped so multi-minute idle gaps don't stall the playback).
        // Debug path only — set via _meta["hydra-acp"].replayMode.
        const speed =
          hydraAttach.dripSpeed && hydraAttach.dripSpeed > 0 ? hydraAttach.dripSpeed : 1;
        const MAX_GAP_MS = 750;
        void (async () => {
          let prev: number | null = null;
          for (const note of replay) {
            const at = typeof note.recordedAt === "number" ? note.recordedAt : null;
            if (prev !== null && at !== null) {
              const gap = Math.min(MAX_GAP_MS, Math.max(0, (at - prev) / speed));
              if (gap > 0) {
                await new Promise((r) => setTimeout(r, gap));
              }
            }
            if (at !== null) {
              prev = at;
            }
            try {
              await connection.notify(note.method, note.params);
            } catch {
              // Client detached mid-drip — stop quietly.
              return;
            }
          }
        })();
      } else {
        // Fire the replay notifications in order without awaiting each one
        // (ws.send queues in call order, so ordering holds and the attach
        // response below still lands last). Awaiting per-entry serialized a
        // write-callback round-trip per notification, which on a long
        // session (thousands of entries) stalled the attach handshake for
        // seconds. We await only every REPLAY_FLUSH_EVERY entries to retain
        // coarse backpressure so a slow/remote client can't make us buffer
        // the whole replay in the ws send queue at once.
        const REPLAY_FLUSH_EVERY = 200;
        for (let i = 0; i < replay.length; i++) {
          const note = replay[i]!;
          const pending = connection
            .notify(note.method, note.params)
            .catch(() => undefined);
          if ((i + 1) % REPLAY_FLUSH_EVERY === 0) {
            await pending;
          }
        }
      }
      session.replayPendingPermissions(client);
      const modesPayload = buildModesPayload(session);
      const modelsPayload = buildModelsPayload(session);
      return {
        sessionId: session.sessionId,
        clientId: client.clientId,
        connectedClients: session.connectedClients(client.clientId),
        // appliedPolicy surfaces whether after_message fell back to full
        // (because afterMessageId wasn't found in history) — RFD #533
        // says the response.historyPolicy should reflect what actually
        // ran, not what was asked for.
        historyPolicy: appliedPolicy,
        replayed: replay.length,
        ...(modesPayload ? { modes: modesPayload } : {}),
        ...(modelsPayload ? { models: modelsPayload } : {}),
        configOptions: session.buildConfigOptions(),
        _meta: buildResponseMeta(deps.manager, session),
      };
    });

    connection.onRequest("session/detach", async (raw) => {
      const params = SessionDetachParams.parse(raw);
      const att = state.attached.get(params.sessionId);
      if (!att) {
        const err = new Error("client not attached to that session") as Error & {
          code: number;
        };
        err.code = JsonRpcErrorCodes.SessionNotFound;
        throw err;
      }
      const session = deps.manager.get(params.sessionId);
      session?.detach(att.clientId);
      state.attached.delete(params.sessionId);
      // `cat` detaches explicitly on exit; reap the now-orphaned
      // non-interactive session so its agent doesn't linger.
      if (session) {
        void deps.manager.reapIfOrphanedNonInteractive(params.sessionId);
      }
      // session/detach is RFD-track; the detach outcome is a hydra
      // extension, so it rides under _meta["hydra-acp"].detachStatus
      // rather than a top-level `status` field.
      return {
        sessionId: params.sessionId,
        _meta: { [HYDRA_META_KEY]: { detachStatus: "detached" as const } },
      };
    });

    connection.onRequest("session/list", async (raw) => {
      // Ratified spec (https://agentclientprotocol.com/protocol/session-list):
      // request accepts optional `cwd` and `cursor`; response is
      // `{ sessions: SessionInfo[], nextCursor? }` where each entry is
      // `{ sessionId, cwd, title?, updatedAt?, _meta? }`. Hydra-specific
      // fields ride under `_meta["hydra-acp"]` per the Extensibility
      // convention. `cursor` is accepted for compliance; the daemon
      // returns all matches in one page so it's currently a no-op.
      const params = SessionListParams.parse(raw ?? {});
      const entries = await deps.manager.list({ cwd: params.cwd });
      // Drop sessions created by `hydra cat` — they're one-shot ancillary
      // sessions (export, ad-hoc prompt, etc.) and would clutter every
      // ACP client's list view. The CLI/picker already filter these out
      // client-side over /v1/sessions; mirror that here so spec-compliant
      // ACP clients get the same view without having to know about the
      // hydra-acp _meta tag.
      const visible = entries.filter(
        (e) => e.originatingClient?.name !== HYDRA_CAT_CLIENT_NAME,
      );
      const result: SessionListResult = {
        sessions: visible.map(sessionListEntryToWire),
      };
      return result;
    });

    // Enumerate the agents a client can select when creating a session
    // (via `_meta["hydra-acp"].agentId` on session/new). Mirror of the
    // REST `GET /v1/agents` endpoint — both call core listAgents() — so a
    // protocol-only ACP client can discover and pick agents without the
    // REST surface. Hydra-specific (no ACP spec equivalent yet); namespaced
    // under hydra-acp per the Extensibility convention.
    connection.onRequest("hydra-acp/agents/list", async () => {
      if (!deps.registry) {
        const err = new Error("agent registry unavailable") as Error & {
          code: number;
        };
        err.code = JsonRpcErrorCodes.InternalError;
        throw err;
      }
      return listAgents(deps.registry);
    });

    connection.onRequest("session/prompt", async (raw) => {
      const params = SessionPromptParams.parse(raw);
      denyIfReadonly(params.sessionId, "session/prompt");
      const att = state.attached.get(params.sessionId);
      if (!att) {
        app.log.warn(
          `session/prompt rejected: not attached sessionId=${params.sessionId} attachedKeys=[${[...state.attached.keys()].join(",")}]`,
        );
        const err = new Error("not attached to session") as Error & {
          code: number;
        };
        err.code = JsonRpcErrorCodes.SessionNotFound;
        throw err;
      }
      let session = deps.manager.get(params.sessionId);
      if (!session) {
        // Session was killed while this WS connection remained open — the
        // state.attached entry is stale. Resurrect from disk so the prompt
        // proceeds without requiring the client to re-attach explicitly.
        const fromDisk = await deps.manager.loadFromDisk(params.sessionId);
        if (!fromDisk) {
          const err = new Error(
            `session ${params.sessionId} not found`,
          ) as Error & { code: number };
          err.code = JsonRpcErrorCodes.SessionNotFound;
          throw err;
        }
        app.log.info(
          `session/prompt auto-resurrecting cold sessionId=${params.sessionId}`,
        );
        session = await deps.manager.resurrect(fromDisk);
        wireDefaultTransformers(session, deps);
        const client = bindClientToSession(
          connection,
          session,
          state,
          undefined,
          att.clientId,
        );
        await session.attach(client, "none");
      }
      return session.prompt(att.clientId, params);
    });

    // session/cancel is a *notification* per the ACP spec — clients send it
    // without an id and don't expect a response. Register it as a
    // notification so messages from spec-compliant clients (Zed, agent-shell,
    // hydra-tui) actually land. Errors from cancel propagate to logs but
    // can't be surfaced to the client (notifications have no reply channel).
    const handleCancelParams = (raw: unknown): void => {
      let params;
      try {
        params = SessionCancelParams.parse(raw);
      } catch (err) {
        app.log.warn(
          `session/cancel: invalid params: ${(err as Error).message}`,
        );
        return;
      }
      const att = state.attached.get(params.sessionId);
      if (!att) {
        return;
      }
      if (att.readonly) {
        // Notifications have no reply channel — we can't surface the
        // PermissionDenied error to the client. Log and drop. The
        // request-shaped variant below does throw.
        app.log.warn(
          `session/cancel dropped (readonly attachment) sessionId=${params.sessionId}`,
        );
        return;
      }
      const session = deps.manager.get(params.sessionId);
      if (!session) {
        return;
      }
      session.cancel(att.clientId).catch((err: unknown) => {
        app.log.warn(
          `session/cancel for ${params.sessionId}: ${(err as Error).message}`,
        );
      });
    };
    connection.onNotification("session/cancel", handleCancelParams);
    // Some older clients (and hydra's own tests) sent it as a request before
    // the spec settled. Accept both shapes so we don't regress them; the
    // request form just gets a null response since cancel itself yields
    // nothing meaningful.
    connection.onRequest("session/cancel", async (raw) => {
      const params = SessionCancelParams.parse(raw);
      denyIfReadonly(params.sessionId, "session/cancel");
      handleCancelParams(raw);
      return null;
    });

    connection.onRequest("hydra-acp/prompt/cancel", async (raw) => {
      const params = CancelPromptParams.parse(raw);
      denyIfReadonly(params.sessionId, "hydra-acp/prompt/cancel");
      const session = deps.manager.get(params.sessionId);
      if (!session) {
        const err = new Error(`session ${params.sessionId} not found`) as Error & {
          code: number;
        };
        err.code = JsonRpcErrorCodes.SessionNotFound;
        throw err;
      }
      return session.cancelQueuedPrompt(params.messageId);
    });

    // Force-cancel escalation: when the agent ignores session/cancel, this
    // tears the subprocess down (aborting the stuck turn) and respawns it
    // with history restored. Request-shaped so the client gets a reply.
    connection.onRequest("hydra-acp/session/force_cancel", async (raw) => {
      const params = SessionCancelParams.parse(raw);
      denyIfReadonly(params.sessionId, "hydra-acp/session/force_cancel");
      const session = deps.manager.get(params.sessionId);
      if (!session) {
        const err = new Error(`session ${params.sessionId} not found`) as Error & {
          code: number;
        };
        err.code = JsonRpcErrorCodes.SessionNotFound;
        throw err;
      }
      return session.forceCancel();
    });

    connection.onRequest("hydra-acp/prompt/update", async (raw) => {
      const params = UpdatePromptParams.parse(raw);
      denyIfReadonly(params.sessionId, "hydra-acp/prompt/update");
      const session = deps.manager.get(params.sessionId);
      if (!session) {
        const err = new Error(`session ${params.sessionId} not found`) as Error & {
          code: number;
        };
        err.code = JsonRpcErrorCodes.SessionNotFound;
        throw err;
      }
      return session.updateQueuedPrompt(params.messageId, params.prompt);
    });

    connection.onRequest("hydra-acp/prompt/amend", async (raw) => {
      const params = AmendPromptParams.parse(raw);
      denyIfReadonly(params.sessionId, "hydra-acp/prompt/amend");
      const att = state.attached.get(params.sessionId);
      if (!att) {
        const err = new Error("not attached to session") as Error & {
          code: number;
        };
        err.code = JsonRpcErrorCodes.SessionNotFound;
        throw err;
      }
      const session = deps.manager.get(params.sessionId);
      if (!session) {
        const err = new Error(`session ${params.sessionId} not found`) as Error & {
          code: number;
        };
        err.code = JsonRpcErrorCodes.SessionNotFound;
        throw err;
      }
      return session.amendPrompt(att.clientId, params);
    });

    connection.onRequest("session/load", async (raw) => {
      const rawObj = (raw ?? {}) as Record<string, unknown>;
      const rawSessionId =
        typeof rawObj.sessionId === "string" ? rawObj.sessionId : undefined;
      if (!rawSessionId) {
        const err = new Error("session/load requires sessionId") as Error & {
          code: number;
        };
        err.code = JsonRpcErrorCodes.InvalidParams;
        throw err;
      }
      const sessionId =
        (await deps.manager.resolveCanonicalId(rawSessionId)) ?? rawSessionId;
      let session = deps.manager.get(sessionId);
      if (!session) {
        const fromDisk = await deps.manager.loadFromDisk(sessionId);
        if (!fromDisk) {
          const err = new Error(
            `session ${rawSessionId} not found in memory or on disk`,
          ) as Error & { code: number };
          err.code = JsonRpcErrorCodes.SessionNotFound;
          throw err;
        }
        session = await deps.manager.resurrect(fromDisk);
        wireDefaultTransformers(session, deps);
      }
      const client = bindClientToSession(connection, session, state);
      const { entries: replay } = await session.attach(client, "pending_only");
      state.attached.set(session.sessionId, {
        sessionId: session.sessionId,
        clientId: client.clientId,
        readonly: false,
      });
      for (const note of replay) {
        await connection.notify(note.method, note.params);
      }
      session.replayPendingPermissions(client);
      const modesPayload = buildModesPayload(session);
      const modelsPayload = buildModelsPayload(session);
      return {
        sessionId: session.sessionId,
        ...(modesPayload ? { modes: modesPayload } : {}),
        ...(modelsPayload ? { models: modelsPayload } : {}),
        configOptions: session.buildConfigOptions(),
        // session/load is a core ACP spec method: clientId rides under
        // _meta["hydra-acp"] (not top-level), same as session/new. Lets
        // deferred-echo clients recognize their own broadcasts.
        _meta: buildResponseMeta(deps.manager, session, {
          clientId: client.clientId,
        }),
      };
    });

    // Validate session/set_model against the session's cached
    // availableModels before forwarding to the agent. Originally
    // this fell through to the default handler (transparent forward),
    // but that let cross-agent set_model requests through — e.g. an
    // emacs agent-shell client that thinks it's talking to claude-acp
    // would send `modelId: "claude-opus-4-7[1m]"` to an opencode
    // session, which opencode would silently accept as `{ providerID:
    // "claude-opus-4-7[1m]", modelID: "" }` and then return end_turn
    // instantly for every subsequent prompt (no agent_message_chunks,
    // no error — the worst possible failure mode). Validating against
    // the agent's own advertised list catches it cleanly and surfaces
    // an actionable JSON-RPC error.
    //
    // When the agent never advertised any models (availableModels
    // empty), we pass-through with a log line — better to defer to the
    // agent's own validation than block a model id we don't recognize.
    connection.onRequest("session/set_model", async (rawParams) => {
      const sessionIdField = (rawParams as { sessionId?: unknown } | undefined)
        ?.sessionId;
      if (typeof sessionIdField === "string") {
        denyIfReadonly(sessionIdField, "session/set_model");
      }
      const decision = decideSetModel(rawParams, deps.manager);
      if (decision.kind === "error") {
        app.log.warn(decision.logMessage);
        const err = new Error(decision.message) as Error & { code: number };
        err.code = decision.code;
        throw err;
      }
      if (decision.kind === "no_op") {
        // Validation failed but the session has a current model — keep
        // the client transparent. Resync its local view with what the
        // session is actually on, then return success without forwarding.
        // Originating client gets the notification directly; other
        // attached clients aren't affected (their view never changed).
        app.log.warn(decision.logMessage);
        await connection
          .notify("session/update", {
            sessionId: decision.sessionId,
            update: {
              sessionUpdate: "current_model_update",
              currentModel: decision.currentModel,
            },
          })
          .catch(() => undefined);
        return null;
      }
      app.log.info(decision.logMessage);
      const { modelId } = decision;
      // Forward the resolved modelId (may differ from the requested one
      // when a bare id resolved to a provider-prefixed advertised id).
      const result = await decision.session.forwardRequest("session/set_model", {
        ...(rawParams as Record<string, unknown>),
        modelId,
      });
      // Mirror set_mode: apply the change daemon-side so all attached clients
      // (including the originator) receive a current_model_update immediately,
      // regardless of whether the agent emits one on its own.
      decision.session.applyModelChange(modelId);
      return result;
    });

    // session/set_mode: forward to the agent then immediately apply the
    // mode change on the daemon-side Session. The agent does not emit a
    // current_mode_update notification after session/set_mode, so without
    // this intercept Session.currentMode would stay stale and meta.json
    // would never be updated — meaning the mode reverts to "default" on
    // every daemon restart.
    connection.onRequest("session/set_mode", async (rawParams) => {
      const params = rawParams as { sessionId?: unknown; modeId?: unknown } | undefined;
      const sessionIdField = params?.sessionId;
      if (typeof sessionIdField === "string") {
        denyIfReadonly(sessionIdField, "session/set_mode");
      }
      if (!params || typeof params.sessionId !== "string") {
        const err = new Error("session/set_mode requires string sessionId") as Error & { code: number };
        err.code = JsonRpcErrorCodes.InvalidParams;
        throw err;
      }
      if (typeof params.modeId !== "string") {
        const err = new Error("session/set_mode requires string modeId") as Error & { code: number };
        err.code = JsonRpcErrorCodes.InvalidParams;
        throw err;
      }
      const session = deps.manager.get(params.sessionId);
      if (!session) {
        const err = new Error(`session ${params.sessionId} not found`) as Error & { code: number };
        err.code = JsonRpcErrorCodes.SessionNotFound;
        throw err;
      }
      const result = await session.forwardRequest("session/set_mode", rawParams);
      // Agent doesn't broadcast current_mode_update after set_mode, so
      // apply the change directly so persistence and attach-response meta
      // stay accurate.
      session.applyModeChange(params.modeId);
      return result;
    });

    // session/set_config_option: the spec-preferred unified config setter.
    // hydra exposes mode/model (when known) and the hydra-native `agent`
    // selector via configOptions, so this dispatches by configId onto the
    // existing per-dimension machinery: agent → swap, mode → set_mode,
    // model → set_model. Per spec the response carries the complete,
    // updated configOptions snapshot.
    connection.onRequest("session/set_config_option", async (rawParams) => {
      const params = rawParams as
        | { sessionId?: unknown; configId?: unknown; value?: unknown }
        | undefined;
      const invalid = (msg: string): Error & { code: number } => {
        const err = new Error(msg) as Error & { code: number };
        err.code = JsonRpcErrorCodes.InvalidParams;
        return err;
      };
      const sessionIdField = params?.sessionId;
      if (typeof sessionIdField === "string") {
        denyIfReadonly(sessionIdField, "session/set_config_option");
      }
      if (!params || typeof params.sessionId !== "string") {
        throw invalid("session/set_config_option requires string sessionId");
      }
      if (typeof params.configId !== "string") {
        throw invalid("session/set_config_option requires string configId");
      }
      if (typeof params.value !== "string") {
        throw invalid("session/set_config_option requires string value");
      }
      const session = deps.manager.get(params.sessionId);
      if (!session) {
        const err = new Error(
          `session ${params.sessionId} not found`,
        ) as Error & { code: number };
        err.code = JsonRpcErrorCodes.SessionNotFound;
        throw err;
      }
      // Validate configId + value against the live snapshot so we never
      // dispatch an option hydra isn't currently offering.
      const option = session
        .buildConfigOptions()
        .find((o) => o.id === params.configId);
      if (!option) {
        throw invalid(
          `unknown configId ${JSON.stringify(params.configId)} for this session`,
        );
      }
      if (!option.options.some((v) => v.value === params.value)) {
        throw invalid(
          `value ${JSON.stringify(params.value)} is not valid for configId ${JSON.stringify(params.configId)}`,
        );
      }
      switch (params.configId) {
        case "model": {
          if (params.value !== session.currentModel) {
            await session.forwardRequest("session/set_model", {
              sessionId: params.sessionId,
              modelId: params.value,
            });
          }
          session.applyModelChange(params.value);
          break;
        }
        case "mode": {
          if (params.value !== session.currentMode) {
            await session.forwardRequest("session/set_mode", {
              sessionId: params.sessionId,
              modeId: params.value,
            });
          }
          session.applyModeChange(params.value);
          break;
        }
        case "agent": {
          // No-op when already on the requested agent (a swap to the same
          // id would throw); just resync the client with the full snapshot.
          if (params.value !== session.agentId) {
            await session.setAgent(params.value);
          }
          break;
        }
        default:
          throw invalid(
            `configId ${JSON.stringify(params.configId)} is not settable`,
          );
      }
      return { configOptions: session.buildConfigOptions() };
    });

    connection.setDefaultHandler(async (rawParams, method) => {
      if (
        !method.startsWith("session/") ||
        rawParams === null ||
        typeof rawParams !== "object"
      ) {
        const err = new Error(`Method not found: ${method}`) as Error & {
          code: number;
        };
        err.code = JsonRpcErrorCodes.MethodNotFound;
        throw err;
      }
      const sessionId = (rawParams as { sessionId?: unknown }).sessionId;
      if (typeof sessionId !== "string") {
        const err = new Error(`Method not found: ${method}`) as Error & {
          code: number;
        };
        err.code = JsonRpcErrorCodes.MethodNotFound;
        throw err;
      }
      // Any unhandled session/* method that reaches the default forwarder
      // is by definition state-changing (the read-only-safe methods all
      // have explicit handlers above). Reject for read-only attachments
      // before forwarding to the agent.
      denyIfReadonly(sessionId, method);
      const session = deps.manager.get(sessionId);
      if (!session) {
        const err = new Error(`session ${sessionId} not found`) as Error & {
          code: number;
        };
        err.code = JsonRpcErrorCodes.SessionNotFound;
        throw err;
      }
      return session.forwardRequest(method, rawParams);
    });
  });
}

// Build a callback that forwards agent install progress events as
// hydra-acp/agents/install_progress notifications on the originating WS
// connection. Per-request — each session/new or session/attach handler
// gets its own forwarder, isolated from any other concurrent install
// running on the same daemon. Notifies are fire-and-forget; failures
// (e.g. client already disconnected mid-download) are swallowed so the
// install itself isn't disrupted.
//
// Exported for unit testing — the WS layer is the only production
// consumer.
export function makeInstallProgressForwarder(
  connection: JsonRpcConnection,
): (event: AgentInstallProgress) => void {
  return (event) => {
    const payload: AgentInstallProgressParams = {
      agentId: event.agentId,
      version: event.version,
      source: event.source,
      phase: event.phase,
    };
    if ("receivedBytes" in event) {
      payload.receivedBytes = event.receivedBytes;
    }
    if ("totalBytes" in event) {
      payload.totalBytes = event.totalBytes;
    }
    if ("packageSpec" in event) {
      payload.packageSpec = event.packageSpec;
    }
    void connection
      .notify(AGENT_INSTALL_PROGRESS_METHOD, payload)
      .catch(() => undefined);
  };
}

// Spec-shaped `modes` payload for session/new and session/attach responses.
// Per zNewSessionResponse in the ACP SDK, the response should include a
// top-level `modes: { currentModeId, availableModes: SessionMode[] }`.
// Hydra exposes its tracked modes here so generic clients (agent-shell, Zed)
// see the mode list without needing to read hydra's `_meta` namespace.
// Returns undefined when the session has no advertised modes — in that
// case we omit the field entirely (the schema is `.nullish()`).
function buildModesPayload(
  session: Session,
):
  | {
      currentModeId: string;
      availableModes: Array<{ id: string; name: string; description?: string }>;
    }
  | undefined {
  const modes = session.availableModes();
  if (modes.length === 0) {
    return undefined;
  }
  const availableModes = modes.map((m) => {
    const out: { id: string; name: string; description?: string } = {
      id: m.id,
      // ACP spec requires `name` — fall back to id when the agent didn't
      // supply one so we never emit an invalid SessionMode.
      name: m.name ?? m.id,
    };
    if (m.description !== undefined) {
      out.description = m.description;
    }
    return out;
  });
  // If we never observed a current mode (e.g. agent emits only the list and
  // not a current_mode_update), point at the first mode so the spec field
  // is non-empty rather than dropping `currentModeId` entirely.
  const currentModeId = session.currentMode ?? modes[0]!.id;
  return { currentModeId, availableModes };
}

// Spec-shaped `models` payload for session/new, session/attach, and
// session/load responses. Mirrors buildModesPayload: surfaces the
// agent's advertised model list on a `models: { currentModelId,
// availableModels }` field so generic ACP clients (agent-shell, Zed)
// see the picker without needing to read hydra's `_meta` namespace.
// Without this, an attaching client only sees the agent's models if
// the agent re-emits a current_model_update notification after the
// response goes out — which most agents don't do on attach.
function buildModelsPayload(
  session: Session,
):
  | {
      currentModelId: string;
      availableModels: Array<{
        modelId: string;
        name?: string;
        description?: string;
      }>;
    }
  | undefined {
  const models = session.availableModels();
  if (models.length === 0) {
    return undefined;
  }
  const availableModels = models.map((m) => {
    const out: { modelId: string; name?: string; description?: string } = {
      modelId: m.modelId,
    };
    if (m.name !== undefined) {
      out.name = m.name;
    }
    if (m.description !== undefined) {
      out.description = m.description;
    }
    return out;
  });
  // Mirror modes: if we never observed a current model, point at the
  // first one so the spec field stays non-empty. Most agents do send
  // a current model, so this is a defensive fallback.
  const currentModelId = session.currentModel ?? models[0]!.modelId;
  return { currentModelId, availableModels };
}

// Pure decision function for the session/set_model handler — extracted
// so the validation logic can be unit-tested without spinning a real
// WebSocket. Three outcomes:
//   - `ok`: forward to the agent (the modelId validates, or no list to
//     validate against).
//   - `no_op`: validation failed but the session already has a current
//     model set. Caller resyncs the originating client by emitting a
//     current_model_update for the actual current model and returns
//     success without forwarding. This preserves transparency for
//     unsophisticated clients (notably emacs agent-shell) that
//     auto-fire set_model on connect with a hardcoded provider id —
//     they get a clean reply, the session keeps working, and their
//     local picker resyncs to whatever the agent is actually on.
//   - `error`: outright reject. Reserved for malformed params and the
//     pathological case where the agent never told us a current model
//     and the requested id isn't valid either (genuinely nothing to
//     fall back to).
// The handler in registerAcpWsEndpoint is the only production
// consumer; tests drive it directly to avoid spinning a WebSocket.
export type SetModelDecision =
  // `modelId` is the id to forward — equal to the requested id for an
  // exact match or passthrough, or the advertised id a fuzzy request
  // resolved to (e.g. "claude-opus-4-7" → "anthropic/claude-opus-4-7").
  | { kind: "ok"; session: Session; modelId: string; logMessage: string }
  | {
      kind: "no_op";
      session: Session;
      sessionId: string;
      currentModel: string;
      logMessage: string;
    }
  | { kind: "error"; code: number; message: string; logMessage: string };

export function decideSetModel(
  rawParams: unknown,
  manager: SessionManager,
): SetModelDecision {
  if (!rawParams || typeof rawParams !== "object") {
    return {
      kind: "error",
      code: JsonRpcErrorCodes.InvalidParams,
      message: "session/set_model requires params",
      logMessage: "session/set_model rejected: params not an object",
    };
  }
  const params = rawParams as { sessionId?: unknown; modelId?: unknown };
  if (typeof params.sessionId !== "string") {
    return {
      kind: "error",
      code: JsonRpcErrorCodes.InvalidParams,
      message: "session/set_model requires string sessionId",
      logMessage: "session/set_model rejected: missing/non-string sessionId",
    };
  }
  if (typeof params.modelId !== "string") {
    return {
      kind: "error",
      code: JsonRpcErrorCodes.InvalidParams,
      message: "session/set_model requires string modelId",
      logMessage: `session/set_model rejected: missing/non-string modelId sessionId=${params.sessionId}`,
    };
  }
  const session = manager.get(params.sessionId);
  if (!session) {
    return {
      kind: "error",
      code: JsonRpcErrorCodes.SessionNotFound,
      message: `session ${params.sessionId} not found`,
      logMessage: `session/set_model rejected: session not found sessionId=${params.sessionId}`,
    };
  }
  const advertised = session.availableModels();
  const resolution = resolveModelId(params.modelId, advertised);
  if (resolution.kind === "none") {
    // Agent never told us its model list. Forward and trust the agent's
    // own validation (or its silence). The log line lets the operator
    // distinguish pass-through events from validated ones when triaging.
    return {
      kind: "ok",
      session,
      modelId: params.modelId,
      logMessage: `session/set_model passthrough (no availableModels) sessionId=${params.sessionId} modelId=${JSON.stringify(params.modelId)}`,
    };
  }
  if (resolution.kind === "exact") {
    return {
      kind: "ok",
      session,
      modelId: params.modelId,
      logMessage: `session/set_model accepted sessionId=${params.sessionId} modelId=${JSON.stringify(params.modelId)}`,
    };
  }
  if (resolution.kind === "resolved") {
    return {
      kind: "ok",
      session,
      modelId: resolution.modelId,
      logMessage: `session/set_model resolved sessionId=${params.sessionId} requested=${JSON.stringify(params.modelId)} → ${JSON.stringify(resolution.modelId)}`,
    };
  }
  // ambiguous or unknown: nothing safe to forward.
  const known = advertised.map((m) => m.modelId).join(", ");
  const detail =
    resolution.kind === "ambiguous"
      ? `ambiguous (trailing-segment matches [${resolution.candidates.join(", ")}])`
      : `not in availableModels`;
  // If the session already has a current model, fall back to no_op
  // semantics: tell the client "ok" without forwarding, and have the
  // handler resync the client's local view via a current_model_update
  // notification. The session keeps working on whatever it was; no
  // garbage gets persisted upstream.
  if (session.currentModel !== undefined && session.currentModel.length > 0) {
    return {
      kind: "no_op",
      session,
      sessionId: params.sessionId,
      currentModel: session.currentModel,
      logMessage: `session/set_model no_op (resyncing client) sessionId=${params.sessionId} requested=${JSON.stringify(params.modelId)} ${detail} actual=${JSON.stringify(session.currentModel)} agentId=${session.agentId} known=[${known}]`,
    };
  }
  // No current model to fall back to — refusing here is the safest
  // option. This is rare in practice: an agent that advertises an
  // availableModels list but no current model is unusual.
  return {
    kind: "error",
    code: JsonRpcErrorCodes.InvalidParams,
    message: `model "${params.modelId}" is ${detail === "not in availableModels" ? "not in this session's availableModels" : detail} (agent ${session.agentId}); known models: ${known}`,
    logMessage: `session/set_model rejected sessionId=${params.sessionId} modelId=${JSON.stringify(params.modelId)} ${detail} agentId=${session.agentId} known=[${known}] (no current model to fall back to)`,
  };
}

export interface TransformerAttachDeps {
  manager: { get(sessionId: string): Session | undefined };
  transformers?: { resolveChain(names: string[]): TransformerRef[] };
}

// Handler for `hydra-acp/transformer/attach`. Extracted from the inline
// connection.onRequest registration so it's directly unit-testable. A
// transformer can only attach itself: callerName is wired in from the
// authenticated processIdentity at the call site, never read from the
// request payload. The target session must be live (`SessionNotFound`
// is returned for cold sessions). Transformers that need to operate on
// a cold session should wait for it to come live via natural client
// interaction, or wake it with `hydra-acp/session/load`.
//
// See PROTOCOL.md for the spec.
export async function handleTransformerAttach(
  rawParams: unknown,
  callerName: string,
  deps: TransformerAttachDeps,
): Promise<{ ok: true }> {
  const params = (rawParams ?? {}) as { sessionId?: unknown };
  const sessionId = typeof params.sessionId === "string"
    ? params.sessionId
    : undefined;
  if (!sessionId) {
    throw Object.assign(
      new Error("transformer/attach requires sessionId"),
      { code: JsonRpcErrorCodes.InvalidParams },
    );
  }
  if (!deps.transformers) {
    throw Object.assign(
      new Error("transformer manager not configured"),
      { code: JsonRpcErrorCodes.InternalError },
    );
  }
  const ref = deps.transformers.resolveChain([callerName])[0];
  if (!ref) {
    throw Object.assign(
      new Error(
        `transformer ${callerName} is not connected (call hydra-acp/transformer/initialize first)`,
      ),
      { code: JsonRpcErrorCodes.InternalError },
    );
  }
  const session = deps.manager.get(sessionId);
  if (!session) {
    throw Object.assign(
      new Error(`session ${sessionId} not found`),
      { code: JsonRpcErrorCodes.SessionNotFound },
    );
  }
  session.addTransformer(ref);
  return { ok: true };
}

// Viewer-mode _meta builder. Mirrors buildResponseMeta but reads from the
// on-disk ResurrectParams shape since no Session instance exists in
// manager.sessions for a read-only cold attach. The session stays cold:
// status is "cold", attachedClients 0, and the live-only clock/queue
// fields (turnStartedAt, queue, agentCapabilities) are never populated.
// Routes through buildHydraSessionMeta so the field set and naming stay
// identical to session/list and the live attach/new response.
function buildViewerResponseMeta(
  fromDisk: ResurrectParams,
): Record<string, unknown> {
  const entry: SessionListEntry = {
    sessionId: fromDisk.hydraSessionId,
    upstreamSessionId: fromDisk.upstreamSessionId,
    cwd: fromDisk.cwd,
    title: fromDisk.title,
    agentId: fromDisk.agentId,
    currentModel: fromDisk.currentModel,
    currentUsage: fromDisk.currentUsage,
    forkedFromSessionId: fromDisk.forkedFromSessionId,
    forkedFromMessageId: fromDisk.forkedFromMessageId,
    originatingClient: fromDisk.originatingClient,
    interactive: fromDisk.interactive,
    updatedAt: fromDisk.createdAt ?? new Date().toISOString(),
    attachedClients: 0,
    status: "cold",
    busy: false,
    awaitingInput: false,
  };
  const extras: LiveSessionMetaExtras = {
    currentMode: fromDisk.currentMode,
    agentArgs: fromDisk.agentArgs,
    availableCommands: fromDisk.agentCommands,
    availableModes: fromDisk.agentModes,
    availableModels: fromDisk.agentModels,
  };
  return { [HYDRA_META_KEY]: buildHydraSessionMeta(entry, extras) };
}

// Reconciled _meta builder for the live session/new, session/attach, and
// session/load responses. Derives the same SessionListEntry session/list
// emits (via manager.liveListEntry) so the triage fields — status, busy,
// awaitingInput, attachedClients, provenance — match across surfaces,
// then layers the live-only extras (palette, mode, turn clock, queue,
// agent capabilities) that only a resident session has. Agent-namespaced
// `_meta` passes through via mergeMeta.
//
// `clientId` is passed by the session/new and session/load callers (those
// are core ACP spec methods, so the per-attachment id can't ride at the
// top level); session/attach is RFD-track and keeps clientId top-level, so
// it doesn't pass one here.
function buildResponseMeta(
  manager: SessionManager,
  session: Session,
  opts: { clientId?: string } = {},
): Record<string, unknown> {
  const entry = manager.liveListEntry(session);
  // Snapshot state for the attaching client. Carries what would
  // otherwise come from history-replayed snapshot events
  // (current_model_update / current_mode_update / available_commands_update)
  // so a fresh attach has the right view from the get-go.
  const extras: LiveSessionMetaExtras = {
    clientId: opts.clientId,
    currentMode: session.currentMode,
    agentArgs: session.agentArgs,
    availableCommands: session.mergedAvailableCommands(),
    availableModes: session.availableModes(),
    availableModels: session.availableModels(),
    // Mid-turn at attach time: hand the client the original prompt's
    // recordedAt so it can boot directly into "busy · Ns" instead of
    // sitting on "ready" until the next live notification.
    turnStartedAt: session.turnStartedAt,
    // The underlying agent's own initialize-time capability claim, captured
    // verbatim. Lets capability-aware clients (cat --stream) pick the right
    // consumption surface without re-probing the agent.
    agentCapabilities: session.agentCapabilities,
    // Snapshot of the daemon-owned prompt queue. Lets a late attacher
    // paint queue chips for entries that landed before it joined without
    // waiting for new prompt_queue_added notifications. Omitted entirely
    // when the queue is empty (the common case).
    queue: session.queueSnapshot(),
  };
  return mergeMeta(session.agentMeta, buildHydraSessionMeta(entry, extras));
}

function buildInitializeResult(): InitializeResult {
  return {
    protocolVersion: ACP_PROTOCOL_VERSION,
    agentInfo: { name: "hydra", version: HYDRA_VERSION },
    agentCapabilities: {
      // hydra is a transparent proxy: prompt blocks and MCP server configs are
      // forwarded to the underlying agent unchanged. We claim the union of
      // relevant capabilities; the agent ultimately decides what it accepts.
      promptCapabilities: {
        image: true,
        audio: true,
        embeddedContext: true,
      },
      mcpCapabilities: {
        http: true,
        sse: true,
      },
      loadSession: true,
      sessionCapabilities: {
        attach: {},
        list: {},
      },
    },
    authMethods: [
      {
        id: "bearer-token",
        description: "Bearer token presented at WS upgrade",
      },
    ],
    // Advertise hydra-only capabilities via _meta["hydra-acp"], grouped by
    // resource to mirror the hydra-acp/<resource>/<action> method
    // namespaces. Generic ACP clients ignore the field; capability-aware
    // clients probe here to gate UI before calling a method. `pipelining`
    // is false until the streaming-input probe lands; the rest are
    // unconditional method-availability flags. (Named `prompt`/`agents`,
    // not `promptCapabilities`/`agentCapabilities` — those are ACP spec
    // names with different meanings.)
    _meta: mergeMeta(undefined, {
      prompt: {
        queueing: true,
        cancelling: true,
        updating: true,
        amending: true,
        pipelining: false,
      },
      agents: {
        list: true,
        installProgress: true,
      },
    }),
  };
}

// Wire any connected default transformers into a freshly resurrected
// session. Resurrect doesn't carry a transformer chain (ResurrectParams
// has none), so without this the session runs chain-free after a daemon
// restart until the next session/new.
function wireDefaultTransformers(
  session: Session,
  deps: { manager?: SessionManager; transformers?: TransformerManager },
): void {
  if (!deps.transformers || !deps.manager) {
    return;
  }
  for (const name of deps.manager.defaultTransformers) {
    const ref = deps.transformers.resolveChain([name])[0];
    if (ref) {
      session.addTransformer(ref);
    }
  }
}

function bindClientToSession(
  connection: JsonRpcConnection,
  session: Session,
  state: ClientState,
  clientInfo?: { name: string; version?: string },
  callerClientId?: string,
): AttachedClient {
  void state;
  void session;
  return {
    clientId: callerClientId ?? `cli_${nanoid(8)}`,
    connection,
    clientInfo,
  };
}
