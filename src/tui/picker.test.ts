import { describe, expect, it } from "vitest";
import { filterByHost, matchesSearch, nextHostFilter } from "./picker.js";
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

describe("nextHostFilter", () => {
  const sessions = [
    { importedFromMachine: undefined },
    { importedFromMachine: "machine-b" },
    { importedFromMachine: "machine-a" },
    { importedFromMachine: "machine-b" },
  ];

  it("cycles local → first peer → next peer → all → local", () => {
    expect(nextHostFilter("__local", sessions)).toBe("machine-a");
    expect(nextHostFilter("machine-a", sessions)).toBe("machine-b");
    expect(nextHostFilter("machine-b", sessions)).toBe("__all");
    expect(nextHostFilter("__all", sessions)).toBe("__local");
  });

  it("collapses to local → all → local when there are no peers", () => {
    const onlyLocal = [{ importedFromMachine: undefined }];
    expect(nextHostFilter("__local", onlyLocal)).toBe("__all");
    expect(nextHostFilter("__all", onlyLocal)).toBe("__local");
  });

  it("resets to local when the current value no longer appears", () => {
    // Mimics the post-refresh case where a peer host vanished from
    // allSessions while its hostname was selected.
    const drained = [{ importedFromMachine: "machine-a" }];
    expect(nextHostFilter("machine-z", drained)).toBe("__local");
  });

  it("drops peer hosts whose imports have all been bound to a local agent", () => {
    // machine-b's only session has been attached locally, so its
    // host bucket would be empty — skip it in the cycle.
    const mixed = [
      { importedFromMachine: "machine-a" },
      { importedFromMachine: "machine-b", upstreamSessionId: "u_abc" },
    ];
    expect(nextHostFilter("__local", mixed)).toBe("machine-a");
    expect(nextHostFilter("machine-a", mixed)).toBe("__all");
  });
});

describe("filterByHost", () => {
  // session() returns a DiscoveredSession-shaped fixture with only the
  // fields filterByHost reads — the rest of the type is bypassed via
  // the cast.
  const session = (
    overrides: Partial<DiscoveredSession>,
  ): DiscoveredSession =>
    ({
      sessionId: "hydra-abc",
      cwd: "/w",
      updatedAt: "2026-05-20T00:00:00Z",
      attachedClients: 0,
      status: "cold",
      ...overrides,
    }) as DiscoveredSession;

  it("__local: includes locally-created sessions", () => {
    const s = session({});
    expect(filterByHost([s], "__local")).toEqual([s]);
  });

  it("__local: includes imports that have been bound to a local agent", () => {
    const s = session({
      importedFromMachine: "broom",
      upstreamSessionId: "u_local",
    });
    expect(filterByHost([s], "__local")).toEqual([s]);
  });

  it("__local: excludes passive mirrors (imported, no local upstream)", () => {
    const s = session({ importedFromMachine: "broom" });
    expect(filterByHost([s], "__local")).toEqual([]);
  });

  it("<host>: includes passive mirrors from that host only", () => {
    const passive = session({ importedFromMachine: "broom" });
    const attached = session({
      importedFromMachine: "broom",
      upstreamSessionId: "u_local",
    });
    const otherPeer = session({ importedFromMachine: "dustpan" });
    expect(
      filterByHost([passive, attached, otherPeer], "broom"),
    ).toEqual([passive]);
  });

  it("__all: includes everything", () => {
    const items = [
      session({}),
      session({ importedFromMachine: "broom" }),
      session({
        importedFromMachine: "broom",
        upstreamSessionId: "u_local",
      }),
    ];
    expect(filterByHost(items, "__all")).toEqual(items);
  });
});
