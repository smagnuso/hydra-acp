// Ephemeral synopsis agent. Spawns a fresh agent subprocess with a blank
// slate — no MCP servers, no transformers, no prior conversation — feeds
// it the rendered transcript of a session, and returns the parsed
// snapshot JSON.
//
// Why not reuse the live session's agent? In-session synopsis generation
// (the Phase 2 approach) routinely fails on deep histories:
//   - the agent's own context window collides with the prompt;
//     claude-acp auto-compacts mid-turn and resumes as if doing work,
//     producing prose instead of JSON.
//   - the optional model swap (to a cheaper model) leaks into the
//     agent's per-turn model attribution and survives the swap-back.
//   - the synopsis turn blocks session close, making kill look frozen.
//
// The ephemeral path sidesteps all of that: no context to collide with,
// no internal session state to leak into, runs after close so kill is
// instant.

import { AgentInstance, type AgentLogger } from "./agent-instance.js";
import type { SpawnPlan } from "./registry.js";
import { ACP_PROTOCOL_VERSION } from "../acp/types.js";
import { HYDRA_VERSION } from "./hydra-version.js";
import {
  COMPACTION_PROMPT,
  SNAPSHOT_PROMPT,
  tryParseCompaction,
  tryParseSnapshot,
  type SnapshotParseResult,
} from "./snapshot.js";
import { renderTranscript } from "./history-transcript.js";

export interface GenerateSynopsisOpts {
  agentId: string;
  cwd: string;
  plan: SpawnPlan;
  history: Array<{ method?: unknown; params?: unknown }>;
  // From config.synopsisModel. When unset (or unknown to the agent's
  // advertised list), the run uses whatever model the agent picks
  // itself on session/new — typically the agent's default.
  modelId?: string;
  logger?: AgentLogger;
  // Hard upper bound on the whole call (spawn + prompt + kill). Defaults
  // to 120 seconds; ephemeral runs with no prior context should resolve
  // in well under 30s even on long transcripts.
  timeoutMs?: number;
  // Cap on the rendered transcript size fed to the agent. Anything older
  // than the tail-fitting window is dropped (see renderTranscript).
  maxTranscriptChars?: number;
  // Called after the ephemeral agent spawns and session/new returns.
  // Provides the upstreamSessionId and pid for diagnostic recording only.
  onWorkerSpawned?: (upstreamSessionId: string, pid: number | undefined) => void;
  // Parent Hydra session id — used to tag the worker prompt so users can
  // identify ephemeral synopsis/compaction sessions in agent storage.
  sessionId?: string;
  // Called once with a human-readable reason whenever the ephemeral run
  // returns undefined (parse failure, timeout, spawn/connection error).
  // Coordinator uses this to populate compactionState.lastError so the
  // user can see WHY a compaction didn't produce an artifact rather than
  // a silent failure. The reason is intended to be short and actionable.
  onFailure?: (reason: string) => void;
}

const DEFAULT_TIMEOUT_MS = 120_000;

