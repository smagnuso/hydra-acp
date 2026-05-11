// Single source of truth for /hydra slash commands. Used by Session for
// dispatch + validation, broadcast via available_commands_update so every
// client (TUI completions, future slack discovery, etc.) sees the same
// list without hardcoding it.

export interface HydraCommandSpec {
  // The verb following "/hydra ", e.g. "title".
  verb: string;
  // The display/dispatch name as users type it, e.g. "/hydra title".
  name: string;
  description: string;
  // Optional argument hint shown in completions, e.g. "<agent>".
  argsHint?: string;
}

export const HYDRA_COMMANDS: readonly HydraCommandSpec[] = [
  {
    verb: "title",
    name: "/hydra title",
    description:
      "Regenerate the session title via the agent (or set manually with an arg)",
  },
  {
    verb: "switch",
    name: "/hydra switch",
    argsHint: "<agent>",
    description: "Swap the agent backing this session, preserving context",
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

export function hydraCommandsAsAdvertised(): AdvertisedCommand[] {
  return HYDRA_COMMANDS.map((c) => ({
    name: c.argsHint ? `${c.name} ${c.argsHint}` : c.name,
    description: c.description,
  }));
}
