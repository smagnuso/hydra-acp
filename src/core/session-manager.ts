import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
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
  findMessageIdIndex,
  firstLine,
  parseModelsList,
  type UsageSnapshot,
} from "./session.js";
import {
  SessionStore,
  generateLineageId,
  recordFromMemorySession,
  type PersistedAgentCommand,
  type PersistedAgentMode,
  type PersistedAgentModel,
  type PersistedUsage,
  type SessionRecord,
} from "./session-store.js";
import type { SessionSynopsis } from "./snapshot.js";
import { SynopsisCoordinator } from "./synopsis-coordinator.js";
import { HistoryStore, type HistoryEntry as HistoryStoreEntry } from "./history-store.js";
import { paths } from "./paths.js";
import { expandHome } from "./config.js";
import { saveHistory as savePromptHistory } from "../tui/history.js";
import { encodeBundle, type Bundle } from "./bundle.js";
import type {
  AdvertisedCommand,
  AdvertisedMode,
  AdvertisedModel,
} from "./hydra-commands.js";
import type { AgentCapabilities, SessionListEntry } from "../acp/types.js";
import type { TransformerRef } from "./transformer-manager.js";
import type { ExtensionCommandRegistry } from "./extension-commands.js";
import { JsonRpcErrorCodes, ACP_PROTOCOL_VERSION } from "../acp/types.js";
import { HYDRA_CAT_CLIENT_NAME, HYDRA_VERSION } from "./hydra-version.js";
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
  // Resolved transformer chain for this session.
  transformChain?: TransformerRef[];
  // Set when this session is spawned as a child by a transformer.
  parentSessionId?: string;
  // clientInfo from the WS connection's initialize. acp-ws.ts captures
  // it from `session/new` and threads it here; persisted to meta.json
  // and used by effectiveInteractive as a legacy hint for pre-flag rows.
  originatingClient?: { name: string; version?: string };
  // Caller-supplied initial value of the interactive tristate. Cat
  // passes `false`; everything else leaves it undefined (the first
  // session/prompt will promote it to true).
  interactive?: boolean;
}

export interface ResurrectParams {
  hydraSessionId: string;
  upstreamSessionId: string;
  agentId: string;
  cwd: string;
  title?: string;
  // Persisted synopsis + offset, restored onto the live Session so
  // subsequent regens can no-op when history hasn't grown.
  synopsis?: SessionSynopsis;
  summarizedThroughEntry?: number;
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
  agentModels?: AdvertisedModel[];
  // Original create time, preserved across resurrect so `sessions list`
  // shows when the conversation actually began rather than the latest
  // wakeup.
  createdAt?: string;
  // One-shot: set true by `hydra agent sync` when the local record was
  // minted from an agent-side session/list entry and we want this
  // resurrect to keep the session/load replay so history.jsonl gets
  // populated from the agent's memory. Cleared on the disk record
  // after the resurrect completes.
  pendingHistorySync?: boolean;
  // Propagated from meta.json so resurrected sessions keep their
  // origin (used by effectiveInteractive as a legacy hint).
  originatingClient?: { name: string; version?: string };
  // Persisted tristate flag from meta.json; the live Session carries
  // it forward and persists changes (first prompt promotes undefined→true).
  interactive?: boolean;
  // Local-fork breadcrumbs from meta.json. Read-only on the resurrected
  // Session; surfaced in list views so future UI can show "branched from <id>".
  forkedFromSessionId?: string;
  forkedFromMessageId?: string;
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
  // Optional override: every background synopsis runs on this agent
  // instead of the session's source agent. Forwarded to the synopsis
  // coordinator. Unset → coordinator uses each session's own agentId.
  synopsisAgent?: string;
  // Optional override: model id passed to session/set_model on the
  // ephemeral synopsis agent. Unset → agent picks its default.
  synopsisModel?: string;
  // When true, schedule a background synopsis as part of session close
  // (the onClose hook below). Defaults off — explicit user paths
  // (picker T, `/hydra title`, scheduleSynopsis()) always run regardless.
  synopsisOnClose?: boolean;
  // Cap on entries kept in each session's on-disk history.jsonl. Forwarded
  // to both the shared HistoryStore (read-side trim) and every Session
  // (write-side compact + derived 20%-of-cap compact trigger).
  sessionHistoryMaxEntries?: number;
  // Default transformer names applied to every new session when the client
  // doesn't supply _meta["hydra-acp"].transformers.
  defaultTransformers?: string[];
  // How long after the last recordable broadcast before session.idle fires
  // to the transformer chain. 0 disables. Defaults to 30 seconds.
  idleEventTimeoutMs?: number;
  // Pino-style logger forwarded to each Session so idle-close + explicit
  // close paths leave a trail in daemon.log (the close path used to be
  // completely silent, making it hard to tell agent-killed-by-us apart
  // from agent-died-on-its-own).
  logger?: AgentLogger;
  // npm registry URL forwarded to planSpawn for npm-distributed agents.
  // Overrides the user's global .npmrc so installs hit the intended registry.
  npmRegistry?: string;
  // Process-name → registered command list. Daemon shares a single
  // registry across all sessions so an extension only has to register
  // once at connect time and every live session can dispatch to it.
  extensionCommands?: ExtensionCommandRegistry;
  // Fallback cwd used when a resurrected session's recorded cwd no longer
  // exists on disk (e.g. a `cat` session whose /tmp sandbox was cleaned
  // up, or a bundle imported from another machine). May be "~"/"$HOME";
  // expanded at use time. Defaults to "~".
  defaultCwd?: string;
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private resurrectionInflight = new Map<string, Promise<Session>>();
  private spawner: AgentSpawner;
  private store: SessionStore;
  private histories: HistoryStore;
  private idleTimeoutMs: number;
  private defaultModels: Record<string, string>;
  private synopsisAgent?: string;
  private synopsisModel?: string;
  private synopsisOnClose: boolean;
  readonly defaultTransformers: string[];
  private idleEventTimeoutMs: number;
  private sessionHistoryMaxEntries: number;
  // Serialize meta.json read-modify-write operations per session id so
  // concurrent snapshot updates (e.g. an agent emitting model + mode
  // back-to-back) don't lose writes via interleaved reads.
  private metaWriteQueues = new Map<string, Promise<unknown>>();
  private logger?: AgentLogger;
  private npmRegistry?: string;
  private extensionCommands?: ExtensionCommandRegistry;
  private defaultCwd: string;
  // Background queue for ephemeral-agent synopsis generation. Runs
  // out-of-band so session close is instant; persists synopsis/title
  // via the same enqueueMetaWrite path the in-session handlers used.
  private synopsisCoordinator: SynopsisCoordinator;

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
    this.idleEventTimeoutMs = options.idleEventTimeoutMs ?? 30_000;
    this.defaultModels = options.defaultModels ?? {};
    this.synopsisAgent = options.synopsisAgent;
    this.synopsisModel = options.synopsisModel;
    this.synopsisOnClose = options.synopsisOnClose ?? false;
    this.defaultTransformers = options.defaultTransformers ?? [];
    this.logger = options.logger;
    this.npmRegistry = options.npmRegistry;
    this.extensionCommands = options.extensionCommands;
    this.defaultCwd = options.defaultCwd ?? "~";
    this.synopsisCoordinator = new SynopsisCoordinator({
      registry: this.registry,
      store: this.store,
      histories: this.histories,
      synopsisAgent: this.synopsisAgent,
      synopsisModel: this.synopsisModel,
      persistTitle: async (id, title) => {
        // Route through the live session when one exists (e.g. bare
        // `/hydra title` on an attached session). retitle() broadcasts
        // session_info_update to attached clients AND updates the
        // in-memory title so list() (and thus the picker poll) reflects
        // it; its onTitleChange hook persists to disk. When the session
        // is cold (synopsis-on-close), there's nothing in memory to
        // broadcast to, so write meta.json directly.
        const live = this.get(id);
        if (live) {
          await live.retitle(title);
          return;
        }
        await this.persistTitle(id, title);
      },
      persistSynopsis: (id, synopsis, through) =>
        this.persistSynopsis(id, synopsis, through),
      logger: this.logger,
      npmRegistry: this.npmRegistry,
    });
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

