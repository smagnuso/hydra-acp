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
  // Epoch-ms of the in-flight turn's start, or undefined if the daemon
  // considers the session idle. Used by onReconnect to reconcile
  // pendingTurns: if the daemon is idle but the TUI still has pendingTurns
  // > 0 (turn_complete was never emitted before the daemon restarted),
  // snap pendingTurns to 0 so the banner clears.
  turnStartedAt?: number;
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
  const meta = r._meta;
  if (meta && typeof meta === "object") {
    const hydra = (meta as Record<string, unknown>)["hydra-acp"];
    if (hydra && typeof hydra === "object") {
      const ts = (hydra as Record<string, unknown>).turnStartedAt;
      if (typeof ts === "number") {
        out.turnStartedAt = ts;
      }
    }
  }
  return out;
}

// True when the drift-reconcile snap inside the turn-complete handler
// should fire. The snap exists for genuine drift (e.g. a daemon restart
// dropped a turn_complete and left pendingTurns stuck above 0). It must
// NOT fire while applying replayed historical turn_completes during an
// attach drain — there pendingTurns being above 0 means the most recent
// prompt_received in history hasn't been paired yet, which is correct
// state, not drift. The other inputs distinguish a real turn boundary
// (no queued prompt, no own prompt awaiting, no in-flight head) from a
// boundary where some local signal already says we're mid-turn.
export function shouldDriftSnap(args: {
  pendingTurns: number;
  queueSize: number;
  ownTurnInFlight: boolean;
  hasInFlightHead: boolean;
  replayDraining: boolean;
}): boolean {
  return (
    !args.replayDraining &&
    args.pendingTurns > 0 &&
    args.queueSize === 0 &&
    !args.ownTurnInFlight &&
    !args.hasInFlightHead
  );
}

// Result of reconciling local pendingTurns/banner state against the
// daemon's authoritative turnStartedAt after an attach (initial or
// reconnect). Both directions of disagreement get a fix:
//   - daemon busy, local idle  → bump pendingTurns up, banner busy
//   - daemon idle, local busy  → snap pendingTurns to 0, banner ready
// busySince is populated whenever the result banner is "busy" so the
// elapsed counter can tick from the real turn start rather than from
// attach time.
export interface AttachReconcile {
  pendingTurnsDelta: number;
  banner: "busy" | "ready";
  busySince?: number;
}

export function computeAttachReconcile(args: {
  daemonTurnStartedAt: number | undefined;
  pendingTurns: number;
}): AttachReconcile {
  if (args.daemonTurnStartedAt !== undefined) {
    const delta = args.pendingTurns === 0 ? 1 : 0;
    return {
      pendingTurnsDelta: delta,
      banner: "busy",
      busySince: args.daemonTurnStartedAt,
    };
  }
  const delta = args.pendingTurns > 0 ? -args.pendingTurns : 0;
  return { pendingTurnsDelta: delta, banner: "ready" };
}
