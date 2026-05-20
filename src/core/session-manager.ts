import * as fs from "node:fs/promises";
import * as os from "node:os";
import { customAlphabet } from "nanoid";
import { AgentInstance, type AgentInstanceOptions, type AgentLogger } from "./agent-instance.js";
import {
  Registry,
  planSpawn,
  type AgentInstallProgressCallback,
} from "./registry.js";
import {
  HYDRA_SESSION_PREFIX,
  Session,
  extractPromptText,
  firstLine,
  type UsageSnapshot,
} from "./session.js";
import {
  SessionStore,
  generateLineageId,
  recordFromMemorySession,
  type PersistedAgentCommand,
  type PersistedAgentMode,
  type PersistedUsage,
  type SessionRecord,
} from "./session-store.js";
import { HistoryStore, type HistoryEntry as HistoryStoreEntry } from "./history-store.js";
import { paths } from "./paths.js";
import { saveHistory as savePromptHistory } from "../tui/history.js";
import type { Bundle } from "./bundle.js";
import type { AdvertisedCommand, AdvertisedMode } from "./hydra-commands.js";
import type { SessionListEntry } from "../acp/types.js";
import { JsonRpcErrorCodes, ACP_PROTOCOL_VERSION } from "../acp/types.js";
import { HYDRA_VERSION } from "./hydra-version.js";
import { loadQueue, rewriteQueue } from "./queue-store.js";

// Persisted queued prompts older than this are dropped at restart
// rather than re-fired. Queues are live intent; if hydra was down
// long enough for the prompts to go stale, blasting through them on
// restart would surprise the user (and burn API tokens). 15 minutes
// is a defensible default — a crash-restart cycle should be under
// that, and longer downtime means the user has likely moved on.
const QUEUE_REPLAY_TTL_MS = 15 * 60 * 1000;

const HYDRA_ID_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const generateRawSessionId = customAlphabet(HYDRA_ID_ALPHABET, 16);

export interface CreateSessionParams {
  cwd: string;
  agentId: string;
  mcpServers?: unknown[];
  title?: string;
  agentArgs?: string[];
  // One-shot model override. When set, wins over defaultModels[agentId]
  // during bootstrapAgent. Not persisted — resurrect and agent-switch
  // paths don't see it.
  model?: string;
  // Per-request callback that fires while the agent's binary or npm
  // package is being fetched. Forwarded to planSpawn; the daemon WS
  // handler uses it to push hydra-acp/agent_install_progress
  // notifications back to the originating client, isolated from any
  // other concurrent install on the same daemon.
  onInstallProgress?: AgentInstallProgressCallback;
}

export interface ResurrectParams {
  hydraSessionId: string;
  upstreamSessionId: string;
  agentId: string;
  cwd: string;
  title?: string;
  agentArgs?: string[];
  // Per-request callback for agent install progress. See
  // CreateSessionParams.onInstallProgress. Not persisted — populated
  // only on the live call from the WS handler.
  onInstallProgress?: AgentInstallProgressCallback;
  // Snapshot state restored from meta.json so the first attach response
  // can deliver the right model/mode/commands via _meta before the
  // agent re-emits.
  currentModel?: string;
  currentMode?: string;
  currentUsage?: UsageSnapshot;
  agentCommands?: AdvertisedCommand[];
  agentModes?: AdvertisedMode[];
  // Original create time, preserved across resurrect so `sessions list`
  // shows when the conversation actually began rather than the latest
  // wakeup.
  createdAt?: string;
}

export type AgentSpawner = (opts: AgentInstanceOptions) => AgentInstance;

