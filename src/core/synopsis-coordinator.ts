// Background queue for ephemeral-agent synopsis generation. The original
// `Session` is already dead by the time a job runs here — this pulls the
// cold record + history.jsonl from disk, spawns a fresh ephemeral agent
// (see ./synopsis-agent.ts), and persists the result via caller-supplied
// `persistSynopsis` / `persistTitle` hooks.
//
// Concurrency is bounded so that a daemon shutdown with N warm sessions
// doesn't fork N agent processes at once. Dedup is by sessionId: the
// same session can't have two synopsis jobs in flight.
//
// Idempotency mirrors the prior in-session regen:
//   - history.length > summarizedThroughEntry → run
//   - history.length <= summarizedThroughEntry → skip (no new conversation)
// A record that's never been synopsized has summarizedThroughEntry
// undefined; in that case we always run on the first schedule (even if
// the history is empty — caller decides whether to bother scheduling).
//
// Agent + model selection:
//   - `synopsisAgent` (config): overrides the source agent. Useful when
//     you want every synopsis run on a cheap+reliable JSON producer
//     regardless of what produced the conversation.
//   - `synopsisModel` (config): override model for the synopsis turn.
//   - Both unset → fall back to the session's source agent and let it
//     pick its default model.

import * as fs from "node:fs/promises";
import { generateCompaction, generateSynopsis } from "./synopsis-agent.js";
import type { AgentLogger } from "./agent-instance.js";
import {
  planSpawn,
  type Registry,
} from "./registry.js";
import type { HistoryStore } from "./history-store.js";
import type { SessionStore } from "./session-store.js";
import type { CompactionState, SessionSynopsis } from "./snapshot.js";
import { extractFilesTouched, extractToolsUsed } from "./history-aggregate.js";
import { paths } from "./paths.js";

export interface SynopsisCoordinatorOptions {
  registry: Registry;
  store: SessionStore;
  histories: HistoryStore;
  // Optional override: every synopsis runs on this agent. When unset
  // (or unknown to the registry), the source session's agentId is used.
  synopsisAgent?: string;
  // Optional override: model id to set on the ephemeral agent. When
  // unset, the agent picks its own default.
  synopsisModel?: string;
  // Optional override: agent for compaction jobs. Falls through to
  // synopsisAgent when unset.
  compactionAgent?: string;
  // Optional override: model for compaction jobs. Falls through to
  // synopsisModel when unset.
  compactionModel?: string;
  persistTitle: (sessionId: string, title: string) => Promise<void>;
  persistSynopsis: (
    sessionId: string,
    synopsis: SessionSynopsis,
    summarizedThroughEntry: number,
  ) => Promise<void>;
  logger?: AgentLogger;
  // Bounded so a shutdown with many warm sessions doesn't fork the box.
  // Each job spawns a full agent process + LLM call; 2 is plenty.
  maxConcurrent?: number;
  npmRegistry?: string;
  // Override the default 120s ephemeral timeout for tests.
  generateTimeoutMs?: number;
  // Called after persisting a compaction result. Used by the manager to
  // dispatch a swap of the compaction artifact into the warm session.
  // `targetAgentId`, when set, signals this was a /hydra agent job —
  // the dispatcher swaps to that agent instead of rotating in place.
  onSynthesisArtifact?: (
    sessionId: string,
    artifact: SessionSynopsis,
    summarizedThroughEntry: number,
    targetAgentId?: string,
  ) => Promise<void>;
  // Max iterations for the compaction catch-up loop. Default 3.
  compactionMaxIterations?: number;
  // Called on each compaction state transition so the caller can persist
  // the state machine. null means "clear the state" (not used by the
  // coordinator; the coordinator only writes requested/running/iter).
  // ctx.targetAgentId is set when the job came from /hydra agent — the
  // SessionManager branches on it to route the event to the agent-swap
  // observer (session_info_update with pendingAgentSwap) instead of the
  // compaction observer (compactionState + hydra_compaction).
  onCompactionStateChange?: (
    sessionId: string,
    state: CompactionState,
    ctx: { targetAgentId?: string },
  ) => Promise<void>;
  // Called to push a hydra_compaction session/update notification to
  // any attached clients. The coordinator only fires started/iteration
  // phases; session-manager fires deferred/swapped/failed from its paths.
  broadcastHydraCompaction?: (
    sessionId: string,
    payload: HydraCompactionPayload,
    ctx: { targetAgentId?: string },
  ) => void;
}

