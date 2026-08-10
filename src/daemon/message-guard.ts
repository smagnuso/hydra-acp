// Loop and deadlock guards for session-to-session prompts.
//
// Two independent rules, both keyed off the provenance the daemon
// already validates (see sent-by.ts):
//
//   Depth   — how many hops a chain of agent-to-agent messages has
//             taken. Bounds runaway ping-pong without banning the
//             single most useful case, which is one session replying
//             to another.
//
//   Deadlock — a blocking send whose target is already (transitively)
//             blocked waiting on the sender. That is not a loop, it is
//             a hang: the sender's prompt queues behind the target's
//             in-flight turn, and that turn cannot finish until the
//             sender's own turn does.
//
// Both are safety nets against accidental loops between cooperating
// sessions, not adversarial controls. `sentBy.fromSession` is asserted
// by the sender, so a client that simply omits it evades both. The
// default path is honest because HYDRA_ACP_SESSION is applied
// automatically, which is what makes the nets worth having.

// Maximum hops in one chain of agent-originated messages. A user-typed
// turn is depth 0, so 3 allows: A messages B (1), B replies (2), A
// follows up (3), and stops the fourth. Enough for a real exchange,
// short enough that a runaway costs a bounded number of turns.
export const MAX_MESSAGE_DEPTH = 3;

// Live "sender is blocked waiting on target" edges. One entry per
// in-flight blocking send: added when the daemon starts awaiting the
// prompt, removed when that await settles. Module-level because the
// two call sites are inside per-connection request handlers with no
// shared object between them, matching how scrub-env.ts handles the
// same problem.
const blockingEdges = new Map<string, Set<string>>();

/**
 * Record that `from` is blocked awaiting a turn in `to`. Returns the
 * release function; callers must invoke it in a finally so a thrown
 * prompt can't strand an edge and wedge the pair permanently.
 */
export function registerBlockingEdge(from: string, to: string): () => void {
  let targets = blockingEdges.get(from);
  if (!targets) {
    targets = new Set();
    blockingEdges.set(from, targets);
  }
  targets.add(to);
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    const live = blockingEdges.get(from);
    if (!live) {
      return;
    }
    live.delete(to);
    if (live.size === 0) {
      blockingEdges.delete(from);
    }
  };
}

/**
 * True when prompting `to` from `from` would deadlock: `to` is already
 * blocked waiting on `from`, directly or through a chain. Walks the
 * live edge graph forward from `to` looking for `from`.
 */
export function wouldDeadlock(from: string, to: string): boolean {
  // A session prompting itself while mid-turn queues behind that turn
  // and never runs, which is the degenerate case of the same problem.
  if (from === to) {
    return true;
  }
  const seen = new Set<string>();
  const stack = [to];
  while (stack.length > 0) {
    const node = stack.pop() as string;
    if (seen.has(node)) {
      continue;
    }
    seen.add(node);
    const targets = blockingEdges.get(node);
    if (!targets) {
      continue;
    }
    if (targets.has(from)) {
      return true;
    }
    for (const next of targets) {
      stack.push(next);
    }
  }
  return false;
}

/** Test-only: drop all edges so cases can't leak into one another. */
export function __resetBlockingEdgesForTests(): void {
  blockingEdges.clear();
}

/** Test/diagnostic view of the live edge set. */
export function blockingEdgeCount(): number {
  let n = 0;
  for (const targets of blockingEdges.values()) {
    n += targets.size;
  }
  return n;
}
