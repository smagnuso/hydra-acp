import { describe, expect, it } from "vitest";
import { matchesSearch } from "./picker.js";
import type { DiscoveredSession } from "./discovery.js";

function session(overrides: Partial<DiscoveredSession>): DiscoveredSession {
  return {
    sessionId: "hydra-abc123",
    cwd: "/home/me/work/project",
    updatedAt: "2026-05-14T10:00:00Z",
    attachedClients: 0,
    status: "cold",
    ...overrides,
  };
}

describe("matchesSearch", () => {
  it("returns true for empty term (no filter)", () => {
    expect(matchesSearch(session({}), "")).toBe(true);
  });

  it("matches the short session id case-insensitively", () => {
    const s = session({ sessionId: "hydra-ABC123" });
    expect(matchesSearch(s, "abc")).toBe(true);
    expect(matchesSearch(s, "AbC1")).toBe(true);
    expect(matchesSearch(s, "xyz")).toBe(false);
  });

  it("matches the agent id", () => {
    const s = session({ agentId: "claude-code" });
    expect(matchesSearch(s, "claude")).toBe(true);
    expect(matchesSearch(s, "CODE")).toBe(true);
  });

  it("matches the title", () => {
    const s = session({ title: "Refactor auth flow" });
    expect(matchesSearch(s, "auth")).toBe(true);
    expect(matchesSearch(s, "AUTH")).toBe(true);
  });

  it("matches the upstream session id", () => {
    const s = session({ upstreamSessionId: "session_abc_456" });
    expect(matchesSearch(s, "session_abc")).toBe(true);
  });

  it("matches the raw cwd path", () => {
    const s = session({ cwd: "/home/me/work/hydra-acp/cli" });
    expect(matchesSearch(s, "hydra-acp")).toBe(true);
    expect(matchesSearch(s, "CLI")).toBe(true);
  });

  it("matches the home-shortened cwd (tilde form)", () => {
    const home = process.env.HOME ?? "";
    if (home.length === 0) {
      return;
    }
    const s = session({ cwd: `${home}/projects/foo` });
    expect(matchesSearch(s, "~/projects")).toBe(true);
  });

  it("does not match unrelated terms", () => {
    const s = session({
      sessionId: "hydra-abc123",
      agentId: "claude",
      cwd: "/home/me/work",
      title: "thing",
    });
    expect(matchesSearch(s, "nothing-matches-here")).toBe(false);
  });
});
