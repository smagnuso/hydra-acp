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
// what attributeOrphan recovers. "Orphan" therefore means "no session
// owns this", not "nothing is known about this" — the distinction
// matters because it is the provider, recovered that way, that knows
// how to tear one down completely.

import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { paths } from "../../core/paths.js";
import { readJsonSafe } from "../../core/json-store.js";
import { getProvider } from "../../core/workspace/registry.js";
import { shortenHomePath } from "../../core/paths.js";
import { asSnapshotId, type Workspace } from "../../core/workspace/provider.js";
import {
  captureSourceForLanding,
  releaseSourceCapture,
  replaySourceDivergence,
  type SourceCapture,
} from "../../core/workspace/source-state.js";
import { invokedBinName } from "../../core/bin-name.js";
import { daemonFetch } from "./_shared.js";

interface Binding {
  sessionId: string;
  workspace: {
    path: string;
    sourceCwd: string;
    label: string;
    provider: string;
    snapshot?: string;
    vcs?: Record<string, string>;
  };
}

export type WorkspaceState =
  /** Directory exists and a session record points at it. */
  | "bound"
  /** Directory exists, no record references it. Reclaimable. */
  | "orphan"
  /** A record points here but the directory is gone. Rebuildable. */
  | "missing";

export interface WorkspaceRow {
  path: string;
  sourceCwd: string;
  label: string;
  provider: string;
  state: WorkspaceState;
  sessionId?: string;
  branch?: string;
  /** undefined when it could not be determined (missing dir, no provider). */
  clean?: boolean;
  changedCount?: number;
}

function workspacesRoot(): string {
  return path.join(paths.home(), "workspaces");
}

/** Every workspace binding recorded across all session meta.json files. */
async function readBindings(): Promise<Binding[]> {
  const dir = path.join(paths.home(), "sessions");
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const out: Binding[] = [];
  for (const name of names) {
    const rec = await readJsonSafe<{ sessionId?: string; workspace?: Binding["workspace"] }>(
      path.join(dir, name, "meta.json"),
    );
    if (rec?.workspace?.path !== undefined && typeof rec.sessionId === "string") {
      out.push({ sessionId: rec.sessionId, workspace: rec.workspace });
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
    ...(b.vcs !== undefined ? { vcs: b.vcs } : {}),
  };
}

export async function collectWorkspaces(): Promise<WorkspaceRow[]> {
  const bindings = await readBindings();
  const byPath = new Map(bindings.map((b) => [b.workspace.path, b]));
  const dirs = new Set(await readDirs());
  const rows: WorkspaceRow[] = [];

  for (const dir of dirs) {
    const bound = byPath.get(dir);
    if (bound !== undefined) {
      rows.push({
        path: dir,
        sourceCwd: bound.workspace.sourceCwd,
        label: bound.workspace.label,
        provider: bound.workspace.provider,
        state: "bound",
        sessionId: bound.sessionId,
        ...(bound.workspace.vcs?.branch !== undefined
          ? { branch: bound.workspace.vcs.branch }
          : {}),
      });
      continue;
    }
    // No record points here, but the directory can usually still say
    // where it came from. Report that rather than "(unknown)": an
    // orphan you can attribute is one you can decide about.
    const attributed = await attributeOrphan(dir);
    rows.push({
      path: dir,
      sourceCwd: attributed?.sourceCwd ?? "(unknown)",
      label: attributed?.label ?? path.basename(dir),
      provider: attributed?.provider ?? "(unknown)",
      state: "orphan",
      ...(attributed?.vcs?.branch !== undefined ? { branch: attributed.vcs.branch } : {}),
    });
  }

  for (const b of bindings) {
    if (!dirs.has(b.workspace.path)) {
      rows.push({
        path: b.workspace.path,
        sourceCwd: b.workspace.sourceCwd,
        label: b.workspace.label,
        provider: b.workspace.provider,
        state: "missing",
        sessionId: b.sessionId,
        ...(b.workspace.vcs?.branch !== undefined ? { branch: b.workspace.vcs.branch } : {}),
      });
    }
  }

  // Cleanliness decides what prune may touch, so it is worth the stat
  // cost. Only meaningful for a directory that exists and whose provider
  // we know.
  for (const row of rows) {
    if (row.state === "missing" || row.provider === "(unknown)") {
      continue;
    }
    const provider = getProvider(row.provider);
    if (provider === undefined) {
      continue;
    }
    // Bound rows use the recorded binding; orphans fall back to what the
    // directory itself reported, so they get a real DIRTY answer too.
    const binding = byPath.get(row.path);
    const ws =
      binding !== undefined ? toProviderWorkspace(binding.workspace) : await attributeOrphan(row.path);
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

function runGit(args: string[], cwd: string): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: 120_000, maxBuffer: 64 * 1024 * 1024 }, (e, o, s) => {
      resolve({ ok: !e, out: o ?? "", err: s ?? "" });
    });
  });
}

