import { describe, it, expect } from "vitest";
import { wireShim } from "./proxy.js";
import { SessionTracker } from "./session-tracker.js";
import { makeControlledStream } from "../__tests__/test-utils.js";

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

  it("rewrites session/new with agentId in launcher mode", async () => {
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
    const sent = upstream.sent[0] as { params: { cwd: string; agentId: string } };
    expect(sent.params).toMatchObject({ cwd: "/work", agentId: "claude-acp" });
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
        agentId: string;
        _meta: { "hydra-acp": { name: string; agentArgs: string[] } };
      };
    };
    expect(sent.params.agentId).toBe("codex-acp");
    expect(sent.params._meta["hydra-acp"]).toEqual({
      agentArgs: ["-c", "sandbox_mode=danger-full-access"],
      name: "feature-X",
    });
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
    const first = upstream.sent[0] as { params: { _meta?: { "hydra-acp"?: { name?: string } } } };
    const second = upstream.sent[1] as { params: { _meta?: { "hydra-acp"?: { name?: string } } } };
    expect(first.params._meta?.["hydra-acp"]?.name).toBe("feature-X");
    expect(second.params._meta?.["hydra-acp"]?.name).toBeUndefined();
  });

  it("synthesizes a downstream response when daemon resolves a sibling-answered permission", async () => {
    const upstream = makeControlledStream();
    const downstream = makeControlledStream();
    const tracker = new SessionTracker();

    wireShim({ opts: {}, upstream, downstream, tracker });

    // Daemon sends request_permission to this shim — the tracker records it.
    upstream.emitMessage({
      jsonrpc: "2.0",
      id: "daemon-req-7",
      method: "session/request_permission",
      params: { sessionId: "sess_h", toolCall: { name: "edit" } },
    });
    await new Promise((r) => setImmediate(r));
    expect(downstream.sent).toHaveLength(1);

    // Sibling answers first; daemon now sends permission_resolved
    // carrying *this* shim's requestId.
    upstream.emitMessage({
      jsonrpc: "2.0",
      method: "session/permission_resolved",
      params: {
        sessionId: "sess_h",
        toolCall: { name: "edit" },
        requestId: "daemon-req-7",
        resolvedBy: "cli_other",
        result: { outcome: { kind: "allow", optionId: "allow" } },
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
      outcome: { kind: "allow", optionId: "allow" },
    });

    const forwardedNotification = downstream.sent.find(
      (m) => "method" in m && m.method === "session/permission_resolved",
    );
    expect(forwardedNotification).toBeDefined();
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
      params: { sessionId: "sess_h", toolCall: { name: "edit" } },
    });
    await new Promise((r) => setImmediate(r));

    // Downstream answers — tracker should drop its pending entry.
    downstream.emitMessage({
      jsonrpc: "2.0",
      id: "daemon-req-8",
      result: { outcome: { kind: "allow", optionId: "allow" } },
    });
    await new Promise((r) => setImmediate(r));

    const beforeResolved = downstream.sent.length;

    // A late `permission_resolved` should be a no-op for the downstream
    // (just forwarded as a notification, no second synthesized response).
    upstream.emitMessage({
      jsonrpc: "2.0",
      method: "session/permission_resolved",
      params: {
        sessionId: "sess_h",
        requestId: "daemon-req-8",
        resolvedBy: "cli_other",
        result: { outcome: { kind: "allow", optionId: "allow" } },
      },
    });
    await new Promise((r) => setImmediate(r));

    const newMessages = downstream.sent.slice(beforeResolved);
    const synthesized = newMessages.find(
      (m) => "id" in m && !("method" in m),
    );
    expect(synthesized).toBeUndefined();
    const forwardedNotification = newMessages.find(
      (m) => "method" in m && m.method === "session/permission_resolved",
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
});
