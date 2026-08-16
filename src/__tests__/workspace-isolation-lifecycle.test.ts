// End-to-end: session/new with an isolated workspace — lifecycle.
//
// Covers the claims the walking skeleton has to make good on:
//   - the AGENT PROCESS is spawned in the workspace, not the source tree
//   - writes there do not reach the user's checkout
//   - the binding survives a daemon restart (record round-trip)
//   - the session is still findable by the tree it came from
// Plus deletion, forking, autosave and the provider hooks.
//
// One of six workspace-isolation-*.test.ts files split out of a single
// 2100-line suite so vitest can spread them across workers; shared
// fixtures live in workspace-isolation-harness.ts. `manager` stays a
// per-file local rather than something the harness hands back, so every
// test body reads exactly as it did before the split.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionManager } from "../core/session-manager.js";
import { extractHydraMeta } from "../acp/types-hydra-meta.js";
import { buildHydraSessionMeta } from "../acp/types-session-list.js";
import {
  drainSnapshots,
  exec,
  makeGitRepo,
  makeIsolationManager,
  makeTempDir,
  registerTempRootCleanup,
} from "./workspace-isolation-harness.js";

// Twenty-odd real git subprocesses per test in places. The config-wide
// 10s was only ever enough because this suite was one file that ran alone
// at the tail of the run, with the whole machine to itself; spread across
// six workers it now contends with the rest of the suite and the slowest
// tests here roughly tripled. Raised per file rather than globally so a
// genuine hang elsewhere still trips the default.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

registerTempRootCleanup();

