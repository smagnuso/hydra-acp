import { describe, it, expect, beforeEach } from "vitest";
import { JsonRpcConnection } from "../acp/connection.js";
import type { MessageStream } from "../acp/framing.js";
import { JsonRpcErrorCodes, type JsonRpcMessage } from "../acp/types.js";
import { makeControlledStream, type ControlledStream } from "../__tests__/test-utils.js";
import { PeerStore } from "../core/peer-store.js";
import {
  ForeignSessionRegistry,
  type Dialer,
  type ForwardTarget,
} from "./acp-forward.js";

// In-memory duplex MessageStream pair — the fake "wire" for one
// dial()'d connection between the registry and a fake peer server, and
// separately between the registry and a fake local client. No real
// sockets; mirrors the pattern acp-ws.test.ts already uses for
// JsonRpcConnection (makeControlledStream), just paired so both ends
// can talk.
function linkedPair(): [MessageStream, MessageStream] {
  const aMsg: Array<(m: JsonRpcMessage) => void> = [];
  const bMsg: Array<(m: JsonRpcMessage) => void> = [];
  const aClose: Array<(err?: Error) => void> = [];
  const bClose: Array<(err?: Error) => void> = [];
  let closed = false;
  const a: MessageStream = {
    async send(m) {
      if (!closed) for (const h of bMsg) h(m);
    },
    onMessage(h) {
      aMsg.push(h);
    },
    onClose(h) {
      aClose.push(h);
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const h of aClose) h();
      for (const h of bClose) h();
    },
  };
  const b: MessageStream = {
    async send(m) {
      if (!closed) for (const h of aMsg) h(m);
    },
    onMessage(h) {
      bMsg.push(h);
    },
    onClose(h) {
      bClose.push(h);
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const h of aClose) h();
      for (const h of bClose) h();
    },
  };
  return [a, b];
}

function future(deltaMs = 60_000): string {
  return new Date(Date.now() + deltaMs).toISOString();
}

async function storeWithPeer(name: string): Promise<PeerStore> {
  const store = await PeerStore.load();
  await store.set({
    name,
    host: "peer.example.com",
    port: 55514,
    token: "tok",
    expiresAt: future(),
    addedAt: new Date().toISOString(),
  });
  return store;
}

// A fake peer daemon. Every dial() call gets its own fresh linked pair
// and its own server-side JsonRpcConnection — mirroring how the real
// registry now opens one dedicated upstream connection per local
// attach rather than sharing one per peer. `onEachServer` registers a
// handler-installer that runs against every server connection ever
// created (past and future callers just re-run it per new dial), and
// `servers` exposes them in dial order for tests that need to push a
// notification/request on one specific attach's connection.
interface FakePeer {
  dial: Dialer;
  servers: JsonRpcConnection[];
  onEachServer(setup: (server: JsonRpcConnection) => void): void;
}

function buildFakePeer(): FakePeer {
  const servers: JsonRpcConnection[] = [];
  const setups: Array<(server: JsonRpcConnection) => void> = [];
  const dial: Dialer = async () => {
    const [registrySide, serverSide] = linkedPair();
    const server = new JsonRpcConnection(serverSide);
    servers.push(server);
    for (const setup of setups) {
      setup(server);
    }
    return new JsonRpcConnection(registrySide);
  };
  return {
    dial,
    servers,
    onEachServer(setup) {
      setups.push(setup);
    },
  };
}

// Every fake peer in these tests answers session/attach the same
// trivial way (echo the id back); shared so individual tests only
// need to register the handlers relevant to what they're checking.
function withEchoAttach(peer: FakePeer): void {
  peer.onEachServer((server) => {
    server.onRequest("session/attach", async (raw) => ({
      sessionId: (raw as { sessionId: string }).sessionId,
    }));
  });
}

function localTarget(clientId: string): { target: ForwardTarget; stream: ControlledStream } {
  const stream = makeControlledStream();
  const connection = new JsonRpcConnection(stream);
  return { target: { connection, clientId }, stream };
}

