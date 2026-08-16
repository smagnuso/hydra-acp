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
// workspace, and session-keying breaks outright once two sessions share
// one: whichever happened to land would measure divergence from the
// moment IT joined rather than from when the work started, and
// mis-classify everything in between as the user's own edits.
//
// A label is unique within its repository, enforced where it is chosen:
// findFreeLabel rejects a candidate whose `hydra/<label>` branch exists,
// and that check runs against the repo root these refs live in. Labels
// are also already ref-safe, since sanitizeLabel restricts them to
// [A-Za-z0-9._-].
//
// Grouped by WORKSPACE first, role second, so everything about one
// workspace is a single prefix:
//
//   git for-each-ref 'refs/hydra/workspaces/stuff-2/**'
//
// which is exactly the query you want when recovering work or working
// out what a workspace left behind. Tearing its refs down is likewise
// one prefix rather than a list of names.

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
  const base = `${NS}/workspaces/${label}`;
  return {
    autosave: `${base}/autosave`,
    start: `${base}/start`,
    baseline: `${base}/baseline`,
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

/**
 * Where a sync parks the workspace's uncommitted work while it merges.
 *
 * A merge cannot run under uncommitted changes to a file it wants to
 * write, and a workspace with an agent in it is dirty as a matter of
 * course, so the work is set aside and replayed. This ref is what makes
 * that safe: between the reset and the replay the tree is the only other
 * copy, and if the replay fails it is the only one left.
 *
 * Not an anchor. Anchors describe a workspace and live as long as it
 * does; this exists for the duration of one merge and is deleted the
 * moment the work is back, exactly like `landingRetainRef`. Which is
 * also why it is absent from `allAnchorRefs`: a teardown sweep must not
 * remove the one copy of work a failed replay left behind.
 */
export function syncRetainRef(label: string): string {
  return `${NS}/sync/${label}`;
}

/**
 * Where a snapshot goes when it outlives the workspace that made it.
 *
 * A label is a name, not an identity: it is free again the moment its
 * workspace is gone, so the same session retrying gets the same label and
 * the same ref path. A snapshot left in the live namespace is therefore
 * overwritten by the NEXT workspace of that name on its first turn —
 * which silently invalidates the recovery command `discard` printed, and
 * mixes two unrelated workspaces into one reflog.
 *
 * Keyed by content, so it cannot collide and cannot be recycled: the same
 * snapshot retired twice lands on the same name, and two different ones
 * never share.
 */
export function retiredSnapshotRef(label: string, sha: string): string {
  return `${NS}/retired/${label}-${sha.slice(0, 12)}`;
}

/** Every anchor for a workspace, for cleanup sweeps. */
export function allAnchorRefs(label: string): string[] {
  const refs = workspaceAnchorRefs(label);
  return [refs.autosave, refs.start, refs.baseline];
}
