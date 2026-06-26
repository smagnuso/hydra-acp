import { describe, expect, it } from "vitest";
import type { AgentInstance } from "./agent-instance.js";
import { enrichBringupFailure } from "./session-manager.js";
import { JsonRpcErrorCodes } from "../acp/types-jsonrpc.js";

function fakeAgent(agentId: string, stderrTail: string): AgentInstance {
  return {
    agentId,
    stderrTailText: () => stderrTail,
  } as unknown as AgentInstance;
}

describe("enrichBringupFailure", () => {
  it("folds the agent's stderr tail into a bare connection-closed error", () => {
    const err = new Error("connection closed");
    const out = enrichBringupFailure(
      err,
      fakeAgent("opencode-dev", "error: Cannot find module 'x'"),
      "opencode-dev",
    ) as Error;
    expect(out).toBeInstanceOf(Error);
    expect(out.message).toContain("agent opencode-dev failed to start");
    expect(out.message).toContain("connection closed");
    expect(out.message).toContain("stderr: error: Cannot find module 'x'");
  });

  it("appends a copy-pasteable repro command line when spawn info is given", () => {
    const err = new Error("connection closed");
    const out = enrichBringupFailure(err, fakeAgent("opencode-dev", "boom"), "opencode-dev", {
      command: "bun",
      args: ["run", "./packages/opencode/src/index.ts"],
      cwd: "/home/me/dev/opencode",
    }) as Error;
    expect(out.message).toContain(
      "to reproduce: (cd /home/me/dev/opencode && bun run ./packages/opencode/src/index.ts)",
    );
  });

  it("adds the repro line even when the agent printed no stderr", () => {
    const err = new Error("connection closed");
    const out = enrichBringupFailure(err, fakeAgent("a", ""), "a", {
      command: "node",
      args: ["agent.js"],
      cwd: "/tmp/w",
    }) as Error;
    expect(out).not.toBe(err);
    expect(out.message).toContain("to reproduce: (cd /tmp/w && node agent.js)");
  });

  it("shell-quotes args containing spaces or metacharacters in the repro line", () => {
    const err = new Error("connection closed");
    const out = enrichBringupFailure(err, fakeAgent("a", ""), "a", {
      command: "node",
      args: ["--flag", "a b", "x'y"],
      cwd: "/tmp/w",
    }) as Error;
    expect(out.message).toContain("node --flag 'a b' 'x'\\''y'");
  });

  it("passes AUTH_REQUIRED through untouched so enrichAuthRequired still sees it", () => {
    const err = Object.assign(new Error("auth required"), {
      code: JsonRpcErrorCodes.AuthRequired,
    });
    const out = enrichBringupFailure(err, fakeAgent("claude-code", "noise"), "claude-code");
    expect(out).toBe(err);
  });

  it("leaves the error untouched when the agent captured no stderr", () => {
    const err = new Error("connection closed");
    const out = enrichBringupFailure(err, fakeAgent("a", ""), "a");
    expect(out).toBe(err);
  });

  it("does not double-wrap an error that already carries a stderr tail", () => {
    const err = new Error("agent a exited before responding (code=1)\nstderr: boom");
    const out = enrichBringupFailure(err, fakeAgent("a", "boom"), "a");
    expect(out).toBe(err);
  });

  it("preserves a numeric error code and data when enriching", () => {
    const err = Object.assign(new Error("nope"), {
      code: JsonRpcErrorCodes.AgentNotInstalled,
      data: { detail: 42 },
    });
    const out = enrichBringupFailure(err, fakeAgent("a", "tail"), "a") as Error & {
      code?: number;
      data?: unknown;
    };
    expect(out).not.toBe(err);
    expect(out.code).toBe(JsonRpcErrorCodes.AgentNotInstalled);
    expect(out.data).toEqual({ detail: 42 });
  });
});
