// Isolation-provider contract: an abstract way to give a session its own
// materialization of a project's files.
//
// Git is ONE implementation, not the design. The daemon must be able to
// isolate sessions on a project that uses Perforce, SVN, or jj, and on a
// directory that is not under version control at all, so nothing in this
// file may name a git concept. Two implementations ship together
// (git-provider.ts and copy-provider.ts) specifically so the abstraction
// is exercised by something unlike git from the start: an interface with
// a single implementation is a guess.
//
// Vocabulary, and what it maps to:
//
//   Workspace   git worktree   |  Perforce client  |  a copied directory
//   Snapshot    commit sha     |  changelist       |  a stored copy id
//   Integrate   merge          |  integrate        |  3-way file merge
//
// Snapshot ids are OPAQUE. They are branded strings so the type system
// refuses code that builds one from a literal or picks it apart. Any
// caller that parses a snapshot id, assumes hex, assumes a length, or
// assumes ordering has broken the abstraction and will break the moment
// a non-git provider is selected.
//
// Errors: expected, recoverable conditions ("not a repository", "git is
// not installed") come back as { ok: false, reason } so the caller can
// decide whether to fail open. Genuinely unexpected IO errors still
// throw. This mirrors readJsonSafe/writeJsonAtomic in json-store.ts and
// the CwdValidation shape in cwd.ts.

import * as path from "node:path";
import { createHash } from "node:crypto";
import { hydraHome } from "../paths.js";

declare const snapshotBrand: unique symbol;
declare const deltaBrand: unique symbol;

/**
 * An opaque, provider-issued token naming a recorded state. Never
 * construct one from a literal; never parse one. Cross the deserialization
 * boundary with asSnapshotId().
 */
export type SnapshotId = string & { readonly [snapshotBrand]: true };

/**
 * Re-brand a string read back from persistence or the wire. This is the
 * ONLY sanctioned way to mint a SnapshotId outside a provider, and it
 * deliberately looks noisy at call sites so it stays rare.
 */
export function asSnapshotId(raw: string): SnapshotId {
  return raw as SnapshotId;
}

/**
 * An opaque, provider-issued representation of the difference between two
 * states, transferable between two materializations of one project.
 *
 * Branded for the same reason SnapshotId is, and the discipline matters
 * more here because the git form is a text patch and therefore *looks*
 * inspectable. A caller that greps it, counts its hunks, or edits it has
 * assumed a format no other provider owes them: a copy provider's delta is
 * a file manifest, and a server-backed one may be an opaque server handle.
 *
 * Deltas are not durable. A provider may express one relative to states
 * that only exist locally, so persisting one and replaying it later is
 * unsupported; retain a snapshot instead.
 */
export type StateDelta = string & { readonly [deltaBrand]: true };

/** Re-brand a delta across a serialization boundary. Rare by design. */
export function asStateDelta(raw: string): StateDelta {
  return raw as StateDelta;
}

export interface Workspace {
  /** Absolute path. Becomes the session's effective cwd. */
  readonly path: string;
  /** Absolute path of the tree this was derived from. */
  readonly sourceCwd: string;
  readonly label: string;
  /** Provider kind that owns this workspace ("git", "copy", ...). */
  readonly provider: string;
  /** State it was created from, when the provider records one. */
  readonly snapshot?: SnapshotId;
  /**
   * True when the provider is holding this workspace on hydra's behalf, as
   * observed by listWorkspaces.
   *
   * A held workspace means a session is live in it, so removing it would
   * pull the directory out from under a running agent. Reported as a boolean
   * rather than left for callers to recognize, because "held by us" versus
   * "held by a human" is a distinction encoded in the provider's own lock
   * format: callers were testing the lock reason against a hydra-specific
   * prefix, which is that format spelled out in a file that should not know
   * the provider has one.
   *
   * Absent when the provider does not lock, and absent on workspaces that
   * did not come from listWorkspaces.
   */
  readonly heldByUs?: boolean;

