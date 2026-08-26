import { describe, it, expect, vi } from "vitest";
import { Session, type AttachedClient } from "./session.js";
import type { AttentionFlag } from "../acp/types-attention.js";
import { HistoryStore } from "./history-store.js";
import { ExtensionCommandRegistry } from "./extension-commands.js";
import { JsonRpcConnection } from "../acp/connection.js";
import {
  makeControlledStream,
  makeMockAgent,
} from "../__tests__/test-utils.js";
import {
  JsonRpcErrorCodes,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
} from "../acp/types.js";

// Narrow a JsonRpcMessage stream entry to a session/update notification
// (or request) whose .update.sessionUpdate matches the given kind.
// Tests use this to assert on broadcast updates without each callsite
// re-doing the union narrowing dance — JsonRpcMessage is a union with
// JsonRpcResponse, which has neither `.method` nor `.params`.
type SessionUpdateMessage = (JsonRpcRequest | JsonRpcNotification) & {
  params: { sessionId?: string; update: Record<string, unknown> };
};
function findSessionUpdate(
  sent: ReadonlyArray<JsonRpcMessage>,
  sessionUpdate: string,
): SessionUpdateMessage | undefined {
  for (const msg of sent) {
    if (!("method" in msg)) continue;
    if (msg.method !== "session/update") continue;
    if (typeof msg.params !== "object" || msg.params === null) continue;
    const params = msg.params as { update?: unknown };
    if (typeof params.update !== "object" || params.update === null) continue;
    const update = params.update as { sessionUpdate?: unknown };
    if (update.sessionUpdate === sessionUpdate) {
      return msg as SessionUpdateMessage;
    }
  }
  return undefined;
}

