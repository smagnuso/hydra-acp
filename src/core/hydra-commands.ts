// Single source of truth for /hydra slash commands. Used by Session for
// dispatch + validation, broadcast via available_commands_update so every
// client (TUI completions, future slack discovery, etc.) sees the same
// list without hardcoding it.

export interface HydraCommandSpec {
  // The verb following "/hydra ", e.g. "title".
  verb: string;
  // Wire-advertised name, bare (no leading "/") per ACP convention so
  // clients prepend their own slash for display. Users type "/hydra
  // <verb>" — the leading "/" is a UI artifact, not part of the name.
  name: string;
  description: string;
  // Optional argument hint shown in completions, e.g. "<agent>".
  argsHint?: string;
}

export const HYDRA_COMMANDS: readonly HydraCommandSpec[] = [
  {
    verb: "title",
    name: "hydra title",
    description:
      "Regenerate the session title + synopsis via the agent (or set title manually with an arg)",
  },
  {
    verb: "agent",
    name: "hydra agent",
    argsHint: "<agent>",
    description: "Swap the agent backing this session, preserving context",
  },
  {
    verb: "kill",
    name: "hydra kill",
    description:
      "Close this session (kills the agent; record is kept so it can be resumed later)",
  },
  {
    verb: "restart",
    name: "hydra restart",
    description:
      "Restart the agent with a fresh session/new while preserving conversation history (useful when the proxy has changed available models)",
  },
];

const VERB_INDEX = new Map(HYDRA_COMMANDS.map((c) => [c.verb, c]));

export function getHydraCommand(verb: string): HydraCommandSpec | undefined {
  return VERB_INDEX.get(verb);
}

// Shape used by the agent-commands protocol channel (session/update
// kind=available_commands_update). The TUI's mapAvailableCommands accepts
// either {name, description} or bare strings; we send the richer form.
export interface AdvertisedCommand {
  name: string;
  description?: string;
}

// Shape used by the agent-modes protocol channel (session/update
// kind=available_modes_update). id is what gets sent to session/set_mode.
// name is required by the ACP spec (zSessionMode) but we keep it optional
// here to tolerate agents that don't supply one — callers fall back to id.
export interface AdvertisedMode {
  id: string;
  name?: string;
  description?: string;
}

// Shape used by the agent-models protocol channel (session/update
// kind=current_model_update with availableModels payload, or
// session/new / session/load result.models.availableModels).
// modelId is what gets sent to session/set_model.
export interface AdvertisedModel {
  modelId: string;
  name?: string;
  description?: string;
}

export function hydraCommandsAsAdvertised(): AdvertisedCommand[] {
  return HYDRA_COMMANDS.map((c) => ({
    name: c.argsHint ? `${c.name} ${c.argsHint}` : c.name,
    description: c.description,
  }));
}
