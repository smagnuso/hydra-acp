import { describe, it, expect } from "vitest";
import { toRow } from "./session-row.js";

describe("toRow agent column", () => {
  it("renders just the agent id (model is intentionally omitted)", () => {
    const r = toRow({
      sessionId: "hydra_session_xyz",
      cwd: "/work",
      agentId: "opencode",
      attachedClients: 1,
      updatedAt: new Date().toISOString(),
      status: "live",
    });
    expect(r.agent).toBe("opencode");
  });

  it("renders the agent id for cold sessions too", () => {
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
      currentUsage: { costAmount: 1.42, costCurrency: "USD" },
      attachedClients: 1,
      updatedAt: new Date().toISOString(),
      status: "live",
    });
    expect(r.agent).toBe("opencode $1");
  });

  it("omits cost when it rounds to zero", () => {
    const r = toRow({
      sessionId: "hydra_session_xyz",
      cwd: "/work",
      agentId: "opencode",
      currentUsage: { costAmount: 0.9905, costCurrency: "USD" },
      attachedClients: 1,
      updatedAt: new Date().toISOString(),
      status: "live",
    });
    expect(r.agent).toBe("opencode $1");
  });

  it("omits cost when only tokens are present", () => {
    const r = toRow({
      sessionId: "hydra_session_xyz",
      cwd: "/work",
      agentId: "opencode",
      currentUsage: { used: 1234, size: 200000 },
      attachedClients: 1,
      updatedAt: new Date().toISOString(),
      status: "live",
    });
    expect(r.agent).toBe("opencode");
  });
});

describe("toRow upstream column", () => {
  const base = {
    sessionId: "hydra_session_xyz",
    cwd: "/work",
    agentId: "opencode",
    attachedClients: 0,
    updatedAt: new Date().toISOString(),
    status: "cold" as const,
  };

  it("renders the local upstream id when it's bound", () => {
    const r = toRow({ ...base, upstreamSessionId: "u_abc" });
    expect(r.upstream).toBe("u_abc");
  });

  it("renders ← <host> when upstream is empty but the origin host is known", () => {
    const r = toRow({
      ...base,
      upstreamSessionId: "",
      importedFromMachine: "build-host",
    });
    expect(r.upstream).toBe("← build-host");
  });

  it("prefers the bound upstream id over the import-host breadcrumb", () => {
    const r = toRow({
      ...base,
      upstreamSessionId: "u_local",
      importedFromMachine: "build-host",
    });
    expect(r.upstream).toBe("u_local");
  });

  it("falls back to - when neither upstream nor origin host is known", () => {
    const r = toRow({ ...base });
    expect(r.upstream).toBe("-");
  });
});

describe("toRow state column", () => {
  const base = {
    sessionId: "hydra_session_xyz",
    cwd: "/work",
    agentId: "opencode",
    updatedAt: new Date().toISOString(),
  };

  it("renders LIVE for an idle live session", () => {
    const r = toRow({ ...base, attachedClients: 0, status: "live" });
    expect(r.state).toBe("LIVE");
  });

  it("renders LIVE• for a live session that is mid-turn", () => {
    const r = toRow({ ...base, attachedClients: 1, status: "live", busy: true });
    expect(r.state).toBe("LIVE•");
  });

  it("renders LIVE◦ for a live session awaiting user input", () => {
    const r = toRow({
      ...base,
      attachedClients: 1,
      status: "live",
      busy: true,
      awaitingInput: true,
    });
    expect(r.state).toBe("LIVE◦");
  });

  it("awaiting input wins over busy on the state glyph", () => {
    const r = toRow({
      ...base,
      attachedClients: 1,
      status: "live",
      busy: false,
      awaitingInput: true,
    });
    expect(r.state).toBe("LIVE◦");
  });

  it("renders COLD for cold sessions regardless of busy flag", () => {
    const r = toRow({ ...base, attachedClients: 0, status: "cold", busy: true });
    expect(r.state).toBe("COLD");
  });
});
