// Carrying work that lives inside a nested tree (a git submodule).
//
// The superproject's working-state snapshot cannot express this, and the
// failure is silent, which is why this module exists rather than a few
// extra flags on the existing carry path. Three verified facts drive
// every decision below (git 2.43):
//
//   1. `git add -A` in a superproject records a submodule as a GITLINK,
//      never as content. A submodule with uncommitted changes therefore
//      produces an EMPTY superproject diff, so the work is invisible to
//      the snapshot. Meanwhile `git status --porcelain` DOES report the
//      submodule as ` M <path>`, so it appears in the carried-path count.
//      Together those two make the reply claim work was carried that was
//      not.
//
//   2. `git apply` of a gitlink hunk exits 0 and does nothing useful: the
//      submodule's HEAD stays where it was, and apply attempts an rmdir
//      of the submodule directory on the way past. So a gitlink move
//      cannot be carried by patching the superproject, and including one
//      in that patch risks deleting an unpopulated submodule directory.
//      The superproject patch is built with --ignore-submodules=all for
//      this reason; everything about submodules happens here instead.
//
//   3. A worktree's submodules get their OWN git dir, under
//      `.git/worktrees/<wt>/modules/<name>`, cloned from the configured
//      URL. Objects are therefore NOT shared with the source's submodule.
//      A commit that exists only locally in the source's submodule is
//      unreachable from the workspace's copy, so aligning the two needs
//      an explicit fetch rather than a checkout.
//
// The shape that follows from those: read each submodule's state from the
// source, align the workspace's copy to the same commit (fetching from
// the source's submodule by path when the commit is local-only), then
// replay uncommitted work as a patch applied INSIDE the submodule, where
// a patch means what it says.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const QUERY_TIMEOUT_MS = 10_000;
const MUTATE_TIMEOUT_MS = 300_000;

function runGit(
  args: string[],
  cwd: string,
  timeout = QUERY_TIMEOUT_MS,
  extraEnv?: Record<string, string>,
): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      {
        cwd,
        timeout,
        maxBuffer: 64 * 1024 * 1024,
        ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}),
      },
      (err, stdout, stderr) => {
        resolve({ ok: !err, out: stdout ?? "", err: stderr ?? "" });
      },
    );
  });
}

function applyPatch(cwd: string, patch: string, extra: string[] = []): Promise<boolean> {
  return new Promise((resolve) => {
    const child = execFile(
      "git",
      ["apply", ...extra],
      { cwd, timeout: MUTATE_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
      (err) => resolve(!err),
    );
    child.stdin?.end(patch);
  });
}

/**
 * Whether a nested path stays inside the tree that declared it.
 *
 * A submodule path comes from `.gitmodules`, which is a tracked file and
 * so can arrive on a branch someone else wrote. Every path here is joined
 * onto both a source root and a workspace root and then handed to git with
 * a cwd, so one that climbs out would operate on a directory neither tree
 * owns. Modern git validates these itself, which makes this
 * defence-in-depth rather than the only guard, but it is the same check
 * applyCarry makes on the same class of input and for the same reason.
 *
 * Checked at the single point where these paths enter the module, so
 * nothing downstream has to remember to.
 */
function containedIn(root: string, relPath: string): boolean {
  if (path.isAbsolute(relPath)) {
    return false;
  }
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relPath);
  return target !== resolvedRoot && target.startsWith(resolvedRoot + path.sep);
}

/** One nested tree, as the source tree currently has it. */
export interface NestedState {
  /** Path relative to the superproject root. Always POSIX-style, as git prints it. */
  readonly relPath: string;
  /** Commit the source's copy is checked out at. */
  readonly head: string;
  /** Commit the superproject's HEAD records for it. Differs when advanced locally. */
  readonly gitlink: string;
  /** Paths changed inside it, relative to the nested tree. */
  readonly changedPaths: readonly string[];
}

/**
 * What has to be reproduced in the workspace for one nested tree.
 *
 * `head` is carried even when nothing is dirty, because a submodule the
 * user advanced (committed inside, not yet reflected in a superproject
 * commit) is uncommitted work in exactly the sense that matters: it is
 * present in their tree and absent from HEAD.
 */
export interface NestedCarry extends NestedState {
  /** Patch of the nested tree's uncommitted work, against its own HEAD. */
  readonly patch?: string;
}

/**
 * Enumerate the source's nested trees and how each one stands.
 *
 * Skips ones the SOURCE has not initialized: an empty directory there is
 * not work, and the workspace will populate its own copy from the
 * recorded gitlink anyway.
 *
 * Returns an empty list for a repo without submodules, so callers need no
 * separate probe.
 */
