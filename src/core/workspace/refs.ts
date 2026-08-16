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

/** Every anchor for a workspace, for cleanup sweeps. */
export function allAnchorRefs(label: string): string[] {
  const refs = workspaceAnchorRefs(label);
  return [refs.autosave, refs.start, refs.baseline];
}
