// End-to-end: joining a workspace someone else is already in.
//
// Co-tenancy has to be CHOSEN rather than stumbled into, so these cover
// which label a join resolves against (the one that was asked for, even
// after a rename), what status reports about co-tenants, and the cases a
// join must refuse outright.
//
// One of six workspace-isolation-*.test.ts files split out of a single
// 2100-line suite so vitest can spread them across workers; shared
// fixtures live in workspace-isolation-harness.ts.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SessionManager } from "../core/session-manager.js";
import { stripHydraSessionPrefix } from "../core/session.js";
import {
  drainSnapshots,
  exec,
  makeGitRepo,
  makeIsolationManager,
  makeTempDir,
  registerTempRootCleanup,
} from "./workspace-isolation-harness.js";

// See workspace-isolation-lifecycle.test.ts: real git, and these files
// no longer get the machine to themselves.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

registerTempRootCleanup();

describe("session isolation end-to-end: joining a workspace", () => {
  let manager: SessionManager;
  let spawnedCwd: string | undefined;

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

  it("joins a workspace when its label names one a live session is in", async () => {
    // Co-tenancy has to be CHOSEN, and naming an occupied label is the
    // choice. Two agents in one checkout is not what isolation prevents:
    // two non-isolated sessions in one source tree already race that way.
    const repo = await makeGitRepo();
    const owner = await manager.create({ agentId: "claude-code", cwd: repo });
    await manager.runWorkspaceAction(owner.sessionId, "start", "shared");
    const wsPath = owner.cwd;

    const guest = await manager.create({ agentId: "claude-code", cwd: repo });
    const msg = await manager.runWorkspaceAction(guest.sessionId, "start", "shared");

    expect(msg).toContain("Joined workspace");
    // Named by the short id the rest of the UI uses, not the wire form.
    expect(msg).toContain(stripHydraSessionPrefix(owner.sessionId));
    expect(msg).not.toContain("hydra_session_");
    // Same directory, same branch, no second checkout beside it.
    expect(guest.cwd).toBe(wsPath);
    expect(guest.workspace?.label).toBe("shared");
    expect(guest.workspace?.vcs?.branch).toBe("hydra/shared");
    const branches = await exec("git", ["branch", "--list", "hydra/*"], { cwd: repo });
    expect(branches.stdout).not.toContain("hydra/shared-2");
  });

  it("joins on the label that was ASKED for, even after a rename", async () => {
    // Observed: two sessions each told to `start stuff` landed in stuff-2
    // and stuff-3. A `hydra/stuff` branch from a workspace removed the
    // day before still held the name, so the first request was suffixed
    // to stuff-2 — and the second request then looked for a live session
    // labelled "stuff", found none (the first is "stuff-2"), and
    // provisioned its own. Both sessions asked to share and neither did.
    const repo = await makeGitRepo();
    // The leftover: a branch with no workspace and no session, exactly
    // what `workspace remove` and `detach` both leave behind.
    await exec("git", ["branch", "hydra/stuff"], { cwd: repo });

    const first = await manager.create({ agentId: "claude-code", cwd: repo });
    const firstMsg = await manager.runWorkspaceAction(first.sessionId, "start", "stuff");
    expect(first.workspace?.label).toBe("stuff-2");
    // And it says why, so the rename is not a silent surprise.
    expect(firstMsg).toContain('"stuff" was already taken');

    const second = await manager.create({ agentId: "claude-code", cwd: repo });
    const secondMsg = await manager.runWorkspaceAction(second.sessionId, "start", "stuff");

    expect(secondMsg).toContain("Joined workspace");
    expect(second.cwd).toBe(first.cwd);
    expect(second.workspace?.label).toBe("stuff-2");
    const branches = await exec("git", ["branch", "--list", "hydra/*"], { cwd: repo });
    expect(branches.stdout).not.toContain("hydra/stuff-3");
  });

  it("reports co-tenants in status, and what leaving will actually do", async () => {
    const repo = await makeGitRepo();
    const owner = await manager.create({ agentId: "claude-code", cwd: repo });
    await manager.runWorkspaceAction(owner.sessionId, "start", "crowded");
    const guest = await manager.create({ agentId: "claude-code", cwd: repo });
    await manager.runWorkspaceAction(guest.sessionId, "start", "crowded");

    const status = await manager.runWorkspaceAction(guest.sessionId, "status");
    expect(status).toContain("shared with: " + stripHydraSessionPrefix(owner.sessionId));
    // The stock hint would be wrong here: neither exit lands anything
    // while somebody else is still in the tree.
    expect(status).toContain("the work lands when the last one leaves");
    expect(status).not.toContain("merge and return");

    // And once alone again, it goes back to describing the real choice.
    await manager.runWorkspaceAction(guest.sessionId, "stop");
    const solo = await manager.runWorkspaceAction(owner.sessionId, "status");
    expect(solo).not.toContain("shared with");
    expect(solo).toContain("merge and return");
  });

  it("still suffixes when the label survives with nobody in it", async () => {
    // The start-after-detach case. The name is taken by a branch, not by
    // a session, and adopting work you just walked away from would be the
    // opposite of what you asked for.
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    await manager.runWorkspaceAction(session.sessionId, "start", "letgo");
    await manager.runWorkspaceAction(session.sessionId, "detach");

    const msg = await manager.runWorkspaceAction(session.sessionId, "start", "letgo");

    expect(msg).toContain("Moved into workspace");
    expect(msg).not.toContain("Joined");
    expect(session.workspace?.label).toBe("letgo-2");
  });

  it("keeps the workspace when a co-tenant leaves, and lands on the last exit", async () => {
    const repo = await makeGitRepo();
    const owner = await manager.create({ agentId: "claude-code", cwd: repo });
    await manager.runWorkspaceAction(owner.sessionId, "start", "team");
    const wsPath = owner.cwd;
    const guest = await manager.create({ agentId: "claude-code", cwd: repo });
    await manager.runWorkspaceAction(guest.sessionId, "start", "team");

    await fs.writeFile(path.join(wsPath, "tracked.txt"), "shared work\n");

    // Guest leaves first: detach, no merge, workspace intact.
    const left = await manager.runWorkspaceAction(guest.sessionId, "stop");
    expect(left).toContain("Nothing landed yet");
    expect(left).toContain(stripHydraSessionPrefix(owner.sessionId));
    expect(left).not.toContain("hydra_session_");
    expect(guest.cwd).toBe(repo);
    await expect(fs.access(wsPath)).resolves.toBeUndefined();
    expect(await fs.readFile(path.join(repo, "tracked.txt"), "utf8")).toBe("original\n");

    // Owner leaves last: now it lands and the directory goes.
    const landed = await manager.runWorkspaceAction(owner.sessionId, "stop");
    expect(landed).toContain("Merged");
    expect(await fs.readFile(path.join(repo, "tracked.txt"), "utf8")).toBe("shared work\n");
    await expect(fs.access(wsPath)).rejects.toThrow();
  });

  it("joins a dirty source when the workspace already matches it", async () => {
    // The ordinary case, and the one a dirtiness check would have wrongly
    // rejected: `start` COPIES the work in, so the source is still dirty
    // with exactly what the workspace received. Equal trees mean the join
    // moves no content, so there is nothing to lose.
    const repo = await makeGitRepo();
    const owner = await manager.create({ agentId: "claude-code", cwd: repo });
    await fs.writeFile(path.join(repo, "wip.txt"), "shared wip\n");
    await manager.runWorkspaceAction(owner.sessionId, "start", "carried");
    // Present in both trees now, which is the state under test.
    expect(await fs.readFile(path.join(repo, "wip.txt"), "utf8")).toBe("shared wip\n");
    expect(await fs.readFile(path.join(owner.cwd, "wip.txt"), "utf8")).toBe("shared wip\n");

    const guest = await manager.create({ agentId: "claude-code", cwd: repo });
    const msg = await manager.runWorkspaceAction(guest.sessionId, "start", "carried");

    expect(msg).toContain("Joined workspace");
    expect(guest.cwd).toBe(owner.cwd);
  });

  it("refuses to join when the two trees have diverged", async () => {
    // Joining carries nothing across, so whichever side the joiner is not
    // in would be silently left behind.
    const repo = await makeGitRepo();
    const owner = await manager.create({ agentId: "claude-code", cwd: repo });
    await manager.runWorkspaceAction(owner.sessionId, "start", "busy");
    const guest = await manager.create({ agentId: "claude-code", cwd: repo });
    await fs.writeFile(path.join(repo, "mine.txt"), "only in the source\n");

    await expect(
      manager.runWorkspaceAction(guest.sessionId, "start", "busy"),
    ).rejects.toThrow(/diverged/);
    expect(guest.workspace).toBeUndefined();
  });

  it("refuses to join when the workspace has moved on", async () => {
    // The mirror image: the agent in there has done work the source has
    // never seen. Same rule, other direction.
    const repo = await makeGitRepo();
    const owner = await manager.create({ agentId: "claude-code", cwd: repo });
    await manager.runWorkspaceAction(owner.sessionId, "start", "ahead");
    await fs.writeFile(path.join(owner.cwd, "agent.txt"), "only in the workspace\n");

    const guest = await manager.create({ agentId: "claude-code", cwd: repo });
    await expect(
      manager.runWorkspaceAction(guest.sessionId, "start", "ahead"),
    ).rejects.toThrow(/diverged/);
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

  it("names the work in the workspace, and the source's drift, before `stop` is tried", async () => {
    // Both halves used to be invisible: status was built from the session
    // record alone, so it could not say what had changed in here, and a
    // source that moved on only surfaced as a refusal from `stop`.
    const repo = await makeGitRepo();
    const session = await manager.create({ agentId: "claude-code", cwd: repo });
    await manager.runWorkspaceAction(session.sessionId, "start", "reported");
    await fs.writeFile(path.join(session.cwd, "tracked.txt"), "agent work\n");
    await fs.writeFile(path.join(session.cwd, "fresh.ts"), "export {};\n");

    const dirty = await manager.runWorkspaceAction(session.sessionId, "status");
    expect(dirty).toContain("tracked.txt");
    expect(dirty).toContain("fresh.ts");
    expect(dirty).toContain("1 unstaged, 1 untracked");
    expect(dirty).toContain("in sync with");

    // The source moves on under it, which is what makes landing refuse.
    await fs.writeFile(path.join(repo, "other.txt"), "meanwhile\n");
    await exec("git", ["add", "-A"], { cwd: repo });
    await exec("git", ["commit", "-q", "-m", "source moved on"], { cwd: repo });

    const drifted = await manager.runWorkspaceAction(session.sessionId, "status");
    expect(drifted).toContain("1 commit(s) behind");
    expect(drifted).toContain("/hydra workspace sync");
  });
});
