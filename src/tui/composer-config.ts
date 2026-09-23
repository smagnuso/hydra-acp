// State behind the picker composer's "new session" popup: the three things
// a fresh session is created with (agent, model, host), each cycled with
// ←/→ the way `/hydra config` cycles its dimensions.
//
// Pure, so the cycling rules are testable without a terminal. The popup
// itself lives in composer-config-prompt.ts.

import type { DiscoveredAgent, HostInfo } from "./discovery.js";

export interface ComposerConfig {
  agentId?: string;
  // undefined means "the agent's own default".
  model?: string;
  // A federated remote's name; undefined means this daemon.
  host?: string;
}

export type ComposerConfigRow = "agent" | "model" | "host";

export interface ComposerConfigChoices {
  agents: DiscoveredAgent[];
  // What each federated remote offers; a host missing here (fetch failed)
  // falls back to the local agents.
  hostInfo?: Record<string, HostInfo>;
  localDefaultAgent?: string;
  // Federated remote names, without the implicit local entry.
  hosts: string[];
  // Models worth offering, e.g. every one configured in sessionDefaults.
  models: string[];
  // The configured default model for an agent on a host (undefined host is
  // local), applied when the agent or host changes.
  defaultModelFor: (
    agent: DiscoveredAgent | undefined,
    host: string | undefined,
  ) => string | undefined;
}

export const LOCAL_HOST_LABEL = "local";
export const DEFAULT_MODEL_LABEL = "(agent default)";

export function agentsForHost(
  choices: ComposerConfigChoices,
  host: string | undefined,
): DiscoveredAgent[] {
  const list = host === undefined ? undefined : choices.hostInfo?.[host]?.agents;
  return list && list.length > 0 ? list : choices.agents;
}

export function composerConfigRows(
  choices: ComposerConfigChoices,
): ComposerConfigRow[] {
  const rows: ComposerConfigRow[] = [];
  if (choices.agents.length > 0) {
    rows.push("agent");
    rows.push("model");
  }
  if (choices.hosts.length > 0) {
    rows.push("host");
  }
  return rows;
}

function step<T>(ring: T[], at: number, delta: 1 | -1): T {
  const from = at === -1 ? 0 : (at + delta + ring.length) % ring.length;
  return ring[from]!;
}

function modelRing(
  choices: ComposerConfigChoices,
  current: string | undefined,
): Array<string | undefined> {
  const seen = new Set<string>(choices.models);
  if (current !== undefined) {
    seen.add(current);
  }
  return [undefined, ...seen];
}

export function cycleComposerConfig(
  state: ComposerConfig,
  row: ComposerConfigRow,
  delta: 1 | -1,
  choices: ComposerConfigChoices,
): ComposerConfig {
  if (row === "agent") {
    const agents = agentsForHost(choices, state.host);
    if (agents.length === 0) {
      return state;
    }
    const at = agents.findIndex((a) => a.id === state.agentId);
    const next = step(agents, at, delta);
    const model = choices.defaultModelFor(next, state.host);
    const out: ComposerConfig = { ...state, agentId: next.id };
    if (model === undefined) {
      delete out.model;
    } else {
      out.model = model;
    }
    return out;
  }
  if (row === "model") {
    const ring = modelRing(choices, state.model);
    const next = step(ring, ring.indexOf(state.model), delta);
    const out: ComposerConfig = { ...state };
    if (next === undefined) {
      delete out.model;
    } else {
      out.model = next;
    }
    return out;
  }
  const ring: Array<string | undefined> = [undefined, ...choices.hosts];
  const next = step(ring, ring.indexOf(state.host), delta);
  const out: ComposerConfig = { ...state };
  if (next === undefined) {
    delete out.host;
  } else {
    out.host = next;
  }
  // Land on the new host's default agent (and its default model) unless
  // the user picked something else that the host also offers.
  const offered = agentsForHost(choices, out.host);
  const defaultOf = (host: string | undefined): string | undefined =>
    host === undefined
      ? choices.localDefaultAgent
      : choices.hostInfo?.[host]?.defaultAgent;
  const stillOffered = offered.some((a) => a.id === out.agentId);
  const wasDefault = out.agentId === defaultOf(state.host);
  if (offered.length > 0 && (!stillOffered || wasDefault)) {
    const agent =
      offered.find((a) => a.id === defaultOf(out.host)) ?? offered[0]!;
    out.agentId = agent.id;
    const model = choices.defaultModelFor(agent, out.host);
    if (model === undefined) {
      delete out.model;
    } else {
      out.model = model;
    }
  }
  return out;
}

export function composerConfigLabel(
  state: ComposerConfig,
  row: ComposerConfigRow,
): string {
  if (row === "agent") {
    return state.agentId ?? "(none)";
  }
  if (row === "model") {
    return state.model ?? DEFAULT_MODEL_LABEL;
  }
  return state.host ?? LOCAL_HOST_LABEL;
}
