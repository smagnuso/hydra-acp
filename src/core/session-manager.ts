import * as fs from "node:fs/promises";
import { AgentInstance, type AgentInstanceOptions } from "./agent-instance.js";
import { Registry, planSpawn } from "./registry.js";
import {
  HYDRA_SESSION_PREFIX,
  Session,
  extractPromptText,
  firstLine,
} from "./session.js";
import {
  SessionStore,
  recordFromMemorySession,
  type PersistedAgentCommand,
  type SessionRecord,
} from "./session-store.js";
import { HistoryStore, type HistoryEntry as HistoryStoreEntry } from "./history-store.js";
import { paths } from "./paths.js";
import type { AdvertisedCommand } from "./hydra-commands.js";
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
  // Snapshot state restored from meta.json so the first attach response
  // can deliver the right model/mode/commands via _meta before the
  // agent re-emits.
  currentModel?: string;
  currentMode?: string;
  agentCommands?: AdvertisedCommand[];
  // Original create time, preserved across resurrect so `sessions list`
  // shows when the conversation actually began rather than the latest
  // wakeup.
  createdAt?: string;
}

export type AgentSpawner = (opts: AgentInstanceOptions) => AgentInstance;

export interface SessionManagerOptions {
  idleTimeoutMs?: number;
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private resurrectionInflight = new Map<string, Promise<Session>>();
  private spawner: AgentSpawner;
  private store: SessionStore;
  private histories: HistoryStore;
  private idleTimeoutMs: number;
  // Serialize meta.json read-modify-write operations per session id so
  // concurrent snapshot updates (e.g. an agent emitting model + mode
  // back-to-back) don't lose writes via interleaved reads.
  private metaWriteQueues = new Map<string, Promise<unknown>>();

  constructor(
    private registry: Registry,
    spawner?: AgentSpawner,
    store?: SessionStore,
    options: SessionManagerOptions = {},
  ) {
    this.spawner = spawner ?? ((opts) => AgentInstance.spawn(opts));
    this.store = store ?? new SessionStore();
    this.histories = new HistoryStore();
    this.idleTimeoutMs = options.idleTimeoutMs ?? 0;
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
      historyStore: this.histories,
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
      clientInfo: { name: "hydra", version: "0.1.0" },
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
      historyStore: this.histories,
      currentModel: params.currentModel,
      currentMode: params.currentMode,
      agentCommands: params.agentCommands,
      // Only gate the first-prompt title heuristic when we actually have
      // a title to preserve. A title-less session (lost to a write race
      // or never seeded) should re-derive from the next prompt rather
      // than stay stuck.
      firstPromptSeeded: !!params.title,
      createdAt: params.createdAt
        ? new Date(params.createdAt).getTime()
        : undefined,
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
        clientInfo: { name: "hydra", version: "0.1.0" },
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
        // History follows the same lifecycle as the session record —
        // an idle-close (deleteRecord: false) keeps both so the next
        // resurrect can replay; an explicit destroy drops both.
        void this.histories.delete(session.sessionId).catch(() => undefined);
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
    session.onModelChange((model) => {
      void this.persistSnapshot(session.sessionId, { currentModel: model }).catch(
        () => undefined,
      );
    });
    session.onModeChange((mode) => {
      void this.persistSnapshot(session.sessionId, { currentMode: mode }).catch(
        () => undefined,
      );
    });
    session.onAgentCommandsChange((commands) => {
      void this.persistSnapshot(session.sessionId, {
        agentCommands: commands.map((c) => ({
          name: c.name,
          ...(c.description !== undefined ? { description: c.description } : {}),
        })),
      }).catch(() => undefined);
    });
    this.sessions.set(session.sessionId, session);
    // Read-modify-write so a resurrect preserves fields the in-memory
    // Session doesn't know about (originally agentCommands, and
    // createdAt for sessions that pre-date this code path). For a
    // brand-new session there's no record yet, so we write the
    // session's current view.
    await this.enqueueMetaWrite(session.sessionId, async () => {
      const existing = await this.store.read(session.sessionId);
      const merged = mergeForPersistence(session, existing);
      await this.store.write(merged);
    }).catch(() => undefined);
  }

