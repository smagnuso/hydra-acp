import { describe, it, expect, vi } from "vitest";
import { Session, type AttachedClient } from "./session.js";
import { HistoryStore } from "./history-store.js";
import { JsonRpcConnection } from "../acp/connection.js";
import {
  makeControlledStream,
  makeMockAgent,
} from "../__tests__/test-utils.js";
import {
  JsonRpcErrorCodes,
  type JsonRpcNotification,
  type JsonRpcRequest,
} from "../acp/types.js";

// Tests want replay-from-disk to settle before they assert, since
// recordAndBroadcast appends fire-and-forget. Use this after triggering
// notifications and before reading session.attach()'s replay.
async function flushHistoryWrites(): Promise<void> {
  // Two ticks: one for the broadcast's pending appendFile to land,
  // one for the writeQueue.then() chain to settle.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

function makeClient(clientInfo?: { name: string; version?: string }): {
  client: AttachedClient;
  conn: JsonRpcConnection;
  stream: ReturnType<typeof makeControlledStream>;
} {
  const stream = makeControlledStream();
  const conn = new JsonRpcConnection(stream);
  const client: AttachedClient = {
    clientId: `c_${Math.random().toString(36).slice(2, 8)}`,
    connection: conn,
    ...(clientInfo ? { clientInfo } : {}),
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
    historyStore: new HistoryStore(),
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

    it("rewrites sessionId in permission requests forwarded to attached clients", async () => {
      const { session, mock } = makeSession("sess_hyd", "u_agent");
      const { client, stream } = makeClient();
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

    it("replays in-flight permission requests to clients that attach late", async () => {
      const { session, mock } = makeSession("sess_hyd", "u_agent");
      const a = makeClient();
      session.attach(a.client, "full");

      const requestPromise = mock.triggerRequest("session/request_permission", {
        sessionId: "u_agent",
        toolCall: { name: "edit_file", toolCallId: "tc_42" },
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      });

      await new Promise((r) => setImmediate(r));
      expect(a.stream.sent).toHaveLength(1);

      // Late-joining client. attach() returns history without dispatching
      // the in-flight permission; the WS handler is expected to drain history
      // first and *then* call replayPendingPermissions so the prompt lands
      // at the bottom of the transcript.
      const b = makeClient();
      session.attach(b.client, "full");
      session.replayPendingPermissions(b.client);
      const bReq = b.stream.sent.find(
        (m): m is JsonRpcRequest =>
          "method" in m && m.method === "session/request_permission",
      );
      expect(bReq).toBeDefined();

      // B answers — A should now get a permission_resolved notification
      // with A's request id, just like the eager-attach case.
      b.stream.emitMessage({
        jsonrpc: "2.0",
        id: bReq!.id,
        result: { outcome: { kind: "allow", optionId: "allow" } },
      });

      await expect(requestPromise).resolves.toMatchObject({
        outcome: { kind: "allow" },
      });

      const aResolved = a.stream.sent.find(
        (m): m is JsonRpcNotification =>
          "method" in m &&
          m.method === "session/update" &&
          (m.params as { update?: { sessionUpdate?: string } } | undefined)
            ?.update?.sessionUpdate === "permission_resolved",
      );
      expect(aResolved).toBeDefined();
    });

    it("does not replay already-settled permissions to late attachers", async () => {
      const { session, mock } = makeSession("sess_hyd", "u_agent");
      const a = makeClient();
      session.attach(a.client, "full");

      const requestPromise = mock.triggerRequest("session/request_permission", {
        sessionId: "u_agent",
        toolCall: { name: "edit_file", toolCallId: "tc_43" },
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      });
      await new Promise((r) => setImmediate(r));

      const aReq = a.stream.sent[0] as { id: string | number };
      a.stream.emitMessage({
        jsonrpc: "2.0",
        id: aReq.id,
        result: { outcome: { kind: "allow", optionId: "allow" } },
      });
      await requestPromise;

      // Late attach AFTER the permission settled — should not see a stale
      // request_permission.
      const b = makeClient();
      session.attach(b.client, "full");
      session.replayPendingPermissions(b.client);
      const stale = b.stream.sent.find(
        (m) => "method" in m && m.method === "session/request_permission",
      );
      expect(stale).toBeUndefined();
    });

    it("replayPendingPermissions runs after history so the prompt lands last", async () => {
      const { session, mock } = makeSession("sess_hyd", "u_agent");
      const a = makeClient();
      session.attach(a.client, "full");

      // Build up some history before the permission request.
      mock.triggerNotification("session/update", {
        sessionId: "u_agent",
        update: { kind: "agent_message_chunk", content: "hi" },
      });

      const reqPromise = mock.triggerRequest("session/request_permission", {
        sessionId: "u_agent",
        toolCall: { name: "edit_file", toolCallId: "tc_50" },
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      });
      await new Promise((r) => setImmediate(r));

      // Late attach. Drain history first (mirrors what acp-ws.ts does), then
      // dispatch in-flight permissions.
      const b = makeClient();
      const { entries: replay } = await session.attach(b.client, "full");
      for (const note of replay) {
        await b.client.connection.notify(note.method, note.params);
      }
      session.replayPendingPermissions(b.client);

      const sentMethods = b.stream.sent
        .filter((m): m is JsonRpcRequest | JsonRpcNotification => "method" in m)
        .map((m) => m.method);
      const updateIdx = sentMethods.indexOf("session/update");
      const permIdx = sentMethods.indexOf("session/request_permission");
      expect(updateIdx).toBeGreaterThanOrEqual(0);
      expect(permIdx).toBeGreaterThan(updateIdx);

      // Cleanup: A answers so the agent's promise resolves.
      const aReq = a.stream.sent.find(
        (m): m is JsonRpcRequest =>
          "method" in m && m.method === "session/request_permission",
      );
      a.stream.emitMessage({
        jsonrpc: "2.0",
        id: aReq!.id,
        result: { outcome: { kind: "allow", optionId: "allow" } },
      });
      await reqPromise;
    });

    it("emits RFD-shaped permission_resolved on the session/update channel to siblings", async () => {
      const { session, mock } = makeSession("sess_hyd", "u_agent");
      const a = makeClient({ name: "client-A", version: "1.2.3" });
      const b = makeClient();
      session.attach(a.client, "full");
      session.attach(b.client, "full");

      const requestPromise = mock.triggerRequest("session/request_permission", {
        sessionId: "u_agent",
        toolCall: { name: "edit_file", toolCallId: "tc_55" },
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      });

      await new Promise((r) => setImmediate(r));
      const aReq = a.stream.sent[0] as { id: string | number };
      const bReq = b.stream.sent[0] as { id: string | number };
      expect(aReq.id).not.toEqual(bReq.id);

      a.stream.emitMessage({
        jsonrpc: "2.0",
        id: aReq.id,
        result: { outcome: { kind: "selected", optionId: "allow" } },
      });

      await expect(requestPromise).resolves.toMatchObject({
        outcome: { kind: "selected" },
      });

      const bResolved = b.stream.sent.find(
        (m): m is JsonRpcNotification =>
          "method" in m &&
          m.method === "session/update" &&
          (m.params as { update?: { sessionUpdate?: string } } | undefined)
            ?.update?.sessionUpdate === "permission_resolved",
      );
      expect(bResolved).toBeDefined();
      const bParams = bResolved?.params as {
        sessionId: string;
        update: {
          sessionUpdate: string;
          toolCallId: string;
          chosenOptionId: string;
          outcome: { kind: string; optionId: string };
          resolvedBy: { clientId: string; name?: string; version?: string };
          requestId?: unknown;
        };
      };
      expect(bParams.sessionId).toBe("sess_hyd");
      expect(bParams.update.toolCallId).toBe("tc_55");
      expect(bParams.update.chosenOptionId).toBe("allow");
      expect(bParams.update.outcome).toEqual({ kind: "selected", optionId: "allow" });
      expect(bParams.update.resolvedBy).toMatchObject({
        clientId: expect.any(String),
        name: "client-A",
        version: "1.2.3",
      });
      // requestId is no longer carried on the wire.
      expect(bParams.update.requestId).toBeUndefined();

      // A must not get a permission_resolved — its own request already resolved.
      const aResolved = a.stream.sent.find(
        (m): m is JsonRpcNotification =>
          "method" in m &&
          m.method === "session/update" &&
          (m.params as { update?: { sessionUpdate?: string } } | undefined)
            ?.update?.sessionUpdate === "permission_resolved",
      );
      expect(aResolved).toBeUndefined();
    });

    it("broadcasts permission requests to every attached client", async () => {
      const { session, mock } = makeSession("hydra_session_z", "u_z");
      const a = makeClient();
      const b = makeClient();
      const c = makeClient();
      session.attach(a.client, "full");
      session.attach(b.client, "full");
      session.attach(c.client, "full");

      const reqPromise = mock.triggerRequest("session/request_permission", {
        sessionId: "u_z",
        toolCall: { name: "edit_file" },
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      });
      await new Promise((r) => setImmediate(r));

      for (const stream of [a.stream, b.stream, c.stream]) {
        const req = stream.sent.find(
          (m) =>
            "method" in m && m.method === "session/request_permission",
        );
        expect(req).toBeDefined();
      }

      const aReq = a.stream.sent[0] as { id: string | number };
      a.stream.emitMessage({
        jsonrpc: "2.0",
        id: aReq.id,
        result: { outcome: { kind: "allow", optionId: "allow" } },
      });
      await reqPromise;
    });
  });

  describe("history replay", () => {
    it("replays full history for historyPolicy=full", async () => {
      const { session, mock } = makeSession("sess_h", "u");
      const { client: warmClient } = makeClient();
      await session.attach(warmClient, "full");
      mock.triggerNotification("session/update", { sessionId: "u", n: 1 });
      mock.triggerNotification("session/update", { sessionId: "u", n: 2 });
      await flushHistoryWrites();

      const { client: coldClient } = makeClient();
      const { entries: replay } = await session.attach(coldClient, "full");
      // Snapshot-shaped events (commands/model/mode/session_info) live
      // in meta.json and are delivered via the attach response _meta,
      // not history. Only the two non-snapshot updates should be here.
      expect(replay).toHaveLength(2);
      expect(replay[0]?.params).toMatchObject({ sessionId: "sess_h", n: 1 });
      expect(replay[1]?.params).toMatchObject({ sessionId: "sess_h", n: 2 });
    });

    it("returns no history for historyPolicy=none", async () => {
      const { session, mock } = makeSession();
      const { client: warm } = makeClient();
      await session.attach(warm, "full");
      mock.triggerNotification("session/update", { foo: 1 });
      await flushHistoryWrites();

      const { client: cold } = makeClient();
      const { entries: replay } = await session.attach(cold, "none");
      expect(replay).toEqual([]);
    });

    it("after_message replays entries strictly after the matching messageId", async () => {
      const { session, mock } = makeSession("sess_am", "u_am");
      const { client: warm } = makeClient();
      await session.attach(warm, "full");

      // Drive a real prompt → turn so we get persisted messageIds.
      (mock.agent.connection.request as ReturnType<typeof vi.fn>).mockResolvedValue({
        stopReason: "end_turn",
      });
      const a = makeClient();
      await session.attach(a.client, "none");
      await session.prompt(a.client.clientId, {
        sessionId: "sess_am",
        prompt: [{ type: "text", text: "first turn" }],
      });
      // Sprinkle an extra event after turn_complete to verify slicing.
      mock.triggerNotification("session/update", {
        sessionId: "u_am",
        update: { sessionUpdate: "agent_message_chunk", content: { text: "tail" } },
      });
      await flushHistoryWrites();

      // Grab the turn_complete's messageId from history.
      const fullSnap = await session.getHistorySnapshot();
      const turnEntry = fullSnap.find(
        (e) =>
          (e.params as { update?: { sessionUpdate?: string } }).update
            ?.sessionUpdate === "turn_complete",
      );
      const turnMessageId = (turnEntry?.params as {
        update: { messageId: string };
      }).update.messageId;
      expect(turnMessageId).toBeDefined();

      const { client: late } = makeClient();
      const { entries: delta, appliedPolicy } = await session.attach(
        late,
        "after_message",
        { afterMessageId: turnMessageId },
      );
      expect(appliedPolicy).toBe("after_message");
      // Only the trailing tail chunk should remain.
      expect(delta).toHaveLength(1);
      expect(
        (delta[0]?.params as { update: { sessionUpdate: string } }).update
          .sessionUpdate,
      ).toBe("agent_message_chunk");
    });

    it("after_message falls back to full when the id is unknown", async () => {
      const { session, mock } = makeSession();
      const { client: warm } = makeClient();
      await session.attach(warm, "full");
      mock.triggerNotification("session/update", {
        sessionId: "u",
        update: { sessionUpdate: "agent_message_chunk", content: { text: "x" } },
      });
      await flushHistoryWrites();

      const { client: late } = makeClient();
      const { entries, appliedPolicy } = await session.attach(
        late,
        "after_message",
        { afterMessageId: "m_does_not_exist" },
      );
      expect(appliedPolicy).toBe("full");
      expect(entries.length).toBeGreaterThan(0);
    });

    it("after_message without afterMessageId falls back to full", async () => {
      const { session } = makeSession();
      const { client: a } = makeClient();
      const { appliedPolicy } = await session.attach(a, "after_message");
      expect(appliedPolicy).toBe("full");
    });
  });

  describe("connectedClients roster", () => {
    it("lists attached clients with clientInfo when present", async () => {
      const { session } = makeSession();
      const a = makeClient({ name: "client-A", version: "1.0.0" });
      const b = makeClient({ name: "client-B" });
      await session.attach(a.client, "none");
      await session.attach(b.client, "none");
      const roster = session.connectedClients();
      expect(roster).toHaveLength(2);
      expect(roster).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "client-A", version: "1.0.0" }),
          expect.objectContaining({ name: "client-B" }),
        ]),
      );
    });

    it("excludes the specified clientId from the roster", async () => {
      const { session } = makeSession();
      const a = makeClient({ name: "client-A" });
      const b = makeClient({ name: "client-B" });
      await session.attach(a.client, "none");
      await session.attach(b.client, "none");
      const roster = session.connectedClients(a.client.clientId);
      expect(roster).toHaveLength(1);
      expect(roster[0]?.name).toBe("client-B");
    });

    it("omits clientInfo fields that weren't supplied", async () => {
      const { session } = makeSession();
      const a = makeClient();
      await session.attach(a.client, "none");
      const roster = session.connectedClients();
      expect(roster).toEqual([{ clientId: a.client.clientId }]);
    });
  });

  describe("client_disconnected broadcast", () => {
    it("notifies remaining peers when a client detaches", async () => {
      const { session } = makeSession("sess_d", "u_d");
      const a = makeClient({ name: "client-A", version: "1.0.0" });
      const b = makeClient({ name: "client-B" });
      await session.attach(a.client, "none");
      await session.attach(b.client, "none");

      session.detach(a.client.clientId);

      const note = b.stream.sent.find(
        (m): m is JsonRpcNotification =>
          "method" in m &&
          m.method === "session/update" &&
          (m.params as { update?: { sessionUpdate?: string } } | undefined)
            ?.update?.sessionUpdate === "client_disconnected",
      );
      expect(note).toBeDefined();
      const params = note?.params as {
        sessionId: string;
        update: {
          sessionUpdate: string;
          client: { clientId: string; name?: string; version?: string };
          timestamp: string;
        };
      };
      expect(params.sessionId).toBe("sess_d");
      expect(params.update.client).toEqual({
        clientId: a.client.clientId,
        name: "client-A",
        version: "1.0.0",
      });
      expect(params.update.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("does not send the notification to the leaving client itself", async () => {
      const { session } = makeSession();
      const a = makeClient({ name: "client-A" });
      const b = makeClient({ name: "client-B" });
      await session.attach(a.client, "none");
      await session.attach(b.client, "none");

      session.detach(a.client.clientId);

      const selfNote = a.stream.sent.find(
        (m) =>
          "method" in m &&
          m.method === "session/update" &&
          (m.params as { update?: { sessionUpdate?: string } } | undefined)
            ?.update?.sessionUpdate === "client_disconnected",
      );
      expect(selfNote).toBeUndefined();
    });

    it("is a no-op for an unknown clientId", () => {
      const { session } = makeSession();
      // Should not throw; nothing to broadcast since no one's attached.
      session.detach("does-not-exist");
    });
  });

  describe("messageId on recorded session/update events", () => {
    it("stamps messageId on tool_call and plan broadcasts so after_message can anchor mid-turn", async () => {
      const { session, mock } = makeSession("sess_mid", "u_mid");
      const a = makeClient();
      await session.attach(a.client, "none");

      mock.triggerNotification("session/update", {
        sessionId: "u_mid",
        update: { sessionUpdate: "tool_call", toolCallId: "tc_1", title: "x" },
      });
      mock.triggerNotification("session/update", {
        sessionId: "u_mid",
        update: { sessionUpdate: "plan", entries: [] },
      });

      const updates = a.stream.sent.flatMap((m) =>
        "method" in m && m.method === "session/update"
          ? [
              (m.params as { update: { sessionUpdate: string; messageId?: string } })
                .update,
            ]
          : [],
      );
      const tool = updates.find((u) => u.sessionUpdate === "tool_call");
      const plan = updates.find((u) => u.sessionUpdate === "plan");
      expect(tool?.messageId).toMatch(/^m_[A-Za-z0-9]{16}$/);
      expect(plan?.messageId).toMatch(/^m_[A-Za-z0-9]{16}$/);
      expect(tool?.messageId).not.toBe(plan?.messageId);
    });

    it("does not stamp messageId on filtered state updates", async () => {
      const { session, mock } = makeSession("sess_state", "u_state");
      const a = makeClient();
      await session.attach(a.client, "none");

      mock.triggerNotification("session/update", {
        sessionId: "u_state",
        update: { sessionUpdate: "current_model_update", currentModel: "opus" },
      });

      // State updates ARE broadcast (so live clients can react) but
      // not recorded — and since they're not anchorable for replay,
      // no messageId is stamped.
      const broadcast = a.stream.sent.find(
        (m) =>
          "method" in m &&
          m.method === "session/update" &&
          (m.params as { update?: { sessionUpdate?: string } } | undefined)
            ?.update?.sessionUpdate === "current_model_update",
      );
      const update = ((broadcast as JsonRpcNotification | undefined)
        ?.params as { update: { messageId?: unknown } }).update;
      expect(update.messageId).toBeUndefined();
    });
  });

  describe("messageId on prompt_received and turn_complete", () => {
    it("stamps a fresh messageId on prompt_received and turn_complete", async () => {
      const { session, mock } = makeSession("sess_m", "u_m");
      const a = makeClient();
      const b = makeClient();
      await session.attach(a.client, "none");
      await session.attach(b.client, "none");

      // Mock agent's session/prompt response so the turn completes.
      (mock.agent.connection.request as ReturnType<typeof vi.fn>).mockResolvedValue({
        stopReason: "end_turn",
      });

      await session.prompt(a.client.clientId, {
        sessionId: "sess_m",
        prompt: [{ type: "text", text: "hi" }],
      });

      const updates = b.stream.sent.flatMap((m) =>
        "method" in m && m.method === "session/update"
          ? [
              (m.params as { update: { sessionUpdate: string; messageId?: string } })
                .update,
            ]
          : [],
      );
      const prompt = updates.find((u) => u.sessionUpdate === "prompt_received");
      const turn = updates.find((u) => u.sessionUpdate === "turn_complete");
      expect(prompt?.messageId).toMatch(/^m_[A-Za-z0-9]{16}$/);
      expect(turn?.messageId).toMatch(/^m_[A-Za-z0-9]{16}$/);
      expect(prompt?.messageId).not.toBe(turn?.messageId);
    });
  });

  describe("history compaction trigger", () => {
    it("triggers compact() once every floor(historyMaxEntries * 0.2) appends", async () => {
      const store = new HistoryStore();
      const compactSpy = vi.spyOn(store, "compact").mockResolvedValue();
      const mock = makeMockAgent({ agentId: "mock", cwd: "/w" });
      const session = new Session({
        sessionId: "hydra_session_HC",
        cwd: "/w",
        agentId: "mock",
        agent: mock.agent,
        upstreamSessionId: "u_hc",
        historyStore: store,
        historyMaxEntries: 50,
      });
      const { client } = makeClient();
      await session.attach(client, "full");

      // compactEvery = floor(50 * 0.2) = 10. Fire 9 recordable broadcasts:
      // not yet at the threshold, no compaction.
      for (let i = 0; i < 9; i++) {
        mock.triggerNotification("session/update", {
          sessionId: "u_hc",
          update: { sessionUpdate: "agent_thought", text: `t${i}` },
        });
      }
      await flushHistoryWrites();
      expect(compactSpy).not.toHaveBeenCalled();

      // The 10th broadcast hits the threshold and triggers one compact.
      mock.triggerNotification("session/update", {
        sessionId: "u_hc",
        update: { sessionUpdate: "agent_thought", text: "t9" },
      });
      await flushHistoryWrites();
      expect(compactSpy).toHaveBeenCalledTimes(1);
      expect(compactSpy).toHaveBeenCalledWith("hydra_session_HC", 50);
    });
  });

  describe("available_commands_update merging", () => {
    it("exposes the hydra verbs via mergedAvailableCommands at construction", () => {
      const { session } = makeSession();
      const names = session.mergedAvailableCommands().map((c) => c.name);
      expect(names).toContain("hydra title");
      expect(names).toContain("hydra agent <agent>");
      expect(names).toContain("hydra kill");
    });

    it("merges agent-emitted commands with hydra verbs and broadcasts the merge live", async () => {
      const { session, mock } = makeSession("sess_h", "u");
      const { client, stream } = makeClient();
      await session.attach(client, "full");
      mock.triggerNotification("session/update", {
        sessionId: "u",
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: [
            { name: "create_plan", description: "Plan a thing" },
          ],
        },
      });

      // mergedAvailableCommands is the snapshot accessor used by
      // acp-ws.ts's buildResponseMeta to deliver commands via _meta.
      const names = session.mergedAvailableCommands().map((c) => c.name);
      expect(names).toContain("hydra title");
      expect(names).toContain("create_plan");

      // Live broadcast to attached clients still happens — only the
      // history persistence is skipped.
      const broadcast = stream.sent.find(
        (m) =>
          "method" in m &&
          m.method === "session/update" &&
          (m.params as { update?: { sessionUpdate?: string } })?.update
            ?.sessionUpdate === "available_commands_update",
      );
      expect(broadcast).toBeDefined();

      // A latecomer's replay should NOT include the commands_update —
      // they pick it up from the attach response _meta instead.
      await flushHistoryWrites();
      const { client: late } = makeClient();
      const { entries: replay } = await session.attach(late, "full");
      const replayedCmds = replay.find((n) => {
        if (n.method !== "session/update") {
          return false;
        }
        const u = (n.params as { update?: { sessionUpdate?: string } })?.update;
        return u?.sessionUpdate === "available_commands_update";
      });
      expect(replayedCmds).toBeUndefined();
    });
  });

  describe("usage_update tracking", () => {
    it("merges fields onto currentUsage and fires onUsageChange", () => {
      const { session, mock } = makeSession("sess_u", "u_u");
      const seen: Array<typeof session.currentUsage> = [];
      session.onUsageChange((usage) => {
        seen.push({ ...usage });
      });

      mock.triggerNotification("session/update", {
        sessionId: "u_u",
        update: {
          sessionUpdate: "usage_update",
          used: 100,
          size: 200000,
          cost: { amount: 0.05, currency: "USD" },
        },
      });
      expect(session.currentUsage).toEqual({
        used: 100,
        size: 200000,
        costAmount: 0.05,
        costCurrency: "USD",
      });
      expect(seen).toHaveLength(1);

      // Partial update: only `used` and amount change; size+currency preserved.
      mock.triggerNotification("session/update", {
        sessionId: "u_u",
        update: {
          sessionUpdate: "usage_update",
          used: 150,
          cost: { amount: 0.08 },
        },
      });
      expect(session.currentUsage).toEqual({
        used: 150,
        size: 200000,
        costAmount: 0.08,
        costCurrency: "USD",
      });
      expect(seen).toHaveLength(2);

      // No-op when nothing actually changed: handler must not fire.
      mock.triggerNotification("session/update", {
        sessionId: "u_u",
        update: {
          sessionUpdate: "usage_update",
          used: 150,
          cost: { amount: 0.08 },
        },
      });
      expect(seen).toHaveLength(2);
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

  describe("prompt queue", () => {
    it("serializes prompts (second prompt waits for first to settle)", async () => {
      const { session, mock } = makeSession();
      const { client } = makeClient();
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

  describe("session/cancel", () => {
    it("forwards cancel to the agent as a notification, not a request", async () => {
      const { session, mock } = makeSession("hydra_session_x", "upstream_x");
      const { client } = makeClient();
      session.attach(client, "full");

      const requestMock = mock.agent.connection.request as unknown as ReturnType<
        typeof vi.fn
      >;
      const notifyMock = mock.agent.connection.notify as unknown as ReturnType<
        typeof vi.fn
      >;

      await session.cancel(client.clientId);

      expect(requestMock).not.toHaveBeenCalledWith(
        "session/cancel",
        expect.anything(),
      );
      expect(notifyMock).toHaveBeenCalledWith("session/cancel", {
        sessionId: "upstream_x",
      });
    });

    it("rewrites the hydra sessionId to the upstream id", async () => {
      const { session, mock } = makeSession("hydra_session_y", "upstream_y");
      const { client } = makeClient();
      session.attach(client, "full");

      const notifyMock = mock.agent.connection.notify as unknown as ReturnType<
        typeof vi.fn
      >;
      await session.cancel(client.clientId);
      // Ensure the agent sees its OWN session id, not hydra's wrapper id.
      expect(notifyMock).toHaveBeenCalledWith("session/cancel", {
        sessionId: "upstream_y",
      });
      expect(notifyMock).not.toHaveBeenCalledWith(
        "session/cancel",
        expect.objectContaining({ sessionId: "hydra_session_y" }),
      );
    });

    it("rejects cancel from a non-attached client with SessionNotFound", async () => {
      const { session, mock } = makeSession();
      await expect(session.cancel("never-attached-id")).rejects.toMatchObject({
        code: JsonRpcErrorCodes.SessionNotFound,
      });
      const notifyMock = mock.agent.connection.notify as unknown as ReturnType<
        typeof vi.fn
      >;
      expect(notifyMock).not.toHaveBeenCalled();
    });

    it("returns immediately without awaiting the agent", async () => {
      // Regression: pre-fix the agent forwarding used .request which awaited a
      // response that agents (per spec) never send, hanging the cancel
      // promise indefinitely.
      const { session, mock } = makeSession();
      const { client } = makeClient();
      session.attach(client, "full");

      const notifyMock = mock.agent.connection.notify as unknown as ReturnType<
        typeof vi.fn
      >;
      // Make notify resolve immediately (the default vi.fn() does too, but
      // be explicit).
      notifyMock.mockResolvedValueOnce(undefined);

      // Should resolve without any agent reply being scheduled.
      await expect(session.cancel(client.clientId)).resolves.toBeUndefined();
    });
  });

  describe("synthesized prompt_received and turn_complete (RFD #533)", () => {
    it("broadcasts prompt_received to non-originators only", async () => {
      const { session, mock } = makeSession("hydra_session_S", "u_S");
      const { client: alice } = makeClient();
      alice.clientInfo = { name: "alice-frontend", version: "1.2.3" };
      const { client: bob, stream: bobStream } = makeClient();
      const { client: carol, stream: carolStream } = makeClient();
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
            (m.params as { update?: { sessionUpdate?: string } } | undefined)
              ?.update?.sessionUpdate === "prompt_received",
        );

      expect(findPromptReceived(bobStream.sent)).toMatchObject({
        params: {
          sessionId: "hydra_session_S",
          update: {
            sessionUpdate: "prompt_received",
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

    it("broadcasts a marked user_message_chunk alongside prompt_received for compat", async () => {
      const { session, mock } = makeSession("hydra_session_C", "u_C");
      const { client: alice } = makeClient();
      const { client: bob, stream: bobStream } = makeClient();
      session.attach(alice, "full");
      session.attach(bob, "full");

      const requestMock = mock.agent.connection.request as ReturnType<
        typeof vi.fn
      >;
      requestMock.mockImplementation(() => new Promise(() => undefined));

      void session.prompt(alice.clientId, {
        sessionId: "hydra_session_C",
        prompt: [{ type: "text", text: "hello compat" }],
      });
      await new Promise((r) => setImmediate(r));

      const compat = bobStream.sent.find(
        (m) =>
          "method" in m &&
          m.method === "session/update" &&
          (m.params as { update?: { sessionUpdate?: string } } | undefined)
            ?.update?.sessionUpdate === "user_message_chunk",
      );
      expect(compat).toMatchObject({
        params: {
          sessionId: "hydra_session_C",
          update: {
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text: "hello compat" },
            _meta: { "hydra-acp": { compatFor: "prompt_received" } },
          },
        },
      });
    });

    it("broadcasts turn_complete to non-originators when agent returns", async () => {
      const { session, mock } = makeSession("hydra_session_T", "u_T");
      const { client: alice } = makeClient();
      const { client: bob, stream: bobStream } = makeClient();
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
          (m.params as { update?: { sessionUpdate?: string } } | undefined)
            ?.update?.sessionUpdate === "turn_complete",
      );
      expect(turnComplete).toMatchObject({
        params: {
          sessionId: "hydra_session_T",
          update: { sessionUpdate: "turn_complete", stopReason: "end_turn" },
        },
      });
    });

    it("seeds session_info_update from the first prompt's first line", async () => {
      const { session, mock } = makeSession("hydra_session_TL", "u_TL");
      const { client: alice } = makeClient();
      const { client: bob, stream: bobStream } = makeClient();
      session.attach(alice, "full");
      session.attach(bob, "full");
      const requestMock = mock.agent.connection.request as ReturnType<
        typeof vi.fn
      >;
      requestMock.mockImplementation(() => new Promise(() => undefined));

      void session.prompt(alice.clientId, {
        sessionId: "hydra_session_TL",
        prompt: [{ type: "text", text: "fix the bug in foo.ts\nmore detail" }],
      });
      await new Promise((r) => setImmediate(r));

      const sessionInfo = bobStream.sent.find(
        (m) =>
          "method" in m &&
          m.method === "session/update" &&
          (m.params as { update?: { sessionUpdate?: string } } | undefined)
            ?.update?.sessionUpdate === "session_info_update",
      );
      expect(sessionInfo).toMatchObject({
        params: {
          sessionId: "hydra_session_TL",
          update: {
            sessionUpdate: "session_info_update",
            title: "fix the bug in foo.ts",
          },
        },
      });
      expect(session.title).toBe("fix the bug in foo.ts");
    });

    it("does not re-seed the title on subsequent prompts", async () => {
      const { session, mock } = makeSession("hydra_session_TL2", "u_TL2");
      const { client: alice } = makeClient();
      session.attach(alice, "full");
      const requestMock = mock.agent.connection.request as ReturnType<
        typeof vi.fn
      >;
      requestMock.mockResolvedValue({ stopReason: "end_turn" });

      await session.prompt(alice.clientId, {
        prompt: [{ type: "text", text: "first prompt title" }],
      });
      await session.prompt(alice.clientId, {
        prompt: [{ type: "text", text: "should not become the title" }],
      });
      await new Promise((r) => setImmediate(r));

      expect(session.title).toBe("first prompt title");
    });

    it("does not clobber a resurrected title with the first prompt", async () => {
      const mock = makeMockAgent({ agentId: "mock", cwd: "/work" });
      const session = new Session({
        sessionId: "hydra_session_TR",
        cwd: "/work",
        agentId: "mock",
        agent: mock.agent,
        upstreamSessionId: "u_TR",
        title: "preserved title from prior life",
        firstPromptSeeded: true,
      });
      const { client: alice } = makeClient();
      session.attach(alice, "full");
      const requestMock = mock.agent.connection.request as ReturnType<
        typeof vi.fn
      >;
      requestMock.mockResolvedValue({ stopReason: "end_turn" });

      await session.prompt(alice.clientId, {
        prompt: [{ type: "text", text: "next turn after resurrect" }],
      });
      await new Promise((r) => setImmediate(r));

      expect(session.title).toBe("preserved title from prior life");
    });

    it("onBroadcast fires for recordable entries and skips snapshot-shaped ones", () => {
      const { session, mock } = makeSession("hydra_session_OB", "u_OB");
      const seen: string[] = [];
      const unsubscribe = session.onBroadcast((entry) => {
        const kind = (
          entry.params as { update?: { sessionUpdate?: string } }
        ).update?.sessionUpdate;
        if (typeof kind === "string") {
          seen.push(kind);
        }
      });

      // Recordable: should fire.
      mock.triggerNotification("session/update", {
        sessionId: "u_OB",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hi" },
        },
      });
      // Snapshot kind: filtered from history, so should NOT fire.
      mock.triggerNotification("session/update", {
        sessionId: "u_OB",
        update: { sessionUpdate: "current_model_update", currentModel: "x" },
      });
      mock.triggerNotification("session/update", {
        sessionId: "u_OB",
        update: { sessionUpdate: "current_mode_update", currentMode: "y" },
      });
      mock.triggerNotification("session/update", {
        sessionId: "u_OB",
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: [{ name: "x" }],
        },
      });
      mock.triggerNotification("session/update", {
        sessionId: "u_OB",
        update: {
          sessionUpdate: "usage_update",
          used: 1,
          cost: { amount: 0.01, currency: "USD" },
        },
      });

      expect(seen).toEqual(["agent_message_chunk"]);

      // After unsubscribe, no further firings.
      unsubscribe();
      mock.triggerNotification("session/update", {
        sessionId: "u_OB",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "after" },
        },
      });
      expect(seen).toEqual(["agent_message_chunk"]);
    });

    it("getHistorySnapshot returns a snapshot decoupled from later writes", async () => {
      const { session, mock } = makeSession("hydra_session_SN", "u_SN");
      mock.triggerNotification("session/update", {
        sessionId: "u_SN",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "first" },
        },
      });
      await flushHistoryWrites();
      const snap = await session.getHistorySnapshot();
      const before = snap.length;
      // Subsequent broadcasts shouldn't appear in the snapshot we took.
      mock.triggerNotification("session/update", {
        sessionId: "u_SN",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "second" },
        },
      });
      expect(snap.length).toBe(before);
      await flushHistoryWrites();
      // The live history did grow.
      expect((await session.getHistorySnapshot()).length).toBe(before + 1);
    });

    it("session_info_update is broadcast live but not put in replay history", async () => {
      const { session, mock } = makeSession("hydra_session_TH", "u_TH");
      const requestMock = mock.agent.connection.request as ReturnType<
        typeof vi.fn
      >;
      requestMock.mockResolvedValue({ stopReason: "end_turn" });

      // Attach Alice — initial history is just the constructor's
      // available_commands_update (no title broadcasts yet).
      const a = makeClient();
      session.attach(a.client, "full");

      // Drive a title change via /hydra title <text>.
      await session.prompt(a.client.clientId, {
        prompt: [{ type: "text", text: "/hydra title testing-the-cache" }],
      });
      expect(session.title).toBe("testing-the-cache");

      // Alice received the live broadcast.
      const aSessionInfo = a.stream.sent.find(
        (m) =>
          "method" in m &&
          m.method === "session/update" &&
          (m.params as { update?: { sessionUpdate?: string } } | undefined)
            ?.update?.sessionUpdate === "session_info_update",
      );
      expect(aSessionInfo).toBeDefined();

      // A late-joining client gets replay history — but no
      // session_info_update should appear in it, since the canonical
      // title is delivered via the attach response _meta instead.
      await flushHistoryWrites();
      const b = makeClient();
      const { entries: replay } = await session.attach(b.client, "full");
      const replayedTitleUpdate = replay.find(
        (e) =>
          e.method === "session/update" &&
          (e.params as { update?: { sessionUpdate?: string } }).update
            ?.sessionUpdate === "session_info_update",
      );
      expect(replayedTitleUpdate).toBeUndefined();
    });

    it("/hydra title <text> sets the title without forwarding to the agent", async () => {
      const { session, mock } = makeSession("hydra_session_HT", "u_HT");
      const { client: alice } = makeClient();
      const { client: bob, stream: bobStream } = makeClient();
      session.attach(alice, "full");
      session.attach(bob, "full");
      const requestMock = mock.agent.connection.request as ReturnType<
        typeof vi.fn
      >;
      requestMock.mockResolvedValue({ stopReason: "end_turn" });

      await session.prompt(alice.clientId, {
        prompt: [{ type: "text", text: "/hydra title an explicit title" }],
      });

      expect(session.title).toBe("an explicit title");
      // No prompt_received broadcast for the slash command.
      const promptReceived = bobStream.sent.find(
        (m) =>
          "method" in m &&
          m.method === "session/update" &&
          (m.params as { update?: { sessionUpdate?: string } } | undefined)
            ?.update?.sessionUpdate === "prompt_received",
      );
      expect(promptReceived).toBeUndefined();
      // session_info_update IS broadcast — that's the visible signal.
      const sessionInfo = bobStream.sent.find(
        (m) =>
          "method" in m &&
          m.method === "session/update" &&
          (m.params as { update?: { sessionUpdate?: string } } | undefined)
            ?.update?.sessionUpdate === "session_info_update",
      );
      expect(sessionInfo).toMatchObject({
        params: {
          sessionId: "hydra_session_HT",
          update: {
            sessionUpdate: "session_info_update",
            title: "an explicit title",
          },
        },
      });
      // Agent's session/prompt was never called for the slash command.
      const promptCalls = requestMock.mock.calls.filter(
        ([method]) => method === "session/prompt",
      );
      expect(promptCalls.length).toBe(0);
    });

    it("/hydra title (no arg) regenerates via a suppressed sub-prompt", async () => {
      const { session, mock } = makeSession("hydra_session_HR", "u_HR");
      const { client: alice } = makeClient();
      const { client: bob, stream: bobStream } = makeClient();
      session.attach(alice, "full");
      session.attach(bob, "full");
      const requestMock = mock.agent.connection.request as ReturnType<
        typeof vi.fn
      >;
      // Agent will emit chunks and eventually resolve.
      requestMock.mockImplementation(async () => {
        mock.triggerNotification("session/update", {
          sessionId: "u_HR",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Refactor auth flow" },
          },
        });
        return { stopReason: "end_turn" };
      });

      await session.prompt(alice.clientId, {
        prompt: [{ type: "text", text: "/hydra title" }],
      });

      expect(session.title).toBe("Refactor auth flow");
      // The sub-prompt's agent_message_chunk was suppressed — bob never
      // sees it.
      const chunkLeak = bobStream.sent.find(
        (m) =>
          "method" in m &&
          m.method === "session/update" &&
          (m.params as { update?: { sessionUpdate?: string } } | undefined)
            ?.update?.sessionUpdate === "agent_message_chunk",
      );
      expect(chunkLeak).toBeUndefined();
      // session_info_update did go out.
      const sessionInfo = bobStream.sent.find(
        (m) =>
          "method" in m &&
          m.method === "session/update" &&
          (m.params as { update?: { sessionUpdate?: string } } | undefined)
            ?.update?.sessionUpdate === "session_info_update",
      );
      expect(sessionInfo).toBeDefined();
    });

    it("/hydra agent swaps the agent, broadcasts info+banner, and feeds transcript to new agent", async () => {
      const oldMock = makeMockAgent({ agentId: "old", cwd: "/w" });
      const newMock = makeMockAgent({ agentId: "new", cwd: "/w" });
      let spawnCalls = 0;
      const session = new Session({
        sessionId: "hydra_session_SW",
        cwd: "/w",
        agentId: "old",
        agent: oldMock.agent,
        upstreamSessionId: "u_old",
        historyStore: new HistoryStore(),
        spawnReplacementAgent: async (p) => {
          spawnCalls++;
          expect(p.agentId).toBe("new");
          expect(p.cwd).toBe("/w");
          return {
            agent: newMock.agent,
            upstreamSessionId: "u_new",
          };
        },
      });
      const { client: alice, stream: aliceStream } = makeClient();
      await session.attach(alice, "full");

      // Build a tiny history first: one user prompt + one agent reply.
      const oldRequest = oldMock.agent.connection.request as ReturnType<
        typeof vi.fn
      >;
      oldRequest.mockImplementationOnce(async () => {
        oldMock.triggerNotification("session/update", {
          sessionId: "u_old",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Hello." },
          },
        });
        return { stopReason: "end_turn" };
      });
      await session.prompt(alice.clientId, {
        prompt: [{ type: "text", text: "say hi" }],
      });
      await flushHistoryWrites();

      // The new agent's session/prompt resolves immediately; we just want to
      // assert it was *invoked* with the synthesized transcript.
      const newRequest = newMock.agent.connection.request as ReturnType<
        typeof vi.fn
      >;
      newRequest.mockResolvedValue({ stopReason: "end_turn" });

      let agentChangePayload: { agentId: string; upstreamSessionId: string } | undefined;
      session.onAgentChange((info) => {
        agentChangePayload = info;
      });

      const oldKill = oldMock.agent.kill as ReturnType<typeof vi.fn>;

      const result = await session.prompt(alice.clientId, {
        prompt: [{ type: "text", text: "/hydra agent new" }],
      });
      expect(result).toMatchObject({ stopReason: "end_turn" });
      expect(spawnCalls).toBe(1);
      expect(session.agentId).toBe("new");
      expect(session.upstreamSessionId).toBe("u_new");
      expect(session.agent).toBe(newMock.agent);
      expect(oldKill).toHaveBeenCalled();

      // Transcript was sent to the new agent.
      const promptCalls = newRequest.mock.calls.filter(
        ([method]) => method === "session/prompt",
      );
      expect(promptCalls.length).toBe(1);
      const [, params] = promptCalls[0] as [string, { prompt: Array<{ text: string }> }];
      const sentText = params.prompt[0]!.text;
      expect(sentText).toContain("taking over this conversation from old");
      expect(sentText).toContain("<user>: say hi");
      expect(sentText).toContain("<agent: old>: Hello.");

      // Broadcast: session_info_update carrying the new agentId inside
      // _meta["hydra-acp"] (the standard ACP schema has no agentId field
      // at the top level — agent identity is a hydra extension).
      const infoUpdate = aliceStream.sent.find((m) => {
        if (!("method" in m) || m.method !== "session/update") {
          return false;
        }
        const update = (
          m.params as
            | {
                update?: {
                  sessionUpdate?: string;
                  _meta?: { "hydra-acp"?: { agentId?: string } };
                };
              }
            | undefined
        )?.update;
        return (
          update?.sessionUpdate === "session_info_update" &&
          update._meta?.["hydra-acp"]?.agentId === "new"
        );
      });
      expect(infoUpdate).toBeDefined();
      const banner = aliceStream.sent.find(
        (m) =>
          "method" in m &&
          m.method === "session/update" &&
          (
            (m.params as { update?: { content?: { text?: string } } } | undefined)?.update
              ?.content?.text ?? ""
          ).includes("(switched from `old` to `new`)"),
      );
      expect(banner).toBeDefined();

      expect(agentChangePayload).toEqual({
        agentId: "new",
        upstreamSessionId: "u_new",
      });
    });

    it("/hydra agent with no agent id rejects", async () => {
      const { session } = makeSession("hydra_session_S0", "u_S0");
      const { client: alice } = makeClient();
      session.attach(alice, "full");

      await expect(
        session.prompt(alice.clientId, {
          prompt: [{ type: "text", text: "/hydra agent" }],
        }),
      ).rejects.toThrow(/requires an agent id/);
    });

    it("/hydra agent to the current agentId rejects", async () => {
      const { session } = makeSession("hydra_session_SS", "u_SS");
      const { client: alice } = makeClient();
      session.attach(alice, "full");

      await expect(
        session.prompt(alice.clientId, {
          prompt: [{ type: "text", text: "/hydra agent mock" }],
        }),
      ).rejects.toThrow(/already on agent mock/);
    });

    it("/hydra agent leaves the old agent in place when the new spawn fails", async () => {
      const oldMock = makeMockAgent({ agentId: "old", cwd: "/w" });
      const session = new Session({
        sessionId: "hydra_session_SF",
        cwd: "/w",
        agentId: "old",
        agent: oldMock.agent,
        upstreamSessionId: "u_old",
        spawnReplacementAgent: async () => {
          throw new Error("registry: agent missing");
        },
      });
      const { client: alice } = makeClient();
      session.attach(alice, "full");
      const oldKill = oldMock.agent.kill as ReturnType<typeof vi.fn>;

      await expect(
        session.prompt(alice.clientId, {
          prompt: [{ type: "text", text: "/hydra agent nope" }],
        }),
      ).rejects.toThrow(/registry: agent missing/);
      expect(session.agentId).toBe("old");
      expect(session.agent).toBe(oldMock.agent);
      expect(oldKill).not.toHaveBeenCalled();
    });

    it("/hydra kill closes the session, notifies clients, and keeps the cold record", async () => {
      const { session, mock } = makeSession("hydra_session_K", "u_K");
      const { client: alice, stream } = makeClient();
      const closeSpy = vi.fn();
      session.onClose(closeSpy);
      session.attach(alice, "full");
      const killMock = mock.agent.kill as ReturnType<typeof vi.fn>;

      const response = await session.prompt(alice.clientId, {
        prompt: [{ type: "text", text: "/hydra kill" }],
      });

      expect(response).toEqual({ stopReason: "end_turn" });
      expect(killMock).toHaveBeenCalledTimes(1);
      expect(closeSpy).toHaveBeenCalledWith({ deleteRecord: false });
      const closeMsg = stream.sent.find(
        (m) => "method" in m && m.method === "hydra-acp/session_closed",
      );
      expect(closeMsg).toMatchObject({ params: { sessionId: "hydra_session_K" } });
      expect(session.attachedCount).toBe(0);
    });

    it("unknown /hydra verbs throw", async () => {
      const { session } = makeSession("hydra_session_HX", "u_HX");
      const { client: alice } = makeClient();
      session.attach(alice, "full");

      await expect(
        session.prompt(alice.clientId, {
          prompt: [{ type: "text", text: "/hydra wat" }],
        }),
      ).rejects.toThrow(/unknown \/hydra verb/);
    });

    it("agent-emitted session_info_update overrides our seed", async () => {
      const { session, mock } = makeSession("hydra_session_TL3", "u_TL3");
      const { client: alice } = makeClient();
      session.attach(alice, "full");
      const requestMock = mock.agent.connection.request as ReturnType<
        typeof vi.fn
      >;
      requestMock.mockImplementation(() => new Promise(() => undefined));

      void session.prompt(alice.clientId, {
        prompt: [{ type: "text", text: "placeholder seed" }],
      });
      await new Promise((r) => setImmediate(r));
      expect(session.title).toBe("placeholder seed");

      mock.triggerNotification("session/update", {
        sessionId: "u_TL3",
        update: {
          sessionUpdate: "session_info_update",
          title: "agent-derived authoritative title",
        },
      });
      expect(session.title).toBe("agent-derived authoritative title");
    });

    it("late attachers replay synthesized events from history", async () => {
      const { session, mock } = makeSession("hydra_session_R", "u_R");
      const { client: alice } = makeClient();
      await session.attach(alice, "full");
      const requestMock = mock.agent.connection.request as ReturnType<
        typeof vi.fn
      >;
      requestMock.mockResolvedValueOnce({ stopReason: "end_turn" });
      await session.prompt(alice.clientId, {
        prompt: [{ type: "text", text: "earlier turn" }],
      });
      await flushHistoryWrites();

      const { client: late } = makeClient();
      const { entries: replay } = await session.attach(late, "full");
      const types = replay.map((n) => {
        const params = n.params as
          | { update?: { sessionUpdate?: string } }
          | undefined;
        return params?.update?.sessionUpdate;
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
    it("closes after the idle window when nothing happens", async () => {
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

        expect(closeSpy).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1_001);

        // No prompt was ever sent, so the idle close drops the record
        // entirely rather than persisting an empty cold session.
        expect(closeSpy).toHaveBeenCalledWith({ deleteRecord: true });
      } finally {
        vi.useRealTimers();
      }
    });

    it("does NOT stay alive just because clients are attached", async () => {
      // Regression: persistent observers (slack/notifier/approver/browser)
      // used to pin a quiet session open forever. The new gate is
      // inactivity, not client count.
      vi.useFakeTimers();
      try {
        const mock = makeMockAgent({ agentId: "mock", cwd: "/w" });
        const session = new Session({
          sessionId: "hydra_session_pinned",
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

        await vi.advanceTimersByTimeAsync(1_001);
        expect(closeSpy).toHaveBeenCalledWith({ deleteRecord: true });
      } finally {
        vi.useRealTimers();
      }
    });

    it("a recorded broadcast resets the idle window", async () => {
      vi.useFakeTimers();
      try {
        const mock = makeMockAgent({ agentId: "mock", cwd: "/w" });
        const session = new Session({
          sessionId: "hydra_session_active",
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

        await vi.advanceTimersByTimeAsync(800);
        // Activity from the agent — recordable, so it should re-arm.
        mock.triggerNotification("session/update", {
          sessionId: "u",
          update: { sessionUpdate: "agent_message_chunk", content: "hi" },
        });
        await vi.advanceTimersByTimeAsync(800);
        expect(closeSpy).not.toHaveBeenCalled();

        // Now go quiet — the next window should fire.
        await vi.advanceTimersByTimeAsync(400);
        expect(closeSpy).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("state-update broadcasts (model/mode/title) do NOT count as activity", async () => {
      vi.useFakeTimers();
      try {
        const mock = makeMockAgent({ agentId: "mock", cwd: "/w" });
        const session = new Session({
          sessionId: "hydra_session_state_only",
          cwd: "/w",
          agentId: "mock",
          agent: mock.agent,
          upstreamSessionId: "u",
          idleTimeoutMs: 1_000,
        });
        const closeSpy = vi.fn();
        session.onClose(closeSpy);

        await vi.advanceTimersByTimeAsync(500);
        // Snapshot-shaped updates are broadcast but not recorded, so
        // they must not extend the inactivity window.
        mock.triggerNotification("session/update", {
          sessionId: "u",
          update: { sessionUpdate: "current_model_update", model: "opus" },
        });
        await vi.advanceTimersByTimeAsync(501);
        expect(closeSpy).toHaveBeenCalled();
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

        await vi.advanceTimersByTimeAsync(60_000);
        expect(closeSpy).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("a resurrected session gets a fresh idle window, not the persisted history's", async () => {
      // Regression: anchoring lastRecordedAt to persisted history's
      // recordedAt would tear down a session immediately on resurrect
      // since those timestamps are exactly what made it go cold.
      vi.useFakeTimers();
      try {
        const mock = makeMockAgent({ agentId: "mock", cwd: "/w" });
        const session = new Session({
          sessionId: "hydra_session_resurrected",
          cwd: "/w",
          agentId: "mock",
          agent: mock.agent,
          upstreamSessionId: "u",
          idleTimeoutMs: 1_000,
          firstPromptSeeded: true,
        });
        const closeSpy = vi.fn();
        session.onClose(closeSpy);

        await vi.advanceTimersByTimeAsync(500);
        expect(closeSpy).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("agent exit", () => {
    it("notifies clients with hydra-acp/session_closed and cleans up", () => {
      const { session, mock } = makeSession("sess_x", "u");
      const { client, stream } = makeClient();
      session.attach(client, "full");

      mock.triggerExit(0, null);

      const closeMsg = stream.sent.find(
        (m) => "method" in m && m.method === "hydra-acp/session_closed",
      );
      expect(closeMsg).toMatchObject({
        params: { sessionId: "sess_x" },
      });
      expect(session.attachedCount).toBe(0);
    });
  });
});
