import { describe, it, expect, vi, beforeEach } from "vitest";
import type { JsonRpcConnection } from "../acp/connection.js";

// Mock AgentInstance.spawn before importing the SUT. The mock builds a
// fake AgentInstance whose `connection` is configurable per-test.
const spawnedAgents: Array<FakeAgent> = [];
let fakeRequestImpl: (method: string, params?: unknown) => Promise<unknown> =
  async () => ({});
let fakeOnNotification: (method: string, handler: (params: unknown) => void) => void =
  () => undefined;
const killSpy = vi.fn(async () => undefined);

interface FakeAgent {
  agentId: string;
  connection: JsonRpcConnection;
  kill: () => Promise<void>;
}

vi.mock("./agent-instance.js", () => ({
  AgentInstance: {
    spawn: vi.fn((opts: { agentId: string }) => {
      const agent: FakeAgent = {
        agentId: opts.agentId,
        connection: {
          request: vi.fn(async (method: string, params?: unknown) =>
            fakeRequestImpl(method, params),
          ),
          onNotification: vi.fn(
            (method: string, handler: (params: unknown) => void) =>
              fakeOnNotification(method, handler),
          ),
        } as unknown as JsonRpcConnection,
        kill: killSpy,
      };
      spawnedAgents.push(agent);
      return agent;
    }),
  },
}));

import { generateSynopsis } from "./synopsis-agent.js";

beforeEach(() => {
  spawnedAgents.length = 0;
  killSpy.mockClear();
  fakeRequestImpl = async () => ({});
  fakeOnNotification = () => undefined;
});

