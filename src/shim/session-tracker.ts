import {
  extractHydraMeta,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "../acp/types.js";

export interface ResumeContext {
  sessionId: string;
  upstreamSessionId: string;
  agentId: string;
  cwd: string;
  title?: string;
  agentArgs?: string[];
}

interface PendingNew {
  cwd: string;
}

interface PendingAttach {
  sessionId: string;
}

interface PendingLoad {
  sessionId: string;
  cwd: string;
}

type Pending =
  | { kind: "new"; data: PendingNew }
  | { kind: "attach"; data: PendingAttach }
  | { kind: "load"; data: PendingLoad };

export interface PendingPermission {
  requestId: JsonRpcId;
  sessionId: string;
  toolCallId: string | undefined;
  params: Record<string, unknown>;
}

export class SessionTracker {
  private contexts = new Map<string, ResumeContext>();
  private pending = new Map<JsonRpcId, Pending>();
  private pendingPermissions = new Map<JsonRpcId, PendingPermission>();
  // Secondary index — same entries as `pendingPermissions`, keyed by the
  // tool call id from the request_permission params. Used to correlate
  // the daemon's `session/update`/`permission_resolved` events back to the
  // pending downstream request, since per-recipient JSON-RPC ids are no
  // longer carried on the wire.
  private pendingPermissionsByToolCall = new Map<string, PendingPermission>();

  observeFromClient(msg: JsonRpcMessage): void {
    if (isResponse(msg)) {
      const existing = this.pendingPermissions.get(msg.id);
      if (existing) {
        this.deletePendingPermission(existing);
      }
      return;
    }
    if (!isRequest(msg)) {
      return;
    }
    if (msg.method === "session/new") {
      const params = (msg.params ?? {}) as Record<string, unknown>;
      const cwd = typeof params.cwd === "string" ? params.cwd : "";
      this.pending.set(msg.id, { kind: "new", data: { cwd } });
      return;
    }
    if (msg.method === "session/attach") {
      const params = (msg.params ?? {}) as Record<string, unknown>;
      const sessionId =
        typeof params.sessionId === "string" ? params.sessionId : "";
      this.pending.set(msg.id, { kind: "attach", data: { sessionId } });
      return;
    }
    // session/load (older) and session/resume (newer ACP draft) both
    // bind the client to an existing session as a controller. Track
    // them so a daemon restart's replayAttach loop can find them.
    if (msg.method === "session/load" || msg.method === "session/resume") {
      const params = (msg.params ?? {}) as Record<string, unknown>;
      const sessionId =
        typeof params.sessionId === "string" ? params.sessionId : "";
      const cwd = typeof params.cwd === "string" ? params.cwd : "";
      this.pending.set(msg.id, { kind: "load", data: { sessionId, cwd } });
    }
  }

  observeFromServer(msg: JsonRpcMessage): void {
    if (isRequest(msg)) {
      if (msg.method === "session/request_permission") {
        const params = (msg.params ?? {}) as Record<string, unknown>;
        const sessionId =
          typeof params.sessionId === "string" ? params.sessionId : undefined;
        if (sessionId) {
          const toolCall = params.toolCall as
            | { toolCallId?: unknown }
            | undefined;
          const toolCallId =
            toolCall && typeof toolCall.toolCallId === "string"
              ? toolCall.toolCallId
              : undefined;
          const entry: PendingPermission = {
            requestId: msg.id,
            sessionId,
            toolCallId,
            params,
          };
          this.pendingPermissions.set(msg.id, entry);
          if (toolCallId) {
            this.pendingPermissionsByToolCall.set(toolCallId, entry);
          }
        }
      }
      return;
    }
    if (!isResponse(msg)) {
      return;
    }
    if (msg.error) {
      this.pending.delete(msg.id);
      return;
    }
    const pending = this.pending.get(msg.id);
    if (!pending) {
      return;
    }
    this.pending.delete(msg.id);
    const result = (msg.result ?? {}) as Record<string, unknown>;
    const sessionId =
      typeof result.sessionId === "string" ? result.sessionId : undefined;
    if (!sessionId) {
      return;
    }
    const meta = result._meta as Record<string, unknown> | undefined;
    const hydraMeta = extractHydraMeta(meta);
    const upstreamSessionId = hydraMeta.upstreamSessionId;
    const agentId = hydraMeta.agentId;
    let pendingCwd = "";
    if (pending.kind === "new" || pending.kind === "load") {
      pendingCwd = pending.data.cwd;
    }
    const cwd = hydraMeta.cwd ?? pendingCwd;
    if (!upstreamSessionId || !agentId || !cwd) {
      return;
    }
    this.contexts.set(sessionId, {
      sessionId,
      upstreamSessionId,
      agentId,
      cwd,
      title: hydraMeta.name,
      agentArgs: hydraMeta.agentArgs,
    });
  }

  list(): ResumeContext[] {
    return [...this.contexts.values()];
  }

  forget(sessionId: string): void {
    this.contexts.delete(sessionId);
  }

  clearPending(): void {
    this.pending.clear();
  }

  takePendingPermissions(): PendingPermission[] {
    const out = [...this.pendingPermissions.values()];
    this.pendingPermissions.clear();
    this.pendingPermissionsByToolCall.clear();
    return out;
  }

  takePendingPermission(requestId: JsonRpcId): PendingPermission | undefined {
    const found = this.pendingPermissions.get(requestId);
    if (found) {
      this.deletePendingPermission(found);
    }
    return found;
  }

  takePendingPermissionByToolCall(
    toolCallId: string,
  ): PendingPermission | undefined {
    const found = this.pendingPermissionsByToolCall.get(toolCallId);
    if (found) {
      this.deletePendingPermission(found);
    }
    return found;
  }

  private deletePendingPermission(entry: PendingPermission): void {
    this.pendingPermissions.delete(entry.requestId);
    if (entry.toolCallId) {
      this.pendingPermissionsByToolCall.delete(entry.toolCallId);
    }
  }
}

function isRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return "method" in msg && "id" in msg && msg.id !== undefined;
}

function isResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return !("method" in msg) && "id" in msg;
}