export async function enumerateNested(root: string): Promise<NestedState[]> {
  // --recursive so a submodule inside a submodule is included; git prints
  // those with their full path from the top level, which is exactly the
  // path the workspace side needs to resolve against.
  const listed = await runGit(["submodule", "status", "--recursive"], root);
  if (!listed.ok) {
    return [];
  }
  const out: NestedState[] = [];
  for (const rawLine of listed.out.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.trim().length === 0) {
      continue;
    }
    // Format: "<flag><sha> <path> (<describe>)", where flag is one of
    // ' ' (in sync), '+' (checked out commit differs from the gitlink),
    // '-' (not initialized), 'U' (merge conflicts inside).
    const flag = line[0] ?? " ";
    if (flag === "-") {
      continue;
    }
    const body = flag === " " ? line.slice(1) : line.slice(1);
    const sp = body.indexOf(" ");
    if (sp <= 0) {
      continue;
    }
    const relPath = body.slice(sp + 1).replace(/\s+\(.*\)\s*$/, "").trim();
    if (relPath.length === 0 || !containedIn(root, relPath)) {
      continue;
    }
    const nestedRoot = path.join(root, relPath);
    const [head, gitlink, status] = await Promise.all([
      runGit(["rev-parse", "HEAD"], nestedRoot),
      // The gitlink as the SUPERPROJECT's HEAD records it, which is what
      // the workspace will materialize. `rev-parse HEAD:<path>` on a
      // gitlink yields the recorded commit.
      runGit(["rev-parse", `HEAD:${relPath}`], root),
      runGit(["status", "--porcelain", "--untracked-files=all"], nestedRoot),
    ]);
    if (!head.ok || head.out.trim().length === 0) {
      continue;
    }
    const changedPaths = status.ok
      ? status.out
          .split("\n")
          .map((l) => l.replace(/\r$/, ""))
          .filter((l) => l.length >= 4)
          .map((l) => {
            const p = l.slice(3);
            const arrow = p.indexOf(" -> ");
            return arrow === -1 ? p : p.slice(arrow + 4);
          })
      : [];
    out.push({
      relPath,
      head: head.out.trim(),
      gitlink: gitlink.ok ? gitlink.out.trim() : "",
      changedPaths,
    });
  }
  return out;
}

/** True when this nested tree holds anything the workspace would not get for free. */
export function nestedHasWork(state: NestedState): boolean {
  return state.changedPaths.length > 0 || (state.gitlink !== "" && state.head !== state.gitlink);
}

/**
 * Snapshot each nested tree's uncommitted work, without touching it.
 *
 * Same throwaway-index technique as the superproject's
 * captureWorkingState, and for the same reason: `stash` would yank the
 * user's work out of a tree they are looking at, and `stash create` omits
 * untracked files, which is where fresh work lives.
 *
 * The snapshot is not retained under a ref here. The patch is what gets
 * carried, and a patch is self-contained (--binary embeds blob data), so
 * the workspace never needs to reach the source's objects for it. Callers
 * that want the source's pre-carry nested state to survive gc should
 * retain it themselves; see retainNestedAnchor.
 */
export async function captureNested(
  root: string,
  states: readonly NestedState[],
): Promise<NestedCarry[]> {
  const out: NestedCarry[] = [];
  for (const state of states) {
    if (!nestedHasWork(state)) {
      continue;
    }
    if (state.changedPaths.length === 0) {
      // Advanced but clean: the commit is the whole of the work.
      out.push(state);
      continue;
    }
    const nestedRoot = path.join(root, state.relPath);
    const patch = await patchWorkingState(nestedRoot);
    out.push(patch === undefined ? state : { ...state, patch });
  }
  return out;
}

/**
 * A tree's uncommitted state as a patch against its own HEAD.
 *
 * Seeded from HEAD before staging, for the same reason the superproject's
 * capture is: an empty index makes git treat nothing as tracked and apply
 * ignore rules to every path, so a file that is both committed and
 * gitignore-matched drops out of the tree and reads as a DELETION. Seeded,
 * those paths are tracked here too and the rules stop applying to them.
 */