  /**
   * Handle for this workspace's own line of work, when the provider keeps
   * one.
   *
   * Pass it back to integrate(). Do not PARSE it: no caller may split it,
   * match a prefix against it, or infer a namespace from it. Ask ownsLine()
   * instead of testing for one. Displaying it IS fine: every plausible
   * provider names its lines something a human can read, and requiring a
   * currentLineName round-trip to obtain the very same string just to print
   * it is what made callers reach for `vcs.branch` instead, which is the
   * leak this field exists to close.
   *
   * Absent for providers with no notion of a line, which is exactly why
   * landing has to check for it rather than assume it.
   */
  readonly line?: string;
  /**
   * Provider-specific display detail (git puts branch/base/repoRoot here).
   *
   * Render it, do not read it. Nothing outside the owning provider may
   * index a key out of this map: the keys are that provider's vocabulary,
   * so a caller reading `vcs.branch` has hardcoded git, and a caller
   * reading `vcs.repoRoot` has hardcoded git's idea of where refs live.
   * Both were real, and both are why `line` and the Workspace-shaped ref
   * operations exist.
   *
   * Readers MUST tolerate absence: a copy provider emits nothing.
   */
  readonly vcs?: Readonly<Record<string, string>>;
}

/**
 * What a provider can actually do, so callers negotiate up front instead
 * of discovering a gap at the moment they need it. Without this the
 * contract collapses to the lowest common denominator and every provider
 * has to pretend it can do everything.
 */
export interface Capabilities {
  /** False when each workspace costs a full fetch or sync rather than sharing a local store. */
  readonly cheapWorkspaces: boolean;
  /** True when a recording made in one workspace is visible to others locally. */
  readonly sharedHistory: boolean;
  /** True when a dirty tree can be captured without modifying the user's files. */
  readonly nonMutatingCapture: boolean;
  /** True when a failed integrate names the conflicting paths rather than just failing. */
  readonly conflictReporting: boolean;
  readonly locking: boolean;
  readonly requiresServer: boolean;
  /** Operations beyond the always-present create/remove/list/status. */
  readonly supports: {
    readonly record: boolean;
    readonly integrate: boolean;
    readonly captureWorkingState: boolean;
    readonly changedPaths: boolean;
    readonly environmentNotes: boolean;
    /** Can a deleted workspace be rebuilt from retained state? */
    readonly rematerialize: boolean;
    /**
     * Does this provider reference trees it does not populate when a
     * workspace is created (git submodules, svn externals, a Perforce
     * client that maps another depot path)?
     *
     * False means "not applicable", not "unsupported": a copy provider
     * copies whatever was there, so there is nothing left to populate.
     */
    readonly nestedTrees: boolean;
  };
}

export interface NestedTreesResult {
  readonly ok: boolean;
  /** How many nested trees were acted on. Zero is the common case. */
  readonly count: number;
  /** Present when ok is false. */
  readonly reason?: string;
}

export interface WorkspaceStatus {
  readonly clean: boolean;
  /** Repo-relative paths. Never absolute: see the path-identity design. */
  readonly changedPaths: readonly string[];
  readonly hasRecordedWork: boolean;
  /**
   * True when some change is marked for inclusion in the next recorded
   * state, as distinct from merely present in the tree.
   *
   * Exists because carrying work between materializations deliberately does
   * NOT preserve that marking, and the difference is invisible otherwise:
   * the files arrive, and the caller has to be able to say that the marking
   * did not. Absent for providers with no such concept, which is not the
   * same as false.
   */
  readonly hasStagedWork?: boolean;
}

export interface PathChange {
  /** Repo-relative. */
  readonly path: string;
  readonly kind: "added" | "modified" | "deleted" | "renamed";
}

export interface CreateWorkspaceOptions {
  /**
   * The tree this workspace belongs to. Recorded as its origin and used
   * to choose its root, so it stays the PROJECT even when the initial
   * content is taken from somewhere else (see contentFrom).
   */
  readonly sourceCwd: string;
  readonly label: string;
  /** Omit for "current state of sourceCwd". */
  readonly from?: SnapshotId;
  /**
   * Materialize initial content from this directory instead of
   * sourceCwd, without changing which tree the workspace belongs to.
   *
   * Exists for forking an isolated session: the new workspace must start
   * from the PARENT WORKSPACE's contents (so in-progress work carries
   * over) while still recording the original project as its origin, or
   * cost attribution and session-list filtering would both point at a
   * sibling workspace that is itself temporary.
   *
   * Providers that can express this through `from` (git snapshots the
   * parent and branches from it) may ignore this field.
   */
  readonly contentFrom?: string;
}