describe("session isolation end-to-end: lifecycle", () => {
  let manager: SessionManager;
  /** cwd the agent process was actually spawned with. */
  let spawnedCwd: string | undefined;

  // Tests that exercise a daemon restart build a second manager, so this
  // keeps the name the bodies already call.
  function makeManager(): SessionManager {
    return makeIsolationManager((cwd) => {
      spawnedCwd = cwd;
    });
  }

  beforeEach(() => {
    spawnedCwd = undefined;
    manager = makeManager();
  });

  afterEach(async () => {
    await drainSnapshots(manager);
  });

  it("spawns the agent in the workspace, not the source tree", async () => {
    const repo = await makeGitRepo();
    const session = await manager.create({
      agentId: "claude-code",
      cwd: repo,
      workspace: { label: "featureA" },
    });

    expect(session.workspace).toBeDefined();
    expect(session.workspace?.sourceCwd).toBe(repo);
    // The agent's working directory is fixed at exec, so this is the
    // assertion that isolation actually happened rather than merely
    // being recorded.
    expect(spawnedCwd).toBe(session.workspace?.path);
    expect(session.cwd).toBe(session.workspace?.path);
    expect(session.cwd).not.toBe(repo);
    expect(session.cwd.startsWith(repo + path.sep)).toBe(false);
  });

  it("keeps writes out of the user's checkout", async () => {
    const repo = await makeGitRepo();
    const session = await manager.create({
      agentId: "claude-code",
      cwd: repo,
      workspace: { label: "featureB" },
    });

    await fs.writeFile(path.join(session.cwd, "tracked.txt"), "agent edited\n");
    await fs.writeFile(path.join(session.cwd, "agent-new.ts"), "export {};\n");

    expect(await fs.readFile(path.join(repo, "tracked.txt"), "utf8")).toBe("original\n");
    await expect(fs.access(path.join(repo, "agent-new.ts"))).rejects.toThrow();
  });

  it("persists the binding so it survives a daemon restart", async () => {
    const repo = await makeGitRepo();
    const session = await manager.create({
      agentId: "claude-code",
      cwd: repo,
      workspace: { label: "featureC" },
    });
    // create() awaits attachManagerHooks, which writes meta.json, so the
    // record is already on disk. loadFromDisk is what a post-restart
    // resurrect reads.
    const reloaded = await manager.loadFromDisk(session.sessionId);
    expect(reloaded?.workspace?.sourceCwd).toBe(repo);
    // cwd is the workspace, which is what makes a cold resurrect respawn
    // the agent in the right directory with no extra plumbing.
    expect(reloaded?.cwd).toBe(session.workspace?.path);
    expect(reloaded?.workspace?.path).toBe(reloaded?.cwd);
  });

  it("stays findable by the tree it came from", async () => {
    const repo = await makeGitRepo();
    const session = await manager.create({
      agentId: "claude-code",
      cwd: repo,
      workspace: { label: "featureD" },
      interactive: true,
    });

    const byRepo = await manager.list({ cwd: repo, includeNonInteractive: true });
    expect(byRepo.map((e) => e.sessionId)).toContain(session.sessionId);

    // ...and by its own workspace path.
    const byWorkspace = await manager.list({
      cwd: session.cwd,
      includeNonInteractive: true,
    });
    expect(byWorkspace.map((e) => e.sessionId)).toContain(session.sessionId);

    // But an unrelated directory must not match.
    const elsewhere = await manager.list({ cwd: "/nowhere", includeNonInteractive: true });
    expect(elsewhere.map((e) => e.sessionId)).not.toContain(session.sessionId);
  });

  it("resurrects into a rebuilt workspace after the directory is deleted", async () => {
    // An isolated session's recorded cwd is a directory that can be
    // removed out from under it, so this path is routine rather than
    // exotic. Before the recovery ladder existed, a missing cwd fell all
    // the way through to defaultCwd, which resurrected the agent in the
    // user's HOME with a history full of edits it believed it had made
    // to a project.
    const repo = await makeGitRepo();
    const session = await manager.create({
      agentId: "claude-code",
      cwd: repo,
      workspace: { label: "recoverme" },
    });
    const originalPath = session.cwd;

    await exec("git", ["add", "-A"], { cwd: originalPath }).catch(() => undefined);
    await fs.writeFile(path.join(originalPath, "work.txt"), "committed work\n");
    await exec("git", ["add", "-A"], { cwd: originalPath });
    await exec("git", ["commit", "-q", "-m", "agent work"], { cwd: originalPath });

    // Delete the directory outright rather than via `git worktree
    // remove`, because that is the realistic case: a tmp reaper or disk
    // cleanup ignores git's lock entirely. It also leaves a LOCKED stale
    // registry entry behind, which recovery has to clear before it can
    // re-add. (`git worktree remove` would refuse here, correctly: the
    // lock exists precisely to stop concurrent cleanup.)
    await fs.rm(originalPath, { recursive: true, force: true });
    await expect(fs.access(originalPath)).rejects.toThrow();

    // A fresh manager is what a daemon restart looks like: resurrect()
    // returns the in-memory session when one is still registered, so
    // reusing `manager` would never exercise the cold path.
    const restarted = makeManager();
    const reloaded = await restarted.loadFromDisk(session.sessionId);
    expect(reloaded).toBeDefined();
    const revived = await restarted.resurrect(reloaded!);

    expect(revived.cwd).not.toBe(os.homedir());
    expect(revived.workspace?.sourceCwd).toBe(repo);
    // Committed work came back with the branch.
    expect(await fs.readFile(path.join(revived.cwd, "work.txt"), "utf8")).toBe("committed work\n");
  });

  it("resurrects unisolated rather than into HOME when nothing can be recovered", async () => {
    // Copy-provider workspaces retain nothing, so a deleted one is gone.
    // The session must still land somewhere sane, and must stop claiming
    // a workspace binding it no longer has.
    const plain = await makeTempDir("hydra-iso-unrecoverable-");
    await fs.writeFile(path.join(plain, "note.txt"), "hello\n");
    const session = await manager.create({
      agentId: "claude-code",
      cwd: plain,
      workspace: { label: "doomed", provider: "copy" },
    });
    await fs.rm(session.cwd, { recursive: true, force: true });

    const restarted = makeManager();
    const reloaded = await restarted.loadFromDisk(session.sessionId);
    const revived = await restarted.resurrect(reloaded!);

    // A fresh copy workspace from the surviving source is the expected
    // outcome; either way it must not be HOME, and it must not still be
    // pointing at the deleted directory.
    expect(revived.cwd).not.toBe(os.homedir());
    expect(revived.cwd).not.toBe(session.cwd);
    expect(await fs.readFile(path.join(revived.cwd, "note.txt"), "utf8")).toBe("hello\n");
  });

  it("parses an isolation request off the wire shape and projects it back", async () => {
    // The wire contract, end to end: a client sends
    // _meta["hydra-acp"].workspace on session/new, and reads the result
    // back as _meta["hydra-acp"].workspaceInfo. Without extractHydraMeta
    // knowing the field, everything below it is unreachable.
    const repo = await makeGitRepo();
    const hydraMeta = extractHydraMeta({
      "hydra-acp": { workspace: { label: "fromWire" } },
    });
    expect(hydraMeta.workspace).toEqual({ label: "fromWire" });

    const session = await manager.create({
      agentId: "claude-code",
      cwd: repo,
      ...(hydraMeta.workspace !== undefined ? { workspace: hydraMeta.workspace } : {}),
    });

    const meta = buildHydraSessionMeta(manager.liveListEntry(session));
    const info = meta.workspaceInfo as { sourceCwd?: string; path?: string } | undefined;
    expect(info?.sourceCwd).toBe(repo);
    expect(info?.path).toBe(session.cwd);
  });

  it("ignores a malformed isolation request rather than passing junk down", async () => {
    // `required` in particular must never be truthy-by-accident: it is
    // what turns a fail-open into a hard session/new failure.
    expect(extractHydraMeta({ "hydra-acp": { workspace: "nope" } }).workspace).toBeUndefined();
    expect(extractHydraMeta({ "hydra-acp": { workspace: [] } }).workspace).toBeUndefined();
    expect(
      extractHydraMeta({ "hydra-acp": { workspace: { required: "yes", label: 7 } } }).workspace,
    ).toEqual({});
  });

  it("omits workspaceInfo entirely for a non-isolated session", async () => {
    const plain = await makeTempDir("hydra-iso-nometa-");
    const session = await manager.create({ agentId: "claude-code", cwd: plain });
    const meta = buildHydraSessionMeta(manager.liveListEntry(session));
    expect(meta.workspaceInfo).toBeUndefined();
    expect(meta.cwd).toBe(plain);
  });

  it("removes a clean workspace on deletion but keeps its branch", async () => {
    const repo = await makeGitRepo();
    const session = await manager.create({
      agentId: "claude-code",
      cwd: repo,
      workspace: { label: "tidy" },
    });
    const wsPath = session.cwd;
    const branch = session.workspace?.vcs?.branch;
    expect(branch).toBeDefined();

    await fs.writeFile(path.join(wsPath, "done.txt"), "finished\n");
    await exec("git", ["add", "-A"], { cwd: wsPath });
    await exec("git", ["commit", "-q", "-m", "work"], { cwd: wsPath });

    await manager.deleteRecord(session.sessionId);

    await expect(fs.access(wsPath)).rejects.toThrow();
    // The branch is the durable artifact: keeping it is what makes the
    // committed work recoverable after the checkout is gone.
    const branches = await exec("git", ["branch", "--list", branch!], { cwd: repo });
    expect(branches.stdout).toContain(branch!);
  });

  it("keeps a workspace holding uncommitted work rather than destroying it", async () => {
    // Deleting a session must not silently delete files the user may
    // still want. A discoverable leaked directory is recoverable; work
    // deleted on someone's behalf is not.
    const repo = await makeGitRepo();
    const session = await manager.create({
      agentId: "claude-code",
      cwd: repo,
      workspace: { label: "messy" },
    });
    const wsPath = session.cwd;
    await fs.writeFile(path.join(wsPath, "unsaved.txt"), "not committed\n");

    await manager.deleteRecord(session.sessionId);

    expect(await fs.readFile(path.join(wsPath, "unsaved.txt"), "utf8")).toBe("not committed\n");
  });

  it("forks an isolated session into its OWN workspace, carrying in-progress work", async () => {
    const repo = await makeGitRepo();
    const parent = await manager.create({
      agentId: "claude-code",
      cwd: repo,
      workspace: { label: "parent" },
    });
    // Uncommitted and untracked: what "fork this session" should carry.
    await fs.writeFile(path.join(parent.cwd, "tracked.txt"), "parent edit\n");
    await fs.writeFile(path.join(parent.cwd, "wip.ts"), "export {};\n");

    const forked = await manager.forkSession(parent.sessionId, {});
    const record = await manager.loadFromDisk(forked.sessionId);

    // The property that matters most: never the parent's workspace.
    expect(record?.cwd).not.toBe(parent.cwd);
    expect(record?.workspace?.path).not.toBe(parent.workspace?.path);
    // Still isolated, and still attributed to the original project
    // rather than to the parent workspace (which is itself temporary).
    expect(record?.workspace?.sourceCwd).toBe(repo);

    expect(await fs.readFile(path.join(record!.cwd, "tracked.txt"), "utf8")).toBe("parent edit\n");
    expect(await fs.readFile(path.join(record!.cwd, "wip.ts"), "utf8")).toBe("export {};\n");

    // And the fork is independent of the parent from here on.
    await fs.writeFile(path.join(record!.cwd, "wip.ts"), "changed in fork\n");
    expect(await fs.readFile(path.join(parent.cwd, "wip.ts"), "utf8")).toBe("export {};\n");
  });

  it("forks without turning the parent's in-progress work into a commit", async () => {
    // The fork must look like its parent did: same commits, same dirty
    // files. Basing it on a snapshot commit instead would silently
    // convert the parent's WIP into history authored "hydra: ...", and
    // a later merge would land it under that name.
    const repo = await makeGitRepo();
    const parent = await manager.create({
      agentId: "claude-code",
      cwd: repo,
      workspace: { label: "wipparent" },
    });
    // A real commit, then uncommitted work on top.
    await fs.writeFile(path.join(parent.cwd, "committed.txt"), "landed\n");
    await exec("git", ["add", "-A"], { cwd: parent.cwd });
    await exec("git", ["commit", "-q", "-m", "real commit"], { cwd: parent.cwd });
    await fs.writeFile(path.join(parent.cwd, "wip.txt"), "in progress\n");

    const forked = await manager.forkSession(parent.sessionId, {});
    const record = await manager.loadFromDisk(forked.sessionId);
    const forkPath = record!.cwd;

    // The parent's commit came across as a commit...
    expect(await fs.readFile(path.join(forkPath, "committed.txt"), "utf8")).toBe("landed\n");
    // ...and the WIP came across as WIP, not as history.
    expect(await fs.readFile(path.join(forkPath, "wip.txt"), "utf8")).toBe("in progress\n");
    const status = await exec("git", ["status", "--porcelain"], { cwd: forkPath });
    expect(status.stdout).toContain("wip.txt");
    // No hydra-authored commit anywhere in the fork's history.
    const log = await exec("git", ["log", "--format=%s"], { cwd: forkPath });
    expect(log.stdout).not.toMatch(/hydra: fork/);

    // And the parent still has its own copy: fork copies, never moves.
    expect(await fs.readFile(path.join(parent.cwd, "wip.txt"), "utf8")).toBe("in progress\n");
  });

  it("forks a copy-provider session by copying the parent workspace", async () => {
    const plain = await makeTempDir("hydra-iso-forkcopy-");
    await fs.writeFile(path.join(plain, "note.txt"), "original\n");
    const parent = await manager.create({
      agentId: "claude-code",
      cwd: plain,
      workspace: { label: "cparent", provider: "copy" },
    });
    await fs.writeFile(path.join(parent.cwd, "note.txt"), "parent edit\n");

    const forked = await manager.forkSession(parent.sessionId, {});
    const record = await manager.loadFromDisk(forked.sessionId);

    expect(record?.cwd).not.toBe(parent.cwd);
    // contentFrom carried the parent's edit...
    expect(await fs.readFile(path.join(record!.cwd, "note.txt"), "utf8")).toBe("parent edit\n");
    // ...while origin stayed the project, not the parent workspace.
    expect(record?.workspace?.sourceCwd).toBe(plain);
  });

  it("leaves a non-isolated fork alone", async () => {
    const plain = await makeTempDir("hydra-iso-forkplain-");
    const parent = await manager.create({ agentId: "claude-code", cwd: plain });
    const forked = await manager.forkSession(parent.sessionId, {});
    const record = await manager.loadFromDisk(forked.sessionId);
    expect(record?.workspace).toBeUndefined();
    expect(record?.cwd).toBe(plain);
  });

  it("autosaves uncommitted work to a hidden ref and drops it on deletion", async () => {
    const repo = await makeGitRepo();
    const session = await manager.create({
      agentId: "claude-code",
      cwd: repo,
      workspace: { label: "autosave" },
    });
    const ref = `refs/hydra/workspaces/${session.workspace?.label}/autosave`;

    await fs.writeFile(path.join(session.cwd, "unsaved.ts"), "export const x = 1;\n");
    // Drive the same hook a completed turn fires.
    await (
      manager as unknown as { runWorkspaceSnapshot(s: typeof session): Promise<void> }
    ).runWorkspaceSnapshot(session);

    const resolved = await exec("git", ["rev-parse", ref], { cwd: repo });
    expect(resolved.stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
    // The uncommitted file is recoverable from the snapshot...
    const shown = await exec("git", ["show", `${resolved.stdout.trim()}:unsaved.ts`], {
      cwd: repo,
    });
    expect(shown.stdout).toBe("export const x = 1;\n");
    // ...without appearing as a branch.
    const branches = await exec("git", ["branch", "--list"], { cwd: repo });
    expect(branches.stdout).not.toContain("snapshots");

    await manager.deleteRecord(session.sessionId);
    // The ref must go, or it pins its objects forever and gc can never
    // reclaim them.
    await expect(exec("git", ["rev-parse", "--verify", ref], { cwd: repo })).rejects.toThrow();
  });

  it("skips snapshotting when the turn changed nothing", async () => {
    const repo = await makeGitRepo();
    const session = await manager.create({
      agentId: "claude-code",
      cwd: repo,
      workspace: { label: "quiet" },
    });
    await (
      manager as unknown as { runWorkspaceSnapshot(s: typeof session): Promise<void> }
    ).runWorkspaceSnapshot(session);
    // No ref at all: a read-only turn should not pay for a tree walk's
    // worth of objects, and most turns are read-only.
    await expect(
      exec("git", ["rev-parse", "--verify", "refs/hydra/workspaces/quiet/autosave"], {
        cwd: repo,
      }),
    ).rejects.toThrow();
  });

  it("carries gitignored files and runs postCreate so the workspace is usable", async () => {
    // The gap that made isolation impractical on real repos: a fresh
    // checkout has no .env and no installed dependencies, so an agent
    // can read the code and do nothing else.
    const repo = await makeGitRepo();
    await fs.writeFile(path.join(repo, ".gitignore"), ".env\nnode_modules/\n");
    await fs.writeFile(path.join(repo, ".env"), "API_KEY=secret\n");
    await fs.mkdir(path.join(repo, ".hydra"), { recursive: true });
    await fs.writeFile(
      path.join(repo, ".hydra/worktree.json"),
      JSON.stringify({ carry: [".env"], postCreate: "mkdir -p node_modules && touch node_modules/.installed" }),
    );
    await exec("git", ["add", "-A"], { cwd: repo });
    await exec("git", ["commit", "-q", "-m", "config"], { cwd: repo });

    const session = await manager.create({
      agentId: "claude-code",
      cwd: repo,
      workspace: { label: "usable" },
    });

    // Gitignored file carried in (a plain worktree would not have it).
    expect(await fs.readFile(path.join(session.cwd, ".env"), "utf8")).toBe("API_KEY=secret\n");
    // postCreate ran, in the workspace.
    await fs.access(path.join(session.cwd, "node_modules/.installed"));
    // ...and left the source tree alone.
    await expect(fs.access(path.join(repo, "node_modules"))).rejects.toThrow();
    expect(session.workspaceError).toBeUndefined();
  });

  it("keeps the session when postCreate fails, and says what broke", async () => {
    // Isolation succeeded; only setup failed. Failing the session would
    // be worse than handing back an isolated-but-incomplete one, so long
    // as the gap is visible.
    const repo = await makeGitRepo();
    await fs.mkdir(path.join(repo, ".hydra"), { recursive: true });
    await fs.writeFile(
      path.join(repo, ".hydra/worktree.json"),
      JSON.stringify({ postCreate: "echo 'install blew up' >&2; exit 1" }),
    );
    await exec("git", ["add", "-A"], { cwd: repo });
    await exec("git", ["commit", "-q", "-m", "bad config"], { cwd: repo });

    const session = await manager.create({
      agentId: "claude-code",
      cwd: repo,
      workspace: { label: "brokensetup" },
    });

    expect(session.workspace).toBeDefined();
    expect(session.workspaceError).toMatch(/postCreate failed/);
    expect(session.workspaceError).toContain("install blew up");
  });

  it("runs preRemove before tearing a workspace down", async () => {
    // Setup may have created state OUTSIDE the directory (a database, a
    // container); deleting the directory does not undo any of it.
    const repo = await makeGitRepo();
    const marker = path.join(repo, "teardown-ran");
    await fs.mkdir(path.join(repo, ".hydra"), { recursive: true });
    await fs.writeFile(
      path.join(repo, ".hydra/worktree.json"),
      JSON.stringify({ preRemove: `touch ${marker}` }),
    );
    await exec("git", ["add", "-A"], { cwd: repo });
    await exec("git", ["commit", "-q", "-m", "teardown config"], { cwd: repo });

    const session = await manager.create({
      agentId: "claude-code",
      cwd: repo,
      workspace: { label: "teardown" },
    });
    await manager.deleteRecord(session.sessionId);
    await fs.access(marker);
  });
});
