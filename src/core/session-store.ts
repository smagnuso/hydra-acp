import * as fs from "node:fs/promises";
import * as path from "node:path";
import { customAlphabet } from "nanoid";
import { z } from "zod";
import { paths } from "./paths.js";
import { readJsonSafe, writeJsonAtomic } from "./json-store.js";
import type { AttentionFlag } from "../acp/types-attention.js";
import { AttentionFlagArraySchema } from "../acp/types-attention.js";
import { CompactionState, SessionSynopsis } from "./snapshot.js";

// Mirror the alphabet/length used for session ids (see session.ts). Plain
// alphanumeric, length 16 → ~95 bits — collisions across a personal
// fleet are vanishingly unlikely.
const HYDRA_ID_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const generateRawId = customAlphabet(HYDRA_ID_ALPHABET, 16);

export const HYDRA_LINEAGE_PREFIX = "hydra_lineage_";

// Stable identifier set once when a session is first created. Preserved
// through every export/import so re-importing the same session (even
// after multi-hop transfers A→B→C→A) can be detected and either
// rejected or replaced. Distinct from sessionId, which is regenerated
// fresh on every import to avoid collisions in the local namespace.
export function generateLineageId(): string {
  return `${HYDRA_LINEAGE_PREFIX}${generateRawId()}`;
}

// One agent-advertised command. Shape mirrors the
// available_commands_update notification's entries (name + description),
// stored persistently here so attach responses can deliver the merged
// (hydra ∪ agent) command list to clients without depending on history
// replay of a notification that may have aged out.
export const PersistedAgentCommand = z.object({
  name: z.string(),
  description: z.string().optional(),
});
export type PersistedAgentCommand = z.infer<typeof PersistedAgentCommand>;

// One agent-advertised mode. Shape mirrors available_modes_update entries.
export const PersistedAgentMode = z.object({
  id: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
});
export type PersistedAgentMode = z.infer<typeof PersistedAgentMode>;

// One agent-advertised model. Shape mirrors current_model_update's
// availableModels entries (spec: { modelId, name?, description? }).
export const PersistedAgentModel = z.object({
  modelId: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
});
export type PersistedAgentModel = z.infer<typeof PersistedAgentModel>;

// Last-known snapshot of a session's usage_update notification. Fields
// mirror the wire shape but flattened (costAmount/costCurrency rather
// than a nested cost object) so partial updates can merge cleanly.
// Every field is optional — agents emit varying subsets, and we want a
// fresh event to update only what it carries while preserving prior
// values for everything else.
export const PersistedUsage = z.object({
  used: z.number().optional(),
  size: z.number().optional(),
  costAmount: z.number().optional(),
  costCurrency: z.string().optional(),
  cumulativeCost: z.number().optional(),
});
export type PersistedUsage = z.infer<typeof PersistedUsage>;

// Identity of the process that issued the session/new request, captured
// from `clientInfo` on its initialize call. Used by list views to filter
// out short-lived ancillary sessions (e.g. `hydra cat`) by default.
export const PersistedOriginatingClient = z.object({
  name: z.string(),
  version: z.string().optional(),
});
export type PersistedOriginatingClient = z.infer<
  typeof PersistedOriginatingClient
>;

// Breadcrumb written to meta.json immediately after a compaction swap
// completes. Allows rollback to the pre-swap upstream session while the
// window is still safe (no new turns since the swap). Cleared on:
// rollback success, any subsequent real agent turn, and any subsequent swap.
export const RollbackBreadcrumb = z.object({
  previousUpstreamSessionId: z.string(),
  previousSummarizedThroughEntry: z.number().int().nonnegative().optional(),
});
export type RollbackBreadcrumb = z.infer<typeof RollbackBreadcrumb>;

