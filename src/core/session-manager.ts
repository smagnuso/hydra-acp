import { AgentInstance, type AgentInstanceOptions } from "./agent-instance.js";
import { Registry, planSpawn } from "./registry.js";
import { HYDRA_SESSION_PREFIX, Session } from "./session.js";
import { SessionStore, recordFromMemorySession } from "./session-store.js";
import type { SessionListEntry } from "../acp/types.js";
import { JsonRpcErrorCodes } from "../acp/types.js";

export interface CreateSessionParams {
  cwd: string;
  agentId: string;
  mcpServers?: unknown[];
  title?: string;
  agentArgs?: string[];
}

export interface ResurrectParams {
  hydraSessionId: string;
  upstreamSessionId: string;
  agentId: string;
  cwd: string;
  title?: string;
  agentArgs?: string[];
}

export type AgentSpawner = (opts: AgentInstanceOptions) => AgentInstance;

export interface SessionManagerOptions {
  idleTimeoutMs?: number;
  recentMinutes?: number;
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private resurrectionInflight = new Map<string, Promise<Session>>();
  private spawner: AgentSpawner;
  private store: SessionStore;
  private idleTimeoutMs: number;
  private recentMinutes: number;

  constructor(
    private registry: Registry,
    spawner?: AgentSpawner,
    store?: SessionStore,
    options: SessionManagerOptions = {},
  ) {
    this.spawner = spawner ?? ((opts) => AgentInstance.spawn(opts));
    this.store = store ?? new SessionStore();
    this.idleTimeoutMs = options.idleTimeoutMs ?? 0;
    this.recentMinutes = options.recentMinutes ?? 30;
  }

