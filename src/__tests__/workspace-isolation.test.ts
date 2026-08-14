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
import { makeMockAgent } from "./test-utils.js";

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
