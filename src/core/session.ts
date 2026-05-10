import { nanoid } from "nanoid";
import { AgentInstance } from "./agent-instance.js";
import type { JsonRpcConnection } from "../acp/connection.js";
import type { HistoryPolicy, SessionRole } from "../acp/types.js";
import { JsonRpcErrorCodes } from "../acp/types.js";

export interface AttachedClient {
  clientId: string;
  role: SessionRole;
  connection: JsonRpcConnection;
  clientInfo?: { name: string; version?: string };
}

interface CachedNotification {
  method: string;
  params: unknown;
  recordedAt: number;
}

export interface SessionInit {
  cwd: string;
  agentId: string;
  agent: AgentInstance;
  upstreamSessionId: string;
  title?: string;
  sessionId?: string;
  agentMeta?: Record<string, unknown>;
  agentArgs?: string[];
}

export class Session {
  readonly sessionId: string;
  readonly cwd: string;
  readonly agentId: string;
  readonly agent: AgentInstance;
  readonly upstreamSessionId: string;
  readonly agentMeta: Record<string, unknown> | undefined;
  readonly agentArgs: string[] | undefined;
  title: string | undefined;
  updatedAt: number;

  private clients = new Map<string, AttachedClient>();
  private history: CachedNotification[] = [];
  private promptQueue: Array<() => Promise<void>> = [];
  private promptInFlight = false;
  private closed = false;
  private closeHandlers: Array<() => void> = [];

  constructor(init: SessionInit) {
    this.sessionId = init.sessionId ?? `sess_${nanoid(16)}`;
    this.cwd = init.cwd;
    this.agentId = init.agentId;
    this.agent = init.agent;
    this.upstreamSessionId = init.upstreamSessionId;
    this.agentMeta = init.agentMeta;
    this.agentArgs = init.agentArgs;
    this.title = init.title;
    this.updatedAt = Date.now();

    this.agent.connection.onNotification("session/update", (params) => {
      this.recordAndBroadcast("session/update", params);
    });
    this.agent.connection.onRequest("session/request_permission", async (params) => {
      return this.handlePermissionRequest(params);
    });
    this.agent.onExit(() => {
      this.markClosed();
    });
  }

  get attachedCount(): number {
    return this.clients.size;
  }

  attach(client: AttachedClient, historyPolicy: HistoryPolicy): CachedNotification[] {
    if (this.closed) {
      throw withCode(
        new Error("session is closed"),
        JsonRpcErrorCodes.SessionNotFound,
      );
    }
    if (this.clients.has(client.clientId)) {
      throw withCode(
        new Error(`client ${client.clientId} is already attached`),
        JsonRpcErrorCodes.AlreadyAttached,
      );
    }
    this.clients.set(client.clientId, client);
    this.updatedAt = Date.now();
    if (historyPolicy === "none") {
      return [];
    }
    if (historyPolicy === "pending_only") {
      return [];
    }
    return [...this.history];
  }

  detach(clientId: string): void {
    if (this.clients.delete(clientId)) {
      this.updatedAt = Date.now();
    }
  }

  async prompt(clientId: string, params: unknown): Promise<unknown> {
    const client = this.clients.get(clientId);
    if (!client) {
      throw withCode(
        new Error("client not attached"),
        JsonRpcErrorCodes.SessionNotFound,
      );
    }
    if (client.role !== "controller") {
      throw withCode(
        new Error("only controllers may send prompts"),
        JsonRpcErrorCodes.RoleNotPermitted,
      );
    }
    return this.enqueuePrompt(async () => {
      return this.agent.connection.request("session/prompt", {
        ...(params as object),
        sessionId: this.upstreamSessionId,
      });
    });
  }

  async cancel(clientId: string): Promise<unknown> {
    const client = this.clients.get(clientId);
    if (!client || client.role !== "controller") {
      throw withCode(
        new Error("only controllers may cancel"),
        JsonRpcErrorCodes.RoleNotPermitted,
      );
    }
    return this.agent.connection.request("session/cancel", {
      sessionId: this.upstreamSessionId,
    });
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    await this.agent.kill().catch(() => undefined);
    this.markClosed();
  }

  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  private markClosed(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const client of this.clients.values()) {
      void client.connection
        .notify("session/closed", { sessionId: this.sessionId })
        .catch(() => undefined);
    }
    this.clients.clear();
    for (const handler of this.closeHandlers) {
      handler();
    }
  }

  private rewriteForClient(params: unknown): unknown {
    if (params && typeof params === "object" && !Array.isArray(params)) {
      const obj = params as Record<string, unknown>;
      if (obj.sessionId === this.upstreamSessionId) {
        return { ...obj, sessionId: this.sessionId };
      }
    }
    return params;
  }

  private recordAndBroadcast(method: string, params: unknown): void {
    const rewritten = this.rewriteForClient(params);
    this.history.push({ method, params: rewritten, recordedAt: Date.now() });
    if (this.history.length > 1000) {
      this.history = this.history.slice(-500);
    }
    this.updatedAt = Date.now();
    for (const client of this.clients.values()) {
      void client.connection.notify(method, rewritten).catch(() => undefined);
    }
  }

  private async handlePermissionRequest(params: unknown): Promise<unknown> {
    const controllers = [...this.clients.values()].filter((c) => c.role === "controller");
    if (controllers.length === 0) {
      throw withCode(
        new Error("no controllers attached to handle permission request"),
        JsonRpcErrorCodes.PermissionDenied,
      );
    }
    const clientParams = this.rewriteForClient(params);
    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        fn();
      };
      for (const controller of controllers) {
        void controller.connection
          .request("session/request_permission", clientParams)
          .then((result) => {
            settle(() => {
              for (const c of controllers) {
                if (c.clientId !== controller.clientId) {
                  void c.connection
                    .notify("session/permission_resolved", {
                      ...(clientParams as object),
                      resolvedBy: controller.clientId,
                      result,
                    })
                    .catch(() => undefined);
                }
              }
              resolve(result);
            });
          })
          .catch((err) => {
            settle(() => reject(err));
          });
      }
    });
  }

  private async enqueuePrompt(task: () => Promise<unknown>): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const run = async (): Promise<void> => {
        try {
          const result = await task();
          resolve(result);
        } catch (err) {
          reject(err as Error);
        }
      };
      this.promptQueue.push(run);
      void this.drainQueue();
    });
  }

  private async drainQueue(): Promise<void> {
    if (this.promptInFlight) {
      return;
    }
    this.promptInFlight = true;
    try {
      while (this.promptQueue.length > 0) {
        const next = this.promptQueue.shift();
        if (next) {
          await next();
        }
      }
    } finally {
      this.promptInFlight = false;
    }
  }
}

function withCode(err: Error, code: number): Error & { code: number } {
  (err as Error & { code: number }).code = code;
  return err as Error & { code: number };
}
