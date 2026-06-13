import type { AdvertisedModel } from "./hydra-commands.js";

// Shared model-id resolver. All three places that turn a user-supplied
// model id into one we hand to `session/set_model` — the `defaultModels`
// / `--model` seed in bootstrapAgent, the daemon's `session/set_model`
// WS handler (decideSetModel), and the `/model` slash command — funnel
// through this so they agree on what "close enough" means. The same
// underlying logic is also reused for /hydra config option values via
// `resolveCandidate`.
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
// never silently pick the "wrong" provider. A final substring tier covers
// users who type a fragment like "sonnet-4-6" expecting the obvious hit;
// that, too, only commits when exactly one candidate contains it.

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
  return resolveCandidate(requested, advertised.map((m) => m.modelId));
}

// Generic value-agnostic resolver. Same tier ordering as resolveModelId:
// exact full-string match → trailing-segment match → case-insensitive
// substring match. Used by /hydra config option handlers so e.g.
// `/hydra config model sonnet-4-6` and `/hydra config agent codex` behave
// the same as the dedicated /model and /agent paths. For non-slashed
// values (most config options) the trailing-segment tier degenerates to
// case-insensitive equality, which is a safe widening.
export function resolveCandidate(
  requested: string,
  candidates: string[],
): ModelResolution {
  if (candidates.length === 0) {
    return { kind: "none", requested };
  }
  // 1. Exact full-id match always wins, even if a later tier would be
  //    ambiguous — the user named a real advertised id.
  if (candidates.includes(requested)) {
    return { kind: "exact", modelId: requested };
  }
  // 2. Trailing-segment match (provider-prefix agnostic), unambiguous only.
  const wantKey = trailingSegment(requested);
  const segMatches = candidates.filter((id) => trailingSegment(id) === wantKey);
  if (segMatches.length === 1) {
    return { kind: "resolved", modelId: segMatches[0]!, requested };
  }
  if (segMatches.length > 1) {
    return { kind: "ambiguous", requested, candidates: segMatches };
  }
  // 3. Substring match (case-insensitive), unambiguous only. Covers
  //    `/model sonnet-4-6` → `ncp-anthropic/claude-sonnet-4-6` and the
  //    like. Skipped silently when the query is empty so a stray ""
  //    doesn't claim "matches everything".
  const needle = requested.toLowerCase();
  if (needle.length > 0) {
    const subMatches = candidates.filter((id) => id.toLowerCase().includes(needle));
    if (subMatches.length === 1) {
      return { kind: "resolved", modelId: subMatches[0]!, requested };
    }
    if (subMatches.length > 1) {
      return { kind: "ambiguous", requested, candidates: subMatches };
    }
  }
  return { kind: "unknown", requested };
}
