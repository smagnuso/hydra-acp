// Isolation backed by `git worktree`.
//
// Invocation follows the convention already established in
// src/tui/app.ts: execFile("git", ...) with an explicit cwd and timeout,
// where ANY error (not a repository, git not installed, timed out) is
// treated as "this is unavailable" rather than thrown. That is exactly
// the fail-open behavior the isolation design requires, so the caller can
// fall back to the shared tree instead of failing a session/new.
//
// Two things here are load-bearing and easy to undo by accident:
//
//   - Workspaces live OUTSIDE the source repo (see workspaceRootFor), so
//     a workspace path shares no prefix with its source. Nothing may
//     relate the two by prefix matching.
//   - The workspace is locked while its session is live, so a concurrent
//     `git worktree prune` (ours, another client's, or a human's) cannot
//     remove a checkout somebody is working in. Reconciliation may
//     release a lock whose session is gone; it must never release a lock
//     a human set, which is why our lock reason carries a recognizable
//     prefix.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  WorkspaceUnsupportedError,
  asSnapshotId,
  sanitizeLabel,
  workspaceRootFor,
  type Capabilities,
  type CreateWorkspaceOptions,
  type CreateWorkspaceResult,
  type IntegrateResult,
  type IsolationProvider,
  type PathChange,
  type SnapshotId,
  type Workspace,
  type WorkspaceStatus,
} from "./provider.js";
import { parseWorktreeListPorcelain, shortBranchName } from "./worktree-list.js";

export const GIT_PROVIDER_KIND = "git";

/** Marks locks we set, so reconciliation can tell ours from a human's. */
export const HYDRA_LOCK_PREFIX = "hydra-acp:";

const BRANCH_NAMESPACE = "hydra";

// Interrogations are fast; creating a worktree checks out a tree and can
// legitimately take a while on a large repo.
const QUERY_TIMEOUT_MS = 5_000;
const MUTATE_TIMEOUT_MS = 120_000;

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function pathExists(p: string): Promise<boolean> {
  return fs
    .access(p)
    .then(() => true)
    .catch(() => false);
}

function runGit(
  args: string[],
  cwd: string,
  timeout: number,
  extraEnv?: Record<string, string>,
): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      {
        cwd,
        timeout,
        maxBuffer: 8 * 1024 * 1024,
        ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}),
      },
      (err, stdout, stderr) => {
        resolve({ ok: !err, stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });
}

/**
 * Parse `git status --porcelain` (v1) into repo-relative paths.
 *
 * Exported for direct testing. The path begins at column 3 and runs to
 * end of line, so it must be sliced rather than split: splitting on
 * whitespace truncates "src/my file.ts" to "file.ts". A rename record
 * carries "ORIG -> NEW"; the post-rename path is the one that exists.
 */
export function parseStatusPorcelain(stdout: string): string[] {
  const out: string[] = [];
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.length < 4) {
      continue;
    }
    const body = line.slice(3);
    const arrow = body.indexOf(" -> ");
    out.push(arrow === -1 ? body : body.slice(arrow + 4));
  }
  return out;
}

export class GitProvider implements IsolationProvider {
  readonly kind = GIT_PROVIDER_KIND;

  capabilities(): Capabilities {
    return {
      // Worktrees share the repository's object store, so an extra
      // workspace costs a checkout rather than a clone or a fetch.
      cheapWorkspaces: true,
      sharedHistory: true,
      // A dirty tree can be captured with a temp index and commit-tree,
      // leaving the user's index and working tree untouched.
      nonMutatingCapture: true,
      conflictReporting: true,
      locking: true,
      requiresServer: false,
      // Deferred to the integration increment. Declared here so callers
      // negotiate up front rather than discovering the gap mid-plan.
      supports: {
        record: false,
        integrate: false,
        captureWorkingState: true,
        changedPaths: false,
        environmentNotes: true,
        // Removing a worktree leaves its branch (and every commit on it)
        // in the repository, so the checkout can be rebuilt with its
        // recorded work intact.
        rematerialize: true,
      },
    };
  }