async function patchWorkingState(nestedRoot: string): Promise<string | undefined> {
  // Outside the tree being staged. An index file placed inside it would
  // be picked up by `add -A` and land in the snapshot as an untracked
  // file, which then gets carried into the workspace.
  const tmpIndex = path.join(
    os.tmpdir(),
    `hydra-nested-index-${process.pid}-${randomBytes(6).toString("hex")}`,
  );
  const env = { GIT_INDEX_FILE: tmpIndex };
  try {
    const head = await runGit(["rev-parse", "--verify", "HEAD"], nestedRoot);
    if (!head.ok || head.out.trim().length === 0) {
      return undefined;
    }
    const seeded = await runGit(["read-tree", "HEAD"], nestedRoot, MUTATE_TIMEOUT_MS, env);
    if (!seeded.ok) {
      return undefined;
    }
    const staged = await runGit(["add", "-A"], nestedRoot, MUTATE_TIMEOUT_MS, env);
    if (!staged.ok) {
      return undefined;
    }
    const tree = await runGit(["write-tree"], nestedRoot, MUTATE_TIMEOUT_MS, env);
    if (!tree.ok || tree.out.trim().length === 0) {
      return undefined;
    }
    const commit = await runGit(
      ["commit-tree", tree.out.trim(), "-m", "hydra: nested work carried into workspace", "-p", head.out.trim()],
      nestedRoot,
      MUTATE_TIMEOUT_MS,
      env,
    );
    if (!commit.ok || commit.out.trim().length === 0) {
      return undefined;
    }
    const patch = await runGit(
      ["diff", "--binary", head.out.trim(), commit.out.trim()],
      nestedRoot,
      MUTATE_TIMEOUT_MS,
    );
    if (!patch.ok || patch.out.trim().length === 0) {
      return undefined;
    }
    return patch.out;
  } finally {
    await fs.rm(tmpIndex, { force: true }).catch(() => undefined);
  }
}

export interface NestedApplyResult {
  /** Nested paths reproduced in full. */
  readonly applied: readonly string[];
  /** Nested paths where something could not be reproduced, with the reason. */
  readonly failed: readonly { path: string; reason: string }[];
}

/**
 * Reproduce carried nested work inside a workspace.
 *
 * Runs AFTER the workspace's nested trees have been populated, because it
 * moves each one from the commit the workspace materialized to the commit
 * the source has, then replays the working tree on top.
 *
 * Alignment before replay is not optional: the patch was produced against
 * the SOURCE's nested HEAD, so applying it to a copy sitting on a
 * different commit fails on context. That was the observed failure before
 * this existed.
 */
export async function applyNestedCarry(
  workspacePath: string,
  sourceRoot: string,
  carries: readonly NestedCarry[],
): Promise<NestedApplyResult> {
  const applied: string[] = [];
  const failed: { path: string; reason: string }[] = [];

  for (const carry of carries) {
    const wsNested = path.join(workspacePath, carry.relPath);
    const srcNested = path.join(sourceRoot, carry.relPath);

    // Align to the source's commit when it differs from what the
    // workspace materialized.
    const at = await runGit(["rev-parse", "HEAD"], wsNested);
    if (!at.ok) {
      failed.push({ path: carry.relPath, reason: "not initialized in the workspace" });
      continue;
    }
    if (at.out.trim() !== carry.head) {
      // Objects live in separate stores (see the header), so a commit the
      // user only has locally is missing here. Fetch it from the source's
      // own copy by path, which is cheap and needs no network.
      const reachable = await runGit(["cat-file", "-e", `${carry.head}^{commit}`], wsNested);
      if (!reachable.ok) {
        const fetched = await runGit(
          ["fetch", "--no-tags", srcNested, carry.head],
          wsNested,
          MUTATE_TIMEOUT_MS,
        );
        if (!fetched.ok) {
          failed.push({
            path: carry.relPath,
            reason: `could not fetch ${carry.head.slice(0, 8)} from the source copy`,
          });
          continue;
        }
      }
      const moved = await runGit(
        ["checkout", "--detach", carry.head],
        wsNested,
        MUTATE_TIMEOUT_MS,
      );
      if (!moved.ok) {
        failed.push({
          path: carry.relPath,
          reason: `could not check out ${carry.head.slice(0, 8)}`,
        });
        continue;
      }
    }

    if (carry.patch !== undefined) {
      // Without --index, matching the superproject's carry: modifications
      // land unstaged and new files untracked, so the agent's first bare
      // commit inside the submodule cannot sweep up the user's work.
      if (!(await applyPatch(wsNested, carry.patch))) {
        failed.push({ path: carry.relPath, reason: "uncommitted changes did not apply" });
        continue;
      }
    }
    applied.push(carry.relPath);
  }

  return { applied, failed };
}

export interface NestedLandResult {
  /** Nested paths brought into line with what was landed. */
  readonly landed: readonly string[];
  /** Nested paths deliberately left alone, with why. */
  readonly skipped: readonly { path: string; reason: string }[];
}

/**
 * Bring the SOURCE's nested trees into line after a landing.
 *
 * Necessary because the superproject's fast-forward moves each gitlink
 * without touching the corresponding working tree, so a landing that
 * bumped a submodule leaves the source reporting that submodule as
 * modified, sitting on the old commit, and possibly without the objects
 * for the new one (separate object stores; see the header). None of that
 * is visible in the superproject's own status beyond a bare ` M sub`.
 *
 * Two jobs, in this order:
 *
 *   1. Check out the gitlink the merge just recorded, fetching it from the
 *      workspace's copy when the source cannot reach it.
 *   2. Replay the workspace's own UNCOMMITTED nested work on top, which
 *      the superproject's pending-work capture could not express.
 *
 * Refuses to touch a nested tree that has uncommitted changes of its own.
 * That is the genuine overlap case, and there is no safe automatic answer:
 * the superproject's three-way ladder cannot see inside a gitlink, so
 * nothing here can tell a conflicting edit from a compatible one. Skipped
 * rather than forced, and named in the result so the caller can say what
 * was left undone.
 */
