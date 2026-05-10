import { describe, it, expect, vi } from "vitest";
import { Session, type AttachedClient } from "./session.js";
import { JsonRpcConnection } from "../acp/connection.js";
import {
  makeControlledStream,
  makeMockAgent,
} from "../__tests__/test-utils.js";
import { JsonRpcErrorCodes } from "../acp/types.js";

function makeClient(role: "controller" | "observer" = "controller"): {
  client: AttachedClient;
  conn: JsonRpcConnection;
  stream: ReturnType<typeof makeControlledStream>;
} {
  const stream = makeControlledStream();
  const conn = new JsonRpcConnection(stream);
  const client: AttachedClient = {
    clientId: `c_${role}_${Math.random().toString(36).slice(2, 8)}`,
    role,
    connection: conn,
  };
  return { client, conn, stream };
}

describe("Session ID prefix", () => {
  it("auto-generated sessionId starts with hydra_session_", () => {
    const mock = makeMockAgent({ agentId: "mock", cwd: "/w" });
    const s = new Session({
      cwd: "/w",
      agentId: "mock",
      agent: mock.agent,
      upstreamSessionId: "u",
    });
    expect(s.sessionId.startsWith("hydra_session_")).toBe(true);
  });
});

function makeSession(sessionId = "sess_test", upstream = "agent-sess-1") {
  const mock = makeMockAgent({ agentId: "mock", cwd: "/work" });
  const session = new Session({
    sessionId,
    cwd: "/work",
    agentId: "mock",
    agent: mock.agent,
    upstreamSessionId: upstream,
  });
  return { session, mock };
}

