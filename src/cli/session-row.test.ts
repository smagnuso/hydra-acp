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
    expect(r.agent).toBe("opencode(gpt-5-codex)");
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
});
