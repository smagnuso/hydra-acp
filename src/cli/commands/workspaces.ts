// `hydra workspace list|prune` — what isolated checkouts exist, which
// session owns each, and which are safe to reclaim.
//
// Reads the filesystem rather than the daemon, deliberately. The two
// questions this answers ("what is lying around" and "can I delete it")
// are exactly the ones you ask when something has gone wrong, which is
// often when the daemon is down or is itself the suspect. Session
// records on disk carry the binding, so nothing here needs the daemon
// running.
//
// A workspace and its source tree share no path prefix, so the
// directory *name* cannot tell you which project it belongs to. The
// binding lives in the session record. But a workspace whose record is
// gone is still not anonymous: the directory itself names its origin (a
// git worktree in `.git`, a copy workspace in its manifest), which is
// what attributeUnowned recovers. "Unowned" therefore means "no session
// owns this", not "nothing is known about this" — the distinction
// matters because it is the provider, recovered that way, that knows
// how to tear one down completely.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { paths } from "../../core/paths.js";
import { readJsonSafe } from "../../core/json-store.js";
import { getProvider, providerKinds } from "../../core/workspace/registry.js";
import { shortenHomePath } from "../../core/paths.js";
import { asSnapshotId, type Workspace } from "../../core/workspace/provider.js";
import {
  captureSourceForLanding,
  releaseSourceCapture,
  replaySourceDivergence,
  type SourceCapture,
} from "../../core/workspace/source-state.js";
import { invokedBinName } from "../../core/bin-name.js";
import {
  allAnchorRefs,
  landingRetainRef,
  retiredSnapshotRef,
  workspaceAnchorRefs,
} from "../../core/workspace/refs.js";
import { daemonFetch } from "./_shared.js";
import { toRow, type SessionSummary } from "../session-row.js";

interface Binding {
  sessionId: string;
  /**
   * Last activity from the session record. The daemon keeps this current
   * for live sessions too, so the LAST column works with the daemon down —
   * which is the state this whole file is written for.
   */
  updatedAt?: string;
  workspace: {
    path: string;
    sourceCwd: string;
    label: string;
    provider: string;
    snapshot?: string;
    line?: string;
    vcs?: Record<string, string>;
  };
}

// One axis: the directory's relationship to the sessions that use it.
// Deliberately not the session vocabulary (BUSY/WARM/COLD) — that is a
// fact about the daemon holding a session in memory, and the same
// session can be cold with an `active` workspace or live with an
// `inactive` one, so sharing words would put two tables in visible
// disagreement about it.
export type WorkspaceState =
  /** Directory exists and a session record points at it. */
  | "active"
  /** Directory exists, no session owns it. Reclaimable. */
  | "unowned"
  /** A session owns it but the directory is gone. Rebuildable. */
  | "inactive";

export interface SessionClaim {
  sessionId: string;
  updatedAt?: string;
}

export interface WorkspaceRow {
  path: string;
  sourceCwd: string;
  label: string;
  provider: string;
  state: WorkspaceState;
  /** First claimant, kept for the single-session callers that resolve a target. */
  sessionId?: string;
  /**
   * Every session claiming this path. More than one once workspaces can
   * be joined; the row is per WORKSPACE, so collapsing co-tenants to the
   * first would hide the fact that a directory is shared at all.
   *
   * Carries `updatedAt` because the table renders one line per claimant
   * and needs a per-session recency, but deliberately not liveness: that
   * is the one fact here the daemon owns, and `collectWorkspaces` stays
   * daemon-free so diagnosis works when the daemon is the suspect.
   */
  sessions?: SessionClaim[];
  branch?: string;
  /** undefined when it could not be determined (missing dir, no provider). */
  clean?: boolean;
  changedCount?: number;
}

function workspacesRoot(): string {
  return path.join(paths.home(), "workspaces");
}

async function lastActivity(
  sessionId: string,
  recorded: string | undefined,
): Promise<string | undefined> {
  const st = await fs.stat(paths.historyFile(sessionId)).catch(() => undefined);
  if (st !== undefined) {
    return new Date(st.mtimeMs).toISOString();
  }
  return recorded;
}

/** Every workspace binding recorded across all session meta.json files. */
async function readBindings(): Promise<Binding[]> {
  const dir = path.join(paths.home(), "sessions");
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const out: Binding[] = [];
  for (const name of names) {
    const rec = await readJsonSafe<{
      sessionId?: string;
      updatedAt?: string;
      workspace?: Binding["workspace"];
    }>(path.join(dir, name, "meta.json"));
    if (rec?.workspace?.path !== undefined && typeof rec.sessionId === "string") {
      // history.jsonl's mtime first, record `updatedAt` second — the same
      // order the daemon uses to build the AGE cell in `session list`
      // (`hist.mtime ?? r.updatedAt`). Reproducing it here rather than
      // reading the daemon's answer is what keeps the two tables agreeing
      // about a session's recency whether the daemon is up or not.
      const activity = await lastActivity(rec.sessionId, rec.updatedAt);
      out.push({
        sessionId: rec.sessionId,
        ...(activity !== undefined ? { updatedAt: activity } : {}),
        workspace: rec.workspace,
      });
    }
  }
  return out;
}

/** Directories physically present under the workspaces root. */
async function readDirs(): Promise<string[]> {
  const root = workspacesRoot();
  const hashes = await fs.readdir(root).catch(() => [] as string[]);
  const out: string[] = [];
  for (const hash of hashes) {
    const inner = await fs.readdir(path.join(root, hash)).catch(() => [] as string[]);
    for (const label of inner) {
      // Sidecars (the copy provider's manifest) are not workspaces.
      if (label.endsWith(".manifest.json")) {
        continue;
      }
      const p = path.join(root, hash, label);
      const st = await fs.stat(p).catch(() => undefined);
      if (st?.isDirectory()) {
        out.push(p);
      }
    }
  }
  return out;
}

function toProviderWorkspace(b: Binding["workspace"]): Workspace {
  return {
    path: b.path,
    sourceCwd: b.sourceCwd,
    label: b.label,
    provider: b.provider,
    ...(b.snapshot !== undefined ? { snapshot: asSnapshotId(b.snapshot) } : {}),
    ...(b.line !== undefined ? { line: b.line } : {}),
    ...(b.vcs !== undefined ? { vcs: b.vcs } : {}),
  };
}

/**
 * A row is per WORKSPACE and may have no binding behind it at all (an
 * unowned directory), so it carries less than a record does. That is enough
 * for the provider: it needs somewhere to put refs and something to
 * integrate from, and both are on the row.
 */
function rowWorkspace(row: WorkspaceRow): Workspace {
  return {
    path: row.path,
    sourceCwd: row.sourceCwd,
    label: row.label,
    provider: row.provider,
    ...(row.branch !== undefined ? { line: row.branch, vcs: { branch: row.branch } } : {}),
  };
}

