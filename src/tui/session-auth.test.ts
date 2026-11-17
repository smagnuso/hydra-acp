import { describe, expect, it, vi } from "vitest";
import { isSessionAuthError, recoverSessionAuth, replayNeedsSessionAuth } from "./session-auth.js";
import type { RenderEvent } from "../core/render-update.js";
import { handleAuthMethodSelection, type TerminalAuthPlan } from "./auth-required-banner.js";
import { JsonRpcErrorCodes } from "../acp/types-jsonrpc.js";

function harness() {
  return {
    isLocal: true,
    agentId: "claude-personal",
    sessionId: "hydra_session_personal",
    request: vi.fn().mockResolvedValue({ authMethods: [{ id: "claude-login" }] }),
    showBanner: vi.fn().mockResolvedValue("terminal-completed"),
    suspend: vi.fn(),
    resume: vi.fn(),
  };
}

describe("session authentication recovery", () => {
  const authFailure: RenderEvent = {
    kind: "turn-complete", stopReason: "error", errorMessage: "Authentication required",
  };

  it("offers login when attaching to a session whose last turn failed authentication", () => {
    expect(replayNeedsSessionAuth([
      { kind: "user-text", text: "test" },
      { kind: "agent-text", text: "Failed to authenticate: this login reached its time limit and cannot be renewed." },
      authFailure,
      { kind: "usage-update", used: 100 },
    ])).toBe(true);
  });

  it("ignores an old auth failure after a later successful, active or unrelated failing turn", () => {
    expect(replayNeedsSessionAuth([authFailure, { kind: "turn-complete", stopReason: "end_turn" }])).toBe(false);
    expect(replayNeedsSessionAuth([authFailure, { kind: "user-text", text: "try again" }])).toBe(false);
    expect(replayNeedsSessionAuth([authFailure, { kind: "turn-started", unsolicited: true }])).toBe(false);
    expect(replayNeedsSessionAuth([authFailure, { kind: "turn-complete", stopReason: "error", errorMessage: "Connection closed" }])).toBe(false);
    expect(replayNeedsSessionAuth([])).toBe(false);
  });

  it("does not treat quoted login instructions in ordinary assistant output as an auth failure", () => {
    expect(replayNeedsSessionAuth([
      { kind: "agent-text", text: "Run claude auth login if you need to sign in." },
      { kind: "turn-complete", stopReason: "end_turn" },
    ])).toBe(false);
  });
  it("recognizes structured auth errors and narrowly scoped legacy messages", () => {
    expect(isSessionAuthError({ code: JsonRpcErrorCodes.AuthRequired })).toBe(true);
    expect(isSessionAuthError(new Error("Authentication required"))).toBe(true);
    expect(isSessionAuthError(new Error("Failed to authenticate: this login reached its time limit and cannot be renewed. Run claude auth login"))).toBe(true);
    expect(isSessionAuthError(new Error("Tool failed: Authentication required"))).toBe(false);
    expect(isSessionAuthError(new Error("Connection closed"))).toBe(false);
    expect(isSessionAuthError(null)).toBe(false);
  });

  it("discovers the personal agent's methods and restores the screen after login", async () => {
    const deps = harness();
    expect(await recoverSessionAuth(deps)).toContain("not resent automatically");
    expect(deps.request).toHaveBeenCalledOnce();
    expect(deps.request).toHaveBeenCalledWith("hydra-acp/agents/auth_methods", {
      agentId: "claude-personal",
    });
    expect(deps.showBanner).toHaveBeenCalledWith([{ id: "claude-login" }], expect.any(Function));
    expect(deps.suspend).toHaveBeenCalledOnce();
    expect(deps.resume).toHaveBeenCalledOnce();
  });

  it("drives daemon authentication with the session identity and preserves its resolved environment", async () => {
    const deps = harness();
    const plan = {
      kind: "terminal",
      command: "/opt/claude/node",
      args: ["/opt/claude/cli.js", "auth", "login", "--claudeai"],
      env: {
        PATH: "/opt/claude:/usr/bin",
        CLAUDE_CONFIG_DIR: "/home/user/.claude-personal",
        ANTHROPIC_BASE_URL: "https://api.anthropic.com",
        CLAUDE_CODE_ENABLE_TELEMETRY: "0",
      },
      cwd: "/home/user",
    };
    deps.request.mockResolvedValueOnce({ authMethods: [{ id: "claude-login" }] })
      .mockResolvedValueOnce(plan);
    const runTerminalAuth = vi.fn().mockResolvedValue({ exitCode: 0 });
    deps.showBanner.mockImplementation(async (methods, authenticate) => {
      const result = await handleAuthMethodSelection(methods[0], { authenticate, runTerminalAuth });
      return result.kind;
    });
    await recoverSessionAuth(deps);
    expect(deps.request).toHaveBeenLastCalledWith("authenticate", {
      methodId: "claude-login",
      _meta: { "hydra-acp": {
        agentId: "claude-personal",
        sessionId: "hydra_session_personal",
      } },
    });
    expect(runTerminalAuth).toHaveBeenCalledWith({
      command: plan.command, args: plan.args, env: plan.env, cwd: plan.cwd,
    } satisfies TerminalAuthPlan);
  });

  it("does not execute a remote daemon's login plan locally", async () => {
    const deps = { ...harness(), isLocal: false };
    expect(await recoverSessionAuth(deps)).toContain("hydra agent auth claude-personal");
    expect(deps.request).not.toHaveBeenCalled();
    expect(deps.suspend).not.toHaveBeenCalled();
  });

  it("handles agents without interactive methods", async () => {
    const deps = harness();
    deps.request.mockResolvedValue({});
    expect(await recoverSessionAuth(deps)).toContain("no login methods");
    expect(deps.suspend).not.toHaveBeenCalled();
  });

  it("restores the screen if the login dialog fails", async () => {
    const deps = harness();
    deps.showBanner.mockRejectedValue(new Error("disconnected"));
    await expect(recoverSessionAuth(deps)).rejects.toThrow("disconnected");
    expect(deps.resume).toHaveBeenCalledOnce();
  });

  it("does not report success after cancelling", async () => {
    const deps = harness();
    deps.showBanner.mockResolvedValue("cancel");
    expect(await recoverSessionAuth(deps)).toBeUndefined();
    expect(deps.resume).toHaveBeenCalledOnce();
  });
});
