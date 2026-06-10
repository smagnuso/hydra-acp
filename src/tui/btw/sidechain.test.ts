import { describe, expect, it, afterEach } from "vitest";
import { makeControlledStream, type ControlledStream } from "../../__tests__/test-utils.js";
import type { JsonRpcRequest } from "../../acp/types.js";
import { runBtwSidechain, type SidechainEventEmitter } from "./sidechain.js";

// Deliberately NOT the real daemon port: every test injects a fake fetch
// and a controlled stream, but if one ever forgot to, we must not reach a live daemon.
import type { RemoteTarget } from "../../core/remote-target.js";

const target: RemoteTarget = {
  baseUrl: "http://127.0.0.1:1",
  wsUrl: "ws://127.0.0.1:1/acp",
  token: "tok",
  display: "test",
  isLocal: true,
};

// Track fetch calls so tests can assert on HTTP behaviour.
const fetchCalls: Array<{ url: string; method?: string; body?: unknown }> = [];

function fakeFetch(
  forkResponses: Record<string, { sessionId: string; forkedFromSessionId: string; forkedAt: string }>,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    let body: unknown;
    if (init?.body) {
      try {
        body = JSON.parse(init.body as string);
      } catch {
        // ignore
      }
    }
    fetchCalls.push({ url, method, body });

    if (url.includes("/fork")) {
      const match = url.match(/\/sessions\/([^/]+)\/fork$/);
      const sourceId = match ? decodeURIComponent(match[1] ?? "") : "";
      const resp = forkResponses[sourceId];
      if (!resp) {
        return new Response(
          JSON.stringify({ error: `source session ${sourceId} not found` }),
          { status: 404 },
        );
      }
      return new Response(JSON.stringify(resp), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (url.includes("/kill")) {
      return new Response(null, { status: 204 });
    }

    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

// Build a test harness: controlled stream that the sidechain uses instead of
// a real WebSocket. The stream tracks sent messages and lets the test emit
// daemon responses at will.
//
// Auto-acks the two handshake requests runBtwSidechain makes before handing
// the emitter to the caller (`initialize` and `session/attach`). Without
// this, every test would hang on session/attach until the vitest timeout.
function makeHarness() {
  const stream = makeControlledStream();
  const origSend = stream.send.bind(stream);
  stream.send = async (msg) => {
    await origSend(msg);
    if (
      typeof msg === "object" &&
      msg !== null &&
      "method" in msg &&
      "id" in msg &&
      (msg as { id: unknown }).id !== undefined
    ) {
      const method = (msg as { method: unknown }).method;
      if (method === "initialize" || method === "session/attach") {
        const id = (msg as { id: string | number }).id;
        queueMicrotask(() => {
          stream.emitMessage({
            jsonrpc: "2.0",
            id,
            result: method === "initialize" ? { protocolVersion: 1, agentCapabilities: {} } : {},
          });
        });
      }
    }
  };
  return {
    stream,
    get sent(): unknown[] {
      return stream.sent;
    },
  };
}

// Extract a JSON-RPC request from the sent messages by method.
function findRequest(sent: unknown[], method: string): JsonRpcRequest | undefined {
  return sent.find(
    (m): m is JsonRpcRequest =>
      typeof m === "object" &&
      m !== null &&
      "method" in m &&
      "id" in m &&
      (m as { id: unknown }).id !== undefined &&
      typeof (m as { id: unknown }).id !== "symbol" &&
      (m as { method: unknown }).method === method,
  );
}

// Collect emitted events until a terminal event arrives.
function collectEvents(emitter: SidechainEventEmitter): Promise<unknown[]> {
  return new Promise((resolve) => {
    const events: unknown[] = [];
    const doneHandler = (event: unknown) => {
      events.push(event);
      if (
        typeof event === "object" &&
        event !== null &&
        "kind" in event &&
        ["completed", "cancelled", "errored"].includes((event as { kind: string }).kind)
      ) {
        emitter.off("event", doneHandler);
        resolve(events);
      }
    };
    emitter.on("event", doneHandler);
  });
}

// Helper to kick the event loop so async code inside runBtwSidechain can run.
// This is needed because runBtwSidechain returns a Promise whose IIFE runs on
// microtasks, and we need those microtasks to execute before we check harness.sent.
async function tick(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

// Wait until a JSON-RPC request with the given method has been sent through
// the stream. session/prompt is sent from a setImmediate inside the sidechain,
// so callers need to yield until the request actually appears in `sent`.
async function waitForRequest(
  harness: { sent: unknown[] },
  method: string,
): Promise<JsonRpcRequest> {
  for (let i = 0; i < 50; i++) {
    const req = findRequest(harness.sent, method);
    if (req) return req;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`request ${method} was never sent`);
}

// Respond to an in-flight request with a JSON-RPC result frame.
function respondResult(
  harness: { stream: ControlledStream },
  req: JsonRpcRequest,
  result: unknown,
): void {
  harness.stream.emitMessage({ jsonrpc: "2.0", id: req.id, result });
}

// Respond to an in-flight request with a JSON-RPC error frame.
function respondError(
  harness: { stream: ControlledStream },
  req: JsonRpcRequest,
  message: string,
): void {
  harness.stream.emitMessage({
    jsonrpc: "2.0",
    id: req.id,
    error: { code: -32000, message },
  });
}

describe("runBtwSidechain", () => {
  afterEach(() => {
    fetchCalls.length = 0;
  });

  describe("happy path", () => {
    it("forks, attaches, sends prompt, emits updates, and completes", async () => {
      const harness = makeHarness();

      const fetchImpl = fakeFetch({
        "src-1": {
          sessionId: "forked-1",
          forkedFromSessionId: "src-1",
          forkedAt: "2025-01-01T00:00:00Z",
        },
      });

      // Start the sidechain (returns a Promise whose IIFE runs on microtasks).
      const result = runBtwSidechain(target, "src-1", "hello world", {
        fetchImpl,
        _streamFactory: () => Promise.resolve(harness.stream),
      });

      // Yield to let the sidechain's async IIFE send initialize().
      await tick();

      // Respond to initialize so it doesn't hang.
      const initReq = findRequest(harness.sent, "initialize");
      if (initReq) {
        harness.stream.emitMessage({
          jsonrpc: "2.0",
          id: initReq.id,
          result: { protocolVersion: 1, agentCapabilities: {} },
        });
      }

      // Yield again to let the sidechain proceed past initialize.
      await tick();

      const emitter = await result;

      // Verify fork was called via HTTP.
      const forkCall = fetchCalls.find((c) => c.url.includes("/fork"));
      expect(forkCall).toBeDefined();
      expect(forkCall?.method).toBe("POST");

      // Attach the collector BEFORE emitting — settle() emits synchronously.
      const eventsPromise = collectEvents(emitter);

      // Send an agent-message-chunk update.
      harness.stream.emitMessage({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          update: {
            kind: "agent-text",
            text: "Hello!",
          },
        },
      });

      // session/prompt is sent from a setImmediate inside the sidechain,
      // so wait for it before asserting and before responding.
      const promptReq = await waitForRequest(harness, "session/prompt");
      expect(promptReq.params).toMatchObject({
        sessionId: "forked-1",
        prompt: [{ type: "text", text: "hello world" }],
        _meta: { "hydra-acp": { ancillary: true } },
      });

      // The originator settles on the session/prompt response carrying
      // stopReason — not on the turn_complete notification (which the
      // daemon excludes the originator from).
      respondResult(harness, promptReq, { stopReason: "end_turn" });

      const events = await eventsPromise;

      // Should have received the update and then the completion.
      const updates = events.filter(
        (e) => typeof e === "object" && e !== null && "kind" in e && (e as { kind: string }).kind === "update",
      );
      expect(updates.length).toBeGreaterThanOrEqual(1);

      const completions = events.filter(
        (e) => typeof e === "object" && e !== null && "kind" in e && (e as { kind: string }).kind === "completed",
      );
      expect(completions.length).toBe(1);
    });

    it("passes forkAt option through to forkSession", async () => {
      const harness = makeHarness();

      const fetchImpl = fakeFetch({
        "src-2": {
          sessionId: "forked-2",
          forkedFromSessionId: "src-2",
          forkedAt: "2025-06-01T12:00:00Z",
        },
      });

      const result = runBtwSidechain(target, "src-2", "test prompt", {
        fetchImpl,
        forkAt: "msg-abc123",
        _streamFactory: () => Promise.resolve(harness.stream),
      });

      await tick();
      const initReq = findRequest(harness.sent, "initialize");
      if (initReq) {
        harness.stream.emitMessage({
          jsonrpc: "2.0",
          id: initReq.id,
          result: { protocolVersion: 1, agentCapabilities: {} },
        });
      }

      await tick();
      await result;

      const forkCall = fetchCalls.find((c) => c.url.includes("/fork"));
      expect(forkCall).toBeDefined();
      expect((forkCall?.body as { forkAt?: string })?.forkAt).toBe("msg-abc123");
    });

    it("emits update events for session/update notifications", async () => {
      const harness = makeHarness();

      const fetchImpl = fakeFetch({
        "src-3": {
          sessionId: "forked-3",
          forkedFromSessionId: "src-3",
          forkedAt: "2025-01-01T00:00:00Z",
        },
      });

      const result = runBtwSidechain(target, "src-3", "prompt text", {
        fetchImpl,
        _streamFactory: () => Promise.resolve(harness.stream),
      });

      await tick();
      const initReq = findRequest(harness.sent, "initialize");
      if (initReq) {
        harness.stream.emitMessage({
          jsonrpc: "2.0",
          id: initReq.id,
          result: { protocolVersion: 1, agentCapabilities: {} },
        });
      }

      await tick();
      const emitter = await result;

      const eventsPromise = collectEvents(emitter);

      // Emit multiple updates.
      harness.stream.emitMessage({
        jsonrpc: "2.0",
        method: "session/update",
        params: { update: { kind: "agent-text", text: "chunk1" } },
      });
      harness.stream.emitMessage({
        jsonrpc: "2.0",
        method: "session/update",
        params: { update: { kind: "tool-call", toolCallId: "t1", title: "read_file" } },
      });

      const promptReq = await waitForRequest(harness, "session/prompt");
      respondResult(harness, promptReq, { stopReason: "end_turn" });

      const events = await eventsPromise;

      // Filter for update events — should have at least 2.
      const updateEvents = events.filter(
        (e) => typeof e === "object" && e !== null && "kind" in e && (e as { kind: string }).kind === "update",
      );
      expect(updateEvents.length).toBeGreaterThanOrEqual(2);

      // Check that the update payloads are forwarded.
      const firstUpdate = updateEvents[0] as { kind: "update"; update: unknown };
      expect(firstUpdate.kind).toBe("update");
    });
  });

  describe("cancel path", () => {
    it("sends session/cancel notification and closes the stream", async () => {
      const harness = makeHarness();

      const fetchImpl = fakeFetch({
        "src-4": {
          sessionId: "forked-4",
          forkedFromSessionId: "src-4",
          forkedAt: "2025-01-01T00:00:00Z",
        },
      });

      const result = runBtwSidechain(target, "src-4", "prompt", {
        fetchImpl,
        _streamFactory: () => Promise.resolve(harness.stream),
      });

      await tick();
      const initReq = findRequest(harness.sent, "initialize");
      if (initReq) {
        harness.stream.emitMessage({
          jsonrpc: "2.0",
          id: initReq.id,
          result: { protocolVersion: 1, agentCapabilities: {} },
        });
      }

      await tick();
      const emitter = await result;

      // Cancel.
      emitter.cancel();

      // The cancel should have triggered a session/cancel notification.
      const cancelNotif = harness.sent.find(
        (m): m is JsonRpcRequest =>
          typeof m === "object" &&
          m !== null &&
          "method" in m &&
          (m as { method: unknown }).method === "session/cancel",
      );
      expect(cancelNotif).toBeDefined();
    });

    it("is idempotent after completion — does not emit a second terminal event", async () => {
      const harness = makeHarness();

      const fetchImpl = fakeFetch({
        "src-5": {
          sessionId: "forked-5",
          forkedFromSessionId: "src-5",
          forkedAt: "2025-01-01T00:00:00Z",
        },
      });

      const result = runBtwSidechain(target, "src-5", "prompt", {
        fetchImpl,
        _streamFactory: () => Promise.resolve(harness.stream),
      });

      await tick();
      const initReq = findRequest(harness.sent, "initialize");
      if (initReq) {
        harness.stream.emitMessage({
          jsonrpc: "2.0",
          id: initReq.id,
          result: { protocolVersion: 1, agentCapabilities: {} },
        });
      }

      await tick();
      const emitter = await result;

      const eventsPromise = collectEvents(emitter);

      // Respond to session/prompt to settle the sidechain as completed.
      const promptReq = await waitForRequest(harness, "session/prompt");
      respondResult(harness, promptReq, { stopReason: "end_turn" });

      const events = await eventsPromise;

      // Cancel after completion — should not produce a cancelled event since
      // the sidechain already settled with completed.
      emitter.cancel();

      const completions = events.filter(
        (e) => typeof e === "object" && e !== null && "kind" in e && (e as { kind: string }).kind === "completed",
      );
      expect(completions.length).toBe(1);

      const cancellations = events.filter(
        (e) => typeof e === "object" && e !== null && "kind" in e && (e as { kind: string }).kind === "cancelled",
      );
      expect(cancellations.length).toBe(0);
    });
  });

  describe("error path", () => {
    it("rejects when forkSession fails", async () => {
      const harness = makeHarness();

      // forkSession throws because the source session doesn't exist.
      const fetchImpl = (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/fork")) {
          return new Response(
            JSON.stringify({ error: "session not found" }),
            { status: 404 },
          );
        }
        return new Response("not found", { status: 404 });
      }) as typeof fetch;

      const result = runBtwSidechain(target, "nonexistent", "prompt", {
        fetchImpl,
        _streamFactory: () => Promise.resolve(harness.stream),
      });

      // Attach the rejection expectation BEFORE any await — otherwise the
      // sidechain's IIFE can reject between ticks while no handler is
      // attached, and Node emits a PromiseRejectionHandledWarning that
      // vitest surfaces as an unhandled error, failing the run.
      const assertion = expect(result).rejects.toThrow(/fork failed/);

      await tick();
      const initReq = findRequest(harness.sent, "initialize");
      if (initReq) {
        harness.stream.emitMessage({
          jsonrpc: "2.0",
          id: initReq.id,
          result: { protocolVersion: 1, agentCapabilities: {} },
        });
      }

      await assertion;
    });

    it("emits errored event on turn_error notification", async () => {
      const harness = makeHarness();

      const fetchImpl = fakeFetch({
        "src-6": {
          sessionId: "forked-6",
          forkedFromSessionId: "src-6",
          forkedAt: "2025-01-01T00:00:00Z",
        },
      });

      const result = runBtwSidechain(target, "src-6", "prompt", {
        fetchImpl,
        _streamFactory: () => Promise.resolve(harness.stream),
      });

      await tick();
      const initReq = findRequest(harness.sent, "initialize");
      if (initReq) {
        harness.stream.emitMessage({
          jsonrpc: "2.0",
          id: initReq.id,
          result: { protocolVersion: 1, agentCapabilities: {} },
        });
      }

      await tick();
      const emitter = await result;

      const eventsPromise = collectEvents(emitter);

      // Reject the session/prompt request — the sidechain maps a prompt
      // rejection to an errored terminal event carrying the error message.
      const promptReq = await waitForRequest(harness, "session/prompt");
      respondError(harness, promptReq, "agent crashed");

      const events = await eventsPromise;

      const errors = events.filter(
        (e) => typeof e === "object" && e !== null && "kind" in e && (e as { kind: string }).kind === "errored",
      );
      expect(errors.length).toBe(1);
      const errEvent = errors[0] as { kind: "errored"; error: Error };
      expect(errEvent.error.message).toBe("agent crashed");
    });

    it("emits completed event when connection closes without turn_complete", async () => {
      const harness = makeHarness();

      const fetchImpl = fakeFetch({
        "src-7": {
          sessionId: "forked-7",
          forkedFromSessionId: "src-7",
          forkedAt: "2025-01-01T00:00:00Z",
        },
      });

      const result = runBtwSidechain(target, "src-7", "prompt", {
        fetchImpl,
        _streamFactory: () => Promise.resolve(harness.stream),
      });

      await tick();
      const initReq = findRequest(harness.sent, "initialize");
      if (initReq) {
        harness.stream.emitMessage({
          jsonrpc: "2.0",
          id: initReq.id,
          result: { protocolVersion: 1, agentCapabilities: {} },
        });
      }

      await tick();
      const emitter = await result;

      // Attach the collector BEFORE closing — onClose settles synchronously.
      const eventsPromise = collectEvents(emitter);

      // Close the stream (simulates connection drop).
      harness.stream.emitClose();

      const events = await eventsPromise;

      const completions = events.filter(
        (e) => typeof e === "object" && e !== null && "kind" in e && (e as { kind: string }).kind === "completed",
      );
      expect(completions.length).toBe(1);
    });

    it("tolerates cancel on an already-closed connection", async () => {
      const harness = makeHarness();

      const fetchImpl = fakeFetch({
        "src-8": {
          sessionId: "forked-8",
          forkedFromSessionId: "src-8",
          forkedAt: "2025-01-01T00:00:00Z",
        },
      });

      const result = runBtwSidechain(target, "src-8", "prompt", {
        fetchImpl,
        _streamFactory: () => Promise.resolve(harness.stream),
      });

      await tick();
      const initReq = findRequest(harness.sent, "initialize");
      if (initReq) {
        harness.stream.emitMessage({
          jsonrpc: "2.0",
          id: initReq.id,
          result: { protocolVersion: 1, agentCapabilities: {} },
        });
      }

      await tick();
      const emitter = await result;

      const eventsPromise = collectEvents(emitter);

      // Close the stream first (simulates connection drop).
      harness.stream.emitClose();

      // Collect the completion event.
      await eventsPromise;

      // Cancel after close — should not throw.
      expect(() => emitter.cancel()).not.toThrow();
    });
  });
});