export type HydraCompactionPayload =
  | { sessionUpdate: "hydra_compaction"; phase: "started"; requestedAt: number }
  | { sessionUpdate: "hydra_compaction"; phase: "iteration"; iter: number; historyLen: number }
  | { sessionUpdate: "hydra_compaction"; phase: "deferred"; attempts: number }
  | { sessionUpdate: "hydra_compaction"; phase: "swapped"; title?: string; summarizedThroughEntry: number }
  | { sessionUpdate: "hydra_compaction"; phase: "failed"; error: string };

const DEFAULT_MAX_CONCURRENT = 2;
type JobKind = "title" | "compaction";
interface QueuedJob {
  kind: JobKind;
  // Set when scheduleCompaction was called for a /hydra agent switch.
  // Forces the ephemeral synthesizer to run on this agent (so the
  // artifact is in the target's idiom) and is plumbed through to
  // onSynthesisArtifact so the dispatcher knows to swap to it.
  targetAgentId?: string;
}

export class SynopsisCoordinator {
  private queued: Record<string, QueuedJob> = {};
  private inflight = new Map<string, Promise<void>>();
  private stopped = false;
  private readonly maxConcurrent: number;

  constructor(private readonly opts: SynopsisCoordinatorOptions) {
    this.maxConcurrent = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  }

  schedule(sessionId: string): void {
    if (this.stopped) {
      return;
    }
    if (this.inflight.has(sessionId)) {
      return;
    }
    if (sessionId in this.queued) {
      // Title is already queued → no-op for title scheduling.
      // Compaction is queued → no-op.
      return;
    }
    this.queued[sessionId] = { kind: "title" };
    void this.drain();
  }

  scheduleCompaction(sessionId: string, opts?: { targetAgentId?: string }): void {
    if (this.stopped) {
      return;
    }
    const targetAgentId = opts?.targetAgentId;
    if (this.inflight.has(sessionId)) {
      return;
    }
    const existing = this.queued[sessionId];
    if (existing && existing.kind === "title") {
      // Promote title to compaction, carrying any targetAgentId.
      this.queued[sessionId] = { kind: "compaction", ...(targetAgentId ? { targetAgentId } : {}) };
      return;
    }
    // Already compaction or not queued → set and drain. Note: a second
    // scheduleCompaction call overrides a prior targetAgentId — last
    // writer wins, mirroring how /hydra agent X then /hydra agent Y
    // should resolve to Y.
    this.queued[sessionId] = { kind: "compaction", ...(targetAgentId ? { targetAgentId } : {}) };
    void this.drain();
  }

  size(): { queued: number; inflight: number } {
    const queuedCount = Object.keys(this.queued).length;
    return { queued: queuedCount, inflight: this.inflight.size };
  }

