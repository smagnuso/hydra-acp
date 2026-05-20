import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { nanoid } from "nanoid";
import { JsonRpcConnection } from "../acp/connection.js";
import { wsToMessageStream } from "../acp/ws-stream.js";
import { SessionManager } from "../core/session-manager.js";
import { Session, type AttachedClient } from "../core/session.js";
import {
  AmendPromptParams,
  CancelPromptParams,
  InitializeParams,
  ProxyInitializeParams,
  SessionAttachParams,
  SessionCancelParams,
  SessionDetachParams,
  SessionListParams,
  SessionNewParams,
  SessionPromptParams,
  UpdatePromptParams,
  extractHydraMeta,
  mergeMeta,
  type InitializeResult,
  type SessionListResult,
  JsonRpcErrorCodes,
  ACP_PROTOCOL_VERSION,
  AGENT_INSTALL_PROGRESS_METHOD,
  type AgentInstallProgressParams,
} from "../acp/types.js";
import type { AgentInstallProgress } from "../core/registry.js";
import { tokenFromUpgradeRequest, type TokenValidator } from "./auth.js";
import { HYDRA_VERSION } from "../core/hydra-version.js";

interface ClientState {
  clientId: string;
  attached: Map<string, { sessionId: string; clientId: string }>;
}

export interface AcpWsDeps {
  validator: TokenValidator;
  manager: SessionManager;
  defaultAgent: string;
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

    const stream = wsToMessageStream(socket);
    const connection = new JsonRpcConnection(stream);
    const state: ClientState = {
      clientId: `hydra_client_${nanoid(12)}`,
      attached: new Map(),
    };

    connection.onClose(() => {
      for (const att of state.attached.values()) {
        const session = deps.manager.get(att.sessionId);
        session?.detach(att.clientId);
      }
      state.attached.clear();
    });

    connection.onRequest("initialize", async (raw) => {
      InitializeParams.parse(raw ?? {});
      return buildInitializeResult();
    });

    connection.onRequest("proxy/initialize", async (raw) => {
      ProxyInitializeParams.parse(raw ?? {});
      return buildInitializeResult();
    });

    connection.onRequest("session/new", async (raw) => {
      const params = SessionNewParams.parse(raw);
      const hydraMeta = extractHydraMeta(
        (raw as { _meta?: Record<string, unknown> } | undefined)?._meta,
      );
      const session = await deps.manager.create({
        cwd: params.cwd,
        agentId: params.agentId ?? deps.defaultAgent,
        mcpServers: params.mcpServers,
        title: hydraMeta.name,
        agentArgs: hydraMeta.agentArgs,
        model: hydraMeta.model,
        onInstallProgress: makeInstallProgressForwarder(connection),
      });
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
      return {
        sessionId: session.sessionId,
        // session/new is implicitly an attach; mirror session/attach's
        // shape by including the clientId so deferred-echo clients
        // (TUI's queue work) can recognize their own prompt_queue_added
        // events without an extra round-trip.
        clientId: client.clientId,
        ...(modesPayload ? { modes: modesPayload } : {}),
        _meta: buildResponseMeta(session),
      };
    });

