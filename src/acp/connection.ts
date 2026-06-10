import { nanoid } from "nanoid";
import {
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcNotification,
  type JsonRpcResponse,
  type JsonRpcError,
  JsonRpcErrorCodes,
} from "./types.js";
import type { MessageStream } from "./framing.js";

export type RequestHandler = (params: unknown, method: string) => Promise<unknown>;
export type NotificationHandler = (params: unknown, method: string) => void;

// Thrown by request()/requestWithId() when the connection has already
// been torn down. Distinguished from a generic Error so callers can
// branch on the closed state without string-matching the message.
export class ConnectionClosedError extends Error {
  readonly code = "ERR_CONNECTION_CLOSED" as const;
  constructor(message = "connection is closed") {
    super(message);
    this.name = "ConnectionClosedError";
  }
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}

export class JsonRpcConnection {
  private requestHandlers = new Map<string, RequestHandler>();
  private defaultRequestHandler: RequestHandler | undefined;
  private notificationHandlers = new Map<string, NotificationHandler>();
  // Notifications received before a handler was registered. Some agents
  // (e.g. claude-acp) advertise their command list in the same chunk as
  // the `session/new` response, which is processed before the consumer
  // can attach its `session/update` handler. Without this buffer those
  // notifications would be silently dropped, so e.g. `/model` would
  // never appear in the TUI's slash-completion palette. Capped per
  // method to keep the buffer from growing unboundedly when nothing
  // ever subscribes.
  private bufferedNotifications = new Map<string, JsonRpcNotification[]>();
  private static readonly MAX_BUFFERED_PER_METHOD = 64;
  private pending = new Map<JsonRpcId, PendingRequest>();
  private closed = false;
  private closeHandlers: Array<(err?: Error) => void> = [];
  // Observers for error frames that arrive with no matching pending
  // request — e.g. an agent replying with an error to a notification
  // (which carries no id, so it can't be correlated the normal way).
  // session/cancel is the canonical case: an agent that doesn't support
  // it (current opencode) emits a MethodNotFound/UnsupportedOperation
  // error frame we'd otherwise silently drop. See handleResponse.
  private orphanErrorHandlers: Array<
    (error: { code?: number; message: string; data?: unknown }) => void
  > = [];

  constructor(private stream: MessageStream) {
    this.stream.onMessage((m) => this.handleIncoming(m));
    this.stream.onClose((err) => this.handleClose(err));
  }

