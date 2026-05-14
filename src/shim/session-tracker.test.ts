import { describe, it, expect } from "vitest";
import { SessionTracker } from "./session-tracker.js";

describe("SessionTracker", () => {
  it("captures resume context from session/new request + response", () => {
    const tracker = new SessionTracker();

    tracker.observeFromClient({
      jsonrpc: "2.0",
      id: 1,
      method: "session/new",
      params: { cwd: "/work" },
    });

    tracker.observeFromServer({
      jsonrpc: "2.0",
      id: 1,
      result: {
        sessionId: "sess_abc",
        _meta: {
          "hydra-acp": {
            upstreamSessionId: "u_xyz",
            agentId: "claude-code",
            cwd: "/work",
          },
        },
      },
    });

    expect(tracker.list()).toEqual([
      {
        sessionId: "sess_abc",
        upstreamSessionId: "u_xyz",
        agentId: "claude-code",
        cwd: "/work",
      },
    ]);
  });

  it("captures title from response meta when provided", () => {
    const tracker = new SessionTracker();
    tracker.observeFromClient({
      jsonrpc: "2.0",
      id: 11,
      method: "session/new",
      params: { cwd: "/work" },
    });
    tracker.observeFromServer({
      jsonrpc: "2.0",
      id: 11,
      result: {
        sessionId: "sess_named",
        _meta: {
          "hydra-acp": {
            upstreamSessionId: "u_x",
            agentId: "claude-code",
            cwd: "/work",
            name: "feature-X",
          },
        },
      },
    });
    expect(tracker.list()[0]?.title).toBe("feature-X");
  });

  it("captures resume context from session/attach", () => {
    const tracker = new SessionTracker();
    tracker.observeFromClient({
      jsonrpc: "2.0",
      id: "x",
      method: "session/attach",
      params: { sessionId: "sess_abc" },
    });
    tracker.observeFromServer({
      jsonrpc: "2.0",
      id: "x",
      result: {
        sessionId: "sess_abc",
        _meta: {
          "hydra-acp": {
            upstreamSessionId: "u_xyz",
            agentId: "claude-code",
            cwd: "/work",
          },
        },
      },
    });

    expect(tracker.list()[0]?.sessionId).toBe("sess_abc");
  });

  it("captures resume context from session/load request + response", () => {
    const tracker = new SessionTracker();
    tracker.observeFromClient({
      jsonrpc: "2.0",
      id: 21,
      method: "session/load",
      params: { sessionId: "sess_resume", cwd: "/work" },
    });
    tracker.observeFromServer({
      jsonrpc: "2.0",
      id: 21,
      result: {
        sessionId: "sess_resume",
        _meta: {
          "hydra-acp": {
            upstreamSessionId: "u_resumed",
            agentId: "claude-acp",
            cwd: "/work",
          },
        },
      },
    });
    expect(tracker.list()).toEqual([
      {
        sessionId: "sess_resume",
        upstreamSessionId: "u_resumed",
        agentId: "claude-acp",
        cwd: "/work",
      },
    ]);
  });

  it("ignores meta when the hydra namespace is missing", () => {
    const tracker = new SessionTracker();
    tracker.observeFromClient({
      jsonrpc: "2.0",
      id: 5,
      method: "session/new",
      params: { cwd: "/work" },
    });
    tracker.observeFromServer({
      jsonrpc: "2.0",
      id: 5,
      result: {
        sessionId: "sess_no_ns",
        _meta: { "some.other.ext": { foo: "bar" } },
      },
    });
    expect(tracker.list()).toEqual([]);
  });

  it("does not capture context when _meta is missing", () => {
    const tracker = new SessionTracker();
    tracker.observeFromClient({
      jsonrpc: "2.0",
      id: 7,
      method: "session/new",
      params: { cwd: "/w" },
    });
    tracker.observeFromServer({
      jsonrpc: "2.0",
      id: 7,
      result: { sessionId: "sess_no_meta" },
    });
    expect(tracker.list()).toEqual([]);
  });

  it("clears pending matches without polluting state on error responses", () => {
    const tracker = new SessionTracker();
    tracker.observeFromClient({
      jsonrpc: "2.0",
      id: 9,
      method: "session/new",
      params: { cwd: "/w" },
    });
    tracker.observeFromServer({
      jsonrpc: "2.0",
      id: 9,
      error: { code: -1, message: "no" },
    });
    expect(tracker.list()).toEqual([]);
  });

  it("forgets a session on demand", () => {
    const tracker = new SessionTracker();
    tracker.observeFromClient({
      jsonrpc: "2.0",
      id: 1,
      method: "session/new",
      params: { cwd: "/w" },
    });
    tracker.observeFromServer({
      jsonrpc: "2.0",
      id: 1,
      result: {
        sessionId: "sess_a",
        _meta: {
          "hydra-acp": { upstreamSessionId: "u", agentId: "a", cwd: "/w" },
        },
      },
    });
    expect(tracker.list()).toHaveLength(1);
    tracker.forget("sess_a");
    expect(tracker.list()).toEqual([]);
  });

  describe("pending permission requests", () => {
    it("captures session/request_permission requests from server", () => {
      const tracker = new SessionTracker();
      tracker.observeFromServer({
        jsonrpc: "2.0",
        id: 42,
        method: "session/request_permission",
        params: {
          sessionId: "sess_h",
          toolCall: { name: "edit_file" },
          options: [],
        },
      });
      const pendings = tracker.takePendingPermissions();
      expect(pendings).toHaveLength(1);
      expect(pendings[0]).toMatchObject({
        requestId: 42,
        sessionId: "sess_h",
      });
      expect(pendings[0]?.params).toMatchObject({
        toolCall: { name: "edit_file" },
      });
    });

    it("drops a pending permission when the client responds", () => {
      const tracker = new SessionTracker();
      tracker.observeFromServer({
        jsonrpc: "2.0",
        id: 7,
        method: "session/request_permission",
        params: { sessionId: "sess_a" },
      });
      tracker.observeFromClient({
        jsonrpc: "2.0",
        id: 7,
        result: { outcome: { kind: "allow_once", optionId: "ok" } },
      });
      expect(tracker.takePendingPermissions()).toEqual([]);
    });

    it("takePendingPermissions clears the internal map", () => {
      const tracker = new SessionTracker();
      tracker.observeFromServer({
        jsonrpc: "2.0",
        id: 1,
        method: "session/request_permission",
        params: { sessionId: "sess_a" },
      });
      tracker.observeFromServer({
        jsonrpc: "2.0",
        id: 2,
        method: "session/request_permission",
        params: { sessionId: "sess_b" },
      });
      const first = tracker.takePendingPermissions();
      expect(first).toHaveLength(2);
      expect(tracker.takePendingPermissions()).toEqual([]);
    });

    it("ignores request_permission requests without a sessionId", () => {
      const tracker = new SessionTracker();
      tracker.observeFromServer({
        jsonrpc: "2.0",
        id: 3,
        method: "session/request_permission",
        params: { toolCall: { name: "x" } },
      });
      expect(tracker.takePendingPermissions()).toEqual([]);
    });

    it("indexes pending permissions by toolCallId for correlation", () => {
      const tracker = new SessionTracker();
      tracker.observeFromServer({
        jsonrpc: "2.0",
        id: 50,
        method: "session/request_permission",
        params: {
          sessionId: "sess_a",
          toolCall: { name: "edit_file", toolCallId: "tc_50" },
        },
      });
      const found = tracker.takePendingPermissionByToolCall("tc_50");
      expect(found).toMatchObject({
        requestId: 50,
        sessionId: "sess_a",
        toolCallId: "tc_50",
      });
      // Both indexes should be cleared after a take.
      expect(tracker.takePendingPermissions()).toEqual([]);
      expect(tracker.takePendingPermissionByToolCall("tc_50")).toBeUndefined();
    });

    it("clears the toolCallId index when the downstream client responds", () => {
      const tracker = new SessionTracker();
      tracker.observeFromServer({
        jsonrpc: "2.0",
        id: 51,
        method: "session/request_permission",
        params: {
          sessionId: "sess_a",
          toolCall: { toolCallId: "tc_51" },
        },
      });
      tracker.observeFromClient({
        jsonrpc: "2.0",
        id: 51,
        result: { outcome: { kind: "selected", optionId: "allow" } },
      });
      expect(tracker.takePendingPermissionByToolCall("tc_51")).toBeUndefined();
    });

    it("returns undefined for an unknown toolCallId", () => {
      const tracker = new SessionTracker();
      expect(tracker.takePendingPermissionByToolCall("nope")).toBeUndefined();
    });
  });

  describe("messageId tracking for after_message", () => {
    it("records the latest messageId observed per session", () => {
      const tracker = new SessionTracker();
      tracker.observeFromServer({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "sess_a",
          update: { sessionUpdate: "prompt_received", messageId: "m_first" },
        },
      });
      expect(tracker.lastMessageId("sess_a")).toBe("m_first");

      tracker.observeFromServer({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "sess_a",
          update: { sessionUpdate: "turn_complete", messageId: "m_second" },
        },
      });
      expect(tracker.lastMessageId("sess_a")).toBe("m_second");
    });

    it("ignores session/update notifications without a messageId", () => {
      const tracker = new SessionTracker();
      tracker.observeFromServer({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "sess_a",
          update: { sessionUpdate: "agent_message_chunk", content: { text: "x" } },
        },
      });
      expect(tracker.lastMessageId("sess_a")).toBeUndefined();
    });

    it("scopes messageIds per session", () => {
      const tracker = new SessionTracker();
      tracker.observeFromServer({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "sess_a",
          update: { sessionUpdate: "prompt_received", messageId: "m_a" },
        },
      });
      tracker.observeFromServer({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "sess_b",
          update: { sessionUpdate: "prompt_received", messageId: "m_b" },
        },
      });
      expect(tracker.lastMessageId("sess_a")).toBe("m_a");
      expect(tracker.lastMessageId("sess_b")).toBe("m_b");
    });

    it("forget() clears the messageId index alongside the resume context", () => {
      const tracker = new SessionTracker();
      tracker.observeFromServer({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "sess_a",
          update: { sessionUpdate: "prompt_received", messageId: "m_x" },
        },
      });
      tracker.forget("sess_a");
      expect(tracker.lastMessageId("sess_a")).toBeUndefined();
    });
  });

  it("ignores responses to ids it did not observe", () => {
    const tracker = new SessionTracker();
    tracker.observeFromServer({
      jsonrpc: "2.0",
      id: "stranger",
      result: {
        sessionId: "sess_x",
        _meta: {
          "hydra-acp": { upstreamSessionId: "u", agentId: "a", cwd: "/w" },
        },
      },
    });
    expect(tracker.list()).toEqual([]);
  });
});
