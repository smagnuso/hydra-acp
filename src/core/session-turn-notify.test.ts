// Session.registerTurnNotify — the one-shot turn-completion webhook a
// caller registers instead of holding an ACP attach open. Exercises the
// real broadcastTurnComplete integration point directly (rather than
// driving a full mock-agent turn through the prompt queue, which has its
// own timing contract unrelated to what's under test here) since that's
// the actual trigger for delivery — see turn-notify.ts for the
// signing/delivery mechanics themselves.
import { describe, it, expect, vi, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { Session, type AttachedClient } from "./session.js";
import { HistoryStore } from "./history-store.js";
import { JsonRpcConnection } from "../acp/connection.js";
import { makeControlledStream, makeMockAgent } from "../__tests__/test-utils.js";

function makeSession(sessionId = "sess_notify") {
  const mock = makeMockAgent({ agentId: "mock", cwd: "/work" });
  const session = new Session({
    sessionId,
    cwd: "/work",
    agentId: "mock",
    agent: mock.agent,
    upstreamSessionId: "u_agent",
    historyStore: new HistoryStore(),
  });
  return session;
}

function makeClient(): AttachedClient {
  return {
    clientId: `c_${Math.random().toString(36).slice(2, 8)}`,
    connection: new JsonRpcConnection(makeControlledStream()),
  };
}

// broadcastTurnComplete is private; this is the exact call shape drainQueue
// uses on a normal completion (see session.ts's four call sites).
function completeTurn(
  session: Session,
  messageId: string,
  stopReason: string,
): void {
  (session as unknown as {
    broadcastTurnComplete(
      originatorClientId: string,
      response: unknown,
      promptMessageId?: string,
      wasAmend?: boolean,
    ): void;
  }).broadcastTurnComplete("some_client", { stopReason }, messageId);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Session.registerTurnNotify", () => {
  it("resolves immediately, with no delivery, when the turn already completed", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const session = makeSession();

    completeTurn(session, "m_1", "end_turn");
    const result = session.registerTurnNotify(
      "m_1",
      "https://example.invalid/callback",
      "s3cr3t",
    );

    expect(result).toEqual({ alreadyTerminal: true, stopReason: "end_turn" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("delivers a signed callback once the registered turn completes", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const session = makeSession();

    const result = session.registerTurnNotify(
      "m_2",
      "https://example.invalid/callback",
      "s3cr3t",
    );
    expect(result).toEqual({ alreadyTerminal: false });
    expect(fetchMock).not.toHaveBeenCalled();

    completeTurn(session, "m_2", "end_turn");
    // deliverTurnNotify's fetch call is fire-and-forget (not awaited by
    // broadcastTurnComplete), so let the microtask it kicks off run.
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://example.invalid/callback");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string) as {
      sessionId: string;
      messageId: string;
      stopReason: string;
      deliveredAt: number;
    };
    expect(body.sessionId).toBe("sess_notify");
    expect(body.messageId).toBe("m_2");
    expect(body.stopReason).toBe("end_turn");
    expect(typeof body.deliveredAt).toBe("number");
    const expectedSignature = createHmac("sha256", "s3cr3t")
      .update(init.body as string)
      .digest("hex");
    expect(init.headers["X-Hydra-Turn-Notify-Signature"]).toBe(expectedSignature);
  });

  it("delivers exactly once even across a second registration for the same turn", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const session = makeSession();

    session.registerTurnNotify("m_3", "https://example.invalid/callback", "s3cr3t");
    completeTurn(session, "m_3", "end_turn");
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A second registration for the same (now-resolved) messageId takes
    // the already_terminal fast path, not another delivery.
    const second = session.registerTurnNotify(
      "m_3",
      "https://example.invalid/callback",
      "s3cr3t",
    );
    expect(second).toEqual({ alreadyTerminal: true, stopReason: "end_turn" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never registers a callback for an unrelated messageId", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const session = makeSession();

    session.registerTurnNotify("m_mine", "https://example.invalid/callback", "s3cr3t");
    completeTurn(session, "m_someone_elses", "end_turn");
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("delivers a cancelled callback for a registration whose turn never started, once the session closes", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const session = makeSession();

    // A queued-but-never-dispatched entry: never reaches
    // broadcastTurnComplete on its own, since there's no turn to
    // complete — markClosed's stranded-queue drain is the only place
    // that resolves it at all.
    (session as unknown as { promptQueue: unknown[] }).promptQueue.push({
      kind: "user",
      messageId: "m_queued",
      originator: { clientId: "c1" },
      clientId: "c1",
      prompt: [{ type: "text", text: "hi" }],
      enqueuedAt: Date.now(),
      cancelled: false,
      resolve: () => undefined,
      reject: () => undefined,
    });
    session.registerTurnNotify("m_queued", "https://example.invalid/callback", "s3cr3t");
    expect(fetchMock).not.toHaveBeenCalled();

    await session.close({ deleteRecord: false });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(init.body as string) as {
      messageId: string;
      stopReason: string;
    };
    expect(body.messageId).toBe("m_queued");
    expect(body.stopReason).toBe("cancelled");
  });

  it("delivers on force-cancel, with the same stopReason peers see on the wire (interrupted, not cancelled)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const session = makeSession();

    // A well-behaved agent honors session/cancel by resolving its own
    // in-flight session/prompt with stopReason "cancelled" — that's just
    // an ordinary broadcastTurnComplete call, already covered by the
    // other tests above. forceCancel() is the *other* path: the agent
    // ignored the polite cancel, so the daemon kills the process
    // outright via close(). The turn's own resolved value comes back
    // "cancelled" to whoever called forceCancel, but what markClosed
    // broadcasts to the wire (and thus what a registered notifier sees)
    // is "interrupted" — same distinction attached peers already get.
    (session as unknown as { currentEntry: unknown }).currentEntry = {
      kind: "user",
      messageId: "m_inflight",
      originator: { clientId: "c1" },
      clientId: "c1",
      prompt: [{ type: "text", text: "hi" }],
      enqueuedAt: Date.now(),
      cancelled: false,
      resolve: () => undefined,
      reject: () => undefined,
    };
    session.registerTurnNotify("m_inflight", "https://example.invalid/callback", "s3cr3t");

    const result = await session.forceCancel();
    expect(result).toEqual({ stopReason: "cancelled" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(init.body as string) as {
      messageId: string;
      stopReason: string;
    };
    expect(body.messageId).toBe("m_inflight");
    expect(body.stopReason).toBe("interrupted");
  });

  it("follows an amend chain: fires once M2 finishes, reporting M1 with amendedTo", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const session = makeSession();
    const client = makeClient();
    await session.attach(client, "none");

    // amendPrompt's "target is the in-flight head" success path requires
    // currentEntry to already be M1, live and unamended.
    (session as unknown as { currentEntry: unknown }).currentEntry = {
      kind: "user",
      messageId: "m1",
      originator: { clientId: client.clientId },
      clientId: client.clientId,
      prompt: [{ type: "text", text: "original" }],
      enqueuedAt: Date.now(),
      cancelled: false,
      resolve: () => undefined,
      reject: () => undefined,
    };
    session.registerTurnNotify("m1", "https://example.invalid/callback", "s3cr3t");

    const result = session.amendPrompt(client.clientId, {
      sessionId: "sess_notify",
      targetMessageId: "m1",
      prompt: [{ type: "text", text: "corrected" }],
    }) as { amended: boolean; reason: string; messageId?: string };
    expect(result.amended).toBe(true);
    const m2 = result.messageId!;
    expect(m2).not.toBe("m1");

    // M1's own cancellation must NOT deliver anything — the registration
    // should have already been carried forward to m2 by amendPrompt.
    completeTurn(session, "m1", "cancelled");
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();

    // M2 is what actually finishes.
    completeTurn(session, m2, "end_turn");
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(init.body as string) as {
      messageId: string;
      stopReason: string;
      amendedTo?: string;
    };
    expect(body.messageId).toBe("m1");
    expect(body.stopReason).toBe("end_turn");
    expect(body.amendedTo).toBe(m2);
  });
});