export type CreateWorkspaceResult =
  | { ok: true; workspace: Workspace }
  | { ok: false; reason: string };

export type IntegrateResult =
  | {
      ok: true;
      snapshot: SnapshotId;
      /** Nothing to do: the work was already present. */
      alreadyUpToDate?: boolean;
    }
  | {
      ok: false;
      /** Paths the provider could not reconcile. Empty when it declined. */
      conflicts: readonly string[];
      /**
       * True when the integration never started, so nothing was written.
       *
       * Load-bearing for callers that retry: a declined integration can be
       * followed by a different strategy, while a conflicted one has left
       * state behind that must be resolved or abandoned first. Telling them
       * apart on the conflict list alone is wrong, because an integration
       * already in progress from an earlier attempt also refuses.
       */
      declined?: boolean;
      reason?: string;
    };

/** Thrown by operations a provider declares unsupported in capabilities(). */
export class WorkspaceUnsupportedError extends Error {
  constructor(providerKind: string, operation: string) {
    super(
      `provider "${providerKind}" does not support ${operation}; check capabilities().supports before calling`,
    );
    this.name = "WorkspaceUnsupportedError";
  }
}

/** Outcome of reproducing a delta somewhere. */
export interface DeltaOutcome {
  readonly ok: boolean;
  /**
   * True when the delta's content was already present, so nothing was
   * written. Distinct from ok: both mean "the target now has this
   * content", but only this one means the call was a no-op.
   */
  readonly alreadyPresent?: boolean;
  readonly reason?: string;
}

/** How two states stand relative to one another. */
export interface Divergence {
  /** States present in the second and missing from the first. */
  readonly behind: number;
  /** States present in the first and missing from the second. */
  readonly ahead: number;
}

export interface ResetOutcome {
  readonly ok: boolean;
  readonly reason?: string;
}

/**
 * One nested tree's state, as some materialization currently has it.
 *
 * `recorded` is what the containing tree says this nested tree should be
 * at; `actual` is where it is. They differ when the nested tree has been
 * advanced locally, which is uncommitted work in the sense that matters:
 * present in the user's tree, absent from the containing tree's recorded
 * state.
 */
export interface NestedState {
  /** Path relative to the containing tree's root. */
  readonly relPath: string;
  readonly actual: SnapshotId;
  readonly recorded?: SnapshotId;
  /** Paths changed inside it, relative to the nested tree. */
  readonly changedPaths: readonly string[];
}

/** A nested tree's state plus the delta needed to reproduce its contents. */
export interface NestedCapture extends NestedState {
  readonly delta?: StateDelta;
}

export interface NestedOutcome {
  readonly applied: readonly string[];
  readonly failed: readonly { path: string; reason: string }[];
}

export interface IsolationProvider {
  readonly kind: string;
  capabilities(): Capabilities;

  // ---------------------------------------------------------------------
  // State inspection.
  //
  // These exist so callers can reason about where a tree stands without
  // naming a git concept. Every one of them returns undefined rather than
  // throwing when it cannot answer, because the callers are decision
  // points ("can this land?", "has the source moved?") that must degrade
  // to silence rather than take a session down.
  // ---------------------------------------------------------------------

