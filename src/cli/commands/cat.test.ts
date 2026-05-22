import { EventEmitter } from "node:events";
import { describe, it, expect } from "vitest";
import { JsonRpcConnection } from "../../acp/connection.js";
import { makeControlledStream } from "../../__tests__/test-utils.js";
import type {
  JsonRpcMessage,
  JsonRpcRequest,
  JsonRpcResponse,
} from "../../acp/types.js";
import { runCatLoop, type CatLoopArgs } from "./cat.js";

// Stand-in for process.stdin. Push() emits a "data" event synchronously
// if a listener is attached; otherwise it buffers and replays once
// runCatLoop subscribes. Same for end().
class FakeStdin extends EventEmitter {
  private pendingData: string[] = [];
  private pendingEnd = false;

  setEncoding(_enc: BufferEncoding): void {
    // The real stream switches encoding modes here; we always emit
    // strings so there's nothing to do.
  }
  override on(event: string | symbol, listener: (...args: any[]) => void): this {
    super.on(event, listener);
    if (event === "data" && this.pendingData.length > 0) {
      const queued = this.pendingData;
      this.pendingData = [];
      for (const d of queued) {
        this.emit("data", d);
      }
    }
    if (event === "end" && this.pendingEnd) {
      this.pendingEnd = false;
      this.emit("end");
    }
    return this;
  }
  push(data: string): void {
    if (this.listenerCount("data") > 0) {
      this.emit("data", data);
    } else {
      this.pendingData.push(data);
    }
  }
  end(): void {
    if (this.listenerCount("end") > 0 && this.pendingData.length === 0) {
      this.emit("end");
    } else {
      this.pendingEnd = true;
    }
  }
}

// Build the test harness: a JsonRpcConnection whose underlying stream
// is controllable, plus helpers to inspect what cat sent and inject
// daemon replies / notifications back at it.
function makeHarness() {
  const stream = makeControlledStream();
  const conn = new JsonRpcConnection(stream);
  const fakeStdin = new FakeStdin();
  const stdout: string[] = [];
  const stderr: string[] = [];

  // Reply to a sent request whose id we haven't replied to yet, matching
  // by `method`. Walks sent[] in order so chained turns (multiple
  // session/prompts) get serviced FIFO. Returns the matched request or
  // undefined if nothing pending.
  const respondedIds = new Set<string | number>();
  const respondToRequest = (
    method: string,
    result: unknown,
  ): JsonRpcRequest | undefined => {
    const sent = stream.sent.find(
      (m): m is JsonRpcRequest =>
        "method" in m &&
        "id" in m &&
        m.id !== undefined &&
        m.method === method &&
        !respondedIds.has(m.id),
    );
    if (!sent) {
      return undefined;
    }
    respondedIds.add(sent.id);
    const reply: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: sent.id,
      result,
    };
    stream.emitMessage(reply);
    return sent;
  };

  // Wait until at least one sent message matches `method`. Polls on the
  // microtask queue — the loop awaits its requests, so each new request
  // lands after a few ticks.
  const waitForRequest = async (
    method: string,
    timeoutMs = 1_000,
  ): Promise<JsonRpcRequest> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = stream.sent.find(
        (m): m is JsonRpcRequest =>
          "method" in m &&
          "id" in m &&
          m.id !== undefined &&
          m.method === method,
      );
      if (found) {
        return found;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(
      `timed out waiting for request ${method}; saw ${stream.sent
        .map((m) => ("method" in m ? m.method : "?"))
        .join(",")}`,
    );
  };

  // Fire a session/update notification at the loop. `update` is the
  // payload that goes inside params.update.
  const emitSessionUpdate = (sessionId: string, update: unknown): void => {
    const note: JsonRpcMessage = {
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId, update },
    };
    stream.emitMessage(note);
  };

  const baseArgs: Omit<CatLoopArgs, "opts"> = {
    conn,
    stdin: fakeStdin,
    stdinIsTty: false,
    stdout: (chunk) => stdout.push(chunk),
    stderr: (chunk) => stderr.push(chunk),
  };

  return {
    stream,
    conn,
    fakeStdin,
    stdout,
    stderr,
    respondToRequest,
    waitForRequest,
    emitSessionUpdate,
    baseArgs,
  };
}