export const SessionRecord = z.object({
  version: z.literal(1),
  sessionId: z.string(),
  // Optional for back-compat with records written before this field
  // existed; mergeForPersistence generates one on next write so any
  // touched session converges to having a lineageId. A record that
  // never gets written again (truly cold and untouched) just won't
  // participate in lineage-based dedup, which is correct — it was
  // never exported, so no incoming bundle can claim its lineage.
  lineageId: z.string().optional(),
  upstreamSessionId: z.string(),
  // When non-empty, marks a session that was created by import and is
  // waiting for its first attach to bootstrap a fresh upstream agent
  // and replay the imported history as a takeover transcript. The
  // origin's local id at export time, kept for debuggability and as a
  // breadcrumb in `sessions list` (informational, not used for routing).
  importedFromSessionId: z.string().optional(),
  // Origin's agent-side session id at export time. Carried as a
  // breadcrumb and as the handle a future "connect back to origin"
  // feature would dial. Absent when the origin record had no upstream
  // bound (re-export of an imported, not-yet-attached session).
  importedFromUpstreamSessionId: z.string().optional(),
  // Hostname of the machine that exported the bundle we imported
  // (i.e. the most recent hop, not necessarily the true multi-hop
  // origin). Surfaced in the picker so imported rows don't look like
  // they materialized from nowhere.
  importedFromMachine: z.string().optional(),
  agentId: z.string(),
  cwd: z.string(),
  title: z.string().optional(),
  // Structured digest of the conversation, produced by the agent in the
  // same `runInternalPrompt` turn that regenerates the title. Persisted
  // here so picker / list_recent / archive bundles surface it without
  // re-asking the agent. Regenerated on idle-close, daemon shutdown,
  // picker T, and /hydra title with no arg — every regen caller checks
  // `summarizedThroughEntry` first and no-ops if history hasn't grown.
  synopsis: SessionSynopsis.optional(),
  // Persistent state for an in-flight async compaction job. Present from
  // the moment compaction is scheduled until the swap completes or is
  // abandoned. S2-S4 read this field; nothing else should invent state.
  compactionState: CompactionState.optional(),
  // Set after a compaction swap so the user can roll back within the
  // safe window (no new turns). Cleared on first post-swap agent turn,
  // on successful rollback, and when a subsequent swap supersedes it.
  rollbackBreadcrumb: RollbackBreadcrumb.optional(),
  // history.length at the last successful snapshot regen. Idempotency
  // guard: if current history length <= this value, regen is a no-op.
  summarizedThroughEntry: z.number().int().nonnegative().optional(),
  agentArgs: z.array(z.string()).optional(),
  // Snapshot of "what is currently true about this session" carried in
  // meta.json so a late-attaching or cold-resurrected client can be
  // told via the attach response _meta without depending on history
  // replay of a snapshot-shaped notification.
  currentModel: z.string().optional(),
  currentMode: z.string().optional(),
  currentUsage: PersistedUsage.optional(),
  agentCommands: z.array(PersistedAgentCommand).optional(),
  agentModes: z.array(PersistedAgentMode).optional(),
  agentModels: z.array(PersistedAgentModel).optional(),
  // One-shot flag set when `hydra agent sync` mints a row from an
  // agent-side session/list entry: signals that the first resurrect
  // should *keep* the agent's session/load replay (instead of draining
  // it) so the local history.jsonl gets populated from the agent's
  // memory. Cleared after that first resurrect completes.
  pendingHistorySync: z.boolean().optional(),
  // Breadcrumb set by `/hydra agent <id>` while the swap is in flight.
  // Names the target agent. The synthesis artifact lives on `synopsis`
  // and is generated in the target's idiom so resume-after-restart can
  // dispatch the swap immediately when history hasn't grown. Cleared
  // when the cross-agent swap completes (or the user re-targets).
  pendingAgentSwap: z.string().optional(),
  // Set when this session was spawned as a child by a transformer via
  // hydra-acp/child_session/spawn. Points to the spawning session's id.
  parentSessionId: z.string().optional(),
  // Set when this session was created by hydra-acp/session/fork.
  // forkedFromSessionId points to the local source session; forkedFromMessageId
  // is the resolved forkAt — the messageId of the turn_complete the slice
  // ended at. Kept so future UI can show "branched from turn N of session X".
  forkedFromSessionId: z.string().optional(),
  forkedFromMessageId: z.string().optional(),
  // When set, this fork session's background synopsis generation is in
  // progress ("running") or terminated abnormally ("failed"). Absent means
  // either not a synthesis fork, or synopsis already landed (check `synopsis`
  // field). Cleared (field removed) on successful completion so list
  // endpoints treat "absent" as the normal/quiet state.
  forkSynthesisState: z.enum(["running", "failed"]).optional(),
  // clientInfo from the process that issued session/new. Display only
  // since the `interactive` flag below; kept on the record for log
  // attribution and as the legacy hint inside effectiveInteractive
  // (pre-flag cat sessions can be recognised from this field).
  originatingClient: PersistedOriginatingClient.optional(),
  // Tristate: true once the session has had a real turn, false when
  // explicitly created as ancillary (e.g. `hydra cat`), undefined for
  // pre-flag records / freshly-created sessions that haven't decided
  // yet. effectiveInteractive() in session-manager.ts is the single
  // resolver — every filter site goes through it.
  interactive: z.boolean().optional(),
  // User-set sort weight. Non-negative integer; 0 (or absent) is the
  // default "normal" priority, any positive value floats the session to
  // the top of the picker regardless of live/cold status. Higher values
  // win ties between two prioritised rows. Toggled from the picker with
  // `*`; no agent involvement, no broadcast — picker auto-refresh picks
  // it up on the next tick.
  priority: z.number().int().nonnegative().optional(),
  // Caller-supplied environment variables to forward into the child
  // agent process on every spawn for this session (brand-new agent,
  // cold-resurrect, and respawn paths). Overwritten in full when a
  // session/new or session/attach arrives with a fresh
  // _meta["hydra-acp"].env map. Stored here so resurrect after a
  // daemon restart restores the same spawn-env.
  forwardedEnv: z.record(z.string(), z.string()).optional(),
  // Per-session attention flags persisted to meta.json so cold-resurrected
  // sessions surface the correct awaitingInput state without depending on
  // history replay. Reconciled from disk on every load.
  attentionFlags: AttentionFlagArraySchema.default([]).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SessionRecord = z.infer<typeof SessionRecord>;

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function assertSafeId(id: string): void {
  if (!SESSION_ID_PATTERN.test(id)) {
    throw new Error(`unsafe session id: ${id}`);
  }
}

export class SessionStore {
  async write(record: Omit<SessionRecord, "version">): Promise<void> {
    assertSafeId(record.sessionId);
    const full: SessionRecord = { version: 1, ...record };
    await writeJsonAtomic(paths.sessionFile(record.sessionId), full, {
      mode: 0o600,
    });
  }

  async read(sessionId: string): Promise<SessionRecord | undefined> {
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      return undefined;
    }
    const parsed = await readJsonSafe(paths.sessionFile(sessionId));
    if (parsed === undefined) {
      return undefined;
    }
    try {
      return SessionRecord.parse(parsed);
    } catch {
      return undefined;
    }
  }

  async delete(sessionId: string): Promise<void> {
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      return;
    }
    try {
      await fs.unlink(paths.sessionFile(sessionId));
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "ENOENT") {
        throw err;
      }
    }
    // Best-effort cleanup: if no other tenant (transcript, etc.) is
    // left in the session dir, drop it. Both this and
    // TranscriptStore.delete attempt this; whichever runs last (after
    // both files are gone) is the one that succeeds.
    try {
      await fs.rmdir(paths.sessionDir(sessionId));
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "ENOENT" && e.code !== "ENOTEMPTY") {
        throw err;
      }
    }
  }

  // Find a persisted session by lineageId. Used by SessionManager.import
  // to detect bundles that have already been imported (lineageId match)
  // so we can either error out or, with replace:true, overwrite.
  // Returns undefined if no record has that lineageId. Records that
  // pre-date the lineageId field simply don't match — which is
  // correct: they were never exported, so no incoming bundle can
  // legitimately claim their lineage.
  async findByLineageId(lineageId: string): Promise<SessionRecord | undefined> {
    if (lineageId.length === 0) {
      return undefined;
    }
    const all = await this.list().catch(() => []);
    for (const record of all) {
      if (record.lineageId === lineageId) {
        return record;
      }
    }
    return undefined;
  }

  async list(): Promise<SessionRecord[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(paths.sessionsDir());
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        return [];
      }
      throw err;
    }
    // Read all per-session meta.json files in parallel. The previous
    // serial loop was O(N) sequential fs ops; on long-lived installs
    // (1000+ sessions) that added ~100ms per list() call and got
    // hammered by the extension pollers. Parallel reads keep the same
    // ordering semantics (the caller doesn't depend on directory order)
    // and let the kernel coalesce dirent stats.
    const settled = await Promise.all(
      entries.map((entry) =>
        // Each session is a directory under sessions/; non-conforming
        // names get filtered by assertSafeId via read().
        this.read(entry).catch(() => undefined),
      ),
    );
    const records: SessionRecord[] = [];
    for (const record of settled) {
      if (record) {
        records.push(record);
      }
    }
    return records;
  }
}