  /** The state a materialization currently sits at. */
  currentState(root: string): Promise<SnapshotId | undefined>;
  /**
   * Stable identity of a state's CONTENT, for equality tests.
   *
   * Separate from the snapshot id because two different recorded states
   * can hold identical content, and "are these two trees the same?" is a
   * question about content. Comparing snapshot ids answers a different
   * question and answers it wrongly: the join check depends on this.
   */
  contentId(root: string, state: SnapshotId): Promise<string | undefined>;
  /**
   * Display name of the line a materialization is on. Messages only.
   *
   * Explicitly not an identifier: a provider may have no concept of a
   * named line, and callers must not branch on its value.
   */
  currentLineName(root: string): Promise<string | undefined>;
  /** The root of the project containing `somePath`, if it is in one. */
  resolveRoot(somePath: string): Promise<string | undefined>;
  /**
   * What a retained handle currently points at, if it exists.
   *
   * Takes a Workspace rather than a path, matching retainSnapshot and
   * dropSnapshotRef. Where retained handles physically live is the
   * provider's business: git keeps them in the repository shared by every
   * worktree, which is neither the workspace directory nor necessarily the
   * source directory. Handing callers a `root` parameter made six of them
   * reach into `vcs.repoRoot` to compute it.
   */
  resolveRetained(ws: Workspace, ref: string): Promise<SnapshotId | undefined>;

  /** True when `state` is already contained within `within`. */
  contains(root: string, opts: { state: string; within: string }): Promise<boolean>;
  /** How far apart two states are, or undefined when it cannot be measured. */
  divergence(root: string, from: string, to: string): Promise<Divergence | undefined>;
  /** Paths that differ between two states. */
  changedPathsBetween(
    root: string,
    from: string,
    to: string,
  ): Promise<readonly string[]>;

  // ---------------------------------------------------------------------
  // Deltas: moving uncommitted content between materializations.
  // ---------------------------------------------------------------------

  /** Capture the difference between two states as a transferable delta. */
  captureDelta(
    root: string,
    from: SnapshotId,
    to: SnapshotId,
  ): Promise<StateDelta | undefined>;
  /**
   * Reproduce a delta in a materialization.
   *
   * `stage` records the content as part of the next snapshot rather than
   * leaving it loose. Default false, and callers should keep it that way
   * for anything derived from a user's in-progress work: staged content is
   * swept into whatever the agent records next, which is precisely the
   * outcome the copy-not-move design exists to avoid.
   *
   * `tolerant` lets the provider reconcile a delta that does not apply
   * cleanly, and to report `alreadyPresent` instead of failing when the
   * content is already there.
   */
  applyDelta(
    root: string,
    delta: StateDelta,
    opts?: { stage?: boolean; tolerant?: boolean },
  ): Promise<DeltaOutcome>;

  // ---------------------------------------------------------------------
  // Mutation.
  // ---------------------------------------------------------------------

  /**
   * Return a materialization to a recorded state, discarding what is not
   * in it.
   *
   * `purgeIgnored` extends that to files the project ignores. Off by
   * default: those are usually the expensive-to-rebuild ones (installed
   * dependencies, local configuration) and they are part of what made the
   * materialization usable rather than part of the work being discarded.
   */
  resetTo(
    root: string,
    state: SnapshotId,
    opts?: { purgeIgnored?: boolean },
  ): Promise<ResetOutcome>;

  /** True when an integration is half-finished and awaiting resolution. */
  integrationInProgress(root: string): Promise<boolean>;
  /** Abandon a half-finished integration, restoring the prior state. */
  abortIntegration(root: string): Promise<void>;
  /** Paths an in-progress integration could not reconcile. */
  conflictedPaths(root: string): Promise<readonly string[]>;

  // ---------------------------------------------------------------------
  // Nested trees.
  // ---------------------------------------------------------------------

  /** Enumerate nested trees and how each one stands. */
  listNested(root: string): Promise<readonly NestedState[]>;
  /** Capture whatever each nested tree holds that its container does not. */
  captureNested(
    root: string,
    states: readonly NestedState[],
  ): Promise<readonly NestedCapture[]>;
  /**
   * Reproduce captured nested state in a materialization, aligning each
   * nested tree before replaying its contents.
   *
   * `from` is the materialization the captures came from, because a
   * provider may need to reach it: nested trees are not guaranteed to
   * share storage with their container's other materializations, so a
   * state that exists in one may be unreachable from another.
   */
  reproduceNested(
    root: string,
    from: string,
    captures: readonly NestedCapture[],
  ): Promise<NestedOutcome>;
  /**
   * Bring a container's nested trees into line after an integration moved
   * what it records for them, then replay `captures` on top.
   *
   * Distinct from reproduceNested because the safety rule inverts: this
   * one must refuse a nested tree holding its own uncommitted work, since
   * the target is the user's tree rather than a fresh workspace.
   */
  integrateNested(
    root: string,
    from: string,
    captures: readonly NestedCapture[],
  ): Promise<NestedOutcome>;

