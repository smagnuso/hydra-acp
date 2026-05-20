// Helpers for state the TUI rebuilds after a daemon reconnect.
//
// Each session/attach mints a fresh clientId on the daemon side. The TUI
// caches that id in `ownClientId` so it can recognize own-originated
// broadcasts (prompt_queue_added, prompt_amended, ...) and bind them to
// local FIFO entries. On a transparent reconnect the daemon mints a NEW
// clientId — if the cache isn't refreshed the FIFO binding silently
// stops working, prompts never echo to scrollback, and (depending on
// subsequent permission/queue races) the prompt area can appear locked.
// See onReconnect in app.ts.

export interface ReattachResponseFields {
  // Echoed by the daemon when it could honor the requested historyPolicy.
  // Falls back to "full" when an after_message cutoff couldn't be found.
  appliedPolicy?: string;
  // The fresh clientId the daemon assigned to this attach. Always present
  // on a healthy daemon, but parsed defensively so a malformed response
  // doesn't wipe the cached id.
  clientId?: string;
}

// Pull the fields we care about out of a session/attach response result.
// Anything missing or of the wrong type is simply absent in the return
// value — callers decide what to do (typically: keep the prior value).
export function parseReattachResponse(result: unknown): ReattachResponseFields {
  const out: ReattachResponseFields = {};
  if (!result || typeof result !== "object") {
    return out;
  }
  const r = result as Record<string, unknown>;
  if (typeof r.historyPolicy === "string") {
    out.appliedPolicy = r.historyPolicy;
  }
  if (typeof r.clientId === "string" && r.clientId.length > 0) {
    out.clientId = r.clientId;
  }
  return out;
}
