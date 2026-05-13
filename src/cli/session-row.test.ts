import { describe, it, expect } from "vitest";
import { toRow } from "./session-row.js";

describe("toRow agent column", () => {
  it("renders agent(model) when currentModel is present", () => {
    const r = toRow({
      sessionId: "hydra_session_xyz",
      cwd: "/work",
      agentId: "opencode",
      currentModel: "openai/gpt-5-codex",
      attachedClients: 1,
      updatedAt: new Date().toISOString(),
      status: "live",
    });
    expect(r.agent).toBe("opencode•gpt-5-codex");
  });

  it("renders just the agent id when currentModel is missing", () => {
    const r = toRow({
      sessionId: "hydra_session_xyz",
      cwd: "/work",
      agentId: "claude-acp",
      attachedClients: 0,
      updatedAt: new Date().toISOString(),
      status: "cold",
    });
    expect(r.agent).toBe("claude-acp");
  });

  it("appends whole-dollar cost suffix when currentUsage carries one", () => {
    const r = toRow({
      sessionId: "hydra_session_xyz",
      cwd: "/work",
      agentId: "opencode",
      currentModel: "openai/gpt-5-codex",
      currentUsage: { costAmount: 1.42, costCurrency: "USD" },
      attachedClients: 1,
      updatedAt: new Date().toISOString(),
      status: "live",
    });
    expect(r.agent).toBe("opencode•gpt-5-codex $1");
  });

  it("omits cost when it rounds to zero", () => {
    const r = toRow({
      sessionId: "hydra_session_xyz",
      cwd: "/work",
      agentId: "opencode",
      currentModel: "openai/gpt-5-codex",
      currentUsage: { costAmount: 0.9905, costCurrency: "USD" },
      attachedClients: 1,
      updatedAt: new Date().toISOString(),
      status: "live",
    });
    // Math.round(0.9905) === 1, so it shows $1; sub-50¢ would drop it.
    expect(r.agent).toBe("opencode•gpt-5-codex $1");
  });

  it("omits cost when only tokens are present", () => {
    const r = toRow({
      sessionId: "hydra_session_xyz",
      cwd: "/work",
      agentId: "opencode",
      currentModel: "openai/gpt-5-codex",
      currentUsage: { used: 1234, size: 200000 },
      attachedClients: 1,
      updatedAt: new Date().toISOString(),
      status: "live",
    });
    expect(r.agent).toBe("opencode•gpt-5-codex");
  });
});

describe("toRow state column", () => {
  const base = {
    sessionId: "hydra_session_xyz",
    cwd: "/work",
    agentId: "opencode",
    updatedAt: new Date().toISOString(),
  };

  it("renders LIVE(N) for live sessions with attached clients", () => {
    const r = toRow({ ...base, attachedClients: 2, status: "live" });
    expect(r.state).toBe("LIVE(2)");
  });

  it("renders LIVE(0) for live sessions with no clients attached", () => {
    const r = toRow({ ...base, attachedClients: 0, status: "live" });
    expect(r.state).toBe("LIVE(0)");
  });

  it("renders COLD for cold sessions", () => {
    const r = toRow({ ...base, attachedClients: 0, status: "cold" });
    expect(r.state).toBe("COLD");
  });
});
