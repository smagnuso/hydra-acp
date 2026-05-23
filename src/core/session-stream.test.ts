import { describe, it, expect } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Session } from "./session.js";
import { makeMockAgent } from "../__tests__/test-utils.js";
import { JsonRpcErrorCodes } from "../acp/types.js";

function makeStreamingSession() {
  const mock = makeMockAgent({ agentId: "mock", cwd: "/w" });
  const session = new Session({
    sessionId: "sess_stream",
    cwd: "/w",
    agentId: "mock",
    agent: mock.agent,
    upstreamSessionId: "u_stream",
  });
  return { session, mock };
}

describe("Session stream lifecycle", () => {
  it("requires openStream before write/read; surfaces StreamNotEnabled otherwise", () => {
    const { session } = makeStreamingSession();
    expect(() => session.streamWrite(Buffer.from("hi").toString("base64"))).toThrow(
      /no stream buffer/,
    );
    try {
      session.streamWrite(Buffer.from("hi").toString("base64"));
    } catch (err) {
      expect((err as { code?: number }).code).toBe(
        JsonRpcErrorCodes.StreamNotEnabled,
      );
    }
  });

  it("openStream then streamWrite + streamRead round-trips bytes through base64", async () => {
    const { session } = makeStreamingSession();
    session.openStream({});
    session.streamWrite(Buffer.from("hello, ", "utf8").toString("base64"));
    session.streamWrite(Buffer.from("world", "utf8").toString("base64"), true);
    const r = await session.streamRead(0, undefined, undefined);
    expect(Buffer.from(r.bytes, "base64").toString("utf8")).toBe("hello, world");
    expect(r.eof).toBe(true);
    expect(r.gap).toBeUndefined();
    expect(r.nextCursor).toBe(12);
  });

  it("streamRead long-polls until an append arrives", async () => {
    const { session } = makeStreamingSession();
    session.openStream({});
    const pending = session.streamRead(0, undefined, 1000);
    setImmediate(() =>
      session.streamWrite(Buffer.from("delayed").toString("base64")),
    );
    const r = await pending;
    expect(Buffer.from(r.bytes, "base64").toString("utf8")).toBe("delayed");
  });

  it("streamRead returns empty bytes (no eof) when waitMs=0 and nothing is available yet", async () => {
    const { session } = makeStreamingSession();
    session.openStream({});
    const r = await session.streamRead(0, undefined, 0);
    expect(r.bytes).toBe("");
    expect(r.eof).toBeUndefined();
  });

  it("openStream rejects a double-open", () => {
    const { session } = makeStreamingSession();
    session.openStream({});
    expect(() => session.openStream({})).toThrow(/already open/);
  });

  it("file mode writes a temp file path and the bytes land on disk", async () => {
    const { session } = makeStreamingSession();
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "hydra-stream-sess-"));
    try {
      const result = session.openStream({
        mode: "file",
        filePathFor: (sid) => path.join(dir, `${sid}.log`),
      });
      expect(result.filePath).toBe(path.join(dir, "sess_stream.log"));
      session.streamWrite(Buffer.from("file-mode bytes\n").toString("base64"));
      // Drain via the public streamRead path so the test doesn't reach
      // into private buffer internals.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      const onDisk = await fsp.readFile(result.filePath!, "utf8");
      expect(onDisk).toBe("file-mode bytes\n");
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it("closing the session unlinks the stream file", async () => {
    const { session } = makeStreamingSession();
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "hydra-stream-sess-"));
    try {
      const result = session.openStream({
        mode: "file",
        filePathFor: (sid) => path.join(dir, `${sid}.log`),
      });
      session.streamWrite(Buffer.from("bye").toString("base64"));
      await session.close();
      // Unlink is fire-and-forget via drainFileWrites().then(unlink) — poll
      // briefly rather than guess at a tick count.
      const deadline = Date.now() + 500;
      let exists = true;
      while (Date.now() < deadline) {
        exists = await fsp
          .access(result.filePath!)
          .then(() => true)
          .catch(() => false);
        if (!exists) {
          break;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(exists).toBe(false);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
