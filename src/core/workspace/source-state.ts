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
// gate refused the ordinary case — and it refused on any difference at
// all, including an edit to a file the workspace never touched.
//
// So: capture instead of check. Snapshot the source before touching it,
// let the landing proceed, then replay whatever the source had that the
// workspace did not. A reset is not destructive once its input is
// captured, and the only genuine failure left is two edits to the same
// lines, which is the one case a human actually has to arbitrate.
//
// Git-specific by nature: it exists to serve `merge --ff-only`, and a
// provider with no branches has nothing to land.

import { execFile as execFileCb } from "node:child_process";
import type { IsolationProvider, SnapshotId } from "./provider.js";

function runGit(
  args: string[],
  cwd: string,
): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    execFileCb("git", args, { cwd, timeout: 120_000, maxBuffer: 64 * 1024 * 1024 }, (e, o, s) => {
      resolve({ ok: !e, out: o ?? "", err: s ?? "" });
    });
  });
}

function applyPatch(cwd: string, patch: string, extra: string[] = []): Promise<boolean> {
  return new Promise((resolve) => {
    const child = execFileCb(
      "git",
      ["apply", ...extra],
      { cwd, timeout: 120_000, maxBuffer: 64 * 1024 * 1024 },
      (e) => resolve(!e),
    );
    child.stdin?.end(patch);
  });
}

export interface SourceCapture {
  /** Nothing uncommitted; the landing needs no reset and no replay. */
  clean: boolean;
  /** The source's working state, held so the reset cannot lose it. */
  snapshot?: SnapshotId;
  /**
   * What the source's changes are measured against, in preference order:
   * the state left by the last successful landing, else the snapshot
   * taken at `start`, else HEAD. Either snapshot makes the copy
   * invisible, since it is present in both trees and so cancels out of
   * the diff, leaving only genuine post-start edits.
   *
   * The landing baseline has to win where both exist. `merge` lands the
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
 * standing between the user and a `reset --hard` they did not ask for.
 */
export async function captureSourceForLanding(opts: {
  source: string;
  startSnapshotRef: string;
  /**
   * How the last successful landing left the source. Preferred over
   * `startSnapshotRef`, and absent until a first landing has run.
   */
  baselineRef?: string;
  retainRef: string;
  provider: IsolationProvider | undefined;
}): Promise<SourceCapture> {
  const { source, startSnapshotRef, baselineRef, retainRef, provider } = opts;
  const status = await runGit(["status", "--porcelain", "-uall"], source);
  // Resolved to a sha, never left as the symbolic "HEAD". The replay
  // runs AFTER the fast-forward has moved HEAD, so a symbolic base
  // would diff against the merged tip: the patch would then read as
  // "undo what the agent did and put my version back", apply cleanly,
  // and silently discard the agent's work.
  let base = "";
  // Baseline before start: a later landing measured against `start` would
  // find the work the last landing put there and report the workspace's
  // own changes as the user's.
  for (const ref of [baselineRef, startSnapshotRef]) {
    if (ref === undefined) {
      continue;
    }
    const resolved = await runGit(["rev-parse", `${ref}^{commit}`], source);
    if (resolved.ok && resolved.out.trim().length > 0) {
      base = resolved.out.trim();
      break;
    }
  }
  const dirty = !status.ok || status.out.trim().length > 0;
  if (base.length === 0) {
    // No anchor resolved. Harmless on a clean source — there is no
    // divergence to measure, so any base does — but NOT harmless when the
    // source is dirty, and falling back to HEAD there is actively
    // misleading.
    //
    // `start` COPIES the source's uncommitted work into the workspace, so
    // an anchor taken at start makes that copy cancel out of the diff and
    // leaves only genuine post-start edits. Measured from HEAD instead,
    // the copy reads as the user's own divergence — and the landing then
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
    base = (await runGit(["rev-parse", "HEAD"], source)).out.trim();
  }
  if (!dirty) {
    return { clean: true, base };
  }
  if (provider?.capabilities().supports.captureWorkingState !== true) {
    throw new Error(
      `${source} has uncommitted changes and this provider cannot snapshot them, ` +
        `so they cannot be preserved across the merge. Commit or stash them first.`,
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
  await runGit(["update-ref", "--create-reflog", retainRef, snapshot], source);
  return { clean: false, snapshot, base, retainedRef: retainRef };
}

/**
 * Put back whatever the source had that the workspace did not.
 *
 * Empty in the common case: work copied in at `start` sits in both
 * trees, so it cancels out of `diff(base, snapshot)` and only edits made
 * after isolating remain.
 *
 * Plain `git apply` is tried first, and that ordering is the point rather
 * than an optimization: it is atomic (all hunks or none, nothing written
 * on failure) and it leaves the work exactly as it was being held —
 * modifications unstaged, new files untracked. `--3way` cannot do that,
 * because it implies `--index`: reaching for it first hands back a
 * staged tree the user never had.
 *
 * `--3way` second, because by this point the tree may have moved: a
 * merge brought in the agent's commits, so a plain context match is too
 * brittle to rely on alone. A false return is a real overlap between the
 * two sets of edits.
 */
export async function replaySourceDivergence(opts: {
  source: string;
  capture: SourceCapture;
}): Promise<boolean> {
  const { source, capture } = opts;
  if (capture.clean || capture.snapshot === undefined) {
    return true;
  }
  const patch = await runGit(["diff", "--binary", capture.base, capture.snapshot], source);
  if (!patch.ok) {
    return false;
  }
  if (patch.out.trim().length === 0) {
    return true;
  }
  if (await applyPatch(source, patch.out)) {
    return true;
  }
  // Already applied is a no-op success, not an overlap. A prior `merge`
  // put this very content into the source, so the patch reverses cleanly
  // against the tree: that is what --reverse --check detects, and it
  // writes nothing.
  //
  // Probed BEFORE --3way on purpose. --3way leaves conflict markers in
  // the working tree when it fails, so reaching it in the
  // nothing-to-do case would dirty files to answer a question that was
  // already settled.
  if (await applyPatch(source, patch.out, ["--reverse", "--check"])) {
    return true;
  }
  return applyPatch(source, patch.out, ["--3way"]);
}

/** Drop the recovery ref once the landing has succeeded. */
export async function releaseSourceCapture(opts: {
  source: string;
  capture: SourceCapture;
}): Promise<void> {
  if (opts.capture.retainedRef === undefined) {
    return;
  }
  await runGit(["update-ref", "-d", opts.capture.retainedRef], opts.source);
}
