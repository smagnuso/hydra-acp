import * as fs from "node:fs/promises";
import * as os from "node:os";
import { thisMachine } from "./machine.js";
import * as path from "node:path";
import { customAlphabet } from "nanoid";
import { AgentInstance, type AgentInstanceOptions, type AgentLogger } from "./agent-instance.js";
import { restoreCurrentMode, restoreCurrentModel } from "./restore-agent-settings.js";
import {
  Registry,
  listAgents,
  planSpawn,
  type AgentInstallProgressCallback,
  type SpawnPlan,
} from "./registry.js";
import { withSelfSessionEnv } from "./scrub-env.js";
import {
  HYDRA_SESSION_PREFIX,
  Session,
  extractPromptText,
  findMessageIdIndex,
  firstLine,
  parseModelsList,
  parseModesList,
  stripHydraSessionPrefix,
  type LoadExistingAgentSession,
  type SpawnReplacementAgentResult,
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
  type PersistedWorkspace,
  type RollbackBreadcrumb,
  type UpstreamGeneration,
  type SessionRecord,
} from "./session-store.js";
import { getProvider as getWorkspaceProvider } from "./workspace/registry.js";
import {
  allAnchorRefs,
  landingRetainRef,
  retiredSnapshotRef,
  workspaceAnchorRefs,
} from "./workspace/refs.js";
import {
  captureSourceForLanding,
  releaseSourceCapture,
  replaySourceDivergence,
} from "./workspace/source-state.js";
import {
  asSnapshotId,
  type IsolationProvider,
  type SnapshotId,
  type Workspace,
} from "./workspace/provider.js";
import {
  applyCarry,
  readWorkspaceRepoConfig,
  runWorkspaceHook,
  type WorkspaceRepoConfig,
} from "./workspace/setup.js";
import { execFile as execFileCb } from "node:child_process";

// Minimal git runner for the workspace-move path. Errors are returned,
// not thrown: every caller here has a meaningful fallback and none of
// them should take the session down.
function execGit(
  args: string[],
  cwd: string,
): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    execFileCb("git", args, { cwd, timeout: 120_000, maxBuffer: 64 * 1024 * 1024 }, (e, o, s) => {
      resolve({ ok: !e, out: o ?? "", err: s ?? "" });
    });
  });
}

function execGitStdin(
  args: string[],
  cwd: string,
  stdin: string,
): Promise<{ ok: boolean; err: string }> {
  return new Promise((resolve) => {
    const child = execFileCb(
      "git",
      args,
      { cwd, timeout: 120_000, maxBuffer: 64 * 1024 * 1024 },
      (e, _o, s) => resolve({ ok: !e, err: s ?? "" }),
    );
    child.stdin?.end(stdin);
  });
}
import {
  TombstoneStore,
  shouldResurrectFromUpstream,
} from "./tombstone-store.js";
import type { CompactionState, SessionSynopsis } from "./snapshot.js";
import { SynopsisCoordinator, type HydraCompactionPayload } from "./synopsis-coordinator.js";
import { generateSynopsis } from "./synopsis-agent.js";
import { HistoryStore, type HistoryEntry as HistoryStoreEntry } from "./history-store.js";
import { getToolBlob, readToolBlobGz, writeToolBlobGz } from "./tool-store.js";
import { collectToolBlobHashes } from "./tool-content.js";
import { paths, shortenHomePath } from "./paths.js";
import { expandHome } from "./config.js";
import { saveHistory as savePromptHistory } from "../tui/history.js";
import { encodeBundle, type Bundle } from "./bundle.js";
import type {
  AdvertisedCommand,
  AdvertisedMode,
  AdvertisedModel,
} from "./hydra-commands.js";
import { resolveModelId } from "./model-resolve.js";
import {
  inferModelVerbFromResult,
  requestModelChange,
  type ModelVerb,
} from "./model-verb.js";
import {
  HYDRA_CLIENT_CAPABILITIES,
  type AgentCapabilities,
  type AuthMethod,
  type SessionListEntry,
} from "../acp/types.js";
import { collapseUsage } from "./usage-collapse.js";
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
// Compaction swap is now event-driven (Session.onceIdle); the legacy
// poll-and-cap constants are gone. A swap that lands on a busy session
// parks an idle handler that fires whenever the session next quiesces,
// re-verifies via isQuiescedForSwap, and either swaps or — if history
// grew during the wait — reschedules the synopsis run.

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
  // handler uses it to push hydra-acp/agents/install_progress
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
  // Caller-supplied env to forward into the spawned agent process.
  // Used as `extraEnv` on AgentInstanceOptions; persisted on the
  // session record as `forwardedEnv` and reapplied on respawn /
  // cold-resurrect. An explicit empty map `{}` clears any persisted
  // value (overwrite semantics, not merge).
  forwardedEnv?: Record<string, string>;
  // Request an isolated workspace instead of running directly in `cwd`.
  // Arrives from _meta["hydra-acp"].workspace on session/new. When it
  // succeeds, `cwd` above is treated as the SOURCE tree and the session's
  // effective cwd becomes the workspace path.
  workspace?: WorkspaceRequest;
  // Caller-supplied callback to mint a FRESH per-session mcpServers
  // config for a new agent process spawned mid-life (compaction swap).
  // Wired by the daemon layer (acp-ws / REST routes) which owns the
  // token registry; session-manager just passes it through to Session.
  // Needed so cached MCP-server builds (keyed by token) get
  // invalidated when session state changes that affect tool
  // registration — primarily, recall_* tools that register only when
  // summarizedThroughEntry > 0. Receives the live Session for disposer
  // binding (on-close cleanup of the new token).
  mintMcpServersForSwap?: (session: import("./session.js").Session) => Promise<unknown[]>;
}

/**
 * Caller's request for an isolated workspace, as it arrives on
 * `_meta["hydra-acp"].workspace`.
 */
export interface WorkspaceRequest {
  /** Human-meaningful name; a filesystem-safe form appears in the path. */
  label?: string;
  /**
   * Opaque provider-issued snapshot to derive from. Omit for "current
   * state of cwd". Never construct one: it is only ever a token a
   * provider handed out earlier.
   */
  from?: string;
  /**
   * When true, a failure to isolate fails session creation instead of
   * falling back to the source tree.
   *
   * The default (false) is fail-open, which is right for an interactive
   * session: a broken setup should not stop you working. But a caller
   * running N agents against one tree needs the opposite, because a
   * silent fallback puts them all back in the same directory, which is
   * the failure isolation exists to prevent, arrived at quietly.
   */
  required?: boolean;
  /** Provider kind. Defaults to git; see workspace/registry.ts. */
  provider?: string;
}

/** Outcome of resolving a WorkspaceRequest, before the agent is spawned. */
interface ResolvedWorkspace {
  /** Effective cwd for the agent: the workspace when isolated, else the source. */
  cwd: string;
  workspace?: PersistedWorkspace;
  /** Set when isolation was requested but failed and we fell back. */
  isolationError?: string;
}

export interface ResurrectParams {
  hydraSessionId: string;
  upstreamSessionId: string;
  agentId: string;
  cwd: string;
  title?: string;
  // Isolated-workspace binding restored from the record. `cwd` above is
  // already the workspace path; this carries the source-tree edge that
  // cwd alone cannot express.
  workspace?: PersistedWorkspace;
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
  // User-set sort weight from meta.json; carried into the resurrected
  // Session so toggles + list rendering see the persisted value
  // immediately on wake.
  priority?: number;
  // Local-fork breadcrumbs from meta.json. Read-only on the resurrected
  // Session; surfaced in list views so future UI can show "branched from <id>".
  forkedFromSessionId?: string;
  forkedFromMessageId?: string;
  // Synthesis-fork state restored from meta.json on resurrect so the
  // live Session carries it forward and list views see it immediately.
  forkSynthesisState?: "running" | "failed";
  // MCP server descriptors to inject at session/load time. Mirrors
  // CreateSessionParams.mcpServers — the WS layer mints fresh per-session
  // bearer tokens and builds descriptors for currently-registered extension
  // MCP servers, then passes them here so resurrected sessions regain the
  // tools they had at original create time. Empty/undefined means the agent
  // gets no MCP servers (legacy behavior).
  mcpServers?: unknown[];
  // Env to forward into the spawn. Mirrors CreateSessionParams.forwardedEnv;
  // loadFromDisk() reads it off the persisted record.
  forwardedEnv?: Record<string, string>;
  // Persisted compaction state restored from meta.json on resurrect.
  // Passed to Session so buildStateSnapshotReplay can deliver it to
  // freshly-attaching clients before any live broadcast fires.
  compactionState?: CompactionState;
  // Attention flags restored from meta.json on cold resurrect so the
  // session starts with the correct attention state.
  attentionFlags?: import("../acp/types-attention.js").AttentionFlag[];
  // Daemon-supplied callback to mint fresh mcpServers on swap. Same
  // semantics as CreateSessionParams.mintMcpServersForSwap.
  mintMcpServersForSwap?: (session: import("./session.js").Session) => Promise<unknown[]>;
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
  // Optional override: agent for compaction jobs. Falls through to
  // synopsisAgent when unset.
  compactionAgent?: string;
  // Optional override: model for compaction jobs. Falls through to
  // synopsisModel when unset.
  compactionModel?: string;
  // Cap on entries kept in each session's on-disk history.jsonl. Forwarded
  // to both the shared HistoryStore (read-side trim) and every Session
  // (write-side compact + derived 20%-of-cap compact trigger).
   sessionHistoryMaxEntries?: number;
  // Per-archive byte ceiling (see HistoryStore). Defaults match the
  // HistoryStore built-in when omitted. Set 0 to disable spill archives
  // and revert to silent-drop trimming.
  sessionHistoryArchiveMaxBytes?: number;
  // Max archive tiers kept per session (see HistoryStore).
  sessionHistoryArchiveTiers?: number;
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
  // once at connect time and every warm session can dispatch to it.
  extensionCommands?: ExtensionCommandRegistry;
  // Turn off per-turn workspace snapshots. They are cheap on a normal
  // repository and expensive on a very large one (each is a tree walk),
  // so this exists as the escape hatch rather than making everyone pay.
  // Recovery of an isolated session degrades to committed work only.
  disableWorkspaceSnapshots?: boolean;
  // Fallback cwd used when a resurrected session's recorded cwd no longer
  // exists on disk (e.g. a `cat` session whose /tmp sandbox was cleaned
  // up, or a bundle imported from another machine). May be "~"/"$HOME";
  // expanded at use time. Defaults to "~".
  defaultCwd?: string;
  // Override for tests; production code constructs its own.
  tombstones?: TombstoneStore;
  // Compaction configuration forwarded to the synopsis coordinator and
  // used by the onSynthesisArtifact hook (swap logic).
  compaction?: {
    // Number of recent turns kept verbatim in the seed after compaction.
    tailK?: number;
    // Circuit-breaker on the catch-up loop during compaction.
    maxIterations?: number;
  };
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private resurrectionInflight = new Map<string, Promise<Session>>();
  // Workspace autosave. Coalescing (in-flight + one pending bit) rather
  // than a queue: turns can outpace snapshots on a large tree, and the
  // latest state taken once beats replaying a backlog of stale ones.
  private snapshotInFlight = new Set<string>();
  private snapshotPending = new Set<string>();
  private workspaceSnapshotsDisabled = false;
  // Standalone agents spawned by the `authenticate` RPC, keyed by
  // agentId. Kept alive past the RPC so an immediately-following
  // session/new can reuse the now-authenticated channel; auto-pruned
  // when the agent exits. At most one per agentId — a second
  // authenticate for the same id reuses the live entry.
  private pendingAuthAgents = new Map<string, AgentInstance>();
  private spawner: AgentSpawner;
  private store: SessionStore;
  private tombstones: TombstoneStore;
  private histories: HistoryStore;
  private idleTimeoutMs: number;
  private defaultModels: Record<string, string>;
  private synopsisAgent?: string;
  private synopsisModel?: string;
  private compactionAgent?: string;
  private compactionModel?: string;
  readonly defaultTransformers: string[];
  private idleEventTimeoutMs: number;
  private sessionHistoryMaxEntries: number;
  // Serialize meta.json read-modify-write operations per session id so
  // concurrent snapshot updates (e.g. an agent emitting model + mode
  // back-to-back) don't lose writes via interleaved reads.
  private metaWriteQueues = new Map<string, Promise<unknown>>();
  // Keyed by workspace PATH, not by session. A session joining a
  // workspace and a session tearing one down are a read-then-write on the
  // same shared fact (who is in here), and they live in different session
  // records — so the per-session meta-write slot cannot order them
  // against each other. Without this queue a join landing between "count
  // the live sessions" and "remove the directory" has its workspace
  // deleted out from under it.
  private workspaceQueues = new Map<string, Promise<unknown>>();
  // Short-TTL cache for list(). Coalesces the extension polling storm
  // (slack/browser/notifier/archiver each poll /v1/sessions every ~2s)
  // into a single fs sweep. Keyed by filter so picker variants (cwd
  // scope, includeNonInteractive) don't collide. 500ms is short enough
  // that staleness is invisible in the picker / extension UIs but long
  // enough that concurrent pollers share one read.
  private listCache = new Map<
    string,
    { expiresAt: number; promise: Promise<SessionListEntry[]> }
  >();
  private static readonly LIST_CACHE_TTL_MS = 500;
  private logger?: AgentLogger;
  private npmRegistry?: string;
  private extensionCommands?: ExtensionCommandRegistry;
  private defaultCwd: string;
  // Background queue for ephemeral-agent synopsis generation. Runs
  // out-of-band so session close is instant; persists synopsis/title
  // via the same enqueueMetaWrite path the in-session handlers used.
  private synopsisCoordinator: SynopsisCoordinator;
  // In-flight tombstone+unlink chains kicked off by the live-session
  // close handler. Awaited by deleteLiveSession() so the DELETE route
  // doesn't return 204 before the record is actually gone — without
  // this, a racing session/attach can see the meta.json still on disk
  // and resurrect a corpse.
  private pendingDeletions = new Map<string, Promise<void>>();
  // onceIdle disposers for sessions waiting on a quiesce edge to swap.
  // Keyed by sessionId so a re-arm replaces the prior handler instead of
  // stacking.
  private pendingSwapDisposers = new Map<string, () => void>();
  // Sessions currently executing a rollback. Guards against concurrent
  // uncompact + compact triggers.
  private rollbackLocks = new Set<string>();
  private compactionTailK = 20;
  // Cached agent catalog used to populate the `agent` config option's
  // value list. Refreshed lazily (fire-and-forget) since the underlying
  // registry load may hit the network; sessions read whatever snapshot is
  // current and always inject their own live agent if it's missing.
  private agentCatalog: Array<{
    id: string;
    name?: string;
    description?: string;
  }> = [];

