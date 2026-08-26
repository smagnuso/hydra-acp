import { JsonRpcErrorCodes } from "../acp/types-jsonrpc.js";
import type { AgentLogger } from "./agent-instance.js";

// Two wire verbs for "change this session's model" exist in the wild:
//
//   - `session/set_model {sessionId, modelId}` — the original. Spoken by
//     claude-agent-acp, codex-acp, opencode, and everything built on
//     @agentclientprotocol/sdk <= 0.25.
//   - `session/set_config_option {sessionId, configId: "model", value}` —
//     the unified config setter. SDK 0.26 *removed* `session/set_model`
//     from its AGENT_METHODS dispatch table entirely, so agents on 0.26+
//     (pi-acp, notably) answer `-32601 Method not found` to the old verb
//     and only accept the config-option form.
//
// hydra has to speak both. There's no capability bit for it in
// `initialize` (nothing in AgentCapabilities distinguishes the two), so
// we probe: send the verb we believe the agent speaks, and on
// MethodNotFound flip to the other and remember the answer for the rest
// of the agent generation. Callers hold the memo (see
// `Session.modelVerb`, reset in `wireAgent`) so the probe costs at most
// one wasted round-trip per agent process.
export type ModelVerb = "session/set_model" | "session/set_config_option";

export const MODEL_VERB_SET_MODEL: ModelVerb = "session/set_model";
export const MODEL_VERB_SET_CONFIG_OPTION: ModelVerb = "session/set_config_option";

// configId used by the config-option form. Matches pi-acp's
// MODEL_CONFIG_ID and opencode's `configOptions[].id`.
export const MODEL_CONFIG_ID = "model";

// ---------------------------------------------------------------------
// Inferring the verb without a probe.
//
// There is no capability bit for this — `AgentCapabilities` in both SDK
// lines (0.26.x and 1.x) carries only loadSession / promptCapabilities /
// mcpCapabilities / sessionCapabilities{list,delete,additionalDirectories,
// fork,resume,close} / auth / providers / nes / positionEncoding, and
// PROTOCOL_VERSION is still 1, so neither capabilities nor the version
// number distinguish the two verbs.
//
// What *does* distinguish them is how the agent advertises its models.
// The SDK releases that dropped `session/set_model` dropped
// `availableModels` and `current_model_update` from the schema in the
// same move — model state now travels as `configOptions[id="model"]`
// plus `config_option_update`. So:
//
//   models seen as `availableModels` / `current_model_update`
//     → legacy agent  → `session/set_model`
//   models seen as `configOptions[id="model"]` / `config_option_update`
//     → modern agent  → `session/set_config_option`
//
// Inference picks the *lead* verb only; `requestModelChange`'s
// MethodNotFound probe stays as the safety net for agents that mix the
// two (opencode advertises via configOptions but still implements
// set_model), and an actually-accepted call always outranks inference.

function hasModelObject(obj: unknown): boolean {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return false;
  }
  return Array.isArray((obj as { availableModels?: unknown }).availableModels);
}

function hasModelConfigOption(list: unknown): boolean {
  return (
    Array.isArray(list) &&
    list.some(
      (e) =>
        e !== null &&
        typeof e === "object" &&
        !Array.isArray(e) &&
        (e as { id?: unknown }).id === MODEL_CONFIG_ID,
    )
  );
}

// Infer from a session/new or session/load response. Mirrors the search
// order of extractInitialModels (top level → nested `models` → foreign
// `_meta` namespaces → configOptions), so the verb we infer matches the
// place the model list was actually read from. Returns undefined when
// the response advertises no models at all — caller keeps its default.
export function inferModelVerbFromResult(
  result: Record<string, unknown> | undefined,
): ModelVerb | undefined {
  if (!result) {
    return undefined;
  }
  if (hasModelObject(result) || hasModelObject(result.models)) {
    return MODEL_VERB_SET_MODEL;
  }
  const meta = result._meta;
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    for (const [key, value] of Object.entries(meta as Record<string, unknown>)) {
      if (key === "hydra-acp") {
        continue;
      }
      if (hasModelObject(value)) {
        return MODEL_VERB_SET_MODEL;
      }
    }
  }
  if (hasModelConfigOption(result.configOptions)) {
    return MODEL_VERB_SET_CONFIG_OPTION;
  }
  return undefined;
}

