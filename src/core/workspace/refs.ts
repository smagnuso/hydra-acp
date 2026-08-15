// Names for the refs a workspace keeps in its SOURCE repository.
//
// All of them live outside refs/heads/ on purpose: a ref under
// refs/hydra/ is a GC root, so the objects survive, but it does not show
// up in `git branch`, default `git log`, or most UIs. That is what lets
// the daemon autosave every turn without filling the user's history with
// noise. The cost is that whoever writes one owns deleting it.
//
// Keyed by workspace LABEL, not by session id, because that is what they
// actually describe: where the source stood when this line of work
// began, and how the last landing left it. Both are properties of the
// workspace. They were session-keyed only because a workspace and a
// session used to be one-to-one, and that keying breaks as soon as two
// sessions share a workspace: whichever one happens to land would
// measure divergence from the moment IT joined rather than from the
// moment the work started, and mis-classify everything in between as the
// user's own edits.
//
// A label is unique within its repository, enforced where it is chosen:
// findFreeLabel rejects a candidate whose `hydra/<label>` branch exists,
// and that check runs against the repo root these refs live in. Labels
// are also already ref-safe, since sanitizeLabel restricts them to
// [A-Za-z0-9._-].
//
// The `ws/` segment keeps the new names from colliding with the old
// session-keyed ones, and makes a migration legible: `git for-each-ref
// refs/hydra/start/ws/` lists exactly the workspaces that have been
// anchored since the re-key.

const NS = "refs/hydra";

export interface WorkspaceAnchorRefs {
  /** Per-turn autosave of the workspace's working tree. */
  autosave: string;
  /** The source's state when this workspace was created. */
  start: string;
  /** How the last successful landing left the source. */
  baseline: string;
}

export function workspaceAnchorRefs(label: string): WorkspaceAnchorRefs {
  return {
    autosave: `${NS}/snapshots/ws/${label}`,
    start: `${NS}/start/ws/${label}`,
    baseline: `${NS}/baseline/ws/${label}`,
  };
}

/**
 * The pre-re-key names, still read (so a workspace created before the
 * change lands correctly) and still deleted (so nothing is left pinning
 * objects), but never written.
 */
export function legacyAnchorRefs(sessionId: string): WorkspaceAnchorRefs {
  return {
    autosave: `${NS}/snapshots/${sessionId}`,
    start: `${NS}/start/${sessionId}`,
    baseline: `${NS}/baseline/${sessionId}`,
  };
}

/**
 * Where a landing parks the source's pre-landing state so the reset it
 * performs cannot lose anything.
 *
 * Stays session-keyed, unlike the anchors above, because it describes an
 * act rather than a place: one session, landing right now. Two landings
 * into one source tree are hazardous for reasons a ref name cannot fix
 * (both reset --hard the same directory), and sharing this ref between
 * them would add a second, quieter way to lose the same work.
 */
export function landingRetainRef(sessionId: string): string {
  return `${NS}/landing/${sessionId}`;
}

/** Every anchor for a workspace, new and legacy, for cleanup sweeps. */
export function allAnchorRefs(label: string, sessionId: string): string[] {
  const fresh = workspaceAnchorRefs(label);
  const legacy = legacyAnchorRefs(sessionId);
  return [fresh.autosave, fresh.start, fresh.baseline, legacy.autosave, legacy.start, legacy.baseline];
}
