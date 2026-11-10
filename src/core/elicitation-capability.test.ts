import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clientCapabilitiesFor, HYDRA_CLIENT_CAPABILITIES } from "../acp/types-capabilities.js";
import { makeMockAgent } from "../__tests__/test-utils.js";
import { Registry, type RegistryAgent } from "./registry.js";
import { SessionManager, type SessionManagerOptions } from "./session-manager.js";
import { SessionStore } from "./session-store.js";
import { extractHydraMeta } from "../acp/types-hydra-meta.js";

const CWD = mkdtempSync(path.join(os.tmpdir(), "hydra-test-elicit-cap-"));

function fakeRegistry(): Registry {
  const agent: RegistryAgent = {
    id: "claude-code",
    name: "claude-code",
    distribution: { npx: { package: "claude-code" } },
  };
  return {
    async getAgent(id: string) {
      return id === "claude-code" ? agent : undefined;
    },
    async load() {
      return { version: "0", agents: [agent] };
    },
    async refresh() {
      return { version: "0", agents: [agent] };
    },
  } as unknown as Registry;
}

// The clientCapabilities of the first initialize the spawned agent saw.
async function capabilitiesSeen(
  run: (manager: SessionManager) => Promise<unknown>,
  options?: SessionManagerOptions,
): Promise<Record<string, unknown> | undefined> {
  const mock = makeMockAgent({ agentId: "claude-code", cwd: CWD });
  const request = mock.agent.connection.request as ReturnType<typeof vi.fn>;
  request.mockImplementation((method: string) => {
    if (method === "initialize") {
      return Promise.resolve({ protocolVersion: 1 });
    }
    if (method === "session/new") {
      return Promise.resolve({ sessionId: "u_cap" });
    }
    return Promise.resolve({});
  });
  const manager = new SessionManager(fakeRegistry(), () => mock.agent, undefined, options);
  await run(manager);
  const init = request.mock.calls.find((c) => c[0] === "initialize");
  return (init?.[1] as { clientCapabilities?: Record<string, unknown> } | undefined)
    ?.clientCapabilities;
}

describe("clientCapabilitiesFor", () => {
  it("keeps form elicitation when on and drops only that when off", () => {
    expect(clientCapabilitiesFor(true).elicitation).toEqual({ form: {} });
    const off = clientCapabilitiesFor(false);
    expect(off.elicitation).toBeUndefined();
    expect(off.auth).toEqual(HYDRA_CLIENT_CAPABILITIES.auth);
  });
});

describe("elicitation capability sent to a spawned agent", () => {
  it("is offered by default", async () => {
    const caps = await capabilitiesSeen((m) => m.create({ agentId: "claude-code", cwd: CWD }));
    expect(caps?.elicitation).toEqual({ form: {} });
  });

  it("is withheld when the daemon setting is off", async () => {
    const caps = await capabilitiesSeen(
      (m) => m.create({ agentId: "claude-code", cwd: CWD }),
      { elicitationForms: false },
    );
    expect(caps?.elicitation).toBeUndefined();
  });

  it("is withheld when the session opts out", async () => {
    const caps = await capabilitiesSeen((m) =>
      m.create({ agentId: "claude-code", cwd: CWD, elicitationForms: false }),
    );
    expect(caps?.elicitation).toBeUndefined();
  });

  it("a session cannot opt in past the daemon setting", async () => {
    const caps = await capabilitiesSeen(
      (m) => m.create({ agentId: "claude-code", cwd: CWD, elicitationForms: true }),
      { elicitationForms: false },
    );
    expect(caps?.elicitation).toBeUndefined();
  });

  it("a session created with the opt-out records it", async () => {
    const mock = makeMockAgent({ agentId: "claude-code", cwd: CWD });
    const request = mock.agent.connection.request as ReturnType<typeof vi.fn>;
    request.mockImplementation((method: string) =>
      Promise.resolve(
        method === "initialize"
          ? { protocolVersion: 1 }
          : method === "session/new"
            ? { sessionId: "u_rec" }
            : {},
      ),
    );
    const manager = new SessionManager(fakeRegistry(), () => mock.agent);
    const session = await manager.create({ agentId: "claude-code", cwd: CWD, elicitationForms: false });
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setImmediate(r));
    }
    const params = await manager.loadFromDisk(session.sessionId);
    expect(params?.elicitationForms).toBe(false);
  });

  it("the session's opt-out survives a cold resurrect", async () => {
    const store = new SessionStore();
    await store.write({
      sessionId: "hydra_elicit_off",
      cwd: CWD,
      agentId: "claude-code",
      upstreamSessionId: "u_off",
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      updatedAt: new Date(Date.now() - 30_000).toISOString(),
      attentionFlags: [],
      elicitationForms: false,
    });
    const mock = makeMockAgent({ agentId: "claude-code", cwd: CWD });
    const request = mock.agent.connection.request as ReturnType<typeof vi.fn>;
    request.mockImplementation((method: string) =>
      Promise.resolve(method === "initialize" ? { protocolVersion: 1 } : {}),
    );
    const manager = new SessionManager(fakeRegistry(), () => mock.agent, store);
    const params = await manager.loadFromDisk("hydra_elicit_off");
    expect(params?.elicitationForms).toBe(false);
    await manager.resurrect(params!);
    const init = request.mock.calls.find((c) => c[0] === "initialize");
    expect(
      (init?.[1] as { clientCapabilities: Record<string, unknown> }).clientCapabilities.elicitation,
    ).toBeUndefined();
  });
});

describe("session/new _meta", () => {
  it("parses elicitationForms: false", () => {
    expect(extractHydraMeta({ "hydra-acp": { elicitationForms: false } }).elicitationForms).toBe(false);
    expect(extractHydraMeta({ "hydra-acp": {} }).elicitationForms).toBeUndefined();
  });
});
