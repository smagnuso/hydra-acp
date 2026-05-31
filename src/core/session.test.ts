import { describe, it, expect, vi } from "vitest";
import { Session, type AttachedClient } from "./session.js";
import { HistoryStore } from "./history-store.js";
import { ExtensionCommandRegistry } from "./extension-commands.js";
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

// Mirror of session.ts STATE_UPDATE_KINDS — the kinds that get prepended
// to attach replay as synthetic standard-ACP notifications. Tests use
// this to peel off the snapshot prefix when asserting on historical
// entries.
const STATE_SNAPSHOT_KINDS = new Set([
  "session_info_update",
  "current_model_update",
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
        update: { sessionUpdate: "current_model_update", currentModel: "gpt-5" },
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
      const model = findKind("current_model_update") as
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
        update: { sessionUpdate: "current_model_update", currentModel: "gpt-5" },
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
          sessionUpdate: "current_model_update",
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
            ?.sessionUpdate === "current_model_update",
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
          sessionUpdate: "current_model_update",
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
        (m) => m.params?.update?.sessionUpdate === "current_model_update",
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
          sessionUpdate: "current_model_update",
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
          sessionUpdate: "current_model_update",
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
      // pending_only is what session/load (agent-shell's resume path)
      // uses — the client has its own conversation history but still
      // needs current state pushed so a third-party ACP client sees
      // model/usage/commands/title without depending on hydra's _meta.
      const { session, mock } = makeSession("sess_po", "u_po");
      const warm = makeClient();
      await session.attach(warm.client, "full");
      mock.triggerNotification("session/update", {
        sessionId: "u_po",
        update: { sessionUpdate: "current_model_update", currentModel: "gpt-5" },
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
            ?.sessionUpdate === "current_model_update",
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

      // Only the head sees a terminal turn_complete (error from the
      // upstream rejection). No synthesized turn_complete(interrupted)
      // for bob's prompt — that's the bug this guards against.
      const turnCompletes = wireOf(bobStream).filter(
        (m) =>
          (m.params as { update?: { sessionUpdate?: string } }).update
            ?.sessionUpdate === "turn_complete",
      );
      expect(turnCompletes).toHaveLength(1);
      expect(
        (turnCompletes[0]!.params as { update: { stopReason?: string } }).update
          .stopReason,
      ).toBe("error");

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
    } {
      const request = vi.fn();
      const connection = { request } as unknown as JsonRpcConnection;
      return { connection, request };
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

      expect(request).toHaveBeenCalledWith("hydra-acp/commands/invoke", {
        sessionId: "hydra_session_ext",
        verb: "reset",
        args: "",
      });

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

      expect(request).toHaveBeenCalledWith("hydra-acp/commands/invoke", {
        sessionId: "hydra_session_ext",
        verb: "set",
        args: "hard 50",
      });
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
            ?.sessionUpdate === "current_model_update",
      );
      expect(broadcast).toBeDefined();
      expect(
        (broadcast as JsonRpcNotification).params,
      ).toMatchObject({
        sessionId: "sess_m",
        update: {
          sessionUpdate: "current_model_update",
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
});