export interface SessionManagerOptions {
  idleTimeoutMs?: number;
  // Per-agent default model id. When a brand-new agent process is spawned
  // (the bootstrapAgent path: create(), /hydra agent switch, import
  // re-seed), hydra issues session/set_model with the entry that matches
  // the agent id so the user lands on their preferred model from the
  // first prompt. Resurrect paths (session/load) skip this — those
  // sessions already carry a user-chosen model from the prior incarnation.
  defaultModels?: Record<string, string>;
  // Cap on entries kept in each session's on-disk history.jsonl. Forwarded
  // to both the shared HistoryStore (read-side trim) and every Session
  // (write-side compact + derived 20%-of-cap compact trigger).
  sessionHistoryMaxEntries?: number;
  // Pino-style logger forwarded to each Session so idle-close + explicit
  // close paths leave a trail in daemon.log (the close path used to be
  // completely silent, making it hard to tell agent-killed-by-us apart
  // from agent-died-on-its-own).
  logger?: AgentLogger;
  // npm registry URL forwarded to planSpawn for npm-distributed agents.
  // Overrides the user's global .npmrc so installs hit the intended registry.
  npmRegistry?: string;
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private resurrectionInflight = new Map<string, Promise<Session>>();
  private spawner: AgentSpawner;
  private store: SessionStore;
  private histories: HistoryStore;
  private idleTimeoutMs: number;
  private defaultModels: Record<string, string>;
  private sessionHistoryMaxEntries: number;
  // Serialize meta.json read-modify-write operations per session id so
  // concurrent snapshot updates (e.g. an agent emitting model + mode
  // back-to-back) don't lose writes via interleaved reads.
  private metaWriteQueues = new Map<string, Promise<unknown>>();
  private logger?: AgentLogger;
  private npmRegistry?: string;

  constructor(
    private registry: Registry,
    spawner?: AgentSpawner,
    store?: SessionStore,
    options: SessionManagerOptions = {},
  ) {
    this.spawner = spawner ?? ((opts) => AgentInstance.spawn(opts));
    this.store = store ?? new SessionStore();
    this.sessionHistoryMaxEntries = options.sessionHistoryMaxEntries ?? 1000;
    this.histories = new HistoryStore({ maxEntries: this.sessionHistoryMaxEntries });
    this.idleTimeoutMs = options.idleTimeoutMs ?? 0;
    this.defaultModels = options.defaultModels ?? {};
    this.logger = options.logger;
    this.npmRegistry = options.npmRegistry;
  }

