import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// The only expensive bit (generateSynopsis spawning a real subprocess)
// is mocked; planSpawn is stubbed so the coordinator doesn't hit the
// registry install logic.
vi.mock("./synopsis-agent.js", () => ({
  generateSynopsis: vi.fn(),
}));
vi.mock("./registry.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./registry.js")>();
  return {
    ...orig,
    planSpawn: vi.fn(async () => ({
      command: "/bin/true",
      args: [],
      env: {},
      version: "test",
    })),
  };
});

import { generateSynopsis } from "./synopsis-agent.js";
import { SessionManager } from "./session-manager.js";
import type { Session } from "./session.js";
import { Registry, type RegistryAgent } from "./registry.js";
import { makeMockAgent, type MockAgentControls } from "../__tests__/test-utils.js";

const mockGenerate = generateSynopsis as ReturnType<typeof vi.fn>;

const WORK_CWD = mkdtempSync(path.join(os.tmpdir(), "hydra-syn-title-"));

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

function makeManager(mocks: MockAgentControls[]): SessionManager {
  return new SessionManager(
    fakeRegistry([fakeRegistryAgent("claude-code")]),
    () => {
      const m = makeMockAgent({ agentId: "claude-code", cwd: WORK_CWD });
      mocks.push(m);
      const requestMock = m.agent.connection.request as ReturnType<typeof vi.fn>;
      requestMock
        .mockResolvedValueOnce({ protocolVersion: 1 })
        .mockResolvedValueOnce({ sessionId: "u_new" });
      return m.agent;
    },
  );
}

async function attachCapturingClient(session: Session): Promise<{ sent: unknown[] }> {
  const { JsonRpcConnection } = await import("../acp/connection.js");
  const { makeControlledStream } = await import("../__tests__/test-utils.js");
  const stream = makeControlledStream();
  const conn = new JsonRpcConnection(stream);
  await session.attach({ clientId: "c1", connection: conn }, "full");
  return stream;
}

function titleBroadcasts(sent: unknown[]): string[] {
  const titles: string[] = [];
  for (const msg of sent) {
    const m = msg as {
      method?: string;
      params?: { update?: { sessionUpdate?: string; title?: string } };
    };
    if (
      m.method === "session/update" &&
      m.params?.update?.sessionUpdate === "session_info_update" &&
      typeof m.params.update.title === "string"
    ) {
      titles.push(m.params.update.title);
    }
  }
  return titles;
}

describe("SessionManager: synopsis title routes through live session", () => {
  beforeEach(() => {
    mockGenerate.mockReset();
  });

  it("broadcasts session_info_update to attached clients AND updates in-memory title", async () => {
    mockGenerate.mockResolvedValue({
      title: "Regenerated live title",
      synopsis: { goal: "ship it" },
    });

    const mocks: MockAgentControls[] = [];
    const manager = makeManager(mocks);

    // A brand-new session has summarizedThroughEntry undefined, so the
    // coordinator runs on the first schedule regardless of history length.
    const session = await manager.create({ cwd: WORK_CWD, agentId: "claude-code" });
    const stream = await attachCapturingClient(session);

    manager.scheduleSynopsis(session.sessionId);
    await manager.flushSynopsis(5_000);
    // retitle runs through the prompt queue; let it drain.
    await manager.flushMetaWrites();
    await manager.flushHistoryWrites();

    expect(mockGenerate).toHaveBeenCalledTimes(1);
    // Live session's in-memory title updated (so list()/picker poll sees it).
    expect(session.title).toBe("Regenerated live title");
    // Attached client received the live push.
    expect(titleBroadcasts(stream.sent)).toContain("Regenerated live title");

    // Disk is in sync too (onTitleChange -> persistTitle).
    const record = await manager.loadFromDisk(session.sessionId);
    expect(record?.title).toBe("Regenerated live title");
  });

  it("for a cold session, writes meta.json only (no live session to broadcast to)", async () => {
    mockGenerate.mockResolvedValue({
      title: "Cold regenerated title",
      synopsis: { goal: "ship it" },
    });

    const mocks: MockAgentControls[] = [];
    const manager = makeManager(mocks);

    const session = await manager.create({ cwd: WORK_CWD, agentId: "claude-code" });
    const sessionId = session.sessionId;
    await session.close({ deleteRecord: false });

    manager.scheduleSynopsis(sessionId);
    await manager.flushSynopsis(5_000);
    await manager.flushMetaWrites();

    expect(mockGenerate).toHaveBeenCalledTimes(1);
    const record = await manager.loadFromDisk(sessionId);
    expect(record?.title).toBe("Cold regenerated title");
  });
});
