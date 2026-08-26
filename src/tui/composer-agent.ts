import { hydraHome } from "../core/paths.js";
import {
  resolveDirectoryConfig,
  stringField,
  stringMapField,
} from "../core/directory-config.js";
import { lookupInheritedAgentValue } from "../core/registry.js";
import type { HydraConfig } from "../core/config.js";

// The picker composer's top-right "agent•model" label is a preview of
// what a new session created from this composer would use — and both
// halves of it are cwd-dependent, because a `.hydra-acp.json` between the
// cwd and $HOME can set `defaultAgent` / `defaultModels`. The label is not
// decoration: picker's makeNewResult sends both values on session/new, so
// whatever it shows is what gets created.
//
// This module is the one place that formula lives. It has three callers:
// seeding the initial picker, seeding the in-session picker, and
// re-resolving after ^O changes the picker's cwd. They agreed by
// copy-paste before, which is how ^O ended up creating a session in
// directory B with directory A's agent.

export interface ComposerAgentPrefs {
  lastChosenAgent?: string;
  lastChosenModel?: string;
}

export interface ComposerAgentChainSource {
  id: string;
  extendsChain?: string[];
}

export interface ComposerAgentSelection {
  agentId?: string;
  model?: string;
}

export interface ComposerAgentInputs {
  // The invocation's own `--agent` flag (or HYDRA_ACP_AGENT env var —
  // resolveOption in cli/parse-args.ts already folds env under the flag,
  // so this one field carries both). Set once at launch and never
  // rewritten, unlike fallbackAgentId below — it is the strongest
  // possible statement of intent ("run THIS agent"), stronger even than
  // a `.hydra-acp.json` for the tree, so it sits above everything else.
  explicitAgentId?: string;
  // defaultAgent / defaultModels as written in the `.hydra-acp.json`
  // layers for the cwd in question, NOT the already-merged config. The
  // distinction is the whole point of the precedence rule below: once
  // merged, there is no way to tell a directory's deliberate statement
  // from the global default it happened to override.
  directoryDefaultAgent?: string;
  directoryDefaultModels?: Record<string, string>;
  prefs: ComposerAgentPrefs;
  // opts.agentId — rewritten to the attached session's agent on every
  // attach / cycle, so it sits below the user's own choice.
  fallbackAgentId?: string;
  configDefaultAgent?: string;
  configDefaultModels?: Record<string, string>;
  availableAgents: readonly ComposerAgentChainSource[];
}

// Precedence, most specific first. explicitAgentId (--agent / env) wins
// outright: it is a fresh, deliberate statement for this exact
// invocation, and nothing resolved from a config file should be able to
// override what the user just typed. Below that, a directory config
// outranks `lastChosenAgent` because the two are not the same kind of
// statement: a `.hydra-acp.json` is an explicit, durable claim about one
// tree, while lastChosenAgent is implicit global stickiness left over
// from whatever the user last clicked. Without this ordering the key
// would be dead for exactly the people who write it — anyone who has
// ever picked an agent from the composer label.
//
// An explicit pick made *in the picker itself* still outranks everything;
// the picker enforces that by not calling this again after one.
export function resolveComposerAgent(
  inputs: ComposerAgentInputs,
): ComposerAgentSelection {
  const agentId =
    inputs.explicitAgentId ??
    inputs.directoryDefaultAgent ??
    inputs.prefs.lastChosenAgent ??
    inputs.fallbackAgentId ??
    inputs.configDefaultAgent;
  if (agentId === undefined || agentId.length === 0) {
    return {};
  }
  // defaultModels is keyed by agent id, and an agent derived via
  // config.agents `extends` usually has no entry of its own — walk the
  // inheritance chain most-specific-first, same as session-manager.ts
  // does when it actually seeds a session's model.
  const chain = inputs.availableAgents.find((a) => a.id === agentId)
    ?.extendsChain;
  const ref = { id: agentId, ...(chain ? { extendsChain: chain } : {}) };
  // lastChosenModel only applies to the agent it was chosen for. It is
  // stored alongside lastChosenAgent and cleared with it, but the agent
  // resolved above may have come from somewhere else entirely (a
  // directory default), and pairing one agent with another's model would
  // paint a combination the user never picked.
  const rememberedModel =
    agentId === inputs.prefs.lastChosenAgent
      ? inputs.prefs.lastChosenModel
      : undefined;
  const model =
    lookupInheritedAgentValue(inputs.directoryDefaultModels, ref)?.value ??
    rememberedModel ??
    lookupInheritedAgentValue(inputs.configDefaultModels, ref)?.value;
  return { agentId, ...(model !== undefined ? { model } : {}) };
}

export interface ComposerAgentForCwd extends ComposerAgentSelection {
  // Something the caller should surface but that we deliberately did not
  // act on. Currently only a `home` key: see below.
  notice?: string;
}

// Resolve the composer's agent•model for `cwd`, reading that directory's
// `.hydra-acp.json` layers directly.
//
// Deliberately uses resolveDirectoryConfig rather than
// applyDirectoryConfig: the latter mutates process.env.HYDRA_ACP_HOME and
// installs the process-wide overlay, both of which are incoherent here.
// By the time the TUI is running we are already dialled into a daemon,
// holding its token and rendering its session list, so a `home` key in
// the directory we just switched to cannot be honored — it is reported
// and dropped. Leaving the process overlay alone likewise matters: any
// later loadConfig() in this process must still describe the directory
// hydra was launched from.
//
// Keys other than defaultAgent / defaultModels are ignored on purpose.
// They are either `overlay: "inert"` already (see core/config-tiers) or,
// like `tui`, feed layout that the picker computed when it opened.
export async function composerAgentForCwd(args: {
  cwd: string;
  config: HydraConfig;
  prefs: ComposerAgentPrefs;
  explicitAgentId?: string;
  fallbackAgentId?: string;
  availableAgents: readonly ComposerAgentChainSource[];
}): Promise<ComposerAgentForCwd> {
  let merged: Record<string, unknown> = {};
  let homeRequest: string | undefined;
  try {
    const resolved = await resolveDirectoryConfig(args.cwd);
    merged = resolved.merged;
    homeRequest = resolved.homeRequest;
  } catch {
    // An unreadable tree is not worth blanking the label over; fall
    // through with no directory layer.
  }
  const dirAgent = stringField(merged, "defaultAgent");
  const dirModels = stringMapField(merged, "defaultModels");
  const selection = resolveComposerAgent({
    ...(args.explicitAgentId !== undefined
      ? { explicitAgentId: args.explicitAgentId }
      : {}),
    ...(dirAgent !== undefined ? { directoryDefaultAgent: dirAgent } : {}),
    ...(dirModels !== undefined ? { directoryDefaultModels: dirModels } : {}),
    prefs: args.prefs,
    ...(args.fallbackAgentId !== undefined
      ? { fallbackAgentId: args.fallbackAgentId }
      : {}),
    configDefaultAgent: args.config.defaultAgent,
    configDefaultModels: args.config.defaultModels,
    availableAgents: args.availableAgents,
  });
  if (homeRequest !== undefined && homeRequest !== hydraHome()) {
    return {
      ...selection,
      notice: `that directory sets home: ${homeRequest} — run hydra there for a separate daemon`,
    };
  }
  return selection;
}
