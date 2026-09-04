// Forwards ACP session/{attach,detach,prompt,cancel} traffic for a
// foreign ("name:localId") session to the federated peer that owns
// it, and relays session/update pushes, hydra-acp/session/closed, and
// permission requests back. See core/foreign-session-id.ts and
// PROTOCOL.md's "Federated session ids" note.
//
// Unlike the REST forwarding hook (one request in, one response out),
// a WS attach is a standing relationship: the peer keeps pushing
// notifications for as long as we're attached, so this needs a
// persistent connection plus bookkeeping of which local client is
// currently attached to which foreign session — not just a
// forward-and-forget.
//
// The peer sees nothing unusual: this daemon just looks like one more
// ordinary ACP client attaching over its normal /acp endpoint,
// authenticated with the stored peer token. No protocol extension is
// required on the peer's side.
//
// One dedicated upstream connection per LOCAL attach, not one shared
// connection per peer. That costs an extra WS connection per attacher
// but buys real multi-client fan-out for free: the peer's own
// per-connection attach bookkeeping (acp-ws.ts's `state.attached`,
// keyed by sessionId) evicts a prior attach on the *same* connection
// rather than layering a second one, so two local clients sharing one
// upstream connection would silently stomp each other's registration.
// Giving each local attacher its own connection instead makes our
// daemon look, from the peer's perspective, like N genuinely
// independent clients attaching the same session — exactly the shape
// the peer's existing multi-client support (history replay per
// attach, connectedClients accounting, and — crucially —
// Session.handlePermissionRequest's broadcast-with-abstention race)
// is already built to handle correctly. We don't have to re-implement
// any of that; we just relay each dedicated connection's traffic to
// the one local target it belongs to.

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

interface Attachment {
  peerConnection: JsonRpcConnection;
  localId: string;
  target: ForwardTarget;
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
  // One entry per local attach — keyed by (clientId, foreignId) so the
  // same local connection attaching two different foreign sessions (or
  // two different local connections attaching the *same* foreign
  // session) each get their own independent dedicated upstream
  // connection. See attachKey: a space separates the two halves
  // since neither can contain one (clientId is minted internally;
  // a foreignId's own separator is a colon).
  private attachments = new Map<string, Attachment>();

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
    const id = isRequest ? (msg as JsonRpcRequest).id : undefined;
    const foreign = parseForeignSessionId(foreignId);
    if (!foreign) {
      return isRequest
        ? errorResponse(id!, JsonRpcErrorCodes.SessionNotFound, `not a federated session id: ${foreignId}`)
        : undefined;
    }
    const key = attachKey(target.clientId, foreignId);
    const upstreamParams = {
      ...(msg.params as Record<string, unknown> | undefined),
      sessionId: foreign.localId,
    };

    if (msg.method === "session/attach") {
      const record = this.store.get(foreign.name);
      if (!record) {
        return isRequest
          ? errorResponse(
              id!,
              JsonRpcErrorCodes.SessionNotFound,
              `No remote named "${foreign.name}". Run \`hydra remote add\` first.`,
            )
          : undefined;
      }
      // Re-attaching the same (client, foreignId) pair replaces the
      // old upstream connection — mirrors evictPriorAttachment's
      // "same connection re-attaching the same session" behavior for
      // local sessions.
      const stale = this.attachments.get(key);
      if (stale) {
        this.attachments.delete(key);
        void stale.peerConnection.close().catch(() => undefined);
      }
      let peerConnection: JsonRpcConnection;
      try {
        peerConnection = await this.dial(record);
      } catch (err) {
        return isRequest
          ? errorResponse(
              id!,
              JsonRpcErrorCodes.InternalError,
              `Could not reach remote "${foreign.name}": ${(err as Error).message}`,
            )
          : undefined;
      }
      let result: Record<string, unknown>;
      try {
        result = await peerConnection.request<Record<string, unknown>>(
          "session/attach",
          upstreamParams,
        );
      } catch (err) {
        void peerConnection.close().catch(() => undefined);
        return isRequest ? errorFromCatch(id!, err) : undefined;
      }
      const attachment: Attachment = {
        peerConnection,
        localId: foreign.localId,
        target,
      };
      this.wireAttachment(foreign.name, attachment);
      this.attachments.set(key, attachment);
      const rewrapped =
        result && typeof result.sessionId === "string"
          ? { ...result, sessionId: foreignId }
          : result;
      return isRequest ? { jsonrpc: "2.0", id: id!, result: rewrapped } : undefined;
    }

