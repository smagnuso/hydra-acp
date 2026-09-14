// Can a workspace be landed while a second session is still in it?
//
// `discard` refuses on a shared workspace, and `stop` deliberately
// degrades to `detach`. Whether bare `merge` also refuses decides
// whether a caller may bring a second session into a workspace and land
// from it — which is exactly what a reviewer joining the tree it is
// reviewing does.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SessionManager } from "../core/session-manager.js";
import {
  drainSnapshots,
  exec,
  makeGitRepo,
  makeIsolationManager,
  registerTempRootCleanup,
} from "./workspace-isolation-harness.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

registerTempRootCleanup();

describe("landing a workspace that another session is still in", () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = makeIsolationManager(() => {});
  });

  afterEach(async () => {
    await drainSnapshots(manager);
  });

  it("merge does NOT refuse while a co-tenant is present", async () => {
    const repo = await makeGitRepo();
    const owner = await manager.create({
      agentId: "claude-code",
      cwd: repo,
      workspace: { label: "shared-land" },
    });
    // Committed work, which is what a landing can actually carry.
    await fs.writeFile(path.join(owner.cwd, "work.txt"), "committed work\n");
    await exec("git", ["add", "-A"], { cwd: owner.cwd });
    await exec("git", ["commit", "-m", "work"], { cwd: owner.cwd });

    // A second session joins the same workspace.
    const guest = await manager.create({
      agentId: "claude-code",
      cwd: repo,
      workspace: { label: "shared-land", adopt: true },
    });
    expect(guest.cwd).toBe(owner.cwd);

    // Land it from the joiner, which is what a reviewer would do.
    const msg = await manager.runWorkspaceAction(guest.sessionId, "merge");

    expect(msg).toContain("Merged");
    // And the work actually arrived in the source tree.
    await expect(fs.readFile(path.join(repo, "work.txt"), "utf8")).resolves.toContain(
      "committed work",
    );
  });

  it("for contrast: discard DOES refuse while a co-tenant is present", async () => {
    const repo = await makeGitRepo();
    const owner = await manager.create({
      agentId: "claude-code",
      cwd: repo,
      workspace: { label: "shared-discard" },
    });
    const guest = await manager.create({
      agentId: "claude-code",
      cwd: repo,
      workspace: { label: "shared-discard", adopt: true },
    });
    expect(guest.cwd).toBe(owner.cwd);

    await expect(
      manager.runWorkspaceAction(guest.sessionId, "discard"),
    ).rejects.toThrow();
  });
});