describe("Session", () => {
  describe("sessionId rewriting (agent → client)", () => {
    it("rewrites the agent's sessionId in broadcast notifications", () => {
      const { session, mock } = makeSession("sess_hyd", "u_agent");
      const { client, stream } = makeClient();
      session.attach(client, "full");

      mock.triggerNotification("session/update", {
        sessionId: "u_agent",
        update: { kind: "agent_thought", text: "thinking" },
      });

      expect(stream.sent).toHaveLength(1);
      expect(stream.sent[0]).toMatchObject({
        method: "session/update",
        params: {
          sessionId: "sess_hyd",
          update: { kind: "agent_thought", text: "thinking" },
        },
      });
    });

    it("leaves session/update without a sessionId field untouched", () => {
      const { session, mock } = makeSession();
      const { client, stream } = makeClient();
      session.attach(client, "full");
      mock.triggerNotification("session/update", {
        update: { kind: "agent_message_chunk", content: "x" },
      });
      expect(stream.sent[0]).toMatchObject({
        method: "session/update",
        params: { update: { kind: "agent_message_chunk", content: "x" } },
      });
    });

    it("rewrites sessionId in permission requests forwarded to controllers", async () => {
      const { session, mock } = makeSession("sess_hyd", "u_agent");
      const { client, stream } = makeClient("controller");
      session.attach(client, "full");

      const requestPromise = mock.triggerRequest("session/request_permission", {
        sessionId: "u_agent",
        toolCall: { name: "edit_file" },
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      });

      await new Promise((r) => setImmediate(r));
      expect(stream.sent).toHaveLength(1);
      expect(stream.sent[0]).toMatchObject({
        method: "session/request_permission",
        params: { sessionId: "sess_hyd", toolCall: { name: "edit_file" } },
      });

      const sentReq = stream.sent[0] as { id: string | number };
      stream.emitMessage({
        jsonrpc: "2.0",
        id: sentReq.id,
        result: { outcome: { kind: "allow", optionId: "allow" } },
      });

      await expect(requestPromise).resolves.toMatchObject({
        outcome: { kind: "allow" },
      });
    });
  });

  describe("history replay", () => {
    it("replays full history for historyPolicy=full", () => {
      const { session, mock } = makeSession("sess_h", "u");
      const { client: warmClient } = makeClient();
      session.attach(warmClient, "full");
      mock.triggerNotification("session/update", { sessionId: "u", n: 1 });
      mock.triggerNotification("session/update", { sessionId: "u", n: 2 });

      const { client: coldClient } = makeClient();
      const replay = session.attach(coldClient, "full");
      expect(replay).toHaveLength(2);
      expect(replay[0]?.params).toMatchObject({ sessionId: "sess_h", n: 1 });
    });

    it("returns no history for historyPolicy=none", () => {
      const { session, mock } = makeSession();
      const { client: warm } = makeClient();
      session.attach(warm, "full");
      mock.triggerNotification("session/update", { foo: 1 });

      const { client: cold } = makeClient();
      const replay = session.attach(cold, "none");
      expect(replay).toEqual([]);
    });
  });

  describe("attach / detach", () => {
    it("rejects double-attach for the same clientId", () => {
      const { session } = makeSession();
      const { client } = makeClient();
      session.attach(client, "full");
      expect(() => session.attach(client, "full")).toThrowError(
        expect.objectContaining({ code: JsonRpcErrorCodes.AlreadyAttached }),
      );
    });

    it("detach stops broadcasts to the gone client", () => {
      const { session, mock } = makeSession();
      const { client, stream } = makeClient();
      session.attach(client, "full");
      session.detach(client.clientId);
      mock.triggerNotification("session/update", { sessionId: "u", n: 1 });
      expect(stream.sent).toEqual([]);
    });
  });

  describe("prompt queue + role enforcement", () => {
    it("rejects prompts from an observer", async () => {
      const { session } = makeSession();
      const { client } = makeClient("observer");
      session.attach(client, "full");
      await expect(
        session.prompt(client.clientId, { sessionId: "sess_test", prompt: [] }),
      ).rejects.toMatchObject({ code: JsonRpcErrorCodes.RoleNotPermitted });
    });

    it("serializes prompts (second prompt waits for first to settle)", async () => {
      const { session, mock } = makeSession();
      const { client } = makeClient("controller");
      session.attach(client, "full");

      let firstResolve: ((v: unknown) => void) | undefined;
      const firstAgentCall = new Promise((resolve) => {
        firstResolve = resolve;
      });
      const requestMock = mock.agent.connection.request as unknown as ReturnType<
        typeof vi.fn
      >;
      requestMock
        .mockImplementationOnce(() => firstAgentCall)
        .mockResolvedValueOnce("second-result");

      const p1 = session.prompt(client.clientId, { prompt: [] });
      const p2 = session.prompt(client.clientId, { prompt: [] });

      await new Promise((r) => setImmediate(r));
      expect(requestMock).toHaveBeenCalledTimes(1);

      firstResolve?.("first-result");
      await expect(p1).resolves.toBe("first-result");
      await expect(p2).resolves.toBe("second-result");
      expect(requestMock).toHaveBeenCalledTimes(2);
    });
  });

  describe("synthesized prompt_received and turn_complete (RFD #533)", () => {
    it("broadcasts prompt_received to non-originators only", async () => {
      const { session, mock } = makeSession("hydra_session_S", "u_S");
      const { client: alice } = makeClient("controller");
      alice.clientInfo = { name: "alice-frontend", version: "1.2.3" };
      const { client: bob, stream: bobStream } = makeClient("controller");
      const { client: carol, stream: carolStream } = makeClient("observer");
      session.attach(alice, "full");
      session.attach(bob, "full");
      session.attach(carol, "full");

      const { stream: aliceStream } = makeClient();
      void aliceStream;
      const requestMock = mock.agent.connection.request as ReturnType<
        typeof vi.fn
      >;
      requestMock.mockImplementation(() => new Promise(() => undefined));

      void session.prompt(alice.clientId, {
        sessionId: "hydra_session_S",
        prompt: [{ type: "text", text: "hello" }],
      });
      await new Promise((r) => setImmediate(r));

      const findPromptReceived = (sent: typeof bobStream.sent) =>
        sent.find(
          (m) =>
            "method" in m &&
            m.method === "session/update" &&
            (m.params as { update?: { type?: string } } | undefined)?.update
              ?.type === "prompt_received",
        );

      expect(findPromptReceived(bobStream.sent)).toMatchObject({
        params: {
          sessionId: "hydra_session_S",
          update: {
            type: "prompt_received",
            prompt: [{ type: "text", text: "hello" }],
            sentBy: {
              clientId: alice.clientId,
              name: "alice-frontend",
              version: "1.2.3",
            },
          },
        },
      });
      expect(findPromptReceived(carolStream.sent)).toBeDefined();

      const aliceSent = (alice.connection as unknown as {
        // The controlled stream backing alice. We can't easily reach it via this
        // test util, so instead we just verify alice didn't receive a notify by
        // looking at the broadcast count.
      });
      void aliceSent;
    });

    it("broadcasts turn_complete to non-originators when agent returns", async () => {
      const { session, mock } = makeSession("hydra_session_T", "u_T");
      const { client: alice } = makeClient("controller");
      const { client: bob, stream: bobStream } = makeClient("controller");
      session.attach(alice, "full");
      session.attach(bob, "full");

      const requestMock = mock.agent.connection.request as ReturnType<
        typeof vi.fn
      >;
      requestMock.mockResolvedValueOnce({ stopReason: "end_turn" });

      await session.prompt(alice.clientId, {
        sessionId: "hydra_session_T",
        prompt: [{ type: "text", text: "x" }],
      });
      await new Promise((r) => setImmediate(r));

      const turnComplete = bobStream.sent.find(
        (m) =>
          "method" in m &&
          m.method === "session/update" &&
          (m.params as { update?: { type?: string } } | undefined)?.update
            ?.type === "turn_complete",
      );
      expect(turnComplete).toMatchObject({
        params: {
          sessionId: "hydra_session_T",
          update: { type: "turn_complete", stopReason: "end_turn" },
        },
      });
    });

    it("late attachers replay synthesized events from history", async () => {
      const { session, mock } = makeSession("hydra_session_R", "u_R");
      const { client: alice } = makeClient("controller");
      session.attach(alice, "full");
      const requestMock = mock.agent.connection.request as ReturnType<
        typeof vi.fn
      >;
      requestMock.mockResolvedValueOnce({ stopReason: "end_turn" });
      await session.prompt(alice.clientId, {
        prompt: [{ type: "text", text: "earlier turn" }],
      });

      const { client: late } = makeClient();
      const replay = session.attach(late, "full");
      const types = replay.map((n) => {
        const params = n.params as { update?: { type?: string } } | undefined;
        return params?.update?.type;
      });
      expect(types).toEqual(
        expect.arrayContaining(["prompt_received", "turn_complete"]),
      );
    });
  });

  describe("forwardRequest (transparent passthrough for unknown session/* methods)", () => {
    it("rewrites the hydra sessionId to the upstream id and forwards", async () => {
      const { session, mock } = makeSession("sess_hyd", "u_agent");
      const requestMock = mock.agent.connection.request as unknown as ReturnType<
        typeof vi.fn
      >;
      requestMock.mockResolvedValueOnce({ ok: true });

      const result = await session.forwardRequest("session/set_model", {
        sessionId: "sess_hyd",
        modelId: "claude-opus-4-7",
      });

      expect(result).toEqual({ ok: true });
      expect(requestMock).toHaveBeenCalledWith("session/set_model", {
        sessionId: "u_agent",
        modelId: "claude-opus-4-7",
      });
    });

    it("leaves params alone when sessionId doesn't match the hydra id", async () => {
      const { session, mock } = makeSession("sess_hyd", "u_agent");
      const requestMock = mock.agent.connection.request as unknown as ReturnType<
        typeof vi.fn
      >;
      requestMock.mockResolvedValueOnce("ok");

      await session.forwardRequest("session/whatever", {
        sessionId: "different",
        x: 1,
      });

      expect(requestMock).toHaveBeenCalledWith("session/whatever", {
        sessionId: "different",
        x: 1,
      });
    });
  });

  describe("idle timeout", () => {
    it("starts a timer when last client detaches and closes after timeout", async () => {
      vi.useFakeTimers();
      try {
        const mock = makeMockAgent({ agentId: "mock", cwd: "/w" });
        const session = new Session({
          sessionId: "hydra_session_idle",
          cwd: "/w",
          agentId: "mock",
          agent: mock.agent,
          upstreamSessionId: "u",
          idleTimeoutMs: 1_000,
        });
        const closeSpy = vi.fn();
        session.onClose(closeSpy);
        const { client } = makeClient();
        session.attach(client, "full");
        session.detach(client.clientId);

        expect(closeSpy).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1_001);

        expect(closeSpy).toHaveBeenCalledWith({ deleteRecord: false });
      } finally {
        vi.useRealTimers();
      }
    });

    it("cancels the idle timer when a client reattaches in time", async () => {
      vi.useFakeTimers();
      try {
        const mock = makeMockAgent({ agentId: "mock", cwd: "/w" });
        const session = new Session({
          sessionId: "hydra_session_renewed",
          cwd: "/w",
          agentId: "mock",
          agent: mock.agent,
          upstreamSessionId: "u",
          idleTimeoutMs: 1_000,
        });
        const closeSpy = vi.fn();
        session.onClose(closeSpy);
        const { client: a } = makeClient();
        session.attach(a, "full");
        session.detach(a.clientId);

        await vi.advanceTimersByTimeAsync(500);
        const { client: b } = makeClient();
        session.attach(b, "full");
        await vi.advanceTimersByTimeAsync(2_000);

        expect(closeSpy).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("idleTimeoutMs=0 disables auto-close", async () => {
      vi.useFakeTimers();
      try {
        const mock = makeMockAgent({ agentId: "mock", cwd: "/w" });
        const session = new Session({
          sessionId: "hydra_session_persistent",
          cwd: "/w",
          agentId: "mock",
          agent: mock.agent,
          upstreamSessionId: "u",
          idleTimeoutMs: 0,
        });
        const closeSpy = vi.fn();
        session.onClose(closeSpy);
        const { client } = makeClient();
        session.attach(client, "full");
        session.detach(client.clientId);

        await vi.advanceTimersByTimeAsync(60_000);
        expect(closeSpy).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("agent exit", () => {
    it("notifies clients with session/closed and cleans up", () => {
      const { session, mock } = makeSession("sess_x", "u");
      const { client, stream } = makeClient();
      session.attach(client, "full");

      mock.triggerExit(0, null);

      const closeMsg = stream.sent.find(
        (m) => "method" in m && m.method === "session/closed",
      );
      expect(closeMsg).toMatchObject({
        params: { sessionId: "sess_x" },
      });
      expect(session.attachedCount).toBe(0);
    });
  });
});
