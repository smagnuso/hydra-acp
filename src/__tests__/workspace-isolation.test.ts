// End-to-end: session/new with an isolated workspace.
//
// Covers the claims the walking skeleton has to make good on:
//   - the AGENT PROCESS is spawned in the workspace, not the source tree
//   - writes there do not reach the user's checkout
//   - the binding survives a daemon restart (record round-trip)
//   - the session is still findable by the tree it came from
//   - isolation failure falls open, unless the caller said it must not

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { SessionManager } from "../core/session-manager.js";
import { Registry, type RegistryAgent } from "../core/registry.js";
import { extractHydraMeta } from "../acp/types-hydra-meta.js";
import { buildHydraSessionMeta } from "../acp/types-session-list.js";
import { JsonRpcConnection } from "../acp/connection.js";
import type { AttachedClient } from "../core/session.js";
import { makeMockAgent, makeControlledStream } from "./test-utils.js";

function makeClient(): { client: AttachedClient } {
  const conn = new JsonRpcConnection(makeControlledStream());
  return {
    client: {
      clientId: `c_${Math.random().toString(36).slice(2, 8)}`,
      connection: conn,
    } as AttachedClient,
  };
}

const exec = promisify(execFile);

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpath(dir);
}

async function makeGitRepo(): Promise<string> {
  const dir = await makeTempDir("hydra-iso-repo-");
  await fs.writeFile(path.join(dir, "tracked.txt"), "original\n");
  await exec("git", ["init", "-b", "main"], { cwd: dir });
  await exec("git", ["config", "user.email", "t@e.invalid"], { cwd: dir });
  await exec("git", ["config", "user.name", "T"], { cwd: dir });
  await exec("git", ["add", "-A"], { cwd: dir });
  await exec("git", ["commit", "-q", "-m", "initial"], { cwd: dir });
  return dir;
}

function fakeRegistry(): Registry {
  const agents: RegistryAgent[] = [
    { id: "claude-code", name: "claude-code", distribution: { npx: { package: "claude-code" } } },
  ];
  return {
    async getAgent(id: string) {
      return agents.find((a) => a.id === id);
    },
    async load() {
      return { version: "0", agents };
    },
    async refresh() {
      return { version: "0", agents };
    },
  } as unknown as Registry;
}