  async create(params: CreateSessionParams): Promise<Session> {
    const fresh = await this.bootstrapAgent({
      agentId: params.agentId,
      cwd: params.cwd,
      agentArgs: params.agentArgs,
      mcpServers: params.mcpServers,
      model: params.model,
      onInstallProgress: params.onInstallProgress,
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
      logger: this.logger,
      spawnReplacementAgent: (p) =>
        this.bootstrapAgent({ ...p, mcpServers: [] }),
      historyStore: this.histories,
      historyMaxEntries: this.sessionHistoryMaxEntries,
      currentModel: fresh.initialModel,
      currentMode: fresh.initialMode,
      agentModes: fresh.initialModes,
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

    // Import-reseed path: meta.json was written by import() with an
    // empty upstreamSessionId, signaling we should bootstrap a fresh
    // agent and let it absorb the imported history as a takeover
    // transcript rather than calling session/load against an id this
    // install has never heard of.
    if (params.upstreamSessionId === "") {
      return this.doResurrectFromImport(params);
    }

    const plan = await planSpawn(agentDef, params.agentArgs ?? [], {
      npmRegistry: this.npmRegistry,
      onInstallProgress: params.onInstallProgress,
    });
    const agent = this.spawner({
      agentId: params.agentId,
      cwd: params.cwd,
      plan,
    });

    try {
      await agent.connection.request("initialize", {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "hydra", version: HYDRA_VERSION },
      });
    } catch (err) {
      await agent.kill().catch(() => undefined);
      throw err;
    }

    let loadResult: Record<string, unknown> | undefined;
    try {
      loadResult = await agent.connection.request<Record<string, unknown>>(
        "session/load",
        {
          sessionId: params.upstreamSessionId,
          cwd: params.cwd,
          mcpServers: [],
        },
      );
    } catch (err) {
      // Agent forgot the upstream id (e.g. its store was wiped). Drop
      // this agent and recover via the import-reseed path: a fresh
      // session/new gives us a new upstream id, attachManagerHooks
      // persists it to meta.json, and seedFromImport replays the
      // history transcript into the new agent so the user keeps the
      // conversation context.
      process.stderr.write(
        `session/load failed for upstream ${params.upstreamSessionId} on ${params.agentId} (${(err as Error).message}); recovering via import-reseed\n`,
      );
      await agent.kill().catch(() => undefined);
      return this.doResurrectFromImport(params);
    }

    // session/load asks the agent to replay the conversation via
    // session/update notifications. We already have that history in
    // history.jsonl, and we're about to wire up wireAgent's session/update
    // handler — which would flush the buffered replay through
    // recordAndBroadcast and re-append every entry. That doubles the log
    // every resurrect, drags in /hydra-internal prompts the agent
    // remembers but we deliberately didn't record, and breaks the TUI's
    // turn bracketing on reload (each replayed slice looks like a turn
    // that started but never reached turn_complete).
    agent.connection.drainBuffered("session/update");

    const session = new Session({
      sessionId: params.hydraSessionId,
      cwd: params.cwd,
      agentId: params.agentId,
      agent,
      upstreamSessionId: params.upstreamSessionId,
      agentMeta: loadResult?._meta as Record<string, unknown> | undefined,
      title: params.title,
      agentArgs: params.agentArgs,
      idleTimeoutMs: this.idleTimeoutMs,
      logger: this.logger,
      spawnReplacementAgent: (p) =>
        this.bootstrapAgent({ ...p, mcpServers: [] }),
      historyStore: this.histories,
      historyMaxEntries: this.sessionHistoryMaxEntries,
      // Prefer what we previously stored from a current_model_update; if
      // we never captured one (e.g. old opencode sessions on disk before
      // this fix), fall back to the model the agent ships in its
      // session/load response body.
      currentModel:
        params.currentModel ?? extractInitialModel(loadResult ?? {}),
      currentMode:
        params.currentMode ?? extractInitialCurrentMode(loadResult ?? {}),
      currentUsage: params.currentUsage,
      agentCommands: params.agentCommands,
      agentModes:
        params.agentModes ?? nonEmptyOrUndefined(extractInitialModes(loadResult ?? {})),
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

  // First-attach path for a session that was created via import(). The
  // on-disk meta.json carries upstreamSessionId="" as the import
  // marker; bootstrap a fresh agent (gets a real upstream id) and kick
  // off seedFromImport so the agent absorbs the historical transcript.
  // attachManagerHooks rewrites meta.json with the new upstreamSessionId,
  // so subsequent resurrects of this session use the normal session/load
  // path.
  private async doResurrectFromImport(params: ResurrectParams): Promise<Session> {
    // Bundles carry the exporter's cwd, which often doesn't exist on
    // this machine when pulling in a session from another user. Fall
    // back to $HOME so the spawn doesn't fail with ENOENT; the merge-
    // write in attachManagerHooks persists the resolved cwd.
    const cwd = await this.resolveImportCwd(params.cwd);
    const fresh = await this.bootstrapAgent({
      agentId: params.agentId,
      cwd,
      agentArgs: params.agentArgs,
      mcpServers: [],
      onInstallProgress: params.onInstallProgress,
    });
    const session = new Session({
      sessionId: params.hydraSessionId,
      cwd,
      agentId: params.agentId,
      agent: fresh.agent,
      upstreamSessionId: fresh.upstreamSessionId,
      agentMeta: fresh.agentMeta,
      title: params.title,
      agentArgs: params.agentArgs,
      idleTimeoutMs: this.idleTimeoutMs,
      logger: this.logger,
      spawnReplacementAgent: (p) =>
        this.bootstrapAgent({ ...p, mcpServers: [] }),
      historyStore: this.histories,
      historyMaxEntries: this.sessionHistoryMaxEntries,
      // Prefer the stored value (set by a previous current_model_update);
      // fall back to whatever the agent ships in its session/new response.
      currentModel: params.currentModel ?? fresh.initialModel,
      currentMode: params.currentMode ?? fresh.initialMode,
      currentUsage: params.currentUsage,
      agentCommands: params.agentCommands,
      agentModes: params.agentModes ?? fresh.initialModes,
      firstPromptSeeded: !!params.title,
      createdAt: params.createdAt
        ? new Date(params.createdAt).getTime()
        : undefined,
    });
    await this.attachManagerHooks(session);
    // Fire and forget — the seed runs through enqueuePrompt inside
    // Session, so any user prompt arriving mid-seed queues behind it.
    void session.seedFromImport().catch(() => undefined);
    return session;
  }

  private async resolveImportCwd(cwd: string): Promise<string> {
    try {
      const stat = await fs.stat(cwd);
      if (stat.isDirectory()) {
        return cwd;
      }
    } catch {
      void 0;
    }
    return os.homedir();
  }

  // Bootstrap a fresh agent process: registry resolve → spawn → initialize
  // → session/new. Shared by create() and the /hydra agent path so both
  // go through the same env / capabilities / error-handling.
  private async bootstrapAgent(params: {
    agentId: string;
    cwd: string;
    agentArgs?: string[];
    mcpServers?: unknown[];
    // Per-invocation model override; takes priority over defaultModels.
    // Only create() forwards this — the agent-switch and import-reseed
    // callsites omit it so the session stays on its existing model.
    model?: string;
    // Per-invocation install-progress callback. Only the WS handler
    // wires this — the in-process /hydra agent-switch path leaves it
    // undefined and falls back to the daemon-log sink.
    onInstallProgress?: AgentInstallProgressCallback;
  }): Promise<{
    agent: AgentInstance;
    upstreamSessionId: string;
    agentMeta?: Record<string, unknown>;
    initialModel?: string;
    initialModes?: AdvertisedMode[];
    initialMode?: string;
  }> {
    const agentDef = await this.registry.getAgent(params.agentId);
    if (!agentDef) {
      const err = new Error(
        `agent ${params.agentId} not found in registry`,
      ) as Error & { code: number };
      err.code = JsonRpcErrorCodes.AgentNotInstalled;
      throw err;
    }
    const plan = await planSpawn(agentDef, params.agentArgs ?? [], {
      npmRegistry: this.npmRegistry,
      onInstallProgress: params.onInstallProgress,
    });
    const agent = this.spawner({
      agentId: params.agentId,
      cwd: params.cwd,
      plan,
    });
    try {
      await agent.connection.request("initialize", {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "hydra", version: HYDRA_VERSION },
      });
      const newResult = await agent.connection.request<Record<string, unknown>>(
        "session/new",
        {
          cwd: params.cwd,
          mcpServers: params.mcpServers ?? [],
        },
      );
      const sessionIdRaw = newResult.sessionId;
      if (typeof sessionIdRaw !== "string") {
        throw new Error(
          `agent ${params.agentId} returned a non-string sessionId from session/new`,
        );
      }
      // Some agents (notably opencode) ship their current model in the
      // session/new response body rather than as a current_model_update
      // notification. Harvest it here so the picker and TUI header have
      // something to render from the very first paint, before any turn
      // runs that might cause the agent to emit a current_model_update.
      let initialModel = extractInitialModel(newResult);
      const desired = params.model ?? this.defaultModels[params.agentId];
      if (desired && desired !== initialModel) {
        try {
          await agent.connection.request("session/set_model", {
            sessionId: sessionIdRaw,
            modelId: desired,
          });
          initialModel = desired;
        } catch {
          // Bad / unsupported model id in config shouldn't break session
          // creation — fall back to whatever the agent picked itself.
          // The user-visible signal is just that the header keeps the
          // old model; misconfigurations surface in daemon logs upstream.
        }
      }
      const initialModes = extractInitialModes(newResult);
      const initialMode = extractInitialCurrentMode(newResult);
      return {
        agent,
        upstreamSessionId: sessionIdRaw,
        agentMeta: newResult._meta as Record<string, unknown> | undefined,
        initialModel,
        initialModes: initialModes.length > 0 ? initialModes : undefined,
        initialMode,
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
  // await so a subsequent /hydra agent's persistAgentChange (which
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
    session.onUsageChange((usage) => {
      void this.persistSnapshot(session.sessionId, {
        currentUsage: usageSnapshotToPersisted(usage),
      }).catch(() => undefined);
    });
    session.onAgentCommandsChange((commands) => {
      void this.persistSnapshot(session.sessionId, {
        agentCommands: commands.map((c) => ({
          name: c.name,
          ...(c.description !== undefined ? { description: c.description } : {}),
        })),
      }).catch(() => undefined);
    });
    session.onAgentModesChange((modes) => {
      void this.persistSnapshot(session.sessionId, {
        agentModes: modes.map((m) => ({
          id: m.id,
          ...(m.name !== undefined ? { name: m.name } : {}),
          ...(m.description !== undefined ? { description: m.description } : {}),
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
      currentUsage: persistedUsageToSnapshot(record.currentUsage),
      agentCommands: record.agentCommands,
      agentModes: record.agentModes,
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

  // Snapshot of which agent versions are currently in use by live
  // sessions, keyed by agentId. Read by the registry-fetch prune sweep
  // so it can skip install dirs that still back a running process.
  activeAgentVersions(): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    for (const session of this.sessions.values()) {
      const id = session.agent.agentId;
      const version = session.agent.version;
      let set = out.get(id);
      if (!set) {
        set = new Set<string>();
        out.set(id, set);
      }
      set.add(version);
    }
    return out;
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
        currentModel: session.currentModel,
        currentUsage: session.currentUsage,
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
        currentModel: r.currentModel,
        currentUsage: r.currentUsage,
        importedFromMachine: r.importedFromMachine,
        importedFromUpstreamSessionId: r.importedFromUpstreamSessionId,
        updatedAt: used,
        attachedClients: 0,
        status: "cold",
      });
    }
    entries.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return entries;
  }

  // Build an export bundle for a session, reading meta + history from
  // disk. Backfills lineageId if the on-disk record pre-dates that
  // field. Returns undefined if the session doesn't exist. Callers
  // populate the bundle's exportedFrom metadata themselves.
  async exportBundle(sessionId: string): Promise<
    | {
        record: SessionRecord & { lineageId: string };
        history: HistoryStoreEntry[];
        promptHistory: string[];
      }
    | undefined
  > {
    const record = await this.store.read(sessionId);
    if (!record) {
      return undefined;
    }
    let withLineage: SessionRecord & { lineageId: string };
    if (record.lineageId) {
      withLineage = record as SessionRecord & { lineageId: string };
    } else {
      // Lazy backfill at export time: write the lineageId back so a
      // subsequent re-export produces the same lineage.
      const lineageId = generateLineageId();
      const backfilled: SessionRecord = { ...record, lineageId };
      await this.enqueueMetaWrite(sessionId, async () => {
        const latest = await this.store.read(sessionId);
        if (!latest) {
          return;
        }
        if (latest.lineageId) {
          return;
        }
        await this.store.write({ ...latest, lineageId });
      }).catch(() => undefined);
      withLineage = backfilled as SessionRecord & { lineageId: string };
    }
    const history = await this.histories.load(sessionId).catch(() => []);
    const promptHistory = await loadPromptHistorySafely(sessionId);
    return { record: withLineage, history, promptHistory };
  }

  // Create a local session from an imported bundle. Without `replace`,
  // a bundle with a lineageId we already have on disk throws
  // BundleAlreadyImported citing the existing local id. With
  // `replace: true`, the existing record is overwritten in-place (its
  // local sessionId is preserved so bookmarks/Slack thread links still
  // resolve), and any live in-memory session is closed so the next
  // attach triggers the import-reseed path.
  async importBundle(
    bundle: Bundle,
    opts: { replace?: boolean; cwd?: string } = {},
  ): Promise<{
    sessionId: string;
    importedFromSessionId: string;
    replaced: boolean;
  }> {
    const existing = await this.store.findByLineageId(bundle.session.lineageId);
    if (existing) {
      if (!opts.replace) {
        const err = new Error(
          `bundle already imported as ${existing.sessionId}`,
        ) as Error & { code: number; existingSessionId: string };
        err.code = JsonRpcErrorCodes.BundleAlreadyImported;
        err.existingSessionId = existing.sessionId;
        throw err;
      }
      // Close any live session backed by this record so the import
      // overwrite isn't racing in-memory state. close() runs the
      // onClose handlers which delete the in-memory entry from
      // this.sessions; deleteRecord:false keeps the disk record so
      // the overwrite below has something to atomically replace.
      const live = this.sessions.get(existing.sessionId);
      if (live) {
        await live.close({ deleteRecord: false }).catch(() => undefined);
      }
      await this.writeImportedRecord({
        sessionId: existing.sessionId,
        bundle,
        preservedCreatedAt: existing.createdAt,
        cwd: opts.cwd,
      });
      return {
        sessionId: existing.sessionId,
        importedFromSessionId: bundle.session.sessionId,
        replaced: true,
      };
    }
    const newId = `${HYDRA_SESSION_PREFIX}${generateRawSessionId()}`;
    await this.writeImportedRecord({
      sessionId: newId,
      bundle,
      cwd: opts.cwd,
    });
    return {
      sessionId: newId,
      importedFromSessionId: bundle.session.sessionId,
      replaced: false,
    };
  }

  // Write the imported bundle's history.jsonl, prompt-history (if
  // present), and meta.json. upstreamSessionId is left empty as the
  // marker that the first attach should bootstrap a fresh agent and
  // run seedFromImport rather than calling session/load.
  private async writeImportedRecord(args: {
    sessionId: string;
    bundle: Bundle;
    preservedCreatedAt?: string;
    // Override the bundle's recorded cwd. Used when importing a
    // session from another machine where the original cwd doesn't
    // exist locally — the caller (CLI / HTTP route) validates the
    // override before passing it in.
    cwd?: string;
  }): Promise<void> {
    // zod's z.unknown() makes params optional in the inferred type, but
    // HistoryStore writes whatever JSON shape it was handed; the on-disk
    // round-trip is identical so the cast is safe.
    await this.histories.rewrite(
      args.sessionId,
      args.bundle.history as HistoryStoreEntry[],
    );
    if (args.bundle.promptHistory && args.bundle.promptHistory.length > 0) {
      await savePromptHistory(
        paths.tuiHistoryFile(args.sessionId),
        args.bundle.promptHistory,
      ).catch(() => undefined);
    }
    const now = new Date().toISOString();
    await this.enqueueMetaWrite(args.sessionId, async () => {
      await this.store.write({
        sessionId: args.sessionId,
        lineageId: args.bundle.session.lineageId,
        upstreamSessionId: "",
        importedFromSessionId: args.bundle.session.sessionId,
        importedFromUpstreamSessionId: args.bundle.session.upstreamSessionId,
        importedFromMachine: args.bundle.exportedFrom.machine,
        agentId: args.bundle.session.agentId,
        cwd: args.cwd ?? args.bundle.session.cwd,
        title: args.bundle.session.title,
        currentModel: args.bundle.session.currentModel,
        currentMode: args.bundle.session.currentMode,
        currentUsage: args.bundle.session.currentUsage,
        agentCommands: args.bundle.session.agentCommands,
        createdAt: args.preservedCreatedAt ?? now,
        updatedAt: now,
      });
    });
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

  // Public retitle entry point that works on live AND cold sessions.
  // - Live: routes through Session.retitle so attached clients receive
  //   a session_info_update broadcast (and persistTitle fires from the
  //   onTitleChange handler, just like /hydra title).
  // - Cold: writes the new title straight into meta.json — there's
  //   nothing in memory to broadcast to, but a later resurrect / list
  //   will pick up the new title.
  // Returns false when no record exists at all (live or on disk).
  async setTitle(sessionId: string, title: string): Promise<boolean> {
    const live = this.get(sessionId);
    if (live) {
      await live.retitle(title);
      return true;
    }
    if (!(await this.hasRecord(sessionId))) {
      return false;
    }
    await this.persistTitle(sessionId, title);
    return true;
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

  // Persist an agent swap from /hydra agent. The on-disk record's
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
      currentUsage?: PersistedUsage;
      agentCommands?: PersistedAgentCommand[];
      agentModes?: PersistedAgentMode[];
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
        ...(update.currentUsage !== undefined
          ? { currentUsage: update.currentUsage }
          : {}),
        ...(update.agentCommands !== undefined
          ? { agentCommands: update.agentCommands }
          : {}),
        ...(update.agentModes !== undefined
          ? { agentModes: update.agentModes }
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

  // Startup hook: scan persisted sessions for non-empty queue files,
  // apply the TTL, resurrect anything with surviving entries, and
  // replay them through the normal queue path. Called from the daemon
  // boot sequence; failures per session are logged and don't block
  // the boot.
  //
  // Concurrency is deliberately sequential — resurrect each session
  // one at a time so a runaway daemon with 100 queued sessions
  // doesn't burst-spawn 100 agents on startup. Inside a single
  // session, the queue still drains in parallel-friendly fashion via
  // drainQueue once resurrect() completes.
  async resurrectPendingQueues(): Promise<void> {
    const records = await this.store.list().catch(() => []);
    for (const rec of records) {
      const queue = await loadQueue(rec.sessionId).catch(() => []);
      if (queue.length === 0) continue;
      const now = Date.now();
      const fresh = queue.filter((e) => now - e.enqueuedAt < QUEUE_REPLAY_TTL_MS);
      const dropped = queue.length - fresh.length;
      if (dropped > 0) {
        this.logger?.info(
          `queue replay: dropping ${dropped} stale prompt(s) for ${rec.sessionId} (TTL ${QUEUE_REPLAY_TTL_MS / 1000}s)`,
        );
        await rewriteQueue(rec.sessionId, fresh).catch(() => undefined);
      }
      if (fresh.length === 0) continue;
      const fromDisk = await this.loadFromDisk(rec.sessionId).catch(() => undefined);
      if (!fromDisk) {
        // Orphan queue file with no meta.json — can't resurrect, but
        // also don't leave the file around as restart cruft.
        this.logger?.warn(
          `queue replay: no meta for ${rec.sessionId}; discarding ${fresh.length} entr${fresh.length === 1 ? "y" : "ies"}`,
        );
        await rewriteQueue(rec.sessionId, []).catch(() => undefined);
        continue;
      }
      try {
        const session = await this.resurrect(fromDisk);
        this.logger?.info(
          `queue replay: resurrected ${rec.sessionId} and replaying ${fresh.length} prompt(s)`,
        );
        session.replayPersistedQueue(fresh);
      } catch (err) {
        this.logger?.warn(
          `queue replay: failed to resurrect ${rec.sessionId}: ${(err as Error).message}`,
        );
      }
    }
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
  const sessionModes = session.availableModes();
  const persistedModes =
    sessionModes.length > 0
      ? sessionModes.map((m): PersistedAgentMode => {
          const out: PersistedAgentMode = { id: m.id };
          if (m.name !== undefined) {
            out.name = m.name;
          }
          if (m.description !== undefined) {
            out.description = m.description;
          }
          return out;
        })
      : undefined;
  const agentModes = persistedModes ?? existing?.agentModes;
  return recordFromMemorySession({
    sessionId: session.sessionId,
    lineageId: existing?.lineageId ?? generateLineageId(),
    upstreamSessionId: session.upstreamSessionId,
    importedFromSessionId: existing?.importedFromSessionId,
    importedFromUpstreamSessionId: existing?.importedFromUpstreamSessionId,
    importedFromMachine: existing?.importedFromMachine,
    agentId: session.agentId,
    cwd: session.cwd,
    title: session.title,
    agentArgs: session.agentArgs,
    currentModel: session.currentModel ?? existing?.currentModel,
    currentMode: session.currentMode ?? existing?.currentMode,
    currentUsage:
      usageSnapshotToPersisted(session.currentUsage) ?? existing?.currentUsage,
    agentCommands,
    agentModes,
    createdAt: existing?.createdAt ?? new Date(session.createdAt).toISOString(),
  });
}

// Convert the in-memory snapshot to the persisted shape. They're
// structurally identical, but kept as distinct types so the persistence
// layer can evolve (e.g. add a `recordedAt`) without changing the
// in-memory contract. Returns undefined when the snapshot is empty.
function usageSnapshotToPersisted(
  usage: UsageSnapshot | undefined,
): PersistedUsage | undefined {
  if (!usage) {
    return undefined;
  }
  const out: PersistedUsage = {};
  if (usage.used !== undefined) {
    out.used = usage.used;
  }
  if (usage.size !== undefined) {
    out.size = usage.size;
  }
  if (usage.costAmount !== undefined) {
    out.costAmount = usage.costAmount;
  }
  if (usage.costCurrency !== undefined) {
    out.costCurrency = usage.costCurrency;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function persistedUsageToSnapshot(
  usage: PersistedUsage | undefined,
): UsageSnapshot | undefined {
  return usage ? { ...usage } : undefined;
}

// Pull a "current model id" from a session/new or session/load response.
// Agents are inconsistent about how they expose this:
//   - opencode: `result.models.currentModelId` (or `result._meta.opencode.modelId`)
//   - hypothetical ACP-spec-strict agent: `result.currentModel` or `result.model`
//   - some agents emit nothing here and only announce via the
//     `current_model_update` notification — those skip this path entirely
// We try the common shapes in order and stop on the first non-empty
// string. Anything we don't recognize returns undefined; the session
// will pick the model up later if/when a current_model_update arrives.
export function extractInitialModel(
  result: Record<string, unknown>,
): string | undefined {
  const direct =
    asString(result.currentModelId) ??
    asString(result.currentModel) ??
    asString(result.modelId) ??
    asString(result.model);
  if (direct) {
    return direct;
  }
  const models = result.models;
  if (models && typeof models === "object" && !Array.isArray(models)) {
    const m =
      asString((models as Record<string, unknown>).currentModelId) ??
      asString((models as Record<string, unknown>).currentModel);
    if (m) {
      return m;
    }
  }
  const meta = result._meta;
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    for (const [key, value] of Object.entries(
      meta as Record<string, unknown>,
    )) {
      // Hydra's own _meta namespace is informational; skip it.
      if (key === "hydra-acp") {
        continue;
      }
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const m =
          asString((value as Record<string, unknown>).modelId) ??
          asString((value as Record<string, unknown>).model) ??
          asString((value as Record<string, unknown>).currentModelId);
        if (m) {
          return m;
        }
      }
    }
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function nonEmptyOrUndefined<T>(arr: T[]): T[] | undefined {
  return arr.length > 0 ? arr : undefined;
}

// Pull an available-modes list from a session/new or session/load response.
// Agents are inconsistent about where they put it:
//   - claude-agent-acp / opencode: `result.modes.availableModes` (items have
//     `{ id, name?, description? }` — sometimes `modeId` instead of `id`)
//   - hypothetical spec-strict agent: top-level `result.availableModes`
//   - notification-only agents: nothing here; modes arrive later via
//     `available_modes_update` and this path returns []
export function extractInitialModes(
  result: Record<string, unknown>,
): AdvertisedMode[] {
  const direct = parseModesList(result.availableModes);
  if (direct.length > 0) {
    return direct;
  }
  const modes = result.modes;
  if (modes && typeof modes === "object" && !Array.isArray(modes)) {
    const fromModesObj = parseModesList(
      (modes as Record<string, unknown>).availableModes,
    );
    if (fromModesObj.length > 0) {
      return fromModesObj;
    }
  }
  const meta = result._meta;
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    for (const [key, value] of Object.entries(
      meta as Record<string, unknown>,
    )) {
      if (key === "hydra-acp") {
        continue;
      }
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const fromMeta = parseModesList(
          (value as Record<string, unknown>).availableModes,
        );
        if (fromMeta.length > 0) {
          return fromMeta;
        }
      }
    }
  }
  return [];
}

// Pull a current-mode id from a session/new or session/load response.
// Mirrors extractInitialModel's structure.
export function extractInitialCurrentMode(
  result: Record<string, unknown>,
): string | undefined {
  const direct =
    asString(result.currentModeId) ??
    asString(result.currentMode) ??
    asString(result.modeId) ??
    asString(result.mode);
  if (direct) {
    return direct;
  }
  const modes = result.modes;
  if (modes && typeof modes === "object" && !Array.isArray(modes)) {
    const m =
      asString((modes as Record<string, unknown>).currentModeId) ??
      asString((modes as Record<string, unknown>).currentMode);
    if (m) {
      return m;
    }
  }
  const meta = result._meta;
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    for (const [key, value] of Object.entries(
      meta as Record<string, unknown>,
    )) {
      if (key === "hydra-acp") {
        continue;
      }
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const m =
          asString((value as Record<string, unknown>).currentModeId) ??
          asString((value as Record<string, unknown>).currentMode) ??
          asString((value as Record<string, unknown>).modeId);
        if (m) {
          return m;
        }
      }
    }
  }
  return undefined;
}

function parseModesList(list: unknown): AdvertisedMode[] {
  if (!Array.isArray(list)) {
    return [];
  }
  const out: AdvertisedMode[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      continue;
    }
    const r = raw as Record<string, unknown>;
    const id = asString(r.id) ?? asString(r.modeId);
    if (!id) {
      continue;
    }
    const mode: AdvertisedMode = { id };
    const name = asString(r.name);
    if (name) {
      mode.name = name;
    }
    const description = asString(r.description);
    if (description) {
      mode.description = description;
    }
    out.push(mode);
  }
  return out;
}

async function loadPromptHistorySafely(sessionId: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(paths.tuiHistoryFile(sessionId), "utf8");
    const out: string[] = [];
    for (const line of raw.split("\n")) {
      if (line.length === 0) {
        continue;
      }
      try {
        const decoded = JSON.parse(line);
        if (typeof decoded === "string") {
          out.push(decoded);
        }
      } catch {
        // Tolerate corrupted lines (older versions or partial writes).
      }
    }
    return out;
  } catch {
    return [];
  }
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