    // Run the agent:initialize chain intercept. Transformers that declared
    // this intercept can inspect and replace agentCapabilities before the
    // Session is constructed. Actual tool injection is deferred pending Q1
    // (MCP vs. direct); this just plumbs the intercept point.
    if (params.transformChain && params.transformChain.length > 0) {
      let caps: Record<string, unknown> = { ...(fresh.agentCapabilities ?? {}) };
      for (const t of params.transformChain) {
        if (!t.intercepts.has("agent:initialize")) {
          continue;
        }
        try {
          const result = await t.connection.request("transformer/message", {
            token: `t_${generateRawSessionId()}`,
            phase: "response",
            method: "initialize",
            direction: "agent→daemon",
            sessionId: "(pre-session)",
            envelope: caps,
          }) as { action: string; payload?: unknown };
          if (result.action === "stop" && result.payload) {
            caps = result.payload as Record<string, unknown>;
          }
        } catch {
          // Fail-open: transformer error during initialize doesn't block session creation.
        }
      }
      fresh.agentCapabilities = caps as AgentCapabilities;
    }
    const session = new Session({
      cwd: params.cwd,
      agentId: params.agentId,
      agent: fresh.agent,
      upstreamSessionId: fresh.upstreamSessionId,
      agentMeta: fresh.agentMeta,
      agentCapabilities: fresh.agentCapabilities,
      title: params.title,
      agentArgs: params.agentArgs,
      idleTimeoutMs: this.idleTimeoutMs,
      idleEventTimeoutMs: this.idleEventTimeoutMs,
      logger: this.logger,
      spawnReplacementAgent: (p) =>
        this.bootstrapAgent({ ...p, mcpServers: [] }),
      listSessions: () => this.list(),
      historyStore: this.histories,
      historyMaxEntries: this.sessionHistoryMaxEntries,
      currentModel: fresh.initialModel,
      currentMode: fresh.initialMode,
      agentModes: fresh.initialModes,
      agentModels: fresh.initialModels,
      transformChain: params.transformChain,
      parentSessionId: params.parentSessionId,
      originatingClient: params.originatingClient,
      interactive: params.interactive,
      extensionCommands: this.extensionCommands,
      scheduleSynopsis: () => this.synopsisCoordinator.schedule(session.sessionId),
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

    // The agent's own session is pinned to the recorded cwd: claude-acp /
    // Claude Code resume fails with `Path "…" does not exist` once that
    // dir is gone (e.g. a `cat` session whose /tmp sandbox was cleaned
    // up), and the cwd passed to session/load can't redirect it. So if the
    // dir is missing, reseed a fresh agent session in the fallback cwd and
    // replay history instead of resuming. The TUI repair path drives this
    // explicitly via a resume hint with an empty upstreamSessionId; this
    // covers every other entry point (session/prompt auto-resurrect,
    // `session attach <id>`, the shim).
    if (!(await this.dirExists(params.cwd))) {
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

    let agentCapabilities: AgentCapabilities | undefined;
    try {
      const initResult = await agent.connection.request<Record<string, unknown>>(
        "initialize",
        {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: {},
          clientInfo: { name: "hydra", version: HYDRA_VERSION },
        },
      );
      agentCapabilities = initResult.agentCapabilities as
        | AgentCapabilities
        | undefined;
    } catch (err) {
      await agent.kill().catch(() => undefined);
      throw err;
    }

    let loadResult: Record<string, unknown> | undefined;
    try {
      const loadMeta = buildSessionLoadMeta(params.agentId, params.currentModel);
      loadResult = await agent.connection.request<Record<string, unknown>>(
        "session/load",
        {
          sessionId: params.upstreamSessionId,
          cwd: params.cwd,
          mcpServers: [],
          ...(loadMeta && { _meta: loadMeta }),
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
    // session/update notifications. Normally we already have that
    // history in history.jsonl and would double-log every resurrect by
    // flushing the replay through wireAgent's session/update handler,
    // so we drop the buffer. The exception is a row minted by
    // `hydra agent sync`, which has no local history yet — there we
    // *want* the replay to land in history.jsonl, and clear the
    // pendingHistorySync flag once we've done so.
    if (params.pendingHistorySync === true) {
      void this.clearPendingHistorySync(params.hydraSessionId).catch(
        () => undefined,
      );
    } else {
      const drain1Count = agent.connection.drainBuffered("session/update");
      this.logger?.info(
        `resurrect: drain1 dropped ${drain1Count} buffered session/update(s) for sessionId=${params.hydraSessionId}`,
      );
    }

    // Push the persisted mode back to the freshly loaded agent so a
    // session that was in plan mode (or any non-default mode) doesn't
    // silently revert on restart. The agent boots in its own default
    // after session/load and would otherwise overwrite our snapshot
    // via a later current_mode_update.
    const agentReportedMode = extractInitialCurrentMode(loadResult ?? {});
    const advertisedModes =
      params.agentModes ??
      nonEmptyOrUndefined(extractInitialModes(loadResult ?? {}));
    this.logger?.info(
      `resurrect: sessionId=${params.hydraSessionId} persistedMode=${JSON.stringify(params.currentMode)} agentReportedMode=${JSON.stringify(agentReportedMode)} advertisedModes=${JSON.stringify(advertisedModes?.map((m) => m.id))}`,
    );
    const effectiveMode = await restoreCurrentMode({
      agent,
      upstreamSessionId: params.upstreamSessionId,
      persistedMode: params.currentMode,
      agentReportedMode,
      advertisedModes,
      logger: this.logger,
    });
    this.logger?.info(
      `resurrect: effectiveMode=${JSON.stringify(effectiveMode)} for sessionId=${params.hydraSessionId}`,
    );

    const agentReportedModel = extractInitialModel(loadResult ?? {});
    const advertisedModels =
      nonEmptyOrUndefined(extractInitialModels(loadResult ?? {})) ??
      params.agentModels;
    this.logger?.info(
      `resurrect: sessionId=${params.hydraSessionId} persistedModel=${JSON.stringify(params.currentModel)} agentReportedModel=${JSON.stringify(agentReportedModel)} advertisedModels=${JSON.stringify(advertisedModels?.map((m) => m.modelId))}`,
    );

    // The set_mode call above may have prompted the agent to emit fresh
    // session/update notifications. Drop them before wireAgent so they
    // don't overwrite the mode we just set.
    if (params.pendingHistorySync !== true) {
      const drain2Count = agent.connection.drainBuffered("session/update");
      this.logger?.info(
        `resurrect: drain2 (post-mode-restore) dropped ${drain2Count} buffered session/update(s) for sessionId=${params.hydraSessionId}`,
      );
    }

    // If the agent didn't come back on the right model (codex-acp has no
    // _meta extension, opencode and claude-acp with _meta both agree),
    // push the persisted model back via set_model. Falls back to whatever
    // the agent reported if the call fails.
    const effectiveModel = await restoreCurrentModel({
      agent,
      upstreamSessionId: params.upstreamSessionId,
      persistedModel: params.currentModel,
      agentReportedModel,
      logger: this.logger,
    });
    if (params.pendingHistorySync !== true) {
      const drain3Count = agent.connection.drainBuffered("session/update");
      this.logger?.info(
        `resurrect: drain3 (post-model-restore) dropped ${drain3Count} buffered session/update(s) for sessionId=${params.hydraSessionId}`,
      );
    }

    const session = new Session({
      sessionId: params.hydraSessionId,
      cwd: params.cwd,
      agentId: params.agentId,
      agent,
      upstreamSessionId: params.upstreamSessionId,
      agentMeta: loadResult?._meta as Record<string, unknown> | undefined,
      agentCapabilities,
      title: params.title,
      agentArgs: params.agentArgs,
      idleTimeoutMs: this.idleTimeoutMs,
      logger: this.logger,
      spawnReplacementAgent: (p) =>
        this.bootstrapAgent({ ...p, mcpServers: [] }),
      listSessions: () => this.list(),
      historyStore: this.histories,
      historyMaxEntries: this.sessionHistoryMaxEntries,
      currentModel: effectiveModel,
      currentMode: effectiveMode,
      currentUsage: params.currentUsage,
      agentCommands: params.agentCommands,
      agentModes: advertisedModes,
      // Always prefer the fresh list from session/load over the persisted
      // snapshot — the proxy's available models can change between daemon
      // restarts (quota resets, rollouts), so meta.json is intentionally
      // treated as a cold fallback here, not the authoritative source.
      agentModels: advertisedModels,
      // Only gate the first-prompt title heuristic when we actually have
      // a title to preserve. A title-less session (lost to a write race
      // or never seeded) should re-derive from the next prompt rather
      // than stay stuck.
      firstPromptSeeded: !!params.title,
      createdAt: params.createdAt
        ? new Date(params.createdAt).getTime()
        : undefined,
      originatingClient: params.originatingClient,
      interactive: params.interactive,
      forkedFromSessionId: params.forkedFromSessionId,
      forkedFromMessageId: params.forkedFromMessageId,
      extensionCommands: this.extensionCommands,
      scheduleSynopsis: () => this.synopsisCoordinator.schedule(session.sessionId),
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
    // back to defaultCwd so the spawn doesn't fail with ENOENT; the merge-
    // write in attachManagerHooks persists the resolved cwd.
    const cwd = await this.resolveResurrectCwd(params.cwd);
    const fresh = await this.bootstrapAgent({
      agentId: params.agentId,
      cwd,
      agentArgs: params.agentArgs,
      mcpServers: [],
      onInstallProgress: params.onInstallProgress,
      // Pass the persisted model so bootstrapAgent calls session/set_model
      // during session/new — the only context where the agent reliably
      // honours the switch.
      model: params.currentModel,
    });
    const advertisedModes = params.agentModes ?? fresh.initialModes;
    const effectiveMode = await restoreCurrentMode({
      agent: fresh.agent,
      upstreamSessionId: fresh.upstreamSessionId,
      persistedMode: params.currentMode,
      agentReportedMode: fresh.initialMode,
      advertisedModes,
      logger: this.logger,
    });
    const advertisedModels = params.agentModels ?? fresh.initialModels;
    const effectiveModel = await restoreCurrentModel({
      agent: fresh.agent,
      upstreamSessionId: fresh.upstreamSessionId,
      persistedModel: params.currentModel,
      agentReportedModel: fresh.initialModel,
      logger: this.logger,
    });
    // Drop any buffered session/update notifications that arrived during
    // the restore calls — same race as doResurrect.
    fresh.agent.connection.drainBuffered("session/update");
    const session = new Session({
      sessionId: params.hydraSessionId,
      cwd,
      agentId: params.agentId,
      agent: fresh.agent,
      upstreamSessionId: fresh.upstreamSessionId,
      agentMeta: fresh.agentMeta,
      agentCapabilities: fresh.agentCapabilities,
      title: params.title,
      agentArgs: params.agentArgs,
      idleTimeoutMs: this.idleTimeoutMs,
      logger: this.logger,
      spawnReplacementAgent: (p) =>
        this.bootstrapAgent({ ...p, mcpServers: [] }),
      listSessions: () => this.list(),
      historyStore: this.histories,
      historyMaxEntries: this.sessionHistoryMaxEntries,
      currentModel: effectiveModel,
      currentMode: effectiveMode,
      currentUsage: params.currentUsage,
      agentCommands: params.agentCommands,
      agentModes: advertisedModes,
      agentModels: advertisedModels,
      firstPromptSeeded: !!params.title,
      createdAt: params.createdAt
        ? new Date(params.createdAt).getTime()
        : undefined,
      originatingClient: params.originatingClient,
      interactive: params.interactive,
      forkedFromSessionId: params.forkedFromSessionId,
      forkedFromMessageId: params.forkedFromMessageId,
      extensionCommands: this.extensionCommands,
      scheduleSynopsis: () => this.synopsisCoordinator.schedule(session.sessionId),
    });
    await this.attachManagerHooks(session);
    // Fire and forget — the seed runs through enqueuePrompt inside
    // Session, so any user prompt arriving mid-seed queues behind it.
    void session.seedFromImport().catch(() => undefined);
    return session;
  }

  private async dirExists(cwd: string): Promise<boolean> {
    try {
      return (await fs.stat(cwd)).isDirectory();
    } catch {
      return false;
    }
  }

  // When the last client detaches from a session that was never promoted
  // to interactive, close it so its agent process doesn't linger until the
  // (default 1h) idle timeout fires. This covers both `hydra cat` runs
  // (born interactive:undefined with originatingClient hydra-acp-cat, every
  // prompt ancillary) and any other client that opened a session but never
  // sent a real, non-ancillary prompt. Promotion to interactive is
  // synchronous on the first real prompt (Session.prompt sets _interactive
  // = true before enqueuing), so a session that ever saw a genuine turn
  // resolves to true here and is left running. The cold record is kept, so
  // re-attaching resurrects via the reseed path.
  //
  // Note: this only fires from the explicit session/detach handler — raw WS
  // close deliberately does NOT reap (see acp-ws.ts), so an abrupt
  // disconnect of a never-prompted session falls through to the idle
  // timeout rather than being torn down.
  async reapIfOrphanedNonInteractive(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.attachedCount > 0) {
      return;
    }
    // Reap unless the session was explicitly created interactive or got
    // promoted by a real prompt — i.e. interactive === true. undefined
    // (never prompted, including cat) and an explicit false both reap.
    if (session.interactive === true) {
      return;
    }
    this.logger?.info(
      `reaping orphaned non-interactive session ${sessionId} (agent killed, cold record kept)`,
    );
    await session.close({ deleteRecord: false }).catch(() => undefined);
  }

  // Resolve a recorded cwd for resurrect: use it if it still exists,
  // otherwise fall back to the configured defaultCwd. Covers both bundles
  // imported from another machine and local sessions (e.g. `cat`) whose
  // recorded dir was cleaned up, so the reseed spawn never ENOENTs.
  private async resolveResurrectCwd(cwd: string): Promise<string> {
    if (await this.dirExists(cwd)) {
      return cwd;
    }
    return expandHome(this.defaultCwd);
  }

  // Pull every session the agent itself remembers (across all cwds) and
  // persist a cold hydra record for each one we don't already track.
  // Used by `hydra agent sync <id>` to surface sessions created outside
  // hydra — or by other tools — in `hydra session list` so the picker
  // can resurrect them. Spawns a throwaway agent process for the
  // initialize + session/list pair, then kills it. Records are minted
  // with pendingHistorySync:true so the first resurrect records the
  // agent's session/load replay into history.jsonl rather than dropping
  // it.
  async syncFromAgent(
    agentId: string,
  ): Promise<{ synced: SessionRecord[]; skipped: number }> {
    const agentDef = await this.registry.getAgent(agentId);
    if (!agentDef) {
      const err = new Error(
        `agent ${agentId} not found in registry`,
      ) as Error & { code: number };
      err.code = JsonRpcErrorCodes.AgentNotInstalled;
      throw err;
    }
    const plan = await planSpawn(agentDef, [], {
      npmRegistry: this.npmRegistry,
    });
    const agent = this.spawner({
      agentId,
      cwd: os.homedir(),
      plan,
    });

    let initResult: Record<string, unknown>;
    try {
      initResult = await agent.connection.request<Record<string, unknown>>(
        "initialize",
        {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: {},
          clientInfo: { name: "hydra", version: HYDRA_VERSION },
        },
      );
    } catch (err) {
      await agent.kill().catch(() => undefined);
      throw err;
    }

    const caps = (initResult.agentCapabilities ?? {}) as {
      sessionCapabilities?: { list?: unknown };
    };
    if (caps.sessionCapabilities?.list === undefined) {
      await agent.kill().catch(() => undefined);
      throw new Error(
        `agent ${agentId} does not advertise sessionCapabilities.list; cannot sync`,
      );
    }

    let entries: Array<{
      sessionId: string;
      cwd: string;
      title?: string;
      updatedAt?: string;
    }>;
    try {
      entries = await this.collectAgentSessions(agent);
    } catch (err) {
      await agent.kill().catch(() => undefined);
      throw err;
    }
    await agent.kill().catch(() => undefined);

    const existing = new Set<string>();
    for (const live of this.sessions.values()) {
      existing.add(`${live.agentId}::${live.upstreamSessionId}`);
    }
    const stored = await this.store.list().catch(() => []);
    for (const rec of stored) {
      existing.add(`${rec.agentId}::${rec.upstreamSessionId}`);
    }

    // Sessions whose cwd is under hydra's synopsis sandbox are internal
    // ephemeral runs — the synopsis coordinator spawns its agent with
    // cwd=~/.hydra-acp/sessions/<id>/, which makes the agent persist that
    // ephemeral session in its own per-project storage.
    // sessionCapabilities.list then surfaces those back to syncFromAgent,
    // and without this guard we'd import them as real hydra sessions
    // (replaying the synopsis prompt as user input on first resurrect).
    // Scope the filter to exactly that sandbox dir — not the whole
    // ~/.hydra-acp/ tree — so legitimate sessions that merely happen to
    // sit under the data dir (e.g. an agent launched from its own install
    // path) still sync.
    const synopsisSandboxDir = paths.sessionsDir();
    const synced: SessionRecord[] = [];
    let skipped = 0;
    for (const entry of entries) {
      const dedupeKey = `${agentId}::${entry.sessionId}`;
      if (existing.has(dedupeKey)) {
        skipped += 1;
        continue;
      }
      if (isSynopsisSession(entry.cwd, synopsisSandboxDir)) {
        skipped += 1;
        continue;
      }
      existing.add(dedupeKey);
      const newId = `${HYDRA_SESSION_PREFIX}${generateRawSessionId()}`;
      const now = new Date().toISOString();
      const ts = entry.updatedAt ?? now;
      const recordArgs: Parameters<typeof recordFromMemorySession>[0] = {
        sessionId: newId,
        lineageId: generateLineageId(),
        upstreamSessionId: entry.sessionId,
        agentId,
        cwd: entry.cwd,
        pendingHistorySync: true,
        // `hydra agent sync` is a user-explicit "show me agent-side
        // sessions" action; the rows are meant to be visible immediately
        // even before the first resurrect populates history.jsonl.
        interactive: true,
        createdAt: ts,
        updatedAt: ts,
      };
      if (entry.title !== undefined) {
        recordArgs.title = entry.title;
      }
      const record = recordFromMemorySession(recordArgs);
      await this.store.write(record);
      synced.push({ version: 1, ...record });
    }
    return { synced, skipped };
  }

  // Paginate the agent's session/list, threading nextCursor until the
  // agent stops returning one. Each entry the spec guarantees has
  // { sessionId, cwd }; title and updatedAt are optional.
  private async collectAgentSessions(agent: AgentInstance): Promise<
    Array<{ sessionId: string; cwd: string; title?: string; updatedAt?: string }>
  > {
    const out: Array<{
      sessionId: string;
      cwd: string;
      title?: string;
      updatedAt?: string;
    }> = [];
    let cursor: string | undefined;
    // Bound the loop to defend against an agent that hands back the same
    // cursor forever; 100 pages × any reasonable page size is well past
    // anything sane.
    for (let page = 0; page < 100; page += 1) {
      const params: Record<string, unknown> = {};
      if (cursor !== undefined) {
        params.cursor = cursor;
      }
      const result = await agent.connection.request<{
        sessions?: Array<{
          sessionId?: unknown;
          cwd?: unknown;
          title?: unknown;
          updatedAt?: unknown;
        }>;
        nextCursor?: unknown;
      }>("session/list", params);
      const rows = Array.isArray(result.sessions) ? result.sessions : [];
      for (const row of rows) {
        if (typeof row.sessionId !== "string" || typeof row.cwd !== "string") {
          continue;
        }
        const entry: {
          sessionId: string;
          cwd: string;
          title?: string;
          updatedAt?: string;
        } = { sessionId: row.sessionId, cwd: row.cwd };
        if (typeof row.title === "string") {
          entry.title = row.title;
        }
        if (typeof row.updatedAt === "string") {
          entry.updatedAt = row.updatedAt;
        }
        out.push(entry);
      }
      if (typeof result.nextCursor !== "string" || result.nextCursor.length === 0) {
        break;
      }
      cursor = result.nextCursor;
    }
    return out;
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
    agentCapabilities?: AgentCapabilities;
    initialModel?: string;
    initialModels?: AdvertisedModel[];
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
      const initResult = await agent.connection.request<Record<string, unknown>>(
        "initialize",
        {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: {},
          clientInfo: { name: "hydra", version: HYDRA_VERSION },
        },
      );
      const agentCapabilities = initResult.agentCapabilities as
        | AgentCapabilities
        | undefined;
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
      const initialModels = extractInitialModels(newResult);
      const desired = params.model ?? this.defaultModels[params.agentId];
      if (desired && desired !== initialModel) {
        // Validate against the agent's advertised model list when we
        // have one. Surfaces config typos (e.g. defaultModels[opencode]
        // set to a claude-acp-shaped id) before they corrupt the
        // session — opencode in particular silently splits an unknown
        // modelId on `/` and stores garbage, which then makes every
        // subsequent prompt return end_turn instantly. When the agent
        // didn't advertise a list yet, we fall back to optimistic
        // forwarding (the previous behavior) so we don't block a
        // legitimate id we just can't see.
        const validates =
          initialModels.length === 0 ||
          initialModels.some((m) => m.modelId === desired);
        if (validates) {
          try {
            await agent.connection.request("session/set_model", {
              sessionId: sessionIdRaw,
              modelId: desired,
            });
            initialModel = desired;
          } catch (err) {
            // Bad / unsupported model id in config shouldn't break session
            // creation — fall back to whatever the agent picked itself.
            this.logger?.warn(
              `defaultModels[${params.agentId}]=${JSON.stringify(desired)} rejected by agent (${(err as Error).message}); session will use ${JSON.stringify(initialModel)}`,
            );
          }
        } else {
          const known = initialModels.map((m) => m.modelId).join(", ");
          this.logger?.warn(
            `defaultModels[${params.agentId}]=${JSON.stringify(desired)} not in agent's availableModels ([${known}]); skipping session/set_model, session will use ${JSON.stringify(initialModel)}`,
          );
        }
      }
      const initialModes = extractInitialModes(newResult);
      const initialMode = extractInitialCurrentMode(newResult);
      return {
        agent,
        upstreamSessionId: sessionIdRaw,
        agentMeta: newResult._meta as Record<string, unknown> | undefined,
        agentCapabilities,
        initialModel,
        initialModels: initialModels.length > 0 ? initialModels : undefined,
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
        return;
      }
      // Out-of-band synopsis generation. By the time the coordinator
      // picks this up, agent is dead and Session is destroyed; the
      // coordinator reads the cold record + history.jsonl, spawns a
      // fresh ephemeral agent, and writes synopsis directly via
      // persistSynopsis. firstPromptSeeded is the gate — a session
      // that never received a prompt has nothing to summarize. The
      // synopsisOnClose flag is the other gate — defaults off so the
      // ephemeral-agent fork cost doesn't pile up under idle sweeps.
      // Explicit paths (picker T, `/hydra title`, scheduleSynopsis())
      // bypass this flag and always run.
      if (session.firstPromptSeeded && this.synopsisOnClose) {
        this.synopsisCoordinator.schedule(session.sessionId);
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
    session.onInteractiveChange((interactive) => {
      void this.persistSnapshot(session.sessionId, { interactive }).catch(
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
    session.onAgentModelsChange((models) => {
      void this.persistSnapshot(session.sessionId, {
        agentModels: models.map((m) => ({
          modelId: m.modelId,
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

  // Read the on-disk history.jsonl for a session without constructing a
  // Session instance. Used by the daemon's read-only viewer attach path
  // (cli/src/daemon/acp-ws.ts) to stream replay events to a client for
  // a cold session without spawning an agent.
  async loadHistory(sessionId: string): Promise<HistoryStoreEntry[]> {
    return this.histories.load(sessionId);
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
      synopsis: record.synopsis,
      summarizedThroughEntry: record.summarizedThroughEntry,
      agentArgs: record.agentArgs,
      currentModel: record.currentModel,
      currentMode: record.currentMode,
      currentUsage: persistedUsageToSnapshot(
        record.currentUsage
          ? {
              ...record.currentUsage,
              cumulativeCost:
                (record.currentUsage.cumulativeCost ?? 0) +
                (record.currentUsage.costAmount ?? 0),
              costAmount: undefined,
            }
          : undefined,
      ),
      agentCommands: record.agentCommands,
      agentModes: record.agentModes,
      agentModels: record.agentModels,
      createdAt: record.createdAt,
      pendingHistorySync: record.pendingHistorySync,
      originatingClient: record.originatingClient,
      interactive: record.interactive,
      forkedFromSessionId: record.forkedFromSessionId,
      forkedFromMessageId: record.forkedFromMessageId,
    };
  }

  private async clearPendingHistorySync(sessionId: string): Promise<void> {
    await this.enqueueMetaWrite(sessionId, async () => {
      const record = await this.store.read(sessionId);
      if (!record || record.pendingHistorySync !== true) {
        return;
      }
      const next: SessionRecord = { ...record };
      delete next.pendingHistorySync;
      await this.store.write(next);
    });
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

  liveSessions(): IterableIterator<Session> {
    return this.sessions.values();
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

  // Synchronous SessionListEntry for a resident session. Mirrors the
  // live-session branch of list() but skips the async history probe:
  // callers on the attach/new hot path already hold the Session and
  // don't need the history-derived `interactive` inference (they pass
  // through the session's own tristate) or the history mtime (the
  // session's updatedAt is current). Used to build the reconciled
  // session/new + session/attach response `_meta["hydra-acp"]` from the
  // same shape session/list emits.
  liveListEntry(session: Session): SessionListEntry {
    return {
      sessionId: session.sessionId,
      upstreamSessionId: session.upstreamSessionId,
      cwd: session.cwd,
      title: session.title,
      agentId: session.agentId,
      currentModel: session.currentModel,
      currentUsage: session.currentUsage,
      parentSessionId: session.parentSessionId,
      forkedFromSessionId: session.forkedFromSessionId,
      forkedFromMessageId: session.forkedFromMessageId,
      originatingClient: session.originatingClient,
      interactive: session.interactive,
      updatedAt: new Date(session.updatedAt).toISOString(),
      attachedClients: session.attachedCount,
      status: "live",
      busy: session.turnStartedAt !== undefined,
      awaitingInput: session.awaitingInput,
    };
  }

  async list(
    filter: { cwd?: string; includeNonInteractive?: boolean } = {},
  ): Promise<SessionListEntry[]> {
    const entries: SessionListEntry[] = [];
    const liveIds = new Set<string>();
    // Filter rule (when includeNonInteractive is false, the default):
    // only effective === true is visible. False (cat one-shots) and
    // undefined (fresh editor panels that never typed) are both hidden.
    // The "user just created a session and is about to type" objection
    // doesn't apply — that user is inside their own TUI for that
    // session, not staring at the picker.
    const includeRow = (interactive: boolean | undefined): boolean => {
      if (filter.includeNonInteractive) return true;
      return interactive === true;
    };
    for (const session of this.sessions.values()) {
      if (filter.cwd && session.cwd !== filter.cwd) {
        continue;
      }
      liveIds.add(session.sessionId);
      const hist = await historyStatus(session.sessionId);
      const interactive = effectiveInteractive(
        {
          interactive: session.interactive,
          ...(session.originatingClient
            ? { originatingClient: session.originatingClient }
            : {}),
        },
        hist.hasContent,
      );
      if (!includeRow(interactive)) {
        continue;
      }
      const used = hist.mtime ?? new Date(session.updatedAt).toISOString();
      entries.push({
        sessionId: session.sessionId,
        upstreamSessionId: session.upstreamSessionId,
        cwd: session.cwd,
        title: session.title,
        agentId: session.agentId,
        currentModel: session.currentModel,
        currentUsage: session.currentUsage,
        parentSessionId: session.parentSessionId,
        forkedFromSessionId: session.forkedFromSessionId,
        forkedFromMessageId: session.forkedFromMessageId,
        originatingClient: session.originatingClient,
        interactive,
        updatedAt: used,
        attachedClients: session.attachedCount,
        status: "live",
        busy: session.turnStartedAt !== undefined,
        awaitingInput: session.awaitingInput,
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
      const hist = await historyStatus(r.sessionId);
      const interactive = effectiveInteractive(r, hist.hasContent);
      if (!includeRow(interactive)) {
        continue;
      }
      const used = hist.mtime ?? r.updatedAt;
      entries.push({
        sessionId: r.sessionId,
        upstreamSessionId: r.upstreamSessionId,
        cwd: r.cwd,
        title: r.title,
        agentId: r.agentId,
        currentModel: r.currentModel,
        currentUsage: r.currentUsage
          ? {
              ...r.currentUsage,
              costAmount:
                (r.currentUsage.cumulativeCost ?? 0) +
                (r.currentUsage.costAmount ?? 0) || undefined,
            }
          : undefined,
        importedFromMachine: r.importedFromMachine,
        importedFromUpstreamSessionId: r.importedFromUpstreamSessionId,
        parentSessionId: r.parentSessionId,
        forkedFromSessionId: r.forkedFromSessionId,
        forkedFromMessageId: r.forkedFromMessageId,
        originatingClient: r.originatingClient,
        interactive,
        updatedAt: used,
        attachedClients: 0,
        status: "cold",
        busy: false,
        awaitingInput: false,
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

  // Branch an existing local session into a new one that shares context
  // up to the chosen turn boundary and diverges from there. Composes the
  // import pipeline: synthesizes a Bundle from the source's record and
  // sliced history, mints a fresh lineageId, then writes the new record
  // via writeImportedRecord with forked* breadcrumbs instead of
  // imported*. The fork carries upstreamSessionId="" so the first attach
  // triggers seedFromImport — same wire shape as an imported session.
  //
  // forkAt defaults to the messageId of the source's most recent
  // turn_complete; explicit forkAt must reference a session/update
  // entry that's present in the source's history.jsonl. Cutting at a
  // completed turn excludes any in-flight prompt by construction
  // (history.jsonl is appended serially per session), so no locking
  // against the live source is needed.
  //
  // agentId defaults to the source's agent. Overriding to a different
  // agent scrubs agent-specific state from the fork (model, mode,
  // usage, agent-emitted commands/modes/models) so the new agent boots
  // clean — title and conversation transcript are agent-agnostic and
  // are kept.
  async forkSession(
    sourceSessionId: string,
    opts: { forkAt?: string; cwd?: string; agentId?: string } = {},
  ): Promise<{
    sessionId: string;
    forkedFromSessionId: string;
    forkedAt: string;
  }> {
    const sourceRecord = await this.store.read(sourceSessionId);
    if (!sourceRecord) {
      const err = new Error(`source session not found: ${sourceSessionId}`) as Error & {
        code: number;
      };
      err.code = JsonRpcErrorCodes.SessionNotFound;
      throw err;
    }

    const targetAgentId = opts.agentId ?? sourceRecord.agentId;
    const crossAgent = targetAgentId !== sourceRecord.agentId;
    if (crossAgent) {
      const def = await this.registry.getAgent(targetAgentId);
      if (!def) {
        const err = new Error(
          `agent ${targetAgentId} not found in registry`,
        ) as Error & { code: number };
        err.code = JsonRpcErrorCodes.AgentNotInstalled;
        throw err;
      }
    }

    const sourceHistory = await this.histories.load(sourceSessionId).catch(() => []);

    let cutoffIndex: number;
    let forkedAt: string;
    if (opts.forkAt !== undefined) {
      cutoffIndex = findMessageIdIndex(sourceHistory, opts.forkAt);
      if (cutoffIndex < 0) {
        const err = new Error(
          `forkAt messageId not found in source history: ${opts.forkAt}`,
        ) as Error & { code: number };
        err.code = JsonRpcErrorCodes.InvalidParams;
        throw err;
      }
      forkedAt = opts.forkAt;
    } else {
      const found = findLastTurnComplete(sourceHistory);
      if (!found) {
        const err = new Error(
          `source session ${sourceSessionId} has no completed turns to fork from`,
        ) as Error & { code: number };
        err.code = JsonRpcErrorCodes.InvalidParams;
        throw err;
      }
      cutoffIndex = found.index;
      forkedAt = found.messageId;
    }

    const slicedHistory = sourceHistory.slice(0, cutoffIndex + 1);
    const promptHistory = await loadPromptHistorySafely(sourceSessionId);

    // Build a record snapshot for encodeBundle. Fresh lineageId so the
    // fork is a new conversation lineage (sharing source's lineageId
    // would deadlock importBundle's dedup against the source itself).
    // For cross-agent forks, omit agent-specific state so the new agent
    // boots clean — title and history survive.
    const recordForBundle: SessionRecord & { lineageId: string } = {
      ...sourceRecord,
      lineageId: generateLineageId(),
      agentId: targetAgentId,
      ...(crossAgent
        ? {
            currentModel: undefined,
            currentMode: undefined,
            currentUsage: undefined,
            agentCommands: undefined,
            agentModes: undefined,
            agentModels: undefined,
          }
        : {}),
    };

    const bundle = encodeBundle({
      record: recordForBundle,
      history: slicedHistory,
      promptHistory: promptHistory.length > 0 ? promptHistory : undefined,
      hydraVersion: HYDRA_VERSION,
      machine: os.hostname(),
    });

    const newId = `${HYDRA_SESSION_PREFIX}${generateRawSessionId()}`;
    await this.writeImportedRecord({
      sessionId: newId,
      bundle,
      cwd: opts.cwd,
      forkedFromSessionId: sourceSessionId,
      forkedFromMessageId: forkedAt,
    });
    return {
      sessionId: newId,
      forkedFromSessionId: sourceSessionId,
      forkedAt,
    };
  }

  // Write the imported (or forked) bundle's history.jsonl, prompt-history
  // (if present), and meta.json. upstreamSessionId is left empty as the
  // marker that the first attach should bootstrap a fresh agent and
  // run seedFromImport rather than calling session/load. When
  // forkedFromSessionId is set, the record is marked as a local fork
  // (forked* fields populated) instead of a cross-machine import
  // (imported* fields populated) — both share the seed-on-first-attach
  // wire shape but trace differently in list views.
  private async writeImportedRecord(args: {
    sessionId: string;
    bundle: Bundle;
    preservedCreatedAt?: string;
    // Override the bundle's recorded cwd. Used when importing a
    // session from another machine where the original cwd doesn't
    // exist locally — the caller (CLI / HTTP route) validates the
    // override before passing it in.
    cwd?: string;
    // Local-fork breadcrumbs. When both are set, the record is written
    // with forked* fields populated; the imported* family is left
    // unset so meta.json doesn't lie about the origin.
    forkedFromSessionId?: string;
    forkedFromMessageId?: string;
  }): Promise<void> {
    // zod's z.unknown() makes params optional in the inferred type, but
    // HistoryStore writes whatever JSON shape it was handed; the on-disk
    // round-trip is identical so the cast is safe.
    await this.histories.rewrite(
      args.sessionId,
      args.bundle.history as HistoryStoreEntry[],
    );
    // Stamp the freshly-written history file with the source's last-turn
    // mtime so AGE on a passive mirror reflects when the conversation
    // last moved, not when we imported it. Without this, a cold import
    // of many sessions would show every row as "just now" and reorder
    // the session list nonsensically.
    const sourceMtime = new Date(args.bundle.session.updatedAt);
    if (!Number.isNaN(sourceMtime.getTime())) {
      await fs
        .utimes(paths.historyFile(args.sessionId), sourceMtime, sourceMtime)
        .catch(() => undefined);
    }
    if (args.bundle.promptHistory && args.bundle.promptHistory.length > 0) {
      await savePromptHistory(
        paths.tuiHistoryFile(args.sessionId),
        args.bundle.promptHistory,
      ).catch(() => undefined);
    }
    const now = new Date().toISOString();
    const isFork = args.forkedFromSessionId !== undefined;
    await this.enqueueMetaWrite(args.sessionId, async () => {
      await this.store.write({
        sessionId: args.sessionId,
        lineageId: args.bundle.session.lineageId,
        upstreamSessionId: "",
        ...(isFork
          ? {
              forkedFromSessionId: args.forkedFromSessionId,
              forkedFromMessageId: args.forkedFromMessageId,
            }
          : {
              importedFromSessionId: args.bundle.session.sessionId,
              importedFromUpstreamSessionId: args.bundle.session.upstreamSessionId,
              importedFromMachine: args.bundle.exportedFrom.machine,
            }),
        agentId: args.bundle.session.agentId,
        cwd: args.cwd ?? args.bundle.session.cwd,
        title: args.bundle.session.title,
        synopsis: args.bundle.session.synopsis,
        summarizedThroughEntry: args.bundle.session.summarizedThroughEntry,
        currentModel: args.bundle.session.currentModel,
        currentMode: args.bundle.session.currentMode,
        currentUsage: args.bundle.session.currentUsage,
        agentCommands: args.bundle.session.agentCommands,
        agentModes: args.bundle.session.agentModes,
        // Carry the source's raw interactive tristate and originating
        // client rather than forcing true. A real conversation arrives
        // as true (visible immediately); an empty source arrives as
        // undefined (hidden until a turn lands here); a cat source
        // arrives as undefined + cat originatingClient, so
        // effectiveInteractive hides it via the hint while leaving it
        // promotable. Legacy bundles (pre-flag) carry neither and fall
        // back to effectiveInteractive's history-presence inference.
        interactive: args.bundle.session.interactive,
        originatingClient: args.bundle.session.originatingClient,
        createdAt: args.preservedCreatedAt ?? now,
        // Fallback path for historyStatus (used when the history file
        // is missing). Keep this consistent with the utimes stamp above.
        updatedAt: args.bundle.session.updatedAt,
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

  // Persist a synopsis update from Session.setSynopsis. The synopsis and
  // its summarizedThroughEntry offset write together so an interrupted
  // daemon never persists a synopsis without the offset that bounds when
  // it should next be regenerated.
  private async persistSynopsis(
    sessionId: string,
    synopsis: SessionSynopsis,
    summarizedThroughEntry: number,
  ): Promise<void> {
    await this.enqueueMetaWrite(sessionId, async () => {
      const record = await this.store.read(sessionId);
      if (!record) {
        return;
      }
      await this.store.write({
        ...record,
        synopsis,
        summarizedThroughEntry,
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
      agentModels?: PersistedAgentModel[];
      interactive?: boolean;
      cwd?: string;
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
        ...(update.agentModels !== undefined
          ? { agentModels: update.agentModels }
          : {}),
        ...(update.interactive !== undefined
          ? { interactive: update.interactive }
          : {}),
        ...(update.cwd !== undefined ? { cwd: update.cwd } : {}),
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
    // Agents die immediately. Synopsis regen runs out-of-band via the
    // synopsis coordinator (scheduled by the onClose hook). Daemon
    // shutdown then awaits the coordinator separately via
    // flushSynopsis, so the cold records still pick up their final
    // synopsis but it doesn't block per-session kill.
    await Promise.allSettled(
      sessions.map((s) => s.close({ deleteRecord: false })),
    );
    this.sessions.clear();
  }

  // Daemon shutdown calls this after closeAll to let in-flight background
  // synopsis jobs settle (and queued ones drain) before flushMetaWrites
  // runs. Bounded by timeoutMs so a hung ephemeral agent doesn't stall
  // exit.
  async flushSynopsis(timeoutMs: number): Promise<void> {
    await this.synopsisCoordinator.flush(timeoutMs);
  }

  // Stop accepting new synopsis jobs and await any still in flight. Used
  // by server shutdown after flushSynopsis so the process exit doesn't
  // race the ephemeral agents.
  async shutdownSynopsis(): Promise<void> {
    await this.synopsisCoordinator.shutdown();
  }

  // Public entry point for picker T and /hydra title with no arg —
  // schedule a synopsis on the named session (live or cold).
  scheduleSynopsis(sessionId: string): void {
    this.synopsisCoordinator.schedule(sessionId);
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

  // Wait for every pending history.jsonl write to settle. markClosed
  // broadcasts turn_complete(interrupted) for the in-flight turn via a
  // fire-and-forget store.append; without flushing, a SIGTERM can exit
  // before that append hits disk, leaving an unmatched prompt_received
  // in history that leaks pendingTurns on every client that replays it.
  async flushHistoryWrites(): Promise<void> {
    await this.histories.flushAll();
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

// True when `cwd` lives under hydra's own data dir. Used by
// syncFromAgent to skip importing ephemeral synopsis sessions (the
// synopsis coordinator spawns agents with cwd=~/.hydra-acp/sessions/<id>/).
// True when `cwd` sits under hydra's synopsis sandbox
// (~/.hydra-acp/sessions/), i.e. the session is one the synopsis
// coordinator spawned internally rather than a real user conversation.
// Agent sync uses this to skip those so they don't pollute the picker.
function isSynopsisSession(cwd: string, sandboxDir: string): boolean {
  if (typeof cwd !== "string" || cwd.length === 0) {
    return false;
  }
  const resolved = path.resolve(cwd);
  const base = path.resolve(sandboxDir);
  return resolved === base || resolved.startsWith(base + path.sep);
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
  const sessionModels = session.availableModels();
  const persistedModels =
    sessionModels.length > 0
      ? sessionModels.map((m): PersistedAgentModel => {
          const out: PersistedAgentModel = { modelId: m.modelId };
          if (m.name !== undefined) {
            out.name = m.name;
          }
          if (m.description !== undefined) {
            out.description = m.description;
          }
          return out;
        })
      : undefined;
  const agentModels = persistedModels ?? existing?.agentModels;
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
    // Preserve synopsis + summarizedThroughEntry from the on-disk
    // record. The live Session no longer carries these (they're owned by
    // the synopsis coordinator now), so without this read-through every
    // attach/persist cycle would clobber the most recent synopsis.
    synopsis: existing?.synopsis,
    summarizedThroughEntry: existing?.summarizedThroughEntry,
    agentArgs: session.agentArgs,
    currentModel: session.currentModel ?? existing?.currentModel,
    currentMode: session.currentMode ?? existing?.currentMode,
    currentUsage:
      usageSnapshotToPersisted(session.currentUsage) ?? existing?.currentUsage,
    agentCommands,
    agentModes,
    agentModels,
    parentSessionId: session.parentSessionId ?? existing?.parentSessionId,
    forkedFromSessionId:
      session.forkedFromSessionId ?? existing?.forkedFromSessionId,
    forkedFromMessageId:
      session.forkedFromMessageId ?? existing?.forkedFromMessageId,
    originatingClient:
      session.originatingClient ?? existing?.originatingClient,
    interactive: session.interactive ?? existing?.interactive,
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
  if (usage.cumulativeCost !== undefined) {
    out.cumulativeCost = usage.cumulativeCost;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function persistedUsageToSnapshot(
  usage: PersistedUsage | undefined,
): UsageSnapshot | undefined {
  return usage ? { ...usage } : undefined;
}

// Build the _meta payload for session/load, injecting agent-specific hints
// needed to restore session state that the agent would otherwise lose.
//
// Per-agent notes:
//   claude-acp: SDK resume path uses --session-id/--replay-user-messages, not
//     --resume, so it doesn't read the persisted model from session state. Pass
//     it explicitly via _meta.claudeCode.options.model.
//   opencode: persists and restores model from its own session state — no
//     injection needed.
//   codex-acp: same bug as claude-acp (native binary, standard ACP LoadSessionRequest,
//     no _meta extension found). Proper fix: add modelId to ACP session/load spec.
//     TODO: inject here once codex-acp supports a _meta extension or ACP adds modelId.
function buildSessionLoadMeta(
  agentId: string,
  model: string | undefined,
): Record<string, unknown> | undefined {
  if (!model)
    return undefined;
  if (agentId === "claude-acp")
    return { claudeCode: { options: { model } } };
  return undefined;
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

// Pull an available-models list from a session/new or session/load response.
// Symmetric to extractInitialModes; agents put it in one of:
//   - claude-agent-acp / opencode: `result.models.availableModels` (items
//     are `{ modelId, name?, description? }` — sometimes `value` instead
//     of `modelId` for opencode's config-option shape)
//   - hypothetical spec-strict agent: top-level `result.availableModels`
//   - notification-only agents: nothing here; the list arrives later via
//     `current_model_update.availableModels` or, for opencode, a
//     `config_option_update` with `configOptions[i].id === "model"`.
//     This path returns [] in that case and the wireAgent extractors
//     pick it up.
export function extractInitialModels(
  result: Record<string, unknown>,
): AdvertisedModel[] {
  const direct = parseModelsList(result.availableModels);
  if (direct.length > 0) {
    return direct;
  }
  const models = result.models;
  if (models && typeof models === "object" && !Array.isArray(models)) {
    const fromModelsObj = parseModelsList(
      (models as Record<string, unknown>).availableModels,
    );
    if (fromModelsObj.length > 0) {
      return fromModelsObj;
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
        const fromMeta = parseModelsList(
          (value as Record<string, unknown>).availableModels,
        );
        if (fromMeta.length > 0) {
          return fromMeta;
        }
      }
    }
  }
  return [];
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

// Push a persisted mode back to a freshly loaded/spawned agent so a
// session that was in plan (or any non-default) mode doesn't silently
// revert on daemon restart. The agent boots in its own default after
// session/load and would otherwise emit a current_mode_update that
// overwrites our snapshot. Returns the mode we should record on the
// Session — either the persisted one (when we successfully pushed it,
// or the agent already agrees) or what the agent reported (when we
// skipped the push because the mode isn't advertised, or the call
// failed).
async function restoreCurrentMode(opts: {
  agent: AgentInstance;
  upstreamSessionId: string;
  persistedMode: string | undefined;
  agentReportedMode: string | undefined;
  advertisedModes: AdvertisedMode[] | undefined;
  logger?: AgentLogger;
}): Promise<string | undefined> {
  const {
    agent,
    upstreamSessionId,
    persistedMode,
    agentReportedMode,
    advertisedModes,
    logger,
  } = opts;
  if (!persistedMode) {
    return agentReportedMode;
  }
  if (persistedMode === agentReportedMode) {
    return persistedMode;
  }
  if (
    advertisedModes &&
    advertisedModes.length > 0 &&
    !advertisedModes.some((m) => m.id === persistedMode)
  ) {
    const known = advertisedModes.map((m) => m.id).join(", ");
    logger?.warn(
      `resurrect: persisted currentMode=${JSON.stringify(persistedMode)} not in agent's availableModes ([${known}]); skipping session/set_mode, session will use ${JSON.stringify(agentReportedMode)}`,
    );
    return agentReportedMode;
  }
  try {
    logger?.info(
      `resurrect: pushing persisted modeId=${JSON.stringify(persistedMode)} to agent (agentReported=${JSON.stringify(agentReportedMode)})`,
    );
    await agent.connection.request("session/set_mode", {
      sessionId: upstreamSessionId,
      modeId: persistedMode,
    });
    logger?.info(
      `resurrect: session/set_mode accepted, effectiveMode=${JSON.stringify(persistedMode)}`,
    );
    return persistedMode;
  } catch (err) {
    logger?.warn(
      `resurrect: session/set_mode rejected by agent for modeId=${JSON.stringify(persistedMode)} (${(err as Error).message}); session will use ${JSON.stringify(agentReportedMode)}`,
    );
    return agentReportedMode;
  }
}

// Push a persisted model back to a freshly loaded agent so a session
// that was on opus[1m] (or any non-default model) doesn't silently
// revert to the agent's default on daemon restart. The agent boots in
// its own default after session/load and would otherwise emit a
// current_model_update that overwrites our snapshot. Returns the model
// we should record on the Session — either the persisted one (when we
// successfully pushed it, or the agent already agrees) or what the
// agent reported (when the call failed).
//
// Unlike restoreCurrentMode, we do NOT skip when the id is absent from
// the advertised list. The persisted model came from an actual
// current_model_update the agent emitted in a prior session — the
// agent confirmed it works. Hydra aliases like "opus[1m]" are valid
// but may not appear in the advertised list (which uses canonical ids
// like "claude-opus-4-7"). Let the agent be the authority; if it
// rejects, we fall back.
async function restoreCurrentModel(opts: {
  agent: AgentInstance;
  upstreamSessionId: string;
  persistedModel: string | undefined;
  agentReportedModel: string | undefined;
  logger?: AgentLogger;
}): Promise<string | undefined> {
  const { agent, upstreamSessionId, persistedModel, agentReportedModel, logger } = opts;
  if (!persistedModel) {
    return agentReportedModel;
  }
  if (persistedModel === agentReportedModel) {
    return persistedModel;
  }
  try {
    logger?.info(
      `resurrect: pushing persisted modelId=${JSON.stringify(persistedModel)} to agent (agentReported=${JSON.stringify(agentReportedModel)})`,
    );
    await agent.connection.request("session/set_model", {
      sessionId: upstreamSessionId,
      modelId: persistedModel,
    });
    logger?.info(
      `resurrect: session/set_model accepted, effectiveModel=${JSON.stringify(persistedModel)}`,
    );
    return persistedModel;
  } catch (err) {
    logger?.warn(
      `resurrect: session/set_model rejected by agent for modelId=${JSON.stringify(persistedModel)} (${(err as Error).message}); session will use ${JSON.stringify(agentReportedModel)}`,
    );
    return agentReportedModel;
  }
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

// Walk history in reverse for the most recent turn_complete session/update
// and return its index + messageId. Returns undefined when no completed
// turn exists (empty history, or only a user prompt with no agent
// response yet). Used by forkSession to default forkAt to the latest
// terminal turn boundary.
function findLastTurnComplete(
  history: HistoryStoreEntry[],
): { index: number; messageId: string } | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (!entry || entry.method !== "session/update") {
      continue;
    }
    const update = (entry.params as { update?: { sessionUpdate?: unknown; messageId?: unknown } } | undefined)?.update;
    if (update?.sessionUpdate !== "turn_complete") {
      continue;
    }
    if (typeof update.messageId !== "string" || update.messageId.length === 0) {
      continue;
    }
    return { index: i, messageId: update.messageId };
  }
  return undefined;
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
// honestly idle. `mtime` is undefined when the file doesn't exist;
// `hasContent` is true only when the file exists AND has non-zero size,
// which effectiveInteractive uses as the "ever had a prompt" signal for
// legacy records that pre-date the interactive flag.
async function historyStatus(
  sessionId: string,
): Promise<{ mtime?: string; hasContent: boolean }> {
  try {
    const st = await fs.stat(paths.historyFile(sessionId));
    return {
      mtime: new Date(st.mtimeMs).toISOString(),
      hasContent: st.size > 0,
    };
  } catch {
    return { hasContent: false };
  }
}

// Single resolver for the `interactive` tristate that every default
// list / picker view filters on. Explicit values win; otherwise we
// infer from historical signals so existing on-disk records keep
// behaving the same way they did before the flag was introduced.
//
//   - record.interactive defined → use it verbatim
//   - legacy `hydra cat` row (no flag, originatingClient.name matches)
//     → treat as false (cat sessions have history but aren't
//     interactive; without this hint, every pre-flag cat session would
//     suddenly start appearing in default views)
//   - any other row with persisted history → treat as true
//   - everything else → undefined (hidden by default — covers the
//     editor-spawned "empty panel" sessions like Zed's)
export function effectiveInteractive(
  record: {
    interactive?: boolean;
    originatingClient?: { name: string };
  },
  hasContent: boolean,
): boolean | undefined {
  if (record.interactive !== undefined) {
    return record.interactive;
  }
  if (record.originatingClient?.name === HYDRA_CAT_CLIENT_NAME) {
    return false;
  }
  return hasContent ? true : undefined;
}
