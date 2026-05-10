import { customAlphabet } from "nanoid";

// nanoid's default alphabet is URL-safe (alphanumerics + `-` + `_`). We
// drop both punctuation chars: `-` collides with parsers that treat dashes
// as field separators, and `_` looks doubled against the literal prefix
// (`hydra_session__foo`). Plain alphanumeric is plenty of entropy at
// length 16 (~95 bits).
const HYDRA_ID_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const generateHydraId = customAlphabet(HYDRA_ID_ALPHABET, 16);
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
  private titleHandlers: Array<(title: string) => void> = [];
  // True once we've observed our first session/prompt; gates the
  // first-prompt-seeded title so subsequent prompts don't churn it.
  private firstPromptSeeded = false;
  private idleTimeoutMs: number;
  private idleTimer: NodeJS.Timeout | undefined;

  constructor(init: SessionInit) {
    this.sessionId = init.sessionId ?? `hydra_session_${generateHydraId()}`;
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
      // Pick up agent-emitted session_info_update so the canonical
      // title in this Session matches what clients see broadcast.
      // Forwarded as-is through recordAndBroadcast below.
      this.maybeApplyAgentSessionInfo(params);
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
    this.maybeSeedTitleFromPrompt(params);
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

    // Compat shim for clients that don't yet implement RFD #533's
    // prompt_received. The marker in _meta lets prompt_received-aware
    // clients short-circuit this duplicate.
    const text = extractPromptText(promptParams.prompt);
    if (text.length > 0) {
      this.recordAndBroadcast(
        "session/update",
        {
          sessionId: this.sessionId,
          update: {
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text },
            _meta: { "acp-hydra": { compatFor: "prompt_received" } },
          },
        },
        client.clientId,
      );
    }
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

  async cancel(clientId: string): Promise<void> {
    const client = this.clients.get(clientId);
    if (!client || client.role !== "controller") {
      throw withCode(
        new Error("only controllers may cancel"),
        JsonRpcErrorCodes.RoleNotPermitted,
      );
    }
    // session/cancel is a notification per the ACP spec — agents process it
    // and don't reply. Sending it as a request would hang our promise
    // forever waiting for a response that never comes.
    await this.agent.connection.notify("session/cancel", {
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

  // Subscribe to title updates. The SessionManager hooks this to
  // persist the new title to disk so a daemon restart restores it.
  onTitleChange(handler: (title: string) => void): void {
    this.titleHandlers.push(handler);
  }

  // Update the canonical title and broadcast a session_info_update to
  // every attached client. Clients that already speak the spec's
  // session_info_update need no hydra-specific wiring to pick this up.
  // Idempotent on identical values.
  private setTitle(title: string): void {
    const trimmed = title.trim();
    if (!trimmed || trimmed === this.title) {
      return;
    }
    this.title = trimmed;
    this.recordAndBroadcast("session/update", {
      sessionId: this.sessionId,
      update: {
        sessionUpdate: "session_info_update",
        title: trimmed,
        updatedAt: new Date().toISOString(),
      },
    });
    for (const handler of this.titleHandlers) {
      try {
        handler(trimmed);
      } catch {
        void 0;
      }
    }
  }

  // First-prompt heuristic: derive a session title from the first
  // session/prompt's text. Replaces whatever was set at session/new
  // (typically an editor frame name like "Claude Agent @ acp-hydra")
  // — the first prompt is a better summary for cross-client display
  // than the editor's static frame label. Subsequent prompts don't
  // touch the title; that'd flap as conversations evolved.
  private maybeSeedTitleFromPrompt(params: unknown): void {
    if (this.firstPromptSeeded) {
      return;
    }
    const promptParams = (params ?? {}) as { prompt?: unknown };
    const text = extractPromptText(promptParams.prompt);
    const seed = firstLine(text, 80);
    if (!seed) {
      return;
    }
    this.firstPromptSeeded = true;
    this.setTitle(seed);
  }

  // Pick up an agent-emitted session_info_update and store its title
  // as our canonical record. The notification is also forwarded to
  // clients via the surrounding recordAndBroadcast call. Authoritative
  // — overrides our placeholder.
  private maybeApplyAgentSessionInfo(params: unknown): void {
    const obj = (params ?? {}) as { update?: unknown };
    const update = (obj.update ?? {}) as {
      sessionUpdate?: unknown;
      title?: unknown;
    };
    if (update.sessionUpdate !== "session_info_update") {
      return;
    }
    if (typeof update.title !== "string") {
      return;
    }
    const trimmed = update.title.trim();
    if (!trimmed || trimmed === this.title) {
      return;
    }
    this.title = trimmed;
    this.firstPromptSeeded = true;
    for (const handler of this.titleHandlers) {
      try {
        handler(trimmed);
      } catch {
        void 0;
      }
    }
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

function extractPromptText(prompt: unknown): string {
  if (typeof prompt === "string") {
    return prompt;
  }
  if (!Array.isArray(prompt)) {
    return "";
  }
  return prompt
    .map((b) => {
      if (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string") {
        return (b as { text: string }).text;
      }
      return "";
    })
    .join("");
}

// First non-empty line of `text`, truncated to `max` chars with a
// trailing ellipsis if needed. Used to seed a session title from the
// first user prompt's leading line.
function firstLine(text: string, max: number): string | undefined {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    return line.length > max ? `${line.slice(0, max)}…` : line;
  }
  return undefined;
}