// Shared ephemeral-agent lifecycle: spawn → initialize → session/new →
// optional set_model → prompt with rendered transcript → parse reply → kill.
// Both synopsis and compaction routing share this body verbatim; only the
// prompt template and parser function differ.
async function runEphemeralRegen(
  opts: GenerateSynopsisOpts,
  promptText: string,
  parser: (reply: string) => SnapshotParseResult | undefined,
): Promise<SnapshotParseResult | undefined> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let agent: AgentInstance | undefined;
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  try {
    const work = (async (): Promise<SnapshotParseResult | undefined> => {
      agent = AgentInstance.spawn({
        agentId: opts.agentId,
        cwd: opts.cwd,
        plan: opts.plan,
        logger: opts.logger,
      });
      const initResult = await agent.connection.request<Record<string, unknown>>(
        "initialize",
        {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: {},
          clientInfo: { name: "hydra-synopsis", version: HYDRA_VERSION },
        },
      );
      void initResult;
      const newResult = await agent.connection.request<Record<string, unknown>>(
        "session/new",
        {
          cwd: opts.cwd,
          mcpServers: [],
        },
      );
      const upstreamSessionId = newResult.sessionId;
      if (typeof upstreamSessionId !== "string") {
        opts.logger?.warn(
          `synopsis: agent ${opts.agentId} returned non-string sessionId from session/new`,
        );
        opts.onFailure?.(
          `agent ${opts.agentId} did not return a sessionId from session/new`,
        );
        return undefined;
      }
      opts.onWorkerSpawned?.(upstreamSessionId, agent.pid);
      if (opts.modelId) {
        const advertised = collectAdvertisedModelIds(newResult);
        if (advertised.size === 0 || advertised.has(opts.modelId)) {
          try {
            await agent.connection.request("session/set_model", {
              sessionId: upstreamSessionId,
              modelId: opts.modelId,
            });
          } catch (err) {
            opts.logger?.warn(
              `synopsis: agent ${opts.agentId} rejected set_model ${JSON.stringify(opts.modelId)}: ${(err as Error).message}; continuing on default`,
            );
          }
        } else {
          opts.logger?.warn(
            `synopsis: model ${JSON.stringify(opts.modelId)} not advertised by agent ${opts.agentId} (have [${[...advertised].join(", ")}]); continuing on default`,
          );
        }
      }
      const chunks: string[] = [];
      agent.connection.onNotification("session/update", (params) => {
        const text = extractChunkText(params);
        if (text.length > 0) {
          chunks.push(text);
        }
      });
      await agent.connection.request<unknown>("session/prompt", {
        sessionId: upstreamSessionId,
        prompt: [{ type: "text", text: promptText }],
      });
      const reply = chunks.join("");
      const parsed = parser(reply);
      if (!parsed) {
        const preview = JSON.stringify(reply.slice(0, 200));
        opts.logger?.warn(
          `synopsis: agent ${opts.agentId} reply did not parse (replyLen=${reply.length} preview=${preview})`,
        );
        // Include the first chunk of the reply verbatim — for small
        // replies (refusals, error strings) this IS the diagnosis; for
        // longer truncated JSON the preview lets the user see what the
        // agent attempted. Prescribing a specific fallback model would
        // be guessing at the user's available providers.
        const preview120 = reply.slice(0, 120).replace(/\s+/g, " ").trim();
        opts.onFailure?.(
          `agent ${opts.agentId} returned unparseable JSON (${reply.length} chars): ${preview120}${reply.length > 120 ? "\u2026" : ""}`,
        );
      }
      return parsed;
    })();

    return await new Promise<SnapshotParseResult | undefined>(
      (resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          opts.logger?.warn(
            `synopsis: agent ${opts.agentId} timed out after ${timeoutMs}ms`,
          );
          opts.onFailure?.(`agent ${opts.agentId} timed out after ${timeoutMs}ms`);
          resolve(undefined);
        }, timeoutMs);
        timer.unref?.();
        work.then(
          (v) => {
            if (timer) {
              clearTimeout(timer);
            }
            if (!timedOut) {
              resolve(v);
            }
          },
          (err) => {
            if (timer) {
              clearTimeout(timer);
            }
            if (!timedOut) {
              reject(err);
            }
          },
        );
      },
    );
  } catch (err) {
    const message = (err as Error).message;
    opts.logger?.warn(`synopsis: agent ${opts.agentId} failed: ${message}`);
    opts.onFailure?.(`agent ${opts.agentId} failed: ${message}`);
    return undefined;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    if (agent) {
      await agent.kill().catch(() => undefined);
    }
  }
}

export async function generateSynopsis(
  opts: GenerateSynopsisOpts,
): Promise<SnapshotParseResult | undefined> {
  const transcript = renderTranscript(opts.history, {
    maxChars: opts.maxTranscriptChars,
  });
  const tag = opts.sessionId !== undefined
    ? `[hydra-acp title-regen worker for session ${opts.sessionId}]`
    : `[hydra-acp title-regen worker]`;
  const promptText =
    transcript.length > 0
      ? `${tag}\n\n${transcript}\n\n${SNAPSHOT_PROMPT}`
      : `${tag}\n\n${SNAPSHOT_PROMPT}`;
  return runEphemeralRegen(opts, promptText, tryParseSnapshot);
}

export async function generateCompaction(
  opts: GenerateSynopsisOpts,
): Promise<SnapshotParseResult | undefined> {
  const transcript = renderTranscript(opts.history, {
    maxChars: opts.maxTranscriptChars,
  });
  const tag = opts.sessionId !== undefined
    ? `[hydra-acp compaction worker for session ${opts.sessionId}]`
    : `[hydra-acp compaction worker]`;
  const promptText =
    transcript.length > 0
      ? `${tag}\n\n${transcript}\n\n${COMPACTION_PROMPT}`
      : `${tag}\n\n${COMPACTION_PROMPT}`;
  return runEphemeralRegen(opts, promptText, tryParseCompaction);
}

function extractChunkText(params: unknown): string {
  if (!params || typeof params !== "object") {
    return "";
  }
  const update = (params as { update?: unknown }).update;
  if (!update || typeof update !== "object") {
    return "";
  }
  const u = update as { sessionUpdate?: unknown; content?: unknown };
  if (u.sessionUpdate !== "agent_message_chunk") {
    return "";
  }
  const content = u.content as { text?: unknown } | undefined;
  if (content && typeof content.text === "string") {
    return content.text;
  }
  return "";
}

// Collect every modelId the agent advertised in session/new. Agents
// disagree on shape; we accept the common ones and fall back to "trust
// the caller" (empty set) so the swap proceeds optimistically.
function collectAdvertisedModelIds(
  result: Record<string, unknown>,
): Set<string> {
  const out = new Set<string>();
  collectFromAvailable(out, result.availableModels);
  const models = result.models;
  if (models && typeof models === "object" && !Array.isArray(models)) {
    collectFromAvailable(out, (models as Record<string, unknown>).availableModels);
  }
  return out;
}

function collectFromAvailable(out: Set<string>, raw: unknown): void {
  if (!Array.isArray(raw)) {
    return;
  }
  for (const m of raw) {
    if (m && typeof m === "object") {
      const id =
        (m as { modelId?: unknown }).modelId ??
        (m as { value?: unknown }).value ??
        (m as { id?: unknown }).id;
      if (typeof id === "string" && id.length > 0) {
        out.add(id);
      }
    }
  }
}
