import type { AgentInstance, AgentLogger } from "./agent-instance.js";
import type { AdvertisedMode } from "./hydra-commands.js";
import { requestModelChange, type ModelVerb } from "./model-verb.js";

// Push a persisted mode back to a freshly loaded or spawned agent so a
// session that was in plan mode (or any non-default mode) doesn't silently
// revert on restart. Returns the mode that should be recorded on the
// Session — either the persisted one (when we successfully pushed it, or
// the agent already agrees) or what the agent reported (when the call
// failed or the mode isn't advertised).
export async function restoreCurrentMode(opts: {
  agent: AgentInstance;
  upstreamSessionId: string;
  persistedMode: string | undefined;
  agentReportedMode: string | undefined;
  advertisedModes?: AdvertisedMode[];
  logger?: AgentLogger;
}): Promise<string | undefined> {
  const { agent, upstreamSessionId, persistedMode, agentReportedMode, advertisedModes, logger } =
    opts;
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

// Push a persisted model back to a freshly loaded or spawned agent so a
// session that was on a non-default model doesn't silently revert on
// restart. Returns the model that should be recorded on the Session —
// either the persisted one (when we successfully pushed it, or the agent
// already agrees) or what the agent reported (when the call failed).
//
// Unlike restoreCurrentMode, we do NOT skip when the id is absent from
// the advertised list. The persisted model came from an actual
// current_model_update the agent emitted in a prior session — the agent
// confirmed it works. Let the agent be the authority; if it rejects, we
// fall back.
//
// `result` is the accepted call's reply, present only when a call was
// actually made and accepted. On the set_config_option verb it carries
// the agent's configOptions rebuilt for the restored model, and it is the
// only word on them: the caller drains buffered session/update right
// after this returns, so a notification would be dropped even if one came.
export async function restoreCurrentModel(opts: {
  agent: AgentInstance;
  upstreamSessionId: string;
  persistedModel: string | undefined;
  agentReportedModel: string | undefined;
  // Lead verb inferred from the session/load response shape (see
  // model-verb.ts). Undefined falls back to session/set_model.
  modelVerb?: ModelVerb;
  logger?: AgentLogger;
}): Promise<{ modelId: string | undefined; result?: unknown }> {
  const { agent, upstreamSessionId, persistedModel, agentReportedModel, modelVerb, logger } =
    opts;
  if (!persistedModel) {
    return { modelId: agentReportedModel };
  }
  if (persistedModel === agentReportedModel) {
    return { modelId: persistedModel };
  }
  try {
    logger?.info(
      `resurrect: pushing persisted modelId=${JSON.stringify(persistedModel)} to agent (agentReported=${JSON.stringify(agentReportedModel)})`,
    );
    // Leads with the inferred verb, probing the other on MethodNotFound —
    // agents on @agentclientprotocol/sdk >= 0.26 only implement
    // session/set_config_option.
    const { verb, result } = await requestModelChange({
      request: (method, params) => agent.connection.request(method, params),
      sessionId: upstreamSessionId,
      modelId: persistedModel,
      ...(modelVerb ? { verb: modelVerb } : {}),
      logger,
    });
    logger?.info(
      `resurrect: ${verb} accepted, effectiveModel=${JSON.stringify(persistedModel)}`,
    );
    return { modelId: persistedModel, result };
  } catch (err) {
    logger?.warn(
      `resurrect: session/set_model rejected by agent for modelId=${JSON.stringify(persistedModel)} (${(err as Error).message}); session will use ${JSON.stringify(agentReportedModel)}`,
    );
    return { modelId: agentReportedModel };
  }
}
