import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { nanoid } from "nanoid";
import { JsonRpcConnection } from "../acp/connection.js";
import { wsToMessageStream } from "../acp/ws-stream.js";
import {
  HydraConfig,
} from "../core/config.js";
import { SessionManager } from "../core/session-manager.js";
import { Session, type AttachedClient } from "../core/session.js";
import {
  InitializeParams,
  ProxyInitializeParams,
  SessionAttachParams,
  SessionCancelParams,
  SessionDetachParams,
  SessionListParams,
  SessionNewParams,
  SessionPromptParams,
  extractHydraMeta,
  mergeMeta,
  type InitializeResult,
  type SessionListResult,
  JsonRpcErrorCodes,
} from "../acp/types.js";
import { tokenFromUpgradeRequest, constantTimeEqual } from "./auth.js";

const HYDRA_VERSION = "0.1.0";
const HYDRA_PROTOCOL_VERSION = 1;

interface ClientState {
  clientId: string;
  attached: Map<string, { sessionId: string; clientId: string }>;
}

export interface AcpWsDeps {
  config: HydraConfig;
  manager: SessionManager;
  defaultAgent: string;
}

export function registerAcpWsEndpoint(
  app: FastifyInstance,
  deps: AcpWsDeps,
): void {
  app.get("/acp", { websocket: true }, (socket: WebSocket, request) => {
    const token = tokenFromUpgradeRequest({
      headers: request.headers as NodeJS.Dict<string | string[]>,
      url: request.url,
    });
    if (!token || !constantTimeEqual(token, deps.config.daemon.authToken)) {
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
      });
      const client = bindClientToSession(connection, session, "controller", state);
      session.attach(client, "full");
      state.attached.set(session.sessionId, {
        sessionId: session.sessionId,
        clientId: client.clientId,
      });
      return {
        sessionId: session.sessionId,
        _meta: buildResponseMeta(session),
      };
    });

    connection.onRequest("session/attach", async (raw) => {
      const params = SessionAttachParams.parse(raw);
      const hydraHints = extractHydraMeta(params._meta).resume;
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
        let resurrectParams = hydraHints
          ? {
              hydraSessionId: params.sessionId,
              upstreamSessionId: hydraHints.upstreamSessionId,
              agentId: hydraHints.agentId,
              cwd: hydraHints.cwd,
              title: hydraHints.title,
              agentArgs: hydraHints.agentArgs,
            }
          : await deps.manager.loadFromDisk(lookupId);
        if (!resurrectParams) {
          const err = new Error(
            `session ${params.sessionId} not found and no resume hints provided`,
          ) as Error & { code: number };
          err.code = JsonRpcErrorCodes.SessionNotFound;
          throw err;
        }
        session = await deps.manager.resurrect(resurrectParams);
      }
      const client = bindClientToSession(
        connection,
        session,
        params.role,
        state,
        params.clientInfo,
      );
      const replay = session.attach(client, params.historyPolicy);
      state.attached.set(session.sessionId, {
        sessionId: session.sessionId,
        clientId: client.clientId,
      });
      for (const note of replay) {
        await connection.notify(note.method, note.params);
      }
      session.replayPendingPermissions(client);
      return {
        sessionId: session.sessionId,
        role: params.role,
        replayed: replay.length,
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
      return { detached: true };
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
        const err = new Error("not attached to session") as Error & {
          code: number;
        };
        err.code = JsonRpcErrorCodes.SessionNotFound;
        throw err;
      }
      const session = deps.manager.require(params.sessionId);
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
      const client = bindClientToSession(connection, session, "controller", state);
      const replay = session.attach(client, "pending_only");
      state.attached.set(session.sessionId, {
        sessionId: session.sessionId,
        clientId: client.clientId,
      });
      for (const note of replay) {
        await connection.notify(note.method, note.params);
      }
      session.replayPendingPermissions(client);
      return {
        sessionId: session.sessionId,
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
  return mergeMeta(session.agentMeta, ours);
}

function buildInitializeResult(): InitializeResult {
  return {
    protocolVersion: HYDRA_PROTOCOL_VERSION,
    agentInfo: { name: "acp-hydra", version: HYDRA_VERSION },
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
        attach: { roles: ["controller", "observer"] },
        list: true,
      },
    },
    authMethods: [
      {
        id: "bearer-token",
        description: "Bearer token presented at WS upgrade",
      },
    ],
  };
}

function bindClientToSession(
  connection: JsonRpcConnection,
  session: Session,
  role: "controller" | "observer",
  state: ClientState,
  clientInfo?: { name: string; version?: string },
): AttachedClient {
  void state;
  void session;
  return {
    clientId: `cli_${nanoid(8)}`,
    role,
    connection,
    clientInfo,
  };
}
