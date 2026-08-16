// Shared fixtures for the workspace-isolation end-to-end suites.
//
// These tests were one 2100-line file and 83 `it`s. Vitest parallelizes
// across FILES, not within them, so the whole suite ran serially on a
// single worker: ~144s of the ~150s total wall clock, and because the
// reporter only prints a file's results once the file finishes, it also
// meant two and a half minutes of no output at all. Split by topic into
// workspace-isolation-*.test.ts, each importing this.
//
// Every split file keeps its own `manager` / `spawnedCwd` locals so the
// test bodies are untouched — see the header comment on any of them.

import { afterEach, vi } from "vitest";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { SessionManager } from "../core/session-manager.js";
import { Registry, type RegistryAgent } from "../core/registry.js";
import { JsonRpcConnection } from "../acp/connection.js";
import { type AttachedClient } from "../core/session.js";
import { makeMockAgent, makeControlledStream } from "./test-utils.js";

export const exec = promisify(execFile);

export function makeClient(): { client: AttachedClient } {
  const conn = new JsonRpcConnection(makeControlledStream());
  return {
    client: {
      clientId: `c_${Math.random().toString(36).slice(2, 8)}`,
      connection: conn,
    } as AttachedClient,
  };
}

const tempRoots: string[] = [];

export async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpath(dir);
}

export async function makeGitRepo(): Promise<string> {
  const dir = await makeTempDir("hydra-iso-repo-");
  await fs.writeFile(path.join(dir, "tracked.txt"), "original\n");
  await exec("git", ["init", "-b", "main"], { cwd: dir });
  await exec("git", ["config", "user.email", "t@e.invalid"], { cwd: dir });
  await exec("git", ["config", "user.name", "T"], { cwd: dir });
  await exec("git", ["add", "-A"], { cwd: dir });
  await exec("git", ["commit", "-q", "-m", "initial"], { cwd: dir });
  return dir;
}

/**
 * Removes every temp tree this module handed out.
 *
 * Registered at FILE level by each split suite, so it runs after the
 * describe-level snapshot drain — order that matters, see drainSnapshots.
 */
export function registerTempRootCleanup(): void {
  afterEach(async () => {
    await Promise.all(
      tempRoots
        .splice(0)
        .map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });
}

export function fakeRegistry(): Registry {
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

/**
 * A SessionManager whose agent spawns are mocked.
 *
 * `onSpawn` receives the cwd the agent process was actually given, which
 * is the thing most of these tests assert on.
 */
export function makeIsolationManager(
  onSpawn: (cwd: string) => void,
): SessionManager {
  return new SessionManager(fakeRegistry(), (opts: { cwd: string }) => {
    onSpawn(opts.cwd);
    const m = makeMockAgent({ agentId: "claude-code", cwd: opts.cwd });
    const requestMock = m.agent.connection.request as ReturnType<typeof vi.fn>;
    requestMock
      .mockResolvedValueOnce({ protocolVersion: 1 })
      .mockResolvedValueOnce({ sessionId: "u_new" });
    return m.agent;
  });
}

/**
 * Waits out the fire-and-forget workspace autosave.
 *
 * Autosave deliberately runs git in the workspace after a turn completes,
 * off the critical path. That makes it invisible to any test that awaits
 * only the command it called, and it outlives the test: the temp-root
 * cleanup can be deleting the repo while git is still writing to
 * .git/worktrees/<label>. Only tests that drive a REAL turn arm it, which
 * is why this stayed hidden while every test called runWorkspaceAction
 * directly.
 *
 * Call from a describe-level afterEach so it drains before the file-level
 * cleanup removes the trees.
 */
export async function drainSnapshots(manager: SessionManager): Promise<void> {
  const inFlight = (manager as unknown as { snapshotInFlight: Set<string> })
    .snapshotInFlight;
  for (let i = 0; i < 200 && inFlight.size > 0; i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
}
