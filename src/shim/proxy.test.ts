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

  it("injects name and agentArgs under _meta.acp-hydra on first session/new", async () => {
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
        _meta: { "acp-hydra": { name: string; agentArgs: string[] } };
      };
    };
    expect(sent.params.agentId).toBe("codex-acp");
    expect(sent.params._meta["acp-hydra"]).toEqual({
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
    const first = upstream.sent[0] as { params: { _meta?: { "acp-hydra"?: { name?: string } } } };
    const second = upstream.sent[1] as { params: { _meta?: { "acp-hydra"?: { name?: string } } } };
    expect(first.params._meta?.["acp-hydra"]?.name).toBe("feature-X");
    expect(second.params._meta?.["acp-hydra"]?.name).toBeUndefined();
  });

  it("translates session/new to session/attach in attach mode", async () => {
    const upstream = makeControlledStream();
    const downstream = makeControlledStream();
    const tracker = new SessionTracker();

    wireShim({
      opts: { sessionId: "sess_existing", role: "observer" },
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
      params: { sessionId: string; role: string };
    };
    expect(sent.method).toBe("session/attach");
    expect(sent.params).toMatchObject({
      sessionId: "sess_existing",
      role: "observer",
    });
  });
});