  onRequest(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  setDefaultHandler(handler: RequestHandler): void {
    this.defaultRequestHandler = handler;
  }

  onNotification(method: string, handler: NotificationHandler): void {
    this.notificationHandlers.set(method, handler);
    const queued = this.bufferedNotifications.get(method);
    if (!queued) {
      return;
    }
    this.bufferedNotifications.delete(method);
    for (const note of queued) {
      try {
        handler(note.params, note.method);
      } catch {
        void 0;
      }
    }
  }

  // Discard any notifications buffered for the given method without firing
  // handlers. Used by the resurrect path to drop the agent's session/load
  // replay: that replay is the agent re-emitting our own history back at
  // us, and if we flushed it through wireAgent's session/update handler
  // every entry would be re-appended to history.jsonl, doubling the log
  // each time the session was woken up.
  drainBuffered(method: string): number {
    const buf = this.bufferedNotifications.get(method);
    const count = buf?.length ?? 0;
    this.bufferedNotifications.delete(method);
    return count;
  }

  onClose(handler: (err?: Error) => void): void {
    this.closeHandlers.push(handler);
  }

  isClosed(): boolean {
    return this.closed;
  }

  // Subscribe to error frames that can't be matched to a pending request.
  onOrphanError(
    handler: (error: { code?: number; message: string; data?: unknown }) => void,
  ): void {
    this.orphanErrorHandlers.push(handler);
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    return this.requestWithId<T>(method, params).response;
  }

  // Same as request() but exposes the JSON-RPC id assigned to the outbound
  // message. Used when the caller needs to correlate later sideband signals
  // (e.g. permission fan-out) with the specific recipient's request id.
  requestWithId<T = unknown>(
    method: string,
    params?: unknown,
  ): { id: JsonRpcId; response: Promise<T> } {
    if (this.closed) {
      // Synchronously throw — returning a sentinel id (`""` or `0`) would
      // collide with real peer-assigned ids on responses. Callers that
      // need fire-and-forget should catch this or check beforehand.
      throw new ConnectionClosedError();
    }
    const id = nanoid();
    const message: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    const response = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (result) => resolve(result as T),
        reject,
      });
      this.stream.send(message).catch((err) => {
        this.pending.delete(id);
        reject(err);
      });
    });
    return { id, response };
  }

  notify(method: string, params?: unknown): Promise<void> {
    if (this.closed) {
      return Promise.resolve();
    }
    const message: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    return this.stream.send(message);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    await this.stream.close();
  }

  // Force-close with an error. Rejects all pending requests and fires
  // close handlers carrying `err`. Used by transports that detect a
  // failure (e.g. child process crash, spawn ENOENT) the stream itself
  // can't surface as a stdout/stdin error.
  fail(err: Error): void {
    this.handleClose(err);
  }

  private handleIncoming(message: JsonRpcMessage): void {
    if ("method" in message) {
      if ("id" in message && message.id !== undefined) {
        // Never let a failed reply (e.g. ws closed mid-handle) bubble out as
        // an unhandled rejection — that would crash the daemon.
        this.handleRequest(message).catch(() => undefined);
      } else {
        this.handleNotification(message);
      }
    } else if ("id" in message) {
      this.handleResponse(message);
    } else if ("error" in message) {
      // Error frame with no id at all (some agents reply this way to a
      // notification). Route it through handleResponse so orphan-error
      // observers still see it.
      this.handleResponse(message as JsonRpcResponse);
    }
  }

  private async handleRequest(req: JsonRpcRequest): Promise<void> {
    const handler =
      this.requestHandlers.get(req.method) ?? this.defaultRequestHandler;
    if (!handler) {
      await this.sendError(req.id, {
        code: JsonRpcErrorCodes.MethodNotFound,
        message: `Method not found: ${req.method}`,
      }).catch(() => undefined);
      return;
    }
    try {
      const result = await handler(req.params, req.method);
      const response: JsonRpcResponse = {
        jsonrpc: "2.0",
        id: req.id,
        result,
      };
      await this.stream.send(response).catch(() => undefined);
    } catch (err) {
      const error = err as Error & { code?: number; data?: unknown };
      await this.sendError(req.id, {
        code: error.code ?? JsonRpcErrorCodes.InternalError,
        message: error.message,
        data: error.data,
      }).catch(() => undefined);
    }
  }

  private handleNotification(note: JsonRpcNotification): void {
    const handler = this.notificationHandlers.get(note.method);
    if (handler) {
      handler(note.params, note.method);
      return;
    }
    // No handler yet — buffer until one subscribes. Drop oldest when
    // capped so a misbehaving sender can't OOM us.
    let queued = this.bufferedNotifications.get(note.method);
    if (!queued) {
      queued = [];
      this.bufferedNotifications.set(note.method, queued);
    }
    queued.push(note);
    if (queued.length > JsonRpcConnection.MAX_BUFFERED_PER_METHOD) {
      queued.shift();
    }
  }

  private handleResponse(res: JsonRpcResponse): void {
    // id=null indicates a server-synthesized parse-error frame (per
    // JSON-RPC 2.0). It can't correlate to anything we sent; route
    // through the orphan-error path so it isn't silently dropped.
    const pending = res.id === null ? undefined : this.pending.get(res.id);
    if (!pending) {
      // Uncorrelated frame. If it's an error, surface it to orphan-error
      // observers rather than dropping silently — this is how a reply to
      // an id-less notification (e.g. session/cancel) reaches a consumer.
      if (res.error) {
        for (const handler of this.orphanErrorHandlers) {
          try {
            handler({
              code: res.error.code,
              message: res.error.message,
              data: res.error.data,
            });
          } catch {
            void 0;
          }
        }
      }
      return;
    }
    this.pending.delete(res.id as JsonRpcId);
    if (res.error) {
      const err = new Error(res.error.message) as Error & { code?: number; data?: unknown };
      err.code = res.error.code;
      err.data = res.error.data;
      pending.reject(err);
    } else {
      pending.resolve(res.result);
    }
  }

  private async sendError(id: JsonRpcId, error: JsonRpcError): Promise<void> {
    const response: JsonRpcResponse = {
      jsonrpc: "2.0",
      id,
      error,
    };
    await this.stream.send(response);
  }

  private handleClose(err?: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const pending of this.pending.values()) {
      pending.reject(err ?? new Error("connection closed"));
    }
    this.pending.clear();
    for (const handler of this.closeHandlers) {
      handler(err);
    }
  }
}