export async function landNested(
  sourceRoot: string,
  workspacePath: string,
  carries: readonly NestedCarry[],
): Promise<NestedLandResult> {
  const landed: string[] = [];
  const skipped: { path: string; reason: string }[] = [];
  const carryByPath = new Map(carries.map((c) => [c.relPath, c]));

  // Post-merge state of the source, so `gitlink` is what the landing put
  // there rather than what was there before it.
  const states = await enumerateNested(sourceRoot);
  const paths = new Set([...states.map((s) => s.relPath), ...carryByPath.keys()]);

  for (const relPath of [...paths].sort()) {
    const state = states.find((s) => s.relPath === relPath);
    const carry = carryByPath.get(relPath);
    const srcNested = path.join(sourceRoot, relPath);
    const wsNested = path.join(workspacePath, relPath);

    // The workspace has work in a nested tree the source has not
    // initialized. Populating it here would be a side effect nobody asked
    // a landing to perform, so it is reported instead.
    if (state === undefined) {
      skipped.push({ path: relPath, reason: "not initialized in the source tree" });
      continue;
    }

    const needsCheckout = state.gitlink !== "" && state.head !== state.gitlink;
    const needsReplay = carry?.patch !== undefined;
    if (!needsCheckout && !needsReplay) {
      continue;
    }

    // The user's own in-flight work inside this submodule. Everything
    // below would overwrite it, so this is where we stop.
    if (state.changedPaths.length > 0) {
      skipped.push({
        path: relPath,
        reason:
          `it has ${state.changedPaths.length} uncommitted change(s) of its own, and nothing ` +
          `can tell those apart from what was landed`,
      });
      continue;
    }

    if (needsCheckout) {
      const reachable = await runGit(["cat-file", "-e", `${state.gitlink}^{commit}`], srcNested);
      if (!reachable.ok) {
        const fetched = await runGit(
          ["fetch", "--no-tags", wsNested, state.gitlink],
          srcNested,
          MUTATE_TIMEOUT_MS,
        );
        if (!fetched.ok) {
          skipped.push({
            path: relPath,
            reason: `the landed commit ${state.gitlink.slice(0, 8)} could not be fetched from the workspace`,
          });
          continue;
        }
      }
      const moved = await runGit(
        ["checkout", "--detach", state.gitlink],
        srcNested,
        MUTATE_TIMEOUT_MS,
      );
      if (!moved.ok) {
        skipped.push({
          path: relPath,
          reason: `could not check out the landed commit ${state.gitlink.slice(0, 8)}`,
        });
        continue;
      }
    }

    if (carry?.patch !== undefined) {
      // Unstaged, like every other replay hydra performs: what the agent
      // left uncommitted comes back uncommitted.
      if (!(await applyPatch(srcNested, carry.patch))) {
        skipped.push({
          path: relPath,
          reason: "the workspace's uncommitted changes there did not apply",
        });
        continue;
      }
    }
    landed.push(relPath);
  }

  return { landed, skipped };
}

/**
 * Prefix nested changed-paths with their nested tree, for reporting.
 *
 * The superproject reports a dirty submodule as the single path `sub`,
 * which counts one file for what may be dozens. Callers that report a
 * carried-file list use this instead so the count matches what actually
 * moved.
 */
export function nestedReportPaths(states: readonly NestedState[]): string[] {
  const out: string[] = [];
  for (const state of states) {
    if (state.changedPaths.length === 0) {
      out.push(`${state.relPath} (submodule advanced to ${state.head.slice(0, 8)})`);
      continue;
    }
    for (const p of state.changedPaths) {
      out.push(`${state.relPath}/${p}`);
    }
  }
  return out;
}

/**
 * Replace the superproject's one-line-per-submodule view with the real
 * per-file detail.
 *
 * The superproject reports a submodule holding thirty edits as the single
 * path `sub`, so a caller counting its changedPaths reports "1 file". Both
 * the carried list and the left-behind list are read to check whether a
 * specific piece of work came along, which that count cannot answer.
 */
export function expandChangedPaths(
  superPaths: readonly string[],
  states: readonly NestedState[],
): string[] {
  const nestedRoots = new Set(states.map((s) => s.relPath));
  const kept = superPaths.filter((p) => !nestedRoots.has(p.replace(/\/$/, "")));
  return [...kept, ...nestedReportPaths(states.filter(nestedHasWork))];
}
