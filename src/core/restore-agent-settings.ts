import type { AgentInstance, AgentLogger } from "./agent-instance.js";
import type { AdvertisedMode } from "./hydra-commands.js";

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
export async function restoreCurrentModel(opts: {
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
