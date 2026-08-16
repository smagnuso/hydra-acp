// End-to-end: isolation failing open, and non-default providers.
//
// Isolation is best-effort by default: a directory that isn't a
// repository falls back to the source tree, and the client is told WHY
// rather than silently getting an unisolated session. `required: true`
// inverts that and fails session creation instead.
//
// One of six workspace-isolation-*.test.ts files split out of a single
// 2100-line suite so vitest can spread them across workers; shared
// fixtures live in workspace-isolation-harness.ts.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SessionManager } from "../core/session-manager.js";
import { buildHydraSessionMeta } from "../acp/types-session-list.js";
import {
  drainSnapshots,
  makeGitRepo,
  makeIsolationManager,
  makeTempDir,
  registerTempRootCleanup,
} from "./workspace-isolation-harness.js";

// See workspace-isolation-lifecycle.test.ts: real git, and these files
// no longer get the machine to themselves.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

registerTempRootCleanup();

describe("session isolation end-to-end: falling open and providers", () => {
  let manager: SessionManager;
  /** cwd the agent process was actually spawned with. */
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

  it("refuses to sync a copy workspace, rather than failing as a non-repository", async () => {
    // Sync is raw git in the workspace directory, and a copy workspace is
    // not a repository — the provider skips `.git` on purpose, so the copy
    // cannot pretend to have history. Left unguarded, `rev-parse HEAD`
    // there reports "not a git repository", which is a confusing way to
    // learn that a feature does not apply.
    //
    // And it genuinely does not apply: a sync needs a common base, which
    // is what `sharedHistory: false` denies. The manifest holds sizes and
    // mtimes, not content, so a 3-way is not reconstructible either.
    const plain = await makeTempDir("hydra-iso-copysync-");
    await fs.writeFile(path.join(plain, "note.txt"), "hello\n");
    const session = await manager.create({
      agentId: "claude-code",
      cwd: plain,
      workspace: { label: "nosync", provider: "copy" },
    });
    expect(session.workspace?.provider).toBe("copy");

    await expect(manager.runWorkspaceAction(session.sessionId, "sync")).rejects.toThrow(
      /no history to merge from/,
    );
    // Named the provider and offered the thing that does work.
    await expect(manager.runWorkspaceAction(session.sessionId, "sync")).rejects.toThrow(
      /workspace merge/,
    );
    // Untouched: a refusal is a no-op.
    expect(await fs.readFile(path.join(session.cwd, "note.txt"), "utf8")).toBe("hello\n");
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
