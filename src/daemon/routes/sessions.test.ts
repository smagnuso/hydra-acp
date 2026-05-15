import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import { registerSessionRoutes } from "./sessions.js";
import { SessionManager } from "../../core/session-manager.js";
import { Registry, type RegistryAgent } from "../../core/registry.js";
import {
  makeMockAgent,
  makeControlledStream,
  type MockAgentControls,
} from "../../__tests__/test-utils.js";
import { JsonRpcConnection } from "../../acp/connection.js";

function fakeRegistryAgent(id = "claude-code"): RegistryAgent {
  return { id, name: id, distribution: { npx: { package: id } } };
}

function fakeRegistry(agents: RegistryAgent[]): Registry {
  return {
    async getAgent(id: string) {
      return agents.find((a) => a.id === id);
    },
    async load() {
      return { version: "0", agents };
    },
    async refresh() {
      return { version: "0", agents };
    },
  } as unknown as Registry;
}

interface Harness {
  app: FastifyInstance;
  manager: SessionManager;
  mocks: MockAgentControls[];
  baseUrl: string;
}

async function buildHarness(): Promise<Harness> {
  const mocks: MockAgentControls[] = [];
  const manager = new SessionManager(
    fakeRegistry([fakeRegistryAgent("claude-code")]),
    () => {
      const m = makeMockAgent({ agentId: "claude-code", cwd: "/w" });
      mocks.push(m);
      const requestMock = m.agent.connection.request as ReturnType<typeof vi.fn>;
      requestMock
        .mockResolvedValueOnce({ protocolVersion: 1 })
        .mockResolvedValueOnce({ sessionId: `u_${mocks.length}` });
      return m.agent;
    },
  );
  const app = Fastify();
  registerSessionRoutes(app, manager, { agentId: "claude-code", cwd: "/w" });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address() as AddressInfo;
  return { app, manager, mocks, baseUrl: `http://127.0.0.1:${addr.port}` };
}

describe("session routes: termination broadcasts session_closed", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await buildHarness();
  });

  afterEach(async () => {
    await harness.manager.closeAll().catch(() => undefined);
    await harness.app.close();
  });

  it("POST /v1/sessions/:id/kill notifies attached clients and demotes the session to cold", async () => {
    const session = await harness.manager.create({
      cwd: "/w",
      agentId: "claude-code",
    });
    const stream = makeControlledStream();
    await session.attach(
      { clientId: "c1", connection: new JsonRpcConnection(stream) },
      "full",
    );

    const res = await fetch(
      `${harness.baseUrl}/v1/sessions/${session.sessionId}/kill`,
      { method: "POST" },
    );
    expect(res.status).toBe(204);

    const closeMsg = stream.sent.find(
      (m) => "method" in m && m.method === "hydra-acp/session_closed",
    );
    expect(closeMsg).toMatchObject({
      params: { sessionId: session.sessionId },
    });
    // Live entry is gone; record stays on disk so the next attach can
    // resurrect.
    expect(harness.manager.get(session.sessionId)).toBeUndefined();
    expect(await harness.manager.hasRecord(session.sessionId)).toBe(true);
  });

  it("DELETE /v1/sessions/:id notifies attached clients and removes the record", async () => {
    const session = await harness.manager.create({
      cwd: "/w",
      agentId: "claude-code",
    });
    const stream = makeControlledStream();
    await session.attach(
      { clientId: "c1", connection: new JsonRpcConnection(stream) },
      "full",
    );

    const res = await fetch(
      `${harness.baseUrl}/v1/sessions/${session.sessionId}`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(204);

    const closeMsg = stream.sent.find(
      (m) => "method" in m && m.method === "hydra-acp/session_closed",
    );
    expect(closeMsg).toMatchObject({
      params: { sessionId: session.sessionId },
    });
    expect(harness.manager.get(session.sessionId)).toBeUndefined();
    expect(await harness.manager.hasRecord(session.sessionId)).toBe(false);
  });
});
