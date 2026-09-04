// Forwards ACP session/{attach,detach,prompt,cancel} traffic for a
// foreign ("name:localId") session to the federated peer that owns
// it, and relays session/update pushes, hydra-acp/session/closed, and
// permission requests back. See core/foreign-session-id.ts and
// PROTOCOL.md's "Federated session ids" note.
//
// Unlike the REST forwarding hook (one request in, one response out),
// a WS attach is a standing relationship: the peer keeps pushing
// notifications for as long as we're attached, so this needs a
// persistent connection per peer plus bookkeeping of which local
// client is currently attached to which foreign session — not just a
// forward-and-forget.
//
// The peer sees nothing unusual: this daemon just looks like one more
// ordinary ACP client attaching over its normal /acp endpoint,
// authenticated with the stored peer token. No protocol extension is
// required on the peer's side.
//
// Deliberately single-target per foreign session for now. The peer's
// own per-connection attach bookkeeping (see acp-ws.ts's
// `state.attached`, keyed by sessionId) evicts a prior attach on the
// same connection rather than layering a second one — so calling
// session/attach twice on our one shared peer connection for the same
// localId, to represent two local fan-out clients, would silently
// stomp the first attach's registration rather than create two. Real
// multi-client fan-out needs the daemon itself to buffer/replay
// history to a late-joining second local client, which this pass
// doesn't do. A second local attach to an already-forwarded session is
// rejected with AlreadyAttached rather than doing that incorrectly.

import { JsonRpcConnection } from "../acp/connection.js";
import { wsToMessageStream } from "../acp/ws-stream.js";
import { openWs } from "../shim/open-ws.js";
import { isLoopbackHost } from "../core/remote-url.js";
import {
  parseForeignSessionId,
  formatForeignSessionId,
} from "../core/foreign-session-id.js";
import type { PeerStore, PeerRecord } from "../core/peer-store.js";
import type { MessageStream } from "../acp/framing.js";
import {
  JsonRpcErrorCodes,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
} from "../acp/types.js";

export interface ForwardTarget {
  connection: JsonRpcConnection;
  clientId: string;
}

interface ForeignSessionState {
  localId: string;
  target: ForwardTarget;
}

interface PeerLink {
  connection: JsonRpcConnection;
  // Keyed by the peer's own (unwrapped) session id.
  sessions: Map<string, ForeignSessionState>;
}

// Injectable so tests can wire a fake peer without a real socket.
export type Dialer = (record: PeerRecord) => Promise<JsonRpcConnection>;

const FORWARDABLE_METHODS = new Set([
  "session/attach",
  "session/detach",
  "session/prompt",
  "session/cancel",
]);

export function isForwardableMethod(method: string): boolean {
  return FORWARDABLE_METHODS.has(method);
}

// Wraps a local client's raw MessageStream so any of the forwardable
// methods above, addressed at a foreign session id, is diverted to the
// registry and never reaches the JsonRpcConnection built on top of the
// returned stream — meaning session/attach, /detach, /prompt, /cancel
// handlers registered there see only local ids, exactly as before.
// Everything else (initialize, session/new, local-id traffic, and
// responses to requests *we* made outbound) passes through untouched.
//
// `targetBox` exists because the JsonRpcConnection this wraps doesn't
// exist yet at wrap time (it's built from the stream this returns) but
// the registry needs to hand it back to the peer as the relay target
// for that session's future notifications/requests. Callers must set
// `targetBox.connection` immediately after constructing that
// JsonRpcConnection, before any message can arrive.
export function wrapStreamForForwarding(
  inner: MessageStream,
  registry: ForeignSessionRegistry,
  targetBox: { connection?: JsonRpcConnection },
  clientId: string,
): MessageStream {
  const handlers: Array<(m: JsonRpcMessage) => void> = [];
  inner.onMessage((msg) => {
    if ("method" in msg && isForwardableMethod(msg.method)) {
      const params = msg.params as { sessionId?: unknown } | undefined;
      const sessionId =
        typeof params?.sessionId === "string" ? params.sessionId : undefined;
      if (sessionId && parseForeignSessionId(sessionId)) {
        void registry
          .handleLocalMessage(msg as JsonRpcRequest | JsonRpcNotification, sessionId, {
            connection: targetBox.connection!,
            clientId,
          })
          .then((response) => (response ? inner.send(response) : undefined))
          .catch(() => undefined);
        return;
      }
    }
    for (const h of handlers) {
      h(msg);
    }
  });
  return {
    send: (m) => inner.send(m),
    onMessage: (h) => handlers.push(h),
    onClose: (h) => inner.onClose(h),
    close: () => inner.close(),
  };
}