    const attachment = this.attachments.get(key);
    if (!attachment) {
      return isRequest
        ? errorResponse(
            id!,
            JsonRpcErrorCodes.SessionNotFound,
            `"${foreignId}" is not attached through this daemon.`,
          )
        : undefined;
    }

    if (msg.method === "session/detach") {
      let result: unknown;
      let caught: unknown;
      try {
        result = await attachment.peerConnection.request("session/detach", upstreamParams);
      } catch (err) {
        caught = err;
      }
      this.attachments.delete(key);
      void attachment.peerConnection.close().catch(() => undefined);
      if (caught) {
        return isRequest ? errorFromCatch(id!, caught) : undefined;
      }
      return isRequest ? { jsonrpc: "2.0", id: id!, result: result ?? {} } : undefined;
    }

    // session/prompt, session/cancel — the only other forwardable
    // methods (see isForwardableMethod).
    if (isRequest) {
      try {
        const result = await attachment.peerConnection.request(msg.method, upstreamParams);
        return { jsonrpc: "2.0", id: id!, result };
      } catch (err) {
        return errorFromCatch(id!, err);
      }
    }
    await attachment.peerConnection.notify(msg.method, upstreamParams).catch(() => undefined);
    return undefined;
  }

  // Local WS connection closed — detach and close every dedicated
  // upstream connection it owned. Best-effort: failures reaching the
  // peer don't block local cleanup.
  detachClient(clientId: string): void {
    for (const [key, attachment] of [...this.attachments.entries()]) {
      if (attachment.target.clientId !== clientId) {
        continue;
      }
      this.attachments.delete(key);
      void attachment.peerConnection
        .request("session/detach", { sessionId: attachment.localId })
        .catch(() => undefined);
      void attachment.peerConnection.close().catch(() => undefined);
    }
  }

  // Wires a freshly-attached dedicated connection's peer-originated
  // traffic straight to the one local target it belongs to — no
  // lookup needed, the target is fixed for this connection's lifetime.
  private wireAttachment(name: string, attachment: Attachment): void {
    const { peerConnection, localId, target } = attachment;
    const foreignId = formatForeignSessionId({ name, localId });
    const forget = (): void => {
      this.attachments.delete(attachKey(target.clientId, foreignId));
    };
    peerConnection.onNotification("session/update", (params) => {
      const p = params as { sessionId?: string } | null;
      if (!p || p.sessionId !== localId) {
        return;
      }
      void target.connection
        .notify("session/update", { ...p, sessionId: foreignId })
        .catch(() => undefined);
    });
    peerConnection.onNotification("hydra-acp/session/closed", (params) => {
      const p = params as { sessionId?: string } | null;
      if (!p || p.sessionId !== localId) {
        return;
      }
      forget();
      void target.connection
        .notify("hydra-acp/session/closed", { sessionId: foreignId })
        .catch(() => undefined);
    });
    peerConnection.onRequest("hydra-acp/session/request_permission", async (params) => {
      const p = params as { sessionId?: string } | null;
      if (!p || p.sessionId !== localId) {
        // Shouldn't happen — this connection only ever attaches one
        // session — but abstain rather than misroute if it somehow does.
        throw { code: JsonRpcErrorCodes.MethodNotFound, message: "unexpected sessionId" };
      }
      return target.connection.request("hydra-acp/session/request_permission", {
        ...p,
        sessionId: foreignId,
      });
    });
    peerConnection.onClose(() => {
      forget();
      void target.connection
        .notify("hydra-acp/session/closed", { sessionId: foreignId })
        .catch(() => undefined);
    });
  }
}

function attachKey(clientId: string, foreignId: string): string {
  return `${clientId} ${foreignId}`;
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
