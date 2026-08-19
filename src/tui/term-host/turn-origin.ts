// Read a turn's origin off the wire, for TerminalHostSnapshot.turnOrigin.
//
// Only ONE of the four origins needs reading. The TUI's three turn-start
// paths are already distinct call sites, so `self` (runPrompt) and `agent`
// (an unsolicited turn_started) are known by construction where they happen.
// What's left is the `prompt_received` broadcast, which the daemon sends to
// everyone EXCEPT the originator — so a prompt_received arriving here is
// always somebody else's, and this decides whether that somebody was a peer
// session or another client.
//
// Reads `sentBy` rather than the mapped RenderEvent because the render layer
// drops attribution on purpose (see mapPromptReceived in render-update.ts:
// the names are clutter under a prompt). That decision is about what the
// user reads in scrollback, not about what a host may know.

import type { TurnOrigin } from "./types.js";

/**
 * The `sentBy` bag on a `prompt_received` update. Every field is optional
 * except `clientId`; see PROTOCOL.md "Prompt provenance" for which
 * combinations occur.
 */
export interface PromptSentBy {
  clientId?: unknown;
  name?: unknown;
  fromSession?: unknown;
  fromSessionTitle?: unknown;
  fromLabel?: unknown;
  depth?: unknown;
}

export interface ClassifiedOrigin {
  origin: TurnOrigin;
  label: string | null;
}

function str(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Classify a prompt we did not send.
 *
 * Falls back to `client` with no label when `sentBy` is missing or
 * unrecognizable: a prompt_received we can't attribute still definitely came
 * from outside this pane, which is the part that matters. Guessing `peer`
 * there would overstate what we know.
 */
export function classifyPromptOrigin(sentBy: unknown): ClassifiedOrigin {
  if (!sentBy || typeof sentBy !== "object") {
    return { origin: "client", label: null };
  }
  const s = sentBy as PromptSentBy;
  const fromSession = str(s.fromSession);
  if (fromSession) {
    // fromSessionTitle is looked up from the session record and never
    // client-settable, so prefer it; fromLabel is asserted by the sender.
    // The raw session id is the last resort — long and opaque, but it beats
    // an unattributed peer turn.
    return {
      origin: "peer",
      label: str(s.fromSessionTitle) ?? str(s.fromLabel) ?? fromSession,
    };
  }
  // A label-only send (no resolved session) is an external program naming
  // itself, e.g. "jenkins:12847". Prefer it over `name`, which only says
  // which client library delivered the bytes.
  return { origin: "client", label: str(s.fromLabel) ?? str(s.name) };
}
