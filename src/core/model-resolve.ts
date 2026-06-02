import type { AdvertisedModel } from "./hydra-commands.js";

// Shared model-id resolver. All three places that turn a user-supplied
// model id into one we hand to `session/set_model` — the `defaultModels`
// / `--model` seed in bootstrapAgent, the daemon's `session/set_model`
// WS handler (decideSetModel), and the `/model` slash command — funnel
// through this so they agree on what "close enough" means.
//
// The motivating case: a user configures `defaultModels[pi-dev] =
// "claude-opus-4-7"`, but the agent advertises the fully-qualified
// `anthropic/claude-opus-4-7`. The bare id isn't an exact string match,
// so the old code rejected it and silently fell back to the agent's
// default (opus-4-8). Provider prefixes (`anthropic/`, `ncp-anthropic/`,
// `openai/`) drift between agents and registry pushes; requiring the user
// to track the exact prefix is brittle. So when there's no exact match we
// fall back to matching on the segment after the last `/` — but only
// commit if that resolves to exactly one advertised model. Two matches
// (e.g. both `anthropic/claude-opus-4-7` and `ncp-anthropic/claude-opus-4-7`
// advertised) stays ambiguous and is left for the caller to reject, so we
// never silently pick the "wrong" provider.

export type ModelResolution =
  // Requested id is itself an advertised modelId. modelId === requested.
  | { kind: "exact"; modelId: string }
  // Requested id matched exactly one advertised model by its trailing
  // segment. modelId is the advertised id to actually send.
  | { kind: "resolved"; modelId: string; requested: string }
  // Agent advertised no model list — nothing to validate against. Caller
  // decides whether to pass through (trust the agent) or skip.
  | { kind: "none"; requested: string }
  // Requested id matched several advertised models by trailing segment;
  // too risky to pick one. candidates lists the colliding advertised ids.
  | { kind: "ambiguous"; requested: string; candidates: string[] }
  // No exact or trailing-segment match against a non-empty list.
  | { kind: "unknown"; requested: string };

// The comparison key for fuzzy matching: the segment after the last "/",
// lowercased. So "anthropic/claude-opus-4-7" and "ncp-anthropic/claude-opus-4-7"
// both key to "claude-opus-4-7", as does a bare "claude-opus-4-7".
function trailingSegment(modelId: string): string {
  const slash = modelId.lastIndexOf("/");
  const tail = slash === -1 ? modelId : modelId.slice(slash + 1);
  return tail.toLowerCase();
}

export function resolveModelId(
  requested: string,
  advertised: AdvertisedModel[],
): ModelResolution {
  if (advertised.length === 0) {
    return { kind: "none", requested };
  }
  // 1. Exact full-id match always wins, even if the trailing segment
  //    would be ambiguous — the user named a real advertised id.
  if (advertised.some((m) => m.modelId === requested)) {
    return { kind: "exact", modelId: requested };
  }
  // 2. Fall back to trailing-segment match (provider-prefix agnostic),
  //    but only commit when it's unambiguous.
  const wantKey = trailingSegment(requested);
  const candidates = advertised
    .map((m) => m.modelId)
    .filter((id) => trailingSegment(id) === wantKey);
  if (candidates.length === 1) {
    return { kind: "resolved", modelId: candidates[0]!, requested };
  }
  if (candidates.length > 1) {
    return { kind: "ambiguous", requested, candidates };
  }
  return { kind: "unknown", requested };
}