function toClaim(b: Binding): SessionClaim {
  return {
    sessionId: b.sessionId,
    ...(b.updatedAt !== undefined ? { updatedAt: b.updatedAt } : {}),
  };
}

export async function collectWorkspaces(): Promise<WorkspaceRow[]> {
  const bindings = await readBindings();
  const byPath = new Map<string, Binding[]>();
  for (const b of bindings) {
    const at = byPath.get(b.workspace.path);
    if (at === undefined) {
      byPath.set(b.workspace.path, [b]);
    } else {
      at.push(b);
    }
  }
  const dirs = new Set(await readDirs());
  const rows: WorkspaceRow[] = [];

  for (const dir of dirs) {
    const claims = byPath.get(dir);
    const bound = claims?.[0];
    if (claims !== undefined && bound !== undefined) {
      rows.push({
        path: dir,
        sourceCwd: bound.workspace.sourceCwd,
        label: bound.workspace.label,
        provider: bound.workspace.provider,
        state: "active",
        sessionId: bound.sessionId,
        sessions: claims.map(toClaim),
        ...(bound.workspace.line !== undefined ? { branch: bound.workspace.line } : {}),
      });
      continue;
    }
    // No record points here, but the directory can usually still say
    // where it came from. Report that rather than "(unknown)": an
    // unowned workspace you can attribute is one you can decide about.
    const attributed = await attributeUnowned(dir);
    rows.push({
      path: dir,
      sourceCwd: attributed?.sourceCwd ?? "(unknown)",
      label: attributed?.label ?? path.basename(dir),
      provider: attributed?.provider ?? "(unknown)",
      state: "unowned",
      ...(attributed?.line !== undefined ? { branch: attributed.line } : {}),
    });
  }

  for (const [dir, claims] of byPath) {
    if (dirs.has(dir)) {
      continue;
    }
    const b = claims[0]!;
    rows.push({
      path: dir,
      sourceCwd: b.workspace.sourceCwd,
      label: b.workspace.label,
      provider: b.workspace.provider,
      state: "inactive",
      sessionId: b.sessionId,
      sessions: claims.map(toClaim),
      ...(b.workspace.line !== undefined ? { branch: b.workspace.line } : {}),
    });
  }

  // Cleanliness decides what prune may touch, so it is worth the stat
  // cost. Only meaningful for a directory that exists and whose provider
  // we know.
  for (const row of rows) {
    if (row.state === "inactive" || row.provider === "(unknown)") {
      continue;
    }
    const provider = getProvider(row.provider);
    if (provider === undefined) {
      continue;
    }
    // Active rows use the recorded binding; unowned ones fall back to what the
    // directory itself reported, so they get a real DIRTY answer too.
    const binding = byPath.get(row.path)?.[0];
    const ws =
      binding !== undefined ? toProviderWorkspace(binding.workspace) : await attributeUnowned(row.path);
    if (ws === undefined) {
      continue;
    }
    const status = await provider.status(ws).catch(() => undefined);
    if (status !== undefined) {
      row.clean = status.clean;
      row.changedCount = status.changedPaths.length;
    }
  }

  rows.sort((a, b) => a.path.localeCompare(b.path));
  return rows;
}

/**
 * Recover a workspace's identity from the directory itself, for use when
 * no session record points at it.
 *
 * The path is a dead end (a hash and a label), but the directory is not,
 * because each provider leaves its own breadcrumb in one. Asking every
 * registered provider in turn is what keeps the formats of those
 * breadcrumbs out of this file: it used to know that a git worktree names
 * its repository in `.git` and that a copy workspace records its source in a
 * manifest sidecar, which is knowledge that belongs to whichever provider
 * writes it.
 *
 * Order is registration order and does not matter: a directory recognized
 * by two providers would be a bug in one of them, not an ambiguity here.
 */
async function attributeUnowned(dir: string): Promise<Workspace | undefined> {
  for (const kind of providerKinds()) {
    const attributed = await getProvider(kind)
      ?.attributeOrphan(dir)
      .catch(() => undefined);
    if (attributed !== undefined) {
      return attributed;
    }
  }
  return undefined;
}

/**
 * Pick the workspace a command should act on.
 *
 * An explicit id always wins. Without one, fall back to "the workspace
 * derived from the tree I am standing in", but only when that is
 * unambiguous — guessing between two candidates is how the wrong change
 * gets landed. Note cwd only ever selects WHICH workspace; it never
 * decides where the work goes. That destination is the recorded
 * sourceCwd, because a workspace shares no path prefix with its source
 * and so the target cannot be inferred from the filesystem at all.
 */
async function resolveTarget(idOrLabel: string | undefined): Promise<WorkspaceRow> {
  const rows = (await collectWorkspaces()).filter((r) => r.state === "active");
  if (idOrLabel !== undefined) {
    const want = idOrLabel.replace(/^hydra_session_/, "");
    const hit = rows.filter(
      (r) => r.sessionId?.replace(/^hydra_session_/, "") === want || r.label === want,
    );
    if (hit.length === 0) {
      throw new Error(`no bound workspace matches "${idOrLabel}"`);
    }
    return hit[0]!;
  }
  const here = path.resolve(process.cwd());
  const local = rows.filter((r) => r.sourceCwd === here);
  if (local.length === 1) {
    return local[0]!;
  }
  if (local.length === 0) {
    throw new Error(
      `no workspace is derived from ${shortenHomePath(here)}; name a session id explicitly`,
    );
  }
  throw new Error(
    `${local.length} workspaces are derived from ${shortenHomePath(here)}; name one explicitly:\n` +
      local.map((r) => `  ${r.sessionId?.replace(/^hydra_session_/, "")}  ${r.label}`).join("\n"),
  );
}

interface TargetChecks {
  source: string;
  branch: string;
  base: string;
  /** The source's pre-landing state, held so the reset cannot lose it. */
  capture?: SourceCapture;
}

/**
 * Refuse rather than resolve cleverly.
 *
 * Each of these is a case where continuing would produce a result the
 * user did not ask for: a merge into a branch they moved off, a patch
 * layered onto unrelated uncommitted edits, or a write into a tree that
 * is no longer there.
 */
