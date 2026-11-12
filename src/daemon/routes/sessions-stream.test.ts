import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import { registerSessionRoutes } from "./sessions.js";
import type { SessionManager } from "../../core/session-manager.js";
import type { Registry, RegistryAgent } from "../../core/registry.js";
import { makeMockAgent } from "../../__tests__/test-utils.js";
import {
  TrackedSessionManager,
  settleTracked,
} from "../../__tests__/tracked.js";

afterEach(settleTracked);

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

interface Frame {
  sessions: Array<{ sessionId: string; status: string; priority?: number }>;
  removed: string[];
  cursor: number;
}

// Reads SSE frames off a response body as they arrive.
function frameReader(res: Response): {
  next: (timeoutMs?: number) => Promise<Frame>;
  stop: () => Promise<void>;
} {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const next = async (timeoutMs = 2000): Promise<Frame> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const end = buffer.indexOf("\n\n");
      if (end !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = block
          .split("\n")
          .find((line) => line.startsWith("data: "));
        if (data !== undefined) {
          return JSON.parse(data.slice(6)) as Frame;
        }
        continue;
      }
      const left = deadline - Date.now();
      if (left <= 0) {
        throw new Error("timed out waiting for a frame");
      }
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timed out waiting for a frame")), left),
        ),
      ]);
      if (chunk.done) {
        throw new Error("stream ended");
      }
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  };
  return { next, stop: () => reader.cancel() };
}

describe("GET /v1/sessions/stream", () => {
  let app: FastifyInstance;
  let manager: SessionManager;
  let baseUrl: string;
  let count = 0;

  beforeEach(async () => {
    count = 0;
    manager = new TrackedSessionManager(
      fakeRegistry([
        { id: "claude-code", name: "claude-code", distribution: { npx: { package: "claude-code" } } },
      ]),
      () => {
        const m = makeMockAgent({ agentId: "claude-code", cwd: "/w" });
        count++;
        const request = m.agent.connection.request as ReturnType<typeof vi.fn>;
        request
          .mockResolvedValueOnce({ protocolVersion: 1 })
          .mockResolvedValueOnce({ sessionId: `u_${count}` });
        return m.agent;
      },
    );
    app = Fastify();
    registerSessionRoutes(app, manager, { agentId: "claude-code", cwd: "/w" });
    await app.listen({ host: "127.0.0.1", port: 0 });
    baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await manager.closeAll().catch(() => undefined);
    await app.close();
  });

  it("sends the current warm set first, then only what changed", async () => {
    const a = await manager.create({ cwd: "/w", agentId: "claude-code" });
    const res = await fetch(
      `${baseUrl}/v1/sessions/stream?status=warm&includeNonInteractive=true`,
    );
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const frames = frameReader(res);
    try {
      const first = await frames.next();
      expect(first.sessions.map((s) => s.sessionId)).toEqual([a.sessionId]);

      const b = await manager.create({ cwd: "/w", agentId: "claude-code" });
      const second = await frames.next();
      expect(second.sessions.map((s) => s.sessionId)).toEqual([b.sessionId]);
    } finally {
      await frames.stop();
    }
  });

  it("names a session that went cold in removed on a warm-only stream", async () => {
    const a = await manager.create({ cwd: "/w", agentId: "claude-code" });
    const res = await fetch(
      `${baseUrl}/v1/sessions/stream?status=warm&includeNonInteractive=true`,
    );
    const frames = frameReader(res);
    try {
      await frames.next();
      await a.close({ deleteRecord: false });
      const frame = await frames.next();
      expect(frame.removed).toEqual([a.sessionId]);
    } finally {
      await frames.stop();
    }
  });

  it("emits a row when an attached client count changes", async () => {
    const a = await manager.create({ cwd: "/w", agentId: "claude-code" });
    const res = await fetch(
      `${baseUrl}/v1/sessions/stream?status=warm&includeNonInteractive=true`,
    );
    const frames = frameReader(res);
    try {
      await frames.next();
      a.attach(
        {
          clientId: "c1",
          connection: { notify: vi.fn(), request: vi.fn() } as never,
        },
        "none",
      );
      const frame = await frames.next();
      expect(frame.sessions.map((s) => s.sessionId)).toEqual([a.sessionId]);
    } finally {
      await frames.stop();
    }
  });

  it("drops its hub subscription when the client disconnects", async () => {
    await manager.create({ cwd: "/w", agentId: "claude-code" });
    const res = await fetch(`${baseUrl}/v1/sessions/stream?status=warm`);
    const frames = frameReader(res);
    await frames.next();
    expect(manager.listHub.size).toBe(1);
    await frames.stop();
    await vi.waitFor(() => expect(manager.listHub.size).toBe(0));
  });

  it("rejects a non-numeric cursor", async () => {
    const res = await fetch(`${baseUrl}/v1/sessions/stream?since=nope`);
    expect(res.status).toBe(400);
  });
});