  /**
   * Rebuild a removed worktree by checking its branch out again.
   *
   * `git worktree remove` deletes only the working directory; the branch
   * is an ordinary ref and survives, so `git worktree add <path> <branch>`
   * restores everything that was COMMITTED. Uncommitted changes died with
   * the directory, which is the same bargain git makes everywhere else.
   */
  async rematerialize(ws: Workspace): Promise<CreateWorkspaceResult> {
    const branch = ws.vcs?.branch;
    if (branch === undefined) {
      return { ok: false, reason: "workspace has no recorded branch to restore from" };
    }
    const repoRoot = ws.vcs?.repoRoot ?? ws.sourceCwd;
    if (!(await pathExists(repoRoot))) {
      return { ok: false, reason: `source repository ${repoRoot} no longer exists` };
    }

    const known = await runGit(
      ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
      repoRoot,
      QUERY_TIMEOUT_MS,
    );
    if (!known.ok || known.stdout.trim().length === 0) {
      return { ok: false, reason: `branch ${branch} no longer exists in ${repoRoot}` };
    }

    // Clear any stale registry entry for the removed path first, or git
    // refuses the re-add with "already registered".
    //
    // Unlock before pruning. We lock live workspaces so concurrent
    // cleanup cannot delete them, but `git worktree prune` also SKIPS
    // locked entries, so a workspace removed by something that ignores
    // locks (rm -rf, a tmp reaper, disk cleanup) leaves a locked entry
    // pointing at a directory that no longer exists. Pruning would then
    // silently do nothing and the re-add would fail. Best-effort: the
    // lock is ours, and its directory is already gone.
    await runGit(["worktree", "unlock", ws.path], repoRoot, QUERY_TIMEOUT_MS);
    await runGit(["worktree", "prune"], repoRoot, QUERY_TIMEOUT_MS);

    const added = await runGit(
      ["worktree", "add", ws.path, branch],
      repoRoot,
      MUTATE_TIMEOUT_MS,
    );
    if (!added.ok) {
      return {
        ok: false,
        reason: `could not restore worktree: ${added.stderr.trim() || "unknown error"}`,
      };
    }
    return {
      ok: true,
      workspace: {
        ...ws,
        vcs: { ...(ws.vcs ?? {}), kind: "git", branch, repoRoot },
      },
    };
  }

  async createWorkspace(opts: CreateWorkspaceOptions): Promise<CreateWorkspaceResult> {
    const source = path.resolve(opts.sourceCwd);

    const topLevel = await runGit(["rev-parse", "--show-toplevel"], source, QUERY_TIMEOUT_MS);
    if (!topLevel.ok) {
      return { ok: false, reason: `${source} is not a git repository (or git is unavailable)` };
    }
    const repoRoot = topLevel.stdout.trim();
    if (repoRoot.length === 0) {
      return { ok: false, reason: `could not resolve the repository root for ${source}` };
    }

    // An unborn HEAD has nothing to branch from. Fail open: this is a
    // legitimate state for a freshly-initialized repository.
    const head = await runGit(["rev-parse", "HEAD"], repoRoot, QUERY_TIMEOUT_MS);
    if (!head.ok) {
      return { ok: false, reason: `${repoRoot} has no commits yet, so there is nothing to branch from` };
    }

    const base = opts.from ?? asSnapshotId(head.stdout.trim());
    const label = sanitizeLabel(opts.label);
    const root = workspaceRootFor(source);
    const target = path.join(root, label);
    const branch = `${BRANCH_NAMESPACE}/${label}`;

    try {
      await fs.mkdir(root, { recursive: true });
    } catch (err) {
      return { ok: false, reason: `could not create workspace root: ${String(err)}` };
    }

    // Refuse rather than adopt an existing directory. Silently reusing
    // one is how two sessions end up sharing a checkout, which is the
    // failure this feature exists to prevent.
    try {
      await fs.access(target);
      return { ok: false, reason: `workspace already exists at ${target}` };
    } catch {
      // Expected: the target should not exist yet.
    }

    const add = await runGit(
      ["worktree", "add", "--no-track", "-b", branch, target, base],
      repoRoot,
      MUTATE_TIMEOUT_MS,
    );
    if (!add.ok) {
      return {
        ok: false,
        reason: `git worktree add failed: ${add.stderr.trim() || "unknown error"}`,
      };
    }

    return {
      ok: true,
      workspace: {
        path: target,
        sourceCwd: source,
        label,
        provider: this.kind,
        snapshot: base,
        vcs: { kind: "git", branch, base, repoRoot },
      },
    };
  }

