// Landing a workspace back into a source tree that is legitimately
// dirty.
//
// `workspace start` copies the user's uncommitted work rather than
// taking it, because the source tree is shared: their editor is open on
// it, other sessions are working in it, and the next `start` snapshots
// whatever is present at that moment. The cost of copying is that at
// landing time the same edits exist in two places, and the source may
// have moved on besides.
//
// The obvious way to settle that is a gate: compare the source against
// the snapshot `start` took, and refuse unless it matches. That is what
// this module used to do, and it was too strict. Under copy semantics,
// carrying on working in the source IS the intended workflow, so the
// gate refused the ordinary case, and it refused on any difference at
// all, including an edit to a file the workspace never touched.
//
// So: capture instead of check. Snapshot the source before touching it,
// let the landing proceed, then replay whatever the source had that the
// workspace did not. A reset is not destructive once its input is
// captured, and the only genuine failure left is two edits to the same
// lines, which is the one case a human actually has to arbitrate.
//
// Every operation here goes through the provider. This module holds the
// ORDER in which things must happen and the reasons behind it; which
// version-control system is underneath is not its business, and it used
// to run its own git, which is how that knowledge leaked out of the one
// file that is supposed to own it.

import type { IsolationProvider, SnapshotId, Workspace } from "./provider.js";

export interface SourceCapture {
  /** Nothing uncommitted; the landing needs no reset and no replay. */
  clean: boolean;
  /** The source's working state, held so the reset cannot lose it. */
  snapshot?: SnapshotId;
  /**
   * What the source's changes are measured against, in preference order:
   * the state left by the last successful landing, else the snapshot
   * taken at `start`, else the source's current state. Either snapshot
   * makes the copy invisible, since it is present in both trees and so
   * cancels out of the difference, leaving only genuine post-start edits.
   *
   * The landing baseline has to win where both exist. Landing brings the
   * workspace's work into the source and stays put, so measuring a later
   * landing against `start` finds that work still sitting there and
   * reports the workspace's own changes as the user's.
   */
  base: string;
  /** Ref holding `snapshot`, so a failed replay is still recoverable. */
  retainedRef?: string;
}

/**
 * Record the source tree's state before a landing writes to it.
 *
 * Performs no mutation, so a caller that gives up after this has
 * changed nothing. The returned snapshot is retained under a ref rather
 * than left dangling: if a later step fails, that ref is the only thing
 * standing between the user and a reset they did not ask for.
 */
export async function captureSourceForLanding(opts: {
  source: string;
  /** The workspace being landed, for the provider's ref operations. */
  ws: Workspace;
  startSnapshotRef: string;
  /**
   * How the last successful landing left the source. Preferred over
   * `startSnapshotRef`, and absent until a first landing has run.
   */
  baselineRef?: string;
  retainRef: string;
  provider: IsolationProvider | undefined;
}): Promise<SourceCapture> {
  const { source, ws, startSnapshotRef, baselineRef, retainRef, provider } = opts;
  if (provider === undefined) {
    throw new Error("no provider available to inspect the source tree");
  }
  const status = await provider
    .status({ ...ws, path: source })
    .catch(() => undefined);
  // Resolved to a concrete state, never left as a symbolic name. The
  // replay runs AFTER the integration has moved the source, so a symbolic
  // base would measure against the integrated tip: the difference would
  // then read as "undo what the agent did and put my version back", apply
  // cleanly, and silently discard the agent's work.
  let base = "";
  // Baseline before start: a later landing measured against `start` would
  // find the work the last landing put there and report the workspace's
  // own changes as the user's.
  for (const ref of [baselineRef, startSnapshotRef]) {
    if (ref === undefined) {
      continue;
    }
    const resolved = await provider.resolveRetained(ws, ref).catch(() => undefined);
    if (resolved !== undefined) {
      base = resolved;
      break;
    }
  }
  const dirty = status === undefined || status.changedPaths.length > 0;
  if (base.length === 0) {
    // No anchor resolved. Harmless on a clean source, since there is no
    // divergence to measure, but NOT harmless when the source is dirty,
    // and falling back to its current state there is actively misleading.
    //
    // `start` COPIES the source's uncommitted work into the workspace, so
    // an anchor taken at start makes that copy cancel out and leaves only
    // genuine post-start edits. Measured from the current state instead,
    // the copy reads as the user's own divergence, and the landing then
    // replays it on top of the very same content arriving from the
    // workspace, producing a conflict that blames the user for an overlap
    // they did not create. Refusing is the honest answer: we cannot tell
    // their edits from our copy.
    if (dirty) {
      throw new Error(
        `${source} has uncommitted changes but this workspace has no start anchor, so its ` +
          `copy of your work cannot be told apart from edits you made since. Refusing rather ` +
          `than reporting a conflict that is not yours. Commit or stash the source, then retry.`,
      );
    }
    const current = await provider.currentState(source).catch(() => undefined);
    base = current ?? "";
  }
  if (!dirty) {
    return { clean: true, base };
  }
  if (provider.capabilities().supports.captureWorkingState !== true) {
    throw new Error(
      `${source} has uncommitted changes and this provider cannot snapshot them, ` +
        `so they cannot be preserved across the landing. Commit or stash them first.`,
    );
  }
  const snapshot = await provider
    .captureWorkingState(source, "hydra: source state before landing")
    .catch(() => undefined);
  if (snapshot === undefined) {
    throw new Error(
      `could not snapshot the uncommitted changes in ${source}, so refusing to touch them`,
    );
  }
  await provider.retainSnapshot({ ...ws, path: source }, retainRef, snapshot);
  return { clean: false, snapshot, base, retainedRef: retainRef };
}

/**
 * Put back whatever the source had that the workspace did not.
 *
 * Empty in the common case: work copied in at `start` sits in both
 * trees, so it cancels out of the difference between `base` and the
 * snapshot, and only edits made after isolating remain.
 *
 * `tolerant` carries the whole strategy. The provider tries an exact
 * reproduction first (atomic, and it preserves the shape the work was
 * held in), then detects already-applied content as a no-op success,
 * then falls back to reconciling. Doing that here, in terms of patches,
 * is what previously required this module to know it was talking to git.
 * A false return is a real overlap between the two sets of edits.
 */
export async function replaySourceDivergence(opts: {
  source: string;
  capture: SourceCapture;
  provider: IsolationProvider | undefined;
}): Promise<boolean> {
  const { source, capture, provider } = opts;
  if (capture.clean || capture.snapshot === undefined || provider === undefined) {
    return true;
  }
  const delta = await provider
    .captureDelta(source, capture.base as SnapshotId, capture.snapshot)
    .catch(() => undefined);
  if (delta === undefined) {
    return false;
  }
  const outcome = await provider.applyDelta(source, delta, { tolerant: true });
  return outcome.ok;
}

/** Drop the recovery ref once the landing has succeeded. */
export async function releaseSourceCapture(opts: {
  source: string;
  ws: Workspace;
  capture: SourceCapture;
  provider: IsolationProvider | undefined;
}): Promise<void> {
  if (opts.capture.retainedRef === undefined || opts.provider === undefined) {
    return;
  }
  await opts.provider
    .dropSnapshotRef({ ...opts.ws, path: opts.source }, opts.capture.retainedRef)
    .catch(() => undefined);
}