// Drive the standard startup handshake: respond to initialize and
// session/new with reasonable defaults. Returns the assigned sessionId.
// Yields a tick at the end so the loop has time to register its stdin
// listeners before the test starts pushing data.
async function performHandshake(
  h: ReturnType<typeof makeHarness>,
  sessionId = "hydra_session_test",
): Promise<string> {
  await h.waitForRequest("initialize");
  h.respondToRequest("initialize", {
    protocolVersion: 1,
    agentCapabilities: {},
  });
  await h.waitForRequest("session/new");
  h.respondToRequest("session/new", { sessionId, _meta: {} });
  // Let the loop's post-handshake setup (stdin listener registration,
  // notification handler) complete before the test starts driving it.
  await new Promise((r) => setTimeout(r, 0));
  return sessionId;
}

// Variant of performHandshake for the --session-id path: the loop
// issues session/attach instead of session/new. Returns the attach
// request so the test can inspect its params (e.g. historyPolicy).
async function performAttachHandshake(
  h: ReturnType<typeof makeHarness>,
  sessionId: string,
): Promise<JsonRpcRequest> {
  await h.waitForRequest("initialize");
  h.respondToRequest("initialize", {
    protocolVersion: 1,
    agentCapabilities: {},
  });
  const attachReq = await h.waitForRequest("session/attach");
  h.respondToRequest("session/attach", { sessionId, _meta: {} });
  await new Promise((r) => setTimeout(r, 0));
  return attachReq;
}

