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
   * Provider-specific display detail (git puts branch/base here). Readers
   * MUST tolerate absence: a copy provider emits nothing, and a client
   * that depends on this is a client that breaks on the second provider.
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
  | { ok: true; snapshot: SnapshotId }
  | { ok: false; conflicts: readonly string[] };

/** Thrown by operations a provider declares unsupported in capabilities(). */
export class WorkspaceUnsupportedError extends Error {
  constructor(providerKind: string, operation: string) {
    super(
      `provider "${providerKind}" does not support ${operation}; check capabilities().supports before calling`,
    );
    this.name = "WorkspaceUnsupportedError";
  }
}

export interface IsolationProvider {
  readonly kind: string;
  capabilities(): Capabilities;

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
  integrate(opts: { from: SnapshotId; into: Workspace }): Promise<IntegrateResult>;

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

/** Filesystem-safe label. Keeps the caller's intent legible in the path. */
export function sanitizeLabel(label: string): string {
  const cleaned = label.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 64) : "workspace";
}