    connection.onRequest("session/attach", async (raw) => {
      const params = SessionAttachParams.parse(raw);
      const hydraHints = extractHydraMeta(params._meta).resume;
      app.log.info(
        `session/attach sessionId=${params.sessionId} hasResumeHints=${!!hydraHints}`,
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
      if (!session) {
        // Always consult disk so the resurrected session has its full
        // persisted state (title, snapshot fields, createdAt). When
        // resume hints are present they override the freshest known
        // identity fields (upstream id / cwd / agent) — the originating
        // client's view is fresher than what was on disk last write.
        const fromDisk = await deps.manager.loadFromDisk(lookupId);
        let resurrectParams = fromDisk;
        if (hydraHints) {
          resurrectParams = {
            hydraSessionId: params.sessionId,
            upstreamSessionId: hydraHints.upstreamSessionId,
            agentId: hydraHints.agentId,
            cwd: hydraHints.cwd,
            title: hydraHints.title ?? fromDisk?.title,
            agentArgs: hydraHints.agentArgs ?? fromDisk?.agentArgs,
            currentModel: fromDisk?.currentModel,
            currentMode: fromDisk?.currentMode,
            agentCommands: fromDisk?.agentCommands,
            createdAt: fromDisk?.createdAt,
          };
        }
        if (!resurrectParams) {
          const err = new Error(
            `session ${params.sessionId} not found and no resume hints provided`,
          ) as Error & { code: number };
          err.code = JsonRpcErrorCodes.SessionNotFound;
          throw err;
        }
        session = await deps.manager.resurrect({
          ...resurrectParams,
          onInstallProgress: makeInstallProgressForwarder(connection),
        });
      }
      const client = bindClientToSession(
        connection,
        session,
        state,
        params.clientInfo,
        params.clientId,
      );
      const { entries: replay, appliedPolicy } = await session.attach(
        client,
        params.historyPolicy,
        { afterMessageId: params.afterMessageId },
      );
      state.attached.set(session.sessionId, {
        sessionId: session.sessionId,
        clientId: client.clientId,
      });
      app.log.info(
        `session/attach OK sessionId=${session.sessionId} clientId=${client.clientId} attachedCount=${state.attached.size} requestedPolicy=${params.historyPolicy} appliedPolicy=${appliedPolicy} replayed=${replay.length}`,
      );
      for (const note of replay) {
        await connection.notify(note.method, note.params);
      }
      session.replayPendingPermissions(client);
      const modesPayload = buildModesPayload(session);
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
        _meta: buildResponseMeta(session),
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
      return { sessionId: params.sessionId, status: "detached" as const };
    });

    connection.onRequest("session/list", async (raw) => {
      const params = SessionListParams.parse(raw ?? {});
      const sessions = await deps.manager.list({ cwd: params.cwd });
      const result: SessionListResult = { sessions };
      return result;
    });

    connection.onRequest("session/prompt", async (raw) => {
      const params = SessionPromptParams.parse(raw);
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
      handleCancelParams(raw);
      return null;
    });

    connection.onRequest("hydra-acp/cancel_prompt", async (raw) => {
      const params = CancelPromptParams.parse(raw);
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

    connection.onRequest("hydra-acp/update_prompt", async (raw) => {
      const params = UpdatePromptParams.parse(raw);
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

    connection.onRequest("hydra-acp/amend_prompt", async (raw) => {
      const params = AmendPromptParams.parse(raw);
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
      }
      const client = bindClientToSession(connection, session, state);
      const { entries: replay } = await session.attach(client, "pending_only");
      state.attached.set(session.sessionId, {
        sessionId: session.sessionId,
        clientId: client.clientId,
      });
      for (const note of replay) {
        await connection.notify(note.method, note.params);
      }
      session.replayPendingPermissions(client);
      const modesPayload = buildModesPayload(session);
      return {
        sessionId: session.sessionId,
        // Same as session/new: include clientId so the deferred-echo
        // path in queue-aware clients can recognize own broadcasts.
        clientId: client.clientId,
        ...(modesPayload ? { modes: modesPayload } : {}),
        _meta: buildResponseMeta(session),
      };
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
// hydra-acp/agent_install_progress notifications on the originating WS
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

function buildResponseMeta(session: Session): Record<string, unknown> {
  const ours: Record<string, unknown> = {
    upstreamSessionId: session.upstreamSessionId,
    agentId: session.agentId,
    cwd: session.cwd,
  };
  if (session.title !== undefined) {
    ours.name = session.title;
  }
  if (session.agentArgs && session.agentArgs.length > 0) {
    ours.agentArgs = session.agentArgs;
  }
  // Snapshot state for the attaching client. Carries what would
  // otherwise come from history-replayed snapshot events
  // (current_model_update / current_mode_update / available_commands_update)
  // so a fresh attach has the right view from the get-go.
  if (session.currentModel !== undefined) {
    ours.currentModel = session.currentModel;
  }
  if (session.currentMode !== undefined) {
    ours.currentMode = session.currentMode;
  }
  if (session.currentUsage !== undefined) {
    ours.currentUsage = session.currentUsage;
  }
  const commands = session.mergedAvailableCommands();
  if (commands.length > 0) {
    ours.availableCommands = commands;
  }
  const modes = session.availableModes();
  if (modes.length > 0) {
    ours.availableModes = modes;
  }
  // Mid-turn at attach time: hand the client the original prompt's
  // recordedAt so it can boot directly into "busy · Ns" instead of
  // sitting on "ready" until the next live notification.
  if (session.turnStartedAt !== undefined) {
    ours.turnStartedAt = session.turnStartedAt;
  }
  // Snapshot of the daemon-owned prompt queue. Lets a late attacher
  // paint queue chips for entries that landed before it joined without
  // waiting for new prompt_queue_added notifications. Omitted entirely
  // when the queue is empty (the common case).
  const queue = session.queueSnapshot();
  if (queue.length > 0) {
    ours.queue = queue;
  }
  return mergeMeta(session.agentMeta, ours);
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
        list: true,
      },
    },
    authMethods: [
      {
        id: "bearer-token",
        description: "Bearer token presented at WS upgrade",
      },
    ],
    // Advertise hydra-only capabilities via _meta["hydra-acp"]. Generic
    // ACP clients ignore the field; capability-aware clients learn here
    // which hydra-acp extensions the daemon supports so they can gate
    // UI surface accordingly. promptPipelining is false until the
    // streaming-input probe lands (Option A in the steering brief);
    // the others are unconditional method-availability flags.
    _meta: mergeMeta(undefined, {
      promptQueueing: true,
      promptCancelling: true,
      promptUpdating: true,
      promptAmending: true,
      promptPipelining: false,
    }),
  };
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
