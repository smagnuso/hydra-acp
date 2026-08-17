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
  asStateDelta,
  capLines,
  findFreeLabel,
  nestedHasWork,
  sanitizeLabel,
  workspaceRootFor,
  type Capabilities,
  type CreateWorkspaceOptions,
  type CreateWorkspaceResult,
  type DeltaOutcome,
  type Divergence,
  type IntegrateResult,
  type IsolationProvider,
  type NestedCapture,
  type NestedState,
  type NestedTreesResult,
  type NestedOutcome,
  type PathChange,
  type ResetOutcome,
  type SnapshotId,
  type StateDelta,
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

/** Feed a patch to a git command on stdin. */
function runGitStdin(
  args: string[],
  cwd: string,
  input: string,
  timeout = MUTATE_TIMEOUT_MS,
): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = execFile(
      "git",
      args,
      { cwd, timeout, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({ ok: !err, stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
    // A git that rejects the invocation before reading stdin closes the
    // pipe first, and an unhandled EPIPE on that socket surfaces as a
    // process-level error rather than a failed command. The daemon is
    // long-lived, so it cannot be left to chance.
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(input);
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

  /**
   * Where this workspace's refs and branches live.
   *
   * Not the workspace directory: a worktree's refs are in the repository
   * every worktree of it shares. `repoRoot` is recorded on the workspace
   * when it is created, and falling back to `sourceCwd` is safe because git
   * resolves upward from any directory inside a repository, so a source that
   * is a subdirectory still finds the same refs.
   *
   * The one place that reads `vcs`, which is where a provider reading its
   * own display detail belongs. Nothing outside this file may do it.
   */
  private refRoot(ws: Workspace): string {
    return ws.vcs?.repoRoot ?? ws.sourceCwd;
  }

  /** Lines this provider created, and therefore may discard. */
  ownsLine(line: string): boolean {
    return line.startsWith(`${BRANCH_NAMESPACE}/`);
  }

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
      supports: {
        record: true,
        integrate: true,
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
    const repoRoot = this.refRoot(ws);
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
        line: branch,
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
        // `line` is the handle callers pass back to integrate(); `vcs` is
        // display detail that a second provider need not supply. Both name
        // the branch here, and that duplication is deliberate: it is what
        // lets a caller stop reading `vcs.branch` to decide what to land.
        line: branch,
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

    const repoRoot = this.refRoot(ws);
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
      // The prefix check stays here, where the prefix is defined. A lock we
      // set means a live session; a lock a human set means hands off for a
      // reason we do not know, and the two must not be confused in either
      // direction.
      const heldByUs = entry.lockedReason?.startsWith(HYDRA_LOCK_PREFIX) === true;
      out.push({
        path: entry.path,
        sourceCwd: source,
        label: path.basename(entry.path),
        ...(heldByUs ? { heldByUs: true } : {}),
        provider: this.kind,
        ...(branch !== undefined ? { line: branch } : {}),
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
    const entries = parseStatusPorcelain(st.stdout);
    const changedPaths = entries.map((e) => e.path);
    // Read off the codes already parsed rather than a second `diff --cached`
    // run: the X column is the staged axis, and "??" is untracked so it is
    // neither.
    const hasStagedWork = entries.some(
      ({ code }) => code !== "??" && code[0] !== " " && code[0] !== "?",
    );

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
    return {
      clean: changedPaths.length === 0 && !hasRecordedWork,
      changedPaths,
      hasRecordedWork,
      hasStagedWork,
    };
  }

  async lock(ws: Workspace, reason: string): Promise<void> {
    const repoRoot = this.refRoot(ws);
    await runGit(
      ["worktree", "lock", "--reason", `${HYDRA_LOCK_PREFIX}${reason}`, ws.path],
      repoRoot,
      QUERY_TIMEOUT_MS,
    );
  }

  async unlock(ws: Workspace): Promise<void> {
    const repoRoot = this.refRoot(ws);
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
    const repoRoot = this.refRoot(ws);
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
    const repoRoot = this.refRoot(ws);
    await runGit(["update-ref", "-d", ref], repoRoot, QUERY_TIMEOUT_MS);
  }

  // =====================================================================
  // State inspection.
  //
  // Every one of these was, until recently, a `git` invocation somewhere
  // else in the tree: session-manager, source-state, the workspaces CLI.
  // They are here so that the answer to "which VCS is this" is asked in
  // exactly one file. Each returns undefined rather than throwing on a
  // failed probe, because the callers are decision points that must
  // degrade to silence rather than take a session down.
  // =====================================================================

  async currentState(root: string): Promise<SnapshotId | undefined> {
    const head = await runGit(["rev-parse", "HEAD"], root, QUERY_TIMEOUT_MS);
    const sha = head.stdout.trim();
    return head.ok && sha.length > 0 ? asSnapshotId(sha) : undefined;
  }

  async contentId(root: string, state: SnapshotId): Promise<string | undefined> {
    // The TREE, not the commit. Two different commits can hold identical
    // content, and the callers asking this ("are these two trees the
    // same?") get the wrong answer from a commit comparison.
    const tree = await runGit(["rev-parse", `${state}^{tree}`], root, QUERY_TIMEOUT_MS);
    const id = tree.stdout.trim();
    return tree.ok && id.length > 0 ? id : undefined;
  }

  async currentLineName(root: string): Promise<string | undefined> {
    const named = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], root, QUERY_TIMEOUT_MS);
    const name = named.stdout.trim();
    return named.ok && name.length > 0 ? name : undefined;
  }

  async resolveRoot(somePath: string): Promise<string | undefined> {
    const top = await runGit(["rev-parse", "--show-toplevel"], somePath, QUERY_TIMEOUT_MS);
    const root = top.stdout.trim();
    return top.ok && root.length > 0 ? root : undefined;
  }

  async resolveRetained(ws: Workspace, ref: string): Promise<SnapshotId | undefined> {
    const found = await runGit(
      ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
      this.refRoot(ws),
      QUERY_TIMEOUT_MS,
    );
    const sha = found.stdout.trim();
    return found.ok && sha.length > 0 ? asSnapshotId(sha) : undefined;
  }

  async contains(root: string, opts: { state: string; within: string }): Promise<boolean> {
    const res = await runGit(
      ["merge-base", "--is-ancestor", opts.state, opts.within],
      root,
      QUERY_TIMEOUT_MS,
    );
    return res.ok;
  }

  async divergence(root: string, from: string, to: string): Promise<Divergence | undefined> {
    // One walk for both counts. Left is `from`'s side, so left is what
    // `to` is missing, which is `from`'s ahead-ness.
    const counted = await runGit(
      ["rev-list", "--left-right", "--count", `${from}...${to}`],
      root,
      QUERY_TIMEOUT_MS,
    );
    if (!counted.ok) {
      return undefined;
    }
    const parts = counted.stdout
      .trim()
      .split(/\s+/)
      .map((n) => Number.parseInt(n, 10));
    const ahead = parts[0];
    const behind = parts[1];
    if (
      ahead === undefined ||
      behind === undefined ||
      !Number.isFinite(ahead) ||
      !Number.isFinite(behind)
    ) {
      return undefined;
    }
    return { ahead, behind };
  }

  async changedPathsBetween(
    root: string,
    from: string,
    to: string,
  ): Promise<readonly string[]> {
    const diffed = await runGit(["diff", "--name-only", from, to], root, QUERY_TIMEOUT_MS);
    if (!diffed.ok) {
      return [];
    }
    return diffed.stdout
      .split("\n")
      .map((l) => l.replace(/\r$/, "").trim())
      .filter((l) => l.length > 0);
  }

  // =====================================================================
  // Deltas.
  // =====================================================================

  async captureDelta(
    root: string,
    from: SnapshotId,
    to: SnapshotId,
  ): Promise<StateDelta | undefined> {
    // --binary so a delta over binary content is reproducible rather than
    // a summary line. --ignore-submodules=all because a gitlink hunk is
    // actively harmful here: `git apply` exits 0 on one, leaves the nested
    // tree's state exactly where it was, and attempts an rmdir of its
    // directory on the way past. Nested state travels through the nested
    // methods below instead.
    const patch = await runGit(
      ["diff", "--binary", "--ignore-submodules=all", from, to],
      root,
      MUTATE_TIMEOUT_MS,
    );
    if (!patch.ok) {
      return undefined;
    }
    // An empty delta is a legitimate delta, not a failure: it means the
    // two states agree. Callers must be able to tell that apart from "the
    // capture did not work", so it comes back as a delta that applies as a
    // no-op rather than as undefined.
    return asStateDelta(patch.stdout);
  }

  async applyDelta(
    root: string,
    delta: StateDelta,
    opts?: { stage?: boolean; tolerant?: boolean },
  ): Promise<DeltaOutcome> {
    if (delta.trim().length === 0) {
      return { ok: true, alreadyPresent: true };
    }
    const extra = opts?.stage === true ? ["--index"] : [];
    const plain = await runGitStdin(["apply", ...extra], root, delta);
    if (plain.ok) {
      return { ok: true };
    }
    if (opts?.tolerant !== true) {
      return { ok: false, reason: plain.stderr.trim() || "the change did not apply" };
    }
    // Already-applied is a no-op success, not a conflict: the content
    // arrived by another route, so the delta reverses cleanly against the
    // tree. Probed BEFORE the three-way attempt because --3way leaves
    // conflict markers in the working tree when it fails, and reaching it
    // in the nothing-to-do case would dirty files to answer a question
    // that was already settled. --check writes nothing.
    const reversed = await runGitStdin(["apply", "--reverse", "--check"], root, delta);
    if (reversed.ok) {
      return { ok: true, alreadyPresent: true };
    }
    // Three-way last, and never first: it implies --index, so reaching for
    // it up front hands back a staged tree the caller never had.
    const threeWay = await runGitStdin(["apply", "--3way"], root, delta);
    if (threeWay.ok) {
      return { ok: true };
    }
    return {
      ok: false,
      reason: threeWay.stderr.trim() || "the change overlaps what is already there",
    };
  }

  // =====================================================================
  // Mutation.
  // =====================================================================

  async resetTo(
    root: string,
    state: SnapshotId,
    opts?: { purgeIgnored?: boolean },
  ): Promise<ResetOutcome> {
    const reset = await runGit(["reset", "--hard", state], root, MUTATE_TIMEOUT_MS);
    if (!reset.ok) {
      return { ok: false, reason: reset.stderr.trim() || "could not return to that state" };
    }
    const cleaned = await runGit(
      ["clean", opts?.purgeIgnored === true ? "-ffdx" : "-fd"],
      root,
      MUTATE_TIMEOUT_MS,
    );
    if (!cleaned.ok) {
      return {
        ok: false,
        reason: cleaned.stderr.trim() || "returned to that state but could not remove extra files",
      };
    }
    // Neither of the above reaches inside a nested tree, so a caller that
    // stopped here would leave exactly the mess it asked to remove.
    const nested = await this.materializeNested(
      { path: root, sourceCwd: root, label: "", provider: this.kind },
      { discardLocal: true, ...(opts?.purgeIgnored === true ? { purgeIgnored: true } : {}) },
    );
    if (!nested.ok) {
      return { ok: false, reason: nested.reason ?? "could not reset nested trees" };
    }
    return { ok: true };
  }

  async integrationInProgress(root: string): Promise<boolean> {
    const found = await runGit(
      ["rev-parse", "-q", "--verify", "MERGE_HEAD"],
      root,
      QUERY_TIMEOUT_MS,
    );
    return found.ok;
  }

  async abortIntegration(root: string): Promise<void> {
    await runGit(["merge", "--abort"], root, MUTATE_TIMEOUT_MS);
  }

  async conflictedPaths(root: string): Promise<readonly string[]> {
    const listed = await runGit(
      ["diff", "--name-only", "--diff-filter=U"],
      root,
      QUERY_TIMEOUT_MS,
    );
    if (!listed.ok) {
      return [];
    }
    return listed.stdout
      .split("\n")
      .map((l) => l.replace(/\r$/, "").trim())
      .filter((l) => l.length > 0);
  }

  // `async` is deliberate on every stub below. A method declared
  // Promise-returning that throws SYNCHRONOUSLY cannot be caught with
  // .catch() on its return value, so a caller doing
  // `provider.record(...).catch(fallback)` gets an uncaught exception
  // instead of its fallback. Rejecting keeps the contract honest.

  /**
   * Record the workspace's current contents as a new state on its line.
   *
   * Stages everything first, including untracked files, because the caller
   * asking for this wants the tree preserved rather than the subset git
   * happens to already track: an agent's new source files are exactly the
   * content at risk otherwise.
   *
   * Returns the existing state unchanged when there is nothing to record,
   * rather than creating an empty one. A caller landing work needs a state
   * to point at either way, and an empty commit would put a message in the
   * user's history describing something that did not happen.
   */
  async record(ws: Workspace, message: string): Promise<SnapshotId> {
    const staged = await runGit(["add", "-A"], ws.path, MUTATE_TIMEOUT_MS);
    if (!staged.ok) {
      throw new Error(`could not stage ${ws.path}: ${staged.stderr.trim() || "unknown error"}`);
    }
    const status = await this.status(ws);
    const before = await this.currentState(ws.path);
    if (status.changedPaths.length === 0) {
      if (before === undefined) {
        throw new Error(`could not read the state of ${ws.path}`);
      }
      return before;
    }
    const committed = await runGit(["commit", "-m", message], ws.path, MUTATE_TIMEOUT_MS);
    if (!committed.ok) {
      throw new Error(
        `could not record ${ws.path}: ${committed.stderr.trim() || committed.stdout.trim() || "unknown error"}`,
      );
    }
    const after = await this.currentState(ws.path);
    if (after === undefined) {
      throw new Error(`recorded ${ws.path} but could not read the resulting state`);
    }
    return after;
  }

  /**
   * A worktree names its parent repository in its `.git` file, so an
   * orphaned one is not anonymous even when its record is gone.
   *
   * `--git-common-dir` rather than `--git-dir`: for a worktree the latter
   * points at the per-worktree subdirectory, and only the common one leads
   * back to the repository they all share.
   */
  async attributeOrphan(dir: string): Promise<Workspace | undefined> {
    const common = await runGit(
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      dir,
      QUERY_TIMEOUT_MS,
    );
    const gitDir = common.stdout.trim();
    if (!common.ok || gitDir.length === 0) {
      return undefined;
    }
    const repoRoot = path.dirname(gitDir);
    const branch = await this.currentLineName(dir);
    return {
      path: dir,
      sourceCwd: repoRoot,
      label: path.basename(dir),
      provider: this.kind,
      ...(branch !== undefined ? { line: branch } : {}),
      vcs: { repoRoot, ...(branch !== undefined ? { branch } : {}) },
    };
  }

  async discardLine(
    ws: Workspace,
    line: string,
  ): Promise<{ ok: boolean; dropped: number; reason?: string }> {
    const root = this.refRoot(ws);
    // Counted against the tree the line would land into, so the number is
    // "what would be lost" rather than the line's total length.
    const spread = await this.divergence(root, "HEAD", line);
    const dropped = spread?.behind ?? 0;
    // -D rather than -d: the caller has already decided, and -d would
    // second-guess that with a refusal it cannot act on.
    const deleted = await runGit(["branch", "-D", line], root, QUERY_TIMEOUT_MS);
    if (!deleted.ok) {
      return {
        ok: false,
        dropped,
        reason: deleted.stderr.trim() || "could not discard the line",
      };
    }
    return { ok: true, dropped };
  }

  async pruneStale(ws: Workspace): Promise<void> {
    await runGit(["worktree", "prune"], this.refRoot(ws), QUERY_TIMEOUT_MS);
  }

  async changedPaths(): Promise<readonly PathChange[]> {
    throw new WorkspaceUnsupportedError(this.kind, "changedPaths");
  }

  async integrate(opts: {
    into: string;
    from: string;
    fastForwardOnly?: boolean;
    message?: string;
    onConflict?: "abort" | "keep";
  }): Promise<IntegrateResult> {
    const { into, from } = opts;
    const before = await this.currentState(into);
    if (before === undefined) {
      return { ok: false, conflicts: [], declined: true, reason: `cannot read the state of ${into}` };
    }
    // Already contained is success with nothing done, and it has to be
    // detected up front: `merge` would report "Already up to date" as a
    // zero exit, which is right, but the caller needs to know no state
    // changed so it does not report a landing that did not happen.
    if (await this.contains(into, { state: from, within: before })) {
      return { ok: true, snapshot: before, alreadyUpToDate: true };
    }
    if (opts.fastForwardOnly === true) {
      const canFf = await this.contains(into, { state: before, within: from });
      if (!canFf) {
        return {
          ok: false,
          conflicts: [],
          declined: true,
          reason: `${into} cannot simply advance to that state; it has moved on independently`,
        };
      }
    }

    const args = opts.fastForwardOnly === true
      ? ["merge", "--ff-only", from]
      : ["merge", "--no-edit", "-m", opts.message ?? "hydra: integrate", from];
    const merged = await runGit(args, into, MUTATE_TIMEOUT_MS);
    if (merged.ok) {
      const after = await this.currentState(into);
      return after === undefined
        ? { ok: false, conflicts: [], reason: "integrated but could not read the resulting state" }
        : { ok: true, snapshot: after };
    }

    // Name the conflicting paths BEFORE deciding what to do with the
    // half-finished merge: aborting erases the evidence, and "these two
    // disagree" is the whole content of a useful report.
    const conflicts = await this.conflictedPaths(into);
    // Two failures wear one exit code, and they need opposite handling. A
    // merge that STARTED and could not reconcile leaves unmerged entries
    // and a MERGE_HEAD. One git DECLINED to start leaves neither, nothing
    // happened, and the reason is in its stderr rather than in a file list.
    // Told apart on both signals rather than on the file list alone,
    // because a merge already in progress from an earlier attempt also
    // refuses, and calling that one "nothing happened" is just as wrong.
    const inProgress = await this.integrationInProgress(into);
    if (conflicts.length === 0 && !inProgress) {
      return {
        ok: false,
        conflicts: [],
        declined: true,
        reason: merged.stderr.trim() || "the integration was refused",
      };
    }
    if (opts.onConflict === "abort") {
      await this.abortIntegration(into);
    }
    return { ok: false, conflicts };
  }

  // =====================================================================
  // Nested trees (submodules).
  //
  // Three verified facts shape all of this, and each one is a silent
  // failure rather than an error if ignored (git 2.43):
  //
  //   1. Staging a containing tree records a nested tree as a POINTER, not
  //      as content. Uncommitted work inside one is therefore invisible to
  //      the container's own snapshot, while still showing in its status as
  //      a single modified path. That combination is what let a carry
  //      report success over work it had not moved.
  //   2. Reproducing a pointer change as part of the container's delta does
  //      nothing useful and risks removing the nested directory outright,
  //      which is why captureDelta excludes them.
  //   3. Nested trees do NOT share storage between materializations of one
  //      project. A state that exists only in the source's copy is
  //      unreachable from a workspace's, so alignment needs a transfer
  //      rather than a checkout. This is why reproduceNested takes the
  //      materialization the captures came from.
  // =====================================================================

  async listNested(root: string): Promise<readonly NestedState[]> {
    // --recursive so a nested tree inside a nested tree is included; git
    // prints those with their full path from the top, which is the path
    // the receiving side needs to resolve against.
    const listed = await runGit(["submodule", "status", "--recursive"], root, MUTATE_TIMEOUT_MS);
    if (!listed.ok) {
      return [];
    }
    const out: NestedState[] = [];
    for (const rawLine of listed.stdout.split("\n")) {
      const line = rawLine.replace(/\r$/, "");
      if (line.trim().length === 0) {
        continue;
      }
      // "<flag><sha> <path> (<describe>)", flag being ' ' (in sync), '+'
      // (checked out state differs from what the container records), '-'
      // (not populated) or 'U' (conflicts inside).
      const flag = line[0] ?? " ";
      if (flag === "-") {
        continue;
      }
      const body = line.slice(1);
      const sp = body.indexOf(" ");
      if (sp <= 0) {
        continue;
      }
      const relPath = body
        .slice(sp + 1)
        .replace(/\s+\(.*\)\s*$/, "")
        .trim();
      if (relPath.length === 0 || !containedIn(root, relPath)) {
        continue;
      }
      const nestedRoot = path.join(root, relPath);
      const [actual, recorded, status] = await Promise.all([
        this.currentState(nestedRoot),
        runGit(["rev-parse", `HEAD:${relPath}`], root, QUERY_TIMEOUT_MS),
        runGit(
          ["status", "--porcelain", "--untracked-files=all"],
          nestedRoot,
          QUERY_TIMEOUT_MS,
        ),
      ]);
      if (actual === undefined) {
        continue;
      }
      const recordedSha = recorded.ok ? recorded.stdout.trim() : "";
      out.push({
        relPath,
        actual,
        ...(recordedSha.length > 0 ? { recorded: asSnapshotId(recordedSha) } : {}),
        changedPaths: status.ok ? parseStatusPorcelain(status.stdout).map((e) => e.path) : [],
      });
    }
    return out;
  }

  async captureNested(
    root: string,
    states: readonly NestedState[],
  ): Promise<readonly NestedCapture[]> {
    const out: NestedCapture[] = [];
    for (const state of states) {
      if (!nestedHasWork(state)) {
        continue;
      }
      if (state.changedPaths.length === 0) {
        // Advanced but otherwise clean: the state itself is the whole of
        // the work, and there is nothing loose to reproduce.
        out.push(state);
        continue;
      }
      const nestedRoot = path.join(root, state.relPath);
      const snapshot = await this.captureWorkingState(
        nestedRoot,
        "hydra: nested work carried into workspace",
      ).catch(() => undefined);
      if (snapshot === undefined) {
        out.push(state);
        continue;
      }
      const delta = await this.captureDelta(nestedRoot, state.actual, snapshot);
      out.push(delta === undefined ? state : { ...state, delta });
    }
    return out;
  }

  async reproduceNested(
    root: string,
    from: string,
    captures: readonly NestedCapture[],
  ): Promise<NestedOutcome> {
    const applied: string[] = [];
    const failed: { path: string; reason: string }[] = [];
    for (const capture of captures) {
      const here = path.join(root, capture.relPath);
      const there = path.join(from, capture.relPath);
      const aligned = await this.alignNested(here, there, capture.actual);
      if (aligned !== undefined) {
        failed.push({ path: capture.relPath, reason: aligned });
        continue;
      }
      if (capture.delta !== undefined) {
        // Unstaged, matching the container's own carry: what the user left
        // loose comes back loose, so the agent's first bare record inside
        // the nested tree cannot sweep it up.
        const out = await this.applyDelta(here, capture.delta);
        if (!out.ok) {
          failed.push({ path: capture.relPath, reason: out.reason ?? "changes did not apply" });
          continue;
        }
      }
      applied.push(capture.relPath);
    }
    return { applied, failed };
  }

  async integrateNested(
    root: string,
    from: string,
    captures: readonly NestedCapture[],
  ): Promise<NestedOutcome> {
    const applied: string[] = [];
    const failed: { path: string; reason: string }[] = [];
    const byPath = new Map(captures.map((c) => [c.relPath, c]));
    // Post-integration state, so `recorded` is what the integration put
    // there rather than what was there before it.
    const states = await this.listNested(root);
    const paths = new Set([...states.map((s) => s.relPath), ...byPath.keys()]);

    for (const relPath of [...paths].sort()) {
      const state = states.find((s) => s.relPath === relPath);
      const capture = byPath.get(relPath);
      // Populating one the container has not is a side effect nobody asked
      // an integration to perform.
      if (state === undefined) {
        failed.push({ path: relPath, reason: "not populated in the receiving tree" });
        continue;
      }
      const needsAlign = state.recorded !== undefined && state.recorded !== state.actual;
      const needsReplay = capture?.delta !== undefined;
      if (!needsAlign && !needsReplay) {
        continue;
      }
      // The user's own in-flight work in this nested tree. Everything
      // below would overwrite it, and nothing here can tell a conflicting
      // edit from a compatible one: the container's own reconciliation
      // cannot see inside a pointer. So this is where it stops.
      if (state.changedPaths.length > 0) {
        failed.push({
          path: relPath,
          reason:
            `it has ${state.changedPaths.length} uncommitted change(s) of its own, and nothing ` +
            `can tell those apart from what was integrated`,
        });
        continue;
      }
      const here = path.join(root, relPath);
      const there = path.join(from, relPath);
      if (needsAlign && state.recorded !== undefined) {
        const aligned = await this.alignNested(here, there, state.recorded);
        if (aligned !== undefined) {
          failed.push({ path: relPath, reason: aligned });
          continue;
        }
      }
      if (capture?.delta !== undefined) {
        const out = await this.applyDelta(here, capture.delta);
        if (!out.ok) {
          failed.push({
            path: relPath,
            reason: out.reason ?? "the uncommitted changes there did not apply",
          });
          continue;
        }
      }
      applied.push(relPath);
    }
    return { applied, failed };
  }

  /**
   * Move a nested tree onto `target`, transferring the state in from a
   * peer materialization when it is not reachable locally.
   *
   * Returns undefined on success, or the reason it could not. The transfer
   * is the part that is easy to leave out and impossible to notice: nested
   * trees have separate storage per materialization, so a state the user
   * created in their own copy simply does not exist in the workspace's, and
   * a checkout of it fails with "reference is not a tree".
   */
  private async alignNested(
    here: string,
    peer: string,
    target: SnapshotId,
  ): Promise<string | undefined> {
    const at = await this.currentState(here);
    if (at === undefined) {
      return "not populated here";
    }
    if (at === target) {
      return undefined;
    }
    const reachable = await runGit(
      ["cat-file", "-e", `${target}^{commit}`],
      here,
      QUERY_TIMEOUT_MS,
    );
    if (!reachable.ok) {
      const fetched = await runGit(
        ["fetch", "--no-tags", peer, target],
        here,
        NESTED_TIMEOUT_MS,
      );
      if (!fetched.ok) {
        return `could not transfer ${target.slice(0, 8)} from the other copy`;
      }
    }
    const moved = await runGit(["checkout", "--detach", target], here, MUTATE_TIMEOUT_MS);
    if (!moved.ok) {
      return `could not move to ${target.slice(0, 8)}`;
    }
    return undefined;
  }
}

/**
 * Whether a nested path stays inside the tree that declared it.
 *
 * A nested tree's path comes from tracked project configuration, so it can
 * arrive on a line someone else wrote, and it gets joined onto two
 * different roots before being handed to a subprocess as a cwd. Modern git
 * validates these itself, which makes this defence in depth rather than the
 * only guard, but it is the same check applyCarry makes on the same class
 * of input and for the same reason.
 */
function containedIn(root: string, relPath: string): boolean {
  if (path.isAbsolute(relPath)) {
    return false;
  }
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relPath);
  return target !== resolvedRoot && target.startsWith(resolvedRoot + path.sep);
}