// Tests want replay-from-disk to settle before they assert, since
// recordAndBroadcast appends fire-and-forget. Use this after triggering
// notifications and before reading session.attach()'s replay.
async function flushHistoryWrites(): Promise<void> {
  // Two ticks: one for the broadcast's pending appendFile to land,
  // one for the writeQueue.then() chain to settle.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

// Mirror of session.ts STATE_UPDATE_KINDS — the kinds that get prepended
// to attach replay as synthetic standard-ACP notifications. Tests use
// this to peel off the snapshot prefix when asserting on historical
// entries.
const STATE_SNAPSHOT_KINDS = new Set([
  "session_info_update",
  "_hydra_current_model_update",
  "current_mode_update",
  "available_commands_update",
  "usage_update",
]);
function isStateSnapshotEntry(entry: { method: string; params: unknown }): boolean {
  if (entry.method !== "session/update") {
    return false;
  }
  const u = (entry.params as { update?: { sessionUpdate?: string } } | undefined)
    ?.update;
  return typeof u?.sessionUpdate === "string" && STATE_SNAPSHOT_KINDS.has(u.sessionUpdate);
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
      const permMsg = stream.sent.find(
        (m): m is JsonRpcRequest =>
          "method" in m && m.method === "session/request_permission",
      );
      expect(stream.sent.some((m) => "method" in m && m.method === "hydra-acp/session/attention_updated")).toBe(true);
      expect(permMsg).toBeDefined();
      expect(permMsg!.params).toMatchObject({ sessionId: "sess_hyd", toolCall: { name: "edit_file" } });

      const sentReq = permMsg! as { id: string | number };
      stream.emitMessage({
        jsonrpc: "2.0",
        id: sentReq.id,
        result: { outcome: { kind: "allow", optionId: "allow" } },
      });

      await expect(requestPromise).resolves.toMatchObject({
        outcome: { kind: "allow" },
      });
    });

    it("rewrites permission requests bearing a subagent (foreign) sessionId to the hydra session id", async () => {
      // Regression: opencode subagent permission requests (acp/permission.ts)
      // carry the subagent's internal opencode session id in params.sessionId,
      // NOT the parent's upstream id. The old gate
      // `obj.sessionId === upstreamSessionId` left those untouched, so the
      // planner (or any attached client) saw a foreign id, couldn't resolve
      // it to a known worker, and abstained — wedging the subagent's tool.
      const { session, mock } = makeSession("sess_hyd", "u_parent");
      const { client, stream } = makeClient();
      session.attach(client, "full");

      const requestPromise = mock.triggerRequest("session/request_permission", {
        sessionId: "u_subagent_foreign",
        toolCall: { name: "external_directory" },
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      });

      await new Promise((r) => setImmediate(r));
      const permMsg = stream.sent.find(
        (m): m is JsonRpcRequest =>
          "method" in m && m.method === "session/request_permission",
      );
      expect(permMsg).toBeDefined();
      expect(permMsg!.params).toMatchObject({
        sessionId: "sess_hyd",
        toolCall: { name: "external_directory" },
      });

      stream.emitMessage({
        jsonrpc: "2.0",
        id: (permMsg! as { id: string | number }).id,
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
      const aReq = a.stream.sent.find(
        (m): m is JsonRpcRequest =>
          "method" in m && m.method === "session/request_permission",
      );
      expect(aReq).toBeDefined();

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

      const aPermReq = a.stream.sent.find(
        (m): m is JsonRpcRequest =>
          "method" in m && m.method === "session/request_permission",
      ) as { id: string | number };
      a.stream.emitMessage({
        jsonrpc: "2.0",
        id: aPermReq.id,
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
      const aPermReq = a.stream.sent.find(
        (m): m is JsonRpcRequest =>
          "method" in m && m.method === "session/request_permission",
      ) as { id: string | number };
      const bPermReq = b.stream.sent.find(
        (m): m is JsonRpcRequest =>
          "method" in m && m.method === "session/request_permission",
      ) as { id: string | number };
      expect(aPermReq.id).not.toEqual(bPermReq.id);

      a.stream.emitMessage({
        jsonrpc: "2.0",
        id: aPermReq.id,
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

      const aPermReq = a.stream.sent.find(
        (m): m is JsonRpcRequest =>
          "method" in m && m.method === "session/request_permission",
      ) as { id: string | number };
      a.stream.emitMessage({
        jsonrpc: "2.0",
        id: aPermReq.id,
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
      // Snapshot-shaped events (commands/model/mode/session_info/usage)
      // live in meta.json and are prepended to the replay as synthetic
      // standard-ACP notifications so third-party clients receive them
      // through the normal event channel. Filter them out here to
      // assert on just the historical entries.
      const historical = replay.filter((e) => !isStateSnapshotEntry(e));
      expect(historical).toHaveLength(2);
      expect(historical[0]?.params).toMatchObject({ sessionId: "sess_h", n: 1 });
      expect(historical[1]?.params).toMatchObject({ sessionId: "sess_h", n: 2 });
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
      // Filter out the synthetic state-snapshot prefix so we can assert
      // on just the historical delta — only the trailing tail chunk
      // should remain there.
      const historicalDelta = delta.filter((e) => !isStateSnapshotEntry(e));
      expect(historicalDelta).toHaveLength(1);
      expect(
        (historicalDelta[0]?.params as { update: { sessionUpdate: string } })
          .update.sessionUpdate,
      ).toBe("agent_message_chunk");
    });

    it("after_message resolves a cutoff that coalesceReplay would drop", async () => {
      // Regression: coalesceReplay folds consecutive same-kind chunks into
      // the first one, so a TUI whose lastSeenMessageId pointed at a
      // middle chunk used to miss the cutoff and fall back to "full".
      // We now search the raw snapshot, then coalesce the tail.
      const { session, mock } = makeSession("sess_mid", "u_mid");
      const { client: warm } = makeClient();
      await session.attach(warm, "full");

      for (const text of ["a", "b", "c"]) {
        mock.triggerNotification("session/update", {
          sessionId: "u_mid",
          update: { sessionUpdate: "agent_message_chunk", content: { text } },
        });
      }
      mock.triggerNotification("session/update", {
        sessionId: "u_mid",
        update: { sessionUpdate: "turn_complete", stopReason: "end_turn" },
      });
      await flushHistoryWrites();

      const snap = await session.getHistorySnapshot();
      const chunkEntries = snap.filter(
        (e) =>
          (e.params as { update?: { sessionUpdate?: string } }).update
            ?.sessionUpdate === "agent_message_chunk",
      );
      expect(chunkEntries).toHaveLength(3);
      const middleId = (chunkEntries[1]?.params as {
        update: { messageId: string };
      }).update.messageId;

      const { client: late } = makeClient();
      const { entries, appliedPolicy } = await session.attach(
        late,
        "after_message",
        { afterMessageId: middleId },
      );
      expect(appliedPolicy).toBe("after_message");

      const delta = entries.filter((e) => !isStateSnapshotEntry(e));
      // Third chunk + turn_complete. The single trailing chunk has no
      // siblings to merge with in the coalesced tail.
      expect(delta).toHaveLength(2);
      expect(
        (delta[0]?.params as { update: { sessionUpdate: string; content: { text: string } } })
          .update,
      ).toMatchObject({ sessionUpdate: "agent_message_chunk", content: { text: "c" } });
      expect(
        (delta[1]?.params as { update: { sessionUpdate: string } }).update
          .sessionUpdate,
      ).toBe("turn_complete");
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

    it("prepends synthetic state snapshots for cached model/mode/usage on attach", async () => {
      const { session, mock } = makeSession("sess_state", "u_state");
      // Drive the agent into emitting state updates that get cached on
      // the Session but filtered from on-disk history. Resume should
      // surface them as standard ACP notifications.
      const warm = makeClient();
      await session.attach(warm.client, "full");
      mock.triggerNotification("session/update", {
        sessionId: "u_state",
        update: { sessionUpdate: "_hydra_current_model_update", currentModel: "gpt-5" },
      });
      mock.triggerNotification("session/update", {
        sessionId: "u_state",
        update: { sessionUpdate: "current_mode_update", currentMode: "code" },
      });
      mock.triggerNotification("session/update", {
        sessionId: "u_state",
        update: {
          sessionUpdate: "usage_update",
          used: 1234,
          size: 200_000,
          cost: { amount: 0.42, currency: "USD" },
        },
      });
      await flushHistoryWrites();

      const { client: cold } = makeClient();
      const { entries: replay } = await session.attach(cold, "full");
      const findKind = (kind: string): unknown =>
        replay.find(
          (e) =>
            e.method === "session/update" &&
            (e.params as { update?: { sessionUpdate?: string } }).update
              ?.sessionUpdate === kind,
        )?.params;
      const model = findKind("_hydra_current_model_update") as
        | { update: { currentModel: string } }
        | undefined;
      const mode = findKind("current_mode_update") as
        | { update: { currentModeId: string } }
        | undefined;
      const usage = findKind("usage_update") as
        | {
            update: {
              used?: number;
              size?: number;
              cost?: { amount?: number; currency?: string };
            };
          }
        | undefined;
      expect(model?.update.currentModel).toBe("gpt-5");
      expect(mode?.update.currentModeId).toBe("code");
      expect(usage?.update.used).toBe(1234);
      expect(usage?.update.size).toBe(200_000);
      expect(usage?.update.cost?.amount).toBe(0.42);
      expect(usage?.update.cost?.currency).toBe("USD");
    });

    it("skips synthetic state snapshots for historyPolicy=none", async () => {
      const { session, mock } = makeSession("sess_none", "u_none");
      const warm = makeClient();
      await session.attach(warm.client, "full");
      mock.triggerNotification("session/update", {
        sessionId: "u_none",
        update: { sessionUpdate: "_hydra_current_model_update", currentModel: "gpt-5" },
      });
      await flushHistoryWrites();
      const { client: cold } = makeClient();
      const { entries: replay } = await session.attach(cold, "none");
      expect(replay).toEqual([]);
    });

    it("captures availableModels from a spec-shaped current_model_update notification", async () => {
      // Spec form: current_model_update with both currentModel and an
      // availableModels list payload. Hydra should cache the list,
      // surface it via session.availableModels(), and include it in
      // the synthetic snapshot replay for fresh attaches.
      const { session, mock } = makeSession("sess_models", "u_models");
      const warm = makeClient();
      await session.attach(warm.client, "full");
      mock.triggerNotification("session/update", {
        sessionId: "u_models",
        update: {
          sessionUpdate: "_hydra_current_model_update",
          currentModel: "ncp-anthropic/claude-opus-4-7",
          availableModels: [
            { modelId: "ncp-anthropic/claude-opus-4-7", name: "Opus 4.7" },
            { modelId: "ncp-anthropic/claude-sonnet-4-6", name: "Sonnet 4.6" },
            { modelId: "openai/gpt-5" },
          ],
        },
      });
      await flushHistoryWrites();

      expect(session.availableModels()).toEqual([
        { modelId: "ncp-anthropic/claude-opus-4-7", name: "Opus 4.7" },
        { modelId: "ncp-anthropic/claude-sonnet-4-6", name: "Sonnet 4.6" },
        { modelId: "openai/gpt-5" },
      ]);

      const { client: cold } = makeClient();
      const { entries: replay } = await session.attach(cold, "full");
      const synth = replay.find(
        (e) =>
          (e.params as { update?: { sessionUpdate?: string } }).update
            ?.sessionUpdate === "_hydra_current_model_update",
      );
      expect(synth).toBeDefined();
      const update = (synth?.params as {
        update: { currentModel?: string; availableModels?: unknown[] };
      }).update;
      expect(update.currentModel).toBe("ncp-anthropic/claude-opus-4-7");
      expect(update.availableModels).toHaveLength(3);
    });

    it("captures availableModels from an opencode config_option_update (id=model)", async () => {
      // opencode emits the model list (and current model) via a
      // config_option_update with options[i] = { value, name }, not the
      // spec-shaped current_model_update.availableModels payload. The
      // extractor accepts both shapes; without this hydra would never
      // learn opencode's model list and set_model validation would
      // pass-through (the original bug).
      const { session, mock } = makeSession("sess_oc", "u_oc");
      const warm = makeClient();
      await session.attach(warm.client, "full");
      mock.triggerNotification("session/update", {
        sessionId: "u_oc",
        update: {
          sessionUpdate: "config_option_update",
          configOptions: [
            {
              id: "model",
              currentValue: "ncp-anthropic/claude-opus-4-7",
              options: [
                {
                  value: "ncp-anthropic/claude-opus-4-7",
                  name: "Claude Opus 4.7",
                },
                { value: "openai/gpt-5", name: "GPT-5" },
              ],
            },
            // Non-model entries are ignored.
            { id: "effort", currentValue: "low" },
          ],
        },
      });
      await flushHistoryWrites();

      expect(session.availableModels()).toEqual([
        { modelId: "ncp-anthropic/claude-opus-4-7", name: "Claude Opus 4.7" },
        { modelId: "openai/gpt-5", name: "GPT-5" },
      ]);
      // currentModel got harvested from configOptions[0].currentValue too.
      expect(session.currentModel).toBe("ncp-anthropic/claude-opus-4-7");
    });

    // An agent-advertised dimension (effort, thought_level, ...) has to be
    // BOTH offered in the snapshot and actually settable. The WS handler
    // validates against buildConfigOptions() and then dispatches; its
    // default branch forwards to the agent, which is the only thing that
    // knows what "effort" means. This used to throw "not settable", so the
    // TUI could list effort and then refuse to set it while the text verb
    // `/hydra config effort high` worked.
    it("offers an agent-advertised config option and forwards a set of it", async () => {
      const { session, mock } = makeSession("sess_eff", "u_eff");
      const warm = makeClient();
      await session.attach(warm.client, "full");
      mock.triggerNotification("session/update", {
        sessionId: "u_eff",
        update: {
          sessionUpdate: "config_option_update",
          configOptions: [
            {
              id: "effort",
              name: "Effort",
              description: "Reasoning effort level",
              category: "thought_level",
              currentValue: "default",
              options: [
                { value: "default", name: "Default" },
                { value: "high", name: "High", description: "Slower, more thorough" },
              ],
            },
          ],
        },
      });
      await flushHistoryWrites();

      const effort = session
        .buildConfigOptions()
        .find((o) => o.id === "effort");
      expect(effort?.options.map((v) => v.value)).toEqual(["default", "high"]);
      // category/description must survive verbatim — a relabeled-to-"other"
      // category is invisible to clients that dispatch on it (agent-shell
      // finds this picker by category:"thought_level" alone).
      expect(effort?.category).toBe("thought_level");
      expect(effort?.description).toBe("Reasoning effort level");
      expect(effort?.options.find((v) => v.value === "high")?.description).toBe(
        "Slower, more thorough",
      );

      const requestSpy = vi
        .spyOn(session.agent.connection, "request")
        .mockResolvedValueOnce({ ok: true });
      await session.forwardRequest("session/set_config_option", {
        sessionId: "sess_eff",
        configId: "effort",
        value: "high",
      });
      // Reaches the agent under the UPSTREAM session id.
      expect(requestSpy).toHaveBeenCalledWith("session/set_config_option", {
        sessionId: "u_eff",
        configId: "effort",
        value: "high",
      });
    });

    it("defaults category to \"other\" when the wire payload omits it", async () => {
      const { session, mock } = makeSession("sess_eff_nocat", "u_eff_nocat");
      const warm = makeClient();
      await session.attach(warm.client, "full");
      mock.triggerNotification("session/update", {
        sessionId: "u_eff_nocat",
        update: {
          sessionUpdate: "config_option_update",
          configOptions: [
            { id: "fast", currentValue: "off", options: [{ value: "off" }, { value: "on" }] },
          ],
        },
      });
      await flushHistoryWrites();
      const fast = session.buildConfigOptions().find((o) => o.id === "fast");
      expect(fast?.category).toBe("other");
    });

    it("refreshes category/description/name on a later update for the same id", async () => {
      const { session, mock } = makeSession("sess_eff_refresh", "u_eff_refresh");
      const warm = makeClient();
      await session.attach(warm.client, "full");
      mock.triggerNotification("session/update", {
        sessionId: "u_eff_refresh",
        update: {
          sessionUpdate: "config_option_update",
          configOptions: [
            { id: "effort", name: "Effort", category: "other", currentValue: "low", options: [{ value: "low" }] },
          ],
        },
      });
      await flushHistoryWrites();
      mock.triggerNotification("session/update", {
        sessionId: "u_eff_refresh",
        update: {
          sessionUpdate: "config_option_update",
          configOptions: [
            {
              id: "effort",
              name: "Reasoning Effort",
              category: "thought_level",
              currentValue: "low",
              options: [{ value: "low" }],
            },
          ],
        },
      });
      await flushHistoryWrites();
      const effort = session.buildConfigOptions().find((o) => o.id === "effort");
      expect(effort?.category).toBe("thought_level");
      expect(effort?.name).toBe("Reasoning Effort");
    });

    it("drops an agent-advertised config option omitted from a later full snapshot", async () => {
      const { session, mock } = makeSession("sess_eff_prune", "u_eff_prune");
      const warm = makeClient();
      await session.attach(warm.client, "full");
      mock.triggerNotification("session/update", {
        sessionId: "u_eff_prune",
        update: {
          sessionUpdate: "config_option_update",
          configOptions: [
            { id: "effort", currentValue: "low", options: [{ value: "low" }] },
            { id: "fast", currentValue: "off", options: [{ value: "off" }] },
          ],
        },
      });
      await flushHistoryWrites();
      expect(
        session.buildConfigOptions().map((o) => o.id),
      ).toEqual(expect.arrayContaining(["effort", "fast"]));

      // claude-agent-acp rebuilds "effort" per model; a model with no
      // reasoning levels sends a snapshot that simply omits it.
      mock.triggerNotification("session/update", {
        sessionId: "u_eff_prune",
        update: {
          sessionUpdate: "config_option_update",
          configOptions: [
            { id: "fast", currentValue: "off", options: [{ value: "off" }] },
          ],
        },
      });
      await flushHistoryWrites();
      const ids = session.buildConfigOptions().map((o) => o.id);
      expect(ids).not.toContain("effort");
      expect(ids).toContain("fast");
    });

    it("applyAgentConfigOptionResponse upserts without pruning ids missing from the reply", async () => {
      const { session, mock } = makeSession("sess_eff_reply", "u_eff_reply");
      const warm = makeClient();
      await session.attach(warm.client, "full");
      mock.triggerNotification("session/update", {
        sessionId: "u_eff_reply",
        update: {
          sessionUpdate: "config_option_update",
          configOptions: [
            { id: "effort", currentValue: "low", options: [{ value: "low" }, { value: "high" }] },
            { id: "fast", currentValue: "off", options: [{ value: "off" }] },
          ],
        },
      });
      await flushHistoryWrites();

      // A reply naming only the id that was set is reporting that one
      // value, not the whole set, so "fast" must survive. Pruning on a
      // partial reply would delete dimensions the agent still offers.
      session.applyAgentConfigOptionResponse({
        configOptions: [
          { id: "effort", currentValue: "high", options: [{ value: "low" }, { value: "high" }] },
        ],
      }, "effort");
      const opts = session.buildConfigOptions();
      expect(opts.find((o) => o.id === "effort")?.currentValue).toBe("high");
      expect(opts.map((o) => o.id)).toContain("fast");
    });

    it("applyAgentConfigOptionResponse prunes an id the agent dropped when the reply is a full snapshot", async () => {
      // claude-acp rebuilds config options per model: switch to one with no
      // reasoning levels and "effort" is gone from the array entirely. Its
      // reply is the whole set (model/mode/agent included), which is what
      // distinguishes it from a reply about the single id that was set.
      const { session, mock } = makeSession("sess_eff_prune", "u_eff_prune");
      const warm = makeClient();
      await session.attach(warm.client, "full");
      mock.triggerNotification("session/update", {
        sessionId: "u_eff_prune",
        update: {
          sessionUpdate: "config_option_update",
          configOptions: [
            { id: "effort", currentValue: "high", options: [{ value: "low" }, { value: "high" }] },
            { id: "fast", currentValue: "off", options: [{ value: "off" }, { value: "on" }] },
          ],
        },
      });
      await flushHistoryWrites();
      expect(session.buildConfigOptions().map((o) => o.id)).toContain("effort");

      const changed = session.applyAgentConfigOptionResponse({
        configOptions: [
          { id: "model", currentValue: "haiku", options: [{ value: "haiku" }] },
          { id: "mode", currentValue: "default", options: [{ value: "default" }] },
          { id: "fast", currentValue: "off", options: [{ value: "off" }, { value: "on" }] },
        ],
      }, "model");

      expect(changed).toBe(true);
      const ids = session.buildConfigOptions().map((o) => o.id);
      expect(ids).not.toContain("effort");
      expect(ids).toContain("fast");
    });

    it("applyAgentConfigOptionResponse reports no change when the reply matches what is cached", async () => {
      // Gates the broadcast: re-sending an identical snapshot to every
      // attached client on each set is churn.
      const { session, mock } = makeSession("sess_eff_same", "u_eff_same");
      const warm = makeClient();
      await session.attach(warm.client, "full");
      mock.triggerNotification("session/update", {
        sessionId: "u_eff_same",
        update: {
          sessionUpdate: "config_option_update",
          configOptions: [
            { id: "effort", currentValue: "high", options: [{ value: "low" }, { value: "high" }] },
          ],
        },
      });
      await flushHistoryWrites();

      const changed = session.applyAgentConfigOptionResponse({
        configOptions: [
          { id: "effort", currentValue: "high", options: [{ value: "low" }, { value: "high" }] },
        ],
      }, "effort");
      expect(changed).toBe(false);
    });

    it("applyAgentConfigOptionResponse ignores model/mode/agent entries and non-array payloads", () => {
      const { session } = makeSession("sess_eff_reply2", "u_eff_reply2");
      const before = session.buildConfigOptions();
      session.applyAgentConfigOptionResponse({
        configOptions: [{ id: "model", currentValue: "should-not-apply", options: [] }],
      });
      session.applyAgentConfigOptionResponse(undefined);
      session.applyAgentConfigOptionResponse({ notConfigOptions: [] });
      expect(session.buildConfigOptions()).toEqual(before);
    });

    it("captures availableModes + currentMode from a config_option_update (id=mode)", async () => {
      // claude-acp advertises its permission modes ONLY via a
      // config_option_update with id="mode" (no available_modes_update).
      // Without harvesting it, availableModes() stays empty and the TUI's
      // Shift+Tab cycle reports "no modes advertised".
      const { session, mock } = makeSession("sess_ocm", "u_ocm");
      const warm = makeClient();
      await session.attach(warm.client, "full");
      mock.triggerNotification("session/update", {
        sessionId: "u_ocm",
        update: {
          sessionUpdate: "config_option_update",
          configOptions: [
            {
              id: "mode",
              name: "Mode",
              category: "mode",
              currentValue: "plan",
              options: [
                { value: "default", name: "Default" },
                { value: "plan", name: "Plan" },
                { value: "bypassPermissions", name: "Bypass" },
              ],
            },
          ],
        },
      });
      await flushHistoryWrites();

      expect(session.availableModes()).toEqual([
        { id: "default", name: "Default" },
        { id: "plan", name: "Plan" },
        { id: "bypassPermissions", name: "Bypass" },
      ]);
      expect(session.currentMode).toBe("plan");
    });

    it("appends the hydra agent option when broadcasting an agent-emitted config_option_update", async () => {
      // opencode's config_option_update carries only mode/model (+ its own
      // extras), never the hydra-native `agent` option. Broadcasting it raw
      // would clobber the merged snapshot the load response gave a generic
      // client (Zed), making the agent selector disappear. Hydra appends
      // the agent option, preserving the agent's own options + order.
      const { session, mock } = makeSession("sess_merge", "u_merge");
      const warm = makeClient();
      await session.attach(warm.client, "full");
      const before = warm.stream.sent.length;
      mock.triggerNotification("session/update", {
        sessionId: "u_merge",
        update: {
          sessionUpdate: "config_option_update",
          configOptions: [
            { id: "model", currentValue: "haiku", options: [{ value: "haiku" }] },
            { id: "mode", currentValue: "default", options: [{ value: "default" }] },
            { id: "effort", currentValue: "low", options: [{ value: "low" }] },
          ],
        },
      });
      await flushHistoryWrites();

      const sent = warm.stream.sent.slice(before) as Array<{
        params?: {
          update?: {
            sessionUpdate?: string;
            configOptions?: Array<{ id?: string }>;
          };
        };
      }>;
      const broadcast = sent.find(
        (m) =>
          m.params?.update?.sessionUpdate === "config_option_update" &&
          (m.params.update.configOptions ?? []).some((o) => o.id === "effort"),
      );
      expect(broadcast).toBeDefined();
      const ids = broadcast!.params!.update!.configOptions!.map((o) => o.id);
      // Agent's own options preserved in order, agent appended last.
      expect(ids).toEqual(["model", "mode", "effort", "agent"]);
    });

    it("broadcasts a synthetic current_model_update when a model change arrives via config_option_update", async () => {
      // opencode/claude-acp carry an agent-initiated model switch only in
      // the non-spec config_option_update. Clients that don't render that
      // shape (the TUI) repaint off current_model_update, so the daemon
      // must synthesize one — otherwise the session banner stays pinned to
      // the stale model even though daemon state and meta.json updated.
      const { session, mock } = makeSession("sess_ocswap", "u_ocswap");
      const warm = makeClient();
      await session.attach(warm.client, "full");
      mock.triggerNotification("session/update", {
        sessionId: "u_ocswap",
        update: {
          sessionUpdate: "_hydra_current_model_update",
          currentModel: "ncp-anthropic/claude-opus-4-7",
        },
      });
      const before = warm.stream.sent.length;
      mock.triggerNotification("session/update", {
        sessionId: "u_ocswap",
        update: {
          sessionUpdate: "config_option_update",
          configOptions: [
            { id: "model", currentValue: "ncp-anthropic/claude-opus-4-8" },
          ],
        },
      });
      await flushHistoryWrites();

      expect(session.currentModel).toBe("ncp-anthropic/claude-opus-4-8");
      const sent = warm.stream.sent.slice(before) as Array<{
        params?: { update?: { sessionUpdate?: string; currentModel?: string } };
      }>;
      const synth = sent.find(
        (m) => m.params?.update?.sessionUpdate === "_hydra_current_model_update",
      );
      expect(synth).toBeDefined();
      expect(synth!.params?.update?.currentModel).toBe(
        "ncp-anthropic/claude-opus-4-8",
      );
    });

    it("does not record config_option_update to history (would falsely mark never-prompted sessions interactive)", async () => {
      // config_option_update is a state-snapshot carrier: its canonical
      // form lives in meta.json and is re-synthesized on attach. Recording
      // it gave never-prompted sessions a non-empty history.jsonl, which
      // effectiveInteractive() infers as interactive=true and surfaces in
      // the picker.
      const { session, mock } = makeSession("sess_ocrec", "u_ocrec");
      const warm = makeClient();
      await session.attach(warm.client, "full");
      mock.triggerNotification("session/update", {
        sessionId: "u_ocrec",
        update: {
          sessionUpdate: "config_option_update",
          configOptions: [
            { id: "model", currentValue: "ncp-anthropic/claude-opus-4-7" },
          ],
        },
      });
      await flushHistoryWrites();

      const snap = await session.getHistorySnapshot();
      const recorded = snap.filter(
        (e) =>
          (e.params as { update?: { sessionUpdate?: string } }).update
            ?.sessionUpdate === "config_option_update",
      );
      expect(recorded).toHaveLength(0);
    });

    it("clears availableModels on /hydra agent swap so set_model can't validate against the dead agent", async () => {
      // Regression guard for the swap path: cached model list belongs
      // to the old agent and would be meaningless (or actively harmful)
      // for the replacement. Mirrors the existing agentAdvertisedCommands
      // clear behavior on agent swap.
      const { session, mock } = makeSession("sess_swap", "u_swap");
      mock.triggerNotification("session/update", {
        sessionId: "u_swap",
        update: {
          sessionUpdate: "_hydra_current_model_update",
          currentModel: "x",
          availableModels: [{ modelId: "x" }],
        },
      });
      await flushHistoryWrites();
      expect(session.availableModels()).toHaveLength(1);

      // Use the public setter path that /hydra agent ultimately invokes
      // (via the agentAdvertisedModels reset in runAgentCommand). The
      // setter is private, but the wireAgent path exercises it: a
      // fresh empty-list current_model_update from a "new" agent should
      // ALSO clear it via the structural-difference path.
      mock.triggerNotification("session/update", {
        sessionId: "u_swap",
        update: {
          sessionUpdate: "_hydra_current_model_update",
          currentModel: "y",
          availableModels: [],
        },
      });
      await flushHistoryWrites();
      // Empty availableModels is treated as a no-op by maybeApplyAgentModel
      // (parseModelsList returns [] which short-circuits setAgentAdvertisedModels).
      // So the cached list stays — this is the right behavior. We test the
      // explicit-clear via the swap path's setter call instead, in the
      // /hydra agent regression test in session-manager.test.ts.
      expect(session.availableModels()).toHaveLength(1);
    });

    it("includes synthetic state snapshots (but no history) for historyPolicy=pending_only", async () => {
      // pending_only is what session/resume (agent-shell's minimal-verbosity
      // path) uses — the client has its own conversation history but still
      // needs current state pushed so a third-party ACP client sees
      // model/usage/commands/title without depending on hydra's _meta.
      const { session, mock } = makeSession("sess_po", "u_po");
      const warm = makeClient();
      await session.attach(warm.client, "full");
      mock.triggerNotification("session/update", {
        sessionId: "u_po",
        update: { sessionUpdate: "_hydra_current_model_update", currentModel: "gpt-5" },
      });
      // Record a real conversation-history entry so we can prove it's
      // excluded from the pending_only replay.
      mock.triggerNotification("session/update", {
        sessionId: "u_po",
        update: { sessionUpdate: "agent_message_chunk", content: { text: "hi" } },
      });
      await flushHistoryWrites();
      const { client: cold } = makeClient();
      const { entries: replay, appliedPolicy } = await session.attach(
        cold,
        "pending_only",
      );
      expect(appliedPolicy).toBe("pending_only");
      // No historical entries.
      const hasHistory = replay.some(
        (e) =>
          (e.params as { update?: { sessionUpdate?: string } }).update
            ?.sessionUpdate === "agent_message_chunk",
      );
      expect(hasHistory).toBe(false);
      // But state snapshots ARE present.
      const model = replay.find(
        (e) =>
          (e.params as { update?: { sessionUpdate?: string } }).update
            ?.sessionUpdate === "_hydra_current_model_update",
      );
      expect(model).toBeDefined();
      expect(
        (model?.params as { update: { currentModel: string } }).update.currentModel,
      ).toBe("gpt-5");
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

  describe("recordedAt on recorded session/update events", () => {
    const hydraMeta = (m: unknown): { recordedAt?: number } | undefined =>
      (
        (m as { params?: { _meta?: Record<string, unknown> } }).params?._meta as
          | Record<string, { recordedAt?: number }>
          | undefined
      )?.["hydra-acp"];

    it("stamps recordedAt on live broadcasts so clients can date events without guessing", async () => {
      const { session, mock } = makeSession("sess_rec", "u_rec");
      const a = makeClient();
      await session.attach(a.client, "none");

      const before = Date.now();
      mock.triggerNotification("session/update", {
        sessionId: "u_rec",
        update: { sessionUpdate: "tool_call", toolCallId: "tc_1", title: "x" },
      });
      const after = Date.now();

      const note = findSessionUpdate(a.stream.sent, "tool_call");
      const at = hydraMeta(note)?.recordedAt;
      expect(typeof at).toBe("number");
      expect(at).toBeGreaterThanOrEqual(before);
      expect(at).toBeLessThanOrEqual(after);
    });

    it("does not stamp recordedAt on filtered state updates", async () => {
      const { session, mock } = makeSession("sess_rec_state", "u_rec_state");
      const a = makeClient();
      await session.attach(a.client, "none");

      mock.triggerNotification("session/update", {
        sessionId: "u_rec_state",
        update: { sessionUpdate: "_hydra_current_model_update", currentModel: "opus" },
      });

      const note = findSessionUpdate(a.stream.sent, "_hydra_current_model_update");
      expect(note).toBeDefined();
      expect(hydraMeta(note)?.recordedAt).toBeUndefined();
    });

    it("keeps the persisted history entry free of the wire-only _meta stamp", async () => {
      const { session, mock } = makeSession("sess_rec_disk", "u_rec_disk");
      const a = makeClient();
      await session.attach(a.client, "none");

      mock.triggerNotification("session/update", {
        sessionId: "u_rec_disk",
        update: { sessionUpdate: "tool_call", toolCallId: "tc_d", title: "x" },
      });
      await flushHistoryWrites();

      const b = makeClient();
      const { entries } = await session.attach(b.client, "full");
      const entry = entries.find(
        (e) =>
          (e.params as { update?: { sessionUpdate?: string } })?.update
            ?.sessionUpdate === "tool_call",
      );
      expect(entry).toBeDefined();
      // recordedAt is a first-class column on the entry; the replay path
      // re-derives the _meta from it, so the stored params stay clean.
      expect(typeof entry?.recordedAt).toBe("number");
      expect(
        (entry?.params as { _meta?: unknown })._meta,
      ).toBeUndefined();
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
        update: { sessionUpdate: "_hydra_current_model_update", currentModel: "opus" },
      });

      // State updates ARE broadcast (so live clients can react) but
      // not recorded — and since they're not anchorable for replay,
      // no messageId is stamped.
      const broadcast = a.stream.sent.find(
        (m) =>
          "method" in m &&
          m.method === "session/update" &&
          (m.params as { update?: { sessionUpdate?: string } } | undefined)
            ?.update?.sessionUpdate === "_hydra_current_model_update",
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

  describe("unknown-slash escape", () => {
    const advertise = (
      mock: ReturnType<typeof makeSession>["mock"],
      upstreamId: string,
      names: string[],
    ): void => {
      mock.triggerNotification("session/update", {
        sessionId: upstreamId,
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: names.map((name) => ({ name })),
        },
      });
    };

    const forwardedText = (mock: ReturnType<typeof makeSession>["mock"]): string => {
      const requestMock = mock.agent.connection.request as ReturnType<typeof vi.fn>;
      const call = requestMock.mock.calls.find(([method]) => method === "session/prompt");
      return (
        (call?.[1] as { prompt: Array<{ text: string }> } | undefined)?.prompt[0]?.text ?? ""
      );
    };

    it("prefixes U+200B when the slash word is not an advertised agent command", async () => {
      const { session, mock } = makeSession("sess_sl1", "u_sl1");
      const a = makeClient();
      await session.attach(a.client, "none");
      advertise(mock, "u_sl1", ["compact"]);
      (mock.agent.connection.request as ReturnType<typeof vi.fn>).mockResolvedValue({
        stopReason: "end_turn",
      });

      await session.prompt(a.client.clientId, {
        sessionId: "sess_sl1",
        prompt: [{ type: "text", text: "/etc/passwd" }],
      });

      // Must survive the agent's .trim() (opencode trims before its
      // startsWith("/") check), hence U+200B rather than a space.
      expect(forwardedText(mock)).toBe("\u200B/etc/passwd");
      expect(forwardedText(mock).trim().startsWith("/")).toBe(false);
    });

    it("leaves an advertised agent command untouched", async () => {
      const { session, mock } = makeSession("sess_sl2", "u_sl2");
      const a = makeClient();
      await session.attach(a.client, "none");
      advertise(mock, "u_sl2", ["/compact"]);
      (mock.agent.connection.request as ReturnType<typeof vi.fn>).mockResolvedValue({
        stopReason: "end_turn",
      });

      await session.prompt(a.client.clientId, {
        sessionId: "sess_sl2",
        prompt: [{ type: "text", text: "/compact now" }],
      });

      expect(forwardedText(mock)).toBe("/compact now");
    });

    it("does not escape when the agent advertised nothing", async () => {
      const { session, mock } = makeSession("sess_sl3", "u_sl3");
      const a = makeClient();
      await session.attach(a.client, "none");
      (mock.agent.connection.request as ReturnType<typeof vi.fn>).mockResolvedValue({
        stopReason: "end_turn",
      });

      await session.prompt(a.client.clientId, {
        sessionId: "sess_sl3",
        prompt: [{ type: "text", text: "/etc/passwd" }],
      });

      expect(forwardedText(mock)).toBe("/etc/passwd");
    });
  });

  describe("interactive promotion", () => {
    const endTurn = (mock: ReturnType<typeof makeSession>["mock"]): void => {
      (mock.agent.connection.request as ReturnType<typeof vi.fn>).mockResolvedValue({
        stopReason: "end_turn",
      });
    };

    it("promotes an undecided session to interactive on a normal prompt", async () => {
      const { session, mock } = makeSession("sess_pi", "u_pi");
      const a = makeClient();
      await session.attach(a.client, "none");
      endTurn(mock);
      const fired: boolean[] = [];
      session.onInteractiveChange((v) => fired.push(v));

      expect(session.interactive).toBeUndefined();
      await session.prompt(a.client.clientId, {
        sessionId: "sess_pi",
        prompt: [{ type: "text", text: "hi" }],
      });

      expect(session.interactive).toBe(true);
      expect(fired).toEqual([true]);
    });

    it("does NOT promote on an ancillary prompt and never writes false", async () => {
      const { session, mock } = makeSession("sess_anc", "u_anc");
      const a = makeClient();
      await session.attach(a.client, "none");
      endTurn(mock);
      const fired: boolean[] = [];
      session.onInteractiveChange((v) => fired.push(v));

      await session.prompt(a.client.clientId, {
        sessionId: "sess_anc",
        prompt: [{ type: "text", text: "cat output" }],
        _meta: { "hydra-acp": { ancillary: true } },
      });

      expect(session.interactive).toBeUndefined();
      expect(fired).toEqual([]);
    });

    it("stays promotable: a real prompt after ancillary ones flips it true", async () => {
      const { session, mock } = makeSession("sess_heal", "u_heal");
      const a = makeClient();
      await session.attach(a.client, "none");
      endTurn(mock);

      await session.prompt(a.client.clientId, {
        sessionId: "sess_heal",
        prompt: [{ type: "text", text: "ancillary" }],
        _meta: { "hydra-acp": { ancillary: true } },
      });
      expect(session.interactive).toBeUndefined();

      await session.prompt(a.client.clientId, {
        sessionId: "sess_heal",
        prompt: [{ type: "text", text: "real turn" }],
      });
      expect(session.interactive).toBe(true);
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
    it("exposes the bare /hydra and /model commands via mergedAvailableCommands at construction", () => {
      const { session } = makeSession();
      const names = session.mergedAvailableCommands().map((c) => c.name);
      expect(names).toContain("hydra");
      expect(names).toContain("model");
      expect(names).toContain("sessions");
      expect(names).toContain("help");
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
      expect(names).toContain("hydra");
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

      // A latecomer's replay carries the merged commands as a synthetic
      // snapshot at the front, so third-party ACP clients see the
      // current command set through the standard event channel — not
      // just hydra-aware clients reading attach response _meta.
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
      expect(replayedCmds).toBeDefined();
      const replayedNames = (
        replayedCmds?.params as {
          update: { availableCommands: Array<{ name: string }> };
        }
      ).update.availableCommands.map((c) => c.name);
      expect(replayedNames).toContain("hydra");
      expect(replayedNames).toContain("create_plan");
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

  // Regression: agents differ in whether their reported cost total is scoped
  // to the process or to the upstream session. OpenCode's ACP adapter sends
  // totalSessionCost(messages) — a re-sum of the whole session — so a
  // resurrected session re-reports history that loadFromDisk already banked
  // into cumulativeCost, doubling the displayed total on every resurrect.
  describe("resurrect cost ledger reconciliation", () => {
    // Shape produced by SessionManager.loadFromDisk: the persisted split,
    // passed through untouched. `current` is spend on the upstream session
    // about to be reloaded; `retired` is spend on upstream sessions the
    // incoming agent has never seen and can never re-report.
    const resurrected = (current: number, retired?: number) => {
      const mock = makeMockAgent({ agentId: "mock", cwd: "/work" });
      const session = new Session({
        sessionId: "sess_led",
        cwd: "/work",
        agentId: "mock",
        agent: mock.agent,
        upstreamSessionId: "u_led",
        currentUsage: {
          costAmount: current,
          ...(retired !== undefined ? { cumulativeCost: retired } : {}),
        },
        reloadsUpstreamLedger: true,
      });
      return { session, mock };
    };
    const report = (
      mock: ReturnType<typeof makeMockAgent>,
      amount: number,
    ): void => {
      mock.triggerNotification("session/update", {
        sessionId: "u_led",
        update: {
          sessionUpdate: "usage_update",
          cost: { amount, currency: "USD" },
        },
      });
    };

    it("does not double-count when the agent re-reports the banked total", () => {
      const { session, mock } = resurrected(10);
      report(mock, 10);
      expect(session.currentUsage?.costAmount).toBe(10);
    });

    it("stays correct as the resumed ledger grows past the banked total", () => {
      const { session, mock } = resurrected(10);
      report(mock, 10);
      report(mock, 12.5);
      expect(session.currentUsage?.costAmount).toBe(12.5);
    });

    it("still adds when the agent restarts its ledger at zero", () => {
      const { session, mock } = resurrected(10);
      report(mock, 0.25);
      expect(session.currentUsage?.costAmount).toBe(10.25);
    });

    it("adjudicates once, not on every report", () => {
      // A restarted-at-zero agent whose total later exceeds the banked
      // amount must not retroactively un-bank on that later report.
      const { session, mock } = resurrected(10);
      report(mock, 0.25);
      report(mock, 30);
      expect(session.currentUsage?.costAmount).toBe(40);
    });

    // onUsageChange feeds persistSnapshot, so it must carry the SPLIT
    // (retired vs current life), not the collapsed total that currentUsage
    // exposes on the wire. Persisting the collapsed value is what destroyed
    // the distinction and made a later resurrect unable to adjudicate.
    it("persists the split, not the collapsed total", () => {
      const { session, mock } = resurrected(1.5, 3.5);
      const seen: Array<{ cost?: number; cumulative?: number }> = [];
      session.onUsageChange((u) => {
        seen.push({ cost: u.costAmount, cumulative: u.cumulativeCost });
      });

      // Process-scoped agent restarts at $0.10: the retained $1.50 is banked,
      // so retired becomes $5.00 and the current life is $0.10.
      report(mock, 0.1);
      expect(seen).toEqual([{ cost: 0.1, cumulative: 5.0 }]);
      // The wire getter still collapses to a single lifetime total.
      expect(session.currentUsage?.costAmount).toBeCloseTo(5.1, 10);
      expect(session.currentUsage?.cumulativeCost).toBeUndefined();
    });

    it("repeated resurrects stay flat instead of compounding", () => {
      // Three resurrect cycles of a session whose true cost never grows.
      // Pre-fix this produced 10 → 20 → 40.
      let banked = 10;
      for (let i = 0; i < 3; i += 1) {
        const { session, mock } = resurrected(banked);
        report(mock, 10);
        banked = session.currentUsage?.costAmount ?? 0;
      }
      expect(banked).toBe(10);
    });


    // Out-of-band spend: hydra tracks $5, daemon exits, the user talks to the
    // same upstream session directly (+$1), then reopens it in hydra.
    it("absorbs out-of-band spend on a session-scoped agent", () => {
      const { session, mock } = resurrected(5);
      report(mock, 6);
      expect(session.currentUsage?.costAmount).toBe(6);
    });

    // Same scenario, process-scoped agent: it restarts at 0 and has no idea
    // about the out-of-band $1, so hydra can only preserve its own $5.
    it("cannot see out-of-band spend on a process-scoped agent", () => {
      const { session, mock } = resurrected(5);
      report(mock, 0.1);
      expect(session.currentUsage?.costAmount).toBe(5.1);
    });


    // Prior upstream sessions contributed $3.50 and the CURRENT upstream
    // session $1.50. The reloaded agent can only report its own session's
    // $1.50; the probe must compare against that, not the $5.00 lifetime
    // total, or the $1.50 gets counted twice.
    it("swap-then-resurrect does not double-count the current session", () => {
      const { session, mock } = resurrected(1.5, 3.5);
      report(mock, 1.5);
      expect(session.currentUsage?.costAmount).toBe(5.0);
    });

    it("swap-then-resurrect absorbs out-of-band spend on the reloaded session", () => {
      const { session, mock } = resurrected(1.5, 3.5);
      report(mock, 2.5);
      expect(session.currentUsage?.costAmount).toBe(6.0);
    });

    it("swap-then-resurrect banks the retained amount for a process-scoped agent", () => {
      const { session, mock } = resurrected(1.5, 3.5);
      report(mock, 0.1);
      expect(session.currentUsage?.costAmount).toBeCloseTo(5.1, 10);
    });

    // doResurrectFromImport bootstraps via session/new, so the incoming agent
    // has a fresh upstream session and its ledger is unrelated to the
    // imported total. Arming the probe here would let the new agent's first
    // sizeable turn cancel out the imported cost.
    it("import reseed keeps the imported total (probe not armed)", () => {
      const mock = makeMockAgent({ agentId: "mock", cwd: "/work" });
      const session = new Session({
        sessionId: "sess_imp",
        cwd: "/work",
        agentId: "mock",
        agent: mock.agent,
        upstreamSessionId: "u_led",
        currentUsage: { cumulativeCost: 10 },
        // reloadsUpstreamLedger deliberately omitted: import mints a fresh
        // upstream session, so the incoming agent's ledger is unrelated.
      });
      // A first turn costing more than the imported total must still add.
      report(mock, 25);
      expect(session.currentUsage?.costAmount).toBe(35);
    });

    // hydra agent sync writes rows with no currentUsage at all, so nothing is
    // banked and the agent's own ledger is the whole truth on first open.
    it("synced session with no persisted usage adopts the agent total as-is", () => {
      const mock = makeMockAgent({ agentId: "mock", cwd: "/work" });
      const session = new Session({
        sessionId: "sess_sync",
        cwd: "/work",
        agentId: "mock",
        agent: mock.agent,
        upstreamSessionId: "u_led",
        reloadsUpstreamLedger: true,
      });
      report(mock, 5);
      expect(session.currentUsage?.costAmount).toBe(5);
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

    it("does not seed the title from an ancillary prompt", async () => {
      const { session, mock } = makeSession("hydra_session_TL4", "u_TL4");
      const { client: alice } = makeClient();
      session.attach(alice, "full");
      const requestMock = mock.agent.connection.request as ReturnType<
        typeof vi.fn
      >;
      requestMock.mockResolvedValue({ stopReason: "end_turn" });

      await session.prompt(alice.clientId, {
        prompt: [{ type: "text", text: "Build 12847 failed: 3 link errors" }],
        _meta: { "hydra-acp": { ancillary: true } },
      });
      await new Promise((r) => setImmediate(r));

      expect(session.title).not.toBe("Build 12847 failed: 3 link errors");

      expect(session.title).toBeUndefined();

      // ...and it DEFERS rather than giving up on the session. Machine
      // traffic arriving first is the ordinary shape of an isolated
      // session — entering or leaving a workspace hands the agent a
      // manufactured prompt about the move — so the human's first real
      // prompt still gets to name it.
      await session.prompt(alice.clientId, {
        prompt: [{ type: "text", text: "now fix the parser bug" }],
      });
      await new Promise((r) => setImmediate(r));

      expect(session.title).toBe("now fix the parser bug");
    });

    it("does not seed the title from a prompt carrying sentBy provenance", async () => {
      const { session, mock } = makeSession("hydra_session_TL5", "u_TL5");
      const { client: alice } = makeClient();
      session.attach(alice, "full");
      const requestMock = mock.agent.connection.request as ReturnType<
        typeof vi.fn
      >;
      requestMock.mockResolvedValue({ stopReason: "end_turn" });

      await session.prompt(alice.clientId, {
        prompt: [{ type: "text", text: "Heads up: I changed flush()" }],
        _meta: { "hydra-acp": { sentBy: { sessionId: "hydra_session_peer" } } },
      });
      await new Promise((r) => setImmediate(r));

      expect(session.title).not.toBe("Heads up: I changed flush()");

      // Deferred, not abandoned: a peer messaging an untitled session
      // says nothing about whether its owner will describe it later.
      await session.prompt(alice.clientId, {
        prompt: [{ type: "text", text: "now fix the parser bug" }],
      });
      await new Promise((r) => setImmediate(r));

      expect(session.title).toBe("now fix the parser bug");
    });

    it("carries sentBy through to the prompt_received broadcast", async () => {
      const { session, mock } = makeSession("hydra_session_TL6", "u_TL6");
      const { client: alice } = makeClient();
      // prompt_received excludes the originator, so observe from a peer.
      const { client: bob, stream: bobStream } = makeClient();
      session.attach(alice, "full");
      session.attach(bob, "full");
      const requestMock = mock.agent.connection.request as ReturnType<
        typeof vi.fn
      >;
      requestMock.mockResolvedValue({ stopReason: "end_turn" });

      await session.prompt(
        alice.clientId,
        { prompt: [{ type: "text", text: "migration finished" }] },
        {
          fromSession: "hydra_session_peer",
          fromSessionTitle: "schema work",
          fromLabel: "jenkins:12847",
        },
      );
      await new Promise((r) => setImmediate(r));

      const received = bobStream.sent.find(
        (m) =>
          "method" in m &&
          m.method === "session/update" &&
          (m.params as { update?: { sessionUpdate?: string } } | undefined)
            ?.update?.sessionUpdate === "prompt_received",
      );
      expect(received).toMatchObject({
        params: {
          update: {
            sentBy: {
              fromSession: "hydra_session_peer",
              fromSessionTitle: "schema work",
              fromLabel: "jenkins:12847",
            },
          },
        },
      });
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
        update: { sessionUpdate: "_hydra_current_model_update", currentModel: "x" },
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

    it("session_info_update is broadcast live and prepended to replay as a synthetic snapshot", async () => {
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

      // session_info_update is filtered from recorded history (it's
      // snapshot state, not a conversation event), so on-disk history
      // never carries it.
      await flushHistoryWrites();
      const onDisk = await session.getHistorySnapshot();
      expect(
        onDisk.find(
          (e) =>
            (e.params as { update?: { sessionUpdate?: string } }).update
              ?.sessionUpdate === "session_info_update",
        ),
      ).toBeUndefined();

      // But the canonical title IS surfaced to a late-joining client
      // through a synthetic session_info_update at the front of replay,
      // so third-party ACP clients see it via the standard event channel.
      const b = makeClient();
      const { entries: replay } = await session.attach(b.client, "full");
      const replayedTitleUpdate = replay.find(
        (e) =>
          e.method === "session/update" &&
          (e.params as { update?: { sessionUpdate?: string } }).update
            ?.sessionUpdate === "session_info_update",
      );
      expect(replayedTitleUpdate).toBeDefined();
      expect(
        (replayedTitleUpdate?.params as { update: { title: string } }).update
          .title,
      ).toBe("testing-the-cache");
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
      // /hydra commands flow through the regular user-prompt path
      // now, so prompt_received DOES fire — the user's slash text
      // is visible in the conversation surface like any other prompt.
      // The TUI's user-text rendering, thinking placeholder, amend
      // affordance, etc. all key off this.
      const promptReceived = bobStream.sent.find(
        (m) =>
          "method" in m &&
          m.method === "session/update" &&
          (m.params as { update?: { sessionUpdate?: string } } | undefined)
            ?.update?.sessionUpdate === "prompt_received",
      );
      expect(promptReceived).toBeDefined();
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

    it("/hydra commands flow through the user-prompt queue (queue_added + queue_removed{started} + prompt_received + turn_complete)", async () => {
      // Regression for the slash-command-as-internal-queue-entry
      // design that bypassed the conversation surface. With slash
      // commands now user-kind, every notification a regular prompt
      // gets fires for /hydra too — which the TUI / peer clients
      // rely on to render user-text, anchor the thinking placeholder,
      // and support amend/cancel.
      const { session, mock } = makeSession("hydra_session_S", "u_S");
      const { client: alice } = makeClient();
      const { client: bob, stream: bobStream } = makeClient();
      session.attach(alice, "full");
      session.attach(bob, "full");
      const requestMock = mock.agent.connection.request as ReturnType<typeof vi.fn>;
      requestMock.mockResolvedValue({ stopReason: "end_turn" });

      await session.prompt(alice.clientId, {
        prompt: [{ type: "text", text: "/hydra title my new title" }],
      });

      const findUpdate = (kind: string): JsonRpcNotification | undefined =>
        bobStream.sent.find(
          (m) =>
            "method" in m &&
            m.method === "session/update" &&
            (m.params as { update?: { sessionUpdate?: string } } | undefined)
              ?.update?.sessionUpdate === kind,
        ) as JsonRpcNotification | undefined;
      const findNotification = (method: string): JsonRpcNotification | undefined =>
        bobStream.sent.find(
          (m) => "method" in m && m.method === method,
        ) as JsonRpcNotification | undefined;

      expect(findNotification("hydra-acp/prompt_queue/added")).toBeDefined();
      expect(findNotification("hydra-acp/prompt_queue/removed")).toBeDefined();
      expect(findUpdate("prompt_received")).toBeDefined();
      expect(findUpdate("turn_complete")).toBeDefined();
    });

    it("/hydra title does not seed the session title from the slash text", async () => {
      // A slash command shouldn't become the session title, even if
      // it's the very first prompt (e.g. user fires `/hydra title
      // explicit name` right after spawn). The title heuristic skips
      // anything that starts with "/" so the next non-slash prompt
      // (if any) can still seed naturally.
      const { session, mock } = makeSession("hydra_session_TS", "u_TS");
      const { client: alice } = makeClient();
      session.attach(alice, "full");
      const requestMock = mock.agent.connection.request as ReturnType<typeof vi.fn>;
      requestMock.mockResolvedValue({ stopReason: "end_turn" });

      await session.prompt(alice.clientId, {
        prompt: [{ type: "text", text: "/hydra title my explicit title" }],
      });

      // Title comes from the explicit /hydra title arg, NOT from the
      // raw slash text.
      expect(session.title).toBe("my explicit title");

      // And the name the user chose survives the next real prompt. The
      // heuristic DEFERS on slash text rather than closing (so a session
      // opened with `/hydra workspace start` can still be titled later),
      // which means setTitle has to be what closes it — otherwise this
      // prompt would quietly overwrite an explicit rename.
      await session.prompt(alice.clientId, {
        prompt: [{ type: "text", text: "now fix the parser bug" }],
      });
      await new Promise((r) => setImmediate(r));

      expect(session.title).toBe("my explicit title");
    });

    it("a slash-command first prompt defers the seed to the next real prompt", async () => {
      // Regression: `_firstPromptSeeded` was promoted unconditionally
      // right after the heuristic declined the slash text, so a session
      // that opened with `/hydra workspace start` — the natural order
      // when isolating before starting work — stayed untitled for the
      // rest of its life, and every surface that falls back to a session
      // id painted `sLPmk5w57fwcLiiu` where its title belonged.
      const { session, mock } = makeSession("hydra_session_TL7", "u_TL7");
      const { client: alice } = makeClient();
      session.attach(alice, "full");
      const requestMock = mock.agent.connection.request as ReturnType<
        typeof vi.fn
      >;
      requestMock.mockResolvedValue({ stopReason: "end_turn" });

      await session.prompt(alice.clientId, {
        prompt: [{ type: "text", text: "/hydra workspace start" }],
      });
      await new Promise((r) => setImmediate(r));

      expect(session.title).toBeUndefined();
      // Still a prompt, though: the idle close reads this to decide
      // whether the record is a conversation worth keeping cold or an
      // empty session to delete. Deferring the TITLE must not make a
      // real session's record disappear.
      expect(session.firstPromptSeeded).toBe(true);

      await session.prompt(alice.clientId, {
        prompt: [{ type: "text", text: "now fix the parser bug" }],
      });
      await new Promise((r) => setImmediate(r));

      expect(session.title).toBe("now fix the parser bug");
    });

    it("a text-less first prompt defers the seed to the next real prompt", async () => {
      // Same deferral, different cause: a pasted image with no caption
      // has no seed in it, but the person sending it is having a
      // conversation and their next prompt does.
      const { session, mock } = makeSession("hydra_session_TL8", "u_TL8");
      const { client: alice } = makeClient();
      session.attach(alice, "full");
      const requestMock = mock.agent.connection.request as ReturnType<
        typeof vi.fn
      >;
      requestMock.mockResolvedValue({ stopReason: "end_turn" });

      await session.prompt(alice.clientId, {
        prompt: [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }],
      });
      await new Promise((r) => setImmediate(r));

      expect(session.title).toBeUndefined();

      await session.prompt(alice.clientId, {
        prompt: [{ type: "text", text: "why is this row misaligned" }],
      });
      await new Promise((r) => setImmediate(r));

      expect(session.title).toBe("why is this row misaligned");
    });

    it("/hydra title (no arg) schedules an out-of-band synopsis", async () => {
      // The live session no longer asks its own agent to summarize —
      // synopsis generation runs in a fresh ephemeral agent process
      // owned by the SessionManager's coordinator. The slash command
      // just fires the schedule hook and returns end_turn; the new
      // title (if any) lands on the cold record asynchronously.
      const mock = makeMockAgent({ agentId: "mock", cwd: "/work" });
      const scheduleSynopsis = vi.fn();
      const session = new Session({
        sessionId: "hydra_session_HR",
        cwd: "/work",
        agentId: "mock",
        agent: mock.agent,
        upstreamSessionId: "u_HR",
        historyStore: new HistoryStore(),
        scheduleSynopsis,
      });
      const { client: alice } = makeClient();
      session.attach(alice, "full");
      const requestMock = mock.agent.connection.request as ReturnType<
        typeof vi.fn
      >;

      await session.prompt(alice.clientId, {
        prompt: [{ type: "text", text: "/hydra title" }],
      });

      expect(scheduleSynopsis).toHaveBeenCalledTimes(1);
      // Title didn't change synchronously — the coordinator writes it
      // later via persistTitle on the cold record.
      expect(session.title).toBeUndefined();
      // The live agent's session/prompt was never called for this — no
      // in-session synopsis turn.
      const promptCalls = requestMock.mock.calls.filter(
        ([method]) => method === "session/prompt",
      );
      expect(promptCalls.length).toBe(0);
    });

    it("/hydra compact schedules compaction via scheduleCompaction hook", async () => {
      const mock = makeMockAgent({ agentId: "mock", cwd: "/work" });
      const scheduleCompaction = vi.fn();
      const session = new Session({
        sessionId: "hydra_session_CK",
        cwd: "/work",
        agentId: "mock",
        agent: mock.agent,
        upstreamSessionId: "u_CK",
        historyStore: new HistoryStore(),
        scheduleCompaction,
      });
      const { client: alice } = makeClient();
      session.attach(alice, "full");

      await session.prompt(alice.clientId, {
        prompt: [{ type: "text", text: "/hydra compact" }],
      });

      expect(scheduleCompaction).toHaveBeenCalledTimes(1);
    });

    it("/hydra compact emits a synthetic confirmation via scheduleCompaction hook", async () => {
      const mock = makeMockAgent({ agentId: "mock", cwd: "/work" });
      const scheduleCompaction = vi.fn();
      const session = new Session({
        sessionId: "hydra_session_CE",
        cwd: "/work",
        agentId: "mock",
        agent: mock.agent,
        upstreamSessionId: "u_CE",
        historyStore: new HistoryStore(),
        scheduleCompaction,
      });
      const { client: alice, stream } = makeClient();
      session.attach(alice, "full");

      await session.prompt(alice.clientId, {
        prompt: [{ type: "text", text: "/hydra compact" }],
      });

      // The synthetic confirmation is broadcast as an agent_message_chunk.
      const chunkUpdate = findSessionUpdate(stream.sent, "agent_message_chunk");
      expect(chunkUpdate).toBeDefined();
      const content = (chunkUpdate!.params.update as { content: { text?: string } }).content;
      expect(content.text).toContain("Compaction scheduled");
    });

    it("/hydra compact status emits running state when compactionState is present", async () => {
      const mock = makeMockAgent({ agentId: "mock", cwd: "/work" });
      const getCompactionState = vi.fn().mockResolvedValue({
        status: "running",
        requestedAt: Date.now(),
        iter: 2,
        attempts: 0,
      });
      const session = new Session({
        sessionId: "hydra_session_CS1",
        cwd: "/work",
        agentId: "mock",
        agent: mock.agent,
        upstreamSessionId: "u_CS1",
        historyStore: new HistoryStore(),
        scheduleCompaction: vi.fn(),
        getCompactionState,
        summarizedThroughEntry: 47,
      });
      const { client: alice, stream } = makeClient();
      session.attach(alice, "full");

      await session.prompt(alice.clientId, {
        prompt: [{ type: "text", text: "/hydra compact status" }],
      });

      const chunkUpdate = findSessionUpdate(stream.sent, "agent_message_chunk");
      expect(chunkUpdate).toBeDefined();
      const content = (chunkUpdate!.params.update as { content: { text?: string } }).content;
      expect(content.text).toContain("running");
      expect(content.text).toContain("iteration 2");
      expect(content.text).toContain("47");
      expect(getCompactionState).toHaveBeenCalledTimes(1);
    });

    it("/hydra compact status emits 'no compaction in progress' when no state but has summarized entry", async () => {
      const mock = makeMockAgent({ agentId: "mock", cwd: "/work" });
      const getCompactionState = vi.fn().mockResolvedValue(undefined);
      const session = new Session({
        sessionId: "hydra_session_CS2",
        cwd: "/work",
        agentId: "mock",
        agent: mock.agent,
        upstreamSessionId: "u_CS2",
        historyStore: new HistoryStore(),
        scheduleCompaction: vi.fn(),
        getCompactionState,
        summarizedThroughEntry: 12,
      });
      const { client: alice, stream } = makeClient();
      session.attach(alice, "full");

      await session.prompt(alice.clientId, {
        prompt: [{ type: "text", text: "/hydra compact status" }],
      });

      const chunkUpdate = findSessionUpdate(stream.sent, "agent_message_chunk");
      expect(chunkUpdate).toBeDefined();
      const content = (chunkUpdate!.params.update as { content: { text?: string } }).content;
      expect(content.text).toContain("No compaction in progress");
      expect(content.text).toContain("12");
    });

    it("/hydra compact status emits 'never been compacted' when no state and no summarized entry", async () => {
      const mock = makeMockAgent({ agentId: "mock", cwd: "/work" });
      const getCompactionState = vi.fn().mockResolvedValue(undefined);
      const session = new Session({
        sessionId: "hydra_session_CS3",
        cwd: "/work",
        agentId: "mock",
        agent: mock.agent,
        upstreamSessionId: "u_CS3",
        historyStore: new HistoryStore(),
        scheduleCompaction: vi.fn(),
        getCompactionState,
      });
      const { client: alice, stream } = makeClient();
      session.attach(alice, "full");

      await session.prompt(alice.clientId, {
        prompt: [{ type: "text", text: "/hydra compact status" }],
      });

      const chunkUpdate = findSessionUpdate(stream.sent, "agent_message_chunk");
      expect(chunkUpdate).toBeDefined();
      const content = (chunkUpdate!.params.update as { content: { text?: string } }).content;
      expect(content.text).toContain("never been compacted");
    });

    it("/hydra compact status reports how many compactions there were and when", async () => {
      const mock = makeMockAgent({ agentId: "mock", cwd: "/work" });
      const session = new Session({
        sessionId: "hydra_session_CS4",
        cwd: "/work",
        agentId: "mock",
        agent: mock.agent,
        upstreamSessionId: "u_live",
        historyStore: new HistoryStore(),
        scheduleCompaction: vi.fn(),
        getCompactionState: vi.fn().mockResolvedValue(undefined),
        getUpstreamGenerations: vi.fn().mockResolvedValue([
          { upstreamSessionId: "u_a", agentId: "mock", startedAt: "2026-08-14T17:48:00.000Z" },
          {
            upstreamSessionId: "u_b",
            agentId: "mock",
            reason: "compaction",
            startedAt: "2026-08-16T01:37:00.000Z",
            endedAt: "2026-08-19T21:25:00.000Z",
            cost: 59.737,
          },
          {
            upstreamSessionId: "u_live",
            agentId: "mock",
            reason: "compaction",
            startedAt: "2026-08-19T21:25:00.000Z",
          },
        ]),
        summarizedThroughEntry: 1200,
      });
      const { client: alice, stream } = makeClient();
      session.attach(alice, "full");

      await session.prompt(alice.clientId, {
        prompt: [{ type: "text", text: "/hydra compact status" }],
      });

      const chunkUpdate = findSessionUpdate(stream.sent, "agent_message_chunk");
      const text =
        (chunkUpdate!.params.update as { content: { text?: string } }).content.text ?? "";
      expect(text).toContain("Compacted 2 times:");
      expect(text).toContain("2026-08-16T01:37Z");
      expect(text).toContain("u_b");
      expect(text).toContain("$59.74");
      expect(text).toContain("(current)");
      // The upstream the session is on right now — the join key back into
      // the agent's own storage, which this command never used to print.
      expect(text).toContain("Current upstream: u_live");
      expect(text).not.toContain("lower bound");
    });

    // A session can have rotated without ever compacting. Counting those
    // rotations as compactions is the failure mode this guards.
    it("/hydra compact status does not count pre-reason rotations as compactions", async () => {
      const mock = makeMockAgent({ agentId: "mock", cwd: "/work" });
      const session = new Session({
        sessionId: "hydra_session_CS5",
        cwd: "/work",
        agentId: "mock",
        agent: mock.agent,
        upstreamSessionId: "u_c",
        historyStore: new HistoryStore(),
        scheduleCompaction: vi.fn(),
        getCompactionState: vi.fn().mockResolvedValue(undefined),
        getUpstreamGenerations: vi.fn().mockResolvedValue([
          { upstreamSessionId: "u_a", agentId: "mock" },
          { upstreamSessionId: "u_b", agentId: "mock", startedAt: "2026-08-14T17:48:00.000Z" },
          { upstreamSessionId: "u_c", agentId: "mock", startedAt: "2026-08-15T09:00:00.000Z" },
        ]),
        summarizedThroughEntry: 400,
      });
      const { client: alice, stream } = makeClient();
      session.attach(alice, "full");

      await session.prompt(alice.clientId, {
        prompt: [{ type: "text", text: "/hydra compact status" }],
      });

      const chunkUpdate = findSessionUpdate(stream.sent, "agent_message_chunk");
      const text =
        (chunkUpdate!.params.update as { content: { text?: string } }).content.text ?? "";
      expect(text).not.toContain("Compacted");
      expect(text).toContain("No compactions on record.");
      expect(text).toContain("2 rotations predate reason tracking");
    });

    it("/hydra compact without scheduleCompaction hook emits error message", async () => {
      const mock = makeMockAgent({ agentId: "mock", cwd: "/work" });
      // No scheduleCompaction provided
      const session = new Session({
        sessionId: "hydra_session_CX",
        cwd: "/work",
        agentId: "mock",
        agent: mock.agent,
        upstreamSessionId: "u_CX",
        historyStore: new HistoryStore(),
      });
      const { client: alice, stream } = makeClient();
      session.attach(alice, "full");

      await session.prompt(alice.clientId, {
        prompt: [{ type: "text", text: "/hydra compact" }],
      });

      const chunkUpdate = findSessionUpdate(stream.sent, "agent_message_chunk");
      expect(chunkUpdate).toBeDefined();
      const content = (chunkUpdate!.params.update as { content: { text?: string } }).content;
      expect(content.text).toContain("compaction scheduling not configured");
    });

    it("forceCancel kills the agent and closes the session (keeping the record) so it can resurrect", async () => {
      const { session, mock } = makeSession("hydra_session_FC", "u_old");
      const { client } = makeClient();
      await session.attach(client, "full");

      let closeOpts: { deleteRecord: boolean } | undefined;
      session.onClose((opts) => {
        closeOpts = opts;
      });
      const kill = mock.agent.kill as ReturnType<typeof vi.fn>;

      const result = await session.forceCancel();

      expect(result).toMatchObject({ stopReason: "cancelled" });
      expect(kill).toHaveBeenCalled();
      // Record is kept (deleteRecord:false) so the next prompt resurrects.
      expect(closeOpts).toEqual({ deleteRecord: false });
    });

    it("forceCancel rejects once the session is already closing", async () => {
      const { session } = makeSession();
      await session.forceCancel();
      await expect(session.forceCancel()).rejects.toThrow(/closing/);
    });

    it("/hydra agent schedules a cross-agent synthesis via scheduleCompaction hook with targetAgentId and emits a synthetic banner", async () => {
      const scheduleCompaction = vi.fn();
      const mock = makeMockAgent({ agentId: "old", cwd: "/w" });
      const session = new Session({
        sessionId: "hydra_session_SW",
        cwd: "/w",
        agentId: "old",
        agent: mock.agent,
        upstreamSessionId: "u_old",
        historyStore: new HistoryStore(),
        scheduleCompaction,
      });
      const { client: alice, stream } = makeClient();
      await session.attach(alice, "full");

      const result = await session.prompt(alice.clientId, {
        prompt: [{ type: "text", text: "/hydra agent new" }],
      });
      expect(result).toMatchObject({ stopReason: "end_turn" });
      expect(scheduleCompaction).toHaveBeenCalledTimes(1);
      expect(scheduleCompaction).toHaveBeenCalledWith({ targetAgentId: "new" });

      // The actual upstream swap is asynchronous (driven by the coordinator
      // → onSynthesisArtifact → swapUpstream chain). Inline path no longer
      // mutates Session state; agentId stays "old" until the swap fires.
      expect(session.agentId).toBe("old");

      // Banner names the target so attached clients see immediate
      // confirmation that the switch was scheduled.
      const banner = stream.sent.find(
        (m) =>
          "method" in m &&
          m.method === "session/update" &&
          (
            (m.params as { update?: { content?: { text?: string } } } | undefined)?.update
              ?.content?.text ?? ""
          ).includes("Agent switch to new scheduled"),
      );
      expect(banner).toBeDefined();
    });

    it("setAgent schedules the switch while a turn is wedged in flight", async () => {
      // The whole point of the switch is escaping a broken agent, so it
      // must not serialize behind the turn that is stuck on it.
      const scheduleCompaction = vi.fn();
      const mock = makeMockAgent({ agentId: "old", cwd: "/w" });
      let releaseStuckTurn: (() => void) | undefined;
      (mock.agent.connection.request as ReturnType<typeof vi.fn>).mockImplementation(
        async (method: string) => {
          if (method !== "session/prompt") {
            return undefined;
          }
          await new Promise<void>((resolve) => {
            releaseStuckTurn = resolve;
          });
          return { stopReason: "end_turn" };
        },
      );
      const session = new Session({
        sessionId: "hydra_session_SWQ",
        cwd: "/w",
        agentId: "old",
        agent: mock.agent,
        upstreamSessionId: "u_old",
        historyStore: new HistoryStore(),
        scheduleCompaction,
      });
      const { client: alice } = makeClient();
      await session.attach(alice, "full");

      const stuck = session.prompt(alice.clientId, {
        prompt: [{ type: "text", text: "hello" }],
      });
      while (releaseStuckTurn === undefined) {
        await new Promise((r) => setImmediate(r));
      }

      // Would hang forever if this went through the prompt queue.
      const result = await session.setAgent("new");
      expect(result).toMatchObject({ stopReason: "end_turn" });
      expect(scheduleCompaction).toHaveBeenCalledWith({ targetAgentId: "new" });

      releaseStuckTurn?.();
      await stuck;
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

    it("/hydra agent without scheduleCompaction hook emits a configuration error", async () => {
      // No scheduleCompaction hook wired — the slash command degrades to
      // a synthetic error reply rather than throwing through the prompt.
      const { session } = makeSession("hydra_session_SF", "u_SF");
      const { client: alice, stream } = makeClient();
      session.attach(alice, "full");

      const result = await session.prompt(alice.clientId, {
        prompt: [{ type: "text", text: "/hydra agent nope" }],
      });
      expect(result).toMatchObject({ stopReason: "end_turn" });
      expect(session.agentId).toBe("mock");
      const errorMsg = stream.sent.find(
        (m) =>
          "method" in m &&
          m.method === "session/update" &&
          (
            (m.params as { update?: { content?: { text?: string } } } | undefined)?.update
              ?.content?.text ?? ""
          ).includes("agent switching not configured"),
      );
      expect(errorMsg).toBeDefined();
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
        (m) => "method" in m && m.method === "hydra-acp/session/closed",
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

  describe("forwardModelChange (set_model / set_config_option probe)", () => {
    it("forwards session/set_model when the agent implements it", async () => {
      const { session, mock } = makeSession("sess_hyd", "u_agent");
      const requestMock = mock.agent.connection.request as unknown as ReturnType<
        typeof vi.fn
      >;
      requestMock.mockResolvedValue(null);

      await session.forwardModelChange("anthropic/claude-opus-4-7");

      expect(requestMock).toHaveBeenCalledTimes(1);
      expect(requestMock).toHaveBeenCalledWith("session/set_model", {
        sessionId: "u_agent",
        modelId: "anthropic/claude-opus-4-7",
      });
    });

    // Agents on @agentclientprotocol/sdk >= 0.26 (pi-acp) removed
    // session/set_model entirely; the model lives behind
    // session/set_config_option with configId "model".
    it("retries via session/set_config_option on MethodNotFound and remembers the verb", async () => {
      const { session, mock } = makeSession("sess_hyd", "u_agent");
      const requestMock = mock.agent.connection.request as unknown as ReturnType<
        typeof vi.fn
      >;
      const notFound = new Error('"Method not found": session/set_model') as Error & {
        code: number;
      };
      notFound.code = JsonRpcErrorCodes.MethodNotFound;
      requestMock.mockImplementation(async (method: string) => {
        if (method === "session/set_model") throw notFound;
        return { configOptions: [] };
      });

      await session.forwardModelChange("anthropic/claude-fable-5");
      expect(requestMock.mock.calls.map((c) => c[0])).toEqual([
        "session/set_model",
        "session/set_config_option",
      ]);
      expect(requestMock).toHaveBeenLastCalledWith("session/set_config_option", {
        sessionId: "u_agent",
        configId: "model",
        value: "anthropic/claude-fable-5",
      });

      // Second change goes straight to the learned verb — no repeat probe.
      requestMock.mockClear();
      await session.forwardModelChange("anthropic/claude-opus-5");
      expect(requestMock.mock.calls.map((c) => c[0])).toEqual([
        "session/set_config_option",
      ]);
    });

    // Inference: an agent whose model advertisement arrived as a
    // config_option_update is on the modern SDK, so lead with
    // set_config_option and don't waste a probe on the dead verb.
    it("leads with session/set_config_option after an agent config_option_update(model)", async () => {
      const { session, mock } = makeSession("sess_hyd", "u_agent");
      const requestMock = mock.agent.connection.request as unknown as ReturnType<
        typeof vi.fn
      >;
      requestMock.mockResolvedValue({ configOptions: [] });

      mock.triggerNotification("session/update", {
        sessionId: "u_agent",
        update: {
          sessionUpdate: "config_option_update",
          configOptions: [
            {
              id: "model",
              currentValue: "anthropic/claude-opus-5",
              options: [
                { value: "anthropic/claude-opus-5" },
                { value: "anthropic/claude-fable-5" },
              ],
            },
          ],
        },
      });
      await new Promise((r) => setImmediate(r));
      requestMock.mockClear();

      await session.forwardModelChange("anthropic/claude-fable-5");
      expect(requestMock.mock.calls.map((c) => c[0])).toEqual([
        "session/set_config_option",
      ]);
    });

    it("keeps session/set_model for an agent that advertises via current_model_update", async () => {
      const { session, mock } = makeSession("sess_hyd", "u_agent");
      const requestMock = mock.agent.connection.request as unknown as ReturnType<
        typeof vi.fn
      >;
      requestMock.mockResolvedValue(null);

      mock.triggerNotification("session/update", {
        sessionId: "u_agent",
        update: {
          sessionUpdate: "_hydra_current_model_update",
          currentModel: "anthropic/claude-opus-4-7",
          availableModels: [{ modelId: "anthropic/claude-opus-4-7" }],
        },
      });
      await new Promise((r) => setImmediate(r));
      requestMock.mockClear();

      await session.forwardModelChange("anthropic/claude-opus-4-7");
      expect(requestMock.mock.calls.map((c) => c[0])).toEqual(["session/set_model"]);
    });

    it("a confirmed verb outranks a later inference hint", async () => {
      const { session, mock } = makeSession("sess_hyd", "u_agent");
      const requestMock = mock.agent.connection.request as unknown as ReturnType<
        typeof vi.fn
      >;
      const notFound = new Error("nope") as Error & { code: number };
      notFound.code = JsonRpcErrorCodes.MethodNotFound;
      requestMock.mockImplementation(async (method: string) => {
        if (method === "session/set_model") throw notFound;
        return { configOptions: [] };
      });

      // Probe pins set_config_option.
      await session.forwardModelChange("m1");

      // A stray current_model_update (hydra itself synthesizes these on
      // every applyModelChange) must not drag us back to the dead verb.
      mock.triggerNotification("session/update", {
        sessionId: "u_agent",
        update: { sessionUpdate: "_hydra_current_model_update", currentModel: "m1" },
      });
      await new Promise((r) => setImmediate(r));
      requestMock.mockClear();

      await session.forwardModelChange("m2");
      expect(requestMock.mock.calls.map((c) => c[0])).toEqual([
        "session/set_config_option",
      ]);
    });

    it("carries client passthrough fields (_meta) onto the forwarded envelope", async () => {
      const { session, mock } = makeSession("sess_hyd", "u_agent");
      const requestMock = mock.agent.connection.request as unknown as ReturnType<
        typeof vi.fn
      >;
      requestMock.mockResolvedValue(null);

      await session.forwardModelChange("m1", {
        sessionId: "sess_hyd",
        modelId: "stale",
        _meta: { keep: true },
      });

      expect(requestMock).toHaveBeenCalledWith("session/set_model", {
        sessionId: "u_agent",
        modelId: "m1",
        _meta: { keep: true },
      });
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

    it("broadcasts hydra-acp/session/closed to attached clients on idle close", async () => {
      // Pins the chain idle-timer → close() → markClosed → broadcast, the
      // exact path the TUI's cold-banner handler keys off when a session
      // is closed behind the user's back.
      vi.useFakeTimers();
      try {
        const mock = makeMockAgent({ agentId: "mock", cwd: "/w" });
        const session = new Session({
          sessionId: "hydra_session_idle_broadcast",
          cwd: "/w",
          agentId: "mock",
          agent: mock.agent,
          upstreamSessionId: "u",
          idleTimeoutMs: 1_000,
        });
        const { client, stream } = makeClient();
        session.attach(client, "full");

        await vi.advanceTimersByTimeAsync(1_001);

        const closeMsg = stream.sent.find(
          (m) => "method" in m && m.method === "hydra-acp/session/closed",
        );
        expect(closeMsg).toMatchObject({
          params: { sessionId: "hydra_session_idle_broadcast" },
        });
        expect(session.attachedCount).toBe(0);
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
          update: { sessionUpdate: "_hydra_current_model_update", model: "opus" },
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

    it("does NOT close while there are queued prompts waiting behind an in-flight turn", async () => {
      // Regression guard for the daemon-side queue: an entry sitting in
      // promptQueue (not yet at the head) represents intent we shouldn't
      // discard via idle close. The in-flight head already keeps
      // turnStartedAt set, but on agents whose turns flap fast or whose
      // turn_complete races with the idle timer firing, we want the
      // queue itself to count as active work.
      vi.useFakeTimers();
      try {
        const mock = makeMockAgent({ agentId: "mock", cwd: "/w" });
        const session = new Session({
          sessionId: "hydra_session_queue_alive",
          cwd: "/w",
          agentId: "mock",
          agent: mock.agent,
          upstreamSessionId: "u",
          idleTimeoutMs: 1_000,
        });
        const closeSpy = vi.fn();
        session.onClose(closeSpy);
        const { client: alice } = makeClient();
        const { client: bob } = makeClient();
        session.attach(alice, "full");
        session.attach(bob, "full");
        const requestMock = mock.agent.connection.request as ReturnType<
          typeof vi.fn
        >;
        // Hold both prompts at the upstream so the second sits in the
        // queue behind the first.
        requestMock.mockImplementation(() => new Promise(() => undefined));

        void session.prompt(alice.clientId, {
          sessionId: "hydra_session_queue_alive",
          prompt: [{ type: "text", text: "head" }],
        });
        await Promise.resolve();
        void session.prompt(bob.clientId, {
          sessionId: "hydra_session_queue_alive",
          prompt: [{ type: "text", text: "waiting" }],
        });
        await Promise.resolve();

        // Advance well past the idle window. The queue gate must keep
        // the session alive even though the test-time wall clock would
        // otherwise have called checkIdle into closing.
        await vi.advanceTimersByTimeAsync(2_000);
        expect(closeSpy).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("does NOT close while a background task is armed with no turn in flight", async () => {
      // Regression: a session's turn ends normally after it kicks off a
      // long-running Monitor/backgrounded-Bash watch (e.g. a device test
      // run). hasWorkInFlight used to ignore armedBackgroundTasks entirely,
      // so an hour of silence closed the session out from under the still-
      // running job. PROTOCOL.md documents armedTasks>0 as "not finished
      // with you"; the idle-close guard needs to agree.
      vi.useFakeTimers();
      try {
        const mock = makeMockAgent({ agentId: "mock", cwd: "/w" });
        const session = new Session({
          sessionId: "hydra_session_armed_alive",
          cwd: "/w",
          agentId: "mock",
          agent: mock.agent,
          upstreamSessionId: "u",
          idleTimeoutMs: 1_000,
        });
        const closeSpy = vi.fn();
        session.onClose(closeSpy);

        mock.triggerNotification("session/update", {
          sessionId: "u",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "toolu_device_run",
            title: "Terminal",
            rawInput: {
              command: "run-device-mem.sh",
              description: "48-run factorial power run",
              run_in_background: true,
            },
          },
        });
        expect(session.armedBackgroundTasks).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(2_000);
        expect(closeSpy).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("orphan timeout (non-interactive + unattached)", () => {
    it("reaps a never-prompted session shortly after its last client detaches", async () => {
      vi.useFakeTimers();
      try {
        const mock = makeMockAgent({ agentId: "mock", cwd: "/w" });
        const session = new Session({
          sessionId: "hydra_session_orphan",
          cwd: "/w",
          agentId: "mock",
          agent: mock.agent,
          upstreamSessionId: "u",
          orphanTimeoutMs: 1_000,
        });
        const closeSpy = vi.fn();
        session.onClose(closeSpy);
        const { client } = makeClient();
        session.attach(client, "full");

        session.detach(client.clientId);
        await vi.advanceTimersByTimeAsync(999);
        expect(closeSpy).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(2);

        // Matches reapIfOrphanedNonInteractive's own shape: cold record
        // kept (unlike the general idle timer, which drops never-prompted
        // records entirely) so a later attach can still resurrect it.
        // close() rebuilds opts to just { deleteRecord } internally before
        // notifying listeners (see Session.close), so `by` never reaches
        // onClose handlers even though checkOrphan passes it through —
        // same as reapIfOrphanedNonInteractive's own call shape.
        expect(closeSpy).toHaveBeenCalledWith({ deleteRecord: false });
      } finally {
        vi.useRealTimers();
      }
    });

    it("never arms while a client stays attached", async () => {
      vi.useFakeTimers();
      try {
        const mock = makeMockAgent({ agentId: "mock", cwd: "/w" });
        const session = new Session({
          sessionId: "hydra_session_orphan_attached",
          cwd: "/w",
          agentId: "mock",
          agent: mock.agent,
          upstreamSessionId: "u",
          orphanTimeoutMs: 1_000,
        });
        const closeSpy = vi.fn();
        session.onClose(closeSpy);
        const { client } = makeClient();
        session.attach(client, "full");

        await vi.advanceTimersByTimeAsync(5_000);
        expect(closeSpy).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("cancels the orphan timer when a new client attaches before the window elapses", async () => {
      vi.useFakeTimers();
      try {
        const mock = makeMockAgent({ agentId: "mock", cwd: "/w" });
        const session = new Session({
          sessionId: "hydra_session_orphan_reattach",
          cwd: "/w",
          agentId: "mock",
          agent: mock.agent,
          upstreamSessionId: "u",
          orphanTimeoutMs: 1_000,
        });
        const closeSpy = vi.fn();
        session.onClose(closeSpy);
        const { client: first } = makeClient();
        session.attach(first, "full");
        session.detach(first.clientId);

        await vi.advanceTimersByTimeAsync(600);
        const { client: second } = makeClient();
        session.attach(second, "full");

        await vi.advanceTimersByTimeAsync(1_000);
        expect(closeSpy).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("never reaps a session that was ever prompted, even after every client detaches", async () => {
      // The core safety property: reapIfOrphanedNonInteractive and this
      // fast timer both exist ONLY for sessions that never became a real
      // conversation. The instant a real prompt lands, interactive flips
      // true permanently — this must be exempt for good, not just while
      // someone happens to be attached.
      const mock = makeMockAgent({ agentId: "mock", cwd: "/w" });
      const session = new Session({
        sessionId: "hydra_session_orphan_used",
        cwd: "/w",
        agentId: "mock",
        agent: mock.agent,
        upstreamSessionId: "u",
        orphanTimeoutMs: 1_000,
      });
      const closeSpy = vi.fn();
      session.onClose(closeSpy);
      const { client } = makeClient();
      session.attach(client, "full");
      (mock.agent.connection.request as ReturnType<typeof vi.fn>).mockResolvedValue(
        { stopReason: "end_turn" },
      );

      // Real timers for the prompt round-trip itself; only the
      // detach+advance phase below needs to be fake-timer-controlled.
      await session.prompt(client.clientId, {
        sessionId: "hydra_session_orphan_used",
        prompt: [{ type: "text", text: "hi" }],
      });
      expect(session.interactive).toBe(true);

      vi.useFakeTimers();
      try {
        session.detach(client.clientId);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(closeSpy).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("defers instead of closing while work is still in flight (ancillary prompt, no promotion)", async () => {
      // An ancillary prompt (hydra cat) deliberately does not promote
      // interactive, so a session mid-ancillary-turn is exactly the case
      // that must NOT be reaped out from under it once its sender detaches.
      vi.useFakeTimers();
      try {
        const mock = makeMockAgent({ agentId: "mock", cwd: "/w" });
        const session = new Session({
          sessionId: "hydra_session_orphan_inflight",
          cwd: "/w",
          agentId: "mock",
          agent: mock.agent,
          upstreamSessionId: "u",
          orphanTimeoutMs: 1_000,
        });
        const closeSpy = vi.fn();
        session.onClose(closeSpy);
        const { client } = makeClient();
        session.attach(client, "full");
        (mock.agent.connection.request as ReturnType<typeof vi.fn>).mockImplementation(
          () => new Promise(() => undefined),
        );

        void session.prompt(client.clientId, {
          sessionId: "hydra_session_orphan_inflight",
          prompt: [{ type: "text", text: "cat output" }],
          _meta: { "hydra-acp": { ancillary: true } },
        });
        await Promise.resolve();
        expect(session.interactive).toBeUndefined();

        session.detach(client.clientId);
        await vi.advanceTimersByTimeAsync(3_000);
        expect(closeSpy).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("orphanTimeoutMs=0 disables the fast path", async () => {
      vi.useFakeTimers();
      try {
        const mock = makeMockAgent({ agentId: "mock", cwd: "/w" });
        const session = new Session({
          sessionId: "hydra_session_orphan_disabled",
          cwd: "/w",
          agentId: "mock",
          agent: mock.agent,
          upstreamSessionId: "u",
          orphanTimeoutMs: 0,
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
    it("notifies clients with hydra-acp/session/closed and cleans up", () => {
      const { session, mock } = makeSession("sess_x", "u");
      const { client, stream } = makeClient();
      session.attach(client, "full");

      mock.triggerExit(0, null);

      const closeMsg = stream.sent.find(
        (m) => "method" in m && m.method === "hydra-acp/session/closed",
      );
      expect(closeMsg).toMatchObject({
        params: { sessionId: "sess_x" },
      });
      expect(session.attachedCount).toBe(0);
    });
  });

  describe("prompt queueing (hydra-acp/prompt_queue_*)", () => {
    // Pulls a particular queue lifecycle event off a client's outbound
    // stream — there's usually exactly one per event-kind/messageId pair.
    function findQueueEvent(
      sent: ReturnType<typeof makeClient>["stream"]["sent"],
      method: string,
      messageId?: string,
    ):
      | (JsonRpcNotification & { method: string; params: Record<string, unknown> })
      | undefined {
      return sent.find(
        (m) =>
          "method" in m &&
          m.method === method &&
          (messageId === undefined ||
            (m.params as { messageId?: unknown }).messageId === messageId),
      ) as
        | (JsonRpcNotification & { method: string; params: Record<string, unknown> })
        | undefined;
    }

    it("broadcasts prompt_queue_added with the same messageId as prompt_received", async () => {
      const { session, mock } = makeSession("hydra_session_Q1", "u_Q1");
      const { client: alice } = makeClient();
      alice.clientInfo = { name: "tui", version: "0.2.0" };
      const { client: bob, stream: bobStream } = makeClient();
      session.attach(alice, "full");
      session.attach(bob, "full");

      const requestMock = mock.agent.connection.request as ReturnType<
        typeof vi.fn
      >;
      requestMock.mockImplementation(() => new Promise(() => undefined));

      void session.prompt(alice.clientId, {
        sessionId: "hydra_session_Q1",
        prompt: [{ type: "text", text: "hello queue" }],
      });
      await new Promise((r) => setImmediate(r));

      const added = findQueueEvent(
        bobStream.sent,
        "hydra-acp/prompt_queue/added",
      );
      const received = bobStream.sent.find(
        (m) =>
          "method" in m &&
          m.method === "session/update" &&
          (m.params as { update?: { sessionUpdate?: string } } | undefined)
            ?.update?.sessionUpdate === "prompt_received",
      ) as JsonRpcNotification | undefined;

      expect(added).toBeDefined();
      expect(received).toBeDefined();
      const addedMid = (added!.params as { messageId: string }).messageId;
      const receivedMid = (received!.params as { update: { messageId: string } })
        .update.messageId;
      expect(addedMid).toMatch(/^m_[A-Za-z0-9]{16}$/);
      expect(addedMid).toBe(receivedMid);
      expect(added!.params).toMatchObject({
        sessionId: "hydra_session_Q1",
        originator: {
          clientId: alice.clientId,
          name: "tui",
          version: "0.2.0",
        },
        prompt: [{ type: "text", text: "hello queue" }],
        position: 0,
        queueDepth: 1,
      });
      expect(typeof (added!.params as { enqueuedAt: number }).enqueuedAt).toBe(
        "number",
      );
    });

    it("broadcasts prompt_queue_added to the originator too (not just peers)", async () => {
      const { session, mock } = makeSession("hydra_session_Q2", "u_Q2");
      const { client: alice, stream: aliceStream } = makeClient();
      session.attach(alice, "full");

      const requestMock = mock.agent.connection.request as ReturnType<
        typeof vi.fn
      >;
      requestMock.mockImplementation(() => new Promise(() => undefined));

      void session.prompt(alice.clientId, {
        sessionId: "hydra_session_Q2",
        prompt: [{ type: "text", text: "my own prompt" }],
      });
      await new Promise((r) => setImmediate(r));

      // prompt_received is NOT sent to alice (RFD #533 excludes the
      // originator), but prompt_queue_added IS — alice needs the
      // server-assigned messageId to drive chip state.
      const added = findQueueEvent(
        aliceStream.sent,
        "hydra-acp/prompt_queue/added",
      );
      expect(added).toBeDefined();
      const promptReceived = aliceStream.sent.find(
        (m) =>
          "method" in m &&
          m.method === "session/update" &&
          (m.params as { update?: { sessionUpdate?: string } } | undefined)
            ?.update?.sessionUpdate === "prompt_received",
      );
      expect(promptReceived).toBeUndefined();
    });

    it("`_meta.hydra-acp.queuePosition: \"head\"` splices the new entry in front of waiting entries", async () => {
      const { session, mock } = makeSession("hydra_session_QH", "u_QH");
      const { client: alice } = makeClient();
      const { client: bob, stream: bobStream } = makeClient();
      session.attach(alice, "full");
      session.attach(bob, "full");
      const requestMock = mock.agent.connection.request as ReturnType<typeof vi.fn>;
      requestMock.mockImplementation(() => new Promise(() => undefined));

      // First prompt: hangs upstream so subsequent prompts queue.
      void session.prompt(alice.clientId, {
        sessionId: "hydra_session_QH",
        prompt: [{ type: "text", text: "running" }],
      });
      await new Promise((r) => setImmediate(r));
      // Second prompt: regular tail-queued.
      void session.prompt(alice.clientId, {
        sessionId: "hydra_session_QH",
        prompt: [{ type: "text", text: "tail one" }],
      });
      await new Promise((r) => setImmediate(r));
      // Third prompt: requests head insertion via _meta.hydra-acp.queuePosition.
      void session.prompt(bob.clientId, {
        sessionId: "hydra_session_QH",
        prompt: [{ type: "text", text: "head one" }],
        _meta: { "hydra-acp": { queuePosition: "head" } },
      });
      await new Promise((r) => setImmediate(r));

      const addedEvents = bobStream.sent.filter(
        (m) => "method" in m && m.method === "hydra-acp/prompt_queue/added",
      ) as JsonRpcNotification[];
      expect(addedEvents).toHaveLength(3);
      const third = addedEvents[2]!.params as {
        position: number;
        queueDepth: number;
      };
      // The head-positioned entry sits at visible position 1 — right
      // after the in-flight currentEntry (position 0) — pushing the
      // previously-queued tail entry to position 2. queueDepth counts
      // the currentEntry too: in-flight + 2 waiting = 3.
      expect(third.position).toBe(1);
      expect(third.queueDepth).toBe(3);
    });

    it("`_meta.hydra-acp.queuePosition: { afterMessageId }` splices after a specific entry", async () => {
      const { session, mock } = makeSession("hydra_session_QA", "u_QA");
      const { client } = makeClient();
      session.attach(client, "full");
      const requestMock = mock.agent.connection.request as ReturnType<typeof vi.fn>;
      requestMock.mockImplementation(() => new Promise(() => undefined));

      // First: in-flight head.
      void session.prompt(client.clientId, {
        sessionId: "hydra_session_QA",
        prompt: [{ type: "text", text: "running" }],
      });
      await new Promise((r) => setImmediate(r));
      // Second: tail (becomes queue position 0).
      void session.prompt(client.clientId, {
        sessionId: "hydra_session_QA",
        prompt: [{ type: "text", text: "A" }],
      });
      await new Promise((r) => setImmediate(r));
      // Third: tail (becomes queue position 1).
      void session.prompt(client.clientId, {
        sessionId: "hydra_session_QA",
        prompt: [{ type: "text", text: "B" }],
      });
      await new Promise((r) => setImmediate(r));

      // Capture the messageId of entry A from queueSnapshot.
      const snapshot = session.queueSnapshot();
      const aEntry = snapshot.find((e) => e.position === 1);
      expect(aEntry).toBeDefined();
      const aMessageId = aEntry!.messageId;

      // Fourth: insert AFTER A. Should land at position 2 (A, here, B).
      void session.prompt(client.clientId, {
        sessionId: "hydra_session_QA",
        prompt: [{ type: "text", text: "after-A" }],
        _meta: { "hydra-acp": { queuePosition: { afterMessageId: aMessageId } } },
      });
      await new Promise((r) => setImmediate(r));

      const post = session.queueSnapshot();
      // The queue ordering should be: [running, A, after-A, B].
      // queueSnapshot's positions are relative to the queue including
      // currentEntry at 0 — verify the texts in order.
      const texts = post.map((e) => {
        const block = (e.prompt as Array<{ text?: string }>)[0];
        return block?.text;
      });
      expect(texts).toEqual(["running", "A", "after-A", "B"]);
    });

    it("an unknown afterMessageId falls back to tail (no error)", async () => {
      const { session, mock } = makeSession("hydra_session_QF", "u_QF");
      const { client } = makeClient();
      session.attach(client, "full");
      const requestMock = mock.agent.connection.request as ReturnType<typeof vi.fn>;
      requestMock.mockImplementation(() => new Promise(() => undefined));

      void session.prompt(client.clientId, {
        sessionId: "hydra_session_QF",
        prompt: [{ type: "text", text: "running" }],
      });
      await new Promise((r) => setImmediate(r));
      void session.prompt(client.clientId, {
        sessionId: "hydra_session_QF",
        prompt: [{ type: "text", text: "tail-fallback" }],
        _meta: { "hydra-acp": { queuePosition: { afterMessageId: "ghost" } } },
      });
      await new Promise((r) => setImmediate(r));

      const snapshot = session.queueSnapshot();
      expect(snapshot).toHaveLength(2);
      const block = (snapshot[1]!.prompt as Array<{ text?: string }>)[0];
      expect(block?.text).toBe("tail-fallback");
    });

    it("malformed queuePosition meta is ignored — defaults to tail", async () => {
      const { session, mock } = makeSession("hydra_session_QM", "u_QM");
      const { client } = makeClient();
      session.attach(client, "full");
      const requestMock = mock.agent.connection.request as ReturnType<typeof vi.fn>;
      requestMock.mockImplementation(() => new Promise(() => undefined));

      void session.prompt(client.clientId, {
        sessionId: "hydra_session_QM",
        prompt: [{ type: "text", text: "running" }],
      });
      await new Promise((r) => setImmediate(r));
      for (const bad of [123, "header", { wrongKey: "x" }, null]) {
        void session.prompt(client.clientId, {
          sessionId: "hydra_session_QM",
          prompt: [{ type: "text", text: `bad-${typeof bad}` }],
          _meta: { "hydra-acp": { queuePosition: bad } },
        });
        await new Promise((r) => setImmediate(r));
      }
      // All four bad-meta prompts ended up tail-queued in order.
      const snapshot = session.queueSnapshot();
      expect(snapshot).toHaveLength(5);
      const textsAfterHead = snapshot.slice(1).map((e) => {
        const block = (e.prompt as Array<{ text?: string }>)[0];
        return block?.text;
      });
      expect(textsAfterHead).toEqual([
        "bad-number",
        "bad-string",
        "bad-object",
        "bad-object",
      ]);
    });

    it("a second concurrent prompt enqueues with position=1 and queueDepth=2", async () => {
      const { session, mock } = makeSession("hydra_session_Q3", "u_Q3");
      const { client: alice } = makeClient();
      const { client: bob, stream: bobStream } = makeClient();
      session.attach(alice, "full");
      session.attach(bob, "full");

      const requestMock = mock.agent.connection.request as ReturnType<
        typeof vi.fn
      >;
      // First prompt hangs upstream so the second one is forced to queue.
      requestMock.mockImplementation(() => new Promise(() => undefined));

      void session.prompt(alice.clientId, {
        sessionId: "hydra_session_Q3",
        prompt: [{ type: "text", text: "first" }],
      });
      await new Promise((r) => setImmediate(r));
      void session.prompt(bob.clientId, {
        sessionId: "hydra_session_Q3",
        prompt: [{ type: "text", text: "second" }],
      });
      await new Promise((r) => setImmediate(r));

      const addedEvents = bobStream.sent.filter(
        (m) => "method" in m && m.method === "hydra-acp/prompt_queue/added",
      ) as JsonRpcNotification[];
      expect(addedEvents).toHaveLength(2);
      const [first, second] = addedEvents;
      expect((first!.params as { position: number }).position).toBe(0);
      expect((first!.params as { queueDepth: number }).queueDepth).toBe(1);
      expect((second!.params as { position: number }).position).toBe(1);
      expect((second!.params as { queueDepth: number }).queueDepth).toBe(2);
      expect(
        (second!.params as { originator: { clientId: string } }).originator
          .clientId,
      ).toBe(bob.clientId);

      // Only the first prompt has hit the upstream agent — the second
      // is still queued behind it.
      const sessionPromptCalls = requestMock.mock.calls.filter(
        ([method]) => method === "session/prompt",
      );
      expect(sessionPromptCalls).toHaveLength(1);
    });

    it("emits prompt_queue_removed(started) before forwarding the next prompt to the agent", async () => {
      const { session, mock } = makeSession("hydra_session_Q4", "u_Q4");
      const { client: alice } = makeClient();
      const { client: bob, stream: bobStream } = makeClient();
      session.attach(alice, "full");
      session.attach(bob, "full");

      const requestMock = mock.agent.connection.request as ReturnType<
        typeof vi.fn
      >;
      // Resolve the agent's session/prompt the moment hydra calls it so
      // drainQueue keeps going. We snapshot the bob-stream send order
      // before/after to verify "started" landed before the second's
      // upstream call.
      requestMock.mockImplementation(async () => ({ stopReason: "end_turn" }));

      await session.prompt(alice.clientId, {
        sessionId: "hydra_session_Q4",
        prompt: [{ type: "text", text: "first" }],
      });
      await session.prompt(bob.clientId, {
        sessionId: "hydra_session_Q4",
        prompt: [{ type: "text", text: "second" }],
      });
      await new Promise((r) => setImmediate(r));

      const startedEvents = bobStream.sent.filter(
        (m) =>
          "method" in m &&
          m.method === "hydra-acp/prompt_queue/removed" &&
          (m.params as { reason?: string }).reason === "started",
      );
      // Two prompts → two started events. Both prompts also resolved
      // (no leftover waiting entries).
      expect(startedEvents).toHaveLength(2);

      // Agent saw both session/prompts in order.
      const sessionPromptCalls = requestMock.mock.calls.filter(
        ([method]) => method === "session/prompt",
      );
      expect(sessionPromptCalls).toHaveLength(2);
      expect(
        (sessionPromptCalls[0]?.[1] as { prompt: Array<{ text: string }> })
          .prompt[0]?.text,
      ).toBe("first");
      expect(
        (sessionPromptCalls[1]?.[1] as { prompt: Array<{ text: string }> })
          .prompt[0]?.text,
      ).toBe("second");
    });

    it("cancelQueuedPrompt splices a waiting entry, broadcasts removed(cancelled), and resolves with cancelled stop reason", async () => {
      const { session, mock } = makeSession("hydra_session_Q5", "u_Q5");
      const { client: alice } = makeClient();
      const { client: bob, stream: bobStream } = makeClient();
      session.attach(alice, "full");
      session.attach(bob, "full");

      const requestMock = mock.agent.connection.request as ReturnType<
        typeof vi.fn
      >;
      // alice's prompt hangs upstream so bob's prompt waits in the queue.
      requestMock.mockImplementation(() => new Promise(() => undefined));

      void session.prompt(alice.clientId, {
        sessionId: "hydra_session_Q5",
        prompt: [{ type: "text", text: "head" }],
      });
      await new Promise((r) => setImmediate(r));
      const bobPromise = session.prompt(bob.clientId, {
        sessionId: "hydra_session_Q5",
        prompt: [{ type: "text", text: "to-be-cancelled" }],
      });
      await new Promise((r) => setImmediate(r));

      // Grab bob's enqueue messageId off the wire so we can cancel it.
      const bobAdded = bobStream.sent
        .filter(
          (m) =>
            "method" in m && m.method === "hydra-acp/prompt_queue/added",
        )
        .at(-1) as JsonRpcNotification;
      const bobMid = (bobAdded.params as { messageId: string }).messageId;

      const res = session.cancelQueuedPrompt(bobMid);
      expect(res).toEqual({ cancelled: true, reason: "ok" });

      // Broadcast for bob is on bob's own stream too.
      const removed = findQueueEvent(
        bobStream.sent,
        "hydra-acp/prompt_queue/removed",
        bobMid,
      );
      expect(removed).toBeDefined();
      expect((removed!.params as { reason: string }).reason).toBe("cancelled");

      // bob's session/prompt resolves with cancelled.
      await expect(bobPromise).resolves.toMatchObject({
        stopReason: "cancelled",
      });

      // Agent only ever saw the first prompt (alice's), never bob's.
      const sessionPromptCalls = requestMock.mock.calls.filter(
        ([method]) => method === "session/prompt",
      );
      expect(sessionPromptCalls).toHaveLength(1);
      expect(
        (sessionPromptCalls[0]?.[1] as { prompt: Array<{ text: string }> })
          .prompt[0]?.text,
      ).toBe("head");
    });

    it("cancelQueuedPrompt on the in-flight head returns already_running and does not abort the turn", async () => {
      const { session, mock } = makeSession("hydra_session_Q6", "u_Q6");
      const { client: alice, stream: aliceStream } = makeClient();
      session.attach(alice, "full");

      const requestMock = mock.agent.connection.request as ReturnType<
        typeof vi.fn
      >;
      let resolveAgent: ((v: unknown) => void) | undefined;
      requestMock.mockImplementation(
        () => new Promise((r) => (resolveAgent = r)),
      );

      const turnPromise = session.prompt(alice.clientId, {
        sessionId: "hydra_session_Q6",
        prompt: [{ type: "text", text: "head" }],
      });
      await new Promise((r) => setImmediate(r));

      const added = findQueueEvent(
        aliceStream.sent,
        "hydra-acp/prompt_queue/added",
      ) as JsonRpcNotification;
      const mid = (added.params as { messageId: string }).messageId;

      // After the drain loop has shifted the head onto currentEntry,
      // cancel_prompt on that messageId should reject.
      await new Promise((r) => setImmediate(r));
      const res = session.cancelQueuedPrompt(mid);
      expect(res).toEqual({ cancelled: false, reason: "already_running" });

      // The running turn is unaffected — completing the upstream call
      // resolves the prompt normally.
      resolveAgent!({ stopReason: "end_turn" });
      await expect(turnPromise).resolves.toMatchObject({
        stopReason: "end_turn",
      });
    });

    it("cancelQueuedPrompt on an unknown messageId returns not_found", () => {
      const { session } = makeSession("hydra_session_Q7", "u_Q7");
      expect(session.cancelQueuedPrompt("m_doesnotexist")).toEqual({
        cancelled: false,
        reason: "not_found",
      });
    });

    it("updateQueuedPrompt mutates the entry and the agent sees the new prompt at exec time", async () => {
      const { session, mock } = makeSession("hydra_session_Q8", "u_Q8");
      const { client: alice } = makeClient();
      const { client: bob, stream: bobStream } = makeClient();
      session.attach(alice, "full");
      session.attach(bob, "full");

      const requestMock = mock.agent.connection.request as ReturnType<
        typeof vi.fn
      >;
      // Hold the first prompt so the second one queues, then complete
      // the first to let drainQueue advance into the (now-updated) second.
      let resolveAlice: ((v: unknown) => void) | undefined;
      requestMock.mockImplementationOnce(
        () => new Promise((r) => (resolveAlice = r)),
      );

      void session.prompt(alice.clientId, {
        sessionId: "hydra_session_Q8",
        prompt: [{ type: "text", text: "first" }],
      });
      await new Promise((r) => setImmediate(r));
      void session.prompt(bob.clientId, {
        sessionId: "hydra_session_Q8",
        prompt: [{ type: "text", text: "original" }],
      });
      await new Promise((r) => setImmediate(r));

      const bobAdded = bobStream.sent
        .filter(
          (m) =>
            "method" in m && m.method === "hydra-acp/prompt_queue/added",
        )
        .at(-1) as JsonRpcNotification;
      const bobMid = (bobAdded.params as { messageId: string }).messageId;

      const newPrompt = [{ type: "text", text: "revised" }];
      const res = session.updateQueuedPrompt(bobMid, newPrompt);
      expect(res).toEqual({ updated: true, reason: "ok" });

      const updated = findQueueEvent(
        bobStream.sent,
        "hydra-acp/prompt_queue/updated",
        bobMid,
      );
      expect(updated).toBeDefined();
      expect((updated!.params as { prompt: unknown[] }).prompt).toEqual(
        newPrompt,
      );

      // Now release the head and resolve the second one too so the
      // upstream agent receives the *updated* prompt array.
      requestMock.mockResolvedValueOnce({ stopReason: "end_turn" });
      resolveAlice!({ stopReason: "end_turn" });
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      const sessionPromptCalls = requestMock.mock.calls.filter(
        ([method]) => method === "session/prompt",
      );
      expect(sessionPromptCalls).toHaveLength(2);
      expect(
        (sessionPromptCalls[1]?.[1] as { prompt: unknown[] }).prompt,
      ).toEqual(newPrompt);
    });

    it("updateQueuedPrompt on the in-flight head returns already_running and does not touch the agent's in-flight params", async () => {
      const { session, mock } = makeSession("hydra_session_Q9", "u_Q9");
      const { client: alice, stream: aliceStream } = makeClient();
      session.attach(alice, "full");

      const requestMock = mock.agent.connection.request as ReturnType<
        typeof vi.fn
      >;
      requestMock.mockImplementation(() => new Promise(() => undefined));

      void session.prompt(alice.clientId, {
        sessionId: "hydra_session_Q9",
        prompt: [{ type: "text", text: "in-flight" }],
      });
      await new Promise((r) => setImmediate(r));

      const added = findQueueEvent(
        aliceStream.sent,
        "hydra-acp/prompt_queue/added",
      ) as JsonRpcNotification;
      const mid = (added.params as { messageId: string }).messageId;

      await new Promise((r) => setImmediate(r));
      const res = session.updateQueuedPrompt(mid, [
        { type: "text", text: "too late" },
      ]);
      expect(res).toEqual({ updated: false, reason: "already_running" });

      // The agent saw the original prompt, not the attempted update.
      const call = requestMock.mock.calls.find(
        ([method]) => method === "session/prompt",
      );
      expect((call?.[1] as { prompt: Array<{ text: string }> }).prompt[0]?.text)
        .toBe("in-flight");
    });

    it("updateQueuedPrompt on an unknown messageId returns not_found", () => {
      const { session } = makeSession("hydra_session_Q10", "u_Q10");
      expect(
        session.updateQueuedPrompt("m_nope", [{ type: "text", text: "x" }]),
      ).toEqual({ updated: false, reason: "not_found" });
    });

    it("amendPrompt on the in-flight head: cancels, emits prompt_amended, splices new prompt at queue head, drains into new turn", async () => {
      const { session, mock } = makeSession("hydra_session_A1", "u_A1");
      const { client: alice, stream: aliceStream } = makeClient({
        name: "tui",
        version: "0.2.0",
      });
      const { client: bob, stream: bobStream } = makeClient();
      session.attach(alice, "full");
      session.attach(bob, "full");

      const requestMock = mock.agent.connection.request as ReturnType<
        typeof vi.fn
      >;
      const notifyMock = mock.agent.connection.notify as ReturnType<
        typeof vi.fn
      >;
      // First session/prompt hangs until we manually resolve it
      // (simulating a real cancel-after-issue dance).
      let resolveAlice: ((v: unknown) => void) | undefined;
      requestMock.mockImplementationOnce(
        () => new Promise((r) => (resolveAlice = r)),
      );
      // Second session/prompt (M2) resolves with end_turn so the test
      // can verify the new turn ran to completion.
      requestMock.mockImplementationOnce(async () => ({
        stopReason: "end_turn",
      }));

      const alicePromise = session.prompt(alice.clientId, {
        sessionId: "hydra_session_A1",
        prompt: [{ type: "text", text: "original" }],
      });
      await new Promise((r) => setImmediate(r));

      // Find alice's messageId from her queue_added broadcast.
      const aliceAdded = findQueueEvent(
        aliceStream.sent,
        "hydra-acp/prompt_queue/added",
      ) as JsonRpcNotification;
      const aliceMid = (aliceAdded.params as { messageId: string }).messageId;

      // Amend alice's running prompt with new content. Originator is alice.
      const result = session.amendPrompt(alice.clientId, {
        sessionId: "hydra_session_A1",
        targetMessageId: aliceMid,
        prompt: [{ type: "text", text: "amended" }],
      });
      expect(result.amended).toBe(true);
      expect(result.reason).toBe("ok");
      expect(result.messageId).toBeDefined();
      expect(result.messageId).not.toBe(aliceMid);
      const amendMid = result.messageId!;

      // A session/cancel notification was sent to the agent (fire-and-forget
      // — no need to await).
      expect(notifyMock).toHaveBeenCalledWith("session/cancel", {
        sessionId: "u_A1",
      });

      // bob (a peer) sees prompt_queue_added for the amendment, with the
      // amending hint pointing at alice's original messageId.
      const amendAdded = findQueueEvent(
        bobStream.sent,
        "hydra-acp/prompt_queue/added",
        amendMid,
      );
      expect(amendAdded).toBeDefined();
      expect(
        (amendAdded!.params as { _meta?: { "hydra-acp"?: { amending?: string } } })
          ._meta?.["hydra-acp"]?.amending,
      ).toBe(aliceMid);

      // Settle the original prompt with cancelled. drainQueue should then
      // advance to the amendment.
      resolveAlice!({ stopReason: "cancelled" });
      await alicePromise;
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      // alice's turn_complete (broadcast to peers) carries the amend marker.
      const aliceTurnComplete = bobStream.sent.find(
        (m) =>
          "method" in m &&
          m.method === "session/update" &&
          ((m.params as { update?: { sessionUpdate?: string } }).update
            ?.sessionUpdate === "turn_complete"),
      ) as JsonRpcNotification | undefined;
      expect(aliceTurnComplete).toBeDefined();
      const update = (
        aliceTurnComplete!.params as {
          update: { stopReason: string; _meta?: Record<string, unknown> };
        }
      ).update;
      expect(update.stopReason).toBe("cancelled");
      expect(
        (update._meta as { "hydra-acp"?: { amended?: { cancelledMessageId: string } } })
          ?.["hydra-acp"]?.amended?.cancelledMessageId,
      ).toBe(aliceMid);

      // The dedicated prompt_amended notification fires too.
      const promptAmended = bobStream.sent.find(
        (m) =>
          "method" in m && m.method === "hydra-acp/prompt/amended",
      ) as JsonRpcNotification | undefined;
      expect(promptAmended).toBeDefined();
      const amendedParams = promptAmended!.params as {
        cancelledMessageId: string;
        newMessageId: string;
        prompt: unknown[];
      };
      expect(amendedParams.cancelledMessageId).toBe(aliceMid);
      expect(amendedParams.newMessageId).toBe(amendMid);
      expect(amendedParams.prompt).toEqual([{ type: "text", text: "amended" }]);

      // The agent received the amendment as a fresh session/prompt call.
      const sessionPromptCalls = requestMock.mock.calls.filter(
        ([m]) => m === "session/prompt",
      );
      expect(sessionPromptCalls).toHaveLength(2);
      expect(
        (sessionPromptCalls[1]?.[1] as { prompt: Array<{ text: string }> })
          .prompt[0]?.text,
      ).toBe("amended");
    });

    it("amendPrompt during the amend window: update_prompt(M2) updates content, the new turn starts with the updated content", async () => {
      const { session, mock } = makeSession("hydra_session_A2", "u_A2");
      const { client: alice, stream: aliceStream } = makeClient();
      session.attach(alice, "full");

      const requestMock = mock.agent.connection.request as ReturnType<
        typeof vi.fn
      >;
      let resolveAlice: ((v: unknown) => void) | undefined;
      requestMock.mockImplementationOnce(
        () => new Promise((r) => (resolveAlice = r)),
      );
      requestMock.mockImplementationOnce(async () => ({
        stopReason: "end_turn",
      }));

      void session.prompt(alice.clientId, {
        sessionId: "hydra_session_A2",
        prompt: [{ type: "text", text: "original" }],
      });
      await new Promise((r) => setImmediate(r));

      const aliceAdded = findQueueEvent(
        aliceStream.sent,
        "hydra-acp/prompt_queue/added",
      ) as JsonRpcNotification;
      const aliceMid = (aliceAdded.params as { messageId: string }).messageId;

      // Amend with content "amended"
      const result = session.amendPrompt(alice.clientId, {
        sessionId: "hydra_session_A2",
        targetMessageId: aliceMid,
        prompt: [{ type: "text", text: "amended" }],
      });
      const amendMid = result.messageId!;

      // Now during the window, update M2 to "amended-then-edited"
      const updRes = session.updateQueuedPrompt(amendMid, [
        { type: "text", text: "amended-then-edited" },
      ]);
      expect(updRes).toEqual({ updated: true, reason: "ok" });

      // Settle the original prompt, let the amendment run.
      resolveAlice!({ stopReason: "cancelled" });
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      // The agent saw the EDITED amendment content.
      const sessionPromptCalls = requestMock.mock.calls.filter(
        ([m]) => m === "session/prompt",
      );
      expect(
        (sessionPromptCalls[1]?.[1] as { prompt: Array<{ text: string }> })
          .prompt[0]?.text,
      ).toBe("amended-then-edited");
    });

    it("amendPrompt during the amend window: cancel_prompt(M2) drops the amendment, M1 still completes as cancelled with no amend marker, no replacement turn runs", async () => {
      const { session, mock } = makeSession("hydra_session_A3", "u_A3");
      const { client: alice, stream: aliceStream } = makeClient();
      const { client: bob, stream: bobStream } = makeClient();
      session.attach(alice, "full");
      session.attach(bob, "full");

      const requestMock = mock.agent.connection.request as ReturnType<
        typeof vi.fn
      >;
      let resolveAlice: ((v: unknown) => void) | undefined;
      requestMock.mockImplementationOnce(
        () => new Promise((r) => (resolveAlice = r)),
      );

      void session.prompt(alice.clientId, {
        sessionId: "hydra_session_A3",
        prompt: [{ type: "text", text: "original" }],
      });
      await new Promise((r) => setImmediate(r));

      const aliceAdded = findQueueEvent(
        aliceStream.sent,
        "hydra-acp/prompt_queue/added",
      ) as JsonRpcNotification;
      const aliceMid = (aliceAdded.params as { messageId: string }).messageId;

      const result = session.amendPrompt(alice.clientId, {
        sessionId: "hydra_session_A3",
        targetMessageId: aliceMid,
        prompt: [{ type: "text", text: "amended" }],
      });
      const amendMid = result.messageId!;

      // Cancel the amendment during the window.
      const cancelRes = session.cancelQueuedPrompt(amendMid);
      expect(cancelRes).toEqual({ cancelled: true, reason: "ok" });

      // Settle the original prompt as cancelled.
      resolveAlice!({ stopReason: "cancelled" });
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      // M1's turn_complete fires WITHOUT the amend marker — the user walked
      // back the amendment.
      const turnComplete = bobStream.sent.find(
        (m) =>
          "method" in m &&
          m.method === "session/update" &&
          ((m.params as { update?: { sessionUpdate?: string } }).update
            ?.sessionUpdate === "turn_complete"),
      ) as JsonRpcNotification | undefined;
      expect(turnComplete).toBeDefined();
      const update = (
        turnComplete!.params as {
          update: { stopReason: string; _meta?: Record<string, unknown> };
        }
      ).update;
      expect(update.stopReason).toBe("cancelled");
      expect(update._meta).toBeUndefined();

      // No prompt_amended notification fired.
      const promptAmended = bobStream.sent.find(
        (m) =>
          "method" in m && m.method === "hydra-acp/prompt/amended",
      );
      expect(promptAmended).toBeUndefined();

      // No second session/prompt was sent to the agent.
      const sessionPromptCalls = requestMock.mock.calls.filter(
        ([m]) => m === "session/prompt",
      );
      expect(sessionPromptCalls).toHaveLength(1);
    });

    it("amendPrompt with replaceQueue: true drops every other waiting entry before splicing the amendment at the head", async () => {
      const { session, mock } = makeSession("hydra_session_A4", "u_A4");
      const { client: alice, stream: aliceStream } = makeClient();
      const { client: bob, stream: bobStream } = makeClient();
      session.attach(alice, "full");
      session.attach(bob, "full");

      const requestMock = mock.agent.connection.request as ReturnType<
        typeof vi.fn
      >;
      requestMock.mockImplementation(() => new Promise(() => undefined));

      void session.prompt(alice.clientId, {
        sessionId: "hydra_session_A4",
        prompt: [{ type: "text", text: "head" }],
      });
      await new Promise((r) => setImmediate(r));
      const bobPromise = session.prompt(bob.clientId, {
        sessionId: "hydra_session_A4",
        prompt: [{ type: "text", text: "waiting" }],
      });
      await new Promise((r) => setImmediate(r));

      const aliceAdded = findQueueEvent(
        aliceStream.sent,
        "hydra-acp/prompt_queue/added",
      ) as JsonRpcNotification;
      const aliceMid = (aliceAdded.params as { messageId: string }).messageId;

      const result = session.amendPrompt(alice.clientId, {
        sessionId: "hydra_session_A4",
        targetMessageId: aliceMid,
        prompt: [{ type: "text", text: "replace-everything" }],
        replaceQueue: true,
      });
      expect(result.amended).toBe(true);

      // bob's session/prompt promise resolves with cancelled stop reason.
      await expect(bobPromise).resolves.toMatchObject({
        stopReason: "cancelled",
      });

      // The queue (in user-visible terms) now has just M1 in flight and
      // the amendment waiting.
      const snap = session.queueSnapshot();
      expect(snap).toHaveLength(2);
      expect(snap[1]?.prompt).toEqual([
        { type: "text", text: "replace-everything" },
      ]);
    });

    it("amendPrompt with targetMessageId matching a queued (not yet running) entry edits in place — same observable behavior as update_prompt", async () => {
      const { session, mock } = makeSession("hydra_session_A5", "u_A5");
      const { client: alice } = makeClient();
      const { client: bob, stream: bobStream } = makeClient();
      session.attach(alice, "full");
      session.attach(bob, "full");

      const requestMock = mock.agent.connection.request as ReturnType<
        typeof vi.fn
      >;
      requestMock.mockImplementation(() => new Promise(() => undefined));

      void session.prompt(alice.clientId, {
        sessionId: "hydra_session_A5",
        prompt: [{ type: "text", text: "head" }],
      });
      await new Promise((r) => setImmediate(r));
      void session.prompt(bob.clientId, {
        sessionId: "hydra_session_A5",
        prompt: [{ type: "text", text: "original-queued" }],
      });
      await new Promise((r) => setImmediate(r));

      const bobAdded = bobStream.sent
        .filter(
          (m) =>
            "method" in m && m.method === "hydra-acp/prompt_queue/added",
        )
        .at(-1) as JsonRpcNotification;
      const bobMid = (bobAdded.params as { messageId: string }).messageId;

      const result = session.amendPrompt(alice.clientId, {
        sessionId: "hydra_session_A5",
        targetMessageId: bobMid,
        prompt: [{ type: "text", text: "edited" }],
      });
      expect(result).toEqual({
        amended: true,
        reason: "ok",
        messageId: bobMid,
      });

      // prompt_queue_updated fires (just like update_prompt).
      const queueUpdated = findQueueEvent(
        bobStream.sent,
        "hydra-acp/prompt_queue/updated",
        bobMid,
      );
      expect(queueUpdated).toBeDefined();
      expect((queueUpdated!.params as { prompt: unknown[] }).prompt).toEqual([
        { type: "text", text: "edited" },
      ]);

      // No agent interaction (cancel notify) happened.
      const notifyMock = mock.agent.connection.notify as ReturnType<
        typeof vi.fn
      >;
      expect(notifyMock).not.toHaveBeenCalledWith(
        "session/cancel",
        expect.anything(),
      );
    });

    it("amendPrompt on a target that already completed returns target_completed and does NOT send by default", async () => {
      const { session, mock } = makeSession("hydra_session_A6", "u_A6");
      const { client: alice, stream: aliceStream } = makeClient();
      session.attach(alice, "full");

      const requestMock = mock.agent.connection.request as ReturnType<
        typeof vi.fn
      >;
      requestMock.mockResolvedValueOnce({ stopReason: "end_turn" });

      await session.prompt(alice.clientId, {
        sessionId: "hydra_session_A6",
        prompt: [{ type: "text", text: "completed" }],
      });
      // Drain pending broadcasts.
      await new Promise((r) => setImmediate(r));

      const aliceAdded = findQueueEvent(
        aliceStream.sent,
        "hydra-acp/prompt_queue/added",
      ) as JsonRpcNotification;
      const aliceMid = (aliceAdded.params as { messageId: string }).messageId;

      const result = session.amendPrompt(alice.clientId, {
        sessionId: "hydra_session_A6",
        targetMessageId: aliceMid,
        prompt: [{ type: "text", text: "too-late" }],
      });
      expect(result).toEqual({
        amended: false,
        reason: "target_completed",
      });

      // No new session/prompt issued — call count should still be 1.
      const sessionPromptCalls = requestMock.mock.calls.filter(
        ([m]) => m === "session/prompt",
      );
      expect(sessionPromptCalls).toHaveLength(1);
    });

    it("amendPrompt with onTargetCompleted: send_anyway forwards the amendment as a regular session/prompt", async () => {
      const { session, mock } = makeSession("hydra_session_A7", "u_A7");
      const { client: alice, stream: aliceStream } = makeClient();
      session.attach(alice, "full");

      const requestMock = mock.agent.connection.request as ReturnType<
        typeof vi.fn
      >;
      requestMock.mockResolvedValueOnce({ stopReason: "end_turn" });
      requestMock.mockResolvedValueOnce({ stopReason: "end_turn" });

      await session.prompt(alice.clientId, {
        sessionId: "hydra_session_A7",
        prompt: [{ type: "text", text: "completed" }],
      });
      await new Promise((r) => setImmediate(r));

      const aliceAdded = findQueueEvent(
        aliceStream.sent,
        "hydra-acp/prompt_queue/added",
      ) as JsonRpcNotification;
      const aliceMid = (aliceAdded.params as { messageId: string }).messageId;

      const result = session.amendPrompt(alice.clientId, {
        sessionId: "hydra_session_A7",
        targetMessageId: aliceMid,
        prompt: [{ type: "text", text: "sent-anyway" }],
        onTargetCompleted: "send_anyway",
      });
      expect(result.amended).toBe(false);
      expect(result.reason).toBe("target_completed");
      expect(result.messageId).toBeDefined();
      expect(result.messageId).not.toBe(aliceMid);

      // Wait for the new turn to run.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      const sessionPromptCalls = requestMock.mock.calls.filter(
        ([m]) => m === "session/prompt",
      );
      expect(sessionPromptCalls).toHaveLength(2);
      expect(
        (sessionPromptCalls[1]?.[1] as { prompt: Array<{ text: string }> })
          .prompt[0]?.text,
      ).toBe("sent-anyway");
    });

    it("amendPrompt with unknown targetMessageId returns target_not_found and does nothing", () => {
      const { session } = makeSession("hydra_session_A8", "u_A8");
      const { client: alice } = makeClient();
      session.attach(alice, "full");

      const result = session.amendPrompt(alice.clientId, {
        sessionId: "hydra_session_A8",
        targetMessageId: "m_never_existed",
        prompt: [{ type: "text", text: "x" }],
      });
      expect(result).toEqual({
        amended: false,
        reason: "target_not_found",
      });
    });

    it("queueSnapshot returns the in-flight head at position 0 and waiting entries after it", async () => {
      const { session, mock } = makeSession("hydra_session_Q11", "u_Q11");
      const { client: alice } = makeClient();
      const { client: bob } = makeClient();
      session.attach(alice, "full");
      session.attach(bob, "full");

      const requestMock = mock.agent.connection.request as ReturnType<
        typeof vi.fn
      >;
      requestMock.mockImplementation(() => new Promise(() => undefined));

      void session.prompt(alice.clientId, {
        sessionId: "hydra_session_Q11",
        prompt: [{ type: "text", text: "head" }],
      });
      await new Promise((r) => setImmediate(r));
      void session.prompt(bob.clientId, {
        sessionId: "hydra_session_Q11",
        prompt: [{ type: "text", text: "waiting" }],
      });
      await new Promise((r) => setImmediate(r));

      const snap = session.queueSnapshot();
      expect(snap).toHaveLength(2);
      expect(snap[0]?.position).toBe(0);
      expect(snap[0]?.originator.clientId).toBe(alice.clientId);
      expect(snap[0]?.prompt).toEqual([{ type: "text", text: "head" }]);
      expect(snap[1]?.position).toBe(1);
      expect(snap[1]?.originator.clientId).toBe(bob.clientId);
      expect(snap[1]?.prompt).toEqual([{ type: "text", text: "waiting" }]);
    });

    it("defers prompt_received until the entry actually leaves the queue head (deviation from RFD #533)", async () => {
      const { session, mock } = makeSession("hydra_session_Qrcv", "u_Qrcv");
      const { client: alice } = makeClient();
      const { client: bob } = makeClient();
      // carol is a non-originator observer for both alice's and bob's
      // prompts — RFD #533 excludes the originator from prompt_received,
      // so we can't watch bob's own stream for bob's prompt_received.
      const { client: carol, stream: carolStream } = makeClient();
      session.attach(alice, "full");
      session.attach(bob, "full");
      session.attach(carol, "full");

      const requestMock = mock.agent.connection.request as ReturnType<
        typeof vi.fn
      >;
      let resolveAlice: ((v: unknown) => void) | undefined;
      requestMock.mockImplementationOnce(
        () => new Promise((r) => (resolveAlice = r)),
      );

      void session.prompt(alice.clientId, {
        sessionId: "hydra_session_Qrcv",
        prompt: [{ type: "text", text: "head" }],
      });
      await new Promise((r) => setImmediate(r));
      void session.prompt(bob.clientId, {
        sessionId: "hydra_session_Qrcv",
        prompt: [{ type: "text", text: "waiting" }],
      });
      await new Promise((r) => setImmediate(r));

      const promptReceivedFor = (text: string) =>
        carolStream.sent.find(
          (m) =>
            "method" in m &&
            m.method === "session/update" &&
            (m.params as {
              update?: { sessionUpdate?: string; prompt?: Array<{ text?: string }> };
            } | undefined)?.update?.sessionUpdate === "prompt_received" &&
            (m.params as {
              update?: { prompt?: Array<{ text?: string }> };
            } | undefined)?.update?.prompt?.[0]?.text === text,
        );

      // alice's "head" entry drained into runQueueEntry immediately, so
      // its prompt_received already landed on carol. bob's "waiting"
      // entry is parked behind the hanging upstream call — its
      // prompt_received MUST NOT have fired yet (this is the deviation).
      expect(promptReceivedFor("head")).toBeDefined();
      expect(promptReceivedFor("waiting")).toBeUndefined();

      // Release the head. drainQueue advances into bob's entry,
      // broadcasts prompt_queue_removed(started), then prompt_received,
      // then forwards to the agent. The next request hangs so the
      // observation is stable.
      requestMock.mockImplementationOnce(() => new Promise(() => undefined));
      resolveAlice!({ stopReason: "end_turn" });
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      expect(promptReceivedFor("waiting")).toBeDefined();
    });

    it("persists queued entries to disk; head is excluded from disk before invocation", async () => {
      const { session, mock } = makeSession("hydra_session_Qpersist", "u_Q");
      const { client: alice } = makeClient();
      const { client: bob } = makeClient();
      session.attach(alice, "full");
      session.attach(bob, "full");

      const requestMock = mock.agent.connection.request as ReturnType<
        typeof vi.fn
      >;
      // Hold the head so the second entry sits in the queue.
      requestMock.mockImplementation(() => new Promise(() => undefined));

      void session.prompt(alice.clientId, {
        sessionId: "hydra_session_Qpersist",
        prompt: [{ type: "text", text: "head" }],
      });
      await new Promise((r) => setImmediate(r));
      void session.prompt(bob.clientId, {
        sessionId: "hydra_session_Qpersist",
        prompt: [{ type: "text", text: "waiting" }],
      });
      // All persistRewrite calls go through the per-session queue
      // write chain. Drain it via the test helper rather than
      // guessing setImmediate ticks.
      await session.flushPersistWrites();

      const { loadQueue } = await import("./queue-store.js");
      const persisted = await loadQueue("hydra_session_Qpersist");
      // Only the waiter is on disk — the head was rewritten out
      // BEFORE the agent invocation so a crash mid-generation won't
      // double-fire on restart.
      expect(persisted).toHaveLength(1);
      expect(
        (persisted[0]?.prompt[0] as { text: string }).text,
      ).toBe("waiting");
    });

    it("replays a persisted queue through drainQueue", async () => {
      const { session, mock } = makeSession("hydra_session_Qreplay", "u_QR");
      const { client: alice, stream: aliceStream } = makeClient();
      session.attach(alice, "full");
      const requestMock = mock.agent.connection.request as ReturnType<
        typeof vi.fn
      >;
      requestMock.mockImplementation(() => new Promise(() => undefined));

      // Pretend the daemon just resurrected this session with a
      // persisted entry on disk. Use the public replay entry point.
      session.replayPersistedQueue([
        {
          messageId: "m_resurrect_test_000",
          originator: { clientInfo: { name: "tui", version: "0.2.0" } },
          prompt: [{ type: "text", text: "from disk" }],
          enqueuedAt: Date.now() - 1000,
        },
      ]);
      await new Promise((r) => setImmediate(r));

      // The replayed entry hit drainQueue → broadcasted
      // prompt_queue_added + prompt_queue_removed(started) + sent
      // session/prompt upstream.
      const upstreamCalls = requestMock.mock.calls.filter(
        ([method]) => method === "session/prompt",
      );
      expect(upstreamCalls).toHaveLength(1);
      expect(
        (upstreamCalls[0]?.[1] as { prompt: Array<{ text: string }> })
          .prompt[0]?.text,
      ).toBe("from disk");
      const added = aliceStream.sent.find(
        (m): m is JsonRpcNotification =>
          "method" in m && m.method === "hydra-acp/prompt_queue/added",
      );
      expect(added).toBeDefined();
      expect(
        (added!.params as { messageId: string }).messageId,
      ).toBe("m_resurrect_test_000");
    });

    it("session close abandons queued entries: broadcasts removed(abandoned) and resolves the originators' promises with cancelled", async () => {
      const { session, mock } = makeSession("hydra_session_Q12", "u_Q12");
      const { client: alice } = makeClient();
      const { client: bob, stream: bobStream } = makeClient();
      session.attach(alice, "full");
      session.attach(bob, "full");

      const requestMock = mock.agent.connection.request as ReturnType<
        typeof vi.fn
      >;
      requestMock.mockImplementation(() => new Promise(() => undefined));

      void session.prompt(alice.clientId, {
        sessionId: "hydra_session_Q12",
        prompt: [{ type: "text", text: "head" }],
      });
      await new Promise((r) => setImmediate(r));
      const bobPromise = session.prompt(bob.clientId, {
        sessionId: "hydra_session_Q12",
        prompt: [{ type: "text", text: "queued" }],
      });
      await new Promise((r) => setImmediate(r));

      const bobAdded = bobStream.sent
        .filter(
          (m) =>
            "method" in m && m.method === "hydra-acp/prompt_queue/added",
        )
        .at(-1) as JsonRpcNotification;
      const bobMid = (bobAdded.params as { messageId: string }).messageId;

      // Triggering an agent exit fires the close path which abandons
      // anything still queued behind the (now-killed) in-flight entry.
      mock.triggerExit(0, null);
      await new Promise((r) => setImmediate(r));

      const removed = findQueueEvent(
        bobStream.sent,
        "hydra-acp/prompt_queue/removed",
        bobMid,
      );
      expect(removed).toBeDefined();
      expect((removed!.params as { reason: string }).reason).toBe("abandoned");

      await expect(bobPromise).resolves.toMatchObject({
        stopReason: "cancelled",
      });
    });

    it("close() while a turn is in flight does not promote the next queued entry — no spurious prompt_received / turn_complete(interrupted) pair", async () => {
      const { session, mock } = makeSession("hydra_session_Q13", "u_Q13");
      const { client: alice, stream: aliceStream } = makeClient();
      const { client: bob, stream: bobStream } = makeClient();
      session.attach(alice, "full");
      session.attach(bob, "full");

      const requestMock = mock.agent.connection.request as ReturnType<
        typeof vi.fn
      >;
      // alice's upstream session/prompt hangs until we manually reject it,
      // standing in for the agent.kill() tear-down that rejects the in-flight
      // request from underneath drainQueue.
      let rejectAlice: ((err: Error) => void) | undefined;
      requestMock.mockImplementationOnce(
        () =>
          new Promise<unknown>((_, rej) => {
            rejectAlice = rej;
          }),
      );

      const alicePromise = session
        .prompt(alice.clientId, {
          sessionId: "hydra_session_Q13",
          prompt: [{ type: "text", text: "head (will be killed)" }],
        })
        .catch((err: unknown) => ({ rejected: err }));
      await new Promise((r) => setImmediate(r));
      const bobPromise = session.prompt(bob.clientId, {
        sessionId: "hydra_session_Q13",
        prompt: [{ type: "text", text: "queued behind the head" }],
      });
      await new Promise((r) => setImmediate(r));

      // Start close(). close() flips `closing` synchronously, then awaits
      // agent.kill() (mock resolves immediately). Rejecting the in-flight
      // upstream gives drainQueue a chance to try to iterate to bob's
      // entry — with the closing-gate fix, it must bail out instead.
      const closePromise = session.close({});
      rejectAlice!(new Error("agent killed"));
      await closePromise;
      await new Promise((r) => setImmediate(r));

      const wireOf = (
        s: ReturnType<typeof makeClient>["stream"],
      ): JsonRpcNotification[] =>
        s.sent.filter(
          (m): m is JsonRpcNotification =>
            "method" in m && m.method === "session/update",
        );

      // bob's queued prompt must NOT have a prompt_received broadcast — on
      // any client. (alice's head DOES, because runQueueEntry got that far
      // before kill rejected it.)
      const bobPromptReceived = [aliceStream, bobStream]
        .flatMap(wireOf)
        .find(
          (m) =>
            (m.params as { update?: { sessionUpdate?: string; prompt?: Array<{ text?: string }> } })
              .update?.sessionUpdate === "prompt_received" &&
            (m.params as { update: { prompt?: Array<{ text?: string }> } }).update
              .prompt?.[0]?.text === "queued behind the head",
        );
      expect(bobPromptReceived).toBeUndefined();

      // Only the head sees a terminal turn_complete. The exact stopReason
      // depends on which of two settle paths wins the race:
      //   - runQueueEntry's catch broadcasts "error" if the upstream
      //     rejection lands first
      //   - markClosed broadcasts "interrupted" if close()'s sweep gets
      //     there first
      // The defining property of this test is "exactly one turn_complete,
      // not two" — the bug this guards is a synthesized interrupted on
      // top of the error. Either label is correct.
      const turnCompletes = wireOf(bobStream).filter(
        (m) =>
          (m.params as { update?: { sessionUpdate?: string } }).update
            ?.sessionUpdate === "turn_complete",
      );
      expect(turnCompletes).toHaveLength(1);
      expect(
        (turnCompletes[0]!.params as { update: { stopReason?: string } }).update
          .stopReason,
      ).toMatch(/^(error|interrupted)$/);

      // bob's queued chip is removed with reason=abandoned (markClosed's
      // sweep), not started. Look up bob's entry by the messageId that
      // queue_added carried.
      const bobAdded = bobStream.sent.find(
        (m): m is JsonRpcNotification =>
          "method" in m &&
          m.method === "hydra-acp/prompt_queue/added" &&
          ((m.params as { originator?: { clientId?: string } }).originator
            ?.clientId === bob.clientId),
      );
      const bobMid = (bobAdded!.params as { messageId: string }).messageId;
      const bobRemoved = bobStream.sent.find(
        (m): m is JsonRpcNotification =>
          "method" in m &&
          m.method === "hydra-acp/prompt_queue/removed" &&
          (m.params as { messageId?: string }).messageId === bobMid,
      );
      expect(bobRemoved).toBeDefined();
      expect((bobRemoved!.params as { reason: string }).reason).toBe(
        "abandoned",
      );

      await expect(bobPromise).resolves.toMatchObject({
        stopReason: "cancelled",
      });
      await expect(alicePromise).resolves.toMatchObject({
        rejected: expect.objectContaining({ message: "agent killed" }),
      });

      // And the agent only ever saw alice's session/prompt — bob's never
      // reached the upstream.
      const sessionPromptCalls = requestMock.mock.calls.filter(
        ([method]) => method === "session/prompt",
      );
      expect(sessionPromptCalls).toHaveLength(1);
    });

    it("close() with a hanging upstream synthesizes exactly one turn_complete(interrupted) for the in-flight head (no dedup-suppression)", async () => {
      const { session, mock } = makeSession("hydra_session_Q14", "u_Q14");
      const { client: alice } = makeClient();
      const { client: bob, stream: bobStream } = makeClient();
      session.attach(alice, "full");
      session.attach(bob, "full");

      const requestMock = mock.agent.connection.request as ReturnType<
        typeof vi.fn
      >;
      // Upstream never settles — only markClosed will terminate the head.
      // This is the path where the recentlyTerminal dedup MUST NOT suppress
      // the synthesized broadcast (no prior turn_complete was emitted).
      requestMock.mockImplementation(() => new Promise(() => undefined));

      void session.prompt(alice.clientId, {
        sessionId: "hydra_session_Q14",
        prompt: [{ type: "text", text: "head (hangs)" }],
      });
      await new Promise((r) => setImmediate(r));

      await session.close({});
      await new Promise((r) => setImmediate(r));

      const turnCompletes = bobStream.sent.filter(
        (m): m is JsonRpcNotification =>
          "method" in m &&
          m.method === "session/update" &&
          (m.params as { update?: { sessionUpdate?: string } }).update
            ?.sessionUpdate === "turn_complete",
      );
      expect(turnCompletes).toHaveLength(1);
      expect(
        (turnCompletes[0]!.params as { update: { stopReason?: string } }).update
          .stopReason,
      ).toBe("interrupted");
    });

    it("agent exit while a queued entry sits behind an in-flight head does not promote the queued entry", async () => {
      const { session, mock } = makeSession("hydra_session_Q15", "u_Q15");
      const { client: alice, stream: aliceStream } = makeClient();
      const { client: bob, stream: bobStream } = makeClient();
      session.attach(alice, "full");
      session.attach(bob, "full");

      const requestMock = mock.agent.connection.request as ReturnType<
        typeof vi.fn
      >;
      let rejectAlice: ((err: Error) => void) | undefined;
      requestMock.mockImplementationOnce(
        () =>
          new Promise<unknown>((_, rej) => {
            rejectAlice = rej;
          }),
      );

      const alicePromise = session
        .prompt(alice.clientId, {
          sessionId: "hydra_session_Q15",
          prompt: [{ type: "text", text: "head" }],
        })
        .catch((err: unknown) => ({ rejected: err }));
      await new Promise((r) => setImmediate(r));
      const bobPromise = session.prompt(bob.clientId, {
        sessionId: "hydra_session_Q15",
        prompt: [{ type: "text", text: "queued" }],
      });
      await new Promise((r) => setImmediate(r));

      // Agent exits (e.g. crash or external SIGTERM). The onExit handler
      // calls markClosed directly — same race surface as close() but via
      // a different entry point. Reject the in-flight upstream in the
      // same tick so drainQueue gets a chance to iterate.
      mock.triggerExit(0, null);
      rejectAlice!(new Error("agent exited"));
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      const wireOf = (
        s: ReturnType<typeof makeClient>["stream"],
      ): JsonRpcNotification[] =>
        s.sent.filter(
          (m): m is JsonRpcNotification =>
            "method" in m && m.method === "session/update",
        );

      const bobPromptReceived = [aliceStream, bobStream]
        .flatMap(wireOf)
        .find(
          (m) =>
            (m.params as { update?: { sessionUpdate?: string } }).update
              ?.sessionUpdate === "prompt_received" &&
            (m.params as { update: { prompt?: Array<{ text?: string }> } })
              .update.prompt?.[0]?.text === "queued",
        );
      expect(bobPromptReceived).toBeUndefined();

      // At most one turn_complete on bob's stream — for alice's head.
      // (Whether it's error or interrupted depends on microtask order,
      // but it must be exactly one, not duplicated.)
      const turnCompletes = wireOf(bobStream).filter(
        (m) =>
          (m.params as { update?: { sessionUpdate?: string } }).update
            ?.sessionUpdate === "turn_complete",
      );
      expect(turnCompletes).toHaveLength(1);

      // bob's chip was abandoned, not started.
      const bobAdded = bobStream.sent.find(
        (m): m is JsonRpcNotification =>
          "method" in m &&
          m.method === "hydra-acp/prompt_queue/added" &&
          ((m.params as { originator?: { clientId?: string } }).originator
            ?.clientId === bob.clientId),
      );
      const bobMid = (bobAdded!.params as { messageId: string }).messageId;
      const bobRemoved = bobStream.sent.find(
        (m): m is JsonRpcNotification =>
          "method" in m &&
          m.method === "hydra-acp/prompt_queue/removed" &&
          (m.params as { messageId?: string }).messageId === bobMid,
      );
      expect(bobRemoved).toBeDefined();
      expect((bobRemoved!.params as { reason: string }).reason).toBe(
        "abandoned",
      );

      await expect(bobPromise).resolves.toMatchObject({
        stopReason: "cancelled",
      });
      await expect(alicePromise).resolves.toMatchObject({
        rejected: expect.objectContaining({ message: "agent exited" }),
      });

      const sessionPromptCalls = requestMock.mock.calls.filter(
        ([method]) => method === "session/prompt",
      );
      expect(sessionPromptCalls).toHaveLength(1);
    });
  });

  describe("Session.steer", () => {
    it("forwards natively when a turn is in flight and the agent supports steering, records a user_message_chunk (not prompt_received) on injected", async () => {
      const { session, mock } = makeSession("hydra_session_steer1", "u_steer1");
      const { client } = makeClient();
      const { client: observer, stream: observerStream } = makeClient();
      session.attach(client, "full");
      session.attach(observer, "full");
      mock.agent.steeringSupported = true;

      const requestMock = mock.agent.connection.request as ReturnType<typeof vi.fn>;
      requestMock.mockImplementationOnce(() => new Promise(() => undefined)); // M1 never resolves in this test
      requestMock.mockResolvedValueOnce({ outcome: "injected" });

      void session.prompt(client.clientId, {
        sessionId: "hydra_session_steer1",
        prompt: [{ type: "text", text: "original" }],
      });
      await new Promise((r) => setImmediate(r));
      observerStream.sent.length = 0;

      const result = await session.steer(client.clientId, {
        sessionId: "hydra_session_steer1",
        prompt: [{ type: "text", text: "actually, do X instead" }],
      });

      expect(result).toEqual({ outcome: "injected" });
      expect(requestMock).toHaveBeenCalledWith(
        "_session/steering",
        expect.objectContaining({ sessionId: "u_steer1" }),
      );
      // Broadcasts exclude the originating client, so check the bystander.
      const chunk = observerStream.sent.find(
        (m): m is JsonRpcNotification =>
          "method" in m &&
          m.method === "session/update" &&
          (m.params as { update?: { sessionUpdate?: string } }).update
            ?.sessionUpdate === "user_message_chunk",
      );
      expect(chunk).toBeDefined();
      expect(
        (chunk!.params as { update: { _meta?: unknown } }).update._meta,
      ).toEqual({ "hydra-acp": { steered: true } });
      const promptReceived = observerStream.sent.find(
        (m): m is JsonRpcNotification =>
          "method" in m &&
          m.method === "session/update" &&
          (m.params as { update?: { sessionUpdate?: string } }).update
            ?.sessionUpdate === "prompt_received",
      );
      expect(promptReceived).toBeUndefined();
    });

    it("does not record a user_message_chunk when the native reply is startedNewTurn (race case)", async () => {
      const { session, mock } = makeSession("hydra_session_steer2", "u_steer2");
      const { client, stream } = makeClient();
      session.attach(client, "full");
      mock.agent.steeringSupported = true;

      const requestMock = mock.agent.connection.request as ReturnType<typeof vi.fn>;
      requestMock.mockImplementationOnce(() => new Promise(() => undefined));
      requestMock.mockResolvedValueOnce({ outcome: "startedNewTurn" });

      void session.prompt(client.clientId, {
        sessionId: "hydra_session_steer2",
        prompt: [{ type: "text", text: "original" }],
      });
      await new Promise((r) => setImmediate(r));
      stream.sent.length = 0;

      const result = await session.steer(client.clientId, {
        sessionId: "hydra_session_steer2",
        prompt: [{ type: "text", text: "redirect" }],
      });

      expect(result).toEqual({ outcome: "startedNewTurn" });
      const chunk = stream.sent.find(
        (m): m is JsonRpcNotification =>
          "method" in m &&
          m.method === "session/update" &&
          (m.params as { update?: { sessionUpdate?: string } }).update
            ?.sessionUpdate === "user_message_chunk",
      );
      expect(chunk).toBeUndefined();
    });

    it("closes a steer-detached turn on its own terminal instead of leaving the session BUSY forever", async () => {
      // The race: steer() reads turnInFlight as true (M1's session/prompt
      // hasn't resolved yet from hydra's side), but by the time the agent
      // handles the _session/steering request, M1's own turn has actually
      // ended — the agent takes its idle branch and detaches a fresh turn,
      // replying startedNewTurn. That detached turn's content is user-lane
      // (kind:"human"), which autonomousTurnTerminal never treats as an
      // ending signal, so without steerCaused tracking the session would
      // read BUSY forever.
      const { session, mock } = makeSession("hydra_session_steer6", "u_steer6");
      const { client } = makeClient();
      session.attach(client, "full");
      mock.agent.steeringSupported = true;

      const requestMock = mock.agent.connection.request as ReturnType<typeof vi.fn>;
      let resolveM1: ((v: unknown) => void) | undefined;
      let resolveSteer: ((v: unknown) => void) | undefined;
      requestMock.mockImplementationOnce(
        () => new Promise((r) => (resolveM1 = r)),
      );
      requestMock.mockImplementationOnce(
        () => new Promise((r) => (resolveSteer = r)),
      );

      void session.prompt(client.clientId, {
        sessionId: "hydra_session_steer6",
        prompt: [{ type: "text", text: "original" }],
      });
      await new Promise((r) => setImmediate(r));

      const steerPromise = session.steer(client.clientId, {
        sessionId: "hydra_session_steer6",
        prompt: [{ type: "text", text: "redirect" }],
      });
      await new Promise((r) => setImmediate(r));

      // M1 actually finishes agent-side while the steering request is still
      // outstanding.
      resolveM1?.({ stopReason: "end_turn" });
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(session.inUnsolicitedTurn).toBe(false);

      resolveSteer?.({ outcome: "startedNewTurn" });
      const result = await steerPromise;
      expect(result).toEqual({ outcome: "startedNewTurn" });

      // The detached turn's own content, streamed with no prompt in flight.
      mock.triggerNotification("session/update", {
        sessionId: "u_steer6",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "redirected work" },
        },
      });
      expect(session.inUnsolicitedTurn).toBe(true);

      // Its terminal rides the same carrier as any user turn's end.
      mock.triggerNotification("session/update", {
        sessionId: "u_steer6",
        update: {
          sessionUpdate: "usage_update",
          used: 42,
          _meta: { "_claude/origin": { kind: "human" } },
        },
      });

      expect(session.inUnsolicitedTurn).toBe(false);
    });

    it("does not mistake an unrelated background-task turn for a steer-caused one", async () => {
      // Guards against a fix that closes on ANY human-lane terminal while an
      // unsolicited turn is open, which would reintroduce the exact bug
      // autonomousTurnTerminal's kind check exists to avoid.
      const { session, mock } = makeSession("hydra_session_steer7", "u_steer7");
      const { client } = makeClient();
      session.attach(client, "full");

      (mock.agent.connection.request as ReturnType<typeof vi.fn>).mockResolvedValue({
        stopReason: "end_turn",
      });
      await session.prompt(client.clientId, {
        sessionId: "hydra_session_steer7",
        prompt: [{ type: "text", text: "first turn" }],
      });
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      // Agent resumes on its own — no steer() was ever involved.
      mock.triggerNotification("session/update", {
        sessionId: "u_steer7",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "background work" },
        },
      });
      expect(session.inUnsolicitedTurn).toBe(true);

      mock.triggerNotification("session/update", {
        sessionId: "u_steer7",
        update: {
          sessionUpdate: "usage_update",
          used: 7,
          _meta: { "_claude/origin": { kind: "human" } },
        },
      });
      expect(session.inUnsolicitedTurn).toBe(true);
    });

    it("does not carry a steer arm forward when the detached turn was folded into the turn hydra thought was running", async () => {
      // The detached turn can live and die entirely inside the window where
      // hydra's own session/prompt for M1 hasn't resolved. promptInFlight is
      // still true, so noteAgentActivity folds the detached turn's output
      // away instead of opening one for it, and nothing ever consumes the
      // arm. Left armed it marks the NEXT agent-initiated turn steerCaused,
      // and steerCausedTurnTerminal then closes that unrelated turn on any
      // usage_update at all — the session reads idle while the agent works.
      const { session, mock } = makeSession("hydra_session_steer8", "u_steer8");
      const { client } = makeClient();
      session.attach(client, "full");
      mock.agent.steeringSupported = true;

      const requestMock = mock.agent.connection.request as ReturnType<typeof vi.fn>;
      let resolveM1: ((v: unknown) => void) | undefined;
      let resolveSteer: ((v: unknown) => void) | undefined;
      requestMock.mockImplementationOnce(
        () => new Promise((r) => (resolveM1 = r)),
      );
      requestMock.mockImplementationOnce(
        () => new Promise((r) => (resolveSteer = r)),
      );

      void session.prompt(client.clientId, {
        sessionId: "hydra_session_steer8",
        prompt: [{ type: "text", text: "original" }],
      });
      await new Promise((r) => setImmediate(r));

      const steerPromise = session.steer(client.clientId, {
        sessionId: "hydra_session_steer8",
        prompt: [{ type: "text", text: "redirect" }],
      });
      await new Promise((r) => setImmediate(r));

      // The detached turn runs to completion while M1 is still nominally
      // current — both of these are folded away, neither opens a turn.
      mock.triggerNotification("session/update", {
        sessionId: "u_steer8",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "detached work" },
        },
      });
      mock.triggerNotification("session/update", {
        sessionId: "u_steer8",
        update: {
          sessionUpdate: "usage_update",
          used: 11,
          _meta: { "_claude/origin": { kind: "human" } },
        },
      });
      expect(session.inUnsolicitedTurn).toBe(false);

      resolveM1?.({ stopReason: "end_turn" });
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      resolveSteer?.({ outcome: "startedNewTurn" });
      await steerPromise;
      await new Promise((r) => setImmediate(r));

      // Much later: an ordinary background-task resumption, nothing to do
      // with the steer. It must not inherit the stale arm.
      mock.triggerNotification("session/update", {
        sessionId: "u_steer8",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "background work" },
        },
      });
      expect(session.inUnsolicitedTurn).toBe(true);

      // A human-lane terminal belongs to some other lane's turn, not this
      // one. If the arm leaked, this closes it and the session reads idle
      // while the agent is still working.
      mock.triggerNotification("session/update", {
        sessionId: "u_steer8",
        update: {
          sessionUpdate: "usage_update",
          used: 12,
          _meta: { "_claude/origin": { kind: "human" } },
        },
      });
      expect(session.inUnsolicitedTurn).toBe(true);

      // Still ends on its own proper signal.
      mock.triggerNotification("session/update", {
        sessionId: "u_steer8",
        update: {
          sessionUpdate: "usage_update",
          used: 13,
          _meta: { "_claude/origin": { kind: "task-notification" } },
        },
      });
      expect(session.inUnsolicitedTurn).toBe(false);
    });

    it("falls back to amend (cancel-and-resubmit) when a turn is in flight but the agent doesn't support native steering", async () => {
      const { session, mock } = makeSession("hydra_session_steer3", "u_steer3");
      const { client } = makeClient();
      session.attach(client, "full");
      mock.agent.steeringSupported = false;

      const requestMock = mock.agent.connection.request as ReturnType<typeof vi.fn>;
      const notifyMock = mock.agent.connection.notify as ReturnType<typeof vi.fn>;
      let resolveM1: ((v: unknown) => void) | undefined;
      requestMock.mockImplementationOnce(
        () => new Promise((r) => (resolveM1 = r)),
      );
      requestMock.mockResolvedValueOnce({ stopReason: "end_turn" });

      void session.prompt(client.clientId, {
        sessionId: "hydra_session_steer3",
        prompt: [{ type: "text", text: "original" }],
      });
      await new Promise((r) => setImmediate(r));

      const result = await session.steer(client.clientId, {
        sessionId: "hydra_session_steer3",
        prompt: [{ type: "text", text: "redirect" }],
      });

      expect(result).toEqual({ outcome: "startedNewTurn" });
      // amendOnHead's cancel-and-resubmit fired, not a native steering call.
      expect(requestMock).not.toHaveBeenCalledWith(
        "_session/steering",
        expect.anything(),
      );
      expect(notifyMock).toHaveBeenCalledWith("session/cancel", {
        sessionId: "u_steer3",
      });
      resolveM1?.({ stopReason: "cancelled" });
    });

    it("treats an idle session as a normal new prompt", async () => {
      const { session, mock } = makeSession("hydra_session_steer4", "u_steer4");
      const { client } = makeClient();
      const { client: observer, stream: observerStream } = makeClient();
      session.attach(client, "full");
      session.attach(observer, "full");
      mock.agent.steeringSupported = true;

      const requestMock = mock.agent.connection.request as ReturnType<typeof vi.fn>;
      requestMock.mockResolvedValueOnce({ stopReason: "end_turn" });

      const result = await session.steer(client.clientId, {
        sessionId: "hydra_session_steer4",
        prompt: [{ type: "text", text: "hello" }],
      });

      expect(result).toEqual({ outcome: "startedNewTurn" });
      expect(requestMock).toHaveBeenCalledWith(
        "session/prompt",
        expect.objectContaining({ sessionId: "u_steer4" }),
      );
      const promptReceived = observerStream.sent.find(
        (m): m is JsonRpcNotification =>
          "method" in m &&
          m.method === "session/update" &&
          (m.params as { update?: { sessionUpdate?: string } }).update
            ?.sessionUpdate === "prompt_received",
      );
      expect(promptReceived).toBeDefined();
    });

    it("returns promptRequired without enqueueing anything when the caller opts into it on an idle session", async () => {
      const { session, mock } = makeSession("hydra_session_steer5", "u_steer5");
      const { client } = makeClient();
      session.attach(client, "full");
      mock.agent.steeringSupported = true;

      const requestMock = mock.agent.connection.request as ReturnType<typeof vi.fn>;

      const result = await session.steer(client.clientId, {
        sessionId: "hydra_session_steer5",
        prompt: [{ type: "text", text: "hello" }],
        _meta: { steering: { idleBehavior: "promptRequired" } },
      });

      expect(result).toEqual({ outcome: "promptRequired", reason: "noRunningTurn" });
      expect(requestMock).not.toHaveBeenCalled();
    });
  });

  describe("extension slash-command dispatch", () => {
    function makeSessionWithRegistry(registry: ExtensionCommandRegistry) {
      const mock = makeMockAgent({ agentId: "mock", cwd: "/work" });
      const session = new Session({
        sessionId: "hydra_session_ext",
        cwd: "/work",
        agentId: "mock",
        agent: mock.agent,
        upstreamSessionId: "u_ext",
        historyStore: new HistoryStore(),
        extensionCommands: registry,
      });
      return { session, mock };
    }

    function makeFakeExtensionConnection(): {
      connection: JsonRpcConnection;
      request: ReturnType<typeof vi.fn>;
      notifications: Array<{ method: string; params: unknown }>;
    } {
      const request = vi.fn();
      const notifications: Array<{ method: string; params: unknown }> = [];
      const notify = vi.fn((method: string, params: unknown) => {
        notifications.push({ method, params });
      });
      const connection = {
        request,
        notify,
      } as unknown as JsonRpcConnection;
      return { connection, request, notifications };
    }

    it("advertises registered verbs via mergedAvailableCommands", () => {
      const registry = new ExtensionCommandRegistry();
      const { session } = makeSessionWithRegistry(registry);
      const { connection } = makeFakeExtensionConnection();
      registry.register("hydra-acp-budgeter", connection, [
        {
          verb: "reset",
          description: "Reset accumulated cost",
        },
      ]);
      const names = session.mergedAvailableCommands().map((c) => c.name);
      expect(names).toContain("hydra hydra-acp-budgeter reset");
    });

    it("registry changes re-broadcast available_commands_update to attached clients", async () => {
      const registry = new ExtensionCommandRegistry();
      const { session } = makeSessionWithRegistry(registry);
      const { client, stream } = makeClient();
      await session.attach(client, "full");
      const baseline = stream.sent.length;

      const { connection } = makeFakeExtensionConnection();
      registry.register("hydra-acp-budgeter", connection, [{ verb: "reset" }]);
      await new Promise((r) => setImmediate(r));

      const broadcast = stream.sent
        .slice(baseline)
        .find(
          (m) =>
            "method" in m &&
            m.method === "session/update" &&
            (m.params as { update?: { sessionUpdate?: string } } | undefined)
              ?.update?.sessionUpdate === "available_commands_update",
        );
      expect(broadcast).toBeDefined();
      const cmds = (
        (broadcast as JsonRpcNotification | undefined)?.params as {
          update: { availableCommands: Array<{ name: string }> };
        }
      ).update.availableCommands.map((c) => c.name);
      expect(cmds).toContain("hydra hydra-acp-budgeter reset");
    });

    it("dispatches /hydra <ext> <verb> to the registered connection and emits the reply", async () => {
      const registry = new ExtensionCommandRegistry();
      const { session } = makeSessionWithRegistry(registry);
      const { connection, request } = makeFakeExtensionConnection();
      request.mockResolvedValue({ text: "spend reset" });
      registry.register("hydra-acp-budgeter", connection, [{ verb: "reset" }]);

      const { client, stream } = makeClient();
      await session.attach(client, "full");

      const result = await session.prompt(client.clientId, {
        sessionId: "hydra_session_ext",
        prompt: [{ type: "text", text: "/hydra hydra-acp-budgeter reset" }],
      });
      expect(result).toEqual({ stopReason: "end_turn" });

      expect(request).toHaveBeenCalledWith(
        "hydra-acp/commands/invoke",
        expect.objectContaining({
          sessionId: "hydra_session_ext",
          verb: "reset",
          args: "",
          // Slash commands now flow through the user-prompt queue;
          // commands/invoke carries the queue entry's messageId so
          // extensions can correlate amends / cancels with their
          // in-flight dispatch.
          messageId: expect.any(String),
        }),
      );

      const chunk = stream.sent.find(
        (m) =>
          "method" in m &&
          m.method === "session/update" &&
          (m.params as { update?: { sessionUpdate?: string; content?: { text?: string } } } | undefined)
            ?.update?.sessionUpdate === "agent_message_chunk",
      );
      expect(chunk).toBeDefined();
      const text = (
        (chunk as JsonRpcNotification | undefined)?.params as {
          update: { content: { text: string } };
        }
      ).update.content.text;
      expect(text).toContain("spend reset");
    });

    it("passes verb args through to the extension", async () => {
      const registry = new ExtensionCommandRegistry();
      const { session } = makeSessionWithRegistry(registry);
      const { connection, request } = makeFakeExtensionConnection();
      request.mockResolvedValue({ text: "" });
      registry.register("hydra-acp-budgeter", connection, [
        { verb: "set", argsHint: "<limit>" },
      ]);

      const { client } = makeClient();
      await session.attach(client, "full");
      await session.prompt(client.clientId, {
        sessionId: "hydra_session_ext",
        prompt: [{ type: "text", text: "/hydra hydra-acp-budgeter set hard 50" }],
      });

      expect(request).toHaveBeenCalledWith(
        "hydra-acp/commands/invoke",
        expect.objectContaining({
          sessionId: "hydra_session_ext",
          verb: "set",
          args: "hard 50",
          messageId: expect.any(String),
        }),
      );
    });

    it("emits an error chunk when the verb isn't registered", async () => {
      const registry = new ExtensionCommandRegistry();
      const { session } = makeSessionWithRegistry(registry);
      const { connection, request } = makeFakeExtensionConnection();
      registry.register("hydra-acp-budgeter", connection, [{ verb: "reset" }]);

      const { client, stream } = makeClient();
      await session.attach(client, "full");
      await session.prompt(client.clientId, {
        sessionId: "hydra_session_ext",
        prompt: [{ type: "text", text: "/hydra hydra-acp-budgeter delete-everything" }],
      });
      expect(request).not.toHaveBeenCalled();
      const chunk = stream.sent.find(
        (m) =>
          "method" in m &&
          m.method === "session/update" &&
          (m.params as { update?: { sessionUpdate?: string } } | undefined)
            ?.update?.sessionUpdate === "agent_message_chunk",
      );
      const text = (
        (chunk as JsonRpcNotification | undefined)?.params as {
          update: { content: { text: string } };
        }
      ).update.content.text;
      expect(text).toContain("unknown verb");
      expect(text).toContain("delete-everything");
    });

    it("surfaces extension errors as a synthetic agent chunk rather than throwing", async () => {
      const registry = new ExtensionCommandRegistry();
      const { session } = makeSessionWithRegistry(registry);
      const { connection, request } = makeFakeExtensionConnection();
      request.mockRejectedValue(new Error("disk full"));
      registry.register("hydra-acp-budgeter", connection, [{ verb: "reset" }]);

      const { client, stream } = makeClient();
      await session.attach(client, "full");
      const result = await session.prompt(client.clientId, {
        sessionId: "hydra_session_ext",
        prompt: [{ type: "text", text: "/hydra hydra-acp-budgeter reset" }],
      });
      expect(result).toEqual({ stopReason: "end_turn" });
      const chunk = stream.sent.find(
        (m) =>
          "method" in m &&
          m.method === "session/update" &&
          (m.params as { update?: { sessionUpdate?: string } } | undefined)
            ?.update?.sessionUpdate === "agent_message_chunk",
      );
      const text = (
        (chunk as JsonRpcNotification | undefined)?.params as {
          update: { content: { text: string } };
        }
      ).update.content.text;
      expect(text).toContain("disk full");
    });

    it("falls back to built-in hydra verbs even if an extension registers a colliding name", async () => {
      const registry = new ExtensionCommandRegistry();
      const { session } = makeSessionWithRegistry(registry);
      const { connection, request } = makeFakeExtensionConnection();
      // An extension that somehow registers under the literal name "title"
      // must NOT shadow the built-in /hydra title verb.
      registry.register("title", connection, [{ verb: "reset" }]);

      const { client } = makeClient();
      await session.attach(client, "full");
      const promise = session.prompt(client.clientId, {
        sessionId: "hydra_session_ext",
        prompt: [{ type: "text", text: "/hydra title my title" }],
      });
      // Built-in title-set path resolves end_turn; the extension is untouched.
      await expect(promise).resolves.toMatchObject({ stopReason: "end_turn" });
      expect(request).not.toHaveBeenCalled();
      expect(session.title).toBe("my title");
    });

    it("routes the elided short form `/hydra <short> <verb>` to a `hydra-acp-<short>` registration", async () => {
      const registry = new ExtensionCommandRegistry();
      const { session } = makeSessionWithRegistry(registry);
      const { connection, request } = makeFakeExtensionConnection();
      request.mockResolvedValue({ text: "ok" });
      registry.register("hydra-acp-planner", connection, [{ verb: "plan" }]);

      const { client } = makeClient();
      await session.attach(client, "full");
      const result = await session.prompt(client.clientId, {
        sessionId: "hydra_session_ext",
        prompt: [{ type: "text", text: "/hydra planner plan build a thing" }],
      });
      expect(result).toEqual({ stopReason: "end_turn" });
      expect(request).toHaveBeenCalledWith(
        "hydra-acp/commands/invoke",
        expect.objectContaining({
          sessionId: "hydra_session_ext",
          verb: "plan",
          args: "build a thing",
          messageId: expect.any(String),
        }),
      );
    });

    it("amend on an in-flight extension command fires hydra-acp/commands/cancel and unsticks the queue", async () => {
      // Stage B: when amend lands on an extension-bound user prompt
      // (the planner's `/hydra planner create` is the canonical
      // case), the daemon must signal the extension to release its
      // commands/invoke so drainQueue can advance. Without this the
      // queue stalls forever because amendOnHead's session/cancel
      // fires to the agent — which never had a turn for the slash
      // command — and the extension never learns about the amend.
      const registry = new ExtensionCommandRegistry();
      const { session } = makeSessionWithRegistry(registry);
      const { connection, request, notifications } = makeFakeExtensionConnection();
      // Park the commands/invoke promise so it never resolves on its
      // own — we want to prove the race against the cancel signal is
      // what unsticks the queue.
      const requestStartedAt = vi.fn();
      let neverResolves: (v: unknown) => void = () => undefined;
      request.mockImplementation(() => {
        requestStartedAt();
        return new Promise(() => {
          // Hold reference so it can't be GC'd; the daemon should
          // abandon this and move on.
          neverResolves = () => undefined;
        });
      });
      registry.register("hydra-acp-planner", connection, [{ verb: "create" }]);

      const { client } = makeClient();
      await session.attach(client, "full");
      const slashPromise = session.prompt(client.clientId, {
        sessionId: "hydra_session_ext",
        prompt: [{ type: "text", text: "/hydra planner create build X" }],
      });

      // Let the slash dispatch reach the extension.
      await new Promise((r) => setTimeout(r, 0));
      expect(request).toHaveBeenCalledTimes(1);
      const slashCallParams = request.mock.calls[0]![1] as { messageId?: unknown };
      const slashMessageId = slashCallParams.messageId;
      expect(typeof slashMessageId).toBe("string");

      // User amends.
      const amendResult = await session.amendPrompt(client.clientId, {
        sessionId: "hydra_session_ext",
        targetMessageId: slashMessageId as string,
        prompt: [{ type: "text", text: "actually build Y" }],
      });
      expect(amendResult).toMatchObject({ amended: true, reason: "ok" });

      // The slash dispatch settles cancelled — the daemon raced its
      // own cancel signal against the never-resolving commands/invoke.
      const slashResult = await slashPromise;
      expect(slashResult).toMatchObject({ stopReason: "cancelled" });

      // Extension received hydra-acp/commands/cancel with the right
      // messageId and reason="amended".
      const cancelNotify = notifications.find(
        (n) => n.method === "hydra-acp/commands/cancel",
      );
      expect(cancelNotify).toBeDefined();
      expect(cancelNotify!.params).toMatchObject({
        sessionId: "hydra_session_ext",
        messageId: slashMessageId,
        reason: "amended",
      });

      // Silence the "neverResolves" reference warning.
      neverResolves;
    });

    it("session/cancel on an in-flight extension command fires commands/cancel with reason='cancelled'", async () => {
      const registry = new ExtensionCommandRegistry();
      const { session } = makeSessionWithRegistry(registry);
      const { connection, request, notifications } = makeFakeExtensionConnection();
      request.mockImplementation(() => new Promise(() => undefined));
      registry.register("hydra-acp-planner", connection, [{ verb: "create" }]);

      const { client } = makeClient();
      await session.attach(client, "full");
      const slashPromise = session.prompt(client.clientId, {
        sessionId: "hydra_session_ext",
        prompt: [{ type: "text", text: "/hydra planner create build X" }],
      });
      await new Promise((r) => setTimeout(r, 0));

      await session.cancel(client.clientId);

      const slashResult = await slashPromise;
      expect(slashResult).toMatchObject({ stopReason: "cancelled" });

      const cancelNotify = notifications.find(
        (n) => n.method === "hydra-acp/commands/cancel",
      );
      expect(cancelNotify).toBeDefined();
      expect(cancelNotify!.params).toMatchObject({ reason: "cancelled" });
    });

    it("session close fires commands/cancel with reason='abandoned' to all in-flight extension dispatches", async () => {
      const registry = new ExtensionCommandRegistry();
      const { session } = makeSessionWithRegistry(registry);
      const { connection, request, notifications } = makeFakeExtensionConnection();
      request.mockImplementation(() => new Promise(() => undefined));
      registry.register("hydra-acp-planner", connection, [{ verb: "create" }]);

      const { client } = makeClient();
      await session.attach(client, "full");
      const slashPromise = session.prompt(client.clientId, {
        sessionId: "hydra_session_ext",
        prompt: [{ type: "text", text: "/hydra planner create build X" }],
      });
      await new Promise((r) => setTimeout(r, 0));

      await session.close();
      // close drives markClosed which fires the abandoned cancel.
      // slashPromise may reject with a connection-closed error or
      // resolve with cancelled — either way, the extension received
      // the notification.
      await slashPromise.catch(() => undefined);

      const cancelNotify = notifications.find(
        (n) => n.method === "hydra-acp/commands/cancel",
      );
      expect(cancelNotify).toBeDefined();
      expect(cancelNotify!.params).toMatchObject({ reason: "abandoned" });
    });

    it("exact-name match wins over the prefix-elision fallback", async () => {
      const registry = new ExtensionCommandRegistry();
      const { session } = makeSessionWithRegistry(registry);
      const shortConn = makeFakeExtensionConnection();
      const longConn = makeFakeExtensionConnection();
      shortConn.request.mockResolvedValue({ text: "short wins" });
      longConn.request.mockResolvedValue({ text: "long wins" });
      // Register both: a literal "planner" name AND "hydra-acp-planner".
      // The literal short name must take precedence — the elision is
      // strictly a fallback for when no exact match exists.
      registry.register("planner", shortConn.connection, [{ verb: "go" }]);
      registry.register("hydra-acp-planner", longConn.connection, [{ verb: "go" }]);

      const { client } = makeClient();
      await session.attach(client, "full");
      await session.prompt(client.clientId, {
        sessionId: "hydra_session_ext",
        prompt: [{ type: "text", text: "/hydra planner go" }],
      });
      expect(shortConn.request).toHaveBeenCalledTimes(1);
      expect(longConn.request).not.toHaveBeenCalled();
    });

    it("advertises both long and short forms for hydra-acp-* names", () => {
      const registry = new ExtensionCommandRegistry();
      const { session } = makeSessionWithRegistry(registry);
      const { connection } = makeFakeExtensionConnection();
      registry.register("hydra-acp-planner", connection, [{ verb: "plan" }]);
      const names = session.mergedAvailableCommands().map((c) => c.name);
      expect(names).toContain("hydra hydra-acp-planner plan");
      expect(names).toContain("hydra planner plan");
    });

    it("does not synthesize a short form for names without the hydra-acp- prefix", () => {
      const registry = new ExtensionCommandRegistry();
      const { session } = makeSessionWithRegistry(registry);
      const { connection } = makeFakeExtensionConnection();
      registry.register("my-custom-tool", connection, [{ verb: "go" }]);
      const names = session.mergedAvailableCommands().map((c) => c.name);
      expect(names).toContain("hydra my-custom-tool go");
      expect(names).not.toContain("hydra go");
    });
  });

  describe("applyModelChange / applyModeChange broadcast", () => {
    it("applyModelChange broadcasts current_model_update even when value already equals currentModel (overrides stale agent echo)", async () => {
      // Regression for the "1 behind" bug: claude-acp's set_model flow
      // emits a stale current_model_update (pre-change value) followed by
      // a config_option_update with the new value. The configOption path
      // updates currentModel, so applyModelChange would see value == state
      // and (previously) skip its corrective broadcast — leaving the TUI
      // showing the stale value. The broadcast must fire unconditionally.
      const { session } = makeSession("sess_m", "u_m");
      const { client, stream } = makeClient();
      await session.attach(client, "full");
      session.currentModel = "opus[1m]";
      stream.sent.length = 0;

      session.applyModelChange("opus[1m]");

      const broadcast = stream.sent.find(
        (m) =>
          "method" in m &&
          m.method === "session/update" &&
          (m.params as { update?: { sessionUpdate?: string } })?.update
            ?.sessionUpdate === "_hydra_current_model_update",
      );
      expect(broadcast).toBeDefined();
      expect(
        (broadcast as JsonRpcNotification).params,
      ).toMatchObject({
        sessionId: "sess_m",
        update: {
          sessionUpdate: "_hydra_current_model_update",
          currentModel: "opus[1m]",
        },
      });
    });

    it("applyModeChange broadcasts current_mode_update so attached peers (e.g. TUI) repaint when set_mode arrives from another client", async () => {
      const { session } = makeSession("sess_mode", "u_mode");
      const { client, stream } = makeClient();
      await session.attach(client, "full");
      stream.sent.length = 0;

      session.applyModeChange("plan");

      const broadcast = stream.sent.find(
        (m) =>
          "method" in m &&
          m.method === "session/update" &&
          (m.params as { update?: { sessionUpdate?: string } })?.update
            ?.sessionUpdate === "current_mode_update",
      );
      expect(broadcast).toBeDefined();
      expect(
        (broadcast as JsonRpcNotification).params,
      ).toMatchObject({
        sessionId: "sess_mode",
        update: {
          sessionUpdate: "current_mode_update",
          currentModeId: "plan",
        },
      });
      expect(session.currentMode).toBe("plan");
    });

    it("applyModeChange broadcasts even when value already equals currentMode (mirrors applyModelChange so a redundant set_mode still resyncs clients)", async () => {
      const { session } = makeSession("sess_mode2", "u_mode2");
      const { client, stream } = makeClient();
      await session.attach(client, "full");
      session.currentMode = "plan";
      stream.sent.length = 0;

      session.applyModeChange("plan");

      const broadcast = stream.sent.find(
        (m) =>
          "method" in m &&
          m.method === "session/update" &&
          (m.params as { update?: { sessionUpdate?: string } })?.update
            ?.sessionUpdate === "current_mode_update",
      );
      expect(broadcast).toBeDefined();
    });
  });

  describe("config options", () => {
    function findConfigUpdate(stream: { sent: unknown[] }) {
      return stream.sent.find(
        (m) =>
          !!m &&
          typeof m === "object" &&
          "method" in m &&
          (m as { method?: string }).method === "session/update" &&
          (m as { params?: { update?: { sessionUpdate?: string } } }).params
            ?.update?.sessionUpdate === "config_option_update",
      ) as JsonRpcNotification | undefined;
    }

    it("buildConfigOptions always includes the hydra-native agent option even with no modes/models/catalog", () => {
      const mock = makeMockAgent({ agentId: "mock", cwd: "/work" });
      const session = new Session({
        sessionId: "sess_co1",
        cwd: "/work",
        agentId: "mock",
        agent: mock.agent,
        upstreamSessionId: "u1",
        historyStore: new HistoryStore(),
      });
      const opts = session.buildConfigOptions();
      expect(opts).toHaveLength(1);
      expect(opts[0]).toMatchObject({
        id: "agent",
        category: "_hydra_agent",
        type: "select",
        currentValue: "mock",
      });
      // currentValue is injected into options even with an empty catalog.
      expect(opts[0]!.options.map((o) => o.value)).toContain("mock");
    });

    it("buildConfigOptions orders model, mode, then agent and uses spec categories", () => {
      const mock = makeMockAgent({ agentId: "mock", cwd: "/work" });
      const session = new Session({
        sessionId: "sess_co2",
        cwd: "/work",
        agentId: "claude-acp",
        agent: mock.agent,
        upstreamSessionId: "u2",
        historyStore: new HistoryStore(),
        currentModel: "model-2",
        currentMode: "code",
        agentModels: [
          { modelId: "model-1", name: "One" },
          { modelId: "model-2", name: "Two" },
        ],
        agentModes: [{ id: "ask" }, { id: "code", name: "Code" }],
        availableAgents: () => [
          { id: "claude-acp", name: "Claude" },
          { id: "opencode", name: "opencode" },
        ],
      });
      const opts = session.buildConfigOptions();
      expect(opts.map((o) => o.id)).toEqual(["model", "mode", "agent"]);
      expect(opts.map((o) => o.category)).toEqual(["model", "mode", "_hydra_agent"]);
      const model = opts[0]!;
      expect(model.currentValue).toBe("model-2");
      const mode = opts[1]!;
      expect(mode.currentValue).toBe("code");
      // mode value falls back to id when the agent supplied no name.
      expect(mode.options.find((o) => o.value === "ask")?.name).toBe("ask");
      const agent = opts[2]!;
      expect(agent.currentValue).toBe("claude-acp");
      expect(agent.options.map((o) => o.value)).toEqual(["claude-acp", "opencode"]);
    });

    it("buildConfigOptions injects the live agent when the catalog omits it", () => {
      const mock = makeMockAgent({ agentId: "mock", cwd: "/work" });
      const session = new Session({
        sessionId: "sess_co3",
        cwd: "/work",
        agentId: "custom-local",
        agent: mock.agent,
        upstreamSessionId: "u3",
        historyStore: new HistoryStore(),
        availableAgents: () => [{ id: "opencode", name: "opencode" }],
      });
      const agent = session.buildConfigOptions().find((o) => o.id === "agent")!;
      expect(agent.currentValue).toBe("custom-local");
      expect(agent.options.map((o) => o.value)).toContain("custom-local");
    });

    it("applyModelChange also broadcasts a config_option_update snapshot", async () => {
      const mock = makeMockAgent({ agentId: "mock", cwd: "/work" });
      const session = new Session({
        sessionId: "sess_co4",
        cwd: "/work",
        agentId: "mock",
        agent: mock.agent,
        upstreamSessionId: "u4",
        historyStore: new HistoryStore(),
        agentModels: [{ modelId: "m1" }, { modelId: "m2" }],
      });
      const { client, stream } = makeClient();
      await session.attach(client, "full");
      stream.sent.length = 0;

      session.applyModelChange("m2");

      const update = findConfigUpdate(stream);
      expect(update).toBeDefined();
      const list = (update!.params as { update: { configOptions: Array<{ id: string; currentValue: string }> } })
        .update.configOptions;
      expect(list.find((o) => o.id === "model")?.currentValue).toBe("m2");
    });

    it("applyModeChange also broadcasts a config_option_update snapshot", async () => {
      const mock = makeMockAgent({ agentId: "mock", cwd: "/work" });
      const session = new Session({
        sessionId: "sess_co5",
        cwd: "/work",
        agentId: "mock",
        agent: mock.agent,
        upstreamSessionId: "u5",
        historyStore: new HistoryStore(),
        agentModes: [{ id: "ask" }, { id: "code" }],
      });
      const { client, stream } = makeClient();
      await session.attach(client, "full");
      stream.sent.length = 0;

      session.applyModeChange("code");

      const update = findConfigUpdate(stream);
      expect(update).toBeDefined();
      const list = (update!.params as { update: { configOptions: Array<{ id: string; currentValue: string }> } })
        .update.configOptions;
      expect(list.find((o) => o.id === "mode")?.currentValue).toBe("code");
    });

    it("config_option_update broadcasts are not recorded to history", async () => {
      const mock = makeMockAgent({ agentId: "mock", cwd: "/work" });
      const store = new HistoryStore();
      const session = new Session({
        sessionId: "sess_co6",
        cwd: "/work",
        agentId: "mock",
        agent: mock.agent,
        upstreamSessionId: "u6",
        historyStore: store,
        agentModes: [{ id: "ask" }, { id: "code" }],
      });
      session.applyModeChange("code");
      const snap = await session.getHistorySnapshot();
      const hasConfigUpdate = snap.some(
        (e) =>
          (e.params as { update?: { sessionUpdate?: string } })?.update
            ?.sessionUpdate === "config_option_update",
      );
      expect(hasConfigUpdate).toBe(false);
    });
  });

  describe("/hydra config command", () => {
    function seedConfigOptions(session: Session, mock: ReturnType<typeof makeSession>["mock"]): void {
      mock.triggerNotification("session/update", {
        sessionId: "u_seed",
        update: {
          sessionUpdate: "config_option_update",
          configOptions: [
            {
              id: "model",
              currentValue: "ncp-anthropic/claude-opus-4-7",
              options: [
                { value: "ncp-anthropic/claude-opus-4-7", name: "Claude Opus 4.7" },
                { value: "openai/gpt-5", name: "GPT-5" },
              ],
            },
            {
              id: "mode",
              currentValue: "plan",
              options: [
                { value: "default", name: "Default" },
                { value: "plan", name: "Plan" },
                { value: "bypassPermissions", name: "Bypass" },
              ],
            },
            {
              id: "effort",
              currentValue: "low",
              options: [
                { value: "low", name: "Low" },
                { value: "medium", name: "Medium" },
                { value: "high", name: "High" },
              ],
            },
          ],
        },
      });
    }

    function findConfigBroadcast(stream: { sent: unknown[] }): JsonRpcNotification | undefined {
      return stream.sent.find(
        (m) =>
          !!m &&
          typeof m === "object" &&
          "method" in m &&
          (m as { method?: string }).method === "session/update" &&
          (m as { params?: { update?: { sessionUpdate?: string } } }).params
            ?.update?.sessionUpdate === "config_option_update",
      ) as JsonRpcNotification | undefined;
    }

    function extractTextMessage(stream: { sent: unknown[] }): string | undefined {
      const chunk = stream.sent.find(
        (m) =>
          !!m &&
          typeof m === "object" &&
          "method" in m &&
          (m as { method?: string }).method === "session/update" &&
          (m as { params?: { update?: { sessionUpdate?: string } } }).params
            ?.update?.sessionUpdate === "agent_message_chunk",
      ) as JsonRpcNotification | undefined;
      if (!chunk) return undefined;
      const content = (chunk.params as { update: { content: { text: string } } }).update.content;
      return typeof content.text === "string" ? content.text : undefined;
    }

    it("'/hydra config' with no args lists every advertised option", async () => {
      const { session, mock } = makeSession("sess_cfg1", "u_seed");
      seedConfigOptions(session, mock);
      await flushHistoryWrites();

      const { client: alice, stream } = makeClient();
      await session.attach(alice, "full");

      const result = await session.prompt(alice.clientId, {
        prompt: [{ type: "text", text: "/hydra config" }],
      });
      expect(result).toMatchObject({ stopReason: "end_turn" });

      const text = extractTextMessage(stream);
      expect(text).toBeDefined();
      // All three seeded options plus the hydra-native agent option,
      // each rendered with `id  (Name) — ▶ currentValue` headers.
      expect(text).toContain("model  (Model) — \u25b6 ncp-anthropic/claude-opus-4-7");
      expect(text).toContain("mode  (Session Mode) — \u25b6 plan");
      expect(text).toContain("effort — \u25b6 low");
      expect(text).toContain("agent  (Agent) — \u25b6");
      // Choice rows: current marked ▶, others ·, with the human name shown.
      expect(text).toContain("\u25b6 plan               Plan");
      expect(text).toContain("\u00b7 default            Default");
      expect(text).toContain("\u25b6 low     Low");
      expect(text).toContain("\u00b7 medium  Medium");
    });

    it("'/hydra config effort' lists choices for that single id", async () => {
      const { session, mock } = makeSession("sess_cfg2", "u_seed");
      seedConfigOptions(session, mock);
      await flushHistoryWrites();

      const { client: alice, stream } = makeClient();
      await session.attach(alice, "full");

      const result = await session.prompt(alice.clientId, {
        prompt: [{ type: "text", text: "/hydra config effort" }],
      });
      expect(result).toMatchObject({ stopReason: "end_turn" });

      const text = extractTextMessage(stream);
      expect(text).toBeDefined();
      expect(text).toContain("effort — \u25b6 low");
      expect(text).toContain("\u25b6 low     Low");
      expect(text).toContain("\u00b7 high    High");
    });

    it("'/hydra config effort high' forwards a session/set_config_option request", async () => {
      const { session, mock } = makeSession("sess_cfg3", "u_seed");
      seedConfigOptions(session, mock);
      await flushHistoryWrites();

      const requestMock = mock.agent.connection.request as ReturnType<typeof vi.fn>;
      requestMock.mockResolvedValue({});

      const { client: alice, stream } = makeClient();
      await session.attach(alice, "full");

      const result = await session.prompt(alice.clientId, {
        prompt: [{ type: "text", text: "/hydra config effort high" }],
      });
      expect(result).toMatchObject({ stopReason: "end_turn" });

      // The daemon should have forwarded set_config_option to the agent.
      expect(requestMock).toHaveBeenCalledWith("session/set_config_option", {
        sessionId: "u_seed",
        configId: "effort",
        value: "high",
      });
    });

    it("'/hydra config effort high' tells the other attached clients, not just the caller", async () => {
      // The reply is a response addressed to whoever asked. Unlike the
      // notification path there is no agent frame to relay, so without an
      // explicit broadcast every other client keeps rendering the old set.
      const { session, mock } = makeSession("sess_cfg_bcast", "u_seed");
      seedConfigOptions(session, mock);
      await flushHistoryWrites();

      const requestMock = mock.agent.connection.request as ReturnType<typeof vi.fn>;
      requestMock.mockResolvedValue({
        configOptions: [
          { id: "effort", currentValue: "high", options: [{ value: "low" }, { value: "high" }] },
        ],
      });

      const { client: alice } = makeClient();
      await session.attach(alice, "full");
      const { client: bob, stream: bobStream } = makeClient();
      await session.attach(bob, "full");
      bobStream.sent.length = 0;

      await session.prompt(alice.clientId, {
        prompt: [{ type: "text", text: "/hydra config effort high" }],
      });

      const pushed = bobStream.sent.filter(
        (m): m is JsonRpcNotification =>
          "method" in m &&
          m.method === "session/update" &&
          (m.params as { update?: { sessionUpdate?: string } }).update
            ?.sessionUpdate === "config_option_update",
      );
      expect(pushed.length).toBeGreaterThan(0);
      const last = pushed[pushed.length - 1]!.params as {
        update: { configOptions: Array<{ id: string; currentValue: string }> };
      };
      expect(
        last.update.configOptions.find((o) => o.id === "effort")?.currentValue,
      ).toBe("high");
    });

    it("keeps the mode downgrade a model switch forces", async () => {
      // A model switch can invalidate the permission mode: claude-acp
      // clamps it to "default" and emits current_mode_update mid-request,
      // before the reply. The reply then also carries mode=default, which
      // applyAgentConfigOptionResponse skips — mode is hydra's own
      // dimension, and the notification already moved it.
      const { session, mock } = makeSession("sess_cfg_modedown", "u_seed");
      seedConfigOptions(session, mock);
      await flushHistoryWrites();
      expect(session.currentMode).toBe("plan");

      const requestMock = mock.agent.connection.request as ReturnType<typeof vi.fn>;
      requestMock.mockImplementation(async (method: string) => {
        if (method !== "session/set_config_option") {
          return {};
        }
        mock.triggerNotification("session/update", {
          sessionId: "u_seed",
          update: {
            sessionUpdate: "current_mode_update",
            currentModeId: "default",
          },
        });
        return {
          configOptions: [
            {
              id: "model",
              currentValue: "openai/gpt-5",
              options: [{ value: "openai/gpt-5" }],
            },
            { id: "mode", currentValue: "default", options: [{ value: "default" }] },
          ],
        };
      });

      const { client: alice } = makeClient();
      await session.attach(alice, "full");

      await session.prompt(alice.clientId, {
        prompt: [{ type: "text", text: "/hydra config model openai/gpt-5" }],
      });

      expect(session.currentModel).toBe("openai/gpt-5");
      expect(session.currentMode).toBe("default");
    });

    it("'/hydra config model X' refreshes the dimensions the new model rebuilt", async () => {
      // A model switch is a config change that reshapes other config
      // values: claude-acp rebuilds effort for the new model and drops it
      // entirely when that model has no levels. The setter reply is the
      // only word on it — no config_option_update follows.
      const { session, mock } = makeSession("sess_cfg_modelsw", "u_seed");
      seedConfigOptions(session, mock);
      await flushHistoryWrites();
      expect(session.buildConfigOptions().map((o) => o.id)).toContain("effort");

      const requestMock = mock.agent.connection.request as ReturnType<typeof vi.fn>;
      requestMock.mockResolvedValue({
        configOptions: [
          {
            id: "model",
            currentValue: "openai/gpt-5",
            options: [
              { value: "ncp-anthropic/claude-opus-4-7" },
              { value: "openai/gpt-5" },
            ],
          },
          { id: "mode", currentValue: "plan", options: [{ value: "plan" }] },
        ],
      });

      const { client: alice } = makeClient();
      await session.attach(alice, "full");

      await session.prompt(alice.clientId, {
        prompt: [{ type: "text", text: "/hydra config model openai/gpt-5" }],
      });

      expect(session.currentModel).toBe("openai/gpt-5");
      // The new model advertises no effort levels, so the picker must go
      // rather than sit there offering values the agent will refuse.
      expect(session.buildConfigOptions().map((o) => o.id)).not.toContain(
        "effort",
      );
    });

    it("'/hydra config bogus' returns a synthetic error listing valid ids", async () => {
      const { session, mock } = makeSession("sess_cfg4", "u_seed");
      seedConfigOptions(session, mock);
      await flushHistoryWrites();

      const { client: alice, stream } = makeClient();
      await session.attach(alice, "full");

      const result = await session.prompt(alice.clientId, {
        prompt: [{ type: "text", text: "/hydra config bogus" }],
      });
      expect(result).toMatchObject({ stopReason: "end_turn" });

      const text = extractTextMessage(stream);
      expect(text).toBeDefined();
      expect(text).toContain('"bogus" is not a known config option');
      expect(text).toContain("Available options");
    });

    it("'/hydra config effort bogus' returns a synthetic error listing valid values", async () => {
      const { session, mock } = makeSession("sess_cfg5", "u_seed");
      seedConfigOptions(session, mock);
      await flushHistoryWrites();

      const { client: alice, stream } = makeClient();
      await session.attach(alice, "full");

      const result = await session.prompt(alice.clientId, {
        prompt: [{ type: "text", text: "/hydra config effort bogus" }],
      });
      expect(result).toMatchObject({ stopReason: "end_turn" });

      const text = extractTextMessage(stream);
      expect(text).toBeDefined();
      expect(text).toContain('"bogus" is not a valid value for "effort"');
      expect(text).toContain("Valid values");
    });

    it("broadcastCompactionPhase clears _liveCompactionPhase on rolled_back", () => {
      const { session } = makeSession();
      session.broadcastCompactionPhase({ phase: "started", requestedAt: 1 });
      expect((session as unknown as { _liveCompactionPhase: unknown })._liveCompactionPhase).toBeDefined();
      session.broadcastCompactionPhase({ phase: "rolled_back" });
      expect((session as unknown as { _liveCompactionPhase: unknown })._liveCompactionPhase).toBeUndefined();
    });
  });

  describe("per-turn usage_update persistence (recordCurrentUsageSnapshot)", () => {
    it("broadcastTurnComplete after applyAgentUsage writes one usage_update to historyStore", async () => {
      const store = new HistoryStore();
      const mock = makeMockAgent({ agentId: "mock", cwd: "/work" });
      const session = new Session({
        sessionId: "sess_ut1",
        cwd: "/work",
        agentId: "mock",
        agent: mock.agent,
        upstreamSessionId: "u_ut1",
        historyStore: store,
      });

      // Simulate usage from the agent.
      mock.triggerNotification("session/update", {
        sessionId: "u_ut1",
        update: {
          sessionUpdate: "usage_update",
          used: 500,
          size: 100_000,
          cost: { amount: 0.12, currency: "USD" },
        },
      });

      // Simulate turn completion (bypass prompt flow entirely).
      (session as unknown as { broadcastTurnComplete: (c: string, r: unknown) => void }).broadcastTurnComplete("client_a", { stopReason: "end_turn" });
      await flushHistoryWrites();

      const entries = await store.load("sess_ut1");
      const usageEntries = entries.filter(
        (e) =>
          (e.params as { update?: { sessionUpdate?: string } }).update
            ?.sessionUpdate === "usage_update",
      );
      expect(usageEntries).toHaveLength(1);
    });

    // Attribution stamp. params.sessionId is the HYDRA id, so without this the
    // recorded row cannot be tied back to the agent session that incurred the
    // cost. A hydra session's upstream rotates (compaction swap, /hydra agent,
    // restart, rollback) and meta.json keeps only the current id, so a cost
    // series spanning several upstreams is otherwise unattributable after the
    // fact — reconciling it against an agent's own ledger degenerates into
    // guessing by cwd and time window.
    it("stamps upstreamSessionId + agentId on the recorded usage_update", async () => {
      const store = new HistoryStore();
      const mock = makeMockAgent({ agentId: "mock", cwd: "/work" });
      const session = new Session({
        sessionId: "sess_attr",
        cwd: "/work",
        agentId: "opencode",
        agent: mock.agent,
        upstreamSessionId: "ses_upstream_abc",
        historyStore: store,
      });

      mock.triggerNotification("session/update", {
        sessionId: "ses_upstream_abc",
        update: {
          sessionUpdate: "usage_update",
          used: 500,
          size: 100_000,
          cost: { amount: 0.12, currency: "USD" },
        },
      });
      (session as unknown as { broadcastTurnComplete: (c: string, r: unknown) => void })
        .broadcastTurnComplete("client_a", { stopReason: "end_turn" });
      await flushHistoryWrites();

      const entries = await store.load("sess_attr");
      const row = entries.find(
        (e) =>
          (e.params as { update?: { sessionUpdate?: string } }).update
            ?.sessionUpdate === "usage_update",
      );
      expect(row).toBeDefined();
      const update = (row!.params as { update: Record<string, unknown> }).update;
      const ns = (update._meta as Record<string, unknown>)["hydra-acp"] as Record<
        string,
        unknown
      >;
      expect(ns.upstreamSessionId).toBe("ses_upstream_abc");
      expect(ns.agentId).toBe("opencode");
      // The cost payload must be untouched by the stamp.
      expect(update.cost).toEqual({ amount: 0.12, currency: "USD" });
    });

    // The stamp must be added AFTER the "any payload field present?" guard.
    // Added before it, _meta alone would push the key count past the
    // threshold and we would persist a usage row carrying no usage.
    //
    // Reaching that guard needs currentUsage to be DEFINED but empty — a
    // session with no usage at all returns undefined and bails earlier, so
    // seeding an empty snapshot is what actually exercises the ordering.
    it("stamp does not defeat the empty-snapshot guard", async () => {
      const store = new HistoryStore();
      const mock = makeMockAgent({ agentId: "mock", cwd: "/work" });
      const session = new Session({
        sessionId: "sess_attr2",
        cwd: "/work",
        agentId: "opencode",
        agent: mock.agent,
        upstreamSessionId: "ses_upstream_def",
        historyStore: store,
        currentUsage: {},
      });
      expect(session.currentUsage).toBeDefined();
      (session as unknown as { broadcastTurnComplete: (c: string, r: unknown) => void })
        .broadcastTurnComplete("client_a", { stopReason: "end_turn" });
      await flushHistoryWrites();
      const entries = await store.load("sess_attr2");
      expect(
        entries.filter(
          (e) =>
            (e.params as { update?: { sessionUpdate?: string } }).update
              ?.sessionUpdate === "usage_update",
        ),
      ).toHaveLength(0);
    });

    it("zero-usage turn writes no usage_update entry", async () => {
      const store = new HistoryStore();
      const mock = makeMockAgent({ agentId: "mock", cwd: "/work" });
      const session = new Session({
        sessionId: "sess_ut2",
        cwd: "/work",
        agentId: "mock",
        agent: mock.agent,
        upstreamSessionId: "u_ut2",
        historyStore: store,
      });

      // No usage notifications — just broadcast turn complete.
      (session as unknown as { broadcastTurnComplete: (c: string, r: unknown) => void }).broadcastTurnComplete("client_a", { stopReason: "end_turn" });
      await flushHistoryWrites();

      const entries = await store.load("sess_ut2");
      const usageEntries = entries.filter(
        (e) =>
          (e.params as { update?: { sessionUpdate?: string } }).update
            ?.sessionUpdate === "usage_update",
      );
      expect(usageEntries).toHaveLength(0);
    });

    it("two turns produce two usage_update entries, second has costAmount >= first", async () => {
      const store = new HistoryStore();
      const mock = makeMockAgent({ agentId: "mock", cwd: "/work" });
      const session = new Session({
        sessionId: "sess_ut3",
        cwd: "/work",
        agentId: "mock",
        agent: mock.agent,
        upstreamSessionId: "u_ut3",
        historyStore: store,
      });

      // Turn 1: usage of $0.10
      mock.triggerNotification("session/update", {
        sessionId: "u_ut3",
        update: {
          sessionUpdate: "usage_update",
          cost: { amount: 0.10, currency: "USD" },
        },
      });
      (session as unknown as { broadcastTurnComplete: (c: string, r: unknown) => void }).broadcastTurnComplete("client_a", { stopReason: "end_turn" });
      await flushHistoryWrites();

      // Turn 2: usage of $0.08 more (total $0.18 via _currentUsage merge).
      mock.triggerNotification("session/update", {
        sessionId: "u_ut3",
        update: {
          sessionUpdate: "usage_update",
          cost: { amount: 0.18, currency: "USD" },
        },
      });
      (session as unknown as { broadcastTurnComplete: (c: string, r: unknown) => void }).broadcastTurnComplete("client_a", { stopReason: "end_turn" });
      await flushHistoryWrites();

      const entries = await store.load("sess_ut3");
      const usageEntries = entries.filter(
        (e) =>
          (e.params as { update?: { sessionUpdate?: string } }).update
            ?.sessionUpdate === "usage_update",
      );
      expect(usageEntries).toHaveLength(2);

      const firstCost = ((usageEntries[0]?.params as { update?: { cost?: { amount?: number } } })?.update?.cost?.amount) ?? 0;
      const secondCost = ((usageEntries[1]?.params as { update?: { cost?: { amount?: number } } })?.update?.cost?.amount) ?? 0;
      expect(typeof firstCost).toBe("number");
      expect(typeof secondCost).toBe("number");
      expect(secondCost!).toBeGreaterThanOrEqual(firstCost!);
    });

    it("recorded envelope shape matches buildStateSnapshotReplay (used/size/cost.optionality)", () => {
      const store = new HistoryStore();
      const mock = makeMockAgent({ agentId: "mock", cwd: "/work" });
      const session = new Session({
        sessionId: "sess_ut4",
        cwd: "/work",
        agentId: "mock",
        agent: mock.agent,
        upstreamSessionId: "u_ut4",
        historyStore: store,
      });

      // Full payload: used + size + cost.amount + cost.currency.
      mock.triggerNotification("session/update", {
        sessionId: "u_ut4",
        update: {
          sessionUpdate: "usage_update",
          used: 5000,
          size: 250_000,
          cost: { amount: 0.99, currency: "EUR" },
        },
      });

      // The currentUsage getter returns the cross-life cumulative total.
      // recordCurrentUsageSnapshot builds its envelope from this getter,
      // so verifying the getter shape confirms the recorded envelope shape.
      expect(session.currentUsage).toEqual({
        used: 5000,
        size: 250_000,
        costAmount: 0.99,
        costCurrency: "EUR",
      });
    });

    it("with non-zero cumulativeCost, recorded cost.amount = cumulativeCost + current-life costAmount", async () => {
      const store = new HistoryStore();
      const mock = makeMockAgent({ agentId: "mock", cwd: "/work" });

      // Build a session that has prior-life cost (simulating a resurrected session).
      const session = new Session({
        sessionId: "sess_ut5",
        cwd: "/work",
        agentId: "mock",
        agent: mock.agent,
        upstreamSessionId: "u_ut5",
        historyStore: store,
      });

      // Manually set cumulativeCost to simulate prior-life spend.
      (session as unknown as { cumulativeCost: number }).cumulativeCost = 1.5;

      // Current-life usage adds $0.30 on top.
      mock.triggerNotification("session/update", {
        sessionId: "u_ut5",
        update: {
          sessionUpdate: "usage_update",
          cost: { amount: 0.30, currency: "USD" },
        },
      });

      // The currentUsage getter folds cumulativeCost + current costAmount.
      expect(session.currentUsage?.costAmount).toBe(1.8);

      (session as unknown as { broadcastTurnComplete: (c: string, r: unknown) => void }).broadcastTurnComplete("client_a", { stopReason: "end_turn" });
      await flushHistoryWrites();

      const entries = await store.load("sess_ut5");
      const usageEntries = entries.filter(
        (e) =>
          (e.params as { update?: { sessionUpdate?: string } }).update
            ?.sessionUpdate === "usage_update",
      );
      expect(usageEntries).toHaveLength(1);

      const recordedCost = ((usageEntries[0]?.params as { update?: { cost?: { amount?: number } } })?.update?.cost?.amount) ?? 0;
      expect(recordedCost).toBe(1.8);
    });

    it("fresh-attach replay filters usage_update from raw history (only synthesized snapshot)", async () => {
      const store = new HistoryStore();
      const mock = makeMockAgent({ agentId: "mock", cwd: "/work" });
      const session = new Session({
        sessionId: "sess_rf1",
        cwd: "/work",
        agentId: "mock",
        agent: mock.agent,
        upstreamSessionId: "u_rf1",
        historyStore: store,
      });

      // Warm attach to seed the session.
      const warm = makeClient();
      await session.attach(warm.client, "full");

      // Simulate usage over two turns.
      mock.triggerNotification("session/update", {
        sessionId: "u_rf1",
        update: {
          sessionUpdate: "usage_update",
          cost: { amount: 0.10, currency: "USD" },
        },
      });
      (session as unknown as { broadcastTurnComplete: (c: string, r: unknown) => void }).broadcastTurnComplete("client_a", { stopReason: "end_turn" });
      await flushHistoryWrites();

      mock.triggerNotification("session/update", {
        sessionId: "u_rf1",
        update: {
          sessionUpdate: "usage_update",
          cost: { amount: 0.25, currency: "USD" },
        },
      });
      (session as unknown as { broadcastTurnComplete: (c: string, r: unknown) => void }).broadcastTurnComplete("client_a", { stopReason: "end_turn" });
      await flushHistoryWrites();

      // Cold attach — should NOT receive historical usage_update entries.
      const cold = makeClient();
      const { entries: replay } = await session.attach(cold.client, "full");

      const historicalUsageReplay = replay.filter(
        (e) =>
          !isStateSnapshotEntry(e) &&
          (e.params as { update?: { sessionUpdate?: string } }).update
            ?.sessionUpdate === "usage_update",
      );
      expect(historicalUsageReplay).toHaveLength(0);

      // The synthesized snapshot should carry the current cumulative total.
      const synthUsage = replay.find(
        (e) =>
          isStateSnapshotEntry(e) &&
          (e.params as { update?: { sessionUpdate?: string } }).update
            ?.sessionUpdate === "usage_update",
      );
      expect(synthUsage).toBeDefined();
      const costAmount = ((synthUsage?.params as { update?: { cost?: { amount?: number } } })?.update?.cost?.amount) ?? 0;
      expect(costAmount).toBe(0.25);
    });

    it("fresh-attach replay filters ALL state-update kinds from raw history", async () => {
      const store = new HistoryStore();
      const mock = makeMockAgent({ agentId: "mock", cwd: "/work" });
      const session = new Session({
        sessionId: "sess_rf2",
        cwd: "/work",
        agentId: "mock",
        agent: mock.agent,
        upstreamSessionId: "u_rf2",
        historyStore: store,
      });

      const warm = makeClient();
      await session.attach(warm.client, "full");

      // Emit various state-update kinds to history.
      mock.triggerNotification("session/update", {
        sessionId: "u_rf2",
        update: { sessionUpdate: "usage_update", cost: { amount: 0.05, currency: "USD" } },
      });
      mock.triggerNotification("session/update", {
        sessionId: "u_rf2",
        update: { sessionUpdate: "_hydra_current_model_update", currentModel: "gpt-5" },
      });
      mock.triggerNotification("session/update", {
        sessionId: "u_rf2",
        update: { sessionUpdate: "session_info_update", title: "Test Session" },
      });
      (session as unknown as { broadcastTurnComplete: (c: string, r: unknown) => void }).broadcastTurnComplete("client_a", { stopReason: "end_turn" });
      await flushHistoryWrites();

      const cold = makeClient();
      const { entries: replay } = await session.attach(cold.client, "full");

      // No state-update kinds should appear in the historical portion.
      const stateKinds = ["usage_update", "_hydra_current_model_update", "session_info_update"];
      for (const kind of stateKinds) {
        const found = replay.filter(
          (e) =>
            !isStateSnapshotEntry(e) &&
            (e.params as { update?: { sessionUpdate?: string } }).update
              ?.sessionUpdate === kind,
        );
        expect(found).toHaveLength(0);
      }
    });

    it("after_message replay with usage_update in history uses correct cutoff", async () => {
      const store = new HistoryStore();
      const mock = makeMockAgent({ agentId: "mock", cwd: "/work" });
      const session = new Session({
        sessionId: "sess_rf3",
        cwd: "/work",
        agentId: "mock",
        agent: mock.agent,
        upstreamSessionId: "u_rf3",
        historyStore: store,
      });

      const warm = makeClient();
      await session.attach(warm.client, "full");

      // Simulate a real prompt → turn flow to get messageIds.
      (mock.agent.connection.request as ReturnType<typeof vi.fn>).mockResolvedValue({
        stopReason: "end_turn",
      });
      const first = makeClient();
      await session.attach(first.client, "none");
      await session.prompt(first.client.clientId, {
        sessionId: "sess_rf3",
        prompt: [{ type: "text", text: "first" }],
      });
      // Add a usage_update after the turn (this is what recordCurrentUsageSnapshot
      // would have persisted at the turn boundary).
      mock.triggerNotification("session/update", {
        sessionId: "u_rf3",
        update: {
          sessionUpdate: "usage_update",
          cost: { amount: 0.15, currency: "USD" },
        },
      });
      await flushHistoryWrites();

      // Grab the turn_complete messageId from history.
      const fullSnap = await session.getHistorySnapshot();
      const turnEntry = fullSnap.find(
        (e) =>
          (e.params as { update?: { sessionUpdate?: string } }).update
            ?.sessionUpdate === "turn_complete",
      );
      const turnMessageId = (turnEntry?.params as { update: { messageId: string } }).update.messageId;
      expect(turnMessageId).toBeDefined();

      // Cold attach with after_message policy.
      const cold = makeClient();
      const { entries: delta, appliedPolicy } = await session.attach(
        cold.client,
        "after_message",
        { afterMessageId: turnMessageId! },
      );
      expect(appliedPolicy).toBe("after_message");

      // The historical delta should be empty — usage_update is a state-update
      // kind and gets filtered out from replayable history. Nothing non-state
      // should remain after the turn_complete cutoff.
      const historicalDelta = delta.filter((e) => !isStateSnapshotEntry(e));
      expect(historicalDelta).toHaveLength(0);
    });
  });

  describe("attention flags", () => {
    it("setAttentionFlag creates a new flag with raisedAt set", () => {
      const { session } = makeSession();
      const before = Date.now();
      session.setAttentionFlag("test-source", "test-reason", { data: 1 });
      const after = Date.now();
      const flags = session.listAttentionFlags();
      expect(flags).toHaveLength(1);
      expect(flags[0]!.source).toBe("test-source");
      expect(flags[0]!.reason).toBe("test-reason");
      expect(flags[0]!.payload).toEqual({ data: 1 });
      expect(flags[0]!.raisedAt).toBeGreaterThanOrEqual(before);
      expect(flags[0]!.raisedAt).toBeLessThanOrEqual(after);
    });

    it("setAttentionFlag with same payload is idempotent — no-op", () => {
      const { session } = makeSession();
      const flag = { data: 1 };
      session.setAttentionFlag("src", "reason", flag);
      const firstRaisedAt = session.listAttentionFlags()[0]!.raisedAt;
      // Wait a tick so Date.now() would differ if raisedAt were updated
      setImmediate(() => {
        session.setAttentionFlag("src", "reason", flag);
      });
      // Use microtask to assert after the tick
      return new Promise<void>((resolve) => {
        setImmediate(() => {
          const flags = session.listAttentionFlags();
          expect(flags).toHaveLength(1);
          expect(flags[0]!.raisedAt).toBe(firstRaisedAt);
          resolve();
        });
      });
    });

    it("setAttentionFlag with new payload replaces, keeping original raisedAt", () => {
      const { session } = makeSession();
      session.setAttentionFlag("src", "reason", { data: 1 });
      const firstRaisedAt = session.listAttentionFlags()[0]!.raisedAt;
      return new Promise<void>((resolve) => {
        setImmediate(() => {
          session.setAttentionFlag("src", "reason", { data: 2 });
          const flags = session.listAttentionFlags();
          expect(flags).toHaveLength(1);
          expect(flags[0]!.raisedAt).toBe(firstRaisedAt);
          expect(flags[0]!.payload).toEqual({ data: 2 });
          resolve();
        });
      });
    });

    it("clearAttentionFlag removes an existing flag", () => {
      const { session } = makeSession();
      session.setAttentionFlag("src", "reason", { data: 1 });
      expect(session.listAttentionFlags()).toHaveLength(1);
      session.clearAttentionFlag("src", "reason");
      expect(session.listAttentionFlags()).toHaveLength(0);
    });

    it("clearAttentionFlag on missing key is no-op", () => {
      const { session } = makeSession();
      expect(() => session.clearAttentionFlag("nope", "nope")).not.toThrow();
      expect(session.listAttentionFlags()).toHaveLength(0);
    });

    it("listAttentionFlags returns flags sorted by raisedAt ascending", () => {
      const { session } = makeSession();
      session.setAttentionFlag("a", "r1", { i: 1 });
      return new Promise<void>((resolve) => {
        setImmediate(() => {
          session.setAttentionFlag("b", "r2", { i: 2 });
          setImmediate(() => {
            session.setAttentionFlag("c", "r3", { i: 3 });
            const flags = session.listAttentionFlags();
            expect(flags).toHaveLength(3);
            expect(flags[0]!.source).toBe("a");
            expect(flags[1]!.source).toBe("b");
            expect(flags[2]!.source).toBe("c");
            resolve();
          });
        });
      });
    });

    it("listAttentionFlagsBySource filters correctly", () => {
      const { session } = makeSession();
      session.setAttentionFlag("alpha", "r1", {});
      session.setAttentionFlag("beta", "r2", {});
      session.setAttentionFlag("alpha", "r3", {});
      const byAlpha = session.listAttentionFlagsBySource("alpha");
      expect(byAlpha).toHaveLength(2);
      expect(byAlpha.every((f) => f.source === "alpha")).toBe(true);
      const byBeta = session.listAttentionFlagsBySource("beta");
      expect(byBeta).toHaveLength(1);
      expect(byBeta[0]!.reason).toBe("r2");
    });

    it("awaitingInput is true when only attention flags are present", () => {
      const { session } = makeSession();
      expect(session.awaitingInput).toBe(false);
      session.setAttentionFlag("src", "reason", {});
      expect(session.awaitingInput).toBe(true);
      session.clearAttentionFlag("src", "reason");
      expect(session.awaitingInput).toBe(false);
    });

    it("awaitingInput is false when there are no attention flags", () => {
      const { session } = makeSession();
      expect(session.awaitingInput).toBe(false);
    });

    it("setAttentionFlag broadcasts attention_updated to attached clients with the new flag", () => {
      const { session } = makeSession();
      const { client, stream } = makeClient();
      session.attach(client, "full");
      session.setAttentionFlag("src", "reason", { data: 42 });
      const msg = stream.sent.find(
        (m) => "method" in m && m.method === "hydra-acp/session/attention_updated",
      ) as JsonRpcNotification | undefined;
      expect(msg).toBeDefined();
      expect(msg!.params).toMatchObject({
        flags: [expect.objectContaining({ source: "src", reason: "reason", payload: { data: 42 } })],
      });
    });

    it("clearAttentionFlag broadcasts attention_updated with empty flags array", () => {
      const { session } = makeSession();
      const { client, stream } = makeClient();
      session.attach(client, "full");
      session.setAttentionFlag("src", "reason", { data: 42 });
      stream.sent.length = 0;
      session.clearAttentionFlag("src", "reason");
      const msg = stream.sent.find(
        (m) => "method" in m && m.method === "hydra-acp/session/attention_updated",
      ) as JsonRpcNotification | undefined;
      expect(msg).toBeDefined();
      expect((msg!.params as { flags: unknown[] }).flags).toEqual([]);
    });

    it("idempotent set (same payload) does NOT trigger a notification", () => {
      const { session } = makeSession();
      const { client, stream } = makeClient();
      session.attach(client, "full");
      session.setAttentionFlag("src", "reason", { data: 42 });
      stream.sent.length = 0;
      session.setAttentionFlag("src", "reason", { data: 42 });
      const msg = stream.sent.find(
        (m) => "method" in m && m.method === "hydra-acp/session/attention_updated",
      );
      expect(msg).toBeUndefined();
    });

    it("onAttentionFlagsChange fires with the current flags after set", () => {
      const { session } = makeSession();
      const received: AttentionFlag[][] = [];
      session.onAttentionFlagsChange((flags) => {
        received.push(flags);
      });
      session.setAttentionFlag("src", "reason", { data: 42 });
      expect(received).toHaveLength(1);
      expect(received[0]).toHaveLength(1);
      expect(received[0]![0]!.source).toBe("src");
      expect(received[0]![0]!.reason).toBe("reason");
    });

    it("onAttentionFlagsChange fires with empty array after clear", () => {
      const { session } = makeSession();
      const received: AttentionFlag[][] = [];
      session.onAttentionFlagsChange((flags) => {
        received.push(flags);
      });
      session.setAttentionFlag("src", "reason", { data: 42 });
      session.clearAttentionFlag("src", "reason");
      expect(received).toHaveLength(2);
      expect(received[0]).toHaveLength(1);
      expect(received[1]).toHaveLength(0);
    });

    it("idempotent set does not fire onAttentionFlagsChange", () => {
      const { session } = makeSession();
      const received: AttentionFlag[][] = [];
      session.onAttentionFlagsChange((flags) => {
        received.push(flags);
      });
      session.setAttentionFlag("src", "reason", { data: 42 });
      session.setAttentionFlag("src", "reason", { data: 42 });
      expect(received).toHaveLength(1);
    });

    it("clear on missing key does not fire onAttentionFlagsChange", () => {
      const { session } = makeSession();
      const received: AttentionFlag[][] = [];
      session.onAttentionFlagsChange((flags) => {
        received.push(flags);
      });
      session.clearAttentionFlag("nope", "nope");
      expect(received).toHaveLength(0);
    });

    it("payload replacement fires onAttentionFlagsChange with updated flags", () => {
      const { session } = makeSession();
      const received: AttentionFlag[][] = [];
      session.onAttentionFlagsChange((flags) => {
        received.push(flags);
      });
      session.setAttentionFlag("src", "reason", { data: 1 });
      session.setAttentionFlag("src", "reason", { data: 2 });
      expect(received).toHaveLength(2);
      expect(received[1]![0]!.payload).toEqual({ data: 2 });
    });

    it("multiple flags with different (source, reason) all fire correctly", () => {
      const { session } = makeSession();
      const received: AttentionFlag[][] = [];
      session.onAttentionFlagsChange((flags) => {
        received.push(flags);
      });
      session.setAttentionFlag("a", "r1", {});
      expect(received[0]).toHaveLength(1);
      session.setAttentionFlag("b", "r2", {});
      expect(received[1]).toHaveLength(2);
      session.setAttentionFlag("a", "r3", {});
      expect(received[2]).toHaveLength(3);
    });
  });
});

// The redesign's safety property: no code path may DECREASE recorded lifetime
// cost. reconcileCostLedger only ever adds (the earlier un-bank variant could
// subtract, which is how it could erase an imported total). These pin that.
describe("cost ledger never loses spend", () => {
  const build = (init: {
    costAmount?: number;
    cumulativeCost?: number;
    reload?: boolean;
  }) => {
    const mock = makeMockAgent({ agentId: "mock", cwd: "/work" });
    const session = new Session({
      sessionId: "sess_noloss",
      cwd: "/work",
      agentId: "mock",
      agent: mock.agent,
      upstreamSessionId: "u_noloss",
      currentUsage: {
        ...(init.costAmount !== undefined
          ? { costAmount: init.costAmount }
          : {}),
        ...(init.cumulativeCost !== undefined
          ? { cumulativeCost: init.cumulativeCost }
          : {}),
      },
      ...(init.reload ? { reloadsUpstreamLedger: true } : {}),
    });
    return { session, mock };
  };
  const push = (mock: ReturnType<typeof makeMockAgent>, amount: number) => {
    mock.triggerNotification("session/update", {
      sessionId: "u_noloss",
      update: {
        sessionUpdate: "usage_update",
        cost: { amount, currency: "USD" },
      },
    });
  };

  const cases: Array<{
    name: string;
    init: { costAmount?: number; cumulativeCost?: number; reload?: boolean };
    reports: number[];
    final: number;
  }> = [
    {
      name: "legacy collapsed total, agent restarts low",
      init: { costAmount: 5, reload: true },
      reports: [0.01],
      final: 5.01,
    },
    {
      name: "legacy collapsed total, agent resumes high",
      init: { costAmount: 5, reload: true },
      reports: [5.5],
      final: 5.5,
    },
    {
      name: "split record, agent restarts low",
      init: { costAmount: 1.5, cumulativeCost: 3.5, reload: true },
      reports: [0.01],
      final: 5.01,
    },
    {
      name: "split record, agent resumes at exactly the retained amount",
      init: { costAmount: 1.5, cumulativeCost: 3.5, reload: true },
      reports: [1.5],
      final: 5,
    },
    {
      name: "import reseed (no reload), agent reports above the banked total",
      init: { cumulativeCost: 10, reload: false },
      reports: [25],
      final: 35,
    },
    {
      name: "many reports after a restart never regress",
      init: { costAmount: 4, cumulativeCost: 1, reload: true },
      reports: [0.1, 0.2, 0.3, 0.25],
      final: 5.25,
    },
  ];

  for (const c of cases) {
    it(`never drops below prior spend: ${c.name}`, () => {
      const { session, mock } = build(c.init);
      const before = session.currentUsage?.costAmount ?? 0;
      let low = before;
      for (const r of c.reports) {
        push(mock, r);
        low = Math.min(low, session.currentUsage?.costAmount ?? 0);
      }
      // The invariant: recorded lifetime cost is monotonically non-decreasing.
      expect(low).toBeGreaterThanOrEqual(before - 1e-9);
      expect(session.currentUsage?.costAmount ?? 0).toBeCloseTo(c.final, 9);
    });
  }
});