  async create(params: CreateSessionParams): Promise<Session> {
    const fresh = await this.bootstrapAgent({
      agentId: params.agentId,
      cwd: params.cwd,
      agentArgs: params.agentArgs,
      mcpServers: params.mcpServers,
    });
    const session = new Session({
      cwd: params.cwd,
      agentId: params.agentId,
      agent: fresh.agent,
      upstreamSessionId: fresh.upstreamSessionId,
      agentMeta: fresh.agentMeta,
      title: params.title,
      agentArgs: params.agentArgs,
      idleTimeoutMs: this.idleTimeoutMs,
      spawnReplacementAgent: (p) =>
        this.bootstrapAgent({ ...p, mcpServers: [] }),
    });
    await this.attachManagerHooks(session);
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
    const plan = planSpawn(agentDef, params.agentArgs ?? []);
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
        mcpServers: [],
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
      agentArgs: params.agentArgs,
      idleTimeoutMs: this.idleTimeoutMs,
      spawnReplacementAgent: (p) =>
        this.bootstrapAgent({ ...p, mcpServers: [] }),
    });
    await this.attachManagerHooks(session);
    return session;
  }

  // Bootstrap a fresh agent process: registry resolve → spawn → initialize
  // → session/new. Shared by create() and the /hydra switch path so both
  // go through the same env / capabilities / error-handling.
  private async bootstrapAgent(params: {
    agentId: string;
    cwd: string;
    agentArgs?: string[];
    mcpServers?: unknown[];
  }): Promise<{
    agent: AgentInstance;
    upstreamSessionId: string;
    agentMeta?: Record<string, unknown>;
  }> {
    const agentDef = await this.registry.getAgent(params.agentId);
    if (!agentDef) {
      const err = new Error(
        `agent ${params.agentId} not found in registry`,
      ) as Error & { code: number };
      err.code = JsonRpcErrorCodes.AgentNotInstalled;
      throw err;
    }
    const plan = planSpawn(agentDef, params.agentArgs ?? []);
    const agent = this.spawner({
      agentId: params.agentId,
      cwd: params.cwd,
      plan,
    });
    try {
      await agent.connection.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "acp-hydra", version: "0.1.0" },
      });
      const newResult = await agent.connection.request<{
        sessionId: string;
        _meta?: Record<string, unknown>;
      }>("session/new", {
        cwd: params.cwd,
        mcpServers: params.mcpServers ?? [],
      });
      return {
        agent,
        upstreamSessionId: newResult.sessionId,
        agentMeta: newResult._meta,
      };
    } catch (err) {
      await agent.kill().catch(() => undefined);
      throw err;
    }
  }

  // Hooks that bridge a Session into the manager's persistence/listing
  // bookkeeping. Called from both create() and resurrect() so the same
  // session record + lifecycle handlers are wired regardless of origin.
  // Returns once the initial disk record is written — callers should
  // await so a subsequent /hydra switch's persistAgentChange (which
  // does read-then-write) finds the file in place.
  private async attachManagerHooks(session: Session): Promise<void> {
    session.onClose(({ deleteRecord }) => {
      this.sessions.delete(session.sessionId);
      if (deleteRecord) {
        void this.store.delete(session.sessionId).catch(() => undefined);
      }
    });
    session.onTitleChange((title) => {
      void this.persistTitle(session.sessionId, title).catch(() => undefined);
    });
    session.onAgentChange(({ agentId, upstreamSessionId }) => {
      void this.persistAgentChange(session.sessionId, agentId, upstreamSessionId).catch(
        () => undefined,
      );
    });
    this.sessions.set(session.sessionId, session);
    await this.store
      .write(
        recordFromMemorySession({
          sessionId: session.sessionId,
          upstreamSessionId: session.upstreamSessionId,
          agentId: session.agentId,
          cwd: session.cwd,
          title: session.title,
          agentArgs: session.agentArgs,
        }),
      )
      .catch(() => undefined);
  }

  async loadFromDisk(sessionId: string): Promise<ResurrectParams | undefined> {
    const record = await this.store.read(sessionId);
    if (!record) {
      return undefined;
    }
    return {
      hydraSessionId: record.sessionId,
      upstreamSessionId: record.upstreamSessionId,
      agentId: record.agentId,
      cwd: record.cwd,
      title: record.title,
      agentArgs: record.agentArgs,
    };
  }

  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  // Resolve a user-typed session id (which may have the hydra_session_
  // prefix stripped — that's what `sessions list` and the picker show) to
  // the canonical form that actually exists. Tries the input as-given
  // first, then with the prefix prepended. Returns undefined if neither
  // form resolves to a live or stored session. Foreign ids (anything not
  // following our prefix convention) pass through via the first lookup.
  async resolveCanonicalId(input: string): Promise<string | undefined> {
    if (this.sessions.has(input) || (await this.store.read(input))) {
      return input;
    }
    if (input.startsWith(HYDRA_SESSION_PREFIX)) {
      return undefined;
    }
    const prefixed = HYDRA_SESSION_PREFIX + input;
    if (this.sessions.has(prefixed) || (await this.store.read(prefixed))) {
      return prefixed;
    }
    return undefined;
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

  async list(
    filter: { cwd?: string; all?: boolean } = {},
  ): Promise<SessionListEntry[]> {
    const entries: SessionListEntry[] = [];
    const liveIds = new Set<string>();
    for (const session of this.sessions.values()) {
      if (filter.cwd && session.cwd !== filter.cwd) {
        continue;
      }
      liveIds.add(session.sessionId);
      entries.push({
        sessionId: session.sessionId,
        upstreamSessionId: session.upstreamSessionId,
        cwd: session.cwd,
        title: session.title,
        agentId: session.agentId,
        updatedAt: new Date(session.updatedAt).toISOString(),
        attachedClients: session.attachedCount,
        status: "live",
      });
    }
    const records = await this.store.list().catch(() => []);
    const cutoffMs =
      !filter.all && this.recentMinutes > 0
        ? Date.now() - this.recentMinutes * 60_000
        : 0;
    for (const r of records) {
      if (liveIds.has(r.sessionId)) {
        continue;
      }
      if (filter.cwd && r.cwd !== filter.cwd) {
        continue;
      }
      const ts = new Date(r.updatedAt).getTime();
      if (cutoffMs > 0 && Number.isFinite(ts) && ts < cutoffMs) {
        continue;
      }
      entries.push({
        sessionId: r.sessionId,
        upstreamSessionId: r.upstreamSessionId,
        cwd: r.cwd,
        title: r.title,
        agentId: r.agentId,
        updatedAt: r.updatedAt,
        attachedClients: 0,
        status: "cold",
      });
    }
    entries.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return entries;
  }

  async deleteRecord(sessionId: string): Promise<boolean> {
    const record = await this.store.read(sessionId);
    if (!record) {
      return false;
    }
    await this.store.delete(sessionId).catch(() => undefined);
    return true;
  }

  // Persist a title update from Session.setTitle. The on-disk record
  // was written at create time; updating it here keeps the session
  // record's title in sync with what was broadcast to clients so a
  // daemon restart (and later resurrect) restores the same title.
  private async persistTitle(sessionId: string, title: string): Promise<void> {
    const record = await this.store.read(sessionId);
    if (!record) {
      return;
    }
    await this.store.write({
      ...record,
      title,
      updatedAt: new Date().toISOString(),
    });
  }

  // Persist an agent swap from /hydra switch. The on-disk record's
  // agentId + upstreamSessionId both rotate so a daemon restart (and
  // later resurrect) brings the session back up on the agent the user
  // most recently switched to, not the one it was originally created on.
  private async persistAgentChange(
    sessionId: string,
    agentId: string,
    upstreamSessionId: string,
  ): Promise<void> {
    const record = await this.store.read(sessionId);
    if (!record) {
      return;
    }
    await this.store.write({
      ...record,
      agentId,
      upstreamSessionId,
      updatedAt: new Date().toISOString(),
    });
  }

  async closeAll(): Promise<void> {
    const sessions = [...this.sessions.values()];
    await Promise.allSettled(sessions.map((s) => s.close()));
    this.sessions.clear();
  }
}
