import { describe, it, expect, vi } from "vitest";
import {
  wireShim,
  normaliseInitializeClientInfo,
  detachUnpromptedSessions,
} from "./proxy.js";
import { SessionTracker } from "./session-tracker.js";
import { makeControlledStream } from "../__tests__/test-utils.js";
import { HYDRA_VERSION } from "../core/hydra-version.js";
import {
  JsonRpcErrorCodes,
  type JsonRpcNotification,
  type JsonRpcRequest,
} from "../acp/types.js";
import type { RemoteTarget } from "../core/remote-target.js";

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

const fakeTarget: RemoteTarget = {
  baseUrl: "http://test.invalid",
  wsUrl: "ws://test.invalid/acp",
  token: "test-token",
  display: "test.invalid",
  isLocal: false,
};

describe("wireShim forwarding", () => {
  it("forwards initialize to upstream and does NOT spuriously respond on downstream", async () => {
    const upstream = makeControlledStream();
    const downstream = makeControlledStream();
    const tracker = new SessionTracker();

    wireShim({ opts: {}, upstream, downstream, tracker });

    downstream.emitMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1 },
    });

    await new Promise((r) => setImmediate(r));

    expect(upstream.sent).toHaveLength(1);
    expect(upstream.sent[0]).toMatchObject({
      method: "initialize",
      id: 1,
    });
    expect(downstream.sent).toEqual([]);
  });

  it("forwards server messages to downstream and does NOT respond upstream", async () => {
    const upstream = makeControlledStream();
    const downstream = makeControlledStream();
    const tracker = new SessionTracker();

    wireShim({ opts: {}, upstream, downstream, tracker });

    upstream.emitMessage({
      jsonrpc: "2.0",
      id: 99,
      method: "session/request_permission",
      params: { sessionId: "sess_h", toolCall: { name: "x" } },
    });

    await new Promise((r) => setImmediate(r));

    expect(downstream.sent).toHaveLength(1);
    expect(downstream.sent[0]).toMatchObject({
      method: "session/request_permission",
    });
    expect(upstream.sent).toEqual([]);
  });

  it("--dangerously-skip-permissions answers session/request_permission upstream and does NOT forward to downstream", async () => {
    const upstream = makeControlledStream();
    const downstream = makeControlledStream();
    const tracker = new SessionTracker();

    wireShim({
      opts: { dangerouslySkipPermissions: true },
      upstream,
      downstream,
      tracker,
    });

    upstream.emitMessage({
      jsonrpc: "2.0",
      id: 7,
      method: "session/request_permission",
      params: {
        sessionId: "sess_h",
        toolCall: { toolCallId: "tc-7", name: "Bash" },
        options: [
          { kind: "allow_always", name: "Always", optionId: "allow_always" },
          { kind: "allow_once", name: "Allow", optionId: "allow_once" },
          { kind: "reject_once", name: "Reject", optionId: "reject_once" },
        ],
      },
    });

    await new Promise((r) => setImmediate(r));

    expect(downstream.sent).toEqual([]);
    expect(upstream.sent).toHaveLength(1);
    expect(upstream.sent[0]).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: { outcome: { outcome: "selected", optionId: "allow_once" } },
    });
  });

  it("injects agentId under _meta[\"hydra-acp\"] in launcher mode (never top-level)", async () => {
    const upstream = makeControlledStream();
    const downstream = makeControlledStream();
    const tracker = new SessionTracker();

    wireShim({
      opts: { agentId: "claude-acp" },
      upstream,
      downstream,
      tracker,
    });

    downstream.emitMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "session/new",
      params: { cwd: "/work" },
    });

    await new Promise((r) => setImmediate(r));

    expect(upstream.sent).toHaveLength(1);
    const sent = upstream.sent[0] as {
      params: { cwd: string; agentId?: string; _meta: { "hydra-acp": { agentId: string } } };
    };
    // Spec-compliant: cwd stays top-level, agentId rides under _meta.
    expect(sent.params.cwd).toBe("/work");
    expect(sent.params.agentId).toBeUndefined();
    expect(sent.params._meta["hydra-acp"].agentId).toBe("claude-acp");
  });

  it("injects name and agentArgs under _meta[\"hydra-acp\"] on first session/new", async () => {
    const upstream = makeControlledStream();
    const downstream = makeControlledStream();
    const tracker = new SessionTracker();

    wireShim({
      opts: {
        agentId: "codex-acp",
        agentArgs: ["-c", "sandbox_mode=danger-full-access"],
        name: "feature-X",
      },
      upstream,
      downstream,
      tracker,
    });

    downstream.emitMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "session/new",
      params: { cwd: "/work" },
    });

    await new Promise((r) => setImmediate(r));

    const sent = upstream.sent[0] as {
      params: {
        agentId?: string;
        _meta: { "hydra-acp": { agentId: string; title: string; agentArgs: string[] } };
      };
    };
    expect(sent.params.agentId).toBeUndefined();
    expect(sent.params._meta["hydra-acp"]).toEqual({
      agentId: "codex-acp",
      agentArgs: ["-c", "sandbox_mode=danger-full-access"],
      title: "feature-X",
    });
  });

  it("injects model under _meta[\"hydra-acp\"] when opts.model is set", async () => {
    const upstream = makeControlledStream();
    const downstream = makeControlledStream();
    const tracker = new SessionTracker();

    wireShim({
      opts: { agentId: "opencode", model: "openai/gpt-5" },
      upstream,
      downstream,
      tracker,
    });

    downstream.emitMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "session/new",
      params: { cwd: "/work" },
    });

    await new Promise((r) => setImmediate(r));

    const sent = upstream.sent[0] as {
      params: {
        agentId?: string;
        _meta: { "hydra-acp": { agentId: string; model: string } };
      };
    };
    expect(sent.params.agentId).toBeUndefined();
    expect(sent.params._meta["hydra-acp"].agentId).toBe("opencode");
    expect(sent.params._meta["hydra-acp"].model).toBe("openai/gpt-5");
  });

  it("re-applies model on every session/new (unlike name, which is first-only)", async () => {
    const upstream = makeControlledStream();
    const downstream = makeControlledStream();
    const tracker = new SessionTracker();

    wireShim({
      opts: { model: "openai/gpt-5" },
      upstream,
      downstream,
      tracker,
    });

    downstream.emitMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "session/new",
      params: { cwd: "/a" },
    });
    downstream.emitMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: { cwd: "/b" },
    });

    await new Promise((r) => setImmediate(r));

    const first = upstream.sent[0] as { params: { _meta?: { "hydra-acp"?: { model?: string } } } };
    const second = upstream.sent[1] as { params: { _meta?: { "hydra-acp"?: { model?: string } } } };
    expect(first.params._meta?.["hydra-acp"]?.model).toBe("openai/gpt-5");
    expect(second.params._meta?.["hydra-acp"]?.model).toBe("openai/gpt-5");
  });

  it("omits model from _meta when opts.model is unset", async () => {
    const upstream = makeControlledStream();
    const downstream = makeControlledStream();
    const tracker = new SessionTracker();

    wireShim({
      opts: { agentId: "opencode" },
      upstream,
      downstream,
      tracker,
    });

    downstream.emitMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "session/new",
      params: { cwd: "/work" },
    });

    await new Promise((r) => setImmediate(r));

    const sent = upstream.sent[0] as {
      params: { _meta?: { "hydra-acp"?: { model?: string } } };
    };
    expect(sent.params._meta?.["hydra-acp"]?.model).toBeUndefined();
  });

  it("only labels the first session/new (first one wins)", async () => {
    const upstream = makeControlledStream();
    const downstream = makeControlledStream();
    const tracker = new SessionTracker();

    wireShim({
      opts: { name: "feature-X" },
      upstream,
      downstream,
      tracker,
    });

    downstream.emitMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "session/new",
      params: { cwd: "/a" },
    });
    downstream.emitMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: { cwd: "/b" },
    });

    await new Promise((r) => setImmediate(r));

    expect(upstream.sent).toHaveLength(2);
    const first = upstream.sent[0] as { params: { _meta?: { "hydra-acp"?: { title?: string } } } };
    const second = upstream.sent[1] as { params: { _meta?: { "hydra-acp"?: { title?: string } } } };
    expect(first.params._meta?.["hydra-acp"]?.title).toBe("feature-X");
    expect(second.params._meta?.["hydra-acp"]?.title).toBeUndefined();
  });

  it("synthesizes a downstream response when daemon resolves a sibling-answered permission", async () => {
    const upstream = makeControlledStream();
    const downstream = makeControlledStream();
    const tracker = new SessionTracker();

    wireShim({ opts: {}, upstream, downstream, tracker });

    // Daemon sends request_permission to this shim — the tracker records it,
    // indexing by toolCallId so the resolve event can be correlated later.
    upstream.emitMessage({
      jsonrpc: "2.0",
      id: "daemon-req-7",
      method: "session/request_permission",
      params: {
        sessionId: "sess_h",
        toolCall: { name: "edit", toolCallId: "tc_7" },
      },
    });
    await new Promise((r) => setImmediate(r));
    expect(downstream.sent).toHaveLength(1);

    // Sibling answers first; daemon now sends session/update with
    // sessionUpdate: "permission_resolved" keyed by toolCallId.
    upstream.emitMessage({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess_h",
        update: {
          sessionUpdate: "permission_resolved",
          toolCallId: "tc_7",
          chosenOptionId: "allow",
          outcome: { kind: "selected", optionId: "allow" },
          resolvedBy: { clientId: "cli_other" },
        },
      },
    });
    await new Promise((r) => setImmediate(r));

    // Downstream should receive both the synthesized response (so its
    // pending request_permission resolves) and the forwarded notification
    // (so any client that wants the metadata still gets it).
    const synthesized = downstream.sent.find(
      (m): m is { jsonrpc: "2.0"; id: string | number; result: unknown } =>
        "id" in m && !("method" in m),
    );
    expect(synthesized).toBeDefined();
    expect(synthesized?.id).toBe("daemon-req-7");
    expect(synthesized?.result).toMatchObject({
      outcome: { kind: "selected", optionId: "allow" },
    });

    const forwardedNotification = downstream.sent.find(
      (m): m is JsonRpcNotification =>
        "method" in m &&
        m.method === "session/update" &&
        (m as { params?: { update?: { sessionUpdate?: string } } }).params
          ?.update?.sessionUpdate === "permission_resolved",
    );
    expect(forwardedNotification).toBeDefined();
  });

  it("falls back to chosenOptionId when the daemon omits outcome", async () => {
    const upstream = makeControlledStream();
    const downstream = makeControlledStream();
    const tracker = new SessionTracker();

    wireShim({ opts: {}, upstream, downstream, tracker });

    upstream.emitMessage({
      jsonrpc: "2.0",
      id: "daemon-req-9",
      method: "session/request_permission",
      params: {
        sessionId: "sess_h",
        toolCall: { name: "edit", toolCallId: "tc_9" },
      },
    });
    await new Promise((r) => setImmediate(r));

    upstream.emitMessage({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess_h",
        update: {
          sessionUpdate: "permission_resolved",
          toolCallId: "tc_9",
          chosenOptionId: "deny",
          resolvedBy: { clientId: "cli_other" },
        },
      },
    });
    await new Promise((r) => setImmediate(r));

    const synthesized = downstream.sent.find(
      (m): m is { jsonrpc: "2.0"; id: string | number; result: unknown } =>
        "id" in m && !("method" in m) && (m as { id?: unknown }).id === "daemon-req-9",
    );
    expect(synthesized?.result).toMatchObject({
      outcome: { kind: "selected", optionId: "deny" },
    });
  });

  it("does not double-respond when downstream already answered the permission", async () => {
    const upstream = makeControlledStream();
    const downstream = makeControlledStream();
    const tracker = new SessionTracker();

    wireShim({ opts: {}, upstream, downstream, tracker });

    upstream.emitMessage({
      jsonrpc: "2.0",
      id: "daemon-req-8",
      method: "session/request_permission",
      params: {
        sessionId: "sess_h",
        toolCall: { name: "edit", toolCallId: "tc_8" },
      },
    });
    await new Promise((r) => setImmediate(r));

    // Downstream answers — tracker should drop its pending entry from
    // both the requestId map AND the toolCallId map.
    downstream.emitMessage({
      jsonrpc: "2.0",
      id: "daemon-req-8",
      result: { outcome: { kind: "selected", optionId: "allow" } },
    });
    await new Promise((r) => setImmediate(r));

    const beforeResolved = downstream.sent.length;

    // A late `permission_resolved` should be a no-op for the downstream
    // (just forwarded as a notification, no second synthesized response).
    upstream.emitMessage({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess_h",
        update: {
          sessionUpdate: "permission_resolved",
          toolCallId: "tc_8",
          chosenOptionId: "allow",
          outcome: { kind: "selected", optionId: "allow" },
          resolvedBy: { clientId: "cli_other" },
        },
      },
    });
    await new Promise((r) => setImmediate(r));

    const newMessages = downstream.sent.slice(beforeResolved);
    const synthesized = newMessages.find(
      (m) => "id" in m && !("method" in m),
    );
    expect(synthesized).toBeUndefined();
    const forwardedNotification = newMessages.find(
      (m): m is JsonRpcNotification =>
        "method" in m &&
        m.method === "session/update" &&
        (m as { params?: { update?: { sessionUpdate?: string } } }).params
          ?.update?.sessionUpdate === "permission_resolved",
    );
    expect(forwardedNotification).toBeDefined();
  });

  it("translates session/new to session/attach in attach mode", async () => {
    const upstream = makeControlledStream();
    const downstream = makeControlledStream();
    const tracker = new SessionTracker();

    wireShim({
      opts: { sessionId: "sess_existing" },
      upstream,
      downstream,
      tracker,
    });

    downstream.emitMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "session/new",
      params: { cwd: "/w" },
    });

    await new Promise((r) => setImmediate(r));

    expect(upstream.sent).toHaveLength(1);
    const sent = upstream.sent[0] as {
      method: string;
      params: { sessionId: string };
    };
    expect(sent.method).toBe("session/attach");
    expect(sent.params).toMatchObject({
      sessionId: "sess_existing",
    });
  });

  it("retries session/prompt with an explicit attach after a SessionNotFound rejection, then succeeds", async () => {
    const upstream = makeControlledStream();
    const downstream = makeControlledStream();
    const tracker = new SessionTracker();

    wireShim({ opts: {}, upstream, downstream, tracker });

    downstream.emitMessage({
      jsonrpc: "2.0",
      id: 42,
      method: "session/prompt",
      params: { sessionId: "sess_stale", prompt: [{ type: "text", text: "hi" }] },
    });
    await tick();

    expect(upstream.sent).toHaveLength(1);
    expect(upstream.sent[0]).toMatchObject({
      id: 42,
      method: "session/prompt",
    });

    // Daemon rejects: this connection was never attached to sess_stale.
    upstream.emitMessage({
      jsonrpc: "2.0",
      id: 42,
      error: {
        code: JsonRpcErrorCodes.SessionNotFound,
        message: "not attached to session",
      },
    });
    await tick();
    await tick();

    // Shim should have issued an explicit attach for that sessionId.
    expect(upstream.sent).toHaveLength(2);
    const attachReq = upstream.sent[1] as JsonRpcRequest;
    expect(attachReq.method).toBe("session/attach");
    expect(attachReq.params).toMatchObject({ sessionId: "sess_stale" });
    expect(downstream.sent).toEqual([]); // not resolved to the client yet

    // Attach succeeds.
    upstream.emitMessage({
      jsonrpc: "2.0",
      id: attachReq.id,
      result: { sessionId: "sess_stale" },
    });
    await tick();
    await tick();

    // Original prompt is retried with the SAME id the client is waiting on.
    expect(upstream.sent).toHaveLength(3);
    expect(upstream.sent[2]).toMatchObject({
      id: 42,
      method: "session/prompt",
    });
    expect(downstream.sent).toEqual([]);

    upstream.emitMessage({
      jsonrpc: "2.0",
      id: 42,
      result: { stopReason: "end_turn" },
    });
    await tick();
    await tick();

    expect(downstream.sent).toHaveLength(1);
    expect(downstream.sent[0]).toEqual({
      jsonrpc: "2.0",
      id: 42,
      result: { stopReason: "end_turn" },
    });
  });

  it("gives up after one retry when the reattach itself fails, without looping", async () => {
    const upstream = makeControlledStream();
    const downstream = makeControlledStream();
    const tracker = new SessionTracker();

    wireShim({ opts: {}, upstream, downstream, tracker });

    downstream.emitMessage({
      jsonrpc: "2.0",
      id: 7,
      method: "session/prompt",
      params: { sessionId: "sess_gone", prompt: [] },
    });
    await tick();

    upstream.emitMessage({
      jsonrpc: "2.0",
      id: 7,
      error: {
        code: JsonRpcErrorCodes.SessionNotFound,
        message: "not attached to session",
      },
    });
    await tick();
    await tick();

    const attachReq = upstream.sent[1] as JsonRpcRequest;
    upstream.emitMessage({
      jsonrpc: "2.0",
      id: attachReq.id,
      error: {
        code: JsonRpcErrorCodes.SessionNotFound,
        message: "session sess_gone not found",
      },
    });
    await tick();
    await tick();

    // No second retry of session/prompt — only the original send plus one attach attempt.
    expect(upstream.sent).toHaveLength(2);
    expect(downstream.sent).toHaveLength(1);
    expect(downstream.sent[0]).toMatchObject({
      id: 7,
      error: { message: "session sess_gone not found" },
    });
  });

  it("leaves a session/prompt that succeeds on the first try untouched", async () => {
    const upstream = makeControlledStream();
    const downstream = makeControlledStream();
    const tracker = new SessionTracker();

    wireShim({ opts: {}, upstream, downstream, tracker });

    downstream.emitMessage({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: { sessionId: "sess_ok", prompt: [] },
    });
    await tick();

    upstream.emitMessage({
      jsonrpc: "2.0",
      id: 3,
      result: { stopReason: "end_turn" },
    });
    await tick();
    await tick();

    expect(upstream.sent).toHaveLength(1);
    expect(downstream.sent).toEqual([
      { jsonrpc: "2.0", id: 3, result: { stopReason: "end_turn" } },
    ]);
  });

  it("cold-watch reattaches once a closed session is observed to go warm again", async () => {
    const upstream = makeControlledStream();
    const downstream = makeControlledStream();
    const tracker = new SessionTracker();
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: "warm" }),
    });

    wireShim({
      opts: {},
      upstream,
      downstream,
      tracker,
      target: fakeTarget,
      coldWatch: { pollMs: 5, fetchImpl },
    });

    upstream.emitMessage({
      jsonrpc: "2.0",
      method: "hydra-acp/session/closed",
      params: { sessionId: "sess_killed" },
    });

    // Wait for at least one poll tick.
    await new Promise((r) => setTimeout(r, 40));
    await tick();

    expect(fetchImpl).toHaveBeenCalled();
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "http://test.invalid/v1/sessions/sess_killed",
    );
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer test-token",
    );

    const attachReq = upstream.sent.find(
      (m): m is JsonRpcRequest =>
        "method" in m && m.method === "session/attach",
    );
    expect(attachReq).toBeDefined();
    expect(attachReq?.params).toMatchObject({ sessionId: "sess_killed" });
  });

  it("cold-watch stops polling once the session 404s (gone for good)", async () => {
    const upstream = makeControlledStream();
    const downstream = makeControlledStream();
    const tracker = new SessionTracker();
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({}),
    });

    wireShim({
      opts: {},
      upstream,
      downstream,
      tracker,
      target: fakeTarget,
      coldWatch: { pollMs: 5, fetchImpl },
    });

    upstream.emitMessage({
      jsonrpc: "2.0",
      method: "hydra-acp/session/closed",
      params: { sessionId: "sess_deleted" },
    });

    await new Promise((r) => setTimeout(r, 20));
    const callsAfterFirstWindow = fetchImpl.mock.calls.length;
    expect(callsAfterFirstWindow).toBeGreaterThanOrEqual(1);

    await new Promise((r) => setTimeout(r, 40));
    // No further calls once the poll has observed a 404 and stopped itself.
    expect(fetchImpl.mock.calls.length).toBe(callsAfterFirstWindow);
  });
});