async function preflight(row: WorkspaceRow, into: string | undefined): Promise<TargetChecks> {
  const source = into !== undefined ? path.resolve(into) : row.sourceCwd;
  const exists = await fs
    .stat(source)
    .then((s) => s.isDirectory())
    .catch(() => false);
  if (!exists) {
    throw new Error(`source tree ${shortenHomePath(source)} no longer exists`);
  }
  const provider = getProvider(row.provider);
  // A dirty source is the NORMAL case: `start` copies the user's work
  // in rather than taking it, so the same edits are still sitting here.
  // Capture it instead of refusing, so the reset this enables cannot
  // lose anything and post-start edits get replayed rather than
  // rejected. Same reconciliation the daemon's `stop` performs.
  const capture =
    row.sessionId === undefined
      ? undefined
      : await captureSourceForLanding({
          source,
          ws: rowWorkspace(row),
          startSnapshotRef: workspaceAnchorRefs(row.label).start,
          // Written by an in-session landing, and it has to win here for
          // the same reason it does there: work a previous landing put
          // into the source is not the user's divergence, and measuring
          // from `start` reports it as an overlap on every landing after
          // the first.
          baselineRef: workspaceAnchorRefs(row.label).baseline,
          retainRef: landingRetainRef(row.sessionId),
          provider: getProvider(row.provider),
        });
  if (capture === undefined) {
    // No session owns this workspace, so there is no start snapshot to
    // measure against and no way to tell the copy from the user's own
    // work. Refusing is the only safe answer left.
    const dirty = await provider
      ?.status({ ...rowWorkspace(row), path: source })
      .catch(() => undefined);
    if (dirty !== undefined && dirty.changedPaths.length > 0) {
      throw new Error(
        `${shortenHomePath(source)} has uncommitted changes; commit or stash them first so a ` +
          `partially-applied result cannot be confused with your own work`,
      );
    }
  }
  const branch = rowWorkspace(row).line ?? "";
  if (branch.length === 0) {
    throw new Error(`workspace ${row.label} has no line of work to land from`);
  }
  return { source, branch, base: "", capture };
}

/**
 * Clear the source so a fast-forward can run.
 *
 * Safe only because `captureSourceForLanding` already retained what is
 * being cleared; the caller replays it afterwards. Called at the last
 * possible moment, after every check that could still refuse, so a
 * command that fails has not touched the tree.
 */
async function clearForLanding(
  source: string,
  row: WorkspaceRow,
  capture: SourceCapture | undefined,
): Promise<void> {
  if (capture === undefined || capture.clean) {
    return;
  }
  const provider = getProvider(row.provider);
  const at = await provider?.currentState(source);
  const cleared =
    provider === undefined || at === undefined
      ? { ok: false, reason: "no provider available to clear the source tree" }
      : await provider.resetTo(source, at);
  if (!cleared.ok) {
    throw new Error(
      `could not clear ${shortenHomePath(source)} for the merge; your work is preserved at ` +
        `${capture.retainedRef}. Nothing was landed.`,
    );
  }
}

/** Put the source's own post-start edits back, and report if they clash. */
async function replayAfterLanding(
  source: string,
  row: WorkspaceRow,
  capture: SourceCapture | undefined,
): Promise<void> {
  if (capture === undefined) {
    return;
  }
  const provider = getProvider(row.provider);
  if (await replaySourceDivergence({ source, capture, provider })) {
    await releaseSourceCapture({ source, ws: rowWorkspace(row), capture, provider });
    return;
  }
  process.stdout.write(
    `WARNING: your own edits to ${shortenHomePath(source)} overlap the workspace's changes ` +
      `and could not be replayed. They are preserved at ${capture.retainedRef}\n`,
  );
}