  async removeWorkspace(ws: Workspace, opts: { force: boolean }): Promise<void> {
    // Make the keep-or-delete judgment here rather than delegating it to
    // git. `git worktree remove` deletes a worktree containing UNTRACKED
    // files without complaint (verified on git 2.43); it only refuses for
    // modified tracked files. Untracked files are precisely what an agent
    // produces (new source files it just wrote), so trusting git's guard
    // would silently destroy the work this feature exists to protect.
    if (!opts.force) {
      const st = await this.status(ws);
      if (!st.clean) {
        throw new Error(
          `workspace ${ws.path} has ${st.changedPaths.length} changed path(s)${st.hasRecordedWork ? " and unintegrated recorded work" : ""}; pass force to remove`,
        );
      }
    }

    const repoRoot = ws.vcs?.repoRoot ?? ws.sourceCwd;
    await this.unlock(ws).catch(() => undefined);
    // Always --force at this point: either we verified cleanliness above,
    // or the caller explicitly chose to discard. Omitting it would make
    // git re-apply its own weaker, differently-shaped guard.
    const removed = await runGit(
      ["worktree", "remove", "--force", ws.path],
      repoRoot,
      MUTATE_TIMEOUT_MS,
    );
    if (!removed.ok) {
      // Forced removal: git may refuse if its metadata is already gone.
      // The directory is what the caller wants rid of.
      await fs.rm(ws.path, { recursive: true, force: true });
      await runGit(["worktree", "prune"], repoRoot, QUERY_TIMEOUT_MS);
    }
  }

  async listWorkspaces(sourceCwd: string): Promise<readonly Workspace[]> {
    const source = path.resolve(sourceCwd);
    const topLevel = await runGit(["rev-parse", "--show-toplevel"], source, QUERY_TIMEOUT_MS);
    if (!topLevel.ok) {
      return [];
    }
    const repoRoot = topLevel.stdout.trim();
    const listed = await runGit(["worktree", "list", "--porcelain"], repoRoot, QUERY_TIMEOUT_MS);
    if (!listed.ok) {
      return [];
    }
    const root = workspaceRootFor(source);
    const out: Workspace[] = [];
    for (const entry of parseWorktreeListPorcelain(listed.stdout)) {
      // Only report workspaces we own. A user's own `git worktree add`
      // elsewhere is not ours to manage or reconcile away.
      if (path.dirname(entry.path) !== root) {
        continue;
      }
      const vcs: Record<string, string> = { kind: "git", repoRoot };
      const branch = shortBranchName(entry.branch);
      if (branch !== undefined) {
        vcs.branch = branch;
      }
      if (entry.head !== undefined) {
        vcs.head = entry.head;
      }
      if (entry.lockedReason !== undefined) {
        vcs.locked = entry.lockedReason;
      }
      out.push({
        path: entry.path,
        sourceCwd: source,
        label: path.basename(entry.path),
        provider: this.kind,
        vcs,
      });
    }
    return out;
  }

  async status(ws: Workspace): Promise<WorkspaceStatus> {
    const st = await runGit(
      ["status", "--porcelain", "--untracked-files=all"],
      ws.path,
      QUERY_TIMEOUT_MS,
    );
    if (!st.ok) {
      // Cannot tell. Report dirty: reporting clean would let
      // reconciliation delete a checkout that may hold real work.
      return { clean: false, changedPaths: [], hasRecordedWork: false };
    }
    const changedPaths = parseStatusPorcelain(st.stdout);

    let hasRecordedWork = false;
    if (ws.snapshot !== undefined) {
      const counted = await runGit(
        ["rev-list", "--count", `${ws.snapshot}..HEAD`],
        ws.path,
        QUERY_TIMEOUT_MS,
      );
      if (counted.ok) {
        hasRecordedWork = Number.parseInt(counted.stdout.trim(), 10) > 0;
      }
    }
    return { clean: changedPaths.length === 0 && !hasRecordedWork, changedPaths, hasRecordedWork };
  }

  async lock(ws: Workspace, reason: string): Promise<void> {
    const repoRoot = ws.vcs?.repoRoot ?? ws.sourceCwd;
    await runGit(
      ["worktree", "lock", "--reason", `${HYDRA_LOCK_PREFIX}${reason}`, ws.path],
      repoRoot,
      QUERY_TIMEOUT_MS,
    );
  }

  async unlock(ws: Workspace): Promise<void> {
    const repoRoot = ws.vcs?.repoRoot ?? ws.sourceCwd;
    await runGit(["worktree", "unlock", ws.path], repoRoot, QUERY_TIMEOUT_MS);
  }

  async environmentNotes(ws: Workspace): Promise<readonly string[]> {
    const notes: string[] = [];
    const branch = ws.vcs?.branch;
    notes.push(
      `This directory is a git worktree of ${ws.sourceCwd}${branch !== undefined ? `, on branch ${branch}` : ""}. Do not read or write ${ws.sourceCwd} directly; paths under it refer to the corresponding file here. Prefer repo-relative paths, which are identical in both.`,
    );
    notes.push(
      "`.git` here is a file, not a directory. That is normal for a worktree and does not need repairing.",
    );

    // Only mention submodules when the repository actually has them.
    // Unconditional caveats are noise, and this text is paid per session.
    const hasSubmodules = await fs
      .access(path.join(ws.path, ".gitmodules"))
      .then(() => true)
      .catch(() => false);
    if (hasSubmodules) {
      notes.push(
        "Submodules are NOT initialized in a new worktree, so their directories are empty. Run `git submodule update --init` if you need them. Do not re-add submodule contents as ordinary tracked files: that silently corrupts the integration back to the source branch.",
      );
    }
    return notes;
  }

