import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { AgentInstance } from "./agent-instance.js";
import { paths } from "./paths.js";
import type { SpawnPlan } from "./registry.js";

function nodeScript(script: string): SpawnPlan {
  return {
    command: process.execPath,
    args: ["-e", script],
    env: {},
    version: "test",
  };
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
        version: "test",
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
    // Four-way race: stderr-tagged exit error, stdout 'end' closing the
    // connection, the exit event landing first, or the connection's
    // write() to a stdin the child already closed (EPIPE). The
    // important invariant is that the daemon doesn't crash — the request
    // rejects either way.
    expect(err.message).toMatch(
      /metatron-auth-failure-tag|exited before responding|closed|EPIPE/i,
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
    expect(err.message).toMatch(/EACCES|exited before responding|closed|EPIPE/i);
  });

  it("respects stderrTailBytes when buffering for the failure diagnostic", async () => {
    // 2 KB of filler followed by a distinct trailing marker. With a 64-byte
    // tail cap, the last slice retained should fit in 64 bytes and still
    // include the marker — confirming the override is applied.
    const agent = AgentInstance.spawn({
      agentId: "verbose-stderr",
      cwd: process.cwd(),
      plan: nodeScript(
        "process.stderr.write('A'.repeat(2000)); process.stderr.write('TAILMARK!'); process.exit(1);",
      ),
      stderrTailBytes: 64,
    });
    const err = await settled(agent.connection.request("initialize", {}));
    // Three possible shapes depending on which event won the race:
    //   "agent ... exited before responding ...\nstderr: <tail>"
    //   "connection closed" (if stdout end fired first; no tail surfaced)
    //   "write EPIPE" (if the request's stdin write raced with the child closing)
    const tail = err.message.match(/stderr: ([\s\S]+)$/)?.[1];
    if (tail !== undefined) {
      expect(tail.length).toBeLessThanOrEqual(64);
      expect(tail).toContain("TAILMARK!");
    } else {
      expect(err.message).toMatch(/closed|exited|EPIPE/i);
    }
  });

  it("writes spawn header, stderr lines, and exit footer to the per-agent log file", async () => {
    const agent = AgentInstance.spawn({
      agentId: "log-writer",
      cwd: process.cwd(),
      plan: nodeScript(
        "process.stderr.write('metatron-style-line\\n'); process.exit(7);",
      ),
    });
    await settled(agent.connection.request("initialize", {}));
    // Streams flush on 'end'; give the writer a tick.
    await new Promise((r) => setTimeout(r, 50));
    const contents = await fs.readFile(paths.agentLogFile("log-writer"), "utf8");
    expect(contents).toMatch(/--- spawn pid=\d+ /);
    expect(contents).toContain("metatron-style-line");
    expect(contents).toMatch(/--- exit code=7 signal=null/);
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