describe("ForeignSessionRegistry", () => {
  let store: PeerStore;

  beforeEach(async () => {
    store = await storeWithPeer("peerb");
  });

  it("forwards session/attach and rewraps the sessionId in the response", async () => {
    const peer = buildFakePeer();
    peer.onEachServer((server) => {
      server.onRequest("session/attach", async (raw) => {
        const p = raw as { sessionId: string };
        return {
          sessionId: p.sessionId,
          clientId: "peer_client_1",
          connectedClients: ["peer_client_1"],
          historyPolicy: "full",
          replayed: 0,
        };
      });
    });
    const registry = new ForeignSessionRegistry(store, peer.dial);
    const { target } = localTarget("local_1");
    const res = await registry.handleLocalMessage(
      { jsonrpc: "2.0", id: 1, method: "session/attach", params: { sessionId: "peerb:abc" } },
      "peerb:abc",
      target,
    );
    expect(res).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { sessionId: "peerb:abc", clientId: "peer_client_1" },
    });
  });

  it("two local clients attaching the same foreign session each get their own dedicated upstream connection", async () => {
    const peer = buildFakePeer();
    withEchoAttach(peer);
    const registry = new ForeignSessionRegistry(store, peer.dial);
    const { target: t1 } = localTarget("local_1");
    const { target: t2 } = localTarget("local_2");
    const res1 = await registry.handleLocalMessage(
      { jsonrpc: "2.0", id: 1, method: "session/attach", params: { sessionId: "peerb:abc" } },
      "peerb:abc",
      t1,
    );
    const res2 = await registry.handleLocalMessage(
      { jsonrpc: "2.0", id: 2, method: "session/attach", params: { sessionId: "peerb:abc" } },
      "peerb:abc",
      t2,
    );
    // Neither attach is rejected, and the peer sees two independent
    // attaching connections — proven by there being two server-side
    // connections at all.
    expect(res1).toMatchObject({ result: { sessionId: "peerb:abc" } });
    expect(res2).toMatchObject({ result: { sessionId: "peerb:abc" } });
    expect(peer.servers).toHaveLength(2);
  });

  it("fans out a peer-broadcast permission request to each attached local target independently", async () => {
    // Mirrors what a real peer does: Session.handlePermissionRequest
    // broadcasts the same request to every attached client — which,
    // from the peer's point of view, now includes both of our
    // dedicated connections. Each must relay only to the local target
    // it belongs to.
    const peer = buildFakePeer();
    withEchoAttach(peer);
    const registry = new ForeignSessionRegistry(store, peer.dial);
    const { target: t1, stream: s1 } = localTarget("local_1");
    const { target: t2, stream: s2 } = localTarget("local_2");
    await registry.handleLocalMessage(
      { jsonrpc: "2.0", id: 1, method: "session/attach", params: { sessionId: "peerb:abc" } },
      "peerb:abc",
      t1,
    );
    await registry.handleLocalMessage(
      { jsonrpc: "2.0", id: 2, method: "session/attach", params: { sessionId: "peerb:abc" } },
      "peerb:abc",
      t2,
    );

    const [serverForT1, serverForT2] = peer.servers;
    const p1 = serverForT1!.request("hydra-acp/session/request_permission", {
      sessionId: "abc",
      toolCall: { toolCallId: "tc1" },
    });
    const p2 = serverForT2!.request("hydra-acp/session/request_permission", {
      sessionId: "abc",
      toolCall: { toolCallId: "tc1" },
    });

    const forwardedTo1 = s1.sent.find(
      (m) => "method" in m && m.method === "hydra-acp/session/request_permission",
    ) as { id: number | string } | undefined;
    const forwardedTo2 = s2.sent.find(
      (m) => "method" in m && m.method === "hydra-acp/session/request_permission",
    ) as { id: number | string } | undefined;
    expect(forwardedTo1).toBeDefined();
    expect(forwardedTo2).toBeDefined();

    s1.emitMessage({
      jsonrpc: "2.0",
      id: forwardedTo1!.id,
      result: { outcome: { outcome: "selected", optionId: "allow" } },
    });
    s2.emitMessage({
      jsonrpc: "2.0",
      id: forwardedTo2!.id,
      result: { outcome: { outcome: "cancelled" } },
    });

    await expect(p1).resolves.toMatchObject({ outcome: { optionId: "allow" } });
    await expect(p2).resolves.toMatchObject({ outcome: { outcome: "cancelled" } });
  });

  it("detaching one local client's attachment doesn't affect another's on the same foreign session", async () => {
    const peer = buildFakePeer();
    withEchoAttach(peer);
    peer.onEachServer((server) => {
      server.onRequest("session/detach", async () => ({}));
      server.onRequest("session/prompt", async () => ({ stopReason: "end_turn" }));
    });
    const registry = new ForeignSessionRegistry(store, peer.dial);
    const { target: t1 } = localTarget("local_1");
    const { target: t2 } = localTarget("local_2");
    await registry.handleLocalMessage(
      { jsonrpc: "2.0", id: 1, method: "session/attach", params: { sessionId: "peerb:abc" } },
      "peerb:abc",
      t1,
    );
    await registry.handleLocalMessage(
      { jsonrpc: "2.0", id: 2, method: "session/attach", params: { sessionId: "peerb:abc" } },
      "peerb:abc",
      t2,
    );

    const detachRes = await registry.handleLocalMessage(
      { jsonrpc: "2.0", id: 3, method: "session/detach", params: { sessionId: "peerb:abc" } },
      "peerb:abc",
      t1,
    );
    expect(detachRes).toMatchObject({ jsonrpc: "2.0", id: 3, result: {} });

    // t1 is gone; t2's independent attachment still works.
    const promptForT1 = await registry.handleLocalMessage(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "session/prompt",
        params: { sessionId: "peerb:abc", prompt: [] },
      },
      "peerb:abc",
      t1,
    );
    expect(promptForT1).toMatchObject({ error: { code: JsonRpcErrorCodes.SessionNotFound } });

    const promptForT2 = await registry.handleLocalMessage(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "session/prompt",
        params: { sessionId: "peerb:abc", prompt: [] },
      },
      "peerb:abc",
      t2,
    );
    expect(promptForT2).toMatchObject({ jsonrpc: "2.0", id: 5, result: { stopReason: "end_turn" } });
  });

  it("re-attaching the same (client, session) pair replaces the prior dedicated connection", async () => {
    const peer = buildFakePeer();
    withEchoAttach(peer);
    const registry = new ForeignSessionRegistry(store, peer.dial);
    const { target } = localTarget("local_1");
    await registry.handleLocalMessage(
      { jsonrpc: "2.0", id: 1, method: "session/attach", params: { sessionId: "peerb:abc" } },
      "peerb:abc",
      target,
    );
    await registry.handleLocalMessage(
      { jsonrpc: "2.0", id: 2, method: "session/attach", params: { sessionId: "peerb:abc" } },
      "peerb:abc",
      target,
    );
    expect(peer.servers).toHaveLength(2);
    // Give the fire-and-forget close of the stale connection a tick.
    await new Promise((r) => setTimeout(r, 0));
    expect(peer.servers[0]!.isClosed()).toBe(true);
    expect(peer.servers[1]!.isClosed()).toBe(false);
  });

  it("forwards session/prompt and session/cancel for an attached session", async () => {
    const peer = buildFakePeer();
    withEchoAttach(peer);
    peer.onEachServer((server) => {
      server.onRequest("session/prompt", async (raw) => ({
        stopReason: "end_turn",
        echoedCwd: (raw as { sessionId: string }).sessionId,
      }));
      server.onRequest("session/cancel", async () => ({}));
    });
    const registry = new ForeignSessionRegistry(store, peer.dial);
    const { target } = localTarget("local_1");
    await registry.handleLocalMessage(
      { jsonrpc: "2.0", id: 1, method: "session/attach", params: { sessionId: "peerb:abc" } },
      "peerb:abc",
      target,
    );
    const prompt = await registry.handleLocalMessage(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "session/prompt",
        params: { sessionId: "peerb:abc", prompt: [] },
      },
      "peerb:abc",
      target,
    );
    // The peer sees the unwrapped local id, not the "peerb:" prefix.
    expect(prompt).toMatchObject({ result: { echoedCwd: "abc" } });
    const cancel = await registry.handleLocalMessage(
      { jsonrpc: "2.0", id: 3, method: "session/cancel", params: { sessionId: "peerb:abc" } },
      "peerb:abc",
      target,
    );
    expect(cancel).toMatchObject({ jsonrpc: "2.0", id: 3, result: {} });
  });

  it("session/prompt to a session that was never attached returns SessionNotFound", async () => {
    const peer = buildFakePeer();
    const registry = new ForeignSessionRegistry(store, peer.dial);
    const { target } = localTarget("local_1");
    const res = await registry.handleLocalMessage(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "session/prompt",
        params: { sessionId: "peerb:abc", prompt: [] },
      },
      "peerb:abc",
      target,
    );
    expect(res).toMatchObject({
      error: { code: JsonRpcErrorCodes.SessionNotFound },
    });
    // Never attached — no connection should have been dialed at all.
    expect(peer.servers).toHaveLength(0);
  });

  it("404s (SessionNotFound) for a name with no registered remote", async () => {
    const peer = buildFakePeer();
    const registry = new ForeignSessionRegistry(store, peer.dial);
    const { target } = localTarget("local_1");
    const res = await registry.handleLocalMessage(
      { jsonrpc: "2.0", id: 1, method: "session/attach", params: { sessionId: "nope:abc" } },
      "nope:abc",
      target,
    );
    expect(res).toMatchObject({
      error: { code: JsonRpcErrorCodes.SessionNotFound },
    });
  });

  it("detach forwards upstream, clears the registration, and allows a fresh attach", async () => {
    const peer = buildFakePeer();
    withEchoAttach(peer);
    peer.onEachServer((server) => {
      server.onRequest("session/detach", async () => ({}));
    });
    const registry = new ForeignSessionRegistry(store, peer.dial);
    const { target: t1 } = localTarget("local_1");
    await registry.handleLocalMessage(
      { jsonrpc: "2.0", id: 1, method: "session/attach", params: { sessionId: "peerb:abc" } },
      "peerb:abc",
      t1,
    );
    const detachRes = await registry.handleLocalMessage(
      { jsonrpc: "2.0", id: 2, method: "session/detach", params: { sessionId: "peerb:abc" } },
      "peerb:abc",
      t1,
    );
    expect(detachRes).toMatchObject({ jsonrpc: "2.0", id: 2, result: {} });

    const { target: t2 } = localTarget("local_2");
    const reattach = await registry.handleLocalMessage(
      { jsonrpc: "2.0", id: 3, method: "session/attach", params: { sessionId: "peerb:abc" } },
      "peerb:abc",
      t2,
    );
    expect(reattach).toMatchObject({ jsonrpc: "2.0", id: 3, result: { sessionId: "peerb:abc" } });
  });

  it("relays session/update pushes from the peer with the id rewrapped", async () => {
    const peer = buildFakePeer();
    withEchoAttach(peer);
    const registry = new ForeignSessionRegistry(store, peer.dial);
    const { target, stream } = localTarget("local_1");
    await registry.handleLocalMessage(
      { jsonrpc: "2.0", id: 1, method: "session/attach", params: { sessionId: "peerb:abc" } },
      "peerb:abc",
      target,
    );
    await peer.servers[0]!.notify("session/update", {
      sessionId: "abc",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } },
    });
    const relayed = stream.sent.find(
      (m) => "method" in m && m.method === "session/update",
    );
    expect(relayed).toMatchObject({
      method: "session/update",
      params: { sessionId: "peerb:abc" },
    });
  });

  it("relays hydra-acp/session/closed from the peer and clears the registration", async () => {
    const peer = buildFakePeer();
    withEchoAttach(peer);
    const registry = new ForeignSessionRegistry(store, peer.dial);
    const { target, stream } = localTarget("local_1");
    await registry.handleLocalMessage(
      { jsonrpc: "2.0", id: 1, method: "session/attach", params: { sessionId: "peerb:abc" } },
      "peerb:abc",
      target,
    );
    await peer.servers[0]!.notify("hydra-acp/session/closed", { sessionId: "abc" });
    const relayed = stream.sent.find(
      (m) => "method" in m && m.method === "hydra-acp/session/closed",
    );
    expect(relayed).toMatchObject({ params: { sessionId: "peerb:abc" } });

    // Cleared — session/prompt against it now 404s instead of forwarding.
    const prompt = await registry.handleLocalMessage(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "session/prompt",
        params: { sessionId: "peerb:abc", prompt: [] },
      },
      "peerb:abc",
      target,
    );
    expect(prompt).toMatchObject({ error: { code: JsonRpcErrorCodes.SessionNotFound } });
  });

  it("relays a permission request from the peer to the local target and returns its answer", async () => {
    const peer = buildFakePeer();
    withEchoAttach(peer);
    const registry = new ForeignSessionRegistry(store, peer.dial);
    const { target, stream } = localTarget("local_1");
    await registry.handleLocalMessage(
      { jsonrpc: "2.0", id: 1, method: "session/attach", params: { sessionId: "peerb:abc" } },
      "peerb:abc",
      target,
    );

    const permissionPromise = peer.servers[0]!.request(
      "hydra-acp/session/request_permission",
      {
        sessionId: "abc",
        toolCall: { toolCallId: "tc1" },
        options: [{ optionId: "allow", kind: "allow_once" }],
      },
    );

    // The local client "answers" by responding to whatever request it
    // just received, same as a real client would.
    const forwarded = stream.sent.find(
      (m) => "method" in m && m.method === "hydra-acp/session/request_permission",
    ) as { id: number | string } | undefined;
    expect(forwarded).toBeDefined();
    stream.emitMessage({
      jsonrpc: "2.0",
      id: forwarded!.id,
      result: { outcome: { outcome: "selected", optionId: "allow" } },
    });

    const answer = await permissionPromise;
    expect(answer).toMatchObject({ outcome: { outcome: "selected", optionId: "allow" } });
  });

  it("abstains (MethodNotFound) if the peer ever sends a permission request for the wrong sessionId on a dedicated connection", async () => {
    // Defense in depth: each dedicated connection is 1:1 with exactly
    // one attached localId, so this should never legitimately happen —
    // but if a misbehaving peer did it, we must not misroute the
    // request to the wrong local target.
    const peer = buildFakePeer();
    withEchoAttach(peer);
    const registry = new ForeignSessionRegistry(store, peer.dial);
    const { target } = localTarget("local_1");
    await registry.handleLocalMessage(
      { jsonrpc: "2.0", id: 1, method: "session/attach", params: { sessionId: "peerb:abc" } },
      "peerb:abc",
      target,
    );
    await expect(
      peer.servers[0]!.request("hydra-acp/session/request_permission", {
        sessionId: "some-other-session",
      }),
    ).rejects.toMatchObject({ code: JsonRpcErrorCodes.MethodNotFound });
  });

  it("notifies the attached target and clears bookkeeping when its dedicated peer connection drops", async () => {
    const peer = buildFakePeer();
    withEchoAttach(peer);
    const registry = new ForeignSessionRegistry(store, peer.dial);
    const { target, stream } = localTarget("local_1");
    await registry.handleLocalMessage(
      { jsonrpc: "2.0", id: 1, method: "session/attach", params: { sessionId: "peerb:abc" } },
      "peerb:abc",
      target,
    );

    await peer.servers[0]!.close();

    const relayed = stream.sent.find(
      (m) => "method" in m && m.method === "hydra-acp/session/closed",
    );
    expect(relayed).toMatchObject({ params: { sessionId: "peerb:abc" } });
  });

  it("detachClient forgets every attachment that connection owned and notifies the peer", async () => {
    const peer = buildFakePeer();
    withEchoAttach(peer);
    const detachedSessionIds: string[] = [];
    peer.onEachServer((server) => {
      server.onRequest("session/detach", async (raw) => {
        detachedSessionIds.push((raw as { sessionId: string }).sessionId);
        return {};
      });
    });
    const registry = new ForeignSessionRegistry(store, peer.dial);
    const { target } = localTarget("local_1");
    await registry.handleLocalMessage(
      { jsonrpc: "2.0", id: 1, method: "session/attach", params: { sessionId: "peerb:abc" } },
      "peerb:abc",
      target,
    );
    registry.detachClient(target.clientId);
    // Give the fire-and-forget upstream detach a tick to land.
    await new Promise((r) => setTimeout(r, 0));
    expect(detachedSessionIds).toContain("abc");

    const promptAfter = await registry.handleLocalMessage(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "session/prompt",
        params: { sessionId: "peerb:abc", prompt: [] },
      },
      "peerb:abc",
      target,
    );
    expect(promptAfter).toMatchObject({ error: { code: JsonRpcErrorCodes.SessionNotFound } });
  });

  it("detachClient only tears down attachments belonging to that client, leaving another's alone", async () => {
    const peer = buildFakePeer();
    withEchoAttach(peer);
    peer.onEachServer((server) => {
      server.onRequest("session/detach", async () => ({}));
      server.onRequest("session/prompt", async () => ({ stopReason: "end_turn" }));
    });
    const registry = new ForeignSessionRegistry(store, peer.dial);
    const { target: t1 } = localTarget("local_1");
    const { target: t2 } = localTarget("local_2");
    await registry.handleLocalMessage(
      { jsonrpc: "2.0", id: 1, method: "session/attach", params: { sessionId: "peerb:abc" } },
      "peerb:abc",
      t1,
    );
    await registry.handleLocalMessage(
      { jsonrpc: "2.0", id: 2, method: "session/attach", params: { sessionId: "peerb:abc" } },
      "peerb:abc",
      t2,
    );

    registry.detachClient(t1.clientId);
    await new Promise((r) => setTimeout(r, 0));

    const promptForT2 = await registry.handleLocalMessage(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "session/prompt",
        params: { sessionId: "peerb:abc", prompt: [] },
      },
      "peerb:abc",
      t2,
    );
    expect(promptForT2).toMatchObject({ jsonrpc: "2.0", id: 3, result: { stopReason: "end_turn" } });
  });
});