describe("runCatLoop", () => {
  it("strips ANSI escape sequences from agent text before writing to stdout", async () => {
    const h = makeHarness();
    const loopPromise = runCatLoop({
      ...h.baseArgs,
      opts: { prompt: "summarize this" },
    });

    const sessionId = await performHandshake(h);

    // Feed one line and close stdin so we have a single bounded turn.
    h.fakeStdin.push("log line\n");
    h.fakeStdin.end();

    await h.waitForRequest("session/prompt");
    // Agent emits text laced with ANSI colour codes — what a careless
    // upstream would do. cat should strip every escape before stdout.
    h.emitSessionUpdate(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "\x1b[31mred\x1b[0m alert" },
    });
    h.emitSessionUpdate(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "\x1b[1;32mbold green\x1b[0m end" },
    });
    // No synthetic turn_complete: the daemon excludes the originator
    // from those broadcasts (core/session.ts:177). The session/prompt
    // response IS the originator's end-of-turn signal.
    h.respondToRequest("session/prompt", { stopReason: "end_turn" });

    const result = await loopPromise;
    expect(result.exitCode).toBe(0);

    const out = h.stdout.join("");
    expect(out).not.toContain("\x1b");
    expect(out).toContain("red alert");
    expect(out).toContain("bold green end");
  });

  it("strips C0 control characters from agent text", async () => {
    const h = makeHarness();
    const loopPromise = runCatLoop({
      ...h.baseArgs,
      opts: { prompt: "go" },
    });

    const sessionId = await performHandshake(h);
    h.fakeStdin.push("x\n");
    h.fakeStdin.end();

    await h.waitForRequest("session/prompt");
    h.emitSessionUpdate(sessionId, {
      sessionUpdate: "agent_message_chunk",
      // \x07 (BEL), \x08 (BS), \x7f (DEL): all should be stripped.
      content: { type: "text", text: "alert\x07\x08\x7fdone" },
    });
    h.respondToRequest("session/prompt", { stopReason: "end_turn" });
    await loopPromise;

    const out = h.stdout.join("");
    expect(out).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f]/);
    expect(out).toContain("alertdone");
  });

  it("sends the standing prompt as the first text block of every chunk", async () => {
    const h = makeHarness();
    const loopPromise = runCatLoop({
      ...h.baseArgs,
      opts: { prompt: "watch for anomalies" },
    });

    const sessionId = await performHandshake(h);

    // First chunk → first prompt.
    h.fakeStdin.push("line one\n");
    const first = await h.waitForRequest("session/prompt");
    const firstParams = first.params as { prompt: Array<{ text?: string }> };
    expect(firstParams.prompt[0]?.text).toBe("watch for anomalies");
    expect(firstParams.prompt[1]?.text).toBe("line one\n");

    h.respondToRequest("session/prompt", { stopReason: "end_turn" });

    // Wait for the first prompt to fully drain through the loop's
    // serialization gate before the second chunk goes out, otherwise
    // we race the test on the second waitForRequest below.
    await new Promise((r) => setTimeout(r, 10));

    h.fakeStdin.push("line two\n");
    h.fakeStdin.end();

    // Drain: second prompt should include the standing prompt again.
    const allPrompts = await waitForPromptCount(h, 2);
    const secondParams = allPrompts[1]!.params as {
      prompt: Array<{ text?: string }>;
    };
    expect(secondParams.prompt[0]?.text).toBe("watch for anomalies");
    expect(secondParams.prompt[1]?.text).toBe("line two\n");

    h.respondToRequest("session/prompt", { stopReason: "end_turn" });
    await loopPromise;
  });

  it("emits a trailing newline only when the last write didn't already end in one", async () => {
    const h = makeHarness();
    const loopPromise = runCatLoop({
      ...h.baseArgs,
      opts: { prompt: "go" },
    });
    const sessionId = await performHandshake(h);

    h.fakeStdin.push("input\n");
    h.fakeStdin.end();

    await h.waitForRequest("session/prompt");
    h.emitSessionUpdate(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "no newline at end" },
    });
    h.respondToRequest("session/prompt", { stopReason: "end_turn" });
    await loopPromise;

    const out = h.stdout.join("");
    expect(out).toBe("no newline at end\n");
  });

  it("does not add a trailing newline when the agent already ended with one", async () => {
    const h = makeHarness();
    const loopPromise = runCatLoop({
      ...h.baseArgs,
      opts: { prompt: "go" },
    });
    const sessionId = await performHandshake(h);

    h.fakeStdin.push("x\n");
    h.fakeStdin.end();

    await h.waitForRequest("session/prompt");
    h.emitSessionUpdate(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "ends with newline\n" },
    });
    h.respondToRequest("session/prompt", { stopReason: "end_turn" });
    await loopPromise;

    expect(h.stdout.join("")).toBe("ends with newline\n");
  });

  it("calls session/detach on normal exit when --detach is NOT set", async () => {
    const h = makeHarness();
    const loopPromise = runCatLoop({
      ...h.baseArgs,
      opts: { prompt: "go" },
    });
    await performHandshake(h);
    h.fakeStdin.end();
    await loopPromise.catch(() => undefined);
    // The settle() path on no-chunks-sent goes straight to detach without
    // any prompt, so we wait for session/detach to appear.
    const detached = h.stream.sent.some(
      (m) => "method" in m && m.method === "session/detach",
    );
    expect(detached).toBe(true);
  });

  it("skips session/detach when --detach IS set, so the session survives in the daemon", async () => {
    const h = makeHarness();
    const loopPromise = runCatLoop({
      ...h.baseArgs,
      opts: { prompt: "go", detach: true },
    });
    await performHandshake(h);
    h.fakeStdin.end();
    await loopPromise;
    const detached = h.stream.sent.some(
      (m) => "method" in m && m.method === "session/detach",
    );
    expect(detached).toBe(false);
  });

  it("serializes chunks behind the previous turn's session/prompt response", async () => {
    const h = makeHarness();
    const loopPromise = runCatLoop({
      ...h.baseArgs,
      opts: { prompt: "go" },
    });
    await performHandshake(h);

    // Burst 1: one line, then await so setImmediate fires and the
    // chunk gets sent.
    h.fakeStdin.push("a\n");
    await h.waitForRequest("session/prompt");
    expect(countPromptsSent(h)).toBe(1);

    // Burst 2: another line. Push happens while the first request is
    // still in flight (we haven't responded yet). The chunker will
    // schedule a flush via setImmediate, but onChunk will enqueue
    // into chunkQueue; drainQueue won't pull it off until the prior
    // sendChunk's await conn.request returns. So even after the
    // setImmediate tick fires, no second session/prompt should be on
    // the wire yet.
    h.fakeStdin.push("b\n");
    await new Promise((r) => setTimeout(r, 20));
    expect(countPromptsSent(h)).toBe(1);

    // Respond to the first turn. drainQueue resumes, pulls "b\n",
    // sends the second prompt.
    h.respondToRequest("session/prompt", { stopReason: "end_turn" });
    await waitForPromptCount(h, 2);

    h.fakeStdin.end();
    h.respondToRequest("session/prompt", { stopReason: "end_turn" });
    await loopPromise;
  });

  it("emits the standing prompt once and exits when stdin is a TTY", async () => {
    const h = makeHarness();
    const loopPromise = runCatLoop({
      ...h.baseArgs,
      stdinIsTty: true,
      opts: { prompt: "what's up?" },
    });
    await performHandshake(h);
    const prompt = await h.waitForRequest("session/prompt");
    const params = prompt.params as { prompt: Array<{ text?: string }> };
    expect(params.prompt).toHaveLength(1);
    expect(params.prompt[0]?.text).toBe("what's up?");

    h.respondToRequest("session/prompt", { stopReason: "end_turn" });
    await loopPromise;
  });

  it("sends a chunk with no standing prompt when -p is not given (stdin alone is the prompt)", async () => {
    const h = makeHarness();
    const loopPromise = runCatLoop({
      ...h.baseArgs,
      opts: {}, // no prompt
    });
    await performHandshake(h);
    h.fakeStdin.push("explain this code\n");
    h.fakeStdin.end();

    const prompt = await h.waitForRequest("session/prompt");
    const params = prompt.params as { prompt: Array<{ text?: string }> };
    expect(params.prompt).toHaveLength(1);
    expect(params.prompt[0]?.text).toBe("explain this code\n");

    h.respondToRequest("session/prompt", { stopReason: "end_turn" });
    await loopPromise;
  });

  it("attaches to an existing session with pending_only history when --session-id is set", async () => {
    const h = makeHarness();
    const loopPromise = runCatLoop({
      ...h.baseArgs,
      opts: { sessionId: "hydra_session_existing", prompt: "watch logs" },
    });
    const attachReq = await performAttachHandshake(
      h,
      "hydra_session_existing",
    );
    const attachParams = attachReq.params as {
      sessionId: string;
      historyPolicy: string;
    };
    expect(attachParams.sessionId).toBe("hydra_session_existing");
    expect(attachParams.historyPolicy).toBe("pending_only");
    // No session/new should have been issued — we're attaching, not
    // creating.
    const sentNew = h.stream.sent.some(
      (m) => "method" in m && m.method === "session/new",
    );
    expect(sentNew).toBe(false);

    h.fakeStdin.push("err\n");
    h.fakeStdin.end();
    await h.waitForRequest("session/prompt");
    h.respondToRequest("session/prompt", { stopReason: "end_turn" });
    await loopPromise;
  });

  // Regression for the deadlock we hit on `cat /etc/passwd | hydra cat -p
  // "what is smagnuson home dir?"`: the daemon answered, the agent text
  // streamed to stdout, but cat never exited. Cause: we were awaiting a
  // turn_complete notification the daemon doesn't send to the originator
  // (it broadcasts only to peers). The session/prompt response is the
  // originator's end-of-turn signal. This test asserts the loop unwinds
  // cleanly with ONLY chunks + response — no synthetic turn_complete.
  it("exits cleanly when the daemon emits chunks + session/prompt response (no turn_complete to originator)", async () => {
    const h = makeHarness();
    const loopPromise = runCatLoop({
      ...h.baseArgs,
      opts: { prompt: "what is the smagnuson home dir?" },
    });
    const sessionId = await performHandshake(h);

    h.fakeStdin.push("root:x:0:0:root:/root:/bin/bash\nsmagnuson:x:1000:1000:Sam:/home/smagnuson:/bin/zsh\n");
    h.fakeStdin.end();

    await h.waitForRequest("session/prompt");
    h.emitSessionUpdate(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "/home/smagnuson" },
    });
    // Crucially: NO turn_complete notification. The daemon excludes
    // the originator from this broadcast in real life.
    h.respondToRequest("session/prompt", { stopReason: "end_turn" });

    const result = await loopPromise;
    expect(result.exitCode).toBe(0);
    expect(h.stdout.join("")).toContain("/home/smagnuson");
  });

  // Peer-driven turn: we attached via --session-id while a TUI / Slack
  // client was driving the conversation. The daemon DOES broadcast
  // turn_complete to us in that case, and our notification handler
  // should still finalize the turn so the trailing newline lands
  // before any subsequent agent output runs together with this one.
  it("flushes a trailing newline on a peer-driven turn_complete notification", async () => {
    const h = makeHarness();
    const loopPromise = runCatLoop({
      ...h.baseArgs,
      opts: { sessionId: "hydra_session_existing" },
    });
    await performAttachHandshake(h, "hydra_session_existing");

    // Peer is driving the turn; we just observe.
    h.emitSessionUpdate("hydra_session_existing", {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "no trailing newline" },
    });
    h.emitSessionUpdate("hydra_session_existing", {
      sessionUpdate: "turn_complete",
      stopReason: "end_turn",
    });
    h.fakeStdin.end();
    await loopPromise;

    expect(h.stdout.join("")).toBe("no trailing newline\n");
  });

  it("reads from stdin even when it is a TTY, as long as --session-id is set", async () => {
    // The user typed `hydra-acp cat --session-id <id>` at the shell
    // and is typing into the keyboard. stdinIsTty=true must NOT take
    // the fire-and-exit shortcut; instead the loop should wire up
    // stdin and serve what the user types until ^D.
    const h = makeHarness();
    const loopPromise = runCatLoop({
      ...h.baseArgs,
      stdinIsTty: true,
      opts: { sessionId: "hydra_session_existing" },
    });
    await performAttachHandshake(h, "hydra_session_existing");

    h.fakeStdin.push("hello agent\n");
    const prompt = await h.waitForRequest("session/prompt");
    const params = prompt.params as { prompt: Array<{ text?: string }> };
    // No -p, so only the stdin text goes in.
    expect(params.prompt).toHaveLength(1);
    expect(params.prompt[0]?.text).toBe("hello agent\n");

    h.respondToRequest("session/prompt", { stopReason: "end_turn" });
    h.fakeStdin.end();
    await loopPromise;
  });
});

function countPromptsSent(h: ReturnType<typeof makeHarness>): number {
  return h.stream.sent.filter(
    (m) => "method" in m && m.method === "session/prompt",
  ).length;
}

async function waitForPromptCount(
  h: ReturnType<typeof makeHarness>,
  n: number,
  timeoutMs = 1_000,
): Promise<JsonRpcRequest[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const prompts = h.stream.sent.filter(
      (m): m is JsonRpcRequest =>
        "method" in m && m.method === "session/prompt",
    );
    if (prompts.length >= n) {
      return prompts;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${n} session/prompt requests`);
}