  /**
   * Snapshot a working tree into a commit object WITHOUT touching the
   * user's index or working tree.
   *
   * The obvious implementations are both wrong. `git stash push` yanks
   * the changes out of the tree the user is looking at, which is an
   * unacceptable surprise. `git stash create` mutates nothing but omits
   * untracked files, and untracked files are exactly where fresh agent
   * work lives (the new source file it just wrote).
   *
   * So: point GIT_INDEX_FILE at a throwaway index, stage everything
   * against THAT, write a tree from it, and build a commit object. The
   * real index never sees any of it. The resulting commit is not on any
   * branch; the caller decides where (if anywhere) to point a ref at it.
   */
  async captureWorkingState(sourceCwd: string, message: string): Promise<SnapshotId> {
    const tmpIndex = path.join(
      os.tmpdir(),
      `hydra-index-${process.pid}-${randomBytes(6).toString("hex")}`,
    );
    const env = { GIT_INDEX_FILE: tmpIndex };
    try {
      const staged = await runGit(["add", "-A"], sourceCwd, MUTATE_TIMEOUT_MS, env);
      if (!staged.ok) {
        throw new Error(`could not stage working state: ${staged.stderr.trim()}`);
      }
      const tree = await runGit(["write-tree"], sourceCwd, MUTATE_TIMEOUT_MS, env);
      if (!tree.ok || tree.stdout.trim().length === 0) {
        throw new Error(`could not write tree: ${tree.stderr.trim()}`);
      }

      // Parent the snapshot on HEAD when there is one so the object is
      // reachable in a sensible chain. An unborn HEAD yields a root
      // commit, which is still a perfectly good snapshot.
      const head = await runGit(["rev-parse", "HEAD"], sourceCwd, QUERY_TIMEOUT_MS);
      const args = ["commit-tree", tree.stdout.trim(), "-m", message];
      if (head.ok && head.stdout.trim().length > 0) {
        args.push("-p", head.stdout.trim());
      }
      const commit = await runGit(args, sourceCwd, MUTATE_TIMEOUT_MS, env);
      if (!commit.ok || commit.stdout.trim().length === 0) {
        throw new Error(`could not create snapshot commit: ${commit.stderr.trim()}`);
      }
      return asSnapshotId(commit.stdout.trim());
    } finally {
      await fs.rm(tmpIndex, { force: true }).catch(() => undefined);
    }
  }

  /**
   * Point a ref at a snapshot so its objects survive garbage collection.
   *
   * Deliberately OUTSIDE refs/heads/: a ref under refs/hydra/ is a GC
   * root (so the snapshot is durable) but does not appear in
   * `git branch`, default `git log`, or most UIs, so continuous
   * autosaving costs the user no history noise. The tradeoff is that
   * these refs pin objects forever, so whoever creates them owns
   * deleting them (see dropSnapshotRef).
   */
  async retainSnapshot(ws: Workspace, ref: string, snapshot: SnapshotId): Promise<void> {
    const repoRoot = ws.vcs?.repoRoot ?? ws.sourceCwd;
    await runGit(["update-ref", ref, snapshot], repoRoot, QUERY_TIMEOUT_MS);
  }

  async dropSnapshotRef(ws: Workspace, ref: string): Promise<void> {
    const repoRoot = ws.vcs?.repoRoot ?? ws.sourceCwd;
    await runGit(["update-ref", "-d", ref], repoRoot, QUERY_TIMEOUT_MS);
  }

  // `async` is deliberate on every stub below. A method declared
  // Promise-returning that throws SYNCHRONOUSLY cannot be caught with
  // .catch() on its return value, so a caller doing
  // `provider.record(...).catch(fallback)` gets an uncaught exception
  // instead of its fallback. Rejecting keeps the contract honest.

  async record(): Promise<SnapshotId> {
    throw new WorkspaceUnsupportedError(this.kind, "record");
  }

  async changedPaths(): Promise<readonly PathChange[]> {
    throw new WorkspaceUnsupportedError(this.kind, "changedPaths");
  }

  async integrate(): Promise<IntegrateResult> {
    throw new WorkspaceUnsupportedError(this.kind, "integrate");
  }
}
