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
import { shortenHomePath } from "../paths.js";
import {
  WorkspaceUnsupportedError,
  asSnapshotId,
  capLines,
  findFreeLabel,
  sanitizeLabel,
  workspaceRootFor,
  type Capabilities,
  type CreateWorkspaceOptions,
  type CreateWorkspaceResult,
  type IntegrateResult,
  type IsolationProvider,
  type NestedTreesResult,
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
// Submodule init is in a different class again: it can clone from a
// remote, once per submodule, recursively. 120s is a plausible time for
// ONE of them on a cold cache, so reusing MUTATE_TIMEOUT_MS here would
// kill the operation partway through and leave half-populated
// directories, which is worse than either finishing or not starting.
const NESTED_TIMEOUT_MS = 900_000;

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

/** One `git status --porcelain` record: its XY code and its path. */
export interface StatusEntry {
  /** The two-character XY code, verbatim (" M", "M ", "??", "A ", ...). */
  readonly code: string;
  /** Repo-relative. */
  readonly path: string;
}

/**
 * Parse `git status --porcelain` (v1).
 *
 * Exported for direct testing. The path begins at column 3 and runs to
 * end of line, so it must be sliced rather than split: splitting on
 * whitespace truncates "src/my file.ts" to "file.ts". A rename record
 * carries "ORIG -> NEW"; the post-rename path is the one that exists.
 *
 * The XY code is kept rather than discarded because staged-vs-unstaged is
 * the whole content of a useful status report, and it exists nowhere else:
 * a second `git status` run would be the only way to recover it.
 */
export function parseStatusPorcelain(stdout: string): StatusEntry[] {
  const out: StatusEntry[] = [];
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.length < 4) {
      continue;
    }
    const body = line.slice(3);
    const arrow = body.indexOf(" -> ");
    out.push({
      code: line.slice(0, 2),
      path: arrow === -1 ? body : body.slice(arrow + 4),
    });
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
        // `git worktree add` does not populate submodules.
        nestedTrees: true,
      },
    };
  }

  /**
   * Populate (and optionally reset) the workspace's submodules.
   *
   * Gated on `.gitmodules` so a repo without submodules pays one stat
   * rather than a `git submodule` invocation, which matters because this
   * runs on every workspace creation.
   *
   * Ordering inside the reset case is deliberate. `update --force` puts
   * each submodule's checkout back on its recorded commit, then the
   * `foreach` pair clears anything in the working tree that survived
   * that: `update` moves HEAD, it does not clean up after local edits or
   * untracked files. Running the foreach first would just let `update`
   * re-dirty nothing, but it would also skip submodules that were not
   * populated yet, which is exactly the set `update --init` is there to
   * create.
   */
  async materializeNested(
    ws: Workspace,
    opts?: { discardLocal?: boolean; purgeIgnored?: boolean },
  ): Promise<NestedTreesResult> {
    const hasSubmodules = await pathExists(path.join(ws.path, ".gitmodules"));
    if (!hasSubmodules) {
      return { ok: true, count: 0 };
    }

    const init = await runGit(
      [
        "submodule",
        "update",
        "--init",
        "--recursive",
        ...(opts?.discardLocal === true ? ["--force"] : []),
      ],
      ws.path,
      NESTED_TIMEOUT_MS,
    );
    if (!init.ok) {
      return {
        ok: false,
        count: 0,
        reason: init.stderr.trim() || "git submodule update --init failed",
      };
    }

    if (opts?.discardLocal === true) {
      const reset = await runGit(
        ["submodule", "foreach", "--recursive", "git", "reset", "--hard"],
        ws.path,
        NESTED_TIMEOUT_MS,
      );
      if (!reset.ok) {
        return {
          ok: false,
          count: 0,
          reason: reset.stderr.trim() || "could not reset submodules",
        };
      }
      const cleanArgs = opts.purgeIgnored === true ? "-ffdx" : "-fd";
      const cleaned = await runGit(
        ["submodule", "foreach", "--recursive", "git", "clean", cleanArgs],
        ws.path,
        NESTED_TIMEOUT_MS,
      );
      if (!cleaned.ok) {
        return {
          ok: false,
          count: 0,
          reason: cleaned.stderr.trim() || "could not clean submodules",
        };
      }
    }

    // Counted after the fact from what is actually initialized, rather
    // than from `.gitmodules`, so the number describes the result instead
    // of the intent.
    const listed = await runGit(
      ["submodule", "status", "--recursive"],
      ws.path,
      QUERY_TIMEOUT_MS,
    );
    const count = listed.ok
      ? listed.stdout.split("\n").filter((l) => l.trim().length > 0).length
      : 0;
    return { ok: true, count };
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
    const requested = sanitizeLabel(opts.label);
    const root = workspaceRootFor(source);

    try {
      await fs.mkdir(root, { recursive: true });
    } catch (err) {
      return { ok: false, reason: `could not create workspace root: ${String(err)}` };
    }

    // Find a label whose directory AND branch are both free.
    //
    // Both halves matter, and the branch half is easy to miss: a branch
    // can outlive its checkout (that is what makes a removed workspace
    // recoverable), so a label whose directory is gone may still have a
    // branch holding the name. Checking only the directory produces a
    // `worktree add` that dies on "a branch named X already exists",
    // which is exactly what happens when a session starts a workspace,
    // ends it, and starts another.
    //
    // Suffixing rather than refusing: the caller asked for isolation,
    // not for a specific name, and the label it gets back is reported on
    // the returned workspace.
    const label = await findFreeLabel(requested, async (candidate) => {
      const dirTaken = await fs
        .access(path.join(root, candidate))
        .then(() => true)
        .catch(() => false);
      if (dirTaken) {
        return false;
      }
      const branchTaken = await runGit(
        ["rev-parse", "--verify", "--quiet", `refs/heads/${BRANCH_NAMESPACE}/${candidate}`],
        repoRoot,
        QUERY_TIMEOUT_MS,
      );
      return !branchTaken.ok;
    });
    if (label === undefined) {
      return { ok: false, reason: `no free name available for "${requested}"` };
    }
    const target = path.join(root, label);
    const branch = `${BRANCH_NAMESPACE}/${label}`;

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

  async removeWorkspace(
    ws: Workspace,
    opts: { force: boolean; discardLine?: boolean },
  ): Promise<void> {
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
    // Drop the branch when the caller says the line is finished with.
    // -D rather than -d: an unmerged branch here means the caller
    // explicitly decided its content is safe elsewhere, and -d would
    // second-guess that with a refusal the caller cannot act on.
    if (opts.discardLine === true && ws.vcs?.branch !== undefined) {
      await runGit(["branch", "-D", ws.vcs.branch], repoRoot, QUERY_TIMEOUT_MS);
    }
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
    const changedPaths = parseStatusPorcelain(st.stdout).map((e) => e.path);

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
    //
    // What this note used to say is now false: workspaces initialize
    // their submodules (see materializeNested), so the agent no longer
    // meets empty directories and no longer needs telling to populate
    // them. The corruption warning stays, because that hazard was never
    // about emptiness: it is about the instinct to fix a submodule that
    // looks wrong by committing its contents into the superproject, and a
    // populated submodule can still look wrong (detached HEAD, a commit
    // the source branch does not reference).
    const hasSubmodules = await fs
      .access(path.join(ws.path, ".gitmodules"))
      .then(() => true)
      .catch(() => false);
    if (hasSubmodules) {
      notes.push(
        "Submodules here are initialized and checked out at the commits this tree records, which means each sits on a detached HEAD. That is normal and does not need repairing. Never re-add a submodule's contents as ordinary tracked files in the superproject: that silently corrupts the integration back to the source branch.",
      );
    }
    return notes;
  }

  async statusReport(ws: Workspace): Promise<readonly string[]> {
    const lines: string[] = [];
    const st = await runGit(
      ["status", "--porcelain", "--untracked-files=all"],
      ws.path,
      QUERY_TIMEOUT_MS,
    );
    // A failed probe says nothing rather than claiming the tree is clean:
    // "no uncommitted changes" is the one wrong answer that would make
    // somebody discard work.
    if (st.ok) {
      const entries = parseStatusPorcelain(st.stdout);
      if (entries.length === 0) {
        lines.push("no uncommitted changes");
      } else {
        // Counted per axis, not per file: "MM" is staged work AND a later
        // unstaged edit to the same file, and both are true at once. The
        // printed codes disambiguate, so do not "fix" this into a per-file
        // tally that has to pick one and hide the other.
        let staged = 0;
        let unstaged = 0;
        let untracked = 0;
        for (const { code } of entries) {
          if (code === "??") {
            untracked += 1;
            continue;
          }
          if (code[0] !== " " && code[0] !== "?") {
            staged += 1;
          }
          if (code[1] !== " " && code[1] !== "?") {
            unstaged += 1;
          }
        }
        const parts: string[] = [];
        if (staged > 0) {
          parts.push(`${staged} staged`);
        }
        if (unstaged > 0) {
          parts.push(`${unstaged} unstaged`);
        }
        if (untracked > 0) {
          parts.push(`${untracked} untracked`);
        }
        lines.push(`${parts.join(", ")}:`);
        lines.push(...capLines(entries.map((e) => `  ${e.code} ${e.path}`)));
      }
    }
    lines.push(...(await this.syncLines(ws)));
    return lines;
  }

  /**
   * How this workspace stands relative to the tree it came from.
   *
   * The source tree, NOT a remote: that is what `sync` moves and what
   * gates landing, so it is the answer that changes what you do next.
   *
   * Silence on any failed probe. This is decoration on a status reply;
   * guessing here would put a wrong ahead/behind count in front of
   * someone about to decide whether their work is safe.
   */
  private async syncLines(ws: Workspace): Promise<string[]> {
    if (ws.vcs?.branch === undefined) {
      return [];
    }
    const [sourceHead, here] = await Promise.all([
      runGit(["rev-parse", "HEAD"], ws.sourceCwd, QUERY_TIMEOUT_MS),
      runGit(["rev-parse", "HEAD"], ws.path, QUERY_TIMEOUT_MS),
    ]);
    const source = sourceHead.stdout.trim();
    const mine = here.stdout.trim();
    if (!sourceHead.ok || !here.ok || source.length === 0 || mine.length === 0) {
      return [];
    }
    const where = shortenHomePath(ws.sourceCwd);
    if (source === mine) {
      return [`in sync with ${where}`];
    }
    // One walk for both counts. Left is the source's side, so left is
    // what this workspace is missing.
    const counted = await runGit(
      ["rev-list", "--left-right", "--count", `${source}...${mine}`],
      ws.path,
      QUERY_TIMEOUT_MS,
    );
    const counts = counted.stdout
      .trim()
      .split(/\s+/)
      .map((n) => Number.parseInt(n, 10));
    const behind = counts[0];
    const ahead = counts[1];
    if (
      !counted.ok ||
      behind === undefined ||
      ahead === undefined ||
      !Number.isFinite(behind) ||
      !Number.isFinite(ahead)
    ) {
      return [];
    }
    const out: string[] = [];
    if (behind > 0) {
      out.push(
        `${behind} commit(s) behind ${where}. \`/hydra workspace sync\` brings them in; ` +
          `landing is fast-forward-only, so this also unblocks \`stop\`.`,
      );
    }
    if (ahead > 0) {
      out.push(`${ahead} commit(s) recorded here and not landed yet.`);
    }
    return out;
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
      // Seed the temp index from HEAD before adding anything.
      //
      // Without this the index starts EMPTY, so git considers nothing
      // tracked and applies ignore rules to every path — including paths
      // that are tracked in the real repository. A file that is both
      // committed and matched by .gitignore (a `.DS_Store` someone added
      // years ago, a `.env` committed before the rule existed, generated
      // output added and later ignored) is therefore skipped by `add -A`,
      // vanishes from the snapshot tree, and reads as a DELETION against
      // HEAD.
      //
      // That is not cosmetic. The carried-work patch replays the deletion
      // into a fresh workspace, and a later landing commits it and
      // fast-forwards it into the source — quietly removing a tracked
      // file from the repository, with nothing reporting a loss because
      // from the workspace's side the file was already gone.
      //
      // Seeded from HEAD, those paths are tracked in this index too, so
      // ignore rules stop applying to them exactly as they do in the real
      // one. A file genuinely missing from the working tree still stages
      // as a deletion, which is the behaviour we want to keep.
      const head = await runGit(["rev-parse", "--verify", "HEAD"], sourceCwd, QUERY_TIMEOUT_MS);
      const hasHead = head.ok && head.stdout.trim().length > 0;
      if (hasHead) {
        const seeded = await runGit(["read-tree", "HEAD"], sourceCwd, MUTATE_TIMEOUT_MS, env);
        if (!seeded.ok) {
          throw new Error(`could not seed the snapshot index: ${seeded.stderr.trim()}`);
        }
      }
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
      // commit, which is still a perfectly good snapshot — and is why the
      // seeding above is conditional.
      const args = ["commit-tree", tree.stdout.trim(), "-m", message];
      if (hasHead) {
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
    // --create-reflog, so the ref keeps its previous values. The autosave
    // is rewritten every turn that changed anything, and without a log
    // each new one made its predecessor unreachable: exactly one recovery
    // point, "as of the last turn". With the log, `git reflog <ref>` is a
    // per-turn history, and its entries keep those objects alive.
    //
    // Git will not do this on its own. core.logAllRefUpdates only covers
    // refs/heads, refs/remotes, refs/notes and HEAD by default, so a ref
    // deliberately parked outside refs/heads (to stay out of `git branch`
    // and `git log`) gets no log unless asked. That was an omission
    // rather than a decision.
    await runGit(["update-ref", "--create-reflog", ref, snapshot], repoRoot, QUERY_TIMEOUT_MS);
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