// Infer from a session/update payload's `update` object: a
// current_model_update means legacy, a config_option_update carrying a
// "model" entry means modern. Anything else returns undefined.
export function inferModelVerbFromUpdate(
  update: unknown,
): ModelVerb | undefined {
  if (!update || typeof update !== "object" || Array.isArray(update)) {
    return undefined;
  }
  const kind = (update as { sessionUpdate?: unknown }).sessionUpdate;
  if (kind === "_hydra_current_model_update") {
    return MODEL_VERB_SET_MODEL;
  }
  if (
    kind === "config_option_update" &&
    hasModelConfigOption((update as { configOptions?: unknown }).configOptions)
  ) {
    return MODEL_VERB_SET_CONFIG_OPTION;
  }
  return undefined;
}

export function isMethodNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === JsonRpcErrorCodes.MethodNotFound
  );
}

// Params envelope for a given verb. `extra` carries client-supplied
// passthrough fields (notably `_meta`); the verb-specific keys are
// stripped from it so a `modelId` left over from a set_model envelope
// doesn't ride along on the config-option form.
export function modelChangeParams(
  verb: ModelVerb,
  sessionId: string,
  modelId: string,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  const passthrough = { ...(extra ?? {}) };
  delete passthrough.sessionId;
  delete passthrough.modelId;
  delete passthrough.configId;
  delete passthrough.value;
  return verb === MODEL_VERB_SET_MODEL
    ? { ...passthrough, sessionId, modelId }
    : { ...passthrough, sessionId, configId: MODEL_CONFIG_ID, value: modelId };
}

export function otherModelVerb(verb: ModelVerb): ModelVerb {
  return verb === MODEL_VERB_SET_MODEL
    ? MODEL_VERB_SET_CONFIG_OPTION
    : MODEL_VERB_SET_MODEL;
}

export interface ModelChangeOutcome {
  // The verb the agent actually accepted. Callers memoize this so the
  // next change on the same agent generation skips the probe.
  verb: ModelVerb;
  result: unknown;
}

// Push a model change upstream, probing across the two verbs.
//
// `request` is the dispatcher — either a raw
// `agent.connection.request` (bootstrap / resurrect, before the session
// is live) or `Session.forwardRequest` (so transformers see the call).
// Only a MethodNotFound rejection triggers the fallback; any other error
// (invalid model id, agent-side failure) propagates untouched so the
// caller's existing error handling is unchanged.
export async function requestModelChange(opts: {
  request: (method: string, params: unknown) => Promise<unknown>;
  sessionId: string;
  modelId: string;
  // Verb to try first. Defaults to `session/set_model` — the older,
  // still-more-common form.
  verb?: ModelVerb;
  // Client-supplied passthrough fields (e.g. `_meta`) to carry on the
  // forwarded envelope.
  extraParams?: Record<string, unknown>;
  logger?: AgentLogger;
}): Promise<ModelChangeOutcome> {
  const { request, sessionId, modelId, extraParams, logger } = opts;
  const first = opts.verb ?? MODEL_VERB_SET_MODEL;
  try {
    const result = await request(
      first,
      modelChangeParams(first, sessionId, modelId, extraParams),
    );
    return { verb: first, result };
  } catch (err) {
    if (!isMethodNotFound(err)) {
      throw err;
    }
    const second = otherModelVerb(first);
    logger?.info(
      `agent does not implement ${first} (MethodNotFound); retrying model change via ${second} modelId=${JSON.stringify(modelId)}`,
    );
    try {
      const result = await request(
        second,
        modelChangeParams(second, sessionId, modelId, extraParams),
      );
      return { verb: second, result };
    } catch (fallbackErr) {
      // Neither verb exists — the agent has no model selector at all.
      // Surface the original rejection so log lines and client-facing
      // messages stay keyed on the verb we lead with.
      if (isMethodNotFound(fallbackErr)) {
        throw err;
      }
      throw fallbackErr;
    }
  }
}
