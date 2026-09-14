// End-to-end: adopting an existing workspace at session creation.
//
// `start`'s join seats a session beside a LIVE host and deliberately
// suffixes past a dormant workspace — a human typing `start` over an
// abandoned name does not mean "adopt what I walked away from." A caller
// that provisioned the workspace itself and brings a second session to it
// later (a retried task resuming in its own tree, a reviewer sent to the
// tree the work happened in) means exactly that, and says so with
// `workspace: { label, adopt: true }`.
//
// Sibling of workspace-isolation-join.test.ts; shared fixtures live in
// workspace-isolation-harness.ts.

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

describe("session isolation end-to-end: adopting an existing workspace", () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = makeIsolationManager(() => {});
  });

  afterEach(async () => {
    await drainSnapshots(manager);
  });

  it("adopts a DORMANT workspace rather than suffixing past it", async () => {
    // The case `start` refuses on purpose and this flag exists for: the
    // session that made the workspace is gone, and a later one needs the
    // tree it left behind.
    const repo = await makeGitRepo();
    const first = await manager.create({
      agentId: "claude-code",
      cwd: repo,
      workspace: { label: "T1" },
    });
    const wsPath = first.cwd;
    expect(first.workspace?.label).toBe("T1");
    // Work left behind uncommitted, which is what a worker that never
    // commits leaves and what an adopter most needs to see.
    await fs.writeFile(path.join(wsPath, "left-behind.txt"), "prior attempt\n");
    // Close the session, which is what `child_session/close` does and so
    // what a finished worker actually goes through — not `stop`, which
    // would land the work and defeat the point.
    await first.close({ deleteRecord: false, by: "test" });

    const second = await manager.create({
      agentId: "claude-code",
      cwd: repo,
      workspace: { label: "T1", adopt: true },
    });

    expect(second.cwd).toBe(wsPath);
    expect(second.workspace?.label).toBe("T1");
    // The whole point: same tree, prior work visible, no second checkout.
    await expect(
      fs.readFile(path.join(second.cwd, "left-behind.txt"), "utf8"),
    ).resolves.toContain("prior attempt");
    const branches = await exec("git", ["branch", "--list", "hydra/*"], { cwd: repo });
    expect(branches.stdout).not.toContain("hydra/T1-2");
  });

  it("adopts a workspace a live session is still in (co-tenancy)", async () => {
    const repo = await makeGitRepo();
    const owner = await manager.create({
      agentId: "claude-code",
      cwd: repo,
      workspace: { label: "T2" },
    });

    const guest = await manager.create({
      agentId: "claude-code",
      cwd: repo,
      workspace: { label: "T2", adopt: true },
    });

    expect(guest.cwd).toBe(owner.cwd);
    expect(guest.workspace?.label).toBe("T2");
    const branches = await exec("git", ["branch", "--list", "hydra/*"], { cwd: repo });
    expect(branches.stdout).not.toContain("hydra/T2-2");
  });

  it("fails when there is no such workspace, rather than creating one", async () => {
    // Silently provisioning a fresh workspace would hand back a tree that
    // lacks the work the caller asked to work in — the exact failure this
    // flag prevents, so a miss must be loud.
    const repo = await makeGitRepo();

    await expect(
      manager.create({
        agentId: "claude-code",
        cwd: repo,
        workspace: { label: "nope", adopt: true },
      }),
    ).rejects.toThrow(/cannot adopt workspace "nope"/);

    const branches = await exec("git", ["branch", "--list", "hydra/*"], { cwd: repo });
    expect(branches.stdout.trim()).toBe("");
  });

  it("fails on a miss even when required is false", async () => {
    // required:false is fail-OPEN for provisioning (fall back to the
    // source tree). Adopt does not honour it: falling back would be the
    // silent-wrong-tree outcome, not a graceful degradation.
    const repo = await makeGitRepo();

    await expect(
      manager.create({
        agentId: "claude-code",
        cwd: repo,
        workspace: { label: "nope", adopt: true, required: false },
      }),
    ).rejects.toThrow(/cannot adopt workspace "nope"/);
  });

  it("requires a label", async () => {
    const repo = await makeGitRepo();

    await expect(
      manager.create({
        agentId: "claude-code",
        cwd: repo,
        workspace: { adopt: true },
      }),
    ).rejects.toThrow(/requires workspace\.label/);
  });

  it("does NOT rewrite the landing anchor", async () => {
    // The subtle one. The anchor is written at creation and points at the
    // base commit. Rewriting it on adopt to the workspace's CURRENT state
    // would make the next landing treat the earlier session's work as the
    // anchor and exclude it from the replay — silently dropping it.
    const repo = await makeGitRepo();
    const first = await manager.create({
      agentId: "claude-code",
      cwd: repo,
      workspace: { label: "T3" },
    });
    const wsPath = first.cwd;
    const anchors = async () =>
      (
        await exec("git", ["for-each-ref", "--format=%(refname) %(objectname)", "refs/hydra/"], {
          cwd: repo,
        })
      ).stdout.trim();
    const before = await anchors();

    await fs.writeFile(path.join(wsPath, "work.txt"), "work that must survive\n");
    // Close the session, which is what `child_session/close` does and so
    // what a finished worker actually goes through — not `stop`, which
    // would land the work and defeat the point.
    await first.close({ deleteRecord: false, by: "test" });

    await manager.create({
      agentId: "claude-code",
      cwd: repo,
      workspace: { label: "T3", adopt: true },
    });

    // Adopting disturbs no anchor: not the start ref, not the landing
    // baseline, not the autosave.
    expect(await anchors()).toBe(before);
  });
});