  createWorkspace(opts: CreateWorkspaceOptions): Promise<CreateWorkspaceResult>;
  /**
   * `discardLine` also discards the provider's line of work (for git,
   * the branch), not just the checkout.
   *
   * Default false, because the line is what makes a removed workspace
   * recoverable: rematerialize rebuilds a vanished checkout from it. Set
   * it only when nothing can reference the line any more AND its content
   * is safe elsewhere — otherwise a surviving line is the difference
   * between "recoverable" and "gone".
   *
   * Keeping it around forever is not free either: a line name that
   * outlives its workspace collides with the next workspace that wants
   * the same label.
   */
  removeWorkspace(
    ws: Workspace,
    opts: { force: boolean; discardLine?: boolean },
  ): Promise<void>;
  /**
   * Rebuild a workspace directory that has gone missing, from whatever
   * the provider retained.
   *
   * This is what makes an isolated session resurrectable after its
   * directory is deleted. A session's recorded cwd IS its workspace, so
   * without this a removed workspace leaves a session that cannot be
   * brought back to anywhere meaningful.
   *
   * Retention is provider-specific and reported by
   * capabilities().supports.rematerialize: git keeps the branch when the
   * checkout is removed, so committed work returns intact, while a copy
   * provider retains nothing and must decline.
   */
  rematerialize(ws: Workspace): Promise<CreateWorkspaceResult>;
  /** What the provider itself believes exists, for reconciling against our records. */
  listWorkspaces(sourceCwd: string): Promise<readonly Workspace[]>;

  /**
   * Recover a workspace's identity from the directory itself, when no
   * record points at it any more.
   *
   * The path is a dead end: a hash and a label, sharing no prefix with the
   * source. The DIRECTORY is not, because a provider leaves its own
   * breadcrumb in one. Asking each provider in turn is how an unowned
   * directory gets handed back to the thing that knows how to tear it down
   * completely, which a bare recursive delete does not: it would leave the
   * provider's own bookkeeping pointing at a path that no longer exists.
   *
   * Returns undefined when this provider does not recognize the directory,
   * which is the normal answer for all but one of them.
   */
  attributeOrphan(dir: string): Promise<Workspace | undefined>;

  /**
   * Discard a line of work that has no materialization left.
   *
   * Distinct from removeWorkspace's `discardLine`, which tears down a
   * directory and its line together. This is the leftover case: a line
   * whose checkout is already gone, squatting on a label the next workspace
   * of that name will want.
   *
   * Reports how many recorded states went with it, because that is the only
   * measure of what is being thrown away and the caller has to be able to
   * say so before it happens.
   */
  discardLine(
    ws: Workspace,
    line: string,
  ): Promise<{ ok: boolean; dropped: number; reason?: string }>;

  /**
   * Whether a line is this provider's own to discard, rather than one the
   * user made.
   *
   * Asked rather than pattern-matched, because the naming convention is the
   * provider's: it chose the namespace when it created the workspace, so it
   * is the only thing that can recognize it. Callers were testing
   * `branch.startsWith("hydra/")`, which is git's namespace spelled out in
   * a file that should not know git has namespaces.
   */
  ownsLine(line: string): boolean;

  /**
   * Drop provider bookkeeping for materializations that no longer exist.
   *
   * Needed because removing a directory from underneath a provider (a
   * reaper, a disk cleanup, an `rm -rf`) leaves a registry entry pointing
   * nowhere, and that stale entry makes the provider refuse to create a new
   * workspace at the same path. A no-op for providers that keep no registry.
   */
  pruneStale(ws: Workspace): Promise<void>;
  status(ws: Workspace): Promise<WorkspaceStatus>;

