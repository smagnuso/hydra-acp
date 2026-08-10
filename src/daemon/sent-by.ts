import { HYDRA_META_KEY } from "../acp/types-hydra-meta.js";
import type { SessionManager } from "../core/session-manager.js";

// Per-prompt provenance asserted by the sender under
// `_meta["hydra-acp"].sentBy` on session/prompt.
//
// The connection's `clientInfo` already tells the daemon which PROGRAM
// delivered a prompt (hydra-acp-cat, hydra-acp-slack, hydra-acp-tui).
// That is per-connection, so every cat-driven push looks identical no
// matter who was behind it. This is the per-prompt layer underneath:
// which session, or which non-session producer, the prompt came from.
//
// Trust posture: any holder of a daemon token can assert any value, so
// this is an attribution to render, never an input to a permission
// decision. The one thing the daemon does enforce is that a claimed
// session id actually exists; an unknown id is dropped rather than
// forwarded, so a stale HYDRA_ACP_SESSION fails closed instead of
// pointing the receiver at a session that was never involved.
export interface SentBy {
  fromSession?: string;
  fromSessionTitle?: string;
  fromLabel?: string;
  // Hop count for this chain of agent-originated messages. Computed by
  // the daemon from the sender's in-flight turn, never taken from the
  // client: a sender that could pick its own depth could pick 0 forever
  // and the bound would mean nothing.
  depth?: number;
  // The sender is blocked awaiting this turn (a cat send without
  // --no-wait). Drives the deadlock guard; a fire-and-forget send can't
  // deadlock because nobody is waiting.
  awaiting?: boolean;
}

const MAX_LABEL_LEN = 200;

function readRawSentBy(
  params: unknown,
): { sessionId?: string; label?: string; awaiting?: boolean } | undefined {
  if (!params || typeof params !== "object") {
    return undefined;
  }
  const meta = (params as { _meta?: unknown })._meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return undefined;
  }
  const hydra = (meta as Record<string, unknown>)[HYDRA_META_KEY];
  if (!hydra || typeof hydra !== "object" || Array.isArray(hydra)) {
    return undefined;
  }
  const raw = (hydra as Record<string, unknown>).sentBy;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const out: { sessionId?: string; label?: string; awaiting?: boolean } = {};
  if (typeof obj.sessionId === "string" && obj.sessionId.length > 0) {
    out.sessionId = obj.sessionId;
  }
  if (typeof obj.label === "string" && obj.label.length > 0) {
    out.label = obj.label.slice(0, MAX_LABEL_LEN);
  }
  if (obj.awaiting === true) {
    out.awaiting = true;
  }
  if (out.sessionId === undefined && out.label === undefined) {
    return undefined;
  }
  return out;
}

// Validate the sender's claim and enrich it with the daemon's own view.
// Returns undefined when nothing survives, which is the same as the
// prompt carrying no provenance at all.
export async function normalizeSentBy(
  params: unknown,
  manager: SessionManager,
  onDropped?: (claimed: string) => void,
): Promise<SentBy | undefined> {
  const raw = readRawSentBy(params);
  if (!raw) {
    return undefined;
  }
  const out: SentBy = {};
  if (raw.label !== undefined) {
    out.fromLabel = raw.label;
  }
  if (raw.awaiting === true) {
    out.awaiting = true;
  }
  if (raw.sessionId !== undefined) {
    const canonical =
      (await manager.resolveCanonicalId(raw.sessionId)) ?? raw.sessionId;
    const entry = await manager.getOne(canonical);
    if (entry) {
      out.fromSession = canonical;
      if (entry.title) {
        out.fromSessionTitle = entry.title;
      }
      // Depth is one more than whatever the sender is currently
      // handling. A user-typed turn is depth 0, so the first
      // agent-to-agent hop is 1. A sender with no live turn (a CI
      // script, a hook, a cold session) starts a fresh chain at 1
      // rather than inheriting anything.
      const senderDepth = manager.get(canonical)?.currentPromptDepth;
      out.depth = (senderDepth ?? 0) + 1;
    } else {
      onDropped?.(raw.sessionId);
    }
  }
  if (out.fromSession === undefined && out.fromLabel === undefined) {
    return undefined;
  }
  return out;
}