export class ForeignSessionRegistry {
  private peers = new Map<string, PeerLink>();

  constructor(
    private readonly store: PeerStore,
    private readonly dial: Dialer = defaultDialer,
  ) {}

  // Handles one inbound request/notification from a local client whose
  // sessionId is foreign-shaped (see parseForeignSessionId). Returns
  // the JsonRpcResponse to send back to the local client for a
  // request, or undefined for a notification (nothing to send back) —
  // callers are expected to have already confirmed msg.method is one
  // of FORWARDABLE_METHODS and msg's sessionId parses as foreign.
  async handleLocalMessage(
    msg: JsonRpcRequest | JsonRpcNotification,
    foreignId: string,
    target: ForwardTarget,
  ): Promise<JsonRpcMessage | undefined> {
    const isRequest = "id" in msg;
    const foreign = parseForeignSessionId(foreignId);
    if (!foreign) {
      return isRequest
        ? errorResponse(
            (msg as JsonRpcRequest).id,
            JsonRpcErrorCodes.SessionNotFound,
            `not a federated session id: ${foreignId}`,
          )
        : undefined;
    }
    const record = this.store.get(foreign.name);
    if (!record) {
      return isRequest
        ? errorResponse(
            (msg as JsonRpcRequest).id,
            JsonRpcErrorCodes.SessionNotFound,
            `No remote named "${foreign.name}". Run \`hydra remote add\` first.`,
          )
        : undefined;
    }
    const link = await this.getOrDialPeer(foreign.name, record);
    if (!link) {
      return isRequest
        ? errorResponse(
            (msg as JsonRpcRequest).id,
            JsonRpcErrorCodes.InternalError,
            `Could not reach remote "${foreign.name}".`,
          )
        : undefined;
    }
    const upstreamParams = {
      ...(msg.params as Record<string, unknown> | undefined),
      sessionId: foreign.localId,
    };

    if (msg.method === "session/attach") {
      if (link.sessions.has(foreign.localId)) {
        return isRequest
          ? errorResponse(
              (msg as JsonRpcRequest).id,
              JsonRpcErrorCodes.AlreadyAttached,
              `"${foreignId}" is already attached through this daemon (forwarded sessions don't yet support more than one local client).`,
            )
          : undefined;
      }
      try {
        const result = await link.connection.request<Record<string, unknown>>(
          "session/attach",
          upstreamParams,
        );
        link.sessions.set(foreign.localId, { localId: foreign.localId, target });
        const rewrapped =
          result && typeof result.sessionId === "string"
            ? { ...result, sessionId: foreignId }
            : result;
        return isRequest
          ? { jsonrpc: "2.0", id: (msg as JsonRpcRequest).id, result: rewrapped }
          : undefined;
      } catch (err) {
        return isRequest
          ? errorFromCatch((msg as JsonRpcRequest).id, err)
          : undefined;
      }
    }

    if (msg.method === "session/detach") {
      let result: unknown;
      let caught: unknown;
      try {
        result = await link.connection.request("session/detach", upstreamParams);
      } catch (err) {
        caught = err;
      }
      link.sessions.delete(foreign.localId);
      if (caught) {
        return isRequest ? errorFromCatch((msg as JsonRpcRequest).id, caught) : undefined;
      }
      return isRequest
        ? { jsonrpc: "2.0", id: (msg as JsonRpcRequest).id, result: result ?? {} }
        : undefined;
    }

    // session/prompt, session/cancel — the only other forwardable
    // methods (see isForwardableMethod).
    const state = link.sessions.get(foreign.localId);
    if (!state) {
      return isRequest
        ? errorResponse(
            (msg as JsonRpcRequest).id,
            JsonRpcErrorCodes.SessionNotFound,
            `"${foreignId}" is not attached through this daemon.`,
          )
        : undefined;
    }
    if (isRequest) {
      try {
        const result = await link.connection.request(msg.method, upstreamParams);
        return { jsonrpc: "2.0", id: (msg as JsonRpcRequest).id, result };
      } catch (err) {
        return errorFromCatch((msg as JsonRpcRequest).id, err);
      }
    }
    await link.connection.notify(msg.method, upstreamParams).catch(() => undefined);
    return undefined;
  }