  // Resolve a session's recorded history without forcing a resurrect.
  // Always loads from disk — that's the source of truth whether the
  // session is hot or cold. Returns undefined if the session id is
  // unknown to both the live map and disk store, so the caller can
  // distinguish "no history yet" (empty array) from "404".
  async getHistory(
    sessionId: string,
  ): Promise<HistoryStoreEntry[] | undefined> {
    if (this.sessions.has(sessionId)) {
      return this.histories.load(sessionId).catch(() => []);
    }
    const record = await this.store.read(sessionId);
    if (!record) {
      return undefined;
    }
    return this.histories.load(sessionId).catch(() => []);
  }

  async loadFromDisk(sessionId: string): Promise<ResurrectParams | undefined> {
    const record = await this.store.read(sessionId);
    if (!record) {
      return undefined;
    }
    // Self-heal a missing title from the first prompt_received in the
    // session's history. A title can be lost if the daemon was killed
    // between setTitle's in-memory set and persistTitle's disk write;
    // re-deriving here means any subsequent load recovers the title
    // (and the next attach persists it back).
    let title = record.title;
    if (!title) {
      title = await this.deriveTitleFromHistory(sessionId);
    }
    return {
      hydraSessionId: record.sessionId,
      upstreamSessionId: record.upstreamSessionId,
      agentId: record.agentId,
      cwd: record.cwd,
      title,
      agentArgs: record.agentArgs,
      currentModel: record.currentModel,
      currentMode: record.currentMode,
      agentCommands: record.agentCommands,
      createdAt: record.createdAt,
    };
  }