  constructor(
    private registry: Registry,
    spawner?: AgentSpawner,
    store?: SessionStore,
    options: SessionManagerOptions = {},
  ) {
    this.spawner = spawner ?? ((opts) => AgentInstance.spawn(opts));
    this.store = store ?? new SessionStore();
    this.tombstones = options.tombstones ?? new TombstoneStore();
    this.sessionHistoryMaxEntries = options.sessionHistoryMaxEntries ?? 1000;
    this.histories = new HistoryStore({
      maxEntries: this.sessionHistoryMaxEntries,
      archiveMaxBytes: options.sessionHistoryArchiveMaxBytes,
      archiveTiers: options.sessionHistoryArchiveTiers,
    });
    this.workspaceSnapshotsDisabled = options.disableWorkspaceSnapshots === true;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 0;
    this.idleEventTimeoutMs = options.idleEventTimeoutMs ?? 30_000;
    this.defaultModels = options.defaultModels ?? {};
    this.synopsisAgent = options.synopsisAgent;
    this.synopsisModel = options.synopsisModel;
    this.compactionAgent = options.compactionAgent;
    this.compactionModel = options.compactionModel;
    this.defaultTransformers = options.defaultTransformers ?? [];
    this.logger = options.logger;
    this.npmRegistry = options.npmRegistry;
    this.extensionCommands = options.extensionCommands;
    this.defaultCwd = options.defaultCwd ?? "~";
    const compactionConfig = options.compaction ?? {};
    const tailK = compactionConfig.tailK ?? 20;
    this.compactionTailK = tailK;
    this.synopsisCoordinator = new SynopsisCoordinator({
      registry: this.registry,
      store: this.store,
      histories: this.histories,
      synopsisAgent: this.synopsisAgent,
      synopsisModel: this.synopsisModel,
      compactionAgent: this.compactionAgent,
      compactionModel: this.compactionModel,
      compactionMaxIterations: compactionConfig.maxIterations,
      persistTitle: async (id, title) => {
        // Route through the warm session when one exists (e.g. bare
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
      onCompactionStateChange: async (sessionId, state, ctx) => {
        // /hydra agent jobs don't use compactionState — the agent-swap
        // breadcrumb lives on record.pendingAgentSwap (set at schedule
        // time, cleared on successful swap). compactionState describes
        // compaction work only.
        if (ctx.targetAgentId) {
          return;
        }
        // Mirror to the live Session's in-memory field so manager.list()
        // (which reads session.compactionState directly, not from disk)
        // surfaces the current compactionState to pickers and other
        // clients without waiting for disk to settle.
        const live = this.get(sessionId);
        if (live) {
          live.compactionState = state;
        }
        await this.mutateRecord(sessionId, { compactionState: state });
      },
      broadcastHydraCompaction: (sessionId, payload, ctx) => {
        this.emitSwapPhase(sessionId, ctx.targetAgentId, payload);
      },
      onSynthesisArtifact: async (sessionId, artifact, summarizedThroughEntry, targetAgentId) => {
        await this.dispatchSynthesisSwap(sessionId, artifact, summarizedThroughEntry, targetAgentId);
      },
    });
    void this.refreshAgentCatalog();
  }

  // Drive the compaction swap. When the session is already quiesced this
  // calls swapUpstream immediately. When it's not, we park an onceIdle
  // handler on the Session that re-attempts the swap at the next quiesce
  // edge — no polling, no retry cap, no false "giving up" failures. If
  // history grew past the artifact's watermark while we waited, we
  // reschedule the synopsis coordinator instead of swapping with a stale
  // artifact (the coordinator's catch-up loop converges; eventually a
  // fresh artifact triggers a new dispatchSynthesisSwap call).
  private async dispatchSynthesisSwap(
    sessionId: string,
    artifact: SessionSynopsis,
    summarizedThroughEntry: number,
    targetAgentId?: string,
  ): Promise<void> {
    const live = this.get(sessionId);
    if (!live) {
      // Cold — persist the artifact for the next resume. No swap target.
      // targetAgentId is preserved on compactionState (written by the
      // coordinator) so a resurrected session resumes against the right
      // agent.
      this.logger?.info(
        `compaction: persisted artifact for cold session sessionId=${sessionId}`,
      );
      await this.mutateRecord(sessionId, {
        synopsis: artifact,
        summarizedThroughEntry,
      });
      return;
    }
    const tailK = this.compactionTailK;
    try {
      const quiesced = await live.isQuiescedForSwap();
      if (quiesced) {
        // Drop any prior waiter — we're acting now.
        this.pendingSwapDisposers.get(sessionId)?.();
        this.pendingSwapDisposers.delete(sessionId);
        await this.performSynthesisSwap(live, artifact, tailK, summarizedThroughEntry, targetAgentId);
        return;
      }
      // Not quiesced — park an onceIdle handler that retries the swap
      // when the session next quiesces. Replace any prior waiter so we
      // don't double-fire when this is called repeatedly.
      this.pendingSwapDisposers.get(sessionId)?.();
      this.logger?.info(
        `compaction: session not quiesced, parking onceIdle swap sessionId=${sessionId}`,
      );
      this.emitSwapPhase(sessionId, targetAgentId, { phase: "deferred" });
      const disposer = live.onceIdle(() => {
        this.pendingSwapDisposers.delete(sessionId);
        void this.onIdleAttemptSwap(sessionId);
      });
      this.pendingSwapDisposers.set(sessionId, disposer);
    } catch (err) {
      this.logger?.warn(
        `compaction: dispatch failed for sessionId=${sessionId}: ${err instanceof Error ? err.message : String(err)}, leaving session as-is`,
      );
    }
  }

  // Idle-edge handler. Re-verifies the strong quiesce check (the onIdle
  // primitive uses isQuiescedSync, which doesn't scan for open tool
  // calls), reads the freshest persisted artifact from disk (synopsis
  // may have advanced via a catch-up run), and either swaps or
  // reschedules a synopsis if history overran the artifact watermark.
  private async onIdleAttemptSwap(sessionId: string): Promise<void> {
    const live = this.get(sessionId);
    if (!live) {
      return;
    }
    const tailK = this.compactionTailK;
    try {
      const quiesced = await live.isQuiescedForSwap();
      if (!quiesced) {
        // Activity arrived between the onceIdle fire and the strong
        // check (an open tool call from the prior turn is still pending,
        // or a new prompt slipped in). Re-park the waiter — we'll get
        // another shot at the next idle edge. Carry pendingAgentSwap
        // through if this is a cross-agent job.
        const record = await this.store.read(sessionId).catch(() => undefined);
        if (record?.synopsis && record.summarizedThroughEntry !== undefined) {
          void this.dispatchSynthesisSwap(
            sessionId,
            record.synopsis,
            record.summarizedThroughEntry,
            record.pendingAgentSwap,
          );
        }
        return;
      }
      const record = await this.store.read(sessionId).catch(() => undefined);
      if (!record?.synopsis || record.summarizedThroughEntry === undefined) {
        this.logger?.warn(
          `compaction: persisted artifact missing for sessionId=${sessionId}, abandoning swap`,
        );
        live.compactionState = undefined;
        await this.mutateRecord(sessionId, {}, ["compactionState"]);
        return;
      }
      // pendingAgentSwap is the agent-switch breadcrumb; survives daemon
      // restart and any onceIdle deferral.
      const targetAgentId = record.pendingAgentSwap;
      // History-growth check: if entries past the watermark accumulated
      // while we waited, the artifact is stale. Re-run the synopsis
      // coordinator; once it converges, onSynthesisArtifact will be
      // called again with a fresh artifact.
      const history = await this.histories.load(sessionId).catch(() => []);
      if (history.length > record.summarizedThroughEntry) {
        this.logger?.info(
          `compaction: history grew during deferral (have=${history.length} artifact=${record.summarizedThroughEntry}), rescheduling synopsis sessionId=${sessionId}`,
        );
        if (targetAgentId) {
          this.synopsisCoordinator.scheduleCompaction(sessionId, { targetAgentId });
        } else {
          this.synopsisCoordinator.scheduleCompaction(sessionId);
        }
        return;
      }
      await this.performSynthesisSwap(
        live,
        record.synopsis,
        tailK,
        record.summarizedThroughEntry,
        targetAgentId,
      );
    } catch (err) {
      this.logger?.warn(
        `compaction: onIdleAttemptSwap failed for sessionId=${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async performSynthesisSwap(
    live: Session,
    artifact: SessionSynopsis,
    tailK: number,
    summarizedThroughEntry: number,
    targetAgentId?: string,
  ): Promise<void> {
    try {
      // Per-intent floor: /hydra agent (cross-agent) wants a few
      // verbatim turns for continuity; /compact wants pure synopsis
      // (lean handoff, the explicit point of compaction).
      const tailFloor = targetAgentId ? Math.min(5, tailK) : 0;
      await live.swapUpstream({
        artifact,
        tailK,
        tailFloor,
        summarizedThroughEntry,
        ...(targetAgentId ? { newAgentId: targetAgentId } : {}),
      });
      if (targetAgentId) {
        // Cross-agent swap completed — drop the breadcrumb so resume
        // doesn't re-fire the same swap. Compaction-only state is
        // already absent on this path (the coordinator never wrote it).
        await this.mutateRecord(live.sessionId, {}, ["pendingAgentSwap"]);
      } else {
        // Clear compactionState now that the swap completed (in-memory
        // and on disk in lockstep — see onCompactionStateChange above).
        live.compactionState = undefined;
        await this.mutateRecord(live.sessionId, {}, ["compactionState"]);
      }
    } catch (err) {
      this.logger?.warn(
        `compaction: swap failed for sessionId=${live.sessionId}: ${err instanceof Error ? err.message : String(err)}, leaving session as-is`,
      );
    }
  }

  // Refresh the cached agent catalog from the registry. Fire-and-forget;
  // failures leave the prior snapshot in place. Called at construction and
  // after each session creation so the list tracks newly-installed agents.
  private async refreshAgentCatalog(): Promise<void> {
    try {
      const { agents } = await listAgents(this.registry);
      this.agentCatalog = agents.map((a) => ({
        id: a.id,
        name: a.name,
        ...(a.description !== undefined ? { description: a.description } : {}),
      }));
    } catch {
      // Keep the existing snapshot; sessions still inject their live agent.
    }
  }

  /**
   * Turn a WorkspaceRequest into the cwd the agent should actually run in.
   *
   * Must run BEFORE bootstrapAgent, because the agent process's working
   * directory is fixed at exec: isolating after the spawn would leave the
   * agent in the source tree with a workspace nobody is using.
   *
   * On failure this falls back to the source tree and records the reason,
   * unless the caller marked isolation `required`. Non-repository
   * directories, repositories with no commits, and a missing git binary
   * are all expected fail-open cases rather than errors.
   *
   * Note on crash-window ordering: the design called for writing the
   * session record before creating the workspace, so a crash could not
   * strand an unfindable directory. That is unnecessary here because
   * workspaces live under a deterministic per-source root and the
   * provider can enumerate them (listWorkspaces), so an orphan is
   * discoverable by reconciliation without a prior record. A record
   * written first would only add the owning session id, which an
   * ownerless orphan does not need.
   */
  private async resolveWorkspace(params: CreateSessionParams): Promise<ResolvedWorkspace> {
    const request = params.workspace;
    if (request === undefined) {
      return { cwd: params.cwd };
    }
    const provider = getWorkspaceProvider(request.provider);
    if (provider === undefined) {
      const reason = `unknown workspace provider "${request.provider}"`;
      if (request.required === true) {
        throw new Error(`isolation required but unavailable: ${reason}`);
      }
      this.logger?.warn?.(`session workspace: ${reason}; running in ${params.cwd}`);
      return { cwd: params.cwd, isolationError: reason };
    }

    const label = request.label ?? `s-${generateRawSessionId().slice(0, 8)}`;
    const created = await provider
      .createWorkspace({
        sourceCwd: params.cwd,
        label,
        ...(request.from !== undefined ? { from: asSnapshotId(request.from) } : {}),
      })
      .catch((err: unknown) => ({ ok: false as const, reason: String(err) }));

    if (!created.ok) {
      if (request.required === true) {
        throw new Error(`isolation required but unavailable: ${created.reason}`);
      }
      this.logger?.warn?.(
        `session workspace: ${created.reason}; falling back to ${params.cwd} (unisolated)`,
      );
      return { cwd: params.cwd, isolationError: created.reason };
    }

    const ws = created.workspace;
    // Lock while the session is live so a concurrent prune (ours,
    // another client's, or a human's) cannot remove a checkout somebody
    // is working in. Best-effort: a provider without locking still gets
    // a usable workspace.
    if (provider.capabilities().locking) {
      await provider.lock(ws, `session ${params.title ?? "live"}`).catch(() => undefined);
    }

    // Make the workspace usable: carry gitignored-but-required files in,
    // then run the repo's setup command. A failure here is reported but
    // does NOT fail the session even under `required: true` — that flag
    // is about isolation, and isolation succeeded. A session in a
    // half-set-up workspace is still isolated and still more useful than
    // no session; the reason is surfaced so the gap is visible.
    const repoConfig = await readWorkspaceRepoConfig(ws.sourceCwd).catch((): WorkspaceRepoConfig => ({}));
    let setupError: string | undefined;
    if (repoConfig.carry !== undefined && repoConfig.carry.length > 0) {
      const carried = await applyCarry(ws.sourceCwd, ws.path, repoConfig.carry).catch(
        () => undefined,
      );
      if (carried !== undefined && carried.copied.length > 0) {
        this.logger?.info?.(
          `session workspace: carried ${carried.copied.length} file(s) into ${ws.path}`,
        );
      }
    }
    if (repoConfig.postCreate !== undefined) {
      const hook = await runWorkspaceHook(repoConfig.postCreate, {
        workspacePath: ws.path,
        sourceCwd: ws.sourceCwd,
        label: ws.label,
        ...(repoConfig.hookTimeoutSeconds !== undefined
          ? { timeoutSeconds: repoConfig.hookTimeoutSeconds }
          : {}),
      });
      if (!hook.ok) {
        setupError = `postCreate failed: ${hook.reason ?? "unknown"}`;
        this.logger?.warn?.(`session workspace: ${setupError} (${ws.path})`);
      }
    }

    return {
      cwd: ws.path,
      workspace: {
        path: ws.path,
        sourceCwd: ws.sourceCwd,
        label: ws.label,
        provider: ws.provider,
        ...(ws.snapshot !== undefined ? { snapshot: ws.snapshot } : {}),
        ...(ws.vcs !== undefined ? { vcs: { ...ws.vcs } } : {}),
      },
      // Isolation succeeded; setup did not. Reported through the same
      // channel so a client sees "you are isolated but the environment
      // is incomplete" rather than nothing at all.
      ...(setupError !== undefined ? { isolationError: setupError } : {}),
    };
  }

  async create(params: CreateSessionParams): Promise<Session> {
    // Canonicalize the caller-supplied agentId to the registry's id
    // (e.g. "claude-agent-acp" from a shim → "claude-acp", "claude"
    // from --agent fuzzy match → "claude-acp") so the persisted session
    // record and every downstream lookup uses the registry-canonical id
    // regardless of which alias the caller typed. Mirrors Registry.getAgent's
    // resolution ladder; if getAgent returns nothing we leave the id
    // alone and let bootstrapAgent surface the AgentNotInstalled error.
    const canonical = await this.registry.getAgent(params.agentId);
    if (canonical && canonical.id !== params.agentId) {
      params = { ...params, agentId: canonical.id };
    }
    // Mint the id before the agent spawns rather than letting Session
    // mint it afterwards. The agent's environment is fixed at exec, so
    // "tell the agent which session it is" only works if we already
    // know. Session accepts the id and skips its own generation.
    const sessionId = `${HYDRA_SESSION_PREFIX}${generateRawSessionId()}`;
    // Resolve isolation before the spawn: a process's working directory
    // is fixed at exec. `effectiveCwd` is the workspace when isolated and
    // the caller's cwd otherwise, and it is what BOTH the agent process
    // and the Session must use, so that respawn and cold resurrect land
    // in the same place with no extra plumbing.
    const resolved = await this.resolveWorkspace(params);
    const effectiveCwd = resolved.cwd;
    const fresh = await this.bootstrapAgent({
      agentId: params.agentId,
      cwd: effectiveCwd,
      agentArgs: params.agentArgs,
      mcpServers: params.mcpServers,
      model: params.model,
      onInstallProgress: params.onInstallProgress,
      forwardedEnv: params.forwardedEnv,
      selfSessionId: sessionId,
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
          const result = await t.connection.request("hydra-acp/transformer/message", {
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
    const session: Session = new Session({
      sessionId,
      cwd: effectiveCwd,
      ...(resolved.workspace !== undefined ? { workspace: resolved.workspace } : {}),
      ...(resolved.isolationError !== undefined
        ? { workspaceError: resolved.isolationError }
        : {}),
      agentId: params.agentId,
      agent: fresh.agent,
      upstreamSessionId: fresh.upstreamSessionId,
      agentMeta: fresh.agentMeta,
      agentCapabilities: fresh.agentCapabilities,
      ...(fresh.modelVerb ? { modelVerb: fresh.modelVerb } : {}),
      title: params.title,
      agentArgs: params.agentArgs,
      idleTimeoutMs: this.idleTimeoutMs,
      idleEventTimeoutMs: this.idleEventTimeoutMs,
      logger: this.logger,
      spawnReplacementAgent: (p) =>
        this.bootstrapAgent({
          ...p,
          mcpServers: p.mcpServers ?? [],
          selfSessionId: sessionId,
        }),
      loadExistingAgentSession: (upstreamId, p) =>
        this.bootstrapAgentLoad(upstreamId, {
          ...p,
          mcpServers: p.mcpServers ?? [],
          selfSessionId: sessionId,
        }),
      ...(params.mintMcpServersForSwap
        ? { mintMcpServersForSwap: params.mintMcpServersForSwap }
        : {}),
      listSessions: () => this.list(),
      availableAgents: () => this.agentCatalog,
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
      forwardedEnv: params.forwardedEnv,
      mcpServers: params.mcpServers ?? [],
      extensionCommands: this.extensionCommands,
      scheduleSynopsis: () => this.synopsisCoordinator.schedule(session.sessionId),
      scheduleWorkspaceSnapshot: () => this.scheduleWorkspaceSnapshot(session),
      scheduleCompaction: (opts) => this.scheduleCompaction(session.sessionId, opts),
      resolveAgentId: async (id) => (await this.registry.getAgent(id))?.id,
      getCompactionState: () => this.getCompactionState(session.sessionId),
      getPendingAgentSwap: () => this.getPendingAgentSwap(session.sessionId),
      uncompactHook: () => this.performUncompact(session.sessionId),
      forkHook: (opts) => this.forkSession(session.sessionId, opts ?? {}),
      workspaceHook: (action, name) =>
        this.runWorkspaceAction(session.sessionId, action, name),
      onCompactionSwapHook: (breadcrumb) =>
        void this.mutateRecord(session.sessionId, { rollbackBreadcrumb: breadcrumb }).catch(() => undefined),
      clearRollbackBreadcrumbHook: () =>
        void this.mutateRecord(session.sessionId, {}, ["rollbackBreadcrumb"]).catch(() => undefined),
    });
    // Ask the provider what is odd about this particular workspace and
    // hand it to the session for the orientation preamble. Conditional
    // by construction (the provider inspects before it speaks), so a
    // repo without submodules is never told about submodules: this text
    // is paid on the first prompt of every isolated session and again
    // whenever one names the source tree.
    if (resolved.workspace !== undefined) {
      const notesProvider = getWorkspaceProvider(resolved.workspace.provider);
      if (notesProvider !== undefined && notesProvider.capabilities().supports.environmentNotes) {
        session.workspaceNotes = await notesProvider
          .environmentNotes({
            path: resolved.workspace.path,
            sourceCwd: resolved.workspace.sourceCwd,
            label: resolved.workspace.label,
            provider: resolved.workspace.provider,
            ...(resolved.workspace.snapshot !== undefined
              ? { snapshot: asSnapshotId(resolved.workspace.snapshot) }
              : {}),
            ...(resolved.workspace.vcs !== undefined ? { vcs: resolved.workspace.vcs } : {}),
          })
          .catch((): readonly string[] => []);
      }
    }
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
    const resurrectEnv = withSelfSessionEnv(
      params.hydraSessionId,
      params.forwardedEnv,
    );
    const agent = this.spawner({
      agentId: params.agentId,
      cwd: params.cwd,
      plan,
      ...(resurrectEnv ? { extraEnv: resurrectEnv } : {}),
    });

    let agentCapabilities: AgentCapabilities | undefined;
    try {
      const initResult = await agent.connection.request<Record<string, unknown>>(
        "initialize",
        {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: HYDRA_CLIENT_CAPABILITIES,
          clientInfo: { name: "hydra", version: HYDRA_VERSION },
        },
      );
      agentCapabilities = initResult.agentCapabilities as
        | AgentCapabilities
        | undefined;
      agent.authMethods = parseAuthMethods(initResult.authMethods);
    } catch (err) {
      await agent.kill().catch(() => undefined);
      throw enrichAuthRequired(err, agent);
    }

    let loadResult: Record<string, unknown> | undefined;
    try {
      const loadMeta = buildSessionLoadMeta(params.agentId, params.currentModel);
      loadResult = await agent.connection.request<Record<string, unknown>>(
        "session/load",
        {
          sessionId: params.upstreamSessionId,
          cwd: params.cwd,
          mcpServers: params.mcpServers ?? [],
          ...(loadMeta && { _meta: loadMeta }),
        },
      );
    } catch (err) {
      // AUTH_REQUIRED is not a missing-upstream-id condition; the
      // recovery/reseed path would mint a brand-new session without
      // resolving the actual auth problem. Surface it verbatim with
      // enriched authMethods context so editors can prompt the user.
      if (
        err &&
        typeof err === "object" &&
        (err as { code?: unknown }).code === JsonRpcErrorCodes.AuthRequired
      ) {
        await agent.kill().catch(() => undefined);
        throw enrichAuthRequired(err, agent);
      }
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
    // Verb inferred from the session/load response shape; restoreCurrentModel
    // leads with it and probes the other on MethodNotFound.
    const loadedModelVerb = inferModelVerbFromResult(loadResult);
    const effectiveModel = await restoreCurrentModel({
      agent,
      upstreamSessionId: params.upstreamSessionId,
      persistedModel: params.currentModel,
      agentReportedModel,
      ...(loadedModelVerb ? { modelVerb: loadedModelVerb } : {}),
      logger: this.logger,
    });
    if (params.pendingHistorySync !== true) {
      const drain3Count = agent.connection.drainBuffered("session/update");
      this.logger?.info(
        `resurrect: drain3 (post-model-restore) dropped ${drain3Count} buffered session/update(s) for sessionId=${params.hydraSessionId}`,
      );
    }

    const session: Session = new Session({
      sessionId: params.hydraSessionId,
      cwd: params.cwd,
      ...(params.workspace !== undefined ? { workspace: params.workspace } : {}),
      agentId: params.agentId,
      agent,
      upstreamSessionId: params.upstreamSessionId,
      agentMeta: loadResult?._meta as Record<string, unknown> | undefined,
      agentCapabilities,
      ...(loadedModelVerb ? { modelVerb: loadedModelVerb } : {}),
      title: params.title,
      agentArgs: params.agentArgs,
      idleTimeoutMs: this.idleTimeoutMs,
      logger: this.logger,
      spawnReplacementAgent: (p) =>
        this.bootstrapAgent({
          ...p,
          mcpServers: p.mcpServers ?? params.mcpServers ?? [],
          selfSessionId: params.hydraSessionId,
        }),
      loadExistingAgentSession: (upstreamId, p) =>
        this.bootstrapAgentLoad(upstreamId, {
          ...p,
          mcpServers: p.mcpServers ?? params.mcpServers ?? [],
          selfSessionId: params.hydraSessionId,
        }),
      ...(params.mintMcpServersForSwap
        ? { mintMcpServersForSwap: params.mintMcpServersForSwap }
        : {}),
      listSessions: () => this.list(),
      availableAgents: () => this.agentCatalog,
      historyStore: this.histories,
      historyMaxEntries: this.sessionHistoryMaxEntries,
      currentModel: effectiveModel,
      currentMode: effectiveMode,

      currentUsage: params.currentUsage,
      // This path reached the agent via session/load on the SAME upstream
      // session id, so an agent that scopes its cost ledger to the session
      // will re-report the total loadFromDisk just banked.
      reloadsUpstreamLedger: true,
      agentCommands: params.agentCommands,
      agentModes: advertisedModes,
      // Always prefer the fresh list from session/load over the persisted
      // snapshot — the proxy's available models can change between daemon
      // restarts (quota resets, rollouts), so meta.json is intentionally
      // treated as a cold fallback here, not the authoritative source.
      agentModels: advertisedModels,
      summarizedThroughEntry: params.summarizedThroughEntry,
      compactionState: params.compactionState,
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
      priority: params.priority,
      forkedFromSessionId: params.forkedFromSessionId,
      forkedFromMessageId: params.forkedFromMessageId,
      forwardedEnv: params.forwardedEnv,
      mcpServers: params.mcpServers ?? [],
      extensionCommands: this.extensionCommands,
      attentionFlags: params.attentionFlags,
      scheduleSynopsis: () => this.synopsisCoordinator.schedule(session.sessionId),
      scheduleWorkspaceSnapshot: () => this.scheduleWorkspaceSnapshot(session),
      scheduleCompaction: (opts) => this.scheduleCompaction(session.sessionId, opts),
      resolveAgentId: async (id) => (await this.registry.getAgent(id))?.id,
      getCompactionState: () => this.getCompactionState(session.sessionId),
      getPendingAgentSwap: () => this.getPendingAgentSwap(session.sessionId),
      uncompactHook: () => this.performUncompact(session.sessionId),
      forkHook: (opts) => this.forkSession(session.sessionId, opts ?? {}),
      workspaceHook: (action, name) =>
        this.runWorkspaceAction(session.sessionId, action, name),
      onCompactionSwapHook: (breadcrumb) =>
        void this.mutateRecord(session.sessionId, { rollbackBreadcrumb: breadcrumb }).catch(() => undefined),
      clearRollbackBreadcrumbHook: () =>
        void this.mutateRecord(session.sessionId, {}, ["rollbackBreadcrumb"]).catch(() => undefined),
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
    const resolvedTarget = await this.resolveResurrectTarget(params.cwd, params.workspace);
    const cwd = resolvedTarget.cwd;
    const fresh = await this.bootstrapAgent({
      agentId: params.agentId,
      cwd,
      agentArgs: params.agentArgs,
      mcpServers: params.mcpServers ?? [],
      onInstallProgress: params.onInstallProgress,
      forwardedEnv: params.forwardedEnv,
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
      ...(fresh.modelVerb ? { modelVerb: fresh.modelVerb } : {}),
      logger: this.logger,
    });
    // Drop any buffered session/update notifications that arrived during
    // the restore calls — same race as doResurrect.
    fresh.agent.connection.drainBuffered("session/update");
    const session: Session = new Session({
      sessionId: params.hydraSessionId,
      cwd,
      // Carry the RESOLVED binding, not the recorded one: recovery may
      // have rebuilt the workspace elsewhere, or given up entirely (in
      // which case this is undefined and the session is honestly no
      // longer isolated).
      ...(resolvedTarget.workspace !== undefined
        ? { workspace: resolvedTarget.workspace }
        : {}),
      agentId: params.agentId,
      agent: fresh.agent,
      upstreamSessionId: fresh.upstreamSessionId,
      agentMeta: fresh.agentMeta,
      agentCapabilities: fresh.agentCapabilities,
      ...(fresh.modelVerb ? { modelVerb: fresh.modelVerb } : {}),
      title: params.title,
      agentArgs: params.agentArgs,
      idleTimeoutMs: this.idleTimeoutMs,
      logger: this.logger,
      spawnReplacementAgent: (p) =>
        this.bootstrapAgent({
          ...p,
          mcpServers: p.mcpServers ?? params.mcpServers ?? [],
          selfSessionId: params.hydraSessionId,
        }),
      loadExistingAgentSession: (upstreamId, p) =>
        this.bootstrapAgentLoad(upstreamId, {
          ...p,
          mcpServers: p.mcpServers ?? params.mcpServers ?? [],
          selfSessionId: params.hydraSessionId,
        }),
      ...(params.mintMcpServersForSwap
        ? { mintMcpServersForSwap: params.mintMcpServersForSwap }
        : {}),
      listSessions: () => this.list(),
      availableAgents: () => this.agentCatalog,
      historyStore: this.histories,
      historyMaxEntries: this.sessionHistoryMaxEntries,
      currentModel: effectiveModel,
      currentMode: effectiveMode,

      currentUsage: params.currentUsage,
      agentCommands: params.agentCommands,
      agentModes: advertisedModes,
      agentModels: advertisedModels,
      summarizedThroughEntry: params.summarizedThroughEntry,
      firstPromptSeeded: !!params.title,
      createdAt: params.createdAt
        ? new Date(params.createdAt).getTime()
        : undefined,
      originatingClient: params.originatingClient,
      interactive: params.interactive,
      priority: params.priority,
      forkedFromSessionId: params.forkedFromSessionId,
      forkedFromMessageId: params.forkedFromMessageId,
      forwardedEnv: params.forwardedEnv,
      mcpServers: params.mcpServers ?? [],
      extensionCommands: this.extensionCommands,
      attentionFlags: params.attentionFlags,
      scheduleSynopsis: () => this.synopsisCoordinator.schedule(session.sessionId),
      scheduleWorkspaceSnapshot: () => this.scheduleWorkspaceSnapshot(session),
      scheduleCompaction: (opts) => this.scheduleCompaction(session.sessionId, opts),
      resolveAgentId: async (id) => (await this.registry.getAgent(id))?.id,
      getCompactionState: () => this.getCompactionState(session.sessionId),
      getPendingAgentSwap: () => this.getPendingAgentSwap(session.sessionId),
      uncompactHook: () => this.performUncompact(session.sessionId),
      forkHook: (opts) => this.forkSession(session.sessionId, opts ?? {}),
      workspaceHook: (action, name) =>
        this.runWorkspaceAction(session.sessionId, action, name),
      onCompactionSwapHook: (breadcrumb) =>
        void this.mutateRecord(session.sessionId, { rollbackBreadcrumb: breadcrumb }).catch(() => undefined),
      clearRollbackBreadcrumbHook: () =>
        void this.mutateRecord(session.sessionId, {}, ["rollbackBreadcrumb"]).catch(() => undefined),
    });
    await this.attachManagerHooks(session);
    // Fire and forget — the seed runs through enqueuePrompt inside
    // Session, so any user prompt arriving mid-seed queues behind it.
    if (params.forkedFromSessionId && params.forkSynthesisState === "running") {
      // Synthesis still generating — its synopsis will land in the
      // background. Skip seeding now; the full history is in the fork's
      // history.jsonl and recall MCP mints from summarizedThroughEntry, so
      // the agent has context on demand. (Re-seeding when the synopsis
      // arrives is intentionally not done — first attach is the only seed.)
      this.logger?.info(`fork ${session.sessionId}: synthesis in flight — skipping seed, recall available`);
    } else if (
      params.forkedFromSessionId &&
      (params.synopsis || (params.summarizedThroughEntry ?? 0) > 0)
    ) {
      // Fork with a synopsis (compaction / synthesis-done) OR a verbatim/btw
      // fork with history to replay. seedFromFork renders [synopsis if
      // present] + the last TAIL_K turns; recall covers the rest of the
      // prefix. synopsis may be undefined here (no-synopsis btw / failed
      // synthesis) — seedFromFork degrades to title + recent turns.
      void session.seedFromFork(params.synopsis).catch(() => undefined);
    } else {
      void session.seedFromImport().catch(() => undefined);
    }
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
    // A detach does not mean the work is over. `hydra cat --no-wait`
    // enqueues a prompt and detaches as soon as the daemon acks the
    // enqueue, so the turn it asked for often hasn't started yet;
    // reaping here kills the agent mid-flight and the message is lost
    // with no error anywhere. Defer to the next quiesce, matching what
    // the idle-close path already does with the same guard.
    if (session.hasWorkInFlight) {
      this.logger?.info(
        `deferring reap of ${sessionId}: work still in flight after detach`,
      );
      session.onceIdle((s) => {
        void this.reapIfOrphanedNonInteractive(s.sessionId).catch(
          () => undefined,
        );
      });
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
  //
  // For an ISOLATED session the recorded cwd is its workspace, which is a
  // deletable directory, so this path is reached routinely rather than
  // rarely. Falling straight through to defaultCwd (`~`) would resurrect
  // an agent in the user's home directory carrying a history full of
  // edits it believes it made to a project: useless, and pointed at a
  // bad place to keep working. The ladder below is what makes such a
  // session recoverable at all.
  private async resolveResurrectTarget(
    cwd: string,
    workspace?: PersistedWorkspace,
  ): Promise<{ cwd: string; workspace?: PersistedWorkspace }> {
    if (await this.dirExists(cwd)) {
      return workspace !== undefined ? { cwd, workspace } : { cwd };
    }
    if (workspace !== undefined) {
      const recovered = await this.recoverWorkspace(workspace);
      if (recovered !== undefined) {
        return { cwd: recovered.path, workspace: recovered };
      }
    }
    // Nothing recoverable. Drop the binding rather than carry a record
    // pointing at a directory that no longer exists: a session sitting in
    // defaultCwd is not isolated, and saying otherwise would make it
    // filterable by a source tree it can no longer affect.
    return { cwd: expandHome(this.defaultCwd) };
  }

  /**
   * Recover a vanished workspace, preferring the option that keeps the
   * session's work:
   *
   *   1. Rematerialize from provider-retained state. For git the branch
   *      outlives `worktree remove`, so every COMMITTED change comes back
   *      intact; only uncommitted edits were lost with the directory.
   *   2. Otherwise a fresh workspace from the same source tree. The
   *      conversation survives, the files do not, and isolation is still
   *      honored (which matters: the session was isolated deliberately,
   *      so silently reseeding it into the user's checkout would defeat
   *      the choice at the worst possible moment).
   *
   * Returns undefined if neither works, leaving the caller's defaultCwd
   * fallback as the last resort.
   */
  /**
   * Release a session's workspace when the session goes away.
   *
   * Policy: remove the directory only when nothing would be LOST by
   * removing it, and keep it otherwise.
   *
   * "Lost" means uncommitted changes specifically, not "has work". A
   * workspace whose work is committed is safe to remove because the
   * branch outlives the checkout and rematerialize can rebuild it: the
   * directory is a cache, the branch is the artifact. So this checks
   * changedPaths directly rather than status().clean, which is
   * deliberately stricter (it also counts unintegrated commits) and
   * would leave recoverable workspaces lying around forever.
   *
   * When there ARE uncommitted changes, the directory stays and we say
   * so. A leaked workspace is discoverable (deterministic root, provider
   * can enumerate it) and reclaimable later; work deleted because
   * somebody removed a session is not. Preferring the discoverable leak
   * is the whole trade.
   *
   * Never deletes the branch, for the same reason.
   */
  private async releaseWorkspace(
    workspace: PersistedWorkspace,
    sessionId?: string,
  ): Promise<void> {
    const provider = getWorkspaceProvider(workspace.provider);
    if (provider === undefined) {
      this.logger?.warn?.(
        `session workspace: no provider "${workspace.provider}" to release ${workspace.path}; leaving it in place`,
      );
      return;
    }
    // Everything from the count to the removal runs in one per-workspace
    // slot. Splitting them would leave a window where a join sees a live
    // workspace and this sees an empty one, and the join loses its
    // checkout mid-turn. Unlike leaveWorkspace, this runs on the
    // session-close path where the departing session may still be
    // registered, so it is excluded by name rather than by relying on
    // when its binding happens to be cleared.
    return this.enqueueKeyed(this.workspaceQueues, workspace.path, async () => {
      const others = this.liveSessionsIn(workspace.path, sessionId);
      if (others.length > 0) {
        this.logger?.info?.(
          `session workspace: keeping ${workspace.path} — ${others.length} live session(s) still in it`,
        );
        return;
      }
      await this.tearDownWorkspace(provider, workspace, sessionId);
    });
  }

  /**
   * Why the workspace's branch could not fast-forward into its source
   * right now, or undefined if it could.
   *
   * Read-only and best-effort. Used to warn a detaching co-tenant early;
   * the authoritative check still runs at landing time.
   */
  private async fastForwardBlocked(ws: PersistedWorkspace): Promise<string | undefined> {
    const branch = ws.vcs?.branch;
    if (branch === undefined) {
      return "the workspace has no branch to merge from";
    }
    const head = await execGit(["rev-parse", "HEAD"], ws.sourceCwd);
    if (!head.ok || head.out.trim().length === 0) {
      return undefined;
    }
    const ancestor = await execGit(
      ["merge-base", "--is-ancestor", head.out.trim(), branch],
      ws.sourceCwd,
    );
    if (ancestor.ok) {
      return undefined;
    }
    const current = await execGit(["rev-parse", "--abbrev-ref", "HEAD"], ws.sourceCwd);
    return (
      `${shortenHomePath(ws.sourceCwd)} has moved on since this workspace was created ` +
      `(it is on ${current.out.trim() || "an unknown branch"}). ` +
      `Land it by hand with: git -C ${ws.sourceCwd} merge ${branch}`
    );
  }

  /**
   * The teardown itself, once it is established that nobody is left.
   *
   * Split out only so the refcount check and this can share one
   * per-workspace slot without a hundred lines inside a closure.
   */
  private async tearDownWorkspace(
    provider: IsolationProvider,
    workspace: PersistedWorkspace,
    sessionId?: string,
  ): Promise<void> {
    const asWorkspace = {
      path: workspace.path,
      sourceCwd: workspace.sourceCwd,
      label: workspace.label,
      provider: workspace.provider,
      ...(workspace.snapshot !== undefined
        ? { snapshot: asSnapshotId(workspace.snapshot) }
        : {}),
      ...(workspace.vcs !== undefined ? { vcs: workspace.vcs } : {}),
    };

    // Run the repo's teardown BEFORE touching the directory: setup may
    // have created state outside it (a database, a container, a volume)
    // and deleting a directory does not undo any of that. Runs even when
    // the directory is ultimately kept, since the session owning that
    // state is going away either way.
    const repoConfig = await readWorkspaceRepoConfig(workspace.sourceCwd).catch(
      (): WorkspaceRepoConfig => ({}),
    );
    if (repoConfig.preRemove !== undefined) {
      const hook = await runWorkspaceHook(repoConfig.preRemove, {
        workspacePath: workspace.path,
        sourceCwd: workspace.sourceCwd,
        label: workspace.label,
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(repoConfig.hookTimeoutSeconds !== undefined
          ? { timeoutSeconds: repoConfig.hookTimeoutSeconds }
          : {}),
      });
      if (!hook.ok) {
        this.logger?.warn?.(
          `session workspace: preRemove failed for ${workspace.path}: ${hook.reason ?? "unknown"}`,
        );
      }
    }

    // Drop every anchor regardless of what happens to the directory.
    // Each is a GC root, so leaving one behind pins its objects forever
    // and `git gc` can never reclaim them: the repository would grow
    // without bound across sessions. The autosave is the per-turn
    // snapshot; the start ref and landing baseline exist only to measure
    // the source's divergence at landing time, so a workspace that is
    // going away leaves all three with no reader.
    for (const ref of allAnchorRefs(workspace.label)) {
      await provider.dropSnapshotRef(asWorkspace, ref).catch(() => undefined);
    }

    const status = await provider
      .status(asWorkspace)
      .catch(() => ({ clean: false, changedPaths: ["<unknown>"], hasRecordedWork: false }));
    if (status.changedPaths.length > 0) {
      this.logger?.warn?.(
        `session workspace: keeping ${workspace.path} — it has ${status.changedPaths.length} ` +
          `uncommitted change(s) that removal would destroy. Remove it by hand once you have ` +
          `salvaged or discarded them.`,
      );
      return;
    }

    // Force here is safe and necessary: we just established there is
    // nothing uncommitted, and the provider's own non-forced guard is
    // stricter than this policy (it also refuses on committed work,
    // which the branch preserves).
    await provider
      .removeWorkspace(asWorkspace, { force: true })
      .catch((err: unknown) =>
        this.logger?.warn?.(
          `session workspace: could not remove ${workspace.path}: ${String(err)}`,
        ),
      );
  }

  /**
   * Build the workspace a fork of an isolated session should run in.
   *
   * A fork MUST NOT inherit its parent's cwd when that cwd is a
   * workspace: two sessions would then be editing one checkout, which is
   * the failure isolation exists to prevent, reached by inheritance
   * rather than by anyone choosing it. That makes this a property of the
   * PARENT session, not of whichever client issued the fork, so it can't
   * be left to callers to remember.
   *
   * Content comes from the parent's workspace so in-progress work carries
   * into the fork, which is what "fork this session" means. How that is
   * achieved is a provider capability: git snapshots the parent's working
   * state (including untracked files) and branches from it; a provider
   * without snapshots copies the parent's directory instead. Either way
   * the fork records the original PROJECT as its origin, never the
   * parent workspace, which is itself temporary.
   *
   * Returns undefined if no isolated workspace could be made. Callers
   * must then fall back to the parent's SOURCE tree, never its workspace.
   */
  /**
   * Ref a session's workspace snapshots live under.
   *
   * Deliberately outside refs/heads/: a ref here is a GC root, so the
   * snapshot is durable, but it does NOT appear in `git branch`, default
   * `git log`, or most UIs. That is what lets us autosave on every turn
   * without filling the user's history with noise. The cost is that
   * these refs pin objects forever, so whoever writes one owns deleting
   * it (releaseWorkspace does).
   */
  private snapshotRefFor(label: string): string {
    return workspaceAnchorRefs(label).autosave;
  }

  /**
   * The source tree's state at the moment `start` isolated the session.
   *
   * Deliberately a DIFFERENT ref from snapshotRefFor, which is the
   * per-turn workspace autosave. They were the same name once, and the
   * autosave overwrote this on the first turn inside the workspace — so
   * by landing time the "state of the source at start" was actually the
   * state of the WORKSPACE, and the replay diff came out as the inverse
   * of the agent's own work. `git apply --3way` rejected it, which is
   * the only reason it did not silently revert the session's changes.
   *
   * Two writers, two lifetimes, two names: this one is written once and
   * never churns; the autosave churns every turn.
   */
  private startRefFor(label: string): string {
    return workspaceAnchorRefs(label).start;
  }

  /**
   * How the source tree was left by the most recent successful landing.
   *
   * Preferred over startRefFor when measuring the source's divergence,
   * and the reason is a bug this fixes: `merge` lands the workspace's
   * work into the source and stays put, so a later `stop` found that work
   * sitting in the source, diffed it against the state at `start`, and
   * reported the workspace's OWN changes as the user's overlapping
   * edits. Landed content is not divergence. Re-baselining after each
   * landing is what makes a second landing a no-op instead of a warning.
   *
   * Named `baseline`, not `landed`, to stay clearly distinct from
   * `refs/hydra/landing/<id>`, which is the recovery copy held only while
   * a replay might still fail.
   */
  private baselineRefFor(label: string): string {
    return workspaceAnchorRefs(label).baseline;
  }

  /**
   * Snapshot an isolated session's workspace, at most one at a time and
   * never on the turn's critical path.
   *
   * Skips when nothing changed, because the common turn edits no files
   * (a question, a read-only exploration) and a no-op snapshot would
   * still cost a full tree walk. On a large repository that walk is not
   * free, which is also why this coalesces rather than queues: if turns
   * arrive faster than snapshots complete, taking the latest state once
   * is both cheaper and more useful than replaying a backlog.
   */
  private scheduleWorkspaceSnapshot(session: Session): void {
    if (session.workspace === undefined || this.workspaceSnapshotsDisabled) {
      return;
    }
    if (this.snapshotInFlight.has(session.sessionId)) {
      this.snapshotPending.add(session.sessionId);
      return;
    }
    this.snapshotInFlight.add(session.sessionId);
    void this.runWorkspaceSnapshot(session)
      .catch(() => undefined)
      .finally(() => {
        this.snapshotInFlight.delete(session.sessionId);
        if (this.snapshotPending.delete(session.sessionId)) {
          this.scheduleWorkspaceSnapshot(session);
        }
      });
  }

  private async runWorkspaceSnapshot(session: Session): Promise<void> {
    const workspace = session.workspace;
    if (workspace === undefined) {
      return;
    }
    const provider = getWorkspaceProvider(workspace.provider);
    if (provider === undefined || !provider.capabilities().supports.captureWorkingState) {
      return;
    }
    const asWorkspace = {
      path: workspace.path,
      sourceCwd: workspace.sourceCwd,
      label: workspace.label,
      provider: workspace.provider,
      ...(workspace.snapshot !== undefined
        ? { snapshot: asSnapshotId(workspace.snapshot) }
        : {}),
      ...(workspace.vcs !== undefined ? { vcs: workspace.vcs } : {}),
    };

    const status = await provider.status(asWorkspace).catch(() => undefined);
    if (status !== undefined && status.changedPaths.length === 0) {
      return;
    }

    const snapshot = await provider.captureWorkingState(
      workspace.path,
      `hydra: autosave ${session.sessionId}`,
    );
    await provider.retainSnapshot(
      asWorkspace,
      this.snapshotRefFor(workspace.label),
      snapshot,
    );
  }

  /**
   * `/hydra workspace <verb>` — move a live session into an isolated
   * workspace, or back out of one.
   *
   * Why mid-session rather than only at creation: the moment you know
   * you need isolation is usually partway through, when a plan turns
   * into edits that will collide with other work. Requiring the decision
   * up front means either isolating sessions that never needed it, or
   * discovering too late that you are in the wrong tree.
   */
  async runWorkspaceAction(
    sessionId: string,
    action: "start" | "merge" | "stop" | "detach" | "discard" | "status",
    name?: string,
  ): Promise<string> {
    const session = this.get(sessionId);
    if (session === undefined) {
      throw new Error("session is not live");
    }
    if (action === "status") {
      const ws = session.workspace;
      if (ws === undefined) {
        return `Not isolated. Working directly in ${shortenHomePath(session.cwd)}.\nUse \`/hydra workspace start\` to move into an isolated workspace.`;
      }
      const others = this.liveSessionsIn(ws.path, session.sessionId).map((s) =>
        stripHydraSessionPrefix(s.sessionId),
      );
      const lines = [
        `Isolated in ${shortenHomePath(ws.path)}`,
        `  source:   ${shortenHomePath(ws.sourceCwd)}`,
        `  provider: ${ws.provider}${ws.vcs?.branch !== undefined ? ` (${ws.vcs.branch})` : ""}`,
      ];
      if (others.length > 0) {
        lines.push(`  shared with: ${others.join(", ")}`);
      }
      // The exits mean different things once the workspace is shared, so
      // the hint cannot be a constant. With a co-tenant still in here
      // `stop` degrades to `detach`: your edits are already in a tree you
      // do not solely own and nothing can un-write them, so what happens
      // to the work is settled by whoever leaves last.
      lines.push(
        others.length > 0
          ? `\`stop\` behaves as \`detach\` while ${others.length === 1 ? "that session is" : "those sessions are"} still here; the work lands when the last one leaves.`
          : `Use \`/hydra workspace stop\` to merge and return, \`discard\` to throw the work away, or \`detach\` to return and leave it here.`,
      );
      return lines.join("\n");
    }
    if (action === "start") {
      return this.startWorkspace(session, name);
    }
    const ws = session.workspace;
    if (ws === undefined) {
      throw new Error(
        `this session is not in a workspace. Use \`/hydra workspace start\` first.`,
      );
    }
    if (action === "merge") {
      session.broadcastWorkspacePhase({ phase: "landing" });
      let landed: { merged: string; warnings: string[] };
      try {
        landed = await this.mergeWorkspaceIntoSource(ws, session.sessionId);
      } catch (err) {
        const base = err instanceof Error ? err.message : String(err);
        session.broadcastWorkspacePhase({ phase: "failed", error: base });
        throw err;
      }
      // Staying put, so clear the indicator rather than leaving it lit.
      session.broadcastWorkspacePhase({
        phase: "entered",
        cwd: session.cwd,
        sourceCwd: ws.sourceCwd,
        label: ws.label,
      });
      return [
        `${landed.merged}; still working in ${shortenHomePath(ws.path)}.`,
        ...landed.warnings,
      ].join("\n");
    }
    if (action === "stop") {
      // Shared workspace: `stop` degrades to `detach`.
      //
      // You cannot finish a shared thing by yourself. `stop` is about
      // this session's relationship to the workspace; the merge is about
      // the workspace's relationship to the source, and those are only
      // fused because they have always coincided. Landing now would
      // commit whatever a still-working co-tenant has half-written onto
      // this branch and into the source, so the merge waits until the
      // tree has no live writer left — which is the last departure.
      const others = this.liveSessionsIn(ws.path, session.sessionId);
      if (others.length > 0) {
        session.broadcastWorkspacePhase({ phase: "returning" });
        await this.leaveWorkspace(session, ws, { exit: "detached" });
        const who = others.map((s) => stripHydraSessionPrefix(s.sessionId)).join(", ");
        const lines = [
          `Left ${shortenHomePath(ws.path)} and returned to ${shortenHomePath(ws.sourceCwd)}.`,
          `Nothing landed yet: ${who} still working there. It lands when the last session leaves.`,
        ];
        // Worth checking now rather than letting it surface to whoever
        // leaves last: a doomed fast-forward is much more actionable to
        // the person who caused it than to the person who happens to be
        // holding the workspace an hour later.
        const blocked = await this.fastForwardBlocked(ws);
        if (blocked !== undefined) {
          lines.push(`WARNING: that merge will not fast-forward as things stand — ${blocked}`);
        }
        return lines.join("\n");
      }
      // Merge BEFORE leaving. If it refuses, the session stays put:
      // returning to the source tree with the work stranded behind is
      // the one outcome that would surprise, since `stop` reads as
      // "finish this", not "walk away from it".
      // Progress phases, matching what `start` reports. The merge walks
      // two trees and the swap respawns an agent, so an `stop` on a real
      // repository is long enough that silence reads as a hang.
      session.broadcastWorkspacePhase({ phase: "landing" });
      let landed: { merged: string; warnings: string[] };
      try {
        landed = await this.mergeWorkspaceIntoSource(ws, session.sessionId);
      } catch (err) {
        const base = err instanceof Error ? err.message : String(err);
        session.broadcastWorkspacePhase({ phase: "failed", error: base });
        throw err;
      }
      // One message, at the end. The merge used to be streamed here
      // because the swap that follows announced itself, and a command's
      // result text waits for the turn to end — so returning the merge
      // text printed the landing AFTER the "returned" line it caused.
      // The swap is silent now, so the ordering problem is gone and the
      // whole outcome can be stated once, in the order it happened.
      session.broadcastWorkspacePhase({ phase: "returning" });
      try {
        await this.leaveWorkspace(session, ws, { exit: "landed" });
      } catch (err) {
        // The merge already succeeded. Losing that fact behind a swap
        // failure would leave the user thinking the work is still only
        // in a workspace they are being told they could not leave.
        const base = err instanceof Error ? err.message : String(err);
        throw new Error(
          `${landed.merged}, but the session could not leave the workspace: ${base}`,
        );
      }
      return [
        `${landed.merged} and returned there; workspace removed.`,
        ...landed.warnings,
      ].join("\n");
    }
    if (action === "discard") {
      // The counterpart of `stop`: leave, and throw the work away.
      // Without it the only route to "I don't want this" was `detach`
      // followed by `hydra workspace remove` from a shell, which is two
      // commands in two places for one intention.
      //
      // Refused on a shared workspace rather than degraded. The refcount
      // would keep the directory alive for the co-tenant, so nothing
      // would actually be discarded while this said otherwise.
      const others = this.liveSessionsIn(ws.path, session.sessionId);
      if (others.length > 0) {
        throw new Error(
          `${shortenHomePath(ws.path)} is shared with ${others
            .map((s) => stripHydraSessionPrefix(s.sessionId))
            .join(", ")}, so its work is not yours alone to discard. ` +
            `Use \`/hydra workspace detach\` to leave it to them.`,
        );
      }
      session.broadcastWorkspacePhase({ phase: "returning" });
      await this.leaveWorkspace(session, ws, { exit: "discarded" });
      const retired = await this.retireAutosave(ws);
      const lines = [
        `Discarded ${shortenHomePath(ws.path)} and its branch ${ws.vcs?.branch ?? "(none)"}; ` +
          `returned to ${shortenHomePath(ws.sourceCwd)}.`,
      ];
      if (retired !== undefined) {
        lines.push(
          `The last autosave is kept at ${retired} if you want it back: ` +
            `git -C ${ws.sourceCwd} checkout ${retired}`,
        );
      }
      return lines.join("\n");
    }
    // detach: step away and leave the workspace running, the least
    // destructive exit there is.
    session.broadcastWorkspacePhase({ phase: "returning" });
    await this.leaveWorkspace(session, ws, { exit: "detached" });
    return [
      `Returned to ${shortenHomePath(ws.sourceCwd)} WITHOUT merging.`,
      `The workspace is still at ${shortenHomePath(ws.path)} and its branch ` +
        `${ws.vcs?.branch ?? "(none)"} is intact, so nothing is lost — land it later with ` +
        `\`hydra workspace merge\`, or drop it with \`/hydra workspace discard\`.`,
    ].join("\n");
  }

  /**
   * Move a surviving autosave out of the live namespace, returning its
   * new name.
   *
   * Called when a snapshot outlives its workspace. Left where it is, the
   * next workspace to take that label overwrites it on its first turn:
   * the recovery command printed here would then resolve to a DIFFERENT
   * workspace's content, and one reflog would cover two unrelated lines
   * of work. A label is only unique among things that exist right now, so
   * anything meant to outlive its workspace needs a name that does too.
   *
   * Deleting the live ref also clears its reflog, so the next workspace of
   * that name starts with a clean history rather than inheriting one.
   */
  private async retireAutosave(ws: PersistedWorkspace): Promise<string | undefined> {
    const repoRoot = ws.vcs?.repoRoot ?? ws.sourceCwd;
    const live = this.snapshotRefFor(ws.label);
    const found = await execGit(["rev-parse", "--verify", "--quiet", live], repoRoot);
    const sha = found.out.trim();
    if (!found.ok || sha.length === 0) {
      return undefined;
    }
    const retired = retiredSnapshotRef(ws.label, sha);
    const written = await execGit(["update-ref", retired, sha], repoRoot);
    if (!written.ok) {
      // Keep the live ref rather than dropping the only copy.
      return live;
    }
    await execGit(["update-ref", "-d", live], repoRoot);
    return retired;
  }

  /**
   * Fast-forward the source onto the workspace's branch and replay
   * whatever the workspace had left uncommitted.
   *
   * Every check runs BEFORE anything is written, so a merge that cannot
   * land is a no-op rather than something that half-happened. Shared by
   * `merge` (stay) and `stop` (leave), which must behave identically at
   * the point of landing.
   *
   * The round trip is meant to be faithful: what was committed comes
   * back committed, what was uncommitted comes back uncommitted. `start`
   * copied the user's WIP in without asking, so `stop` must not hand it
   * back in a form they did not choose — least of all as a commit that
   * turns their untracked files into tracked ones.
   */
  /**
   * Returns the outcome in parts rather than as a finished sentence, so
   * each caller can say what it did in ONE line. `stop` merges and then
   * leaves; `merge` stays put. Handing them a pre-punctuated "Merged X
   * into Y." forced them to append a second sentence about the same
   * action, which is how one command came to print three lines.
   */
  private async mergeWorkspaceIntoSource(
    ws: PersistedWorkspace,
    sessionId: string,
  ): Promise<{ merged: string; warnings: string[] }> {
    const source = ws.sourceCwd;
    const branch = ws.vcs?.branch;
    if (branch === undefined) {
      throw new Error(`workspace ${ws.label} has no branch to merge from`);
    }
    const exists = await this.dirExists(source);
    if (!exists) {
      throw new Error(`source tree ${shortenHomePath(source)} no longer exists`);
    }
    // A dirty source is the NORMAL case: `start` copied the work in
    // rather than taking it, so the same edits are expected to still be
    // sitting here. Capture that state rather than gating on it. Once
    // it is captured the reset below cannot lose anything, which turns
    // "has the source diverged?" from a question that has to be
    // answered before proceeding into one that answers itself at the
    // end — and only fails when two edits genuinely overlap.
    const provider = getWorkspaceProvider(ws.provider);
    const capture = await captureSourceForLanding({
      source,
      // The START ref. Using the per-turn autosave ref here was the bug:
      // it holds WORKSPACE state, so the replay diff came out as the
      // inverse of the agent's work rather than as the source's
      // divergence.
      // Label-keyed first, then the session-keyed name a workspace
      // created before the re-key still carries. Absent refs resolve to
      // nothing and fall through, so offering both is free.
      startSnapshotRef: this.startRefFor(ws.label),
      // Wins over the start ref once a first landing has run, so work
      // this workspace already put into the source stops counting as the
      // user's divergence on every landing after it.
      baselineRef: this.baselineRefFor(ws.label),
      retainRef: landingRetainRef(sessionId),
      provider,
    });

    const sourceHead = (await execGit(["rev-parse", "HEAD"], source)).out.trim();
    const canFf = await execGit(["merge-base", "--is-ancestor", sourceHead, branch], source);
    if (!canFf.ok) {
      const current = (await execGit(["rev-parse", "--abbrev-ref", "HEAD"], source)).out.trim();
      throw new Error(
        // Prose gets the short path; the command keeps the absolute one,
        // so it stays paste-able outside a shell that expands `~`.
        `cannot fast-forward ${current} in ${shortenHomePath(source)} to ${branch}. ` +
          `The source has moved on. ` +
          `Nothing was changed; merge it yourself with: git -C ${source} merge ${branch}`,
      );
    }

    // Capture what the workspace has NOT committed, but do not commit it.
    // Work the agent chose to commit should arrive as commits; work it
    // left uncommitted — including the user's own WIP that was copied in
    // — should arrive as uncommitted changes. Synthesizing a commit for
    // the latter hands back something the user never chose to create,
    // and quietly promotes their untracked files to tracked ones.
    let pending: SnapshotId | undefined;
    const outstanding = await execGit(["status", "--porcelain", "-uall"], ws.path);
    if (outstanding.ok && outstanding.out.trim().length > 0 && provider !== undefined) {
      pending = await provider
        .captureWorkingState(ws.path, `hydra: uncommitted work in ${ws.label}`)
        .catch(() => undefined);
      if (pending === undefined) {
        throw new Error(
          `could not capture the uncommitted work in ${shortenHomePath(ws.path)}; nothing was changed`,
        );
      }
    }

    // Every check that could refuse has now run, and both trees are
    // captured. First write happens here.
    if (!capture.clean) {
      const reset = await execGit(["reset", "--hard", "HEAD"], source);
      const cleaned = await execGit(["clean", "-fd"], source);
      if (!reset.ok || !cleaned.ok) {
        throw new Error(
          `could not clear ${shortenHomePath(source)} for the merge; your work is preserved ` +
            `at ${capture.retainedRef}. Nothing was merged.`,
        );
      }
    }

    const merged = await execGit(["merge", "--ff-only", branch], source);
    if (!merged.ok) {
      throw new Error(`merge failed: ${merged.err.trim() || "unknown error"}`);
    }

    // Replay the uncommitted remainder on top, as uncommitted changes.
    // Applied without --index so modifications land unstaged and new
    // files land untracked, which is the shape they had in the
    // workspace.
    let replayed = true;
    if (pending !== undefined) {
      const tip = (await execGit(["rev-parse", "HEAD"], source)).out.trim();
      const patch = await execGit(["diff", "--binary", tip, pending], source);
      if (patch.ok && patch.out.trim().length > 0) {
        replayed = (await execGitStdin(["apply"], source, patch.out)).ok;
      }
    }

    // Then whatever the source had that the workspace never saw. Empty
    // unless the user kept editing after isolating.
    const divergenceOk = await replaySourceDivergence({ source, capture });
    if (divergenceOk) {
      await releaseSourceCapture({ source, capture });
    }

    // Re-baseline: record how this landing left the source, so the NEXT
    // one measures divergence from here instead of from `start`. Written
    // even when a replay failed, because the question it answers is
    // "what is in the source now", and the answer is this tree either
    // way. What did not make it in is still held by the retained
    // landing ref.
    //
    // Best-effort: a failure here costs a stale warning on the next
    // landing, which is not worth failing a landing that has already
    // succeeded over.
    if (provider !== undefined) {
      const after = await provider
        .captureWorkingState(source, `hydra: source state after landing ${ws.label}`)
        .catch(() => undefined);
      if (after !== undefined) {
        // Reflogged like the others: this one moves on every landing, so
        // its previous values are the record of where each landing left
        // the source.
        await execGit(
          ["update-ref", "--create-reflog", this.baselineRefFor(ws.label), after],
          source,
        );
      }
    }

    const warnings: string[] = [];
    if (!replayed) {
      warnings.push(
        `  WARNING: the workspace's uncommitted changes could not be replayed; ` +
          `they remain reachable from ${branch}.`,
      );
    }
    if (!divergenceOk) {
      warnings.push(
        `  WARNING: your own edits to ${shortenHomePath(source)} overlap the workspace's ` +
          `changes and could not be replayed on top. They are preserved at ` +
          `${capture.retainedRef} — recover with: git -C ${source} diff ${capture.base} ${capture.retainedRef}`,
      );
    }
    return { merged: `Merged ${branch} into ${shortenHomePath(source)}`, warnings };
  }


  /**
   * Swap the session back to its source tree and drop the binding.
   *
   * The three exits differ only in what they leave behind, and each
   * choice follows from where the work is safe:
   *
   *   landed     → it is on the source branch, so the workspace and its
   *                refs are redundant. Remove everything.
   *   detached   → nothing was landed, so the directory, the branch and
   *                the autosave are the only copies. Keep all of them
   *                and say where they are.
   *   discarded  → the work is being thrown away ON PURPOSE, so the
   *                directory and the branch go — but the autosave stays.
   *                A slash command has nowhere to put a confirmation
   *                prompt, so the ref is the confirmation: destructive,
   *                and still recoverable for as long as gc allows.
   */
  private async leaveWorkspace(
    session: Session,
    ws: PersistedWorkspace,
    opts: { exit: "landed" | "detached" | "discarded" },
  ): Promise<void> {
    // Both of these ask "is the directory about to disappear", which is
    // the only distinction the swap notice and the `left` phase care
    // about. Discarding and landing look identical from there.
    const removing = opts.exit !== "detached";
    const provider = getWorkspaceProvider(ws.provider);
    const asWorkspace = {
      path: ws.path,
      sourceCwd: ws.sourceCwd,
      label: ws.label,
      provider: ws.provider,
      ...(ws.snapshot !== undefined ? { snapshot: asSnapshotId(ws.snapshot) } : {}),
      ...(ws.vcs !== undefined ? { vcs: ws.vcs } : {}),
    };

    const history = await this.histories.load(session.sessionId).catch(() => []);
    await session.swapIntoWorkspace({
      cwd: ws.sourceCwd,
      workspace: undefined,
      historyLength: history.length,
      artifact: {
        summary:
          `Returned to the source tree at ${ws.sourceCwd}` +
          (opts.exit === "landed"
            ? " after merging the workspace."
            : opts.exit === "discarded"
              ? " after discarding the workspace and its work."
              : " without merging."),
      } as SessionSynopsis,
      // `removed` is the difference between a stale path that fails
      // loudly and one that silently absorbs work. `stop` and `discard`
      // delete the workspace; `detach` keeps it, which is the dangerous
      // case.
      left: { path: ws.path, removed: removing },
    });

    // Clear cwd and the binding in one write. Two writes could strand a
    // record claiming isolation while sitting in the source tree.
    await this.mutateRecord(
      session.sessionId,
      { cwd: session.cwd },
      ["workspace"],
    );
    this.invalidateListCache();

    // The return trip needs announcing for the same reason the outbound
    // one does: a client still pointed at the workspace would be
    // resolving paths inside a directory that is about to be removed.
    session.broadcastWorkspacePhase({
      phase: "left",
      cwd: session.cwd,
      sourceCwd: ws.sourceCwd,
      integrated: opts.exit === "landed",
    });

    if (provider === undefined) {
      return;
    }
    // Anything below this point is about the WORKSPACE rather than about
    // this session, so a co-tenant still working in it gets to keep it.
    // The lock in particular: it is a presence marker with a single
    // reason string, so unlocking on the first departure would leave a
    // directory someone is still writing in open to `workspace remove`.
    // One slot from the count through the removal, so a join cannot slip
    // in between and lose its checkout.
    await this.enqueueKeyed(this.workspaceQueues, ws.path, async () => {
      const others = this.liveSessionsIn(ws.path, session.sessionId);
      if (others.length > 0) {
        this.logger?.info?.(
          `session workspace: ${session.sessionId} left ${ws.path}; ` +
            `${others.length} live session(s) remain, so it stays`,
        );
        return;
      }
      await this.reclaimAfterLastLeaver(provider, asWorkspace, ws, session.sessionId, opts);
    });
  }

  /**
   * Drop a workspace's refs, lock and directory once its last session has
   * gone. Split from leaveWorkspace only to keep the per-workspace slot's
   * closure readable.
   */
  private async reclaimAfterLastLeaver(
    provider: IsolationProvider,
    asWorkspace: Workspace,
    ws: PersistedWorkspace,
    sessionId: string,
    opts: { exit: "landed" | "detached" | "discarded" },
  ): Promise<void> {
    await provider.unlock(asWorkspace).catch(() => undefined);
    // The start and baseline refs go on EVERY exit, unlike the autosave.
    // They are baselines for landing, not copies of anything: the source
    // kept its own work when `start` copied it, so nothing here is the
    // last copy of the user's edits, and only the next landing would read
    // them. Leaving them behind pins objects for a session that will not
    // have another landing.
    for (const ref of [this.startRefFor(ws.label), this.baselineRefFor(ws.label)]) {
      await provider.dropSnapshotRef(asWorkspace, ref).catch(() => undefined);
    }
    if (opts.exit === "detached") {
      return;
    }
    // The autosave is the one ref whose fate differs. After a landing it
    // is redundant, because the work is on the source branch. After a
    // DISCARD it is the only surviving copy of what was just thrown
    // away, and keeping it is what makes an unprompted destructive verb
    // survivable.
    if (opts.exit === "landed") {
      await provider
        .dropSnapshotRef(asWorkspace, this.snapshotRefFor(ws.label))
        .catch(() => undefined);
    }
    // Discard the line too. Safe on a landing because the work is in the
    // source; intended on a discard because throwing the line away is
    // the point. Keeping it would also squat on the label, so a session
    // that finishes one workspace and starts another would collide with
    // its own leftover branch.
    //
    // `detach` deliberately does not reach this code: there the line is
    // the only record of unmerged work.
    await provider
      .removeWorkspace(asWorkspace, { force: true, discardLine: true })
      .catch(() => undefined);
  }

  /**
   * Why this session must not join that workspace, or undefined if it may.
   *
   * Compares working TREES rather than asking whether either is dirty.
   * Both worktrees share one object store, so a tree written from either
   * is comparable from the source repo, and equal trees mean the join
   * changes no content anywhere.
   *
   * Costs two working-tree walks and leaves two unreferenced commit
   * objects behind (gc reclaims them). Paid once per join attempt, which
   * is the same price an autosave pays every turn.
   */
  private async joinDivergence(
    provider: IsolationProvider,
    sourceCwd: string,
    ws: PersistedWorkspace,
  ): Promise<string | undefined> {
    const [sourceState, wsState] = await Promise.all([
      provider
        .captureWorkingState(sourceCwd, "hydra: source state at join")
        .catch(() => undefined),
      provider.captureWorkingState(ws.path, "hydra: workspace state at join").catch(() => undefined),
    ]);
    if (sourceState === undefined || wsState === undefined) {
      // Could not look. Fall back to the conservative answer rather than
      // guessing that they agree.
      return (
        `could not compare ${shortenHomePath(sourceCwd)} with ${shortenHomePath(ws.path)}, ` +
        `so refusing to join a workspace that may not match your tree`
      );
    }
    const trees = await Promise.all(
      [sourceState, wsState].map(async (sha) =>
        (await execGit(["rev-parse", `${sha}^{tree}`], sourceCwd)).out.trim(),
      ),
    );
    if (trees[0]!.length > 0 && trees[0] === trees[1]) {
      return undefined;
    }
    return (
      `${shortenHomePath(sourceCwd)} and ${shortenHomePath(ws.path)} have diverged, and joining ` +
      `does not carry work across — whichever side you are not in would be left behind. ` +
      `Land or stash one of them first: \`git -C ${sourceCwd} stash\` if the difference is yours, ` +
      `or \`/hydra workspace merge\` from the session already in there if it is theirs.`
    );
  }

  /**
   * Live sessions a request for `label` should join.
   *
   * Matches the label a session ASKED FOR as well as the one it got.
   * They differ whenever the name was already taken by a surviving
   * branch: asking for `stuff` with `hydra/stuff` still around lands you
   * in `stuff-2`, and a second session then asking for `stuff` would find
   * nothing live under that name and provision `stuff-3` — two sessions
   * that both asked to share, in two separate workspaces. Comparing the
   * request fixes that without inferring anything from the `-N` spelling,
   * which a user is entitled to type deliberately.
   */
  private liveSessionsWithLabel(sourceCwd: string, label: string): Session[] {
    const out: Session[] = [];
    for (const s of this.sessions.values()) {
      const ws = s.workspace;
      if (ws === undefined || ws.sourceCwd !== sourceCwd) {
        continue;
      }
      if (ws.label === label || ws.requestedLabel === label) {
        out.push(s);
      }
    }
    return out;
  }

  /**
   * Seat this session in a workspace another live session is already in.
   *
   * Two agents in one checkout is not what isolation prevents: two
   * non-isolated sessions in one source tree already race that way, and
   * always have. What isolation protects is the USER's tree, and that
   * protection is unaffected here. So co-tenancy is a risk to accept
   * rather than a mistake to block — but only when it is chosen, which is
   * what naming an occupied label does.
   *
   * Provisions nothing. The directory, the branch and the landing anchor
   * all exist already, and the anchor is why they had to stop being keyed
   * by session id: the eventual merge measures divergence from where the
   * source stood when the WORK began, not from whenever the last joiner
   * happened to arrive.
   *
   * Refuses on a dirty source, unlike `start`. A fresh workspace carries
   * your uncommitted work in and resets the source behind it; neither
   * half is safe here. Dropping a third-party diff into a tree another
   * agent is mid-edit in can clobber their work, and resetting the source
   * would be resetting a tree that is not this session's to reset.
   */
  private async joinWorkspace(
    session: Session,
    host: Session,
    ws: PersistedWorkspace,
    sourceCwd: string,
  ): Promise<string> {
    const provider = getWorkspaceProvider(ws.provider);
    if (provider === undefined) {
      throw new Error(`no provider "${ws.provider}" to join that workspace with`);
    }
    // A dirty source is the NORMAL case for a joiner, not an edge case:
    // `start` COPIES the uncommitted work in rather than moving it, so
    // the tree the first session left behind is still dirty with exactly
    // what it carried across. Refusing on dirtiness alone would reject
    // the most ordinary join there is.
    //
    // What actually matters is whether the two trees agree. If they do,
    // the join carries no risk at all, because there is nothing to carry:
    // the workspace already contains precisely what the source has. If
    // they have diverged, joining would silently leave one side's edits
    // behind, and that is worth refusing.
    if (provider.capabilities().supports.captureWorkingState) {
      const diverged = await this.joinDivergence(provider, sourceCwd, ws);
      if (diverged !== undefined) {
        throw new Error(diverged);
      }
    }

    // Serialized against teardown. Without this the last leaver can count
    // zero live sessions, and remove the directory while this join is
    // mid-swap into it.
    return await this.enqueueKeyed(this.workspaceQueues, ws.path, async () => {
      if (this.sessions.get(host.sessionId)?.workspace?.path !== ws.path) {
        throw new Error(
          `${shortenHomePath(ws.path)} was released while joining it; run the command again`,
        );
      }
      session.broadcastWorkspacePhase({ phase: "swapping" });
      const history = await this.histories.load(session.sessionId).catch(() => []);
      await session.swapIntoWorkspace({
        cwd: ws.path,
        workspace: {
          path: ws.path,
          sourceCwd: ws.sourceCwd,
          label: ws.label,
          ...(ws.requestedLabel !== undefined ? { requestedLabel: ws.requestedLabel } : {}),
          provider: ws.provider,
          ...(ws.snapshot !== undefined ? { snapshot: ws.snapshot } : {}),
          ...(ws.vcs !== undefined ? { vcs: { ...ws.vcs } } : {}),
        },
        historyLength: history.length,
        artifact: {
          summary: `Continuing in an isolated workspace at ${ws.path}, derived from ${sourceCwd}, shared with another session.`,
        } as SessionSynopsis,
      });
      await this.mutateRecord(session.sessionId, {
        cwd: session.cwd,
        workspace: session.workspace,
      });
      this.invalidateListCache();
      session.broadcastWorkspacePhase({
        phase: "entered",
        cwd: session.cwd,
        sourceCwd: ws.sourceCwd,
        label: ws.label,
        ...(ws.vcs?.branch !== undefined ? { branch: ws.vcs.branch } : {}),
      });

      const sharers = this.liveSessionsIn(ws.path, session.sessionId).map((s) =>
        stripHydraSessionPrefix(s.sessionId),
      );
      const lines = [
        `Joined workspace ${shortenHomePath(ws.path)}`,
        `  source: ${shortenHomePath(ws.sourceCwd)}`,
      ];
      if (ws.vcs?.branch !== undefined) {
        lines.push(`  branch: ${ws.vcs.branch}`);
      }
      lines.push(`  shared with: ${sharers.join(", ")}`);
      lines.push(`  your edits will interleave with that session's`);
      lines.push(
        `Use \`/hydra workspace stop\` to leave; the work lands when the last session leaves.`,
      );
      return lines.join("\n");
    });
  }

  /**
   * Move a live session into a fresh isolated workspace.
   *
   * COPIES the session's uncommitted work rather than taking it, and
   * leaves the source tree exactly as it was found. The source is not
   * private to this session: the user's editor is open on it and other
   * sessions are working in it, so taking the work would mean the first
   * workspace to start silently claims it. The cost is that the same
   * edits then exist in two places, which is why landing captures and
   * replays the source rather than gating on it being clean.
   *
   * (This comment used to claim the opposite — that the work was moved
   * and the source reset. Nothing here resets the source; copyCarriedWork
   * applies a patch into the workspace and stops. The landing path is
   * built on the copy semantics, so the code was right and the comment
   * was wrong.)
   *
   * Snapshot-first regardless. `captureWorkingState` writes a commit
   * object and we point a ref at it BEFORE the workspace is populated, so
   * a crash in the middle leaves the pre-start state recoverable.
   */
  private async startWorkspace(session: Session, label?: string): Promise<string> {
    if (session.workspace !== undefined) {
      throw new Error(
        `already isolated in ${shortenHomePath(session.workspace.path)}. ` +
          `Use \`/hydra workspace stop\` to merge and return first, or \`detach\` to leave it behind.`,
      );
    }
    const sourceCwd = session.cwd;
    const provider = getWorkspaceProvider();
    if (provider === undefined) {
      throw new Error("no workspace provider available");
    }
    // Preconditions before provisioning, not after. The swap at the end
    // re-checks this, but by then the workspace exists and the user's
    // work has been moved into it — a refusal there is not a no-op, it
    // is a mess someone has to clean up.
    if (!(await session.isQuiescedForSwap())) {
      throw new Error(
        "the agent is still working — wait for the current turn to finish, then try again",
      );
    }
    const caps = provider.capabilities();

    // An explicit label naming a workspace somebody is LIVE in means
    // join it, not make a second one beside it. A bare `start` cannot
    // reach this: its default label is derived from the session id, so it
    // never collides. And a label whose branch or directory merely
    // survives, with nobody in it, still gets suffixed — that is the
    // start-after-abandon case, where adopting the work you just walked
    // away from would be the opposite of what you asked for.
    if (label !== undefined) {
      const host = this.liveSessionsWithLabel(sourceCwd, label)[0];
      if (host !== undefined && host.workspace !== undefined) {
        return await this.joinWorkspace(session, host, host.workspace, sourceCwd);
      }
    }

    // Snapshot the working tree first, while it is still intact.
    let carried: SnapshotId | undefined;
    if (caps.supports.captureWorkingState) {
      const status = await provider
        .status({ path: sourceCwd, sourceCwd, label: "source", provider: provider.kind })
        .catch(() => undefined);
      if (status !== undefined && status.changedPaths.length > 0) {
        carried = await provider
          .captureWorkingState(sourceCwd, `hydra: work carried into workspace`)
          .catch(() => undefined);
        if (carried === undefined) {
          throw new Error(
            "could not snapshot your uncommitted work, so refusing to move it. Commit or stash first.",
          );
        }
      }
    }

    session.broadcastWorkspacePhase({ phase: "provisioning" });
    const created = await provider.createWorkspace({
      sourceCwd,
      label: label ?? `s-${session.sessionId.slice(-8)}`,
    });
    if (!created.ok) {
      session.broadcastWorkspacePhase({ phase: "failed", error: created.reason });
      throw new Error(created.reason);
    }
    const ws = created.workspace;

    // Past this point every step changes state outside this function.
    // Any failure unwinds them in reverse — otherwise a late error
    // strands an orphan workspace holding work the source no longer has.
    // The START ref, not the autosave ref. Landing measures the source's
    // divergence against this, and the autosave would overwrite it on
    // the first turn in the workspace — leaving the landing to diff the
    // workspace against the source and compute the inverse of the
    // agent's own work.
    const startRef = this.startRefFor(ws.label);
    let setup: string | undefined;
    let copied = false;
    try {
      if (caps.locking) {
        await provider.lock(ws, `session ${session.sessionId}`).catch(() => undefined);
      }
      // Retain the pre-move snapshot under the session's own ref before
      // the source is reset. This is the recovery anchor for the window
      // where the work exists in neither place, so a failure to write it
      // aborts the move rather than being swallowed: without the ref,
      // a crash after the reset takes the work with it.
      if (carried !== undefined) {
        await provider.retainSnapshot(ws, startRef, carried);
      }

      // Setup runs the repo's own hooks, which the design doc's example
      // fills with dependency installs. Named separately because it is
      // the phase most likely to be the slow one.
      session.broadcastWorkspacePhase({ phase: "setup" });
      setup = await this.applyWorkspaceSetup(ws, session.sessionId);
      copied = carried !== undefined ? await this.copyCarriedWork(ws, carried, sourceCwd) : true;

      session.broadcastWorkspacePhase({ phase: "swapping" });
      const history = await this.histories.load(session.sessionId).catch(() => []);
      await session.swapIntoWorkspace({
        cwd: ws.path,
        workspace: {
          path: ws.path,
          sourceCwd: ws.sourceCwd,
          label: ws.label,
          // Only when it differs, so the field means "this was renamed"
          // rather than being noise on every record.
          ...(label !== undefined && label !== ws.label ? { requestedLabel: label } : {}),
          provider: ws.provider,
          ...(ws.snapshot !== undefined ? { snapshot: ws.snapshot } : {}),
          ...(ws.vcs !== undefined ? { vcs: { ...ws.vcs } } : {}),
        },
        historyLength: history.length,
        artifact: {
          summary: `Continuing in an isolated workspace at ${ws.path}, derived from ${sourceCwd}.`,
        } as SessionSynopsis,
      });
    } catch (err) {
      const note = await this.unwindStartWorkspace({
        provider,
        ws,
        startRef,
        carried,
      });
      const base = err instanceof Error ? err.message : String(err);
      session.broadcastWorkspacePhase({ phase: "failed", error: base });
      throw new Error(note === undefined ? base : `${base}\n${note}`);
    }

    // cwd and the binding are written together: a record claiming one
    // without the other is the inconsistency every consumer trips on.
    await this.mutateRecord(session.sessionId, {
      cwd: session.cwd,
      workspace: session.workspace,
    });
    this.invalidateListCache();

    // Announced only after the record is written, so a client acting on
    // the new cwd cannot outrun the state that justifies it.
    session.broadcastWorkspacePhase({
      phase: "entered",
      cwd: session.cwd,
      sourceCwd: ws.sourceCwd,
      label: ws.label,
      ...(ws.vcs?.branch !== undefined ? { branch: ws.vcs.branch } : {}),
    });

    // Paths shortened throughout: these lines are read, not copied, and
    // three absolute paths under ~ push the parts that differ off the
    // right of the screen.
    const lines = [`Moved into workspace ${shortenHomePath(ws.path)}`, `  source: ${shortenHomePath(sourceCwd)}`];
    if (ws.vcs?.branch !== undefined) {
      lines.push(`  branch: ${ws.vcs.branch}`);
    }
    if (label !== undefined && label !== ws.label) {
      lines.push(
        `  note: "${label}" was already taken by a surviving branch, so this is "${ws.label}"`,
      );
    }
    if (carried !== undefined) {
      lines.push(
        copied
          ? `  copied your uncommitted work in; the source tree is untouched`
          : `  WARNING: could not copy your uncommitted work; the workspace starts from HEAD`,
      );
    }
    if (setup !== undefined) {
      lines.push(`  ${setup}`);
    }
    lines.push(`Use \`/hydra workspace stop\` to merge back and return.`);
    return lines.join("\n");
  }

  /**
   * Reproduce the snapshotted work inside the workspace, leaving the
   * source tree exactly as it was found.
   *
   * Copy, not move. The source tree is not private to this session: the
   * user's editor is open on it, other sessions are working in it, and
   * crucially the NEXT `workspace start` snapshots whatever is there at
   * that moment. Taking the work would mean the first workspace to start
   * silently claims it and every later one begins from a different
   * baseline, decided by typing order and reported to nobody. For
   * competition siblings, which exist precisely to be identical at t=0,
   * that is not a surprise but a wrong answer.
   *
   * The duplicate this leaves behind is reconciled at `stop`, where the
   * source can be compared against this same snapshot and cleared only
   * once the content is provably preserved on the branch.
   */
  private async copyCarriedWork(
    ws: { path: string; sourceCwd: string; vcs?: Record<string, string> },
    snapshot: SnapshotId,
    sourceCwd: string,
  ): Promise<boolean> {
    const repoRoot = ws.vcs?.repoRoot ?? sourceCwd;
    const patch = await this.patchFromSnapshot(repoRoot, snapshot);
    if (patch === undefined) {
      return false;
    }
    // Applied WITHOUT --index, so the copy lands unstaged and new files
    // land untracked. Staging it would put the user's WIP in the index
    // the agent is about to commit from, and the agent's first bare
    // `git commit` would sweep it into a commit nobody asked for —
    // exactly the outcome `stop` goes to trouble to avoid.
    return (await execGitStdin(["apply"], ws.path, patch)).ok;
  }

  // The working-state snapshot as a patch against HEAD. Undefined when
  // there is nothing to move or the diff cannot be produced.
  private async patchFromSnapshot(
    repoRoot: string,
    snapshot: SnapshotId,
  ): Promise<string | undefined> {
    const head = await execGit(["rev-parse", "HEAD"], repoRoot);
    if (!head.ok) {
      return undefined;
    }
    const patch = await execGit(["diff", "--binary", head.out.trim(), snapshot], repoRoot);
    if (!patch.ok || patch.out.trim().length === 0) {
      return undefined;
    }
    return patch.out;
  }

  /**
   * Undo a partially-completed `workspace start`.
   *
   * Short because `start` copies: the source tree was never modified, so
   * there is nothing to put back and no window in which the work exists
   * only inside the workspace. Tearing down the provisioned side is the
   * whole job.
   */
  private async unwindStartWorkspace(opts: {
    provider: IsolationProvider;
    ws: Workspace;
    startRef: string;
    carried: SnapshotId | undefined;
  }): Promise<string | undefined> {
    const { provider, ws, startRef, carried } = opts;
    await provider.unlock(ws).catch(() => undefined);
    if (carried !== undefined) {
      await provider.dropSnapshotRef(ws, startRef).catch(() => undefined);
    }
    await provider.removeWorkspace(ws, { force: true }).catch(() => undefined);
    return undefined;
  }

  private async applyWorkspaceSetup(
    ws: { path: string; sourceCwd: string; label: string },
    sessionId: string,
  ): Promise<string | undefined> {
    const cfg = await readWorkspaceRepoConfig(ws.sourceCwd).catch(
      (): WorkspaceRepoConfig => ({}),
    );
    const notes: string[] = [];
    if (cfg.carry !== undefined && cfg.carry.length > 0) {
      const res = await applyCarry(ws.sourceCwd, ws.path, cfg.carry).catch(() => undefined);
      if (res !== undefined && res.copied.length > 0) {
        notes.push(`carried ${res.copied.length} config file(s)`);
      }
    }
    if (cfg.postCreate !== undefined) {
      const hook = await runWorkspaceHook(cfg.postCreate, {
        workspacePath: ws.path,
        sourceCwd: ws.sourceCwd,
        label: ws.label,
        sessionId,
        ...(cfg.hookTimeoutSeconds !== undefined
          ? { timeoutSeconds: cfg.hookTimeoutSeconds }
          : {}),
      });
      notes.push(hook.ok ? "ran postCreate" : `postCreate FAILED: ${hook.reason ?? "unknown"}`);
    }
    return notes.length > 0 ? notes.join("; ") : undefined;
  }

  private async deriveForkWorkspace(
    parent: PersistedWorkspace,
    label: string,
  ): Promise<PersistedWorkspace | undefined> {
    const provider = getWorkspaceProvider(parent.provider);
    if (provider === undefined) {
      return undefined;
    }
    const caps = provider.capabilities();

    // Base the fork on the parent's BRANCH TIP, then replay the parent's
    // uncommitted work on top as uncommitted changes.
    //
    // The tempting shortcut is to snapshot the parent and branch from
    // that commit, which is what this used to do. It quietly converts
    // whatever the parent had in progress into a commit authored
    // "hydra: fork of <label>", so the fork reports itself clean and a
    // later merge lands your work as machine-authored history. Matching
    // `/hydra workspace start` here means a fork looks exactly like its
    // parent did: same commits, same dirty files, same authorship story.
    const parentTip = caps.sharedHistory
      ? (await execGit(["rev-parse", "HEAD"], parent.path)).out.trim()
      : "";

    const created = await provider
      .createWorkspace({
        sourceCwd: parent.sourceCwd,
        label,
        ...(parentTip.length > 0
          ? { from: asSnapshotId(parentTip) }
          : { contentFrom: parent.path }),
      })
      .catch((err: unknown) => ({ ok: false as const, reason: String(err) }));
    if (!created.ok) {
      this.logger?.warn?.(
        `fork workspace: could not derive from ${parent.path}: ${created.reason}`,
      );
      return undefined;
    }
    const ws = created.workspace;

    // Replay the parent's in-progress edits into the fork, uncommitted.
    // Copy, not move: the parent keeps working, so it keeps its files.
    if (parentTip.length > 0 && caps.supports.captureWorkingState) {
      const snap = await provider
        .captureWorkingState(parent.path, `hydra: fork carry from ${parent.label}`)
        .catch(() => undefined);
      if (snap !== undefined && snap !== parentTip) {
        await this.copyUncommittedInto(parent.path, ws.path, parentTip, snap).catch(
          () => undefined,
        );
      }
    }

    return {
      path: ws.path,
      sourceCwd: ws.sourceCwd,
      label: ws.label,
      provider: ws.provider,
      ...(ws.snapshot !== undefined ? { snapshot: ws.snapshot } : {}),
      ...(ws.vcs !== undefined ? { vcs: { ...ws.vcs } } : {}),
    };
  }

  /**
   * Apply the delta between two commits into a workspace as uncommitted
   * changes. Used to replay in-progress work into a new workspace
   * without recording it as somebody's commit.
   */
  private async copyUncommittedInto(
    repoRoot: string,
    targetPath: string,
    fromCommit: string,
    toCommit: string,
  ): Promise<boolean> {
    const patch = await execGit(["diff", "--binary", fromCommit, toCommit], repoRoot);
    if (!patch.ok || patch.out.trim().length === 0) {
      return false;
    }
    const applied = await execGitStdin(["apply", "--index"], targetPath, patch.out);
    return applied.ok;
  }

  private async recoverWorkspace(
    workspace: PersistedWorkspace,
  ): Promise<PersistedWorkspace | undefined> {
    const provider = getWorkspaceProvider(workspace.provider);
    if (provider === undefined) {
      return undefined;
    }
    const asWorkspace = {
      path: workspace.path,
      sourceCwd: workspace.sourceCwd,
      label: workspace.label,
      provider: workspace.provider,
      ...(workspace.snapshot !== undefined
        ? { snapshot: asSnapshotId(workspace.snapshot) }
        : {}),
      ...(workspace.vcs !== undefined ? { vcs: workspace.vcs } : {}),
    };

    if (provider.capabilities().supports.rematerialize) {
      const restored = await provider
        .rematerialize(asWorkspace)
        .catch((err: unknown) => ({ ok: false as const, reason: String(err) }));
      if (restored.ok) {
        this.logger?.info?.(
          `session workspace: restored ${restored.workspace.path} from retained state`,
        );
        return { ...workspace, path: restored.workspace.path };
      }
      this.logger?.warn?.(`session workspace: could not restore: ${restored.reason}`);
    }

    if (!(await this.dirExists(workspace.sourceCwd))) {
      return undefined;
    }
    const fresh = await provider
      .createWorkspace({ sourceCwd: workspace.sourceCwd, label: `${workspace.label}-r` })
      .catch((err: unknown) => ({ ok: false as const, reason: String(err) }));
    if (fresh.ok) {
      this.logger?.warn?.(
        `session workspace: ${workspace.path} is gone and could not be restored; ` +
          `resurrecting in a fresh workspace ${fresh.workspace.path} from ${workspace.sourceCwd}. ` +
          `Uncommitted work from the old workspace is not recoverable.`,
      );
      return {
        path: fresh.workspace.path,
        sourceCwd: fresh.workspace.sourceCwd,
        label: fresh.workspace.label,
        provider: fresh.workspace.provider,
        ...(fresh.workspace.snapshot !== undefined
          ? { snapshot: fresh.workspace.snapshot }
          : {}),
        ...(fresh.workspace.vcs !== undefined ? { vcs: { ...fresh.workspace.vcs } } : {}),
      };
    }
    return undefined;
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
          clientCapabilities: HYDRA_CLIENT_CAPABILITIES,
          clientInfo: { name: "hydra", version: HYDRA_VERSION },
        },
      );
    } catch (err) {
      await agent.kill().catch(() => undefined);
      throw enrichAuthRequired(err, agent);
    }
    agent.authMethods = parseAuthMethods(initResult.authMethods);

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
      // RETIRED generations count as known too.
      //
      // Every swap — compaction, workspace enter, workspace leave, agent
      // switch — retires one upstream session and mints another, so a
      // single hydra session can burn through many. The agent remembers
      // all of them and session/list reports all of them. Matching only
      // on the CURRENT id therefore made every superseded generation look
      // brand new, and sync imported each as its own cold row: no
      // history, createdAt == updatedAt, cwd wherever that generation
      // happened to be spawned (a workspace path, for a workspace swap).
      // One session that had switched workspaces a few times produced six
      // phantoms.
      //
      // The trail needs no new state; appendUpstreamGeneration has been
      // recording it all along.
      for (const gen of rec.upstreamGenerations ?? []) {
        existing.add(`${gen.agentId}::${gen.upstreamSessionId}`);
      }
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
      // Tombstone check: a session the user explicitly deleted stays
      // gone unless the agent reports activity newer than what we
      // recorded at delete time, which we take as "user revived this
      // conversation in the agent" and resurrect.
      const tombstone = await this.tombstones
        .read(agentId, entry.sessionId)
        .catch(() => undefined);
      if (tombstone) {
        if (!shouldResurrectFromUpstream(tombstone, entry.updatedAt)) {
          skipped += 1;
          continue;
        }
        await this.tombstones
          .remove(agentId, entry.sessionId)
          .catch(() => undefined);
        this.logger?.info(
          `syncFromAgent: resurrecting tombstoned ${agentId}/${entry.sessionId} (upstream updatedAt advanced past ${tombstone.upstreamUpdatedAt ?? "<unset>"})`,
        );
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
    const seenCursors = new Set<string>();
    // Bound the loop to defend against a buggy agent; 100 pages × any
    // reasonable page size is well past anything sane. We also bail
    // immediately if the agent hands back a cursor we've already used,
    // since otherwise we'd burn the full 100-page cap re-fetching the
    // same page.
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
      if (seenCursors.has(result.nextCursor)) {
        break;
      }
      seenCursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    return out;
  }

  // Issue session/set_model for a seed model (defaultModels / --model) at
  // bootstrap, logging success or a non-fatal rejection. `where` is the
  // human-readable provenance string used in log lines. A bad id in config
  // shouldn't break session creation, so a rejection is swallowed.
  private async applySeedModel(
    agent: AgentInstance,
    sessionId: string,
    modelId: string,
    where: string,
    // Lead verb inferred from the agent's session/new response shape;
    // undefined falls back to session/set_model.
    modelVerb?: ModelVerb,
  ): Promise<boolean> {
    try {
      // Leads with the inferred verb and probes the other on
      // MethodNotFound — agents on @agentclientprotocol/sdk >= 0.26 only
      // implement session/set_config_option (see core/model-verb.ts).
      const { verb } = await requestModelChange({
        request: (method, params) => agent.connection.request(method, params),
        sessionId,
        modelId,
        ...(modelVerb ? { verb: modelVerb } : {}),
        logger: this.logger,
      });
      this.logger?.info(`${where}: ${verb} accepted`);
      return true;
    } catch (err) {
      this.logger?.warn(
        `${where} rejected by agent (${(err as Error).message}); session will use the agent's own default`,
      );
      return false;
    }
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
    // Caller-supplied env forwarded into the spawn via extraEnv on
    // AgentInstanceOptions. Applied on every bootstrapAgent call site
    // (brand-new, agent switch, import re-seed, /hydra restart) so
    // resurrect paths and respawn carry the same env.
    forwardedEnv?: Record<string, string>;
    // The hydra session this agent is being spawned for. Exported into
    // the child as HYDRA_ACP_SESSION so anything the agent shells out to
    // can identify itself without being told.
    selfSessionId?: string;
  }): Promise<{
    agent: AgentInstance;
    upstreamSessionId: string;
    agentMeta?: Record<string, unknown>;
    agentCapabilities?: AgentCapabilities;
    initialModel?: string;
    initialModels?: AdvertisedModel[];
    initialModes?: AdvertisedMode[];
    initialMode?: string;
    modelVerb?: ModelVerb;
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
    const bootstrapEnv = withSelfSessionEnv(
      params.selfSessionId,
      params.forwardedEnv,
    );
    const agent = this.spawner({
      agentId: params.agentId,
      cwd: params.cwd,
      plan,
      ...(bootstrapEnv ? { extraEnv: bootstrapEnv } : {}),
    });
    try {
      const initResult = await agent.connection.request<Record<string, unknown>>(
        "initialize",
        {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: HYDRA_CLIENT_CAPABILITIES,
          clientInfo: { name: "hydra", version: HYDRA_VERSION },
        },
      );
      const agentCapabilities = initResult.agentCapabilities as
        | AgentCapabilities
        | undefined;
      agent.authMethods = parseAuthMethods(initResult.authMethods);
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
      // Which verb this agent takes for model changes, read off the shape
      // of its model advertisement (see core/model-verb.ts).
      const modelVerb = inferModelVerbFromResult(newResult);
      const desired = params.model ?? this.defaultModels[params.agentId];
      if (desired && desired !== initialModel) {
        // Resolve against the agent's advertised model list when we have
        // one. Surfaces config typos (e.g. defaultModels[opencode] set to
        // a claude-acp-shaped id) before they corrupt the session —
        // opencode in particular silently splits an unknown modelId on `/`
        // and stores garbage, which then makes every subsequent prompt
        // return end_turn instantly. resolveModelId also bridges
        // provider-prefix drift: a configured bare "claude-opus-4-7"
        // resolves to the advertised "anthropic/claude-opus-4-7" when
        // that's the only trailing-segment match. When the agent didn't
        // advertise a list yet (kind "none"), we fall back to optimistic
        // forwarding (the previous behavior) so we don't block a
        // legitimate id we just can't see.
        const resolution = resolveModelId(desired, initialModels);
        const where =
          params.model !== undefined
            ? `model=${JSON.stringify(desired)}`
            : `defaultModels[${params.agentId}]=${JSON.stringify(desired)}`;
        if (resolution.kind === "exact" || resolution.kind === "none") {
          // Only adopt the desired id if the agent actually accepted it;
          // a rejection leaves the session on the agent's own default.
          if (
            await this.applySeedModel(
              agent,
              sessionIdRaw,
              desired,
              where,
              modelVerb,
            )
          ) {
            initialModel = desired;
          }
        } else if (resolution.kind === "resolved") {
          if (resolution.modelId === initialModel) {
            initialModel = resolution.modelId;
          } else if (
            await this.applySeedModel(
              agent,
              sessionIdRaw,
              resolution.modelId,
              `${where} resolved to ${JSON.stringify(resolution.modelId)}`,
              modelVerb,
            )
          ) {
            initialModel = resolution.modelId;
          }
        } else if (resolution.kind === "ambiguous") {
          this.logger?.warn(
            `${where} is ambiguous (trailing-segment matches [${resolution.candidates.join(", ")}]); skipping session/set_model, session will use ${JSON.stringify(initialModel)}`,
          );
        } else {
          const known = initialModels.map((m) => m.modelId).join(", ");
          this.logger?.warn(
            `${where} not in agent's availableModels ([${known}]); skipping session/set_model, session will use ${JSON.stringify(initialModel)}`,
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
        modelVerb,
      };
    } catch (err) {
      await agent.kill().catch(() => undefined);
      throw enrichAuthRequired(
        enrichBringupFailure(err, agent, params.agentId, {
          command: plan.command,
          args: plan.args,
          cwd: params.cwd,
        }),
        agent,
      );
    }
  }

  // Spawn a fresh agent process and resume an existing upstream session
  // via session/load (not session/new). Used by the rollback path to
  // re-attach to the pre-compaction upstream session.
  private async bootstrapAgentLoad(
    upstreamSessionId: string,
    params: {
      agentId: string;
      cwd: string;
      agentArgs?: string[];
      forwardedEnv?: Record<string, string>;
      mcpServers?: unknown[];
      selfSessionId?: string;
    },
  ): Promise<SpawnReplacementAgentResult> {
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
    });
    const loadEnv = withSelfSessionEnv(
      params.selfSessionId,
      params.forwardedEnv,
    );
    const agent = this.spawner({
      agentId: params.agentId,
      cwd: params.cwd,
      plan,
      ...(loadEnv ? { extraEnv: loadEnv } : {}),
    });
    try {
      const initResult = await agent.connection.request<Record<string, unknown>>(
        "initialize",
        {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: HYDRA_CLIENT_CAPABILITIES,
          clientInfo: { name: "hydra", version: HYDRA_VERSION },
        },
      );
      const agentCapabilities = initResult.agentCapabilities as
        | AgentCapabilities
        | undefined;
      agent.authMethods = parseAuthMethods(initResult.authMethods);
      const loadMeta = buildSessionLoadMeta(params.agentId, undefined);
      const loadResult = await agent.connection.request<Record<string, unknown>>(
        "session/load",
        {
          sessionId: upstreamSessionId,
          cwd: params.cwd,
          mcpServers: params.mcpServers ?? [],
          ...(loadMeta && { _meta: loadMeta }),
        },
      );
      const initialModel = extractInitialModel(loadResult);
      const initialModels = nonEmptyOrUndefined(extractInitialModels(loadResult));
      const initialModes = extractInitialModes(loadResult);
      const initialMode = extractInitialCurrentMode(loadResult);
      return {
        agent,
        upstreamSessionId,
        agentMeta: loadResult._meta as Record<string, unknown> | undefined,
        agentCapabilities,
        initialModel,
        initialModels,
        initialModes: initialModes.length > 0 ? initialModes : undefined,
        initialMode,
        modelVerb: inferModelVerbFromResult(loadResult),
      };
    } catch (err) {
      await agent.kill().catch(() => undefined);
      throw enrichAuthRequired(
        enrichBringupFailure(err, agent, params.agentId, {
          command: plan.command,
          args: plan.args,
          cwd: params.cwd,
        }),
        agent,
      );
    }
  }

  // Roll back the most recent compaction swap for a session. Guards:
  //   - session must be live
  //   - session record must have a rollbackBreadcrumb
  //   - session must be quiesced
  //   - no active compaction in flight for this session
  //   - no concurrent rollback in progress for this session
  //
  // On success: restores the previous upstream, clears synopsis and
  // rollbackBreadcrumb, restores previousSummarizedThroughEntry, and
  // broadcasts phase: "rolled_back".
  async performUncompact(sessionId: string): Promise<void> {
    if (this.rollbackLocks.has(sessionId)) {
      throw new Error("a rollback is already in progress for this session");
    }
    const live = this.get(sessionId);
    if (!live) {
      throw new Error("session is not live — cannot roll back a cold session");
    }
    const record = await this.store.read(sessionId);
    if (!record) {
      throw new Error("session record not found");
    }
    const breadcrumb = record.rollbackBreadcrumb;
    if (!breadcrumb) {
      throw new Error(
        "no rollback breadcrumb found — either the session has not been compacted, " +
          "the rollback window has closed (a new turn was dispatched), or a previous " +
          "rollback already consumed the breadcrumb",
      );
    }
    const compactionState = record.compactionState;
    if (compactionState != null) {
      throw new Error(
        `compaction is in progress (status: ${compactionState.status}) — wait for it to complete before rolling back`,
      );
    }
    const quiesced = await live.isQuiescedForSwap();
    if (!quiesced) {
      throw new Error(
        "session is not quiesced for rollback — wait for in-flight work to complete",
      );
    }
    this.rollbackLocks.add(sessionId);
    try {
      await live.rollbackToUpstream({
        previousUpstreamSessionId: breadcrumb.previousUpstreamSessionId,
        previousSummarizedThroughEntry: breadcrumb.previousSummarizedThroughEntry,
      });
      // Clear synopsis, rollbackBreadcrumb, and restore summarizedThroughEntry.
      // rollbackToUpstream already updated upstreamSessionId via agentChangeHandlers
      // and broadcast phase:"rolled_back" to clients; we only need to persist
      // the cleared fields here.
      await this.mutateRecord(sessionId, {
        summarizedThroughEntry: breadcrumb.previousSummarizedThroughEntry,
      }, ["synopsis", "rollbackBreadcrumb"]);
    } finally {
      this.rollbackLocks.delete(sessionId);
    }
  }

  // Spawn + initialize an agent for the standalone `authenticate` RPC.
  // Unlike bootstrapAgent this skips session/new — the caller only needs
  // a live JSON-RPC channel to forward `authenticate` to, and a populated
  // authMethods list to validate the methodId against. The agent stays
  // alive on success so a follow-up session/new (post-auth) can reuse the
  // already-authenticated channel via consumePendingAuthAgent.
  async bootstrapAgentForAuth(
    agentId: string,
    cwd?: string,
  ): Promise<AgentInstance> {
    const existing = this.pendingAuthAgents.get(agentId);
    if (existing && existing.isAlive()) {
      return existing;
    }
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
    const effectiveCwd = cwd ?? expandHome(this.defaultCwd);
    const agent = this.spawner({
      agentId,
      cwd: effectiveCwd,
      plan,
    });
    try {
      const initResult = await agent.connection.request<Record<string, unknown>>(
        "initialize",
        {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: HYDRA_CLIENT_CAPABILITIES,
          clientInfo: { name: "hydra", version: HYDRA_VERSION },
        },
      );
      agent.authMethods = parseAuthMethods(initResult.authMethods);
    } catch (err) {
      await agent.kill().catch(() => undefined);
      throw enrichAuthRequired(err, agent);
    }
    this.pendingAuthAgents.set(agentId, agent);
    agent.onExit(() => {
      if (this.pendingAuthAgents.get(agentId) === agent) {
        this.pendingAuthAgents.delete(agentId);
      }
    });
    return agent;
  }

  // Resolve a registry-shaped SpawnPlan for `agentId` without spawning.
  // Mirrors the registry lookup + planSpawn pair used by session
  // create/load/respawn and bootstrapAgentForAuth, so terminal-auth can
  // surface the exact same command/args/env the daemon would launch.
  async planSpawnForAgent(agentId: string): Promise<SpawnPlan> {
    const agentDef = await this.registry.getAgent(agentId);
    if (!agentDef) {
      const err = new Error(
        `agent ${agentId} not found in registry`,
      ) as Error & { code: number };
      err.code = JsonRpcErrorCodes.AgentNotInstalled;
      throw err;
    }
    return planSpawn(agentDef, [], { npmRegistry: this.npmRegistry });
  }

  // Pop the most-recently-authenticated standalone agent for this id, if
  // any. Used by session/new (TODO) to avoid re-spawning + re-initing
  // right after the editor's authenticate round-trip completed.
  consumePendingAuthAgent(agentId: string): AgentInstance | undefined {
    const agent = this.pendingAuthAgents.get(agentId);
    if (!agent) {
      return undefined;
    }
    this.pendingAuthAgents.delete(agentId);
    if (!agent.isAlive()) {
      return undefined;
    }
    return agent;
  }

  // Live AgentInstance backing the given hydra sessionId, or undefined
  // when no session by that id is currently in memory. Used by the
  // `authenticate` RPC to route to an existing session's child agent
  // instead of spawning a fresh one.
  getAgentForSession(sessionId: string): AgentInstance | undefined {
    const session = this.sessions.get(sessionId);
    return session?.agent;
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
      this.invalidateListCache();
      // Release the workspace only when the record is going away too.
      // A close WITHOUT deleteRecord is a cold-down, not a deletion: the
      // session can be resurrected later and must find its workspace
      // still there.
      if (deleteRecord && session.workspace !== undefined) {
        void this.releaseWorkspace(session.workspace, session.sessionId).catch(() => undefined);
      }
      if (deleteRecord) {
        // Tombstone before unlink so the next agent sync doesn't
        // reimport this upstream session. Snapshot updatedAt/cwd/title
        // from the live Session (no extra fs read needed, and avoids
        // racing the unlink) so syncFromAgent can tell whether the
        // agent has progressed past our snapshot since deletion.
        if (session.upstreamSessionId) {
          const liveInteractive = effectiveInteractive(
            {
              interactive: session.interactive,
              ...(session.originatingClient
                ? { originatingClient: session.originatingClient }
                : {}),
            },
            // The session has been alive in-process so we don't know
            // history presence here without a stat; pass true to fall
            // through to the explicit-flag / originatingClient rules
            // (the only branches that produce a defined boolean).
            true,
          );
          // Chain tombstone → unlink so the tombstone file is durable
          // before the meta.json disappears. Otherwise a racing
          // session/attach (TUI auto-reconnect off session/closed) can
          // beat the tombstone to disk, see no record + no tombstone,
          // and resurrect from hydraHints alone.
          const chain = this.tombstoneAllGenerations(
            session.sessionId,
            {
              agentId: session.agentId,
              upstreamSessionId: session.upstreamSessionId,
              upstreamUpdatedAt: new Date(session.updatedAt).toISOString(),
              cwd: session.cwd,
              ...(session.title !== undefined ? { title: session.title } : {}),
              ...(liveInteractive !== undefined ? { interactive: liveInteractive } : {}),
            },
            "user",
          )
            .catch(() => undefined)
            .then(() =>
              this.store.delete(session.sessionId).catch(() => undefined),
            )
            .then(() =>
              this.histories.delete(session.sessionId).catch(() => undefined),
            )
            .finally(() => {
              if (this.pendingDeletions.get(session.sessionId) === chain) {
                this.pendingDeletions.delete(session.sessionId);
              }
            });
          this.pendingDeletions.set(session.sessionId, chain);
          return;
        }
        const noTombstoneChain = this.store
          .delete(session.sessionId)
          .catch(() => undefined)
          .then(() =>
            this.histories.delete(session.sessionId).catch(() => undefined),
          )
          .finally(() => {
            if (this.pendingDeletions.get(session.sessionId) === noTombstoneChain) {
              this.pendingDeletions.delete(session.sessionId);
            }
          });
        this.pendingDeletions.set(session.sessionId, noTombstoneChain);
        return;
      }
    });
    session.onTitleChange((title) => {
      void this.persistTitle(session.sessionId, title).catch(() => undefined);
    });
    session.onPriorityChange((priority) => {
      void this.persistPriority(session.sessionId, priority).catch(
        () => undefined,
      );
    });
    session.onAgentChange(({ agentId, upstreamSessionId, retiredCost }) => {
      void this.persistAgentChange(
        session.sessionId,
        agentId,
        upstreamSessionId,
        retiredCost,
      ).catch(() => undefined);
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
    session.onAttentionFlagsChange((flags) => {
      void this.mutateRecord(session.sessionId, { attentionFlags: flags }).catch(
        () => undefined,
      );
    });
    this.sessions.set(session.sessionId, session);
    this.invalidateListCache();
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
  async loadHistory(
    sessionId: string,
    opts: { tools?: "inline" | "references"; maxEntries?: number } = {},
  ): Promise<HistoryStoreEntry[]> {
    return this.histories.load(sessionId, opts);
  }

  // Read a single externalized tool-content blob by sha256 (the lean
  // `tools: "references"` fetch-on-expand path). Null if the session id or
  // hash is malformed, or the blob isn't present.
  async loadToolBlob(sessionId: string, hash: string): Promise<string | null> {
    return getToolBlob(sessionId, hash);
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
      // Pass the split through untouched. Folding costAmount into
      // cumulativeCost here would destroy the distinction between "spend on
      // the upstream session we are about to reload" and "spend on retired
      // ones", which is exactly what Session.armCostLedgerProbe needs to
      // decide whether a reloading agent is re-reporting history.
      //
      // Legacy records (collapsed total in costAmount, no cumulativeCost)
      // read as "retired = 0, current life = total", which is the correct
      // interpretation for a single-life session and degrades gracefully for
      // a rotated one.
      currentUsage: persistedUsageToSnapshot(record.currentUsage),
      agentCommands: record.agentCommands,
      agentModes: record.agentModes,
      agentModels: record.agentModels,
      createdAt: record.createdAt,
      pendingHistorySync: record.pendingHistorySync,
      originatingClient: record.originatingClient,
      interactive: record.interactive,
      priority: record.priority,
      forkedFromSessionId: record.forkedFromSessionId,
      forkedFromMessageId: record.forkedFromMessageId,
      forkSynthesisState: record.forkSynthesisState,
      forwardedEnv: record.forwardedEnv,
      // `cwd` above is already the workspace path, so the agent respawns
      // in the right directory without this. Restoring the binding is
      // what keeps the resurrected session FINDABLE by its source tree:
      // without it, session-list filtering by the repo silently stops
      // matching this session the moment the daemon restarts.
      workspace: record.workspace,
      compactionState: record.compactionState,
      attentionFlags: record.attentionFlags?.filter(
        (f: import("../acp/types-attention.js").AttentionFlag) =>
          !(f.source === "daemon" && f.reason.startsWith("permission:")),
      ),
    };
  }

  // Overwrite the persisted forwardedEnv for a session (and the live
  // Session's mirror, if hot). Called from the daemon's session/new
  // and session/attach handlers when the request carries a fresh
  // _meta["hydra-acp"].env map. Pass an empty object to clear; pass
  // undefined and the call is a no-op (no fresh env means leave the
  // persisted value alone).
  async setForwardedEnv(
    sessionId: string,
    env: Record<string, string> | undefined,
  ): Promise<void> {
    if (env === undefined) {
      return;
    }
    const live = this.sessions.get(sessionId);
    if (live) {
      live.forwardedEnv = env;
    }
    await this.enqueueMetaWrite(sessionId, async () => {
      const record = await this.store.read(sessionId);
      if (!record) {
        return;
      }
      const next: SessionRecord = { ...record, forwardedEnv: env };
      await this.store.write(next);
    });
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
      workspace: session.workspace,
      workspaceError: session.workspaceError,
      title: session.title,
      agentId: session.agentId,
      currentModel: session.currentModel,
      currentUsage: session.currentUsage,
      parentSessionId: session.parentSessionId,
      forkedFromSessionId: session.forkedFromSessionId,
      forkedFromMessageId: session.forkedFromMessageId,
      forkSynthesisState: session.forkSynthesisState,
      originatingClient: session.originatingClient,
      interactive: session.interactive,
      updatedAt: new Date(session.updatedAt).toISOString(),
      attachedClients: session.attachedCount,
      status: "warm",
      busy: session.turnStartedAt !== undefined,
      armedTasks: session.armedBackgroundTasks.length,
      ...(session.armedSince !== undefined
        ? { armedSince: session.armedSince }
        : {}),
      awaitingInput: session.awaitingInput,
      agentPid: session.agentPid,
    };
  }

  // Single-row variant of list() for callers that already know the
  // sessionId (e.g. GET /v1/sessions/:id). Reads exactly one record
  // and runs one historyStatus probe instead of walking the full
  // live+cold list. Output matches the corresponding row from
  // listUncached() byte-for-byte (same fields, same enrichment).
  async getOne(sessionId: string): Promise<SessionListEntry | undefined> {
    const live = this.sessions.get(sessionId);
    if (live) {
      const hist = await historyStatus(live.sessionId);
      const interactive = effectiveInteractive(
        {
          interactive: live.interactive,
          ...(live.originatingClient
            ? { originatingClient: live.originatingClient }
            : {}),
        },
        hist.hasContent,
      );
      const used = hist.mtime ?? new Date(live.updatedAt).toISOString();
      return {
        sessionId: live.sessionId,
        upstreamSessionId: live.upstreamSessionId,
        cwd: live.cwd,
        title: live.title,
        agentId: live.agentId,
        currentModel: live.currentModel,
        currentUsage: live.currentUsage,
        parentSessionId: live.parentSessionId,
        forkedFromSessionId: live.forkedFromSessionId,
        forkedFromMessageId: live.forkedFromMessageId,
        forkSynthesisState: live.forkSynthesisState,
        originatingClient: live.originatingClient,
        interactive,
        priority: live.priority,
        updatedAt: used,
        attachedClients: live.attachedCount,
        status: "warm",
        agentPid: live.agentPid,
        busy: live.turnStartedAt !== undefined,
        armedTasks: live.armedBackgroundTasks.length,
        ...(live.armedSince !== undefined ? { armedSince: live.armedSince } : {}),
        awaitingInput: live.awaitingInput,
      };
    }
    const r = await this.store.read(sessionId).catch(() => undefined);
    if (!r) {
      return undefined;
    }
    const hist = await historyStatus(r.sessionId);
    const interactive = effectiveInteractive(r, hist.hasContent);
    const used = hist.mtime ?? r.updatedAt;
    return {
      sessionId: r.sessionId,
      upstreamSessionId: r.upstreamSessionId,
      cwd: r.cwd,
      title: r.title,
      agentId: r.agentId,
      currentModel: r.currentModel,
      currentUsage: collapseUsage(r.currentUsage),
      importedFromMachine: r.importedFromMachine,
      importedFromUpstreamSessionId: r.importedFromUpstreamSessionId,
      parentSessionId: r.parentSessionId,
      forkedFromSessionId: r.forkedFromSessionId,
      forkedFromMessageId: r.forkedFromMessageId,
      forkSynthesisState: r.forkSynthesisState,
      originatingClient: r.originatingClient,
      interactive,
      priority: r.priority,
      updatedAt: used,
      attachedClients: 0,
      status: "cold",
      busy: false,
      armedTasks: 0,
      awaitingInput: false,
    };
  }

  async list(
    filter: {
      cwd?: string;
      includeNonInteractive?: boolean;
      // Restrict to one side of the warm/cold split, named for the
      // SessionListEntry field it filters on.
      //
      // "warm" is the one that earns its keep: it skips the cold-record
      // walk, which is the entire cost of a list on a machine with a long
      // history — a thousand records to stat and serialize so a caller can
      // throw away all but the handful actually running. Anything POLLING
      // for live state must pass it.
      status?: "warm" | "cold";
    } = {},
  ): Promise<SessionListEntry[]> {
    const key =
      `${filter.cwd ?? ""}|${filter.includeNonInteractive ? "1" : "0"}` +
      `|${filter.status ?? ""}`;
    const now = Date.now();
    const cached = this.listCache.get(key);
    if (cached && cached.expiresAt > now) {
      return cached.promise;
    }
    const promise = this.listUncached(filter);
    this.listCache.set(key, {
      expiresAt: now + SessionManager.LIST_CACHE_TTL_MS,
      promise,
    });
    // If the read fails, drop the entry so the next caller retries
    // immediately rather than waiting out the TTL on a broken result.
    promise.catch(() => {
      const current = this.listCache.get(key);
      if (current && current.promise === promise) {
        this.listCache.delete(key);
      }
    });
    return promise;
  }

  private invalidateListCache(): void {
    this.listCache.clear();
  }

  private async listUncached(
    filter: {
      cwd?: string;
      includeNonInteractive?: boolean;
      status?: "warm" | "cold";
    } = {},
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
    // Stat all sessions (warm + cold) in parallel. The sequential
    // historyStatus loop was the dominant cost when the picker opened
    // against a directory with hundreds of cold sessions.
    const liveSessions = [...this.sessions.values()].filter(
      (s) => matchesCwdFilter(filter.cwd, s),
    );
    // status=cold still needs the live IDS — they're what excludes a live
    // session's record from the cold set — but none of the per-session
    // stats or entry building below.
    if (filter.status === "cold") {
      for (const session of liveSessions) {
        liveIds.add(session.sessionId);
      }
    }
    const liveStats =
      filter.status === "cold"
        ? []
        : await Promise.all(liveSessions.map((s) => historyStatus(s.sessionId)));
    for (let i = 0; i < liveStats.length; i += 1) {
      const session = liveSessions[i]!;
      const hist = liveStats[i]!;
      liveIds.add(session.sessionId);
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
        // Emitted alongside cwd, which for an isolated session is a hash
        // directory naming no project. This literal is a second warm-entry
        // builder beside liveListEntry, and it silently lagged it: the
        // attach response carried the binding while `session list` and
        // GET /v1/sessions reported the same session as ordinary.
        workspace: session.workspace,
        workspaceError: session.workspaceError,
        title: session.title,
        agentId: session.agentId,
        currentModel: session.currentModel,
        currentUsage: session.currentUsage,
        parentSessionId: session.parentSessionId,
        forkedFromSessionId: session.forkedFromSessionId,
        forkedFromMessageId: session.forkedFromMessageId,
        originatingClient: session.originatingClient,
        interactive,
        priority: session.priority,
        updatedAt: used,
        attachedClients: session.attachedCount,
        status: "warm",
        agentPid: session.agentPid,
        busy: session.turnStartedAt !== undefined,
        armedTasks: session.armedBackgroundTasks.length,
        ...(session.armedSince !== undefined
          ? { armedSince: session.armedSince }
          : {}),
        awaitingInput: session.awaitingInput,
        compactionState: session.compactionState,
        forkSynthesisState: session.forkSynthesisState,
      });
    }
    if (filter.status === "warm") {
      return entries;
    }
    // Propagate disk errors so list()'s cache entry evicts and the next
    // caller retries instead of seeing an empty cold-record set wedged
    // in the 500ms list cache.
    const records = await this.store.list().catch((err: unknown) => {
      this.logger?.warn(
        `session list: store.list() failed: ${(err as Error)?.message ?? String(err)}`,
      );
      throw err;
    });
    const coldRecords = records.filter(
      (r) => !liveIds.has(r.sessionId) && matchesCwdFilter(filter.cwd, r),
    );
    const coldStats = await Promise.all(
      coldRecords.map((r) => historyStatus(r.sessionId)),
    );
    for (let i = 0; i < coldRecords.length; i += 1) {
      const r = coldRecords[i]!;
      const hist = coldStats[i]!;
      const interactive = effectiveInteractive(r, hist.hasContent);
      if (!includeRow(interactive)) {
        continue;
      }
      const used = hist.mtime ?? r.updatedAt;
      entries.push({
        sessionId: r.sessionId,
        upstreamSessionId: r.upstreamSessionId,
        cwd: r.cwd,
        workspace: r.workspace,
        title: r.title,
        agentId: r.agentId,
        currentModel: r.currentModel,
        currentUsage: collapseUsage(r.currentUsage),
        importedFromMachine: r.importedFromMachine,
        importedFromUpstreamSessionId: r.importedFromUpstreamSessionId,
        parentSessionId: r.parentSessionId,
        forkedFromSessionId: r.forkedFromSessionId,
        forkedFromMessageId: r.forkedFromMessageId,
        originatingClient: r.originatingClient,
        interactive,
        priority: r.priority,
        updatedAt: used,
        attachedClients: 0,
        status: "cold",
        busy: false,
        armedTasks: 0,
        awaitingInput: false,
        compactionState: r.compactionState,
        forkSynthesisState: r.forkSynthesisState,
      });
    }
    entries.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return entries;
  }

  // Build an export bundle for a session, reading meta + history from
  // disk. Backfills lineageId if the on-disk record pre-dates that
  // field. Returns undefined if the session doesn't exist. Callers
  // populate the bundle's exportedFrom metadata themselves.
  async exportBundle(
    sessionId: string,
    opts: { tools?: "inline" | "references" } = {},
  ): Promise<
    | {
        record: SessionRecord & { lineageId: string };
        history: HistoryStoreEntry[];
        promptHistory: string[];
        toolBlobs?: Record<string, string>;
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
    const tools = opts.tools ?? "inline";
    const history = await this.histories
      .load(sessionId, tools === "references" ? { tools: "references" } : {})
      .catch(() => []);
    const promptHistory = await loadPromptHistorySafely(sessionId);
    if (tools !== "references") {
      return { record: withLineage, history, promptHistory };
    }
    // Assemble the referenced tool blobs (gzipped, base64) so the bundle is
    // a complete, deduped, compressed backup the importer can hydrate from.
    const toolBlobs: Record<string, string> = {};
    for (const hash of collectToolBlobHashes(history)) {
      const gz = await readToolBlobGz(sessionId, hash);
      if (gz) {
        toolBlobs[hash] = gz.toString("base64");
      }
    }
    return { record: withLineage, history, promptHistory, toolBlobs };
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
      // Close any warm session backed by this record so the import
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
    opts: {
      forkAt?: string;
      cwd?: string;
      agentId?: string;
      // Optional title for the fork. When omitted, the fork inherits the
      // source's title via the spread below. /btw passes "btw: <prompt>"
      // so the fork is identifiable in `hydra sessions list --all`.
      title?: string;
      // "synthesis" (default): copy full history and run generateSynopsis
      // to produce a concise brief for the new agent.  "verbatim": copy
      // only the sliced history up to forkAt/TurnComplete — identical to
      // pre-synthesis behavior.  In synthesis mode, `forkAt` is silently
      // ignored (synthesis always covers full history).
      mode?: "verbatim" | "synthesis";
      // Optional model override for the fork. When set, the fork's
      // record.currentModel is stamped with this id so the resurrect path
      // applies it via session/set_model at agent bootstrap. Validation
      // against the target agent's advertised models happens at attach
      // time; an unknown id logs a warning and leaves the fork on the
      // agent's default. Also used as the synopsis model in synthesis mode
      // so the brief is generated in the same idiom the fork will consume.
      model?: string;
    } = {},
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

    let slicedHistory = sourceHistory;
    let forkedAt: string;
    const mode = opts.mode ?? "synthesis";
    // Set in phase 1 for synthesis forks so recordForBundle picks it up.
    // Undefined for verbatim and cross-machine imports.
    let forkSynthesisState: "running" | undefined;
    // Hoisted for synthesis-mode phase 2 (background synopsis generation).
    // Undefined for verbatim forks.
    let sourceModel: string | undefined;
    let pendingSynthAgentDef: Awaited<ReturnType<typeof this.registry.getAgent>> | undefined;

    // Timeout for synopsis generation — reused in phase 1 (validation) and
    // phase 2 (background).  Same default as synopsis-agent.ts (120 s).
    const SYNOPSIS_TIMEOUT_MS = 120_000;

    if (mode === "verbatim") {
      // Legacy path — slice via forkAt or last completed turn.
      if (opts.forkAt !== undefined) {
        const ci = findMessageIdIndex(sourceHistory, opts.forkAt);
        if (ci < 0) {
          const err = new Error(
            `forkAt messageId not found in source history: ${opts.forkAt}`,
          ) as Error & { code: number };
          err.code = JsonRpcErrorCodes.InvalidParams;
          throw err;
        }
        forkedAt = opts.forkAt;
        slicedHistory = sourceHistory.slice(0, ci + 1);
      } else {
        const found = findLastTurnComplete(sourceHistory);
        if (found) {
          forkedAt = found.messageId;
          slicedHistory = sourceHistory.slice(0, found.index + 1);
        } else {
          // Source has no completed turns yet (e.g. a freshly-spawned
          // session that hasn't received a real prompt). Fork at the
          // beginning — empty history, no messageId to point at. This
          // makes /btw and other fork-based features work from any
          // session state, not just established conversations.
          forkedAt = "";
          slicedHistory = sourceHistory.slice(0, 0);
        }
      }
   } else {
      // synthesis mode — full history by default. When forkAt is set,
      // slice sourceHistory *and* the synopsis input at that boundary
      // so callers mid-turn (e.g. /hydra fork excluding its own trigger
      // message) don't carry an in-flight turn into the fork.
      if (opts.forkAt !== undefined && opts.forkAt !== "") {
        const ci = findMessageIdIndex(sourceHistory, opts.forkAt);
        if (ci < 0) {
          const err = new Error(
            `forkAt messageId not found in source history: ${opts.forkAt}`,
          ) as Error & { code: number };
          err.code = JsonRpcErrorCodes.InvalidParams;
          throw err;
        }
        forkedAt = opts.forkAt;
        slicedHistory = sourceHistory.slice(0, ci + 1);
      } else {
        forkedAt = "";
        slicedHistory = sourceHistory; // full copy
      }

      // Validate target agent exists (cheap registry lookup). The
      // expensive part — planSpawn / npm-prefetch — is deferred to phase 2
      // so the HTTP response returns quickly and the TUI picker can
      // navigate to the new session without waiting on a network install.
      const targetAgentDef = await this.registry.getAgent(targetAgentId);
      if (!targetAgentDef) {
        const err = new Error(
          `agent ${targetAgentId} not found in registry`,
        ) as Error & { code: number };
        err.code = JsonRpcErrorCodes.AgentNotInstalled;
        throw err;
      }
      // Stash for phase 2.
      pendingSynthAgentDef = targetAgentDef;

      // Phase 1 (synchronous): stamp forkSynthesisState="running" so the
      // recall MCP mint predicate fires immediately on attach.
      // synopsis is left unset — it will be filled by the background phase
      // below.
      sourceModel = sourceRecord.currentModel;

      forkSynthesisState = "running";
    }
    const promptHistory = await loadPromptHistorySafely(sourceSessionId);

    // Build a record snapshot for encodeBundle. Fresh lineageId so the
    // fork is a new conversation lineage (sharing source's lineageId
    // would deadlock importBundle's dedup against the source itself).
    // For cross-agent forks, omit agent-specific state so the new agent
    // boots clean — title and history survive.
    //
    // `interactive` is forced to false on every fork: a fork is a
    // pristine snapshot that has not had a real turn on its own yet,
    // regardless of the source's interactive state. The first
    // non-ancillary prompt against the fork promotes it to true (see
    // session.ts:1229), matching session/new semantics. Forks that are
    // viewed but never prompted stay hidden from default picker
    // listings (visible via --all / --include-non-interactive) —
    // they're just unused snapshots at that point. /btw forks stay
    // false because their prompts are tagged ancillary.
    //
    // The alternative — leaving interactive=undefined — falls through
    // to effectiveInteractive's hasContent inference, which returns
    // true because the fork is seeded with the source's history. That
    // would put every /btw fork in the picker. Setting false here
    // bypasses the inference cleanly.
    // Stamp summarizedThroughEntry = the fork's own (sliced) history length
    // for BOTH modes, so the recall MCP mint predicate fires from first
    // attach and recall indexes exactly the history this fork carries.
    // Synthesis copies the full history (sliced === source), so this equals
    // sourceHistory.length there; verbatim/btw gets its prefix length —
    // replacing the incoherent inherited source watermark (which could
    // exceed the prefix and point recall past the end of the fork).
    const synthesized = mode === "synthesis";
    const recordForBundle: SessionRecord & { lineageId: string } = {
      ...sourceRecord,
      lineageId: generateLineageId(),
      agentId: targetAgentId,
      interactive: false,
      ...(forkSynthesisState !== undefined ? { forkSynthesisState } : {}),
      summarizedThroughEntry: slicedHistory.length,
      ...(opts.title !== undefined ? { title: opts.title } : {}),
      // A fork is a new session: its first turn re-pays for the carried
      // context (cache miss on the new session id, full prompt re-sent),
      // so cumulativeCost from turn 1 onward is the true cost of this
      // session. Inheriting the source's usage would double-count the
      // shared prefix against the source's own ledger.
      currentUsage: undefined,
      ...(crossAgent
        ? {
            currentModel: undefined,
            currentMode: undefined,
            agentCommands: undefined,
            agentModes: undefined,
            agentModels: undefined,
          }
        : {}),
      // Explicit model override wins over both source's currentModel
      // (same-agent fork) and the crossAgent clear above.
      ...(opts.model !== undefined ? { currentModel: opts.model } : {}),
    };

    const bundle = encodeBundle({
      record: recordForBundle,
      history: slicedHistory,
      promptHistory: promptHistory.length > 0 ? promptHistory : undefined,
      hydraVersion: HYDRA_VERSION,
      machine: thisMachine(),
    });

    const newId = `${HYDRA_SESSION_PREFIX}${generateRawSessionId()}`;

    // Isolation is inherited from the PARENT SESSION, not from whoever
    // asked for the fork. Without this the fork inherits the parent's
    // cwd, which for an isolated session is its workspace, putting two
    // sessions in one checkout.
    //
    // An explicit opts.cwd is respected as a deliberate override. When
    // derivation fails we fall back to the parent's SOURCE tree
    // (unisolated but safe) and never to its workspace: landing there is
    // the exact bug this guards against.
    let forkCwd = opts.cwd;
    let forkWorkspace: PersistedWorkspace | undefined;
    if (opts.cwd === undefined && sourceRecord.workspace !== undefined) {
      const derived = await this.deriveForkWorkspace(
        sourceRecord.workspace,
        `${sourceRecord.workspace.label}-fork-${newId.slice(-6)}`,
      );
      if (derived !== undefined) {
        forkWorkspace = derived;
        forkCwd = derived.path;
      } else {
        forkCwd = sourceRecord.workspace.sourceCwd;
        this.logger?.warn?.(
          `fork ${newId}: could not derive an isolated workspace from ` +
            `${sourceRecord.workspace.path}; running unisolated in ${forkCwd}`,
        );
      }
    }

    await this.writeImportedRecord({
      sessionId: newId,
      bundle,
      cwd: forkCwd,
      ...(forkWorkspace !== undefined ? { workspace: forkWorkspace } : {}),
      forkedFromSessionId: sourceSessionId,
      forkedFromMessageId: forkedAt,
      ...(forkSynthesisState !== undefined ? { forkSynthesisState } : {}),
    });

    // Phase 2 (background, fire-and-forget): generate synopsis for the
    // new session so it has a concise context brief on attach.  This runs
    // detached — the HTTP/ACP response already returned above.
    if (synthesized) {
      void (async () => {
        try {
          // Note: TARGET agent generates the synopsis (not source) — it's
          // consumed by the fork's agent, so we want it in the target's
          // idiom + model.  TODO: plumb an AbortSignal so a disconnected
          // HTTP client can cancel synopsis generation (currently orphans
          // the ephemeral agent run).
          // planSpawn deferred into phase 2 — it can do an npm install on
          // first run for a given agent/version, which would otherwise
          // block the phase-1 HTTP response (and the TUI picker behind it)
          // for seconds.
          const spawnPlan = await planSpawn(pendingSynthAgentDef!, [], {
            npmRegistry: this.npmRegistry,
          });
          const synopsisResult = await generateSynopsis({
            agentId: targetAgentId,
            cwd: opts.cwd ?? paths.sessionDir(sourceSessionId),
            plan: spawnPlan,
            history: slicedHistory,
            // sourceModel deliberately — synopsis is a one-shot prep step,
            // not the review work. Using opts.model here would burn premium
            // tokens (and possibly rate-limit) on history summarization the
            // user didn't ask for. The target agent still consumes the
            // synopsis in its own idiom (agentId is targetAgentId above);
            // the model-tier choice is what stays with the source.
            modelId: sourceModel,
            sessionId: sourceSessionId,
            logger: this.logger,
            timeoutMs: SYNOPSIS_TIMEOUT_MS,
          });

          if (synopsisResult && synopsisResult.synopsis) {
            await this.mutateRecord(newId, { synopsis: synopsisResult.synopsis }, ["forkSynthesisState"]);
          } else {
            this.logger?.warn(
              `forkSession(${sourceSessionId}): generateSynopsis returned no synopsis — fork usable via recall`,
            );
            await this.mutateRecord(newId, {}, ["forkSynthesisState"]);
          }
        } catch (err) {
          this.logger?.warn(
            `forkSession(${sourceSessionId}): generateSynopsis failed — fork usable via recall: ${(err as Error).message}`,
          );
          try {
            await this.mutateRecord(newId, {}, ["forkSynthesisState"]);
          } catch (mutateErr) {
            this.logger?.warn(
              `forkSession(${sourceSessionId}): mutateRecord to clear forkSynthesisState failed: ${(mutateErr as Error).message}`,
            );
          }
        }
      })();
    }

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
    // Isolated-workspace binding for the new record. Set by the fork
    // path when the source session was isolated; `cwd` above must then
    // be this workspace's path.
    workspace?: PersistedWorkspace;
    // Local-fork breadcrumbs. When both are set, the record is written
    // with forked* fields populated; the imported* family is left
    // unset so meta.json doesn't lie about the origin.
    forkedFromSessionId?: string;
    forkedFromMessageId?: string;
    // Transient marker for synthesis-mode forks — stamped in phase 1 so the
    // recall MCP mint predicate fires immediately. Cleared by the background
    // phase via mutateRecord once synopsis lands or fails.
    forkSynthesisState?: "running" | "failed";
  }): Promise<void> {
    // zod's z.unknown() makes params optional in the inferred type, but
    // HistoryStore writes whatever JSON shape it was handed; the on-disk
    // round-trip is identical so the cast is safe.
    await this.histories.rewrite(
      args.sessionId,
      args.bundle.history as HistoryStoreEntry[],
    );
    // Restore externalized tool blobs (tools=references bundles). The
    // ref-form history written above points at these hashes; getToolBlob
    // hydrates from them. Inline bundles carry no toolBlobs (rewrite
    // re-externalizes their inline content locally instead).
    if (args.bundle.toolBlobs) {
      for (const [hash, b64] of Object.entries(args.bundle.toolBlobs)) {
        await writeToolBlobGz(
          args.sessionId,
          hash,
          Buffer.from(b64, "base64"),
        ).catch(() => undefined);
      }
    }
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
        // Deliberately NOT inherited from the bundle: a bundle records
        // the SOURCE session's workspace, and reusing it would point two
        // records at one directory. Only an explicit caller-supplied
        // binding (the fork path, which derives a fresh workspace) counts.
        workspace: args.workspace,
        title: args.bundle.session.title,
        synopsis: args.bundle.session.synopsis,
        summarizedThroughEntry: args.bundle.session.summarizedThroughEntry,
        ...(args.forkSynthesisState !== undefined
          ? { forkSynthesisState: args.forkSynthesisState }
          : {}),
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
        priority: args.bundle.session.priority,
        attentionFlags: [],
        createdAt: args.preservedCreatedAt ?? now,
        // Fallback path for historyStatus (used when the history file
        // is missing). Keep this consistent with the utimes stamp above.
        updatedAt: args.bundle.session.updatedAt,
      });
    });
  }

  /**
   * Tombstone every upstream session a hydra session has ever occupied,
   * not just the one it is on now.
   *
   * A session accumulates upstream generations as it swaps — compaction,
   * workspace enter and leave, agent switch — and the record's
   * `upstreamGenerations` is the only place that trail is written down.
   * Deleting the session deletes the trail with it, so tombstoning the
   * current id alone leaves every retired generation with no record AND
   * no tombstone. The next `agent sync` sees them in the agent's own
   * session/list, recognizes nothing, and mints a fresh cold row for
   * each: no history, createdAt == updatedAt, cwd wherever that
   * generation was spawned.
   *
   * Generations can span agents (an agent switch retires one and mints
   * another elsewhere), so each is tombstoned under its OWN agentId
   * rather than the record's current one.
   */
  private async tombstoneAllGenerations(
    sessionId: string,
    current: {
      agentId: string;
      upstreamSessionId: string;
      upstreamUpdatedAt: string;
      cwd: string;
      title?: string;
      interactive?: boolean;
    },
    reason: "user" | "expired",
  ): Promise<void> {
    const record = await this.store.read(sessionId).catch(() => undefined);
    const pairs = new Map<string, { agentId: string; upstreamSessionId: string }>();
    for (const gen of record?.upstreamGenerations ?? []) {
      if (gen.upstreamSessionId) {
        pairs.set(`${gen.agentId}::${gen.upstreamSessionId}`, {
          agentId: gen.agentId,
          upstreamSessionId: gen.upstreamSessionId,
        });
      }
    }
    pairs.set(`${current.agentId}::${current.upstreamSessionId}`, {
      agentId: current.agentId,
      upstreamSessionId: current.upstreamSessionId,
    });
    const deletedAt = new Date().toISOString();
    for (const pair of pairs.values()) {
      await this.tombstones
        .add({
          agentId: pair.agentId,
          upstreamSessionId: pair.upstreamSessionId,
          deletedAt,
          upstreamUpdatedAt: current.upstreamUpdatedAt,
          cwd: current.cwd,
          ...(current.title !== undefined ? { title: current.title } : {}),
          reason,
          ...(current.interactive !== undefined ? { interactive: current.interactive } : {}),
        })
        .catch(() => undefined);
    }
  }

  async deleteRecord(
    sessionId: string,
    reason: "user" | "expired" = "user",
  ): Promise<boolean> {
    const record = await this.store.read(sessionId);
    if (!record) {
      return false;
    }
    // Tombstone before we drop the file so the next periodic
    // syncFromAgent doesn't reimport the same upstream session under a
    // fresh hydra id. Skipped for records with no upstream (shouldn't
    // happen for cold records — upstreamSessionId is required by
    // SessionRecord — but defensive in case the schema relaxes).
    if (record.upstreamSessionId) {
      const hist = await historyStatus(sessionId);
      const recordInteractive = effectiveInteractive(record, hist.hasContent);
      await this.tombstoneAllGenerations(
        sessionId,
        {
          agentId: record.agentId,
          upstreamSessionId: record.upstreamSessionId,
          upstreamUpdatedAt: record.updatedAt,
          cwd: record.cwd,
          ...(record.title !== undefined ? { title: record.title } : {}),
          ...(recordInteractive !== undefined ? { interactive: recordInteractive } : {}),
        },
        reason,
      );
    }
    // Release the workspace before dropping the record: the record is
    // the only thing that knows a workspace exists, so unlinking it
    // first would strand the directory with nothing pointing at it.
    if (record.workspace !== undefined) {
      await this.releaseWorkspace(record.workspace, sessionId).catch(() => undefined);
    }
    await this.store.delete(sessionId).catch(() => undefined);
    // Drop history.jsonl + externalized tool blobs alongside the meta
    // record, mirroring the live-session deleteRecord:true path
    // (attachManagerHooks). Without this, deleting a cold record would
    // leave its history file orphaned on disk indefinitely.
    await this.histories.delete(sessionId).catch(() => undefined);
    this.invalidateListCache();
    return true;
  }

  // Await any in-flight deletion chain (tombstone + meta unlink +
  // history unlink) for a session id. The live-session close path
  // schedules these as a fire-and-forget chain from the synchronous
  // onClose handler; callers that need to observe the post-delete
  // state (DELETE /v1/sessions/:id, tests) await this before checking.
  async waitForDeletion(sessionId: string): Promise<void> {
    const p = this.pendingDeletions.get(sessionId);
    if (p) {
      await p;
    }
  }

  // Tombstone lookup gate for the attach/resurrect path. Returns true
  // when the user explicitly deleted this (agentId, upstreamSessionId)
  // pair — so a racing session/attach (e.g. a TUI auto-reconnect that
  // fires off the hydra-acp/session/closed notify) refuses to bring it
  // back from the dead. Keyed by (agent, upstream) because that's the
  // tombstone's natural key; the hydra session id is ephemeral.
  async isTombstoned(
    agentId: string,
    upstreamSessionId: string,
  ): Promise<boolean> {
    const t = await this.tombstones
      .read(agentId, upstreamSessionId)
      .catch(() => undefined);
    return t?.reason === "user";
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
  /**
   * Drop a cold session's workspace binding.
   *
   * The binding outlives the directory: remove an isolated session's
   * workspace and the record still names it, which is what makes the
   * next resurrect rebuild the checkout. Clearing it is how you say the
   * session should stop trying, and it has to happen here rather than
   * in the CLI. A live session holds its record in memory and rewrites
   * it, so a file edited underneath one is silently reverted; going
   * through mutateRecord also serializes this against every other
   * meta write instead of racing them.
   *
   * Live sessions are refused rather than served, because for them
   * clearing the binding is only half the operation: `cwd` IS the
   * workspace, so dropping the binding without moving the agent leaves
   * it running in a directory nothing points at. `workspace stop` /
   * `detach` does both, and is the caller the client should be sent to.
   */
  async clearWorkspaceBinding(
    sessionId: string,
  ): Promise<"cleared" | "live" | "missing"> {
    if (this.get(sessionId) !== undefined) {
      return "live";
    }
    const record = await this.store.read(sessionId).catch(() => undefined);
    if (!record) {
      return "missing";
    }
    // cwd moves back with the binding, in the same write.
    //
    // An isolated record has `cwd` equal to its workspace path, so
    // dropping only the binding leaves the record pointing into a
    // directory that is usually gone — which is why this is called at
    // all. Two visible symptoms: `session list` renders the raw
    // workspace path (its CWD cell substitutes `workspace.sourceCwd`,
    // and there is no longer a workspace to read it from), and a
    // resurrect spawns the agent in a directory that does not exist,
    // while the command that did this promised the session would "resume
    // in <source>".
    //
    // leaveWorkspace already states the rule for the other direction:
    // "Clear cwd and the binding in one write. Two writes could strand a
    // record claiming isolation while sitting in the source tree." Same
    // pairing, opposite order.
    const source = record.workspace?.sourceCwd;
    await this.mutateRecord(sessionId, source !== undefined ? { cwd: source } : {}, ["workspace"]);
    return "cleared";
  }

  /**
   * Point a cold session at a different working directory.
   *
   * Exists for records whose `cwd` outlived the directory it names — a
   * workspace that was removed, a checkout that moved. Such a session
   * resurrects into nowhere, and nothing else can repair it: the fix is a
   * field on the record, and the daemon is the only writer.
   *
   * Cold only, and never while a workspace binding exists. Both refusals
   * protect the same invariant, stated in leaveWorkspace: cwd and the
   * binding move together, and `cwd` equals `workspace.path` for as long
   * as a session is isolated. A live session is refused for a second
   * reason — its agent process was spawned in its cwd and cannot be told
   * to change directory, so moving a live session is a swap
   * (`workspace start` does one), not a field write.
   *
   * The target must exist. Pointing a session at a directory that is not
   * there is the failure this repairs, so accepting one would just move
   * the problem.
   */
  async setCwd(
    sessionId: string,
    cwd: string,
  ): Promise<"set" | "live" | "bound" | "missing" | "not-a-directory"> {
    if (this.get(sessionId) !== undefined) {
      return "live";
    }
    const record = await this.store.read(sessionId).catch(() => undefined);
    if (!record) {
      return "missing";
    }
    if (record.workspace !== undefined) {
      return "bound";
    }
    if (!(await this.dirExists(cwd))) {
      return "not-a-directory";
    }
    await this.mutateRecord(sessionId, { cwd });
    this.invalidateListCache();
    return "set";
  }

  // Set or clear the user-set priority on a session. Mirrors setTitle:
  // works on live (in-memory mutation + persist hook) and cold (direct
  // meta.json write) sessions. Pass 0 or undefined to clear (return to
  // normal priority). Returns false when no record exists at all.
  async setPriority(
    sessionId: string,
    priority: number | undefined,
  ): Promise<boolean> {
    const live = this.get(sessionId);
    if (live) {
      live.setPriority(priority);
      return true;
    }
    if (!(await this.hasRecord(sessionId))) {
      return false;
    }
    const next =
      priority === undefined || priority <= 0 ? undefined : Math.floor(priority);
    await this.persistPriority(sessionId, next);
    return true;
  }

  private async persistPriority(
    sessionId: string,
    priority: number | undefined,
  ): Promise<void> {
    if (priority === undefined) {
      await this.mutateRecord(sessionId, {}, ["priority"]);
    } else {
      await this.mutateRecord(sessionId, { priority });
    }
    this.invalidateListCache();
  }

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
    await this.mutateRecord(sessionId, { title });
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
    await this.mutateRecord(sessionId, { synopsis, summarizedThroughEntry });
  }

  // Persist an agent swap from /hydra agent. The on-disk record's
  // agentId + upstreamSessionId both rotate so a daemon restart (and
  // later resurrect) brings the session back up on the agent the user
  // most recently switched to, not the one it was originally created on.
  private async persistAgentChange(
    sessionId: string,
    agentId: string,
    upstreamSessionId: string,
    retiredCost?: number,
  ): Promise<void> {
    await this.mutateRecord(sessionId, { agentId, upstreamSessionId }, undefined, (prev) => ({
      upstreamGenerations: appendUpstreamGeneration(
        prev,
        agentId,
        upstreamSessionId,
        undefined,
        retiredCost,
      ),
    }));
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
    const fields: Partial<SessionRecord> = {};
    if (update.currentModel !== undefined) fields.currentModel = update.currentModel;
    if (update.currentMode !== undefined) fields.currentMode = update.currentMode;
    if (update.currentUsage !== undefined) fields.currentUsage = update.currentUsage;
    if (update.agentCommands !== undefined) fields.agentCommands = update.agentCommands;
    if (update.agentModes !== undefined) fields.agentModes = update.agentModes;
    if (update.agentModels !== undefined) fields.agentModels = update.agentModels;
    if (update.interactive !== undefined) fields.interactive = update.interactive;
    if (update.cwd !== undefined) fields.cwd = update.cwd;
    await this.mutateRecord(sessionId, fields);
  }

  // Read-modify-write a session's meta.json record under the per-session
  // write queue. Spreads `fields` over the current record, bumps
  // updatedAt, and deletes any keys named in `remove`. No-op if the
  // record has gone away (race with deleteRecord).
  private async mutateRecord(
    sessionId: string,
    fields: Partial<SessionRecord>,
    remove: ReadonlyArray<keyof SessionRecord> = [],
    // Fields that can only be computed from the record as it exists on
    // disk (e.g. appending to a list). Runs inside the same serialized
    // meta-write slot as the read, so concurrent rotations can't
    // interleave a read-modify-write and drop an entry.
    derive?: (prev: SessionRecord) => Partial<SessionRecord>,
  ): Promise<void> {
    await this.enqueueMetaWrite(sessionId, async () => {
      const record = await this.store.read(sessionId);
      if (!record) {
        return;
      }
      const next: SessionRecord = {
        ...record,
        ...fields,
        ...(derive ? derive(record) : {}),
        updatedAt: new Date().toISOString(),
      };
      for (const key of remove) {
        delete (next as Record<string, unknown>)[key as string];
      }
      await this.store.write(next);
    });
  }

  // ── Extension state ──────────────────────────────────────────────
  //
  // Per-(extension, session) key-value bucket persisted to meta.json.
  // Extensions call these via the daemon's REST or WS surfaces, both
  // of which enforce namespacing by deriving `extName` from the
  // caller's bearer token / connection identity. The daemon core never
  // synthesizes an `extName` from an untrusted input.
  //
  // Reads bypass the write queue (single async read from the store);
  // writes go through the queue so concurrent set/delete calls under
  // the same session don't interleave.

  // Serialization cap enforced at write time. 64KB per extension bucket
  // is generous for state that should be flags + small identifiers,
  // and small enough that a runaway extension can't bloat meta.json to
  // the point of slowing every session read.
  private static readonly EXTENSION_STATE_CAP_BYTES = 64 * 1024;

  // Fetch the entire bucket for one extension on one session. Returns
  // an empty object when the session has no state for this extension
  // (or no session at all — callers already handle "unknown session"
  // via the outer HTTP/WS layer, this method just returns empty).
  async getExtensionState(
    sessionId: string,
    extName: string,
  ): Promise<Record<string, unknown>> {
    const record = await this.store.read(sessionId);
    return record?.extensionState?.[extName] ?? {};
  }

  // Fetch one key from one extension's bucket. Returns undefined for
  // missing session, missing bucket, or missing key — caller decides
  // whether that's a 404 or a null result.
  async getExtensionStateKey(
    sessionId: string,
    extName: string,
    key: string,
  ): Promise<unknown> {
    const bucket = await this.getExtensionState(sessionId, extName);
    return bucket[key];
  }

  // Set one key on one extension's bucket. Rejects with a size-cap
  // error when the serialized bucket would exceed the cap.
  // Idempotent: writing the same value again is a no-op from the
  // caller's perspective (the file gets rewritten with a fresh
  // updatedAt, but no observable state change).
  async setExtensionStateKey(
    sessionId: string,
    extName: string,
    key: string,
    value: unknown,
  ): Promise<void> {
    await this.enqueueMetaWrite(sessionId, async () => {
      const record = await this.store.read(sessionId);
      if (!record) {
        return;
      }
      const all = { ...(record.extensionState ?? {}) };
      const bucket = { ...(all[extName] ?? {}), [key]: value };
      const size = Buffer.byteLength(JSON.stringify(bucket), "utf8");
      if (size > SessionManager.EXTENSION_STATE_CAP_BYTES) {
        throw new Error(
          `extension_state: bucket for ${extName} would be ${size} bytes; cap is ${SessionManager.EXTENSION_STATE_CAP_BYTES}`,
        );
      }
      all[extName] = bucket;
      const next: SessionRecord = {
        ...record,
        extensionState: all,
        updatedAt: new Date().toISOString(),
      };
      await this.store.write(next);
    });
  }

  // Remove one key from one extension's bucket. No-op if the key,
  // bucket, or session doesn't exist. Cleans up an empty bucket so
  // meta.json doesn't grow "{}" entries for extensions that touched
  // and left.
  async deleteExtensionStateKey(
    sessionId: string,
    extName: string,
    key: string,
  ): Promise<void> {
    await this.enqueueMetaWrite(sessionId, async () => {
      const record = await this.store.read(sessionId);
      if (!record?.extensionState?.[extName]) {
        return;
      }
      const all = { ...record.extensionState };
      const bucket = { ...all[extName] };
      if (!(key in bucket)) {
        return;
      }
      delete bucket[key];
      if (Object.keys(bucket).length === 0) {
        delete all[extName];
      } else {
        all[extName] = bucket;
      }
      const next: SessionRecord = {
        ...record,
        extensionState: all,
        updatedAt: new Date().toISOString(),
      };
      await this.store.write(next);
    });
  }

  // Serialize meta.json writes per session id so concurrent
  // read-modify-write operations don't interleave reads.
  private enqueueMetaWrite(
    sessionId: string,
    task: () => Promise<void>,
  ): Promise<void> {
    return this.enqueueKeyed(this.metaWriteQueues, sessionId, task);
  }

  /**
   * Serialize `task` against others sharing `key`.
   *
   * Swallows the predecessor's error before chaining so `task` runs
   * exactly once. An earlier `prev.then(task, task)` passed task as both
   * the fulfilled and the rejected handler, which re-ran the work when a
   * predecessor failed.
   */
  private enqueueKeyed<T>(
    queues: Map<string, Promise<unknown>>,
    key: string,
    task: () => Promise<T>,
  ): Promise<T> {
    const prev = queues.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(task);
    const settled = next.catch(() => undefined);
    queues.set(key, settled);
    void settled.finally(() => {
      if (queues.get(key) === settled) {
        queues.delete(key);
      }
    });
    return next;
  }

  /**
   * Live sessions whose binding names this workspace.
   *
   * Derived from the records rather than kept as a counter, deliberately:
   * a counter drifts, because a crash between "session died" and
   * "decrement" pins the workspace forever. A query cannot drift, since a
   * session that is gone stops answering.
   *
   * LIVE sessions only. A cold session's record keeps pointing at its
   * workspace on purpose (that is the `inactive` state, and it is safe
   * because a resurrect rebuilds the checkout from the branch), so
   * counting every claim would let one cold session pin a directory
   * forever and nothing would ever be reclaimed.
   */
  private liveSessionsIn(workspacePath: string, exclude?: string): Session[] {
    const out: Session[] = [];
    for (const s of this.sessions.values()) {
      if (s.sessionId === exclude) {
        continue;
      }
      if (s.workspace?.path === workspacePath) {
        out.push(s);
      }
    }
    return out;
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

  // Public entry point for /hydra compact and /hydra agent — schedule
  // a synthesis-based job on the named session (live or cold). The
  // coordinator runs synthesis asynchronously and dispatches the swap
  // on the next idle edge. When opts.targetAgentId is set, this is a
  // /hydra agent switch: the swap rotates to that agent and we stamp
  // pendingAgentSwap on the record so resume-after-restart knows the
  // target. Fire-and-forget: the meta-write is best-effort (resume
  // gracefully degrades to scheduling a fresh synthesis if missing).
  scheduleCompaction(sessionId: string, opts?: { targetAgentId?: string }): void {
    if (opts?.targetAgentId) {
      void this.mutateRecord(sessionId, { pendingAgentSwap: opts.targetAgentId }).catch((err) => {
        this.logger?.warn(
          `scheduleCompaction: failed to stamp pendingAgentSwap for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      // Fast path for /hydra agent when we already have a fresh synopsis
      // artifact covering the entire current history: skip re-synthesis
      // (which would spawn an ephemeral agent and re-summarize the whole
      // transcript in the target agent's idiom) and go straight to the
      // swap. The artifact is in whatever agent's idiom last generated
      // it, but modern agents consume each other's markdown fine — and
      // for the frequent-switching case the multi-second synthesis wait
      // dominates the perceived latency. If history has grown past the
      // watermark, fall through to the normal coordinator path.
      const targetAgentId = opts.targetAgentId;
      void (async () => {
        try {
          const record = await this.store.read(sessionId);
          if (!record?.synopsis || record.summarizedThroughEntry === undefined) {
            this.synopsisCoordinator.scheduleCompaction(sessionId, opts);
            return;
          }
          const history = await this.histories.load(sessionId, { maxEntries: Infinity });
          if (history.length !== record.summarizedThroughEntry) {
            this.synopsisCoordinator.scheduleCompaction(sessionId, opts);
            return;
          }
          this.logger?.info(
            `compaction: fast-path swap sessionId=${sessionId} target=${targetAgentId} (reusing artifact @${record.summarizedThroughEntry})`,
          );
          await this.dispatchSynthesisSwap(
            sessionId,
            record.synopsis,
            record.summarizedThroughEntry,
            targetAgentId,
          );
        } catch (err) {
          this.logger?.warn(
            `scheduleCompaction: fast-path check failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)} — falling back to synthesis`,
          );
          this.synopsisCoordinator.scheduleCompaction(sessionId, opts);
        }
      })();
      return;
    }
    this.synopsisCoordinator.scheduleCompaction(sessionId, opts);
  }

  // Expose compaction in-flight status for the GET /compact endpoint.
  getCompactionInFlight(): boolean {
    const s = this.synopsisCoordinator.size();
    return s.inflight > 0 || s.queued > 0;
  }

  // Read pendingAgentSwap from a session's record. Returns the target
  // agentId of an in-flight /hydra agent swap, or undefined if none
  // pending. Used by /hydra agent status.
  async getPendingAgentSwap(sessionId: string): Promise<string | undefined> {
    const record = await this.store.read(sessionId).catch(() => undefined);
    return record?.pendingAgentSwap;
  }

  // Read compactionState from a session's record (cold or live).
  // Returns undefined when no compaction is in progress or no record exists.
  async getCompactionState(sessionId: string): Promise<CompactionState | undefined> {
    const record = await this.store.read(sessionId).catch(() => undefined);
    return record?.compactionState;
  }

  // Read rollbackBreadcrumb from a session's persisted record.
  // Returns undefined when no breadcrumb exists (no compaction swap
  // has occurred, the window has closed, or rollback was already done).
  async getRollbackBreadcrumb(sessionId: string): Promise<RollbackBreadcrumb | undefined> {
    const record = await this.store.read(sessionId).catch(() => undefined);
    return record?.rollbackBreadcrumb;
  }

  // Route synthesis phase events to the right wire channel. /hydra compact
  // jobs emit hydra_compaction; /hydra agent jobs emit session_info_update
  // carrying _meta["hydra-acp"].pendingAgentSwap so the TUI's session bar
  // can render "switching to X" without conflating with compaction events.
  // Cleared by swapUpstream's broadcastAgentSwitch once the swap lands; on
  // terminal "failed" phases we broadcast a null pendingAgentSwap so the
  // bar resets.
  private emitSwapPhase(
    sessionId: string,
    targetAgentId: string | undefined,
    payload: Record<string, unknown> & { phase: string },
  ): void {
    const live = this.get(sessionId);
    if (!live) {
      return;
    }
    if (targetAgentId) {
      const cleared = payload.phase === "failed";
      live.broadcastPendingAgentSwap(cleared ? null : targetAgentId);
      return;
    }
    live.broadcastCompactionPhase(payload);
  }

  // Read summarizedThroughEntry from a session's record (cold or live).
  // Returns undefined when the session has never been compacted or
  // when no record exists at all — callers should check hasRecord()
  // separately to distinguish "unknown" from "never compacted".
  async getSummarizedThroughEntry(sessionId: string): Promise<number | undefined> {
    const live = this.sessions.get(sessionId);
    if (live) {
      return live.summarizedThroughEntry;
    }
    const record = await this.store.read(sessionId).catch(() => undefined);
    return record?.summarizedThroughEntry;
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

  // Startup reconcile: clear stale daemon permission attention flags
  // from every persisted session record. These flags represent
  // permission requests whose agent processes are dead (the daemon
  // crashed or was restarted), so they would otherwise leave
  // awaitingInput=true forever on any client that attaches to the
  // session. Only clears flags where source==="daemon" and
  // reason.startsWith("permission:"). Logs the total count at info.
  async reconcilePermissionFlags(): Promise<void> {
    const records = await this.store.list().catch(() => []);
    let cleared = 0;
    for (const rec of records) {
      const flags = rec.attentionFlags ?? [];
      const kept = flags.filter(
        (f: import("../acp/types-attention.js").AttentionFlag) =>
          !(f.source === "daemon" && f.reason.startsWith("permission:")),
      );
      if (kept.length !== flags.length) {
        const diff = flags.length - kept.length;
        cleared += diff;
        await this.mutateRecord(rec.sessionId, { attentionFlags: kept }).catch(
          () => undefined,
        );
      }
    }
    if (cleared > 0) {
      this.logger?.info(`cleared ${cleared} stale permission attention flags on startup`);
    }
  }

  // Startup hook: scan persisted session records for in-flight
  // compactionState and resume the work. requested/running statuses
  // re-enqueue the full compaction job (idempotent against
  // summarizedThroughEntry); swap_pending/swap_deferred statuses
  // re-enqueue too, since the post-spawn retrySwap path bails for
  // cold sessions at startup. Per-session failures are logged and
  // do not block boot.
  async resumePendingCompactions(): Promise<void> {
    // Only ACTIVE compaction states resume on daemon restart. Terminal
    // states (currently just "failed") stay parked on disk so the user
    // can read lastError via `/hydra compact status` or the picker —
    // auto-resuming a failed compaction would silently retry without
    // user consent and waste tokens on something that already broke.
    // Re-triggering a failed compaction is explicit: `/hydra compact`
    // or POST /v1/sessions/:id/compact.
    const ACTIVE_RESUME_STATES = new Set([
      "requested",
      "running",
      "swap_pending",
      "swap_deferred",
    ]);
    const records = await this.store.list().catch(() => []);
    for (const rec of records) {
      const state = rec.compactionState;
      if (state == null) {
        continue;
      }
      if (!ACTIVE_RESUME_STATES.has(state.status)) {
        this.logger?.info(
          `compaction: not resuming sessionId=${rec.sessionId} status=${state.status} (terminal — user must re-trigger explicitly)`,
        );
        continue;
      }
      this.logger?.info(
        `compaction: resuming sessionId=${rec.sessionId} status=${state.status} from prior daemon`,
      );
      try {
        // compactionState is compaction-only; /hydra agent resume rides
        // on record.pendingAgentSwap, handled by resumePendingAgentSwaps.
        this.scheduleCompaction(rec.sessionId);
      } catch (err) {
        this.logger?.warn(
          `compaction: resume failed for sessionId=${rec.sessionId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // Startup hook for /hydra agent swaps that were in flight when the
  // daemon went down. Two sub-cases:
  //   (1) record.synopsis is fresh (summarizedThroughEntry === current
  //       history length) — the artifact is already in the target's
  //       idiom and there's nothing to summarize. Dispatch the swap
  //       directly; first attach will execute it on idle.
  //   (2) otherwise — reschedule synthesis (target-agent run produces
  //       a fresh artifact incorporating any new turns), then dispatch.
  // Per-session failures are logged and do not block boot.
  async resumePendingAgentSwaps(): Promise<void> {
    const records = await this.store.list().catch(() => []);
    for (const rec of records) {
      const targetAgentId = rec.pendingAgentSwap;
      if (!targetAgentId) {
        continue;
      }
      try {
        const history = await this.histories.load(rec.sessionId).catch(() => []);
        const fresh =
          rec.synopsis !== undefined &&
          rec.summarizedThroughEntry !== undefined &&
          rec.summarizedThroughEntry >= history.length;
        if (fresh && rec.synopsis) {
          this.logger?.info(
            `agent-swap: resuming sessionId=${rec.sessionId} target=${targetAgentId} with persisted synopsis (history=${history.length})`,
          );
          await this.dispatchSynthesisSwap(
            rec.sessionId,
            rec.synopsis,
            rec.summarizedThroughEntry ?? history.length,
            targetAgentId,
          );
        } else {
          this.logger?.info(
            `agent-swap: resuming sessionId=${rec.sessionId} target=${targetAgentId} via fresh synthesis (history=${history.length} watermark=${rec.summarizedThroughEntry ?? "(none)"})`,
          );
          this.scheduleCompaction(rec.sessionId, { targetAgentId });
        }
      } catch (err) {
        this.logger?.warn(
          `agent-swap: resume failed for sessionId=${rec.sessionId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

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
// Exported for direct unit tests of the "read-through" contract:
// every field this function pulls from the on-disk record MUST have
// an explicit `existing?.X` fallback, or a routine session persist
// (from attachManagerHooks / resurrect / create) will clobber it.
// Adding a new persisted field? Add it here AND to the regression
// tests in session-manager.test.ts.
/**
 * Does a session belong to the tree the caller asked about?
 *
 * Matches the session's effective cwd OR, for an isolated session, the
 * source tree it was derived from. Both arms are required, and the second
 * one is the whole point: an isolated session's cwd is its WORKSPACE, so
 * without the sourceCwd arm, filtering by a repository returns none of
 * its isolated sessions. That inverts the query's purpose, since the
 * sessions most worth knowing about (someone else is editing this tree
 * right now) become exactly the ones it cannot see.
 *
 * The result is deliberately asymmetric:
 *
 *   cwd=<repo>       matches plain sessions there AND workspaces from it
 *   cwd=<workspace>  matches only that workspace
 *
 * MUST NOT be implemented as a path-prefix test. Workspaces live outside
 * their source tree and share no prefix with it, so `startsWith` finds
 * nothing; the recorded derivation edge is the only link.
 *
 * Trailing separators are tolerated on the query because a near-miss here
 * returns an empty list, which reads identically to "nothing is running"
 * — the exact wrong conclusion. Symlink resolution is NOT done: it needs
 * async IO on a hot path, and callers already pass resolved paths.
 */
export function matchesCwdFilter(
  want: string | undefined,
  session: { cwd: string; workspace?: { sourceCwd: string } | undefined },
): boolean {
  if (want === undefined || want.length === 0) {
    return true;
  }
  const target = stripTrailingSep(want);
  if (stripTrailingSep(session.cwd) === target) {
    return true;
  }
  const source = session.workspace?.sourceCwd;
  return source !== undefined && stripTrailingSep(source) === target;
}

function stripTrailingSep(p: string): string {
  return p.length > 1 && p.endsWith("/") ? p.replace(/\/+$/, "") : p;
}

export function mergeForPersistence(
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
    // persistableUsage, not currentUsage: meta.json keeps the split
    // (cumulativeCost = retired lives, costAmount = current life) while
    // currentUsage collapses them for the wire.
    currentUsage:
      usageSnapshotToPersisted(session.persistableUsage) ??
      existing?.currentUsage,
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
    priority: session.priority ?? existing?.priority,
    // Live Session is the source of truth for forwardedEnv: it's set
    // from the most recent session/new or session/attach (overwrite
    // semantics, including an explicit empty map) and from the
    // persisted record on cold-resurrect. existing? fallback only
    // matters if the Session somehow has no field at all — shouldn't
    // happen, but keeps round-trip safe for old records.
   forwardedEnv: session.forwardedEnv ?? existing?.forwardedEnv,
    // The live Session is AUTHORITATIVE here, deliberately unlike
    // forwardedEnv above: no `?? existing?.workspace` fallback.
    //
    // Every construction path sets this explicitly from the right source
    // (create from the resolver, resurrect from the record, import-reseed
    // from the recovery ladder). An absent value therefore means "this
    // session is not isolated", which is a real outcome: when a workspace
    // is deleted and cannot be rebuilt, recovery drops the binding and
    // the session resurrects unisolated. Reading the old binding back
    // from disk at that moment would re-attach a session to a directory
    // that no longer exists, and keep it filterable by a source tree it
    // can no longer affect.
    workspace: session.workspace,
    attentionFlags: session.listAttentionFlags(),
    // Preserve extension_state from the on-disk record. The live Session
    // doesn't hold this — extensions read/write it via the daemon RPCs
    // in acp-ws.ts, which mutate the record directly through
    // setExtensionStateKey. Without this pass-through, every routine
    // persistSnapshot (currentUsage / mode / model change) would clobber
    // whatever an extension just wrote.
    extensionState: existing?.extensionState,
    // Must be passed through explicitly: recordFromMemorySession seeds a
    // fresh single-entry chain from the current upstream when this is
    // absent, so omitting it here would silently truncate the lineage on
    // every routine persist. Re-running the append also makes this path
    // self-healing if a rotation persisted through here before
    // persistAgentChange ran; it's idempotent on the current upstream.
    upstreamGenerations: existing
      ? appendUpstreamGeneration(existing, session.agentId, session.upstreamSessionId)
      : undefined,
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
// Generic four-step search for an extractor: top-level direct fields,
// the nested object (`models` / `modes`), each non-hydra `_meta`
// namespace, then the matching `configOptions` entry. `fromObject` is
// applied to the result root, the nested object, and each _meta value
// in turn; the first non-empty hit wins. `fromConfig` is applied to
// the configOption entry. Returns undefined when nothing matches.
//
// The four extractors below differ only in which keys they probe at
// each layer, so they're written as small closure tables passed in.
function searchInitial<T>(
  result: Record<string, unknown>,
  spec: {
    nestedKey: "models" | "modes";
    configId: "model" | "mode";
    fromObject: (obj: Record<string, unknown>) => T | undefined;
    fromConfig: (entry: { currentValue?: unknown; options?: unknown }) => T | undefined;
  },
): T | undefined {
  const direct = spec.fromObject(result);
  if (direct !== undefined) {
    return direct;
  }
  const nested = result[spec.nestedKey];
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const v = spec.fromObject(nested as Record<string, unknown>);
    if (v !== undefined) {
      return v;
    }
  }
  const meta = result._meta;
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    for (const [key, value] of Object.entries(meta as Record<string, unknown>)) {
      // Hydra's own _meta namespace is informational; skip it.
      if (key === "hydra-acp") {
        continue;
      }
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const v = spec.fromObject(value as Record<string, unknown>);
        if (v !== undefined) {
          return v;
        }
      }
    }
  }
  const entry = findConfigOptionEntry(result, spec.configId);
  if (entry) {
    const v = spec.fromConfig(entry);
    if (v !== undefined) {
      return v;
    }
  }
  return undefined;
}

export function extractInitialModel(
  result: Record<string, unknown>,
): string | undefined {
  return searchInitial<string>(result, {
    nestedKey: "models",
    configId: "model",
    fromObject: (o) =>
      asString(o.currentModelId) ??
      asString(o.currentModel) ??
      asString(o.modelId) ??
      asString(o.model),
    fromConfig: (e) => asString(e.currentValue),
  });
}

// If `err` is an AUTH_REQUIRED JSON-RPC error from a child agent,
// return a fresh Error preserving its code and message but with the
// child's advertised authMethods and agentId merged into
// data._meta['hydra-acp']. Otherwise return `err` unchanged so callers
// can `throw enrichAuthRequired(err, agent)` without branching. Editors
// and the TUI consume the enriched envelope to render an onboarding
// flow that lists the agent's real auth methods instead of an opaque
// code; the recovery (import-reseed) path must NOT run for AUTH_REQUIRED
// since that path exists for missing-upstream-id, not unauthenticated
// agents.
export function enrichAuthRequired(
  err: unknown,
  agent: { agentId: string; authMethods?: AuthMethod[] },
): unknown {
  if (!err || typeof err !== "object") {
    return err;
  }
  const e = err as { code?: unknown; message?: unknown; data?: unknown };
  if (e.code !== JsonRpcErrorCodes.AuthRequired) {
    return err;
  }
  const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === "object" && !Array.isArray(v);
  const baseData = isPlainObject(e.data) ? e.data : {};
  const baseMeta = isPlainObject(baseData._meta) ? baseData._meta : {};
  const baseHydra = isPlainObject(baseMeta["hydra-acp"])
    ? baseMeta["hydra-acp"]
    : {};
  const message =
    typeof e.message === "string" ? e.message : "authentication required";
  const next = new Error(message) as Error & {
    code: number;
    data: Record<string, unknown>;
  };
  next.code = JsonRpcErrorCodes.AuthRequired;
  next.data = {
    ...baseData,
    _meta: {
      ...baseMeta,
      "hydra-acp": {
        ...baseHydra,
        authMethods: agent.authMethods ?? [],
        agentId: agent.agentId,
      },
    },
  };
  return next;
}

// Spawn details for the repro hint appended to a bring-up failure.
export interface BringupSpawnInfo {
  command: string;
  args: string[];
  cwd: string;
}

// Single-quote a token for a copy-pasteable shell command, leaving the
// common safe set bare. Keeps the repro line runnable when args contain
// spaces or shell metacharacters.
function shellQuote(token: string): string {
  if (/^[A-Za-z0-9_\-./=:@]+$/.test(token)) {
    return token;
  }
  return `'${token.replace(/'/g, "'\\''")}'`;
}

// When a fresh agent dies during initialize/session-new, the daemon↔agent
// stream can close before the child-exit handler attaches its stderr tail
// — the in-flight request then rejects with a bare "connection closed".
// Fold in whatever we actually know so the client can report *why* it
// failed instead of an opaque connection error: the agent's captured
// stderr, plus a copy-pasteable command line (and cwd) so the user can run
// the agent by hand and reproduce. Auth errors pass through untouched so
// enrichAuthRequired still recognizes them; an error already carrying a
// stderr tail isn't re-stderr'd, only given the repro hint.
export function enrichBringupFailure(
  err: unknown,
  agent: AgentInstance,
  agentId: string,
  spawn?: BringupSpawnInfo,
): unknown {
  if (
    err &&
    typeof err === "object" &&
    (err as { code?: unknown }).code === JsonRpcErrorCodes.AuthRequired
  ) {
    return err;
  }
  const base = err instanceof Error ? err.message : String(err);
  const alreadyEnriched = base.includes("stderr:");
  const tail = alreadyEnriched ? "" : agent.stderrTailText();
  const reproLine = spawn
    ? `to reproduce: (cd ${shellQuote(spawn.cwd)} && ${[spawn.command, ...spawn.args]
        .map(shellQuote)
        .join(" ")})`
    : "";
  // Nothing extra to add — leave the error exactly as-is.
  if (!tail && !reproLine) {
    return err;
  }
  const lines = [alreadyEnriched ? base : `agent ${agentId} failed to start: ${base}`];
  if (tail) {
    lines.push(`stderr: ${tail}`);
  }
  if (reproLine) {
    lines.push(reproLine);
  }
  const next = new Error(lines.join("\n")) as Error & {
    code?: number;
    data?: unknown;
  };
  if (err && typeof err === "object") {
    const e = err as { code?: number; data?: unknown };
    if (typeof e.code === "number") {
      next.code = e.code;
    }
    if (e.data !== undefined) {
      next.data = e.data;
    }
  }
  return next;
}

// Validate and narrow a raw initialize.authMethods payload to the
// strict AuthMethod[] shape. Drops malformed entries silently; returns
// undefined when the field is absent or yields zero valid entries, so
// callers can treat "agent didn't advertise auth" and "agent sent junk"
// the same way.
function parseAuthMethods(value: unknown): AuthMethod[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out: AuthMethod[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== "string") {
      continue;
    }
    const description = typeof e.description === "string" ? e.description : "";
    const type = e.type === "agent" || e.type === "terminal" ? e.type : undefined;
    const name = typeof e.name === "string" ? e.name : undefined;
    const rawMeta = e._meta;
    const meta =
      rawMeta !== null &&
      typeof rawMeta === "object" &&
      !Array.isArray(rawMeta)
        ? (rawMeta as Record<string, unknown>)
        : undefined;
    out.push({
      id: e.id,
      description,
      ...(type && { type }),
      ...(name !== undefined && { name }),
      ...(meta && { _meta: meta }),
    });
  }
  return out.length > 0 ? out : undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// opencode 1.15.13+ moved its model/mode advertisement out of the spec
// `availableModels` / `availableModes` fields and into a top-level
// `configOptions` array on the session/new and session/load responses,
// keyed by `id` ("model", "mode", "effort", …). Pull the matching entry
// so the extractInitial* helpers below can fall back to it when the
// agent doesn't use the spec shapes. Returns undefined if `configOptions`
// is missing, malformed, or has no entry with the requested id.
function findConfigOptionEntry(
  result: Record<string, unknown>,
  id: string,
): { currentValue?: unknown; options?: unknown } | undefined {
  const list = result.configOptions;
  if (!Array.isArray(list)) {
    return undefined;
  }
  for (const raw of list) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      continue;
    }
    const entry = raw as Record<string, unknown>;
    if (entry.id === id) {
      return entry;
    }
  }
  return undefined;
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
  return (
    searchInitial<AdvertisedModel[]>(result, {
      nestedKey: "models",
      configId: "model",
      fromObject: (o) => {
        const parsed = parseModelsList(o.availableModels);
        return parsed.length > 0 ? parsed : undefined;
      },
      fromConfig: (e) => {
        const parsed = parseModelsList(e.options);
        return parsed.length > 0 ? parsed : undefined;
      },
    }) ?? []
  );
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
  return (
    searchInitial<AdvertisedMode[]>(result, {
      nestedKey: "modes",
      configId: "mode",
      fromObject: (o) => {
        const parsed = parseModesList(o.availableModes);
        return parsed.length > 0 ? parsed : undefined;
      },
      fromConfig: (e) => {
        const parsed = parseModesList(e.options);
        return parsed.length > 0 ? parsed : undefined;
      },
    }) ?? []
  );
}

// Pull a current-mode id from a session/new or session/load response.
// Mirrors extractInitialModel's structure.
export function extractInitialCurrentMode(
  result: Record<string, unknown>,
): string | undefined {
  return searchInitial<string>(result, {
    nestedKey: "modes",
    configId: "mode",
    fromObject: (o) =>
      asString(o.currentModeId) ??
      asString(o.currentMode) ??
      asString(o.modeId) ??
      asString(o.mode),
    fromConfig: (e) => asString(e.currentValue),
  });
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

// Append a generation entry for the upstream the session just rotated
// onto, closing out the previous one.
//
// Seeding: a record written before upstreamGenerations existed has no
// list, so the first rotation after upgrade back-fills the upstream it
// is rotating *away from* before appending the new one. That recovers
// one generation of history for free; anything older than that is gone
// and only a ledger-side reconstruction can find it. The seeded entry
// carries no startedAt because it was never recorded — see the schema.
//
// Idempotent on upstreamSessionId: a rotation that lands on the same
// upstream (a resurrect that reloads the same agent session) is not a
// new generation and must not double-append, or cost attribution would
// count that upstream twice.
export function appendUpstreamGeneration(
  prev: SessionRecord,
  agentId: string,
  upstreamSessionId: string,
  now: string = new Date().toISOString(),
  retiredCost?: number,
): UpstreamGeneration[] {
  const seeded: UpstreamGeneration[] =
    prev.upstreamGenerations && prev.upstreamGenerations.length > 0
      ? [...prev.upstreamGenerations]
      : prev.upstreamSessionId
        ? [{ upstreamSessionId: prev.upstreamSessionId, agentId: prev.agentId }]
        : [];

  const last = seeded[seeded.length - 1];
  if (last && last.upstreamSessionId === upstreamSessionId) {
    // Already on this upstream. Either an idempotent re-notify, or a
    // routine persist (mergeForPersistence) beat us to the append and
    // closed the previous entry without a cost — it has no retiredCost to
    // pass. Back-fill it here so the figure isn't lost to that race.
    if (retiredCost !== undefined && seeded.length >= 2) {
      const retiring = seeded[seeded.length - 2];
      if (retiring && retiring.cost === undefined) {
        seeded[seeded.length - 2] = { ...retiring, cost: retiredCost };
      }
    }
    return seeded;
  }
  if (last && last.endedAt === undefined) {
    seeded[seeded.length - 1] = {
      ...last,
      endedAt: now,
      // Stamp the retiring generation's spend while we still know it. A
      // rollback re-enters an upstream, so a later stint on the same
      // upstream gets its own entry and its own cost — consumers must sum
      // per entry for time attribution but dedupe by upstream id when
      // joining an external per-session ledger.
      ...(retiredCost !== undefined ? { cost: retiredCost } : {}),
    };
  }
  seeded.push({ upstreamSessionId, agentId, startedAt: now });
  return seeded;
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