  // Local WS connection closed — detach it from every foreign session
  // it was the target of and forget the upstream attach. Best-effort:
  // failures reaching the peer don't block local cleanup.
  detachClient(clientId: string): void {
    for (const link of this.peers.values()) {
      for (const [localId, state] of [...link.sessions.entries()]) {
        if (state.target.clientId !== clientId) {
          continue;
        }
        link.sessions.delete(localId);
        void link.connection
          .request("session/detach", { sessionId: localId })
          .catch(() => undefined);
      }
    }
  }

  private async getOrDialPeer(
    name: string,
    record: PeerRecord,
  ): Promise<PeerLink | undefined> {
    const existing = this.peers.get(name);
    if (existing) {
      return existing;
    }
    let connection: JsonRpcConnection;
    try {
      connection = await this.dial(record);
    } catch {
      return undefined;
    }
    const link: PeerLink = { connection, sessions: new Map() };
    connection.onNotification("session/update", (params) => {
      const p = params as { sessionId?: string } | null;
      if (!p || typeof p.sessionId !== "string") {
        return;
      }
      const state = link.sessions.get(p.sessionId);
      if (!state) {
        return;
      }
      void state.target.connection
        .notify("session/update", {
          ...p,
          sessionId: formatForeignSessionId({ name, localId: p.sessionId }),
        })
        .catch(() => undefined);
    });
    connection.onNotification("hydra-acp/session/closed", (params) => {
      const p = params as { sessionId?: string } | null;
      if (!p || typeof p.sessionId !== "string") {
        return;
      }
      const state = link.sessions.get(p.sessionId);
      link.sessions.delete(p.sessionId);
      if (!state) {
        return;
      }
      void state.target.connection
        .notify("hydra-acp/session/closed", {
          sessionId: formatForeignSessionId({ name, localId: p.sessionId }),
        })
        .catch(() => undefined);
    });
    connection.onRequest("hydra-acp/session/request_permission", async (params) => {
      const p = params as { sessionId?: string } | null;
      if (!p || typeof p.sessionId !== "string") {
        throw { code: JsonRpcErrorCodes.InvalidParams, message: "sessionId is required" };
      }
      const state = link.sessions.get(p.sessionId);
      if (!state) {
        // No local client attached right now — abstain, same as any
        // other client that can't answer. See Session.handlePermissionRequest.
        throw { code: JsonRpcErrorCodes.MethodNotFound, message: "no local attachment" };
      }
      return state.target.connection.request("hydra-acp/session/request_permission", {
        ...p,
        sessionId: formatForeignSessionId({ name, localId: p.sessionId }),
      });
    });
    connection.onClose(() => {
      for (const state of link.sessions.values()) {
        void state.target.connection
          .notify("hydra-acp/session/closed", {
            sessionId: formatForeignSessionId({ name, localId: state.localId }),
          })
          .catch(() => undefined);
      }
      this.peers.delete(name);
    });
    this.peers.set(name, link);
    return link;
  }
}

function errorResponse(
  id: JsonRpcRequest["id"],
  code: number,
  message: string,
): JsonRpcMessage {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function errorFromCatch(id: JsonRpcRequest["id"], err: unknown): JsonRpcMessage {
  const e = err as { code?: unknown; message?: unknown; data?: unknown } | null;
  const code =
    typeof e?.code === "number" ? e.code : JsonRpcErrorCodes.InternalError;
  const message =
    typeof e?.message === "string" ? e.message : String(err ?? "forward failed");
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(e?.data !== undefined ? { data: e.data } : {}) },
  };
}

const WS_CONNECT_TIMEOUT_MS = 10_000;

async function defaultDialer(record: PeerRecord): Promise<JsonRpcConnection> {
  const scheme = isLoopbackHost(record.host) ? "ws" : "wss";
  const url = `${scheme}://${record.host}:${record.port}/acp`;
  const ws = await openWs(
    url,
    ["acp.v1", `hydra-acp-token.${record.token}`],
    WS_CONNECT_TIMEOUT_MS,
  );
  return new JsonRpcConnection(wsToMessageStream(ws));
}
