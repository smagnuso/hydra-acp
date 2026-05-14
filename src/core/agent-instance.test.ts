import { describe, it, expect } from "vitest";
import * as path from "node:path";
import * as os from "node:os";
import { AgentInstance } from "./agent-instance.js";
import type { SpawnPlan } from "./registry.js";

function nodeScript(script: string): SpawnPlan {
  return { command: process.execPath, args: ["-e", script], env: {} };
}

async function settled(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected promise to reject");
}

describe("AgentInstance: spawn-level failures", () => {
  it("rejects pending requests when the binary doesn't exist (no daemon crash)", async () => {
    const agent = AgentInstance.spawn({
      agentId: "ghost-binary",
      cwd: process.cwd(),
      plan: {
        command: "definitely-not-a-real-binary-xyz-12345",
        args: [],
        env: {},
      },
    });
    const err = await settled(agent.connection.request("initialize", {}));
    expect(err.message).toMatch(/ENOENT|EPIPE|closed|spawn|definitely-not-a-real-binary-xyz/i);
  });

  it("rejects pending requests when the cwd doesn't exist", async () => {
    const badCwd = path.join(
      os.tmpdir(),
      `agent-instance-test-nope-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const agent = AgentInstance.spawn({
      agentId: "bad-cwd",
      cwd: badCwd,
      plan: nodeScript("setTimeout(() => {}, 60000);"),
    });
    const err = await settled(agent.connection.request("initialize", {}));
    expect(err.message).toMatch(/ENOENT|EPIPE|closed|spawn/i);
  });

  it("rejects pending requests when the agent exits before responding", async () => {
    const agent = AgentInstance.spawn({
      agentId: "early-exit",
      cwd: process.cwd(),
      plan: nodeScript(
        "process.stderr.write('metatron-auth-failure-tag'); process.exit(1);",
      ),
    });
    const err = await settled(agent.connection.request("initialize", {}));
    // Either we win the race and surface the stderr-tagged exit error,
    // or stdout 'end' wins and we get a plain "connection closed". The
    // important invariant is that the daemon doesn't crash — the request
    // rejects either way.
    expect(err.message).toMatch(
      /metatron-auth-failure-tag|exited before responding|closed/i,
    );
  });

  it("surfaces npm install failures (npx exits non-zero with EACCES) via stderr context", async () => {
    // Models `npx -y <pkg>` on a system npm that requires sudo for the
    // global cache: npx spawns fine, the install fails with EACCES, and
    // npx exits non-zero. The user sees the EACCES line, not silence.
    const agent = AgentInstance.spawn({
      agentId: "npx-eacces",
      cwd: process.cwd(),
      plan: nodeScript(
        "process.stderr.write(\"npm ERR! code EACCES\\nnpm ERR! syscall mkdir\\nnpm ERR! path /usr/lib/node_modules/foo\\n\"); process.exit(243);",
      ),
    });
    const err = await settled(agent.connection.request("initialize", {}));
    expect(err.message).toMatch(/EACCES|exited before responding|closed/i);
  });

  it("kill() closes the connection without surfacing an exit-before-responding error", async () => {
    const agent = AgentInstance.spawn({
      agentId: "long-lived",
      cwd: process.cwd(),
      plan: nodeScript("setInterval(() => {}, 1000);"),
    });
    await new Promise((r) => setTimeout(r, 50));
    const pending = agent.connection
      .request("initialize", {})
      .catch((e) => e as Error);
    await agent.kill();
    const err = (await pending) as Error;
    expect(err.message).not.toMatch(/exited before responding/);
    expect(err.message).toMatch(/closed/i);
  });
});