  captureWorkingState(sourceCwd: string, message: string): Promise<SnapshotId>;
  /**
   * Keep a snapshot alive under a named handle so it survives garbage
   * collection, without it showing up as a branch.
   *
   * Autosave depends on both halves: durable enough that a deleted
   * workspace is recoverable, invisible enough that saving on every turn
   * does not fill the user's history with noise. Providers with no
   * concept of retention implement this as a no-op and report
   * captureWorkingState: false so callers do not rely on it.
   */
  retainSnapshot(ws: Workspace, ref: string, snapshot: SnapshotId): Promise<void>;
  /**
   * Release a retained snapshot. MUST be idempotent: it is called on
   * teardown regardless of whether anything was ever retained. Skipping
   * it leaks a GC root, which pins objects permanently.
   */
  dropSnapshotRef(ws: Workspace, ref: string): Promise<void>;
  record(ws: Workspace, message: string): Promise<SnapshotId>;
  changedPaths(ws: Workspace, since: SnapshotId): Promise<readonly PathChange[]>;
  /**
   * Bring work from one state or line into a materialization.
   *
   * Takes paths and opaque handles rather than a Workspace, because the
   * receiving side is usually the SOURCE tree: landing integrates the
   * workspace's line into the project, which is the opposite direction from
   * what a Workspace-shaped parameter suggests. Sync runs the same
   * operation the other way, and sharing one method is what keeps the two
   * from drifting apart.
   *
   * `fastForwardOnly` refuses unless the receiving tree can simply advance.
   * Callers landing into a user's tree should set it: it is what guarantees
   * that tree is never left holding a conflict it did not ask for, and
   * never gains a merge record nobody chose to create.
   */
  integrate(opts: {
    /** Materialization receiving the work. */
    into: string;
    /** Opaque state or line handle being integrated. */
    from: string;
    fastForwardOnly?: boolean;
    /** Description for the integration record, when one is created. */
    message?: string;
    /**
     * What to do when reconciliation fails. "abort" restores the receiving
     * tree; "keep" leaves the conflict there to resolve by hand.
     */
    onConflict?: "abort" | "keep";
  }): Promise<IntegrateResult>;

  lock(ws: Workspace, reason: string): Promise<void>;
  unlock(ws: Workspace): Promise<void>;

  /**
   * Populate trees the workspace references but did not materialize.
   *
   * A `git worktree` leaves submodule directories EMPTY, which is an
   * artifact of how worktrees are made rather than anything the caller
   * asked for. Left that way, a workspace in a submodule repo cannot
   * build, and the agent is one plausible-looking `git add` away from
   * re-committing the empty directories as ordinary files. So this is
   * part of making a workspace usable, alongside carry and postCreate,
   * not an optional extra.
   *
   * Expensive: potentially a full fetch per nested tree. Callers run it
   * in the setup phase where slowness is expected and reported, and
   * providers that declare `supports.nestedTrees: false` return a
   * zero-count success rather than throwing, because "nothing to do" is
   * the common answer even for providers that CAN do it.
   *
   * `discardLocal` additionally returns already-populated nested trees to
   * their recorded state, discarding changes inside them. Needed because
   * the operations that clear a tree do not reach inside a nested one:
   * neither `reset --hard` nor `clean -fd` touches a submodule's working
   * tree (verified on git 2.43), so a caller that skips this leaves
   * exactly the mess it was asked to remove.
   *
   * `purgeIgnored` extends that to ignored files inside nested trees, for
   * the deep variant that intends to rebuild rather than preserve them.
   */
  materializeNested(
    ws: Workspace,
    opts?: { discardLocal?: boolean; purgeIgnored?: boolean },
  ): Promise<NestedTreesResult>;

  /**
   * Agent-facing caveats about this workspace, conditional on inspected
   * state. Exists so an agent meeting an artifact of isolation does not
   * try to repair it.
   */
  environmentNotes(ws: Workspace): Promise<readonly string[]>;