  // Best-effort: peek at the persisted history's first prompt and use
  // its first line (capped to 200 chars) as a session title. Returns
  // undefined if no usable prompt is found or any I/O fails.
  private async deriveTitleFromHistory(
    sessionId: string,
  ): Promise<string | undefined> {
    const history = await this.histories.load(sessionId).catch(() => []);
    for (const entry of history) {
      const params = entry.params as
        | { update?: { sessionUpdate?: string; prompt?: unknown } }
        | undefined;
      if (params?.update?.sessionUpdate !== "prompt_received") {
        continue;
      }
      const text = extractPromptText(params.update.prompt);
      const line = firstLine(text, 200);
      if (line) {
        return line;
      }
    }
    return undefined;
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

  async list(filter: { cwd?: string } = {}): Promise<SessionListEntry[]> {
    const entries: SessionListEntry[] = [];
    const liveIds = new Set<string>();
    for (const session of this.sessions.values()) {
      if (filter.cwd && session.cwd !== filter.cwd) {
        continue;
      }
      liveIds.add(session.sessionId);
      const used =
        (await historyMtimeIso(session.sessionId)) ??
        new Date(session.updatedAt).toISOString();
      entries.push({
        sessionId: session.sessionId,
        upstreamSessionId: session.upstreamSessionId,
        cwd: session.cwd,
        title: session.title,
        agentId: session.agentId,
        updatedAt: used,
        attachedClients: session.attachedCount,
        status: "live",
      });
    }
    const records = await this.store.list().catch(() => []);
    for (const r of records) {
      if (liveIds.has(r.sessionId)) {
        continue;
      }
      if (filter.cwd && r.cwd !== filter.cwd) {
        continue;
      }
      const used = (await historyMtimeIso(r.sessionId)) ?? r.updatedAt;
      entries.push({
        sessionId: r.sessionId,
        upstreamSessionId: r.upstreamSessionId,
        cwd: r.cwd,
        title: r.title,
        agentId: r.agentId,
        updatedAt: used,
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

  async hasRecord(sessionId: string): Promise<boolean> {
    const record = await this.store.read(sessionId).catch(() => undefined);
    return record !== undefined;
  }

  // Persist a title update from Session.setTitle. The on-disk record
  // was written at create time; updating it here keeps the session
  // record's title in sync with what was broadcast to clients so a
  // daemon restart (and later resurrect) restores the same title.
  private async persistTitle(sessionId: string, title: string): Promise<void> {
    await this.enqueueMetaWrite(sessionId, async () => {
      const record = await this.store.read(sessionId);
      if (!record) {
        return;
      }
      await this.store.write({
        ...record,
        title,
        updatedAt: new Date().toISOString(),
      });
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
    await this.enqueueMetaWrite(sessionId, async () => {
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
    });
  }

  // Update one or more snapshot fields (model, mode, commands) in
  // meta.json. Used so cold-resurrect can deliver the latest snapshot
  // to attaching clients via the attach response _meta. No-op if the
  // session record has gone away (race with deleteRecord).
  private async persistSnapshot(
    sessionId: string,
    update: {
      currentModel?: string;
      currentMode?: string;
      agentCommands?: PersistedAgentCommand[];
    },
  ): Promise<void> {
    await this.enqueueMetaWrite(sessionId, async () => {
      const record = await this.store.read(sessionId);
      if (!record) {
        return;
      }
      await this.store.write({
        ...record,
        ...(update.currentModel !== undefined
          ? { currentModel: update.currentModel }
          : {}),
        ...(update.currentMode !== undefined
          ? { currentMode: update.currentMode }
          : {}),
        ...(update.agentCommands !== undefined
          ? { agentCommands: update.agentCommands }
          : {}),
        updatedAt: new Date().toISOString(),
      });
    });
  }

  // Serialize meta.json writes per session id so concurrent
  // read-modify-write operations don't interleave reads.
  private enqueueMetaWrite(
    sessionId: string,
    task: () => Promise<void>,
  ): Promise<void> {
    const prev = this.metaWriteQueues.get(sessionId) ?? Promise.resolve();
    const next = prev.then(task, task);
    const settled = next.catch(() => undefined);
    this.metaWriteQueues.set(sessionId, settled);
    void settled.finally(() => {
      if (this.metaWriteQueues.get(sessionId) === settled) {
        this.metaWriteQueues.delete(sessionId);
      }
    });
    return next;
  }

  async closeAll(): Promise<void> {
    const sessions = [...this.sessions.values()];
    await Promise.allSettled(sessions.map((s) => s.close()));
    this.sessions.clear();
  }

  // Wait for every pending meta.json write to settle. Daemon shutdown
  // hooks call this so a SIGTERM doesn't kill the process mid-write
  // and lose a freshly-set title (or model/mode/commands).
  async flushMetaWrites(): Promise<void> {
    const pending = [...this.metaWriteQueues.values()];
    if (pending.length === 0) {
      return;
    }
    await Promise.allSettled(pending);
  }
}

// Build the record we'll persist to meta.json. Read-modify-write style:
// fields from the live Session win for the things it tracks, and we
// reach back to the on-disk record for fields the Session deliberately
// doesn't carry across a resurrect (createdAt, agentCommands).
function mergeForPersistence(
  session: Session,
  existing: SessionRecord | undefined,
): Omit<SessionRecord, "version"> {
  const persistedCommands =
    session.mergedAvailableCommands().length > 0
      ? session
          .agentOnlyAdvertisedCommands()
          .map((c): PersistedAgentCommand => {
            if (c.description !== undefined) {
              return { name: c.name, description: c.description };
            }
            return { name: c.name };
          })
      : undefined;
  const agentCommands = persistedCommands ?? existing?.agentCommands;
  return recordFromMemorySession({
    sessionId: session.sessionId,
    upstreamSessionId: session.upstreamSessionId,
    agentId: session.agentId,
    cwd: session.cwd,
    title: session.title,
    agentArgs: session.agentArgs,
    currentModel: session.currentModel ?? existing?.currentModel,
    currentMode: session.currentMode ?? existing?.currentMode,
    agentCommands,
    createdAt: existing?.createdAt ?? new Date(session.createdAt).toISOString(),
  });
}

// "Last meaningful activity" for the picker/listing's USED hint. Uses
// the history.jsonl mtime — it only gets touched on recordable
// broadcasts (user prompts, agent chunks, tool calls) and skips noisy
// state pings (model/mode/title/commands), so an idle session reads
// honestly idle. Returns undefined when the file doesn't exist (e.g.
// freshly created session that hasn't been prompted yet) so callers
// can fall back to the on-disk record's updatedAt.
async function historyMtimeIso(sessionId: string): Promise<string | undefined> {
  try {
    const st = await fs.stat(paths.historyFile(sessionId));
    return new Date(st.mtimeMs).toISOString();
  } catch {
    return undefined;
  }
}