describe("normaliseInitializeClientInfo", () => {
  const baseReq = (params: Record<string, unknown> = {}): JsonRpcRequest => ({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params,
  });

  it("injects hydra-acp-shim when no clientInfo is set", () => {
    const out = normaliseInitializeClientInfo(baseReq({ protocolVersion: 1 }));
    expect(out.params).toMatchObject({
      protocolVersion: 1,
      clientInfo: { name: "hydra-acp-shim", version: HYDRA_VERSION },
    });
  });

  it("injects hydra-acp-shim when clientInfo is present but name is missing", () => {
    const out = normaliseInitializeClientInfo(
      baseReq({ clientInfo: { title: "Stable" } }),
    );
    expect(out.params).toMatchObject({
      clientInfo: {
        title: "Stable",
        name: "hydra-acp-shim",
        version: HYDRA_VERSION,
      },
    });
  });

  it("passes through clientInfo unchanged when name is a non-empty string", () => {
    const orig = baseReq({
      clientInfo: { name: "zed", version: "0.190.0", title: "Stable" },
    });
    const out = normaliseInitializeClientInfo(orig);
    expect(out).toBe(orig);
  });

  it("injects hydra-acp-shim when clientInfo.name is an empty string", () => {
    const out = normaliseInitializeClientInfo(
      baseReq({ clientInfo: { name: "   " } }),
    );
    expect(out.params).toMatchObject({
      clientInfo: { name: "hydra-acp-shim", version: HYDRA_VERSION },
    });
  });
});