export async function runWorkspaceMerge(opts: {
  target?: string;
  message?: string;
  into?: string;
  remove?: boolean;
}): Promise<void> {
  const row = await resolveTarget(opts.target);
  const { source, branch, capture } = await preflight(row, opts.into);

  // Establish that the merge CAN fast-forward before mutating anything.
  //
  // Without this the doomed case still commits in the workspace on its
  // way to failing, so a refused merge would leave the workspace in a
  // different state than it started. Committing is not destructive, but
  // a command that fails should be a no-op, or you cannot retry it and
  // reason about what happened.
  //
  // The test is whether the source's current tip is an ancestor of the
  // branch: if the source moved on, it is not, and no amount of
  // committing here will make the fast-forward legal.
  const provider = getProvider(row.provider);
  if (provider === undefined) {
    throw new Error(`no provider "${row.provider}" available to land this workspace`);
  }
  const sourceHead = await provider.currentState(source);
  if (sourceHead === undefined) {
    throw new Error(`could not read the state of ${shortenHomePath(source)}`);
  }
  if (!(await provider.contains(source, { state: sourceHead, within: branch }))) {
    const current = (await provider.currentLineName(source)) ?? "the source";
    throw new Error(
      `cannot fast-forward ${current} in ${shortenHomePath(source)} to ${branch}.\n` +
        `The source has moved since this workspace was created, or is on a different branch.\n` +
        `Nothing was changed. Merge it yourself with:  git -C ${source} merge ${branch}`,
    );
  }

  // Record anything outstanding in the workspace: landing brings recorded
  // states across, and the agent's work is usually sitting loose.
  const wsDirty = await provider.status(rowWorkspace(row)).catch(() => undefined);
  if (wsDirty !== undefined && wsDirty.changedPaths.length > 0) {
    const msg = opts.message ?? `hydra: work from ${row.label}`;
    try {
      await provider.record(rowWorkspace(row), msg);
    } catch (err) {
      throw new Error(
        `could not record workspace changes: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    process.stdout.write(`recorded workspace changes on ${branch}\n`);
  }

  await clearForLanding(source, row, capture);

  const currentBranch = (await provider.currentLineName(source)) ?? "the source";
  const merged = await provider.integrate({ into: source, from: branch, fastForwardOnly: true });
  if (!merged.ok) {
    // Name both lines. The usual cause is that the source moved on since
    // the workspace was created, and the useful thing to say is which two
    // things failed to line up.
    throw new Error(
      `cannot fast-forward ${currentBranch} in ${shortenHomePath(source)} to ${branch}.\n` +
        `The source has moved since this workspace was created, or is on a different branch.\n` +
        `Merge it yourself with:  git -C ${source} merge ${branch}\n` +
        (merged.reason !== undefined ? `the provider said: ${merged.reason}\n` : ""),
    );
  }
  await replayAfterLanding(source, row, capture);
  process.stdout.write(
    `merged ${branch} into ${currentBranch} at ${shortenHomePath(source)}\n`,
  );
  await afterLand(row, source, opts.remove === true);
}

export async function runWorkspaceApply(opts: {
  target?: string;
  into?: string;
}): Promise<void> {
  const row = await resolveTarget(opts.target);

  const provider = getProvider(row.provider);
  if (provider === undefined || !provider.capabilities().supports.captureWorkingState) {
    throw new Error(`provider "${row.provider}" cannot snapshot a working tree to apply from`);
  }
  const bindings = await readBindings();
  const binding = bindings.find((b) => b.workspace.path === row.path);
  if (binding === undefined) {
    throw new Error(`workspace ${row.label} is no longer bound to a session`);
  }
  const source = opts.into !== undefined ? path.resolve(opts.into) : row.sourceCwd;

  // Before the capture, because it is a refusal and refusals come first.
  // The index is what `apply` delivers, so it cannot also hold the user's
  // own staging: the two sets would be indistinguishable afterwards, and
  // the reset below does not preserve the marking anyway. `merge` has no
  // such constraint: it delivers commits.
  const staged = await provider.status({ ...rowWorkspace(row), path: source }).catch(() => undefined);
  if (staged?.hasStagedWork === true) {
    throw new Error(
      `${shortenHomePath(source)} already has changes staged for its next commit, and apply ` +
        `delivers into that same index; unstaging one set would unstage both. Commit or ` +
        `unstage them first, or use \`${invokedBinName()} workspace merge\` instead`,
    );
  }

  const { capture } = await preflight(row, opts.into);
  const sourceHead = await provider.currentState(source);
  if (sourceHead === undefined) {
    throw new Error(`could not read the state of ${shortenHomePath(source)}`);
  }
  // The source's own tip when the workspace already contains it, so the
  // change set is exactly what the workspace added and is a patch against
  // the tree the clear below leaves behind. Its creation state otherwise,
  // which is the drift case: the two trees last agreed there, and the
  // patch has to be reconciled onto what the source has become.
  //
  // Measuring from the creation state unconditionally broke every synced
  // workspace: a sync brings the source's commits INTO the workspace, so
  // the change set carried content the source already had, and one
  // already-present hunk takes the whole (atomic) apply down.
  const branch = rowWorkspace(row).line;
  const contained =
    branch !== undefined &&
    (await provider.contains(source, { state: sourceHead, within: branch }).catch(() => false));
  const base = contained ? sourceHead : binding.workspace.snapshot;
  if (base === undefined) {
    throw new Error(`workspace ${row.label} has no recorded base to diff against`);
  }

  // Snapshot through the provider rather than staging in place: it uses
  // a temporary index, so the workspace's own index is left alone and
  // untracked files are still included. Both trees share the object
  // store, so the resulting commit is readable from the source repo.
  const snapshot = await provider.captureWorkingState(row.path, `hydra: apply from ${row.label}`);
  const delta = await provider.captureDelta(source, asSnapshotId(base), snapshot);
  if (delta === undefined) {
    throw new Error("could not compute the change set");
  }
  if (delta.trim().length === 0) {
    if (capture !== undefined) {
      await releaseSourceCapture({ source, ws: rowWorkspace(row), capture, provider });
    }
    process.stdout.write("Nothing to apply: the workspace matches its base.\n");
    return;
  }
  await clearForLanding(source, row, capture);
  // Staged, unlike the other replays: `apply` exists to hand you the
  // workspace's changes to review and commit yourself, so they arrive
  // marked for the next commit rather than loose.
  const applied = await provider.applyDelta(source, delta, {
    stage: true,
    // Only with a stale base. Against an exact one the patch either
    // applies or something is genuinely wrong, and reconciling there
    // would hide it.
    tolerant: !contained,
  });
  if (!applied.ok) {
    // A refused apply has to be a no-op, and reconciliation may have
    // written conflict markers on its way to failing. Put the tree back;
    // the capture is what makes that safe.
    await provider.resetTo(source, sourceHead).catch(() => undefined);
    await replayAfterLanding(source, row, capture);
    throw new Error(
      `could not apply the change set: ${applied.reason ?? "unknown error"}` +
        (contained
          ? ""
          : `\nThe source has moved on since this workspace was created; sync it into the ` +
            `workspace first so the change set applies against those commits`),
    );
  }
  await replayAfterLanding(source, row, capture);
  // Re-baseline, as a merge does: this content is in the source now, so a
  // later landing must not count it as the user's own divergence and
  // replay it on top of the same content arriving from the branch.
  const after = await provider
    .captureWorkingState(source, `hydra: source state after applying ${row.label}`)
    .catch(() => undefined);
  if (after !== undefined) {
    await provider
      .retainSnapshot(
        { ...rowWorkspace(row), path: source },
        workspaceAnchorRefs(row.label).baseline,
        after,
      )
      .catch(() => undefined);
  }
  process.stdout.write(
    `applied ${row.label} into ${shortenHomePath(source)} as staged changes (not committed)\n`,
  );
}

/** Shared post-landing housekeeping. */
async function afterLand(row: WorkspaceRow, source: string, remove: boolean): Promise<void> {
  // The autosave ref exists to make unintegrated work recoverable. Once
  // it is integrated the ref is only pinning objects, so drop it.
  if (row.sessionId !== undefined) {
    // Every anchor, both namings. Each is a GC root, so a survivor pins
    // objects for a workspace that is done. The landing baseline goes too:
    // unlike an in-session landing, this one commits the workspace's work,
    // so HEAD now describes where the source was left and is the honest
    // base for anything that follows.
    const provider = getProvider(row.provider);
    for (const ref of allAnchorRefs(row.label)) {
      await provider
        ?.dropSnapshotRef({ ...rowWorkspace(row), path: source }, ref)
        .catch(() => undefined);
    }
  }
  if (!remove) {
    process.stdout.write(
      `Workspace kept at ${shortenHomePath(row.path)}. Remove it with --remove once you are done.\n`,
    );
    return;
  }
  const provider = getProvider(row.provider);
  const bindings = await readBindings();
  const binding = bindings.find((b) => b.workspace.path === row.path);
  if (provider !== undefined && binding !== undefined) {
    await provider
      .removeWorkspace(toProviderWorkspace(binding.workspace), { force: true })
      .catch((e: unknown) => process.stdout.write(`could not remove workspace: ${String(e)}\n`));
    process.stdout.write(`removed workspace ${shortenHomePath(row.path)}\n`);
  }
}

/**
 * Finish removing a workspace whose directory is already gone.
 *
 * "Inactive" rows are built FROM the session binding, not from the
 * filesystem, so reporting "already gone, clearing nothing" and
 * returning left `remove` unable to clear the one row a user is most
 * likely to aim it at. Three things outlive the directory: the binding
 * (which is what lists the row, and what makes resurrect rebuild the
 * workspace), the branch, and the snapshot refs. The refs are GC roots,
 * so leaving them pins objects for a checkout that no longer exists.
 *
 * Destroys nothing, which is what makes it need no guard. The two
 * things that outlive the directory can each hold the last copy of
 * work: the branch holds what was committed, and the autosave ref holds
 * what was not, as of the last turn before the directory went away.
 * Neither is this command's to discard — the same call on a `bound` row
 * keeps the branch too, and treating it as deletable here inverted that
 * on the one state where the DIRTY column reads `?` and you cannot see
 * what you are agreeing to. So the branch is deleted only when it holds
 * nothing (prune's rule, via the same function), the autosave is kept,
 * and whatever survives is named on the way out.
 */
async function removeInactive(row: WorkspaceRow): Promise<void> {
  const bindings = await readBindings();
  const bound = bindings.find((b) => b.workspace.path === row.path);
  if (bound === undefined) {
    // Only reachable if a record changed under us between collect and
    // now: with no binding there is no row, and nothing left to clear.
    process.stdout.write(`${shortenHomePath(row.path)} is already gone.\n`);
    return;
  }

  // First, because it is the only step that can be refused: the daemon
  // turns down a live session, and a refused command should not have
  // already pruned git state on its way to failing. Everything after
  // this reports failures as notes rather than throwing, so the command
  // either changes nothing or runs to the end.
  await clearBinding(bound);

  const ws = toProviderWorkspace(bound.workspace);
  const provider = getProvider(ws.provider);
  const line = ws.line;
  const notes: string[] = [];

  // Before the line: a provider refuses to discard one it still believes
  // is materialized somewhere, and its bookkeeping still points here.
  await provider?.pruneStale(ws).catch(() => undefined);
  if (line !== undefined && provider !== undefined && !provider.ownsLine(line)) {
    notes.push(`kept ${line} (not hydra's to delete)`);
  } else {
    const held = await reclaimBranch(ws);
    if (held !== undefined) {
      notes.push(held);
    }
  }

  // The start ref measured the source at isolation time, for landing.
  // Nothing can be landed from a checkout that is gone, so it is pure
  // GC root now. The autosave is the opposite: with the directory gone
  // it is the only copy of whatever was uncommitted, so it stays.
  if (provider !== undefined && row.sessionId !== undefined) {
    await provider
      .dropSnapshotRef(ws, workspaceAnchorRefs(row.label).start)
      .catch(() => undefined);
    const autosave = await firstExistingRef(ws, [workspaceAnchorRefs(row.label).autosave]);
    if (autosave !== undefined) {
      notes.push(`kept ${autosave} (last autosave)`);
    }
  }

  process.stdout.write(
    `cleared ${shortenHomePath(row.path)}${notes.length > 0 ? ` (${notes.join("; ")})` : ""}\n`,
  );
  process.stdout.write(
    `Its session no longer claims a workspace and will resume in ${shortenHomePath(row.sourceCwd)}.\n`,
  );
}

/**
 * Ask the daemon to drop a session's workspace binding.
 *
 * Everything else in this file reads the filesystem, deliberately. This
 * does not, and the asymmetry is the point: reading a record with the
 * daemon down is the diagnostic this file exists for, but *writing* one
 * is the daemon's alone. It holds live records in memory and rewrites
 * them, so a file edited underneath it is silently reverted; its writer
 * also serializes against every other meta write, which no outside
 * writer can join. Editing meta.json from here would have been the only
 * place in the CLI that touches a session record directly — every other
 * session mutation (delete, kill, retitle, priority) is a daemon call,
 * and this is not the one to make an exception for.
 */
async function clearBinding(bound: Binding): Promise<void> {
  const id = encodeURIComponent(bound.sessionId);
  let res;
  try {
    res = await daemonFetch(`/v1/sessions/${id}`, {
      method: "PATCH",
      body: { workspace: null },
      rethrowNetworkError: true,
    });
  } catch (err) {
    throw new Error(
      `could not reach the daemon to clear the binding, and only it may write that record: ` +
        `${(err as Error).message}`,
    );
  }
  if (res.ok) {
    return;
  }
  const detail =
    res.body !== null && typeof res.body === "object" && "error" in res.body
      ? String((res.body as { error?: unknown }).error)
      : `HTTP ${res.status}`;
  throw new Error(detail);
}

/**
 * Remove one named workspace.
 *
 * Distinct from `prune`, which sweeps unattributable unowned ones in bulk.
 * This takes a target you named, so it will happily remove a workspace
 * that is still bound to a session — that is usually the point, and it
 * is recoverable: the session's next resurrect rebuilds the checkout
 * from its branch, or falls back to a fresh workspace from the source.
 *
 * Two guards, both overridable, because the irreversible cases are
 * narrow and worth naming:
 *
 *   - Uncommitted changes. The branch preserves committed work, so
 *     removal only ever destroys what was never recorded.
 *   - A hydra lock. We lock a workspace while its session is live, so a
 *     lock means an agent may be working in this directory right now.
 *     Pulling it out from under a running process is not something to
 *     do because a path matched.
 */
export async function runWorkspaceRemove(opts: {
  target?: string;
  force?: boolean;
}): Promise<void> {
  if (opts.target === undefined) {
    throw new Error("name the workspace to remove (a session id or a label)");
  }
  const want = opts.target.replace(/^hydra_session_/, "");
  const rows = await collectWorkspaces();
  const hits = rows.filter(
    (r) =>
      r.sessionId?.replace(/^hydra_session_/, "") === want ||
      r.label === want ||
      r.path === opts.target,
  );
  if (hits.length === 0) {
    throw new Error(`no workspace matches "${opts.target}"`);
  }
  if (hits.length > 1) {
    throw new Error(
      `"${opts.target}" matches ${hits.length} workspaces; name one by path:\n` +
        hits.map((r) => `  ${r.path}`).join("\n"),
    );
  }
  const row = hits[0]!;

  if (row.state === "inactive") {
    await removeInactive(row);
    return;
  }

  if (opts.force !== true) {
    // Unknown is not clean. `collectWorkspaces` swallows a failed
    // status, an unresolvable provider and a failed attribution alike,
    // all of which land here as undefined — so reading that as "nothing
    // to lose" removes a directory whose contents nobody checked.
    // `prune` already fails closed on the same input; match it.
    if (row.changedCount === undefined) {
      throw new Error(
        `cannot tell whether ${shortenHomePath(row.path)} holds uncommitted work ` +
          `(its state could not be read). Pass --force to remove it anyway.`,
      );
    }
    if (row.changedCount > 0) {
      throw new Error(
        `${shortenHomePath(row.path)} has ${row.changedCount} uncommitted change(s). ` +
          `Land them with \`hydra workspace merge ${want}\`, or pass --force to discard them.`,
      );
    }
    // A held workspace means a session is live in it. Removing it would
    // yank the working directory out from under a running agent.
    const bindings = await readBindings();
    const bound = bindings.find((b) => b.workspace.path === row.path);
    if (bound !== undefined) {
      const provider = getProvider(bound.workspace.provider);
      const listed = await provider?.listWorkspaces(bound.workspace.sourceCwd).catch(() => []);
      const live = listed?.find((w) => w.path === row.path);
      if (live?.heldByUs === true) {
        throw new Error(
          `${shortenHomePath(row.path)} is locked, which means a session is live in it. ` +
            `Close that session first, or pass --force if you know it is gone.`,
        );
      }
    }
  }

  const bindings = await readBindings();
  const bound = bindings.find((b) => b.workspace.path === row.path);
  const provider = bound !== undefined ? getProvider(bound.workspace.provider) : undefined;

  // Whether this removal is about to destroy the only live copy of
  // something. Uncommitted work exists nowhere but the directory, so
  // discarding it is the case the autosave ref exists to cover. Unknown
  // counts as discarding: under --force we get here without having been
  // able to look.
  const discarding = row.changedCount === undefined || row.changedCount > 0;

  const notes: string[] = [];
  if (provider !== undefined && bound !== undefined) {
    // force at the provider layer: this function already made the
    // keep-or-delete decision above, and the provider's own guard is
    // stricter (it also refuses on committed-but-unintegrated work,
    // which the branch preserves anyway).
    await provider.removeWorkspace(toProviderWorkspace(bound.workspace), { force: true });
  } else {
    const held = await removeUnowned(row);
    if (held !== undefined) {
      notes.push(held);
    }
  }

  // Only now that the directory is actually gone. These refs are GC
  // roots, so a survivor pins objects for a checkout that no longer
  // exists — but dropping them first would strip the refs off a
  // workspace that is still there if the removal above threw.
  //
  // The autosave is the exception, and outranks the hygiene: when the
  // removal just discarded uncommitted work, this ref is the only
  // remaining copy of it. Deleting it here is what turns `--force` from
  // recoverable into final.
  let retained: string | undefined;
  if (provider !== undefined && bound !== undefined && row.sessionId !== undefined) {
    const ws = toProviderWorkspace(bound.workspace);
    await provider
      .dropSnapshotRef(ws, workspaceAnchorRefs(row.label).start)
      .catch(() => undefined);
    const candidates = [workspaceAnchorRefs(row.label).autosave];
    const autosave = await firstExistingRef(ws, candidates);
    if (discarding && autosave !== undefined) {
      // Retire it out of the live namespace. A label is free again the
      // moment its workspace is gone, so the next workspace of that name
      // would overwrite this ref on its first turn — leaving the recovery
      // path printed below pointing at somebody else's work.
      retained = await retireRef(ws, autosave);
    } else {
      // Nothing was lost, so the ref is only pinning objects. Reap every
      // naming rather than just the one that resolved.
      for (const ref of candidates) {
        await provider.dropSnapshotRef(ws, ref).catch(() => undefined);
      }
    }
  }

  process.stdout.write(
    `removed ${shortenHomePath(row.path)}${notes.length > 0 ? ` (${notes.join("; ")})` : ""}\n`,
  );
  if (retained !== undefined) {
    process.stdout.write(
      `Discarded uncommitted work is recoverable from the last autosave: ` +
        `git -C ${shortenHomePath(row.sourceCwd)} checkout ${retained}\n`,
    );
  }
  if (row.state === "active") {
    process.stdout.write(
      `Its session still references it; the next resurrect rebuilds it from ${row.branch ?? "its branch"} ` +
        `or starts fresh from ${shortenHomePath(row.sourceCwd)}.\n`,
    );
  }
}

/**
 * The first of these refs that actually exists, or undefined.
 *
 * Used wherever a name changed: callers offer the current name and the
 * one a workspace created before the re-key still carries, and get back
 * whichever is really there. Also the guard against advertising a
 * recovery that does not exist.
 */
async function firstExistingRef(
  ws: Workspace,
  refs: readonly string[],
): Promise<string | undefined> {
  for (const ref of refs) {
    if (await refExists(ws, ref)) {
      return ref;
    }
  }
  return undefined;
}

/**
 * Move a surviving snapshot to a name that cannot be recycled, returning
 * it. Falls back to the live name if the move fails, since one reachable
 * copy beats a tidy namespace.
 */
async function retireRef(ws: Workspace, live: string): Promise<string> {
  const provider = getProvider(ws.provider);
  if (provider === undefined) {
    return live;
  }
  const sha = await provider.resolveRetained(ws, live).catch(() => undefined);
  if (sha === undefined) {
    return live;
  }
  const retired = retiredSnapshotRef(ws.label, sha);
  const written = await provider
    .retainSnapshot(ws, retired, sha)
    .then(() => true)
    .catch(() => false);
  if (!written) {
    return live;
  }
  await provider.dropSnapshotRef(ws, live).catch(() => undefined);
  return retired;
}

/** Whether a retained handle is present, so we never advertise a recovery that isn't there. */
async function refExists(ws: Workspace, ref: string): Promise<boolean> {
  const found = await getProvider(ws.provider)
    ?.resolveRetained(ws, ref)
    .catch(() => undefined);
  return found !== undefined;
}

/**
 * Tear down a workspace no session record claims.
 *
 * `prune` already does this properly and this used to do it differently:
 * a bare `rm` of the directory, which removes the checkout but tells git
 * nothing, leaving a stale worktree registration and an abandoned branch
 * behind — the exact residue prune's docstring warns about. The
 * attribution needed to route it through the provider instead is the
 * same one `collectWorkspaces` already computed for the DIRTY column.
 *
 * Returns a note when the branch was kept, so committed work does not
 * survive silently with nothing left pointing at it.
 */
async function removeUnowned(row: WorkspaceRow): Promise<string | undefined> {
  const ws = await attributeUnowned(row.path);
  const provider = ws === undefined ? undefined : getProvider(ws.provider);
  if (ws === undefined || provider === undefined) {
    // Genuinely unattributable: the directory is all there is to remove.
    await fs.rm(row.path, { recursive: true, force: true });
    await fs.rm(`${row.path}.manifest.json`, { force: true }).catch(() => undefined);
    return undefined;
  }
  await provider.unlock(ws).catch(() => undefined);
  await provider.removeWorkspace(ws, { force: true });
  return reclaimBranch(ws);
}

/**
 * Live sessions by id, or undefined when the daemon could not be asked.
 *
 * The distinction matters and is why this returns undefined rather than an
 * empty map: with the daemon down every session really is cold, but so is
 * every session when the token is stale or the port moved, and rendering
 * COLD for all of them would state as fact something we did not check.
 *
 * `status=warm` is the whole point — it skips the cold-record walk on the
 * daemon side (see SessionManager.list), so this costs one small response
 * no matter how many hundreds of sessions exist on disk. Everything cold
 * is already on this side, from the records readBindings opened.
 */
async function readLiveSessions(): Promise<Map<string, SessionSummary> | undefined> {
  const res = await daemonFetch(
    "/v1/sessions?status=warm&includeNonInteractive=true",
    { rethrowNetworkError: true },
  ).catch(() => undefined);
  if (res === undefined || !res.ok) {
    return undefined;
  }
  const body = res.body as { sessions?: SessionSummary[] } | null;
  if (body === null || !Array.isArray(body.sessions)) {
    return undefined;
  }
  return new Map(body.sessions.map((s) => [s.sessionId, s]));
}

/**
 * One claimant's cells. Live sessions render from the daemon's summary,
 * cold ones from a synthesized summary, and both go through the session
 * table's own `toRow` so STATE and AGE cannot drift from `session list`.
 */
function claimCells(
  claim: SessionClaim,
  live: Map<string, SessionSummary> | undefined,
  now: number,
): { session: string; state: string; seen: string } {
  // A live session renders from the daemon's own summary, so its SEEN is
  // the daemon's timestamp — the same history-mtime-first answer
  // lastActivity computes, just fresher mid-turn.
  const summary = live?.get(claim.sessionId);
  const row = toRow(
    summary ?? {
      sessionId: claim.sessionId,
      // Unread for the three cells taken from this row, but required by
      // the shape; the workspace table has its own SOURCE/WORKSPACE cells.
      cwd: "",
      attachedClients: 0,
      updatedAt: claim.updatedAt ?? "",
      status: "cold",
    },
    now,
  );
  return {
    session: row.session,
    // `?`, not COLD: see readLiveSessions.
    state: live === undefined ? "?" : row.state,
    seen: row.age,
  };
}

/** Every session claiming a row; empty for an unowned one. */
function claimsOf(row: WorkspaceRow): SessionClaim[] {
  return row.sessions ?? (row.sessionId === undefined ? [] : [{ sessionId: row.sessionId }]);
}

/** Claimants newest first, so a shared workspace leads with the one in use. */
function orderedClaims(row: WorkspaceRow): SessionClaim[] {
  return [...claimsOf(row)].sort((a, b) =>
    (a.updatedAt ?? "") < (b.updatedAt ?? "") ? 1 : -1,
  );
}

/**
 * Freshest claimant's activity, for ordering workspaces by how recently
 * they were worked in. "" for an unowned row, which sorts it to the bottom.
 */
function rowActivity(row: WorkspaceRow): string {
  let latest = "";
  for (const claim of claimsOf(row)) {
    const at = claim.updatedAt ?? "";
    if (at > latest) {
      latest = at;
    }
  }
  return latest;
}

export async function runWorkspaceList(
  opts: { json?: boolean; inactive?: boolean } = {},
): Promise<void> {
  const all = await collectWorkspaces();
  const live = await readLiveSessions();
  // JSON is a dump for tooling and every row carries `state`, so it
  // stays complete: a flag that silently shrinks machine-readable output
  // is worse than the noise it saves.
  //
  // Per-claimant liveness rides as the raw wire fields rather than the
  // rendered cell, and is omitted entirely when the daemon could not be
  // asked — a script reading `busy: false` off an unreachable daemon
  // would be reading an assumption.
  if (opts.json === true) {
    const enriched = all.map((r) => ({
      ...r,
      ...(r.sessions === undefined
        ? {}
        : {
            sessions: r.sessions.map((c) => {
              const s = live?.get(c.sessionId);
              return {
                ...c,
                ...(live === undefined
                  ? {}
                  : {
                      status: s === undefined ? "cold" : "warm",
                      busy: s?.busy === true,
                      awaitingInput: s?.awaitingInput === true,
                      armedTasks: s?.armedTasks ?? 0,
                    }),
                ...(s?.updatedAt !== undefined ? { updatedAt: s.updatedAt } : {}),
              };
            }),
          }),
    }));
    process.stdout.write(JSON.stringify({ workspaces: enriched }, null, 2) + "\n");
    return;
  }
  // An inactive row is a property of a SESSION (it points at a directory
  // that is gone), not a workspace that exists, and sessions sit for
  // weeks. Keep it out of the table by default but never out of the
  // footer: hidden-and-counted is tidying, hidden-without-trace is how
  // you stop finding out that two sessions are stale.
  const rows = opts.inactive === true ? all : all.filter((r) => r.state !== "inactive");
  if (all.length === 0) {
    process.stdout.write("No workspaces.\n");
    return;
  }

  if (rows.length === 0) {
    process.stdout.write("No workspaces on disk.\n");
  } else {
    // One line per (workspace, claimant). The workspace cells repeat down
    // a shared directory's lines, which is the point: a co-tenant that
    // only showed up inside a comma-joined SESSION cell could not carry
    // its own liveness, and liveness is what says whether a workspace is
    // being worked in or merely exists.
    //
    // No STATE column: `-` in SESSION is "no session owns this" (unowned)
    // and `-` in WORKSPACE is "the directory is not there" (inactive), so
    // the word would only restate a cell already on the line — and on a
    // default listing, where inactive rows are filtered out, it would
    // restate it as the constant `active`. Both cells use the same `-` the
    // rest of the table already uses for "nothing here", and between them
    // they disambiguate DIRTY's `?`: with WORKSPACE `-` it means "no
    // directory to read", and on any other row it means "reading it
    // failed". The two words survive in the footers, where they are
    // explained and paired with the command that acts on them.
    //
    // Ordered by the freshest claimant, newest first, like `session list`.
    // Unowned rows have no claimant and sort to the bottom for free.
    //
    // WORKSPACE goes last because it is the only variable-width column;
    // the short ones stay aligned to the left where they can be scanned.
    const now = Date.now();
    const ordered = [...rows].sort((a, b) => (rowActivity(a) < rowActivity(b) ? 1 : -1));
    const cols = [["SESSION", "LIVE", "SEEN", "N", "SOURCE", "LABEL", "DIRTY", "WORKSPACE"]];
    for (const r of ordered) {
      const claims = orderedClaims(r);
      // N is blank unless the directory is shared, and then it appears on
      // every one of its lines — you should be able to tell from whichever
      // line you happened to land on.
      const shared = claims.length > 1 ? String(claims.length) : "-";
      const tail = [
        shortenHomePath(r.sourceCwd),
        r.label,
        r.changedCount === undefined ? "?" : r.changedCount > 0 ? String(r.changedCount) : "-",
        // The path is recorded, not observed, so an inactive row could
        // print it — but it names a directory that is not there, and the
        // reader has no way to tell that from a path they could cd into.
        // SOURCE and LABEL still say which workspace the row is about, and
        // --json keeps the path for anything that needs it.
        r.state === "inactive" ? "-" : shortenHomePath(r.path),
      ];
      if (claims.length === 0) {
        cols.push(["-", "-", "-", "-", ...tail]);
        continue;
      }
      for (const claim of claims) {
        const cells = claimCells(claim, live, now);
        cols.push([cells.session, cells.state, cells.seen, shared, ...tail]);
      }
    }
    const widths = cols[0]!.map((_, i) => Math.max(...cols.map((row) => (row[i] ?? "").length)));
    for (const row of cols) {
      process.stdout.write(
        row.map((c, i) => (c ?? "").padEnd(widths[i] ?? 0)).join("  ").trimEnd() + "\n",
      );
    }
    if (live === undefined) {
      process.stdout.write(
        `\nLIVE is \`?\` for every session: the daemon could not be reached, so ` +
          `warm/busy state is unknown. SEEN is read from disk and is current.\n`,
      );
    }
  }

  const unowned = rows.filter((r) => r.state === "unowned").length;
  if (unowned > 0) {
    process.stdout.write(
      `\n${unowned} unowned (no session references ${unowned === 1 ? "it" : "them"}). ` +
        `\`${invokedBinName()} workspace prune\` removes the ones holding no uncommitted work.\n`,
    );
  }
  // Counted from `all`, never from the filtered rows: the footer is the
  // only trace a hidden row leaves.
  const inactive = all.filter((r) => r.state === "inactive").length;
  if (inactive > 0) {
    const bin = invokedBinName();
    process.stdout.write(
      `${unowned > 0 ? "" : "\n"}${inactive} inactive (a session points at a directory that is ` +
        `gone). Committed work is rebuilt from its branch on next resurrect; ` +
        `\`${bin} workspace remove\` clears the binding instead.\n` +
        (opts.inactive === true ? "" : `List them with \`${bin} workspace --inactive\`.\n`),
    );
  }
}

/**
 * Put a workspace back to the state it was created in.
 *
 * Dispatched to the daemon rather than performed here, which is the
 * opposite of how `merge` and `remove` in this file work, and deliberately
 * so. Those operate on workspaces whose session is gone, where reading
 * records off disk is the point. Cleaning rewrites a tree an agent is
 * living in, so all three of its guards (agent quiesced, no co-tenant, the
 * per-workspace slot) are properties of the live session, and the reply is
 * how the agent learns its files no longer exist. Reimplementing that out
 * here would produce something that looks like the verb and is not.
 */
export async function runWorkspaceClean(opts: {
  target?: string;
  deep?: boolean;
}): Promise<void> {
  const row = await resolveTarget(opts.target);
  if (row.sessionId === undefined) {
    throw new Error(
      `${shortenHomePath(row.path)} has no session bound to it, so there is no agent to clean ` +
        `around. Use \`${invokedBinName()} workspace remove\` to take it away instead.`,
    );
  }
  const id = encodeURIComponent(row.sessionId);
  let res;
  try {
    res = await daemonFetch(`/v1/sessions/${id}/workspace/clean`, {
      method: "POST",
      body: { deep: opts.deep === true },
      rethrowNetworkError: true,
    });
  } catch (err) {
    throw new Error(
      `could not reach the daemon, and only it may clean a workspace a live session is in: ` +
        `${(err as Error).message}`,
    );
  }
  if (!res.ok) {
    const detail =
      res.body !== null && typeof res.body === "object" && "error" in res.body
        ? String((res.body as { error?: unknown }).error)
        : `HTTP ${res.status}`;
    throw new Error(detail);
  }
  const report =
    res.body !== null && typeof res.body === "object" && "report" in res.body
      ? String((res.body as { report?: unknown }).report)
      : "Cleaned.";
  process.stdout.write(`${report}\n`);
}

export async function runWorkspacePrune(opts: { force?: boolean } = {}): Promise<void> {
  const rows = await collectWorkspaces();
  const unowned = rows.filter((r) => r.state === "unowned");
  if (unowned.length === 0) {
    process.stdout.write("Nothing to prune.\n");
    return;
  }

  let removed = 0;
  let kept = 0;
  for (const row of unowned) {
    // An unowned workspace has no record, but it is not therefore
    // anonymous: the
    // directory still knows its own provider and source. Recovering that
    // is what lets the removal go through provider.removeWorkspace,
    // which is the only thing that tears down a workspace *completely* —
    // a bare rm of the directory leaves git's worktree registry (and the
    // branch) pointing at a path that no longer exists.
    const ws = await attributeUnowned(row.path);
    const provider = ws === undefined ? undefined : getProvider(ws.provider);
    if (ws === undefined || provider === undefined) {
      // Genuinely unattributable. The old behaviour is right here: only
      // --force may delete work nobody can account for.
      if (opts.force !== true) {
        kept += 1;
        process.stdout.write(
          `keep   ${shortenHomePath(row.path)} (unrecognized workspace; use --force)\n`,
        );
        continue;
      }
      await fs.rm(row.path, { recursive: true, force: true }).catch(() => undefined);
      await fs.rm(`${row.path}.manifest.json`, { force: true }).catch(() => undefined);
      removed += 1;
      process.stdout.write(`remove ${shortenHomePath(row.path)} (unrecognized)\n`);
      continue;
    }
    // Now that the provider is known, cleanliness is a real question
    // with a real answer, so --force stops being the only option.
    const status = await provider.status(ws).catch(() => undefined);
    const dirty = status === undefined || status.changedPaths.length > 0;
    if (dirty && opts.force !== true) {
      kept += 1;
      const why =
        status === undefined
          ? "state unknown"
          : `${status.changedPaths.length} uncommitted change(s)`;
      process.stdout.write(`keep   ${shortenHomePath(row.path)} (${why}; use --force)\n`);
      continue;
    }
    await provider.unlock(ws).catch(() => undefined);
    await provider.removeWorkspace(ws, { force: opts.force === true }).catch(() => undefined);
    removed += 1;
    const held = await reclaimBranch(ws);
    process.stdout.write(
      `remove ${shortenHomePath(row.path)}${held === undefined ? "" : ` (${held})`}\n`,
    );
  }
  process.stdout.write(`\n${removed} removed, ${kept} kept.\n`);
}

/**
 * Delete the workspace's branch once the workspace itself is gone, but
 * only when the branch is empty of work.
 *
 * Removing a worktree never removes its branch, so pruning without this
 * leaves a `hydra/…` ref per workspace forever. Deleting unconditionally
 * is not the fix: a branch with commits on it is the durable artifact
 * that `inactive` workspaces are rebuilt from, and for an unowned one it is
 * the last copy. So the empty ones go and the rest are reported.
 *
 * Returns a note when the branch was kept, undefined when there was
 * nothing to keep or nothing to do.
 */
async function reclaimBranch(ws: Workspace): Promise<string | undefined> {
  const line = ws.line;
  const provider = getProvider(ws.provider);
  // Only ever a line this provider created: a workspace sitting on the
  // user's own line must not have it deleted out from under them. Asked of
  // the provider rather than pattern-matched, since the namespace is its
  // invention.
  if (line === undefined || provider === undefined || !provider.ownsLine(line)) {
    return undefined;
  }
  // Asked BEFORE discarding, because afterwards the count is unobtainable
  // and it is the whole measure of what would have been lost.
  const spread = await provider.divergence(ws.sourceCwd, "HEAD", line).catch(() => undefined);
  if (spread === undefined) {
    return `branch ${line} kept (could not compare it to the source)`;
  }
  if (spread.behind > 0) {
    return `branch ${line} kept: it has ${spread.behind} commit(s) not in the source`;
  }
  const discarded = await provider.discardLine(ws, line).catch(() => ({
    ok: false as const,
    dropped: 0,
  }));
  return discarded.ok ? undefined : `branch ${line} kept (delete failed)`;
}