describe("session isolation end-to-end", () => {
  let manager: SessionManager;
  /** cwd the agent process was actually spawned with. */
  let spawnedCwd: string | undefined;

  function makeManager(): SessionManager {
    return new SessionManager(fakeRegistry(), (opts: { cwd: string }) => {
      spawnedCwd = opts.cwd;
      const m = makeMockAgent({ agentId: "claude-code", cwd: opts.cwd });
      const requestMock = m.agent.connection.request as ReturnType<typeof vi.fn>;
      requestMock
        .mockResolvedValueOnce({ protocolVersion: 1 })
        .mockResolvedValueOnce({ sessionId: "u_new" });
      return m.agent;
    });
  }

  beforeEach(() => {
    spawnedCwd = undefined;
    manager = makeManager();
  });

  // Workspace autosave is deliberately fire-and-forget: it runs git in
  // the workspace after a turn completes, off the critical path. That
  // makes it invisible to any test that awaits only the command it
  // called — and it outlives the test, so the outer afterEach can be
  // deleting the repo while git is still writing to
  // .git/worktrees/<label>. Only tests that drive a REAL turn arm it,
  // which is why this stayed hidden while every test called
  // runWorkspaceAction directly.
  //
  // Registered on the inner block so it drains before the outer
  // afterEach removes the temp trees.
  afterEach(async () => {
    const inFlight = (manager as unknown as { snapshotInFlight: Set<string> }).snapshotInFlight;
    for (let i = 0; i < 200 && inFlight.size > 0; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
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
    const ref = `refs/hydra/snapshots/${session.sessionId}`;

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
      exec("git", ["rev-parse", "--verify", `refs/hydra/snapshots/${session.sessionId}`], {
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

  it("orients the agent on its first prompt and rewrites source-tree paths", async () => {
    const repo = await makeGitRepo();
    const session = await manager.create({
      agentId: "claude-code",
      cwd: repo,
      workspace: { label: "oriented" },
    });
    expect(session.workspaceNotes.length).toBeGreaterThan(0);

    const rewrite = (
      session as unknown as { applyWorkspacePromptRewrite(p: unknown[]): unknown[] }
    ).applyWorkspacePromptRewrite.bind(session);

    const first = rewrite([{ type: "text", text: `look at ${repo}/tracked.txt` }]) as {
      text: string;
    }[];
    // Oriented once, up front...
    expect(first[0]?.text).toContain("[workspace]");
    expect(first[0]?.text).toContain(session.cwd);
    // ...and the path now points at the file the agent should touch.
    expect(first[0]?.text).toContain(`${session.cwd}/tracked.txt`);
    expect(first[0]?.text).not.toContain(`${repo}/tracked.txt`);

    // An ordinary follow-up does not re-pay for the preamble.
    const second = rewrite([{ type: "text", text: "now run the tests" }]) as { text: string }[];
    expect(second[0]?.text).toBe("now run the tests");

    // But naming the source tree re-asserts, because that is the moment
    // a forgotten mapping does damage, and the preamble is exactly what
    // compaction drops on a long session.
    const third = rewrite([{ type: "text", text: `also ${repo}/other.txt` }]) as {
      text: string;
    }[];
    expect(third[0]?.text).toMatch(/reminder/i);
    expect(third[0]?.text).toContain(`${session.cwd}/other.txt`);
  });

  it("reports a write that lands in the source tree", async () => {
    // Detection, not prevention: the daemon sees file edits as
    // notifications, after the write. The point is that a breach of the
    // one promise isolation makes is never silent.
    const repo = await makeGitRepo();
    const session = await manager.create({
      agentId: "claude-code",
      cwd: repo,
      workspace: { label: "breach" },
    });

    const events: { kind: string; payload: unknown }[] = [];
    (session as unknown as { notifyChain(k: string, p: unknown): void }).notifyChain = (
      kind,
      payload,
    ) => {
      events.push({ kind, payload });
    };
    const report = (
      session as unknown as { reportIsolationBreach(p: string, t: unknown): void }
    ).reportIsolationBreach.bind(session);

    report(`${repo}/tracked.txt`, "tool-1");
    expect(events.map((e) => e.kind)).toContain("workspace.breach");
    expect((events[0]?.payload as { path?: string }).path).toBe(`${repo}/tracked.txt`);

    // Writes inside the workspace, and unrelated paths, are silent.
    events.length = 0;
    report(`${session.cwd}/tracked.txt`, "tool-2");
    report("/tmp/scratch.txt", "tool-3");
    expect(events).toEqual([]);
  });

  it("leaves a non-isolated session's prompts untouched", async () => {
    const plain = await makeTempDir("hydra-iso-noprompt-");
    const session = await manager.create({ agentId: "claude-code", cwd: plain });
    const out = (
      session as unknown as { applyWorkspacePromptRewrite(p: unknown[]): unknown[] }
    ).applyWorkspacePromptRewrite([{ type: "text", text: `look at ${plain}/x.ts` }]) as {
      text: string;
    }[];
    expect(out[0]?.text).toBe(`look at ${plain}/x.ts`);
  });

  it("starts a workspace when the user actually types the command", async () => {
    // Every other test here calls runWorkspaceAction directly, which
    // skips the prompt queue. Typing `/hydra workspace start` does not:
    // the command runs as a queue entry, so the session is mid-drain
    // while it asks to be swapped. Keying the swap gate on "is the queue
    // busy" makes the command refuse itself, and no test that bypasses
    // the queue can see it.
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    const { client } = makeClient();
    session.attach(client, "full");

    await session.prompt(client.clientId, {
      prompt: [{ type: "text", text: "/hydra workspace start typed" }],
    });

    expect(session.workspace?.sourceCwd).toBe(repo);
    expect(session.cwd).toBe(session.workspace?.path);
    expect(session.cwd).not.toBe(repo);
  });

  it("copies staged work in, but lands it unstaged in the workspace", async () => {
    // Staging it in the workspace would leave the user's WIP sitting in
    // the index the agent commits from, so the agent's first bare
    // `git commit` would sweep it up.
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    await fs.writeFile(path.join(repo, "tracked.txt"), "staged edit\n");
    await fs.writeFile(path.join(repo, "added.txt"), "staged addition\n");
    await exec("git", ["add", "-A"], { cwd: repo });

    await manager.runWorkspaceAction(session.sessionId, "start", "staged");

    expect(await fs.readFile(path.join(session.cwd, "tracked.txt"), "utf8")).toBe("staged edit\n");
    expect(await fs.readFile(path.join(session.cwd, "added.txt"), "utf8")).toBe(
      "staged addition\n",
    );
    const inWs = await exec("git", ["status", "--porcelain", "-uall"], { cwd: session.cwd });
    expect(inWs.stdout).toContain(" M tracked.txt");
    expect(inWs.stdout).toContain("?? added.txt");

    // And the source keeps its own copy, staged as the user left it.
    const inSource = await exec("git", ["status", "--porcelain", "-uall"], { cwd: repo });
    expect(inSource.stdout).toContain("M  tracked.txt");
    expect(inSource.stdout).toContain("A  added.txt");
  });

  it("gives two workspaces started from one dirty tree the same baseline", async () => {
    // The reason start copies. Taking the work would mean whichever
    // session runs first silently claims it and the second begins from
    // HEAD — a different baseline, chosen by typing order, reported to
    // nobody. Competition siblings exist to be identical at t=0, so
    // this is not a surprise but a wrong answer.
    const repo = await makeGitRepo();
    const first = await manager.create({ agentId: "claude-code", cwd: repo });
    const second = await manager.create({ agentId: "claude-code", cwd: repo });
    await fs.writeFile(path.join(repo, "tracked.txt"), "shared premise\n");
    await fs.writeFile(path.join(repo, "notes.md"), "shared note\n");

    await manager.runWorkspaceAction(first.sessionId, "start", "one");
    await manager.runWorkspaceAction(second.sessionId, "start", "two");

    for (const s of [first, second]) {
      expect(await fs.readFile(path.join(s.cwd, "tracked.txt"), "utf8")).toBe("shared premise\n");
      expect(await fs.readFile(path.join(s.cwd, "notes.md"), "utf8")).toBe("shared note\n");
    }
    // And the tree they were both derived from still has it.
    expect(await fs.readFile(path.join(repo, "tracked.txt"), "utf8")).toBe("shared premise\n");
  });

  it("leaves nothing behind when the swap fails partway", async () => {
    // The failure this reproduces stranded a workspace holding the only
    // copy of the user's edits. Unwinding has to put the work back
    // BEFORE removing the tree that holds it.
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    await fs.writeFile(path.join(repo, "tracked.txt"), "work in progress\n");
    await fs.writeFile(path.join(repo, "extra.txt"), "untracked too\n");
    await exec("git", ["add", "tracked.txt"], { cwd: repo });

    vi.spyOn(session, "swapIntoWorkspace").mockRejectedValue(new Error("agent respawn failed"));

    await expect(
      manager.runWorkspaceAction(session.sessionId, "start", "doomed"),
    ).rejects.toThrow(/agent respawn failed/);

    // Session never moved.
    expect(session.workspace).toBeUndefined();
    expect(session.cwd).toBe(repo);
    // The work is back, staged and untracked alike.
    expect(await fs.readFile(path.join(repo, "tracked.txt"), "utf8")).toBe("work in progress\n");
    expect(await fs.readFile(path.join(repo, "extra.txt"), "utf8")).toBe("untracked too\n");
    // And no orphan workspace was left for `hydra workspace prune` to find.
    const worktrees = await exec("git", ["worktree", "list"], { cwd: repo });
    expect(worktrees.stdout).not.toContain("doomed");
  });

  it("refuses to start while the agent is mid-turn, without provisioning anything", async () => {
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    vi.spyOn(session, "isQuiescedForSwap").mockResolvedValue(false);

    await expect(manager.runWorkspaceAction(session.sessionId, "start", "busy")).rejects.toThrow(
      /still working/i,
    );

    const worktrees = await exec("git", ["worktree", "list"], { cwd: repo });
    expect(worktrees.stdout).not.toContain("busy");
  });

  it("moves a live session into a workspace, copying uncommitted work in", async () => {
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    expect(session.workspace).toBeUndefined();

    // Planning phase produced edits in the real tree.
    await fs.writeFile(path.join(repo, "tracked.txt"), "planned edit\n");
    await fs.writeFile(path.join(repo, "notes.md"), "new file\n");

    const msg = await manager.runWorkspaceAction(session.sessionId, "start", "feature");
    expect(msg).toContain("Moved into workspace");
    expect(msg).toContain("untouched");

    // The session relocated, and the agent was respawned there.
    expect(session.workspace?.sourceCwd).toBe(repo);
    expect(session.cwd).toBe(session.workspace?.path);
    expect(spawnedCwd).toBe(session.cwd);

    // The work came along...
    expect(await fs.readFile(path.join(session.cwd, "tracked.txt"), "utf8")).toBe("planned edit\n");
    expect(await fs.readFile(path.join(session.cwd, "notes.md"), "utf8")).toBe("new file\n");

    // ...and is still in the real tree, which the session does not own.
    expect(await fs.readFile(path.join(repo, "tracked.txt"), "utf8")).toBe("planned edit\n");
    expect(await fs.readFile(path.join(repo, "notes.md"), "utf8")).toBe("new file\n");
  });

  it("announces the move so clients can stop pointing at the old tree", async () => {
    // A client resolves cwd once, at session/new or attach. Without this
    // event it has no way to learn the session relocated, and its cwd is
    // what file completion, the git panel and diff resolution are all
    // computed against.
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    const seen: Array<Record<string, unknown>> = [];
    session.onBroadcast?.((msg) => {
      const update = (msg.params as { update?: Record<string, unknown> } | undefined)?.update;
      if (update?.sessionUpdate === "hydra_workspace") {
        seen.push(update);
      }
    });

    await manager.runWorkspaceAction(session.sessionId, "start", "announced");

    const phases = seen.map((u) => u.phase);
    expect(phases).toContain("provisioning");
    expect(phases).toContain("swapping");
    // The terminal phase carries where the session actually went.
    const entered = seen.find((u) => u.phase === "entered");
    expect(entered?.cwd).toBe(session.cwd);
    expect(entered?.sourceCwd).toBe(repo);
    expect(entered?.label).toBe("announced");
    // ...and it lands only after the record is written, so a client
    // acting on it cannot outrun the state that justifies it.
    expect(phases.indexOf("entered")).toBe(phases.length - 1);

    seen.length = 0;
    await manager.runWorkspaceAction(session.sessionId, "end");
    const left = seen.find((u) => u.phase === "left");
    expect(left?.cwd).toBe(repo);
  });

  it("announces failure so the progress indicator cannot stick", async () => {
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    const seen: Array<Record<string, unknown>> = [];
    session.onBroadcast?.((msg) => {
      const update = (msg.params as { update?: Record<string, unknown> } | undefined)?.update;
      if (update?.sessionUpdate === "hydra_workspace") {
        seen.push(update);
      }
    });
    vi.spyOn(session, "swapIntoWorkspace").mockRejectedValue(new Error("respawn failed"));

    await expect(
      manager.runWorkspaceAction(session.sessionId, "start", "doomed"),
    ).rejects.toThrow(/respawn failed/);

    expect(seen.map((u) => u.phase)).toContain("failed");
  });

  it("ends by returning uncommitted work uncommitted, and commits as commits", async () => {
    // The round trip has to be faithful. Handing WIP back as a commit
    // creates something the user never chose to create, and promotes
    // their untracked files to tracked ones on the way.
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    await fs.writeFile(path.join(repo, "tracked.txt"), "user wip\n");
    await fs.writeFile(path.join(repo, "scratch.md"), "untracked wip\n");

    await manager.runWorkspaceAction(session.sessionId, "start", "roundtrip");
    const wsPath = session.cwd;

    // The agent commits one thing deliberately and leaves another loose.
    await fs.writeFile(path.join(wsPath, "shipped.ts"), "deliberate\n");
    await exec("git", ["add", "shipped.ts"], { cwd: wsPath });
    await exec("git", ["commit", "-q", "-m", "agent: ship it"], { cwd: wsPath });
    await fs.writeFile(path.join(wsPath, "loose.ts"), "still working\n");

    await manager.runWorkspaceAction(session.sessionId, "end");

    // The deliberate commit arrived as a commit.
    const log = await exec("git", ["log", "--oneline", "-3"], { cwd: repo });
    expect(log.stdout).toContain("agent: ship it");
    expect(log.stdout).not.toContain("hydra: work from");

    // Everything uncommitted arrived uncommitted, and the untracked file
    // is still untracked.
    const status = await exec("git", ["status", "--porcelain", "-uall"], { cwd: repo });
    expect(status.stdout).toContain(" M tracked.txt");
    expect(status.stdout).toContain("?? scratch.md");
    expect(status.stdout).toContain("?? loose.ts");
    expect(await fs.readFile(path.join(repo, "tracked.txt"), "utf8")).toBe("user wip\n");
    expect(await fs.readFile(path.join(repo, "loose.ts"), "utf8")).toBe("still working\n");
  });

  it("keeps working in the source tree while isolated, and lands both sides", async () => {
    // Copy semantics make this the intended workflow, not an edge case:
    // the source stays usable precisely because the workspace did not
    // take the work. So editing here must not make `end` refuse.
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    await fs.writeFile(path.join(repo, "tracked.txt"), "copied in\n");

    await manager.runWorkspaceAction(session.sessionId, "start", "diverge");
    const wsPath = session.cwd;

    // The user keeps working in the source, on a file the agent never
    // touches. The agent works on its own file.
    await fs.writeFile(path.join(repo, "mine.txt"), "my parallel work\n");
    await fs.writeFile(path.join(wsPath, "theirs.txt"), "agent work\n");
    await exec("git", ["add", "theirs.txt"], { cwd: wsPath });
    await exec("git", ["commit", "-q", "-m", "agent: theirs"], { cwd: wsPath });

    await manager.runWorkspaceAction(session.sessionId, "end");

    // Both survive. The agent's commit is a commit...
    const log = await exec("git", ["log", "--oneline", "-2"], { cwd: repo });
    expect(log.stdout).toContain("agent: theirs");
    // ...the copied WIP is back as uncommitted work...
    expect(await fs.readFile(path.join(repo, "tracked.txt"), "utf8")).toBe("copied in\n");
    // ...and so is the work done in the source while isolated.
    expect(await fs.readFile(path.join(repo, "mine.txt"), "utf8")).toBe("my parallel work\n");
  });

  it("reports rather than loses work when both sides edited the same lines", async () => {
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });

    await manager.runWorkspaceAction(session.sessionId, "start", "clash");
    const wsPath = session.cwd;

    // Same file, same line, two different edits.
    await fs.writeFile(path.join(repo, "tracked.txt"), "source version\n");
    await fs.writeFile(path.join(wsPath, "tracked.txt"), "workspace version\n");
    await exec("git", ["commit", "-qam", "agent: my version"], { cwd: wsPath });

    const msg = await manager.runWorkspaceAction(session.sessionId, "end");

    // The merge still lands, and the clash is reported with a recovery
    // path rather than the source edit being silently dropped.
    expect(msg).toMatch(/overlap|could not be replayed/i);
    const refs = await exec("git", ["for-each-ref", "refs/hydra/landing"], { cwd: repo });
    expect(refs.stdout.trim().length).toBeGreaterThan(0);
  });

  it("keeps the pre-move state recoverable under refs/hydra", async () => {
    // There is a window where the work exists in neither tree. The
    // snapshot ref is written before the source is touched so that
    // window is survivable.
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    await fs.writeFile(path.join(repo, "precious.txt"), "do not lose me\n");

    await manager.runWorkspaceAction(session.sessionId, "start", "safety");

    // The START ref, not the autosave ref. They were the same name once,
    // which is exactly how the autosave came to clobber this baseline.
    const ref = `refs/hydra/start/${session.sessionId}`;
    const sha = (await exec("git", ["rev-parse", ref], { cwd: repo })).stdout.trim();
    const shown = await exec("git", ["show", `${sha}:precious.txt`], { cwd: repo });
    expect(shown.stdout).toBe("do not lose me\n");
  });

  it("persists cwd and the binding together, and reports status", async () => {
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    await manager.runWorkspaceAction(session.sessionId, "start", "persisted");

    const record = await manager.loadFromDisk(session.sessionId);
    // The invariant every consumer relies on: if there is a binding,
    // cwd IS the workspace path.
    expect(record?.workspace?.path).toBe(record?.cwd);
    expect(record?.workspace?.sourceCwd).toBe(repo);

    const status = await manager.runWorkspaceAction(session.sessionId, "status");
    expect(status).toContain("Isolated in");
    expect(status).toContain(repo);
  });

  it("refuses to start when already isolated", async () => {
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    await manager.runWorkspaceAction(session.sessionId, "start", "first");
    await expect(
      manager.runWorkspaceAction(session.sessionId, "start", "second"),
    ).rejects.toThrow(/already isolated/i);
  });

  it("reports not-isolated status for an ordinary session", async () => {
    const plain = await makeTempDir("hydra-iso-status-");
    const session = await manager.create({ agentId: "claude-code", cwd: plain });
    const status = await manager.runWorkspaceAction(session.sessionId, "status");
    expect(status).toContain("Not isolated");
    expect(status).toContain(plain);
  });

  it("ends a workspace by merging and returning to the source", async () => {
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    await manager.runWorkspaceAction(session.sessionId, "start", "shipit");
    const wsPath = session.cwd;
    await fs.writeFile(path.join(wsPath, "tracked.txt"), "agent work\n");

    const msg = await manager.runWorkspaceAction(session.sessionId, "end");
    expect(msg).toContain("Merged");
    expect(msg).toContain("Returned to");

    // Back in the real tree, with the work landed.
    expect(session.cwd).toBe(repo);
    expect(session.workspace).toBeUndefined();
    expect(await fs.readFile(path.join(repo, "tracked.txt"), "utf8")).toBe("agent work\n");

    // Binding cleared on disk, not just in memory.
    const record = await manager.loadFromDisk(session.sessionId);
    expect(record?.workspace).toBeUndefined();
    expect(record?.cwd).toBe(repo);

    // Workspace gone, and its snapshot ref with it: integrated work
    // needs no recovery anchor, and a live ref pins objects forever.
    await expect(fs.access(wsPath)).rejects.toThrow();
    await expect(
      exec("git", ["rev-parse", "--verify", `refs/hydra/snapshots/${session.sessionId}`], {
        cwd: repo,
      }),
    ).rejects.toThrow();
  });

  it("lands cleanly after several turns of autosave", async () => {
    // Regression. The start baseline and the per-turn autosave shared one
    // ref name, so the autosave clobbered the baseline on the first turn
    // inside the workspace. Landing then diffed the WORKSPACE against the
    // source and produced the inverse of the agent's own work; `git apply
    // --3way` rejecting it is the only reason it did not silently revert
    // the session's changes. Existing tests all landed immediately, so
    // none of them had an autosave to be clobbered by.
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    // The user has their own uncommitted edit, untouched by the agent.
    await fs.writeFile(path.join(repo, "mine.txt"), "user edit\n");

    await manager.runWorkspaceAction(session.sessionId, "start", "afterturns");
    const wsPath = session.cwd;

    // Several turns' worth of agent work, each followed by an autosave.
    for (const round of ["one", "two", "three"]) {
      await fs.writeFile(path.join(wsPath, "tracked.txt"), `agent ${round}\n`);
      await (
        manager as unknown as { runWorkspaceSnapshot(s: typeof session): Promise<void> }
      ).runWorkspaceSnapshot(session);
    }

    const msg = await manager.runWorkspaceAction(session.sessionId, "end");
    expect(msg).toContain("Merged");
    // The agent's work survived: the whole point.
    expect(await fs.readFile(path.join(repo, "tracked.txt"), "utf8")).toBe("agent three\n");
    // The user's own edit came back too, and was not reported as a conflict.
    expect(await fs.readFile(path.join(repo, "mine.txt"), "utf8")).toBe("user edit\n");
    expect(msg).not.toMatch(/could not be replayed|WARNING/i);
  });

  it("drops both the autosave and the landing baseline on exit", async () => {
    // Two refs now, two GC roots. A survivor pins objects for a session
    // that is finished with them.
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    await fs.writeFile(path.join(repo, "mine.txt"), "user edit\n");
    await manager.runWorkspaceAction(session.sessionId, "start", "refs");
    await fs.writeFile(path.join(session.cwd, "tracked.txt"), "work\n");
    await (
      manager as unknown as { runWorkspaceSnapshot(s: typeof session): Promise<void> }
    ).runWorkspaceSnapshot(session);

    const before = await exec("git", ["for-each-ref", "refs/hydra/"], { cwd: repo });
    expect(before.stdout).toContain(`refs/hydra/start/${session.sessionId}`);

    await manager.runWorkspaceAction(session.sessionId, "end");
    const after = await exec("git", ["for-each-ref", "refs/hydra/"], { cwd: repo });
    expect(after.stdout).not.toContain(session.sessionId);
  });

  it("labels a workspace swap by its cause, not by the compaction machinery", async () => {
    // Workspace moves borrow swapUpstream, which is the compaction path,
    // so they used to announce "Compaction completed." That is wrong
    // twice: nothing was summarized, and it invites worry about lost
    // context at the moment the user is confirming a clean transition.
    //
    // The synthetic message goes to ATTACHED CLIENTS rather than through
    // onBroadcast (it is deliberately not recorded to history), so the
    // assertion has to read a client's wire.
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    const stream = makeControlledStream();
    await session.attach(
      { clientId: "c_label", connection: new JsonRpcConnection(stream) } as AttachedClient,
      "none",
    );
    const textOf = (): string =>
      stream.sent
        .map((m) => {
          const u = (m as { params?: { update?: { content?: { text?: unknown } } } }).params
            ?.update;
          return typeof u?.content?.text === "string" ? u.content.text : "";
        })
        .join("");

    await manager.runWorkspaceAction(session.sessionId, "start", "labelled");
    expect(textOf()).toContain("Moved into the workspace");
    expect(textOf()).not.toContain("Compaction completed");

    stream.sent.length = 0;
    await manager.runWorkspaceAction(session.sessionId, "end");
    expect(textOf()).toContain("Returned to the source tree");
    expect(textOf()).not.toContain("Compaction completed");
  });

  it("reports progress phases on the way out, as it does on the way in", async () => {
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    const phases: string[] = [];
    session.onBroadcast((raw) => {
      const ev = raw as { params?: { update?: { sessionUpdate?: string; phase?: string } } };
      if (ev.params?.update?.sessionUpdate === "hydra_workspace") {
        phases.push(ev.params.update.phase ?? "");
      }
    });

    await manager.runWorkspaceAction(session.sessionId, "start", "phased");
    expect(phases).toContain("provisioning");
    expect(phases).toContain("entered");

    phases.length = 0;
    await fs.writeFile(path.join(session.cwd, "tracked.txt"), "work\n");
    await manager.runWorkspaceAction(session.sessionId, "end");
    // Both legs of the exit are slow enough that silence reads as a hang.
    expect(phases).toContain("landing");
    expect(phases).toContain("returning");
    expect(phases).toContain("left");
  });

  it("can start again after ending, without colliding with its own leftovers", async () => {
    // Regression. The default label is derived from the session id, so
    // it repeats; `end` used to keep the branch, so the second start hit
    // "fatal: a branch named 'hydra/s-...' already exists". Two right
    // decisions that were wrong together.
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });

    await manager.runWorkspaceAction(session.sessionId, "start");
    const first = session.cwd;
    await fs.writeFile(path.join(first, "tracked.txt"), "round one\n");
    await manager.runWorkspaceAction(session.sessionId, "end");

    // The branch is gone too: merged, unreferenced, and squatting on the
    // label the next start wants.
    const branches = await exec("git", ["branch", "--list", "hydra/*"], { cwd: repo });
    expect(branches.stdout.trim()).toBe("");

    // Round two must just work.
    const msg = await manager.runWorkspaceAction(session.sessionId, "start");
    expect(msg).toContain("Moved into workspace");
    expect(session.workspace).toBeDefined();
    expect(session.cwd).not.toBe(repo);
  });

  it("picks a free label when a branch legitimately survives", async () => {
    // `abandon` keeps the branch on purpose, so the name stays taken.
    // Starting again must sidestep rather than fail.
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });

    await manager.runWorkspaceAction(session.sessionId, "start", "reused");
    await manager.runWorkspaceAction(session.sessionId, "abandon");
    const kept = await exec("git", ["branch", "--list", "hydra/reused"], { cwd: repo });
    expect(kept.stdout).toContain("hydra/reused");

    await manager.runWorkspaceAction(session.sessionId, "start", "reused");
    expect(session.workspace?.label).toBe("reused-2");
    expect(session.workspace?.vcs?.branch).toBe("hydra/reused-2");
  });

  it("abandons without merging, keeping the workspace and its safety net", async () => {
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    await manager.runWorkspaceAction(session.sessionId, "start", "nevermind");
    const wsPath = session.cwd;
    await fs.writeFile(path.join(wsPath, "experiment.txt"), "might want this\n");
    // Give the ref something to hold.
    await (
      manager as unknown as { runWorkspaceSnapshot(s: typeof session): Promise<void> }
    ).runWorkspaceSnapshot(session);

    const msg = await manager.runWorkspaceAction(session.sessionId, "abandon");
    expect(msg).toContain("WITHOUT merging");

    expect(session.cwd).toBe(repo);
    expect(session.workspace).toBeUndefined();
    // Nothing landed.
    await expect(fs.access(path.join(repo, "experiment.txt"))).rejects.toThrow();
    // The directory and the ref are the only copies, so both survive.
    expect(await fs.readFile(path.join(wsPath, "experiment.txt"), "utf8")).toBe(
      "might want this\n",
    );
    const ref = await exec(
      "git",
      ["rev-parse", `refs/hydra/snapshots/${session.sessionId}`],
      { cwd: repo },
    );
    expect(ref.stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
  });

  it("refuses to end when the source moved, leaving the session in place", async () => {
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    await manager.runWorkspaceAction(session.sessionId, "start", "stuck");
    const wsPath = session.cwd;
    await fs.writeFile(path.join(wsPath, "tracked.txt"), "agent work\n");
    // Source diverges underneath.
    await exec("git", ["commit", "-q", "--allow-empty", "-m", "moved on"], { cwd: repo });

    await expect(manager.runWorkspaceAction(session.sessionId, "end")).rejects.toThrow(
      /cannot fast-forward/i,
    );
    // `end` means finish, so a failure must not strand the work by
    // returning to the source anyway.
    expect(session.cwd).toBe(wsPath);
    expect(session.workspace).toBeDefined();
  });

  it("merges without leaving the workspace", async () => {
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    await manager.runWorkspaceAction(session.sessionId, "start", "keepgoing");
    await fs.writeFile(path.join(session.cwd, "tracked.txt"), "first pass\n");

    const msg = await manager.runWorkspaceAction(session.sessionId, "merge");
    expect(msg).toContain("Still working in");
    expect(await fs.readFile(path.join(repo, "tracked.txt"), "utf8")).toBe("first pass\n");
    expect(session.workspace).toBeDefined();
  });

  it("rejects workspace verbs on a session that is not isolated", async () => {
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    for (const verb of ["merge", "end", "abandon"] as const) {
      await expect(manager.runWorkspaceAction(session.sessionId, verb)).rejects.toThrow(
        /not in a workspace/i,
      );
    }
  });

  it("falls open to the source tree when the directory is not a repository", async () => {
    const plain = await makeTempDir("hydra-iso-plain-");
    const session = await manager.create({
      agentId: "claude-code",
      cwd: plain,
      workspace: { label: "nope" },
    });

    expect(session.workspace).toBeUndefined();
    expect(session.cwd).toBe(plain);
    expect(spawnedCwd).toBe(plain);
  });

  it("tells the client WHY it fell open instead of failing silently", async () => {
    // Falling back without saying so is the dangerous shape: the caller
    // asked for isolation, did not get it, and has no way to know. The
    // pair (no workspaceInfo, workspaceError present) is the signal.
    const plain = await makeTempDir("hydra-iso-why-");
    const session = await manager.create({
      agentId: "claude-code",
      cwd: plain,
      workspace: { label: "explain" },
    });

    expect(session.workspaceError).toMatch(/not a git repository/i);

    const meta = buildHydraSessionMeta(manager.liveListEntry(session));
    expect(meta.workspaceInfo).toBeUndefined();
    expect(meta.workspaceError).toMatch(/not a git repository/i);
  });

  it("reports no error when isolation succeeded", async () => {
    const repo = await makeGitRepo();
    const session = await manager.create({
      agentId: "claude-code",
      cwd: repo,
      workspace: { label: "fine" },
    });
    expect(session.workspaceError).toBeUndefined();
    const meta = buildHydraSessionMeta(manager.liveListEntry(session));
    expect(meta.workspaceError).toBeUndefined();
    expect(meta.workspaceInfo).toBeDefined();
  });

  it("fails session creation when isolation is required and unavailable", async () => {
    // The competition case: a silent fallback would put N agents back in
    // one tree, which is the failure isolation exists to prevent, reached
    // quietly. Better to refuse.
    const plain = await makeTempDir("hydra-iso-required-");
    await expect(
      manager.create({
        agentId: "claude-code",
        cwd: plain,
        workspace: { label: "must", required: true },
      }),
    ).rejects.toThrow(/isolation required/i);
  });

  it("isolates a non-repository directory when the copy provider is asked for", async () => {
    const plain = await makeTempDir("hydra-iso-copy-");
    await fs.writeFile(path.join(plain, "note.txt"), "hello\n");

    const session = await manager.create({
      agentId: "claude-code",
      cwd: plain,
      workspace: { label: "copied", provider: "copy" },
    });

    expect(session.workspace?.provider).toBe("copy");
    expect(session.cwd).not.toBe(plain);
    expect(await fs.readFile(path.join(session.cwd, "note.txt"), "utf8")).toBe("hello\n");

    await fs.writeFile(path.join(session.cwd, "note.txt"), "changed\n");
    expect(await fs.readFile(path.join(plain, "note.txt"), "utf8")).toBe("hello\n");
  });

  it("rejects an unknown provider only when isolation is required", async () => {
    const repo = await makeGitRepo();
    const lenient = await manager.create({
      agentId: "claude-code",
      cwd: repo,
      workspace: { label: "x", provider: "not-a-provider" },
    });
    expect(lenient.workspace).toBeUndefined();
    expect(lenient.cwd).toBe(repo);

    await expect(
      manager.create({
        agentId: "claude-code",
        cwd: repo,
        workspace: { label: "y", provider: "not-a-provider", required: true },
      }),
    ).rejects.toThrow(/isolation required/i);
  });
});