export function recordFromMemorySession(args: {
  sessionId: string;
  lineageId?: string;
  upstreamSessionId: string;
  importedFromSessionId?: string;
  importedFromUpstreamSessionId?: string;
  importedFromMachine?: string;
  agentId: string;
  cwd: string;
  title?: string;
  synopsis?: SessionSynopsis;
  summarizedThroughEntry?: number;
  agentArgs?: string[];
  currentModel?: string;
  currentMode?: string;
  currentUsage?: PersistedUsage;
  agentCommands?: PersistedAgentCommand[];
  agentModes?: PersistedAgentMode[];
  agentModels?: PersistedAgentModel[];
  pendingHistorySync?: boolean;
  pendingAgentSwap?: string;
  parentSessionId?: string;
  forkedFromSessionId?: string;
  forkedFromMessageId?: string;
  forkSynthesisState?: "running" | "failed";
  originatingClient?: PersistedOriginatingClient;
  interactive?: boolean;
  priority?: number;
  forwardedEnv?: Record<string, string>;
  compactionState?: CompactionState;
  rollbackBreadcrumb?: RollbackBreadcrumb;
  attentionFlags?: AttentionFlag[];
  createdAt?: string;
  updatedAt?: string;
}): Omit<SessionRecord, "version"> {
  const now = new Date().toISOString();
  return {
    sessionId: args.sessionId,
    lineageId: args.lineageId,
    upstreamSessionId: args.upstreamSessionId,
    importedFromSessionId: args.importedFromSessionId,
    importedFromUpstreamSessionId: args.importedFromUpstreamSessionId,
    importedFromMachine: args.importedFromMachine,
    agentId: args.agentId,
    cwd: args.cwd,
    title: args.title,
    synopsis: args.synopsis,
    summarizedThroughEntry: args.summarizedThroughEntry,
    compactionState: args.compactionState,
    rollbackBreadcrumb: args.rollbackBreadcrumb,
    agentArgs: args.agentArgs,
    currentModel: args.currentModel,
    currentMode: args.currentMode,
    currentUsage: args.currentUsage,
    agentCommands: args.agentCommands,
    agentModes: args.agentModes,
    agentModels: args.agentModels,
    pendingHistorySync: args.pendingHistorySync,
    pendingAgentSwap: args.pendingAgentSwap,
    parentSessionId: args.parentSessionId,
    forkedFromSessionId: args.forkedFromSessionId,
    forkedFromMessageId: args.forkedFromMessageId,
    forkSynthesisState: args.forkSynthesisState,
    originatingClient: args.originatingClient,
    interactive: args.interactive,
    priority: args.priority,
    forwardedEnv: args.forwardedEnv,
      attentionFlags: args.attentionFlags ?? [],
    createdAt: args.createdAt ?? now,
    updatedAt: args.updatedAt ?? now,
  };
}

void path;