describe("wireShim initialize normalisation", () => {
  it("stamps clientInfo.name=hydra-acp-shim on initialize that lacks it", async () => {
    const upstream = makeControlledStream();
    const downstream = makeControlledStream();
    const tracker = new SessionTracker();

    wireShim({ opts: {}, upstream, downstream, tracker });

    downstream.emitMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1 },
    });

    await new Promise((r) => setImmediate(r));

    expect(upstream.sent).toHaveLength(1);
    const sent = upstream.sent[0] as {
      method: string;
      params: { clientInfo: { name: string; version: string } };
    };
    expect(sent.method).toBe("initialize");
    expect(sent.params.clientInfo).toEqual({
      name: "hydra-acp-shim",
      version: HYDRA_VERSION,
    });
  });

  it("passes a client-provided clientInfo.name through unchanged", async () => {
    const upstream = makeControlledStream();
    const downstream = makeControlledStream();
    const tracker = new SessionTracker();

    wireShim({ opts: {}, upstream, downstream, tracker });

    downstream.emitMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientInfo: { name: "zed", version: "0.190.0", title: "Stable" },
      },
    });

    await new Promise((r) => setImmediate(r));

    expect(upstream.sent).toHaveLength(1);
    const sent = upstream.sent[0] as {
      method: string;
      params: { clientInfo: { name: string; version: string; title: string } };
    };
    expect(sent.params.clientInfo).toEqual({
      name: "zed",
      version: "0.190.0",
      title: "Stable",
    });
  });
});

