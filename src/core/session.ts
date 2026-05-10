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
  idleTimeoutMs?: number;
}

export interface CloseOptions {
  deleteRecord?: boolean;
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
  private closeHandlers: Array<(opts: { deleteRecord: boolean }) => void> = [];
  private idleTimeoutMs: number;
  private idleTimer: NodeJS.Timeout | undefined;

  constructor(init: SessionInit) {
    this.sessionId = init.sessionId ?? `hydra_session_${nanoid(16)}`;
    this.cwd = init.cwd;
    this.agentId = init.agentId;
    this.agent = init.agent;
    this.upstreamSessionId = init.upstreamSessionId;
    this.agentMeta = init.agentMeta;
    this.agentArgs = init.agentArgs;
    this.title = init.title;
    this.idleTimeoutMs = init.idleTimeoutMs ?? 0;
    this.updatedAt = Date.now();

    this.agent.connection.onNotification("session/update", (params) => {
      this.recordAndBroadcast("session/update", params);
    });
    this.agent.connection.onRequest("session/request_permission", async (params) => {
      return this.handlePermissionRequest(params);
    });
    this.agent.onExit(() => {
      this.markClosed({ deleteRecord: false });
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
    this.cancelIdleTimer();
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
      this.maybeStartIdleTimer();
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
    this.broadcastPromptReceived(client, params);
    return this.enqueuePrompt(async () => {
      const response = await this.agent.connection.request<unknown>(
        "session/prompt",
        {
          ...(params as object),
          sessionId: this.upstreamSessionId,
        },
      );
      this.broadcastTurnComplete(client.clientId, response);
      return response;
    });
  }

  private broadcastPromptReceived(
    client: AttachedClient,
    params: unknown,
  ): void {
    const promptParams = (params ?? {}) as Record<string, unknown>;
    const sentBy: Record<string, unknown> = { clientId: client.clientId };
    if (client.clientInfo?.name) {
      sentBy.name = client.clientInfo.name;
    }
    if (client.clientInfo?.version) {
      sentBy.version = client.clientInfo.version;
    }
    this.recordAndBroadcast(
      "session/update",
      {
        sessionId: this.sessionId,
        update: {
          sessionUpdate: "prompt_received",
          prompt: promptParams.prompt,
          sentBy,
        },
      },
      client.clientId,
    );
  }

  private broadcastTurnComplete(
    originatorClientId: string,
    response: unknown,
  ): void {
    const stopReason =
      response &&
      typeof response === "object" &&
      "stopReason" in response &&
      typeof (response as { stopReason: unknown }).stopReason === "string"
        ? (response as { stopReason: string }).stopReason
        : undefined;
    const update: Record<string, unknown> = {
      sessionUpdate: "turn_complete",
    };
    if (stopReason !== undefined) {
      update.stopReason = stopReason;
    }
    this.recordAndBroadcast(
      "session/update",
      {
        sessionId: this.sessionId,
        update,
      },
      originatorClientId,
    );
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

  async forwardRequest(method: string, params: unknown): Promise<unknown> {
    return this.agent.connection.request(method, this.rewriteForAgent(params));
  }

  private rewriteForAgent(params: unknown): unknown {
    if (params && typeof params === "object" && !Array.isArray(params)) {
      const obj = params as Record<string, unknown>;
      if (obj.sessionId === this.sessionId) {
        return { ...obj, sessionId: this.upstreamSessionId };
      }
    }
    return params;
  }

  async close(opts: CloseOptions = {}): Promise<void> {
    if (this.closed) {
      return;
    }
    this.cancelIdleTimer();
    await this.agent.kill().catch(() => undefined);
    this.markClosed({ deleteRecord: opts.deleteRecord ?? false });
  }

  onClose(handler: (opts: { deleteRecord: boolean }) => void): void {
    this.closeHandlers.push(handler);
  }

  private markClosed(opts: { deleteRecord: boolean }): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.cancelIdleTimer();
    for (const client of this.clients.values()) {
      void client.connection
        .notify("acp-hydra/session_closed", { sessionId: this.sessionId })
        .catch(() => undefined);
    }
    this.clients.clear();
    for (const handler of this.closeHandlers) {
      handler(opts);
    }
  }

  private maybeStartIdleTimer(): void {
    if (this.closed || this.clients.size > 0 || this.idleTimeoutMs <= 0) {
      return;
    }
    if (this.idleTimer) {
      return;
    }
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      void this.close({ deleteRecord: false }).catch(() => undefined);
    }, this.idleTimeoutMs);
    if (typeof this.idleTimer.unref === "function") {
      this.idleTimer.unref();
    }
  }

  private cancelIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
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

  private recordAndBroadcast(
    method: string,
    params: unknown,
    excludeClientId?: string,
  ): void {
    const rewritten = this.rewriteForClient(params);
    this.history.push({ method, params: rewritten, recordedAt: Date.now() });
    if (this.history.length > 1000) {
      this.history = this.history.slice(-500);
    }
    this.updatedAt = Date.now();
    for (const client of this.clients.values()) {
      if (excludeClientId && client.clientId === excludeClientId) {
        continue;
      }
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
