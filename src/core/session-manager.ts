import { AgentInstance, type AgentInstanceOptions } from "./agent-instance.js";
import { Registry, planSpawn } from "./registry.js";
import { Session } from "./session.js";
import type { SessionListEntry } from "../acp/types.js";
import { JsonRpcErrorCodes } from "../acp/types.js";

export interface CreateSessionParams {
  cwd: string;
  agentId: string;
  mcpServers?: unknown[];
  title?: string;
}

export interface ResurrectParams {
  hydraSessionId: string;
  upstreamSessionId: string;
  agentId: string;
  cwd: string;
  title?: string;
}

export type AgentSpawner = (opts: AgentInstanceOptions) => AgentInstance;

export class SessionManager {
  private sessions = new Map<string, Session>();
  private resurrectionInflight = new Map<string, Promise<Session>>();
  private spawner: AgentSpawner;

  constructor(private registry: Registry, spawner?: AgentSpawner) {
    this.spawner = spawner ?? ((opts) => AgentInstance.spawn(opts));
  }

  async create(params: CreateSessionParams): Promise<Session> {
    const agentDef = await this.registry.getAgent(params.agentId);
    if (!agentDef) {
      const err = new Error(
        `agent ${params.agentId} not found in registry`,
      ) as Error & { code: number };
      err.code = JsonRpcErrorCodes.AgentNotInstalled;
      throw err;
    }
    const plan = planSpawn(agentDef);
    const agent = this.spawner({
      agentId: params.agentId,
      cwd: params.cwd,
      plan,
    });

    const initResult = await agent.connection.request<{
      protocolVersion?: number;
    }>("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "acp-hydra", version: "0.1.0" },
    });
    void initResult;

    const newResult = await agent.connection.request<{
      sessionId: string;
      _meta?: Record<string, unknown>;
    }>("session/new", {
      cwd: params.cwd,
      mcpServers: params.mcpServers ?? [],
    });

    const session = new Session({
      cwd: params.cwd,
      agentId: params.agentId,
      agent,
      upstreamSessionId: newResult.sessionId,
      agentMeta: newResult._meta,
      title: params.title,
    });
    session.onClose(() => {
      this.sessions.delete(session.sessionId);
    });
    this.sessions.set(session.sessionId, session);
    return session;
  }

  async resurrect(params: ResurrectParams): Promise<Session> {
    const existing = this.sessions.get(params.hydraSessionId);
    if (existing) {
      if (existing.upstreamSessionId !== params.upstreamSessionId) {
        const err = new Error(
          `session ${params.hydraSessionId} already exists with a different upstream id`,
        ) as Error & { code: number };
        err.code = JsonRpcErrorCodes.AlreadyAttached;
        throw err;
      }
      return existing;
    }

    const inflight = this.resurrectionInflight.get(params.hydraSessionId);
    if (inflight) {
      return inflight;
    }

    const promise = this.doResurrect(params);
    this.resurrectionInflight.set(params.hydraSessionId, promise);
    try {
      return await promise;
    } finally {
      this.resurrectionInflight.delete(params.hydraSessionId);
    }
  }

  private async doResurrect(params: ResurrectParams): Promise<Session> {
    const existing = this.sessions.get(params.hydraSessionId);
    if (existing) {
      return existing;
    }

    const agentDef = await this.registry.getAgent(params.agentId);
    if (!agentDef) {
      const err = new Error(
        `agent ${params.agentId} not found in registry; cannot resurrect`,
      ) as Error & { code: number };
      err.code = JsonRpcErrorCodes.AgentNotInstalled;
      throw err;
    }
    const plan = planSpawn(agentDef);
    const agent = this.spawner({
      agentId: params.agentId,
      cwd: params.cwd,
      plan,
    });

    await agent.connection.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "acp-hydra", version: "0.1.0" },
    });

    let loadResult: { _meta?: Record<string, unknown> } | undefined;
    try {
      loadResult = await agent.connection.request<{
        _meta?: Record<string, unknown>;
      }>("session/load", {
        sessionId: params.upstreamSessionId,
        cwd: params.cwd,
      });
    } catch (err) {
      await agent.kill().catch(() => undefined);
      throw new Error(
        `agent ${params.agentId} failed to load upstream session ${params.upstreamSessionId}: ${(err as Error).message}`,
      );
    }

    const session = new Session({
      sessionId: params.hydraSessionId,
      cwd: params.cwd,
      agentId: params.agentId,
      agent,
      upstreamSessionId: params.upstreamSessionId,
      agentMeta: loadResult?._meta,
      title: params.title,
    });
    session.onClose(() => {
      this.sessions.delete(session.sessionId);
    });
    this.sessions.set(session.sessionId, session);
    return session;
  }

  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  require(sessionId: string): Session {
    const session = this.sessions.get(sessionId);
    if (!session) {
      const err = new Error(`session ${sessionId} not found`) as Error & {
        code: number;
      };
      err.code = JsonRpcErrorCodes.SessionNotFound;
      throw err;
    }
    return session;
  }

  list(filter?: { cwd?: string }): SessionListEntry[] {
    const entries: SessionListEntry[] = [];
    for (const session of this.sessions.values()) {
      if (filter?.cwd && session.cwd !== filter.cwd) {
        continue;
      }
      entries.push({
        sessionId: session.sessionId,
        cwd: session.cwd,
        title: session.title,
        agentId: session.agentId,
        updatedAt: new Date(session.updatedAt).toISOString(),
        attachedClients: session.attachedCount,
      });
    }
    entries.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return entries;
  }

  async closeAll(): Promise<void> {
    const sessions = [...this.sessions.values()];
    await Promise.allSettled(sessions.map((s) => s.close()));
    this.sessions.clear();
  }
}
