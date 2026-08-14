// Making a fresh workspace actually usable.
//
// A workspace materializes the project's TRACKED files. Everything a
// real repo needs to build or run is typically not tracked: .env,
// node_modules, .venv, generated configs. So without this step an agent
// in a workspace can read the code and do nothing else, and it fails in
// ways that look like its own mistakes rather than like a missing
// environment.
//
// Two mechanisms, applied in this order:
//
//   1. carry — copy declared files in from the source tree.
//   2. postCreate — run a command in the new workspace (npm ci, etc).
//
// carry runs FIRST so a hook can depend on .env already being present.
// They compose rather than shadow each other, unlike Claude Code's
// arrangement where defining a WorktreeCreate hook silently disables
// .worktreeinclude. Ours is a strictly post-create hook: it never
// replaces workspace creation, so there is nothing for it to displace.
//
// Config comes from the repo, not from a daemon install or a user
// profile, because which files a project needs is a property of the
// project. Committing `.hydra/worktree.json` means every client and
// every contributor gets the same setup.

import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readJsonSafe } from "../json-store.js";

export interface WorkspaceRepoConfig {
  /** Gitignored-but-required files to copy in from the source tree. */
  carry?: string[];
  /** Command run once in the new workspace, after carry. */
  postCreate?: string;
  /** Command run before a workspace is removed (drop databases, etc). */
  preRemove?: string;
  /** Seconds before a hook is killed. Defaults to 120. */
  hookTimeoutSeconds?: number;
}

const CONFIG_PATH = ".hydra/worktree.json";
const WORKTREEINCLUDE = ".worktreeinclude";
const DEFAULT_HOOK_TIMEOUT_S = 120;

/**
 * Read the repo's workspace config, unioning ours with Claude Code's
 * `.worktreeinclude`.
 *
 * Union rather than override: both express "this gitignored file is
 * needed", and there is no reading under which having one means ignoring
 * the other. Adopting `.worktreeinclude` means a repo already set up for
 * `claude --worktree` needs no second config to work here.
 *
 * We read foreign DECLARATIONS but never execute foreign hook commands.
 * Copying a listed file is inert; running another tool's `postCreate`
 * (createdb, bun install, prisma push) because its config happens to be
 * in the repo would be executing commands with no user intent behind
 * them in this context.
 */
export async function readWorkspaceRepoConfig(
  sourceCwd: string,
): Promise<WorkspaceRepoConfig> {
  const own =
    (await readJsonSafe<WorkspaceRepoConfig>(path.join(sourceCwd, CONFIG_PATH))) ?? {};
  const carry = new Set<string>(Array.isArray(own.carry) ? own.carry : []);

  const foreign = await fs
    .readFile(path.join(sourceCwd, WORKTREEINCLUDE), "utf8")
    .catch(() => undefined);
  if (foreign !== undefined) {
    for (const raw of foreign.split("\n")) {
      const line = raw.trim();
      // `.worktreeinclude` uses gitignore syntax. We support the literal
      // subset (a path per line, # comments) and skip pattern lines
      // rather than half-implementing globbing: a silently mis-expanded
      // pattern is worse than an honestly ignored one.
      if (line.length === 0 || line.startsWith("#")) {
        continue;
      }
      if (line.startsWith("!") || line.includes("*") || line.includes("?")) {
        continue;
      }
      carry.add(line);
    }
  }

  const out: WorkspaceRepoConfig = {};
  if (carry.size > 0) {
    out.carry = [...carry];
  }
  if (typeof own.postCreate === "string") {
    out.postCreate = own.postCreate;
  }
  if (typeof own.preRemove === "string") {
    out.preRemove = own.preRemove;
  }
  if (typeof own.hookTimeoutSeconds === "number") {
    out.hookTimeoutSeconds = own.hookTimeoutSeconds;
  }
  return out;
}

export interface CarryResult {
  copied: string[];
  skipped: string[];
}

/**
 * Copy declared files from the source tree into the workspace.
 *
 * Only copies a file that is ABSENT from the workspace, which quietly
 * implements the rule `.worktreeinclude` states explicitly ("only files
 * that are also gitignored are copied"), without needing to ask git
 * anything: a tracked file is already in the checkout, so it is present
 * and gets skipped, while an ignored file is absent and gets copied.
 * That also makes the behavior identical for a provider with no concept
 * of ignoring, and it means carry can never clobber a materialized file
 * with a stale copy.
 *
 * Refuses to escape either tree. A carry entry is repo config, and repo
 * config can come from a branch someone else wrote.
 */
export async function applyCarry(
  sourceCwd: string,
  workspacePath: string,
  entries: readonly string[],
): Promise<CarryResult> {
  const copied: string[] = [];
  const skipped: string[] = [];
  const srcRoot = path.resolve(sourceCwd);
  const dstRoot = path.resolve(workspacePath);

  for (const entry of entries) {
    const from = path.resolve(srcRoot, entry);
    const to = path.resolve(dstRoot, entry);
    if (!from.startsWith(srcRoot + path.sep) || !to.startsWith(dstRoot + path.sep)) {
      skipped.push(entry);
      continue;
    }
    // Present already means the checkout materialized it: leave it be.
    const exists = await fs
      .access(to)
      .then(() => true)
      .catch(() => false);
    if (exists) {
      skipped.push(entry);
      continue;
    }
    const stat = await fs.stat(from).catch(() => undefined);
    if (stat === undefined) {
      skipped.push(entry);
      continue;
    }
    try {
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.cp(from, to, { recursive: stat.isDirectory() });
      copied.push(entry);
    } catch {
      skipped.push(entry);
    }
  }
  return { copied, skipped };
}

export interface HookResult {
  ok: boolean;
  reason?: string;
}

/**
 * Run a repo-declared hook inside the workspace.
 *
 * Receives the same values as JSON on stdin and as environment
 * variables, so a trivial hook needs no JSON parsing and a complex one
 * is not limited to env. Failure is reported, never thrown: a broken
 * setup command must not take the session down with it, since a session
 * in a half-set-up workspace is still more useful than no session.
 */
export async function runWorkspaceHook(
  command: string,
  ctx: {
    workspacePath: string;
    sourceCwd: string;
    label: string;
    sessionId?: string;
    timeoutSeconds?: number;
  },
): Promise<HookResult> {
  const payload = JSON.stringify({
    path: ctx.workspacePath,
    sourceCwd: ctx.sourceCwd,
    label: ctx.label,
    ...(ctx.sessionId !== undefined ? { sessionId: ctx.sessionId } : {}),
  });
  const timeout = (ctx.timeoutSeconds ?? DEFAULT_HOOK_TIMEOUT_S) * 1_000;

  return new Promise<HookResult>((resolve) => {
    const child = execFile(
      "/bin/sh",
      ["-c", command],
      {
        cwd: ctx.workspacePath,
        timeout,
        maxBuffer: 8 * 1024 * 1024,
        env: {
          ...process.env,
          HYDRA_WORKSPACE_PATH: ctx.workspacePath,
          HYDRA_SOURCE_CWD: ctx.sourceCwd,
          HYDRA_WORKSPACE_LABEL: ctx.label,
          ...(ctx.sessionId !== undefined ? { HYDRA_SESSION_ID: ctx.sessionId } : {}),
        },
      },
      (err, _stdout, stderr) => {
        if (err) {
          const detail = (stderr || err.message || "").trim().slice(0, 500);
          resolve({ ok: false, reason: detail.length > 0 ? detail : "hook failed" });
          return;
        }
        resolve({ ok: true });
      },
    );
    child.stdin?.end(payload);
  });
}