describe("detachUnpromptedSessions", () => {
  it("sends nothing when there are no unprompted originated sessions", async () => {
    const upstream = makeControlledStream();
    const tracker = new SessionTracker();

    await detachUnpromptedSessions(tracker, upstream, "SIGTERM");

    expect(upstream.sent).toEqual([]);
  });

  it("sends session/detach for a never-prompted session/new'd session", async () => {
    const upstream = makeControlledStream();
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
        sessionId: "sess_probe",
        _meta: {
          "hydra-acp": { upstreamSessionId: "u", agentId: "a", cwd: "/w" },
        },
      },
    });

    await detachUnpromptedSessions(tracker, upstream, "SIGTERM");

    expect(upstream.sent).toHaveLength(1);
    expect(upstream.sent[0]).toMatchObject({
      method: "session/detach",
      params: { sessionId: "sess_probe" },
    });
  });

  it("does not detach a session that was prompted, or one only attached to", async () => {
    const upstream = makeControlledStream();
    const tracker = new SessionTracker();
    // Originated and prompted — must be left alone.
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
        sessionId: "sess_used",
        _meta: {
          "hydra-acp": { upstreamSessionId: "u", agentId: "a", cwd: "/w" },
        },
      },
    });
    tracker.observeFromClient({
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: { sessionId: "sess_used", prompt: [] },
    });
    // Attached (resumed), not originated — not ours to judge.
    tracker.observeFromClient({
      jsonrpc: "2.0",
      id: 3,
      method: "session/attach",
      params: { sessionId: "sess_resumed" },
    });
    tracker.observeFromServer({
      jsonrpc: "2.0",
      id: 3,
      result: {
        sessionId: "sess_resumed",
        _meta: {
          "hydra-acp": { upstreamSessionId: "u2", agentId: "a", cwd: "/w" },
        },
      },
    });

    await detachUnpromptedSessions(tracker, upstream, "SIGTERM");

    expect(upstream.sent).toEqual([]);
  });

  it("sends a detach for every unprompted originated session", async () => {
    const upstream = makeControlledStream();
    const tracker = new SessionTracker();
    for (const [id, sessionId] of [
      [1, "sess_a"],
      [2, "sess_b"],
    ] as const) {
      tracker.observeFromClient({
        jsonrpc: "2.0",
        id,
        method: "session/new",
        params: { cwd: "/w" },
      });
      tracker.observeFromServer({
        jsonrpc: "2.0",
        id,
        result: {
          sessionId,
          _meta: {
            "hydra-acp": { upstreamSessionId: `u_${id}`, agentId: "a", cwd: "/w" },
          },
        },
      });
    }

    await detachUnpromptedSessions(tracker, upstream, "SIGTERM");

    const detachedIds = upstream.sent
      .filter((m): m is JsonRpcRequest => "method" in m && m.method === "session/detach")
      .map((m) => (m.params as { sessionId: string }).sessionId);
    expect(detachedIds.sort()).toEqual(["sess_a", "sess_b"]);
  });

  it("does not hang past its timeout when the send never resolves", async () => {
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
        sessionId: "sess_stuck",
        _meta: {
          "hydra-acp": { upstreamSessionId: "u", agentId: "a", cwd: "/w" },
        },
      },
    });
    const neverResolvingUpstream = {
      send: () => new Promise<void>(() => undefined),
      onMessage: () => undefined,
      onClose: () => undefined,
      close: async () => undefined,
    };

    const start = Date.now();
    await detachUnpromptedSessions(
      tracker,
      neverResolvingUpstream,
      "SIGTERM",
      20,
    );
    expect(Date.now() - start).toBeLessThan(500);
  });
});