/**
 * Recover a workspace's identity from the directory itself, for use when
 * no session record points at it.
 *
 * The path is a dead end — a hash and a label — but the directory is
 * not: a git worktree names its parent repo in `.git`, and a copy
 * workspace records its source in the manifest sidecar. That is enough
 * to hand an orphan back to its provider, which matters because the
 * provider is what knows how to delete one safely. Returns undefined
 * only when the directory belongs to neither shipped provider.
 */
async function attributeOrphan(dir: string): Promise<Workspace | undefined> {
  const common = await runGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], dir);
  if (common.ok && common.out.trim().length > 0) {
    const gitDir = common.out.trim();
    const branch = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], dir);
    return {
      path: dir,
      sourceCwd: path.dirname(gitDir),
      label: path.basename(dir),
      provider: "git",
      vcs: {
        repoRoot: path.dirname(gitDir),
        ...(branch.ok && branch.out.trim().length > 0 ? { branch: branch.out.trim() } : {}),
      },
    };
  }
  const manifest = await readJsonSafe<{ sourceCwd?: string; label?: string }>(
    `${dir}.manifest.json`,
  );
  if (manifest?.sourceCwd !== undefined) {
    return {
      path: dir,
      sourceCwd: manifest.sourceCwd,
      label: manifest.label ?? path.basename(dir),
      provider: "copy",
    };
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
  const rows = (await collectWorkspaces()).filter((r) => r.state === "bound");
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
  // A dirty source is the NORMAL case: `start` copies the user's work
  // in rather than taking it, so the same edits are still sitting here.
  // Capture it instead of refusing, so the reset this enables cannot
  // lose anything and post-start edits get replayed rather than
  // rejected. Same reconciliation the daemon's `end` performs.
  const capture =
    row.sessionId === undefined
      ? undefined
      : await captureSourceForLanding({
          source,
          startSnapshotRef: `refs/hydra/start/${row.sessionId}`,
          retainRef: `refs/hydra/landing/${row.sessionId}`,
          provider: getProvider(row.provider),
        });
  if (capture === undefined) {
    // No session owns this workspace, so there is no start snapshot to
    // measure against and no way to tell the copy from the user's own
    // work. Refusing is the only safe answer left.
    const dirty = await runGit(["status", "--porcelain", "-uall"], source);
    if (dirty.ok && dirty.out.trim().length > 0) {
      throw new Error(
        `${shortenHomePath(source)} has uncommitted changes; commit or stash them first so a ` +
          `partially-applied result cannot be confused with your own work`,
      );
    }
  }
  const branch = row.branch ?? "";
  if (branch.length === 0) {
    throw new Error(`workspace ${row.label} has no branch to merge from`);
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
async function clearForLanding(source: string, capture: SourceCapture | undefined): Promise<void> {
  if (capture === undefined || capture.clean) {
    return;
  }
  const reset = await runGit(["reset", "--hard", "HEAD"], source);
  const cleaned = await runGit(["clean", "-fd"], source);
  if (!reset.ok || !cleaned.ok) {
    throw new Error(
      `could not clear ${shortenHomePath(source)} for the merge; your work is preserved at ` +
        `${capture.retainedRef}. Nothing was landed.`,
    );
  }
}

/** Put the source's own post-start edits back, and report if they clash. */
async function replayAfterLanding(
  source: string,
  capture: SourceCapture | undefined,
): Promise<void> {
  if (capture === undefined) {
    return;
  }
  if (await replaySourceDivergence({ source, capture })) {
    await releaseSourceCapture({ source, capture });
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
  const sourceHead = (await runGit(["rev-parse", "HEAD"], source)).out.trim();
  const canFf = await runGit(["merge-base", "--is-ancestor", sourceHead, branch], source);
  if (!canFf.ok) {
    const current = (await runGit(["rev-parse", "--abbrev-ref", "HEAD"], source)).out.trim();
    throw new Error(
      `cannot fast-forward ${current} in ${shortenHomePath(source)} to ${branch}.\n` +
        `The source has moved since this workspace was created, or is on a different branch.\n` +
        `Nothing was changed. Merge it yourself with:  git -C ${source} merge ${branch}`,
    );
  }

  // Commit anything outstanding in the workspace: a merge needs commits,
  // and the agent's work is usually sitting uncommitted.
  const wsDirty = await runGit(["status", "--porcelain", "--untracked-files=all"], row.path);
  if (wsDirty.ok && wsDirty.out.trim().length > 0) {
    const staged = await runGit(["add", "-A"], row.path);
    if (!staged.ok) {
      throw new Error(`could not stage workspace changes: ${staged.err.trim()}`);
    }
    const msg = opts.message ?? `hydra: work from ${row.label}`;
    const committed = await runGit(["commit", "-m", msg], row.path);
    if (!committed.ok) {
      throw new Error(`could not commit workspace changes: ${committed.err.trim()}`);
    }
    process.stdout.write(`committed workspace changes on ${branch}\n`);
  }

  await clearForLanding(source, capture);

  const currentBranch = (await runGit(["rev-parse", "--abbrev-ref", "HEAD"], source)).out.trim();
  const merged = await runGit(["merge", "--ff-only", branch], source);
  if (!merged.ok) {
    // Name both branches. The usual cause is that the source moved on
    // since the workspace was created, and the useful thing to say is
    // which two things failed to line up.
    throw new Error(
      `cannot fast-forward ${currentBranch} in ${shortenHomePath(source)} to ${branch}.\n` +
        `The source has moved since this workspace was created, or is on a different branch.\n` +
        `Merge it yourself with:  git -C ${source} merge ${branch}\n` +
        (merged.err.trim() ? `git said: ${merged.err.trim()}\n` : ""),
    );
  }
  await replayAfterLanding(source, capture);
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
  const { source, capture } = await preflight(row, opts.into);

  const provider = getProvider(row.provider);
  if (provider === undefined || !provider.capabilities().supports.captureWorkingState) {
    throw new Error(`provider "${row.provider}" cannot snapshot a working tree to apply from`);
  }
  const bindings = await readBindings();
  const binding = bindings.find((b) => b.workspace.path === row.path);
  if (binding === undefined) {
    throw new Error(`workspace ${row.label} is no longer bound to a session`);
  }
  const base = binding.workspace.snapshot;
  if (base === undefined) {
    throw new Error(`workspace ${row.label} has no recorded base to diff against`);
  }

  // Snapshot through the provider rather than staging in place: it uses
  // a temporary index, so the workspace's own index is left alone and
  // untracked files are still included. Both trees share the object
  // store, so the resulting commit is readable from the source repo.
  const snapshot = await provider.captureWorkingState(row.path, `hydra: apply from ${row.label}`);
  const diff = await runGit(["diff", "--binary", base, snapshot], source);
  if (!diff.ok) {
    throw new Error(`could not compute the change set: ${diff.err.trim()}`);
  }
  if (diff.out.trim().length === 0) {
    process.stdout.write("Nothing to apply: the workspace matches its base.\n");
    return;
  }
  await clearForLanding(source, capture);
  const applied = await new Promise<{ ok: boolean; err: string }>((resolve) => {
    const child = execFile(
      "git",
      ["apply", "--index", "-"],
      { cwd: source, timeout: 120_000, maxBuffer: 64 * 1024 * 1024 },
      (e, _o, s) => resolve({ ok: !e, err: s ?? "" }),
    );
    child.stdin?.end(diff.out);
  });
  if (!applied.ok) {
    throw new Error(`could not apply the change set: ${applied.err.trim()}`);
  }
  await replayAfterLanding(source, capture);
  process.stdout.write(
    `applied ${row.label} into ${shortenHomePath(source)} as staged changes (not committed)\n`,
  );
}

/** Shared post-landing housekeeping. */
async function afterLand(row: WorkspaceRow, source: string, remove: boolean): Promise<void> {
  // The autosave ref exists to make unintegrated work recoverable. Once
  // it is integrated the ref is only pinning objects, so drop it.
  if (row.sessionId !== undefined) {
    // Both refs: the autosave and the landing baseline. Each is a GC
    // root, so a survivor pins objects for a workspace that is done.
    await runGit(["update-ref", "-d", `refs/hydra/snapshots/${row.sessionId}`], source);
    await runGit(["update-ref", "-d", `refs/hydra/start/${row.sessionId}`], source);
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
 * "Missing" rows are built FROM the session binding, not from the
 * filesystem, so reporting "already gone, clearing nothing" and
 * returning left `remove` unable to clear the one row a user is most
 * likely to aim it at. Three things outlive the directory: the binding
 * (which is what lists the row, and what makes resurrect rebuild the
 * workspace), the branch, and the snapshot refs — and the refs are GC
 * roots, so leaving them pins objects for a checkout that no longer
 * exists.
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
async function removeMissing(row: WorkspaceRow): Promise<void> {
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
  const branch = ws.vcs?.branch;
  const repoRoot = ws.vcs?.repoRoot;
  const notes: string[] = [];

  // Before the branch: git refuses to delete a branch it still believes
  // is checked out somewhere, and the registration still points here.
  if (repoRoot !== undefined) {
    await runGit(["worktree", "prune"], repoRoot);
  }
  if (branch !== undefined && !branch.startsWith("hydra/")) {
    notes.push(`kept ${branch} (not hydra's to delete)`);
  } else {
    const held = await reclaimOrphanBranch(ws);
    if (held !== undefined) {
      notes.push(held);
    }
  }

  // The start ref measured the source at isolation time, for landing.
  // Nothing can be landed from a checkout that is gone, so it is pure
  // GC root now. The autosave is the opposite: with the directory gone
  // it is the only copy of whatever was uncommitted, so it stays.
  const provider = getProvider(bound.workspace.provider);
  if (provider !== undefined && row.sessionId !== undefined) {
    await provider.dropSnapshotRef(ws, `refs/hydra/start/${row.sessionId}`).catch(() => undefined);
    const autosave = `refs/hydra/snapshots/${row.sessionId}`;
    if (await refExists(ws, autosave)) {
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
 * Distinct from `prune`, which sweeps unattributable orphans in bulk.
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

  if (row.state === "missing") {
    await removeMissing(row);
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
    // A live session holds a hydra lock on its workspace. Removing it
    // would yank the working directory out from under a running agent.
    const bindings = await readBindings();
    const bound = bindings.find((b) => b.workspace.path === row.path);
    if (bound !== undefined) {
      const provider = getProvider(bound.workspace.provider);
      const listed = await provider?.listWorkspaces(bound.workspace.sourceCwd).catch(() => []);
      const live = listed?.find((w) => w.path === row.path);
      if (live?.vcs?.locked?.startsWith("hydra-acp:") === true) {
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
    const held = await removeUnbound(row);
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
    await provider.dropSnapshotRef(ws, `refs/hydra/start/${row.sessionId}`).catch(() => undefined);
    const autosave = `refs/hydra/snapshots/${row.sessionId}`;
    if (discarding && (await refExists(ws, autosave))) {
      retained = autosave;
    } else {
      await provider.dropSnapshotRef(ws, autosave).catch(() => undefined);
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
  if (row.state === "bound") {
    process.stdout.write(
      `Its session still references it; the next resurrect rebuilds it from ${row.branch ?? "its branch"} ` +
        `or starts fresh from ${shortenHomePath(row.sourceCwd)}.\n`,
    );
  }
}

/** Whether a ref is present, so we never advertise a recovery that isn't there. */
async function refExists(ws: Workspace, ref: string): Promise<boolean> {
  const repoRoot = ws.vcs?.repoRoot;
  if (repoRoot === undefined) {
    return false;
  }
  return (await runGit(["rev-parse", "--verify", "--quiet", ref], repoRoot)).ok;
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
async function removeUnbound(row: WorkspaceRow): Promise<string | undefined> {
  const ws = await attributeOrphan(row.path);
  const provider = ws === undefined ? undefined : getProvider(ws.provider);
  if (ws === undefined || provider === undefined) {
    // Genuinely unattributable: the directory is all there is to remove.
    await fs.rm(row.path, { recursive: true, force: true });
    await fs.rm(`${row.path}.manifest.json`, { force: true }).catch(() => undefined);
    return undefined;
  }
  await provider.unlock(ws).catch(() => undefined);
  await provider.removeWorkspace(ws, { force: true });
  return reclaimOrphanBranch(ws);
}

export async function runWorkspaceList(
  opts: { json?: boolean; missing?: boolean } = {},
): Promise<void> {
  const all = await collectWorkspaces();
  // JSON is a dump for tooling and every row carries `state`, so it
  // stays complete: a flag that silently shrinks machine-readable output
  // is worse than the noise it saves.
  if (opts.json === true) {
    process.stdout.write(JSON.stringify({ workspaces: all }, null, 2) + "\n");
    return;
  }
  // A missing row is a property of a SESSION (it points at a directory
  // that is gone), not a workspace that exists, and sessions sit for
  // weeks. Keep it out of the table by default but never out of the
  // footer: hidden-and-counted is tidying, hidden-without-trace is how
  // you stop finding out that two sessions are stale.
  const rows = opts.missing === true ? all : all.filter((r) => r.state !== "missing");
  if (all.length === 0) {
    process.stdout.write("No workspaces.\n");
    return;
  }

  if (rows.length === 0) {
    process.stdout.write("No workspaces on disk.\n");
  } else {
    // WORKSPACE goes last because it is the only variable-width column;
    // the short ones stay aligned to the left where they can be scanned.
    const cols = [
      ["STATE", "SESSION", "SOURCE", "LABEL", "DIRTY", "WORKSPACE"],
      ...rows.map((r) => [
        r.state,
        r.sessionId?.replace(/^hydra_session_/, "") ?? "-",
        shortenHomePath(r.sourceCwd),
        r.label,
        r.changedCount === undefined ? "?" : r.changedCount > 0 ? String(r.changedCount) : "-",
        shortenHomePath(r.path),
      ]),
    ];
    const widths = cols[0]!.map((_, i) => Math.max(...cols.map((row) => (row[i] ?? "").length)));
    for (const row of cols) {
      process.stdout.write(
        row.map((c, i) => (c ?? "").padEnd(widths[i] ?? 0)).join("  ").trimEnd() + "\n",
      );
    }
  }

  const orphans = rows.filter((r) => r.state === "orphan").length;
  if (orphans > 0) {
    process.stdout.write(
      `\n${orphans} orphan${orphans === 1 ? "" : "s"} (no session references them). ` +
        `\`${invokedBinName()} workspace prune\` removes the ones holding no uncommitted work.\n`,
    );
  }
  // Counted from `all`, never from the filtered rows: the footer is the
  // only trace a hidden row leaves.
  const missing = all.filter((r) => r.state === "missing").length;
  if (missing > 0) {
    const bin = invokedBinName();
    process.stdout.write(
      `${orphans > 0 ? "" : "\n"}${missing} missing (a session points at a directory that is ` +
        `gone). Committed work is rebuilt from its branch on next resurrect; ` +
        `\`${bin} workspace remove\` clears the binding instead.\n` +
        (opts.missing === true ? "" : `List them with \`${bin} workspace --missing\`.\n`),
    );
  }
}

export async function runWorkspacePrune(opts: { force?: boolean } = {}): Promise<void> {
  const rows = await collectWorkspaces();
  const orphans = rows.filter((r) => r.state === "orphan");
  if (orphans.length === 0) {
    process.stdout.write("Nothing to prune.\n");
    return;
  }

  let removed = 0;
  let kept = 0;
  for (const row of orphans) {
    // An orphan has no record, but it is not therefore anonymous: the
    // directory still knows its own provider and source. Recovering that
    // is what lets the removal go through provider.removeWorkspace,
    // which is the only thing that tears down a workspace *completely* —
    // a bare rm of the directory leaves git's worktree registry (and the
    // branch) pointing at a path that no longer exists.
    const ws = await attributeOrphan(row.path);
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
    const held = await reclaimOrphanBranch(ws);
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
 * that `missing` workspaces are rebuilt from, and for an orphan it is
 * the last copy. So the empty ones go and the rest are reported.
 *
 * Returns a note when the branch was kept, undefined when there was
 * nothing to keep or nothing to do.
 */
async function reclaimOrphanBranch(ws: Workspace): Promise<string | undefined> {
  const branch = ws.vcs?.branch;
  const repoRoot = ws.vcs?.repoRoot;
  // Only ever our own namespace — a workspace checked out on a user's
  // branch must not have that branch deleted out from under them.
  if (branch === undefined || repoRoot === undefined || !branch.startsWith("hydra/")) {
    return undefined;
  }
  const ahead = await runGit(["rev-list", "--count", `HEAD..${branch}`], repoRoot);
  if (!ahead.ok) {
    return `branch ${branch} kept (could not compare it to HEAD)`;
  }
  if (Number.parseInt(ahead.out.trim(), 10) > 0) {
    return `branch ${branch} kept — it has ${ahead.out.trim()} commit(s) not in HEAD`;
  }
  const deleted = await runGit(["branch", "-D", branch], repoRoot);
  return deleted.ok ? undefined : `branch ${branch} kept (delete failed)`;
}