  async flush(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Object.keys(this.queued).length > 0 || this.inflight.size > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return;
      }
      const promises = [...this.inflight.values()];
      if (promises.length === 0) {
        await new Promise<void>((r) => {
          const t = setTimeout(r, 25);
          t.unref?.();
        });
        continue;
      }
      await Promise.race([
        Promise.race(promises),
        new Promise<void>((r) => {
          const t = setTimeout(r, remaining);
          t.unref?.();
        }),
      ]);
    }
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    this.queued = {};
    await Promise.allSettled([...this.inflight.values()]);
  }

  private drain(): void {
    if (this.stopped) {
      return;
    }
    while (this.inflight.size < this.maxConcurrent && Object.keys(this.queued).length > 0) {
      const keys = Object.keys(this.queued);
      const sessionId = keys[0];
      if (!sessionId) {
        return;
      }
      const job = this.queued[sessionId] as QueuedJob;
      delete this.queued[sessionId];
      const p = this.runOne(sessionId, job).finally(() => {
        this.inflight.delete(sessionId);
        this.drain();
      });
      this.inflight.set(sessionId, p);
    }
  }

  private async runOne(
    sessionId: string,
    job: QueuedJob,
  ): Promise<void> {
    const jobKind = job.kind;
    const targetAgentId = job.targetAgentId;
    try {
      const record = await this.opts.store.read(sessionId);
      if (!record) {
        this.opts.logger?.info(
          `synopsis: session ${sessionId} record missing; skipping`,
        );
        return;
      }
      // Uncapped: the watermark/length comparison below must see ALL
      // entries on disk, otherwise once history.jsonl exceeds the store's
      // default cap (10k) the array length silently freezes at the cap
      // and every subsequent compaction reports "history unchanged".
      const history = await this.opts.histories.load(sessionId, { maxEntries: Infinity });
      const last = record.summarizedThroughEntry;
      // First-ever run: regardless of history length. Subsequent: only
      // when history grew past the last offset.
      if (last !== undefined && history.length <= last) {
        this.opts.logger?.info(
          `synopsis: skip ${sessionId} (history unchanged at ${history.length})`,
        );
        return;
      }
      // Pick agent. Compaction and title are independent concerns with
      // different cost/quality tradeoffs, so the two knobs do NOT cascade:
      // an unset compactionAgent does not silently inherit synopsisAgent.
      // Fallthrough for each job kind is to the session's own agentId,
      // letting the user opt either knob in/out without affecting the
      // other. If neither resolves to a registered agent we skip the job.
      // targetAgentId (from /hydra agent) takes precedence over the
      // compactionAgent config — the artifact must be in the new
      // agent's idiom because it's what that agent will consume.
      const synopsisAgentId = jobKind === "compaction"
        ? (targetAgentId ?? this.opts.compactionAgent ?? record.agentId)
        : (this.opts.synopsisAgent ?? record.agentId);
      const agentDef = await this.opts.registry.getAgent(synopsisAgentId);
      if (!agentDef) {
        this.opts.logger?.warn(
          `synopsis: agent ${synopsisAgentId} not in registry for session ${sessionId}; skipping`,
        );
        return;
      }
      const plan = await planSpawn(agentDef, [], {
        npmRegistry: this.opts.npmRegistry,
      });
      // Model selection rules:
      //   - title  : synopsisModel or the agent's own default.
      //   - compaction:
      //       1. compactionModel if set (explicit user override).
      //       2. otherwise, when we're also using the session's own
      //          agent (no compactionAgent override), inherit the
      //          session's currentModel. Compaction on the session's
      //          own agent should produce its summary on the model
      //          that's been doing the actual work, not whatever the
      //          ephemeral agent's startup config happens to default
      //          to — those defaults are often friendly aliases that
      //          fail to resolve in a fresh process.
      //       3. otherwise (compactionAgent IS overridden), undefined
      //          so the override agent picks its own default — the
      //          parent's model id may not be advertised by a
      //          different agent.
      //   Compaction does NOT inherit synopsisModel — those knobs are
      //   independent (title is high-frequency / cheap; compaction is
      //   rare / quality-sensitive).
      // Cross-agent jobs (targetAgentId set) must NOT inherit the
      // source session's currentModel — that model id likely doesn't
      // exist on the target agent. Let the target pick its own default.
      const usingSessionAgent = this.opts.compactionAgent === undefined && targetAgentId === undefined;
      const modelId = jobKind === "compaction"
        ? (this.opts.compactionModel ??
           (usingSessionAgent ? record.currentModel : undefined))
        : this.opts.synopsisModel;
      // Run the ephemeral agent in the session's own hydra directory
      // rather than the user's project cwd. Two reasons: (a) if a prompt
      // injection ever coaxed it into a filesystem tool call, the blast
      // radius is a daemon-owned scratch dir, not the user's code;
      // (b) it segregates claude-acp's per-project storage
      // (~/.claude/projects/<encoded>) so synopsis artifacts collect in
      // a predictable, sweepable folder instead of polluting every user
      // project the session ever touched.
      const synopsisCwd = paths.sessionDir(sessionId);
      await fs.mkdir(synopsisCwd, { recursive: true }).catch(() => undefined);
      this.opts.logger?.info(
        `synopsis: start sessionId=${sessionId} agentId=${synopsisAgentId} historyLen=${history.length} model=${JSON.stringify(modelId ?? "(default)")} cwd=${synopsisCwd}`,
      );
      if (jobKind === "compaction") {
        const maxIterations = this.opts.compactionMaxIterations ?? 3;
        let iter = 0;
        let through = last ?? 0;
        let latestArtifact: SessionSynopsis | undefined;
        let latestThrough = 0;
        // Captures the most recent failure reason surfaced by
        // generateCompaction's onFailure callback. Used to populate
        // compactionState.lastError when the loop exits without an
        // artifact, so the user sees an actionable message in
        // `/hydra compact status` and the TUI's failed broadcast.
        let lastFailureReason: string | undefined;
        const requestedAt = Date.now();
        const ctx = { targetAgentId };
        const writeState = (state: CompactionState): Promise<void> =>
          this.opts.onCompactionStateChange?.(sessionId, state, ctx) ?? Promise.resolve();
        const wireBroadcast = (payload: HydraCompactionPayload): void => {
          this.opts.broadcastHydraCompaction?.(sessionId, payload, ctx);
        };
        await writeState({
          status: "requested",
          requestedAt,
        });
        wireBroadcast({
          sessionUpdate: "hydra_compaction",
          phase: "started",
          requestedAt,
        });

        try {
          do {
            iter++;
            this.opts.logger?.info(
              `synopsis: compaction iteration ${iter} sessionId=${sessionId} historyLen=${history.length} watermark=${through}`,
            );

            const historyAtStart = await this.opts.histories.load(sessionId, { maxEntries: Infinity });
            if (historyAtStart.length <= through) {
              break;
            }

            const result = await generateCompaction({
              agentId: synopsisAgentId,
              cwd: synopsisCwd,
              plan,
              history: historyAtStart,
              modelId,
              sessionId,
              logger: this.opts.logger,
              timeoutMs: this.opts.generateTimeoutMs,
              onWorkerSpawned: (upstreamSessionId, pid) => {
                void writeState({
                  status: "running",
                  requestedAt,
                  iter,
                  worker: {
                    upstreamSessionId,
                    pid: pid ?? 0,
                  },
                });
              },
              onFailure: (reason) => {
                lastFailureReason = reason;
              },
            });

            if (result) {
              const merged = mergeLocalFields(result.synopsis, historyAtStart);
              if (merged && synopsisHasContent(merged)) {
                await this.opts.persistSynopsis(sessionId, merged, historyAtStart.length);
                latestArtifact = merged;
                latestThrough = historyAtStart.length;
                // Clear any stale failure reason now that an iteration
                // succeeded — partial progress beats no information.
                lastFailureReason = undefined;
                await writeState({
                  status: "running",
                  requestedAt,
                  iter,
                });
                wireBroadcast({
                  sessionUpdate: "hydra_compaction",
                  phase: "iteration",
                  iter,
                  historyLen: historyAtStart.length,
                });
                await this.opts.onSynthesisArtifact?.(sessionId, merged, latestThrough, targetAgentId);
                this.opts.logger?.info(
                  `synopsis: persisted compaction sessionId=${sessionId} iteration=${iter} fields=${describeFields(merged)}`,
                );
              }
            } else {
              this.opts.logger?.warn(
                `synopsis: sessionId=${sessionId} compaction iteration ${iter} returned no result`,
              );
            }

            through = historyAtStart.length;
            const historyAfter = await this.opts.histories.load(sessionId, { maxEntries: Infinity });
            if (historyAfter.length === through) {
              break;
            }
          } while (iter < maxIterations);

          if (!latestArtifact) {
            // Loop exited without ever producing an artifact (parse failure,
            // timeout, agent error, or no growth since last summary). Persist
            // a terminal "failed" state with the most recent reason so the
            // user can read it via `/hydra compact status` or the TUI's
            // failed broadcast. The state stays until next compaction trigger
            // replaces it or the session resurrects.
            if (iter > 0) {
              this.opts.logger?.warn(
                `synopsis: compaction hit maxIterations=${maxIterations} without producing artifact sessionId=${sessionId}: ${lastFailureReason ?? "no reason captured"}`,
              );
            }
            const errorMsg =
              lastFailureReason ??
              (iter === 0
                ? "no new history to compact since last summary"
                : `compaction did not produce an artifact after ${iter} iteration(s)`);
            await writeState({
              status: "failed",
              requestedAt,
              iter,
              lastError: errorMsg,
            });
            wireBroadcast({
              sessionUpdate: "hydra_compaction",
              phase: "failed",
              error: errorMsg,
            });
          } else if (iter >= maxIterations) {
            this.opts.logger?.info(
              `synopsis: compaction converged sessionId=${sessionId} watermark=${latestThrough} iterations=${iter}`,
            );
          }
        } catch (err) {
          // Thrown errors land here — record so the state isn't stranded.
          // The onSynthesisArtifact / swap path has its own try/catch and
          // won't reach here; this catches unexpected throws inside the loop.
          const message = err instanceof Error ? err.message : String(err);
          this.opts.logger?.warn(
            `synopsis: compaction threw for sessionId=${sessionId}: ${message}`,
          );
          await writeState({
            status: "failed",
            requestedAt,
            iter,
            lastError: message,
          });
          this.opts.broadcastHydraCompaction?.(sessionId, {
            sessionUpdate: "hydra_compaction",
            phase: "failed",
            error: message,
          }, { targetAgentId });
        }
      } else {
        const result = await generateSynopsis({
          agentId: synopsisAgentId,
          cwd: synopsisCwd,
          plan,
          history,
          modelId,
          sessionId,
          logger: this.opts.logger,
          timeoutMs: this.opts.generateTimeoutMs,
        });
        if (!result) {
          this.opts.logger?.warn(
            `synopsis: sessionId=${sessionId} no parseable result; not persisting`,
          );
          return;
        }
        const merged = mergeLocalFields(result.synopsis, history);
        if (merged && synopsisHasContent(merged)) {
          await this.opts.persistSynopsis(sessionId, merged, history.length);
          if (result.title) {
            await this.opts.persistTitle(sessionId, result.title);
          }
          this.opts.logger?.info(
            `synopsis: persisted sessionId=${sessionId} title=${JSON.stringify(!!result.title)} fields=${describeFields(merged)}`,
          );
        } else if (result.title) {
          await this.opts.persistTitle(sessionId, result.title);
          this.opts.logger?.info(
            `synopsis: persisted title only sessionId=${sessionId}`,
          );
        }
      }
    } catch (err) {
      this.opts.logger?.warn(
        `synopsis: sessionId=${sessionId} failed: ${(err as Error).message}`,
      );
    }
  }
}

