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

// In-memory duplex MessageStream pair — the fake "wire" between our
// registry's dialed peer connection and a fake peer server, and
// between the registry and a fake local client. No real sockets;
// mirrors the pattern acp-ws.test.ts already uses for JsonRpcConnection
// (makeControlledStream), just paired so both ends can talk.
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

// A fake peer daemon: a JsonRpcConnection whose handlers are wired up
// by each test to whatever it needs to assert against. `dial` (passed
// to ForeignSessionRegistry) hands back the *other* end of the pair,
// so requests the registry makes land on `server`'s handlers and
// notifications `server` sends arrive at the registry.
function buildFakePeer(): { server: JsonRpcConnection; dial: Dialer } {
  const [registrySide, serverSide] = linkedPair();
  const server = new JsonRpcConnection(serverSide);
  const dial: Dialer = async () => new JsonRpcConnection(registrySide);
  return { server, dial };
}

function localTarget(): { target: ForwardTarget; stream: ControlledStream } {
  const stream = makeControlledStream();
  const connection = new JsonRpcConnection(stream);
  return { target: { connection, clientId: "local_1" }, stream };
}

describe("ForeignSessionRegistry", () => {
  let store: PeerStore;

  beforeEach(async () => {
    store = await storeWithPeer("peerb");
  });

  it("forwards session/attach and rewraps the sessionId in the response", async () => {
    const { server, dial } = buildFakePeer();
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
    const registry = new ForeignSessionRegistry(store, dial);
    const { target } = localTarget();
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

  it("rejects a second local attach to an already-forwarded session", async () => {
    const { server, dial } = buildFakePeer();
    server.onRequest("session/attach", async (raw) => ({
      sessionId: (raw as { sessionId: string }).sessionId,
    }));
    const registry = new ForeignSessionRegistry(store, dial);
    const { target: t1 } = localTarget();
    await registry.handleLocalMessage(
      { jsonrpc: "2.0", id: 1, method: "session/attach", params: { sessionId: "peerb:abc" } },
      "peerb:abc",
      t1,
    );
    const { target: t2 } = localTarget();
    const res = await registry.handleLocalMessage(
      { jsonrpc: "2.0", id: 2, method: "session/attach", params: { sessionId: "peerb:abc" } },
      "peerb:abc",
      t2,
    );
    expect(res).toMatchObject({
      jsonrpc: "2.0",
      id: 2,
      error: { code: JsonRpcErrorCodes.AlreadyAttached },
    });
  });

  it("forwards session/prompt and session/cancel for an attached session", async () => {
    const { server, dial } = buildFakePeer();
    server.onRequest("session/attach", async (raw) => ({
      sessionId: (raw as { sessionId: string }).sessionId,
    }));
    server.onRequest("session/prompt", async (raw) => ({
      stopReason: "end_turn",
      echoedCwd: (raw as { sessionId: string }).sessionId,
    }));
    server.onRequest("session/cancel", async () => ({}));
    const registry = new ForeignSessionRegistry(store, dial);
    const { target } = localTarget();
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
    const { server, dial } = buildFakePeer();
    server.onRequest("session/prompt", async () => ({}));
    const registry = new ForeignSessionRegistry(store, dial);
    const { target } = localTarget();
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
  });

  it("404s (SessionNotFound) for a name with no registered remote", async () => {
    const { dial } = buildFakePeer();
    const registry = new ForeignSessionRegistry(store, dial);
    const { target } = localTarget();
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
    const { server, dial } = buildFakePeer();
    server.onRequest("session/attach", async (raw) => ({
      sessionId: (raw as { sessionId: string }).sessionId,
    }));
    server.onRequest("session/detach", async () => ({}));
    const registry = new ForeignSessionRegistry(store, dial);
    const { target: t1 } = localTarget();
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

    const { target: t2 } = localTarget();
    const reattach = await registry.handleLocalMessage(
      { jsonrpc: "2.0", id: 3, method: "session/attach", params: { sessionId: "peerb:abc" } },
      "peerb:abc",
      t2,
    );
    expect(reattach).toMatchObject({ jsonrpc: "2.0", id: 3, result: { sessionId: "peerb:abc" } });
  });

  it("relays session/update pushes from the peer with the id rewrapped", async () => {
    const { server, dial } = buildFakePeer();
    server.onRequest("session/attach", async (raw) => ({
      sessionId: (raw as { sessionId: string }).sessionId,
    }));
    const registry = new ForeignSessionRegistry(store, dial);
    const { target, stream } = localTarget();
    await registry.handleLocalMessage(
      { jsonrpc: "2.0", id: 1, method: "session/attach", params: { sessionId: "peerb:abc" } },
      "peerb:abc",
      target,
    );
    await server.notify("session/update", {
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
    const { server, dial } = buildFakePeer();
    server.onRequest("session/attach", async (raw) => ({
      sessionId: (raw as { sessionId: string }).sessionId,
    }));
    const registry = new ForeignSessionRegistry(store, dial);
    const { target, stream } = localTarget();
    await registry.handleLocalMessage(
      { jsonrpc: "2.0", id: 1, method: "session/attach", params: { sessionId: "peerb:abc" } },
      "peerb:abc",
      target,
    );
    await server.notify("hydra-acp/session/closed", { sessionId: "abc" });
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
    const { server, dial } = buildFakePeer();
    server.onRequest("session/attach", async (raw) => ({
      sessionId: (raw as { sessionId: string }).sessionId,
    }));
    const registry = new ForeignSessionRegistry(store, dial);
    const { target, stream } = localTarget();
    await registry.handleLocalMessage(
      { jsonrpc: "2.0", id: 1, method: "session/attach", params: { sessionId: "peerb:abc" } },
      "peerb:abc",
      target,
    );

    const permissionPromise = server.request("hydra-acp/session/request_permission", {
      sessionId: "abc",
      toolCall: { toolCallId: "tc1" },
      options: [{ optionId: "allow", kind: "allow_once" }],
    });

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

  it("abstains (MethodNotFound) from a permission request when nothing local is attached", async () => {
    const { server, dial } = buildFakePeer();
    server.onRequest("session/prompt", async () => ({}));
    const registry = new ForeignSessionRegistry(store, dial);
    const { target } = localTarget();
    // Dial the peer without attaching anything (this call itself
    // 404s — the session isn't attached — but it establishes the
    // PeerLink as a side effect, same as a real forward attempt would).
    await registry.handleLocalMessage(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "session/prompt",
        params: { sessionId: "peerb:abc", prompt: [] },
      },
      "peerb:abc",
      target,
    );
    await expect(
      server.request("hydra-acp/session/request_permission", { sessionId: "abc" }),
    ).rejects.toMatchObject({ code: JsonRpcErrorCodes.MethodNotFound });
  });

  it("notifies attached targets and clears bookkeeping when the peer connection drops", async () => {
    const { server, dial } = buildFakePeer();
    server.onRequest("session/attach", async (raw) => ({
      sessionId: (raw as { sessionId: string }).sessionId,
    }));
    const registry = new ForeignSessionRegistry(store, dial);
    const { target, stream } = localTarget();
    await registry.handleLocalMessage(
      { jsonrpc: "2.0", id: 1, method: "session/attach", params: { sessionId: "peerb:abc" } },
      "peerb:abc",
      target,
    );

    await server.close();

    const relayed = stream.sent.find(
      (m) => "method" in m && m.method === "hydra-acp/session/closed",
    );
    expect(relayed).toMatchObject({ params: { sessionId: "peerb:abc" } });
  });

  it("detachClient forgets every session that connection was attached to and notifies the peer", async () => {
    const { server, dial } = buildFakePeer();
    let detachedSessionIds: string[] = [];
    server.onRequest("session/attach", async (raw) => ({
      sessionId: (raw as { sessionId: string }).sessionId,
    }));
    server.onRequest("session/detach", async (raw) => {
      detachedSessionIds.push((raw as { sessionId: string }).sessionId);
      return {};
    });
    const registry = new ForeignSessionRegistry(store, dial);
    const { target } = localTarget();
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
});
