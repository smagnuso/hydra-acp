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

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}

export class JsonRpcConnection {
  private requestHandlers = new Map<string, RequestHandler>();
  private defaultRequestHandler: RequestHandler | undefined;
  private notificationHandlers = new Map<string, NotificationHandler>();
  private pending = new Map<JsonRpcId, PendingRequest>();
  private closed = false;
  private closeHandlers: Array<(err?: Error) => void> = [];

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
  }

  onClose(handler: (err?: Error) => void): void {
    this.closeHandlers.push(handler);
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
      return {
        id: "",
        response: Promise.reject(new Error("connection is closed")),
      };
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
    }
  }

  private handleResponse(res: JsonRpcResponse): void {
    const pending = this.pending.get(res.id);
    if (!pending) {
      return;
    }
    this.pending.delete(res.id);
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