// Layer the locally-computed files_touched + tools_used onto whatever the
// agent produced. The agent isn't asked for these fields (see snapshot.ts
// SNAPSHOT_PROMPT) — they're derivable from history.jsonl deterministically,
// so we compute them here and avoid the hallucination risk.
function mergeLocalFields(
  agentSynopsis: SessionSynopsis | undefined,
  history: Array<{ method?: unknown; params?: unknown }>,
): SessionSynopsis | undefined {
  const localFiles = extractFilesTouched(history);
  const localTools = extractToolsUsed(history);
  if (!agentSynopsis) {
    if (localFiles.length === 0 && localTools.length === 0) {
      return undefined;
    }
    return {
      files_touched: localFiles.length > 0 ? localFiles : undefined,
      tools_used: localTools.length > 0 ? localTools : undefined,
    };
  }
  return {
    ...agentSynopsis,
    files_touched: localFiles.length > 0 ? localFiles : agentSynopsis.files_touched,
    tools_used: localTools.length > 0 ? localTools : agentSynopsis.tools_used,
  };
}

function synopsisHasContent(s: SessionSynopsis): boolean {
  if (s.goal && s.goal.trim().length > 0) {
    return true;
  }
  if (s.outcome && s.outcome.trim().length > 0) {
    return true;
  }
  if (s.files_touched && s.files_touched.length > 0) {
    return true;
  }
  if (s.tools_used && s.tools_used.length > 0) {
    return true;
  }
  if (s.rejected_approaches && s.rejected_approaches.length > 0) {
    return true;
  }
  if (s.open_threads && s.open_threads.length > 0) {
    return true;
  }
  return false;
}

function describeFields(s: SessionSynopsis): string {
  const parts: string[] = [];
  if (s.goal) {
    parts.push("goal");
  }
  if (s.outcome) {
    parts.push("outcome");
  }
  if (s.files_touched && s.files_touched.length > 0) {
    parts.push(`files=${s.files_touched.length}`);
  }
  if (s.tools_used && s.tools_used.length > 0) {
    parts.push(`tools=${s.tools_used.length}`);
  }
  if (s.rejected_approaches && s.rejected_approaches.length > 0) {
    parts.push(`rejected=${s.rejected_approaches.length}`);
  }
  if (s.open_threads && s.open_threads.length > 0) {
    parts.push(`open=${s.open_threads.length}`);
  }
  return `[${parts.join(",")}]`;
}