  /**
   * Lines describing this workspace's current state, for showing to a
   * user or an agent.
   *
   * Prose, and provider-authored, because the useful detail is exactly
   * the part that does not generalize: git separates staged from unstaged
   * and has a source tip to compare against, a copied directory has
   * neither. status() cannot carry it either: its changedPaths is bare
   * paths, so the distinction is gone before a caller sees it.
   *
   * A caller renders these verbatim and interprets nothing. Same shape
   * and same reasoning as environmentNotes().
   */
  statusReport(ws: Workspace): Promise<readonly string[]>;
}

/**
 * Root for a source tree's workspaces, outside the repo.
 *
 * Outside rather than inside so agent scratch never lands in the user's
 * tree and needs no .gitignore entry. The consequence is load-bearing: a
 * workspace shares NO path prefix with its source, so nothing anywhere
 * may relate the two by prefix matching. The derivation edge is recorded
 * explicitly on the session record instead.
 *
 * hydraHome() honors HYDRA_ACP_HOME, which vitest.setup.ts clamps to a
 * per-worker tmpdir, so workspaces are test-isolated with no fixture work.
 */
export function workspaceRootFor(sourceCwd: string): string {
  const digest = createHash("sha256")
    .update(path.resolve(sourceCwd))
    .digest("hex")
    .slice(0, 12);
  return path.join(hydraHome(), "workspaces", digest);
}

/**
 * Find a label no existing workspace is using, suffixing `-2`, `-3`, …
 *
 * Callers ask for isolation, not for a particular name, so a taken label
 * is adjusted rather than refused. What must never happen is handing back
 * an EXISTING workspace: two sessions in one checkout is the failure this
 * whole mechanism exists to prevent.
 *
 * `isFree` is provider-supplied because "taken" differs by provider. For
 * git a label is taken when either its directory or its branch exists,
 * and the branch half is the subtle one: a branch outlives its checkout
 * (that is what makes a removed workspace recoverable), so a label whose
 * directory is long gone can still be spoken for.
 */
export async function findFreeLabel(
  requested: string,
  isFree: (label: string) => Promise<boolean>,
  limit = 100,
): Promise<string | undefined> {
  if (await isFree(requested)) {
    return requested;
  }
  for (let n = 2; n <= limit; n += 1) {
    const candidate = `${requested}-${n}`;
    if (await isFree(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Cap a list destined for a chat reply, replacing the tail with a count.
 *
 * A workspace mid-refactor has hundreds of changed paths, and these
 * replies are rendered into the agent's context window as well as the
 * user's screen.
 */
export function capLines(items: readonly string[], cap = 10): string[] {
  if (items.length <= cap) {
    return [...items];
  }
  const kept = items.slice(0, cap);
  const rest = items.length - cap;
  return [...kept, `... and ${rest} more`];
}

/** True when a nested tree holds anything its container does not already have. */
export function nestedHasWork(state: NestedState): boolean {
  return (
    state.changedPaths.length > 0 ||
    (state.recorded !== undefined && state.recorded !== state.actual)
  );
}

/** Per-file paths inside nested trees, for a human-facing list. */
function nestedReportPaths(states: readonly NestedState[]): string[] {
  const out: string[] = [];
  for (const state of states) {
    if (state.changedPaths.length === 0) {
      out.push(`${state.relPath} (nested tree advanced to ${state.actual.slice(0, 8)})`);
      continue;
    }
    for (const p of state.changedPaths) {
      out.push(`${state.relPath}/${p}`);
    }
  }
  return out;
}

/**
 * Replace a container's one-line-per-nested-tree view with real per-file
 * detail.
 *
 * A container reports a nested tree holding thirty edits as the single path
 * `sub`, so a caller counting its changed paths reports "1 file". Both the
 * carried list and the left-behind list get read to check whether a
 * specific piece of work moved, which that count cannot answer.
 */
export function expandChangedPaths(
  containerPaths: readonly string[],
  states: readonly NestedState[],
): string[] {
  const roots = new Set(states.map((s) => s.relPath));
  const kept = containerPaths.filter((p) => !roots.has(p.replace(/\/$/, "")));
  return [...kept, ...nestedReportPaths(states.filter(nestedHasWork))];
}

/** Filesystem-safe label. Keeps the caller's intent legible in the path. */
export function sanitizeLabel(label: string): string {
  const cleaned = label.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 64) : "workspace";
}