describe("generateSynopsis", () => {
  it("happy path: returns parsed snapshot from agent_message_chunk", async () => {
    let promptResolver: (() => void) | undefined;
    let notificationHandler: ((params: unknown) => void) | undefined;
    fakeOnNotification = (_method, handler) => {
      notificationHandler = handler;
    };
    fakeRequestImpl = async (method) => {
      if (method === "initialize") {
        return {};
      }
      if (method === "session/new") {
        return { sessionId: "u_test" };
      }
      if (method === "session/prompt") {
        // Push the JSON chunk through the notification handler, then
        // resolve the request — that's what a real agent would do.
        notificationHandler?.({
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: '{"title":"My Title","synopsis":{"goal":"do a thing"}}',
            },
          },
        });
        return { stopReason: "end_turn" };
      }
      return {};
    };

    const result = await generateSynopsis({
      agentId: "test-agent",
      cwd: "/w",
      plan: { command: "/bin/true", args: [], env: {}, version: "test" },
      history: [],
    });

    expect(result?.title).toBe("My Title");
    expect(result?.synopsis?.goal).toBe("do a thing");
    expect(killSpy).toHaveBeenCalled();
    void promptResolver;
  });

  it("returns undefined and kills agent on parse failure", async () => {
    let notificationHandler: ((params: unknown) => void) | undefined;
    fakeOnNotification = (_method, handler) => {
      notificationHandler = handler;
    };
    fakeRequestImpl = async (method) => {
      if (method === "initialize") {
        return {};
      }
      if (method === "session/new") {
        return { sessionId: "u_test" };
      }
      if (method === "session/prompt") {
        notificationHandler?.({
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "I can't summarize this, sorry." },
          },
        });
        return { stopReason: "end_turn" };
      }
      return {};
    };

    const result = await generateSynopsis({
      agentId: "test-agent",
      cwd: "/w",
      plan: { command: "/bin/true", args: [], env: {}, version: "test" },
      history: [],
    });

    expect(result).toBeUndefined();
    expect(killSpy).toHaveBeenCalled();
  });

  it("returns undefined on timeout (and kills the agent)", async () => {
    fakeRequestImpl = async (method) => {
      if (method === "initialize") {
        return {};
      }
      if (method === "session/new") {
        return { sessionId: "u_test" };
      }
      // session/prompt never resolves — simulates a hung agent.
      return new Promise(() => undefined);
    };

    const start = Date.now();
    const result = await generateSynopsis({
      agentId: "test-agent",
      cwd: "/w",
      plan: { command: "/bin/true", args: [], env: {}, version: "test" },
      history: [],
      timeoutMs: 200,
    });
    const elapsed = Date.now() - start;

    expect(result).toBeUndefined();
    expect(elapsed).toBeLessThan(2000);
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(killSpy).toHaveBeenCalled();
  });

  it("returns undefined on non-string sessionId from session/new", async () => {
    fakeRequestImpl = async (method) => {
      if (method === "initialize") {
        return {};
      }
      if (method === "session/new") {
        return { sessionId: 42 };
      }
      return {};
    };
    const result = await generateSynopsis({
      agentId: "test-agent",
      cwd: "/w",
      plan: { command: "/bin/true", args: [], env: {}, version: "test" },
      history: [],
    });
    expect(result).toBeUndefined();
    expect(killSpy).toHaveBeenCalled();
  });

  it("skips set_model when the model is not advertised", async () => {
    let setModelCalled = false;
    let notificationHandler: ((params: unknown) => void) | undefined;
    fakeOnNotification = (_method, handler) => {
      notificationHandler = handler;
    };
    fakeRequestImpl = async (method) => {
      if (method === "initialize") {
        return {};
      }
      if (method === "session/new") {
        return {
          sessionId: "u_test",
          availableModels: [{ modelId: "default" }, { modelId: "fast" }],
        };
      }
      if (method === "session/set_model") {
        setModelCalled = true;
        return {};
      }
      if (method === "session/prompt") {
        notificationHandler?.({
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: '{"title":"x"}' },
          },
        });
        return { stopReason: "end_turn" };
      }
      return {};
    };

    await generateSynopsis({
      agentId: "test-agent",
      cwd: "/w",
      plan: { command: "/bin/true", args: [], env: {}, version: "test" },
      history: [],
      modelId: "unknown-model",
    });

    expect(setModelCalled).toBe(false);
  });

  it("calls set_model when the requested model is advertised", async () => {
    let setModelCalled = false;
    let notificationHandler: ((params: unknown) => void) | undefined;
    fakeOnNotification = (_method, handler) => {
      notificationHandler = handler;
    };
    fakeRequestImpl = async (method) => {
      if (method === "initialize") {
        return {};
      }
      if (method === "session/new") {
        return {
          sessionId: "u_test",
          availableModels: [{ modelId: "haiku" }, { modelId: "opus" }],
        };
      }
      if (method === "session/set_model") {
        setModelCalled = true;
        return {};
      }
      if (method === "session/prompt") {
        notificationHandler?.({
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: '{"title":"x"}' },
          },
        });
        return { stopReason: "end_turn" };
      }
      return {};
    };

    await generateSynopsis({
      agentId: "test-agent",
      cwd: "/w",
      plan: { command: "/bin/true", args: [], env: {}, version: "test" },
      history: [],
      modelId: "haiku",
    });

    expect(setModelCalled).toBe(true);
  });

  it("falls through and continues when set_model is rejected", async () => {
    let promptSent = false;
    let notificationHandler: ((params: unknown) => void) | undefined;
    fakeOnNotification = (_method, handler) => {
      notificationHandler = handler;
    };
    fakeRequestImpl = async (method) => {
      if (method === "initialize") {
        return {};
      }
      if (method === "session/new") {
        return {
          sessionId: "u_test",
          availableModels: [{ modelId: "haiku" }],
        };
      }
      if (method === "session/set_model") {
        throw new Error("model rejected");
      }
      if (method === "session/prompt") {
        promptSent = true;
        notificationHandler?.({
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: '{"title":"fallback"}' },
          },
        });
        return { stopReason: "end_turn" };
      }
      return {};
    };

    const result = await generateSynopsis({
      agentId: "test-agent",
      cwd: "/w",
      plan: { command: "/bin/true", args: [], env: {}, version: "test" },
      history: [],
      modelId: "haiku",
    });

    expect(promptSent).toBe(true);
    expect(result?.title).toBe("fallback");
  });
});
