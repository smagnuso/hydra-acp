import { describe, it, expect } from "vitest";
import { JsonRpcConnection } from "../acp/connection.js";
import { makeControlledStream } from "../__tests__/test-utils.js";
import { makeInstallProgressForwarder } from "./acp-ws.js";
import {
  AGENT_INSTALL_PROGRESS_METHOD,
  AgentInstallProgressParams,
} from "../acp/types.js";
import type { JsonRpcNotification } from "../acp/types.js";

describe("makeInstallProgressForwarder", () => {
  it("translates binary download progress into a wire notification", async () => {
    const stream = makeControlledStream();
    const connection = new JsonRpcConnection(stream);
    const forward = makeInstallProgressForwarder(connection);

    forward({
      source: "binary",
      phase: "download_progress",
      agentId: "codex",
      version: "0.14.0",
      receivedBytes: 12_345_678,
      totalBytes: 45_678_910,
    });

    // notify() is async (returns a promise) — give the microtask queue a
    // tick so the send actually lands in stream.sent before we assert.
    await new Promise((r) => setImmediate(r));
    expect(stream.sent.length).toBe(1);
    const msg = stream.sent[0] as JsonRpcNotification;
    expect(msg.method).toBe(AGENT_INSTALL_PROGRESS_METHOD);
    const parsed = AgentInstallProgressParams.parse(msg.params);
    expect(parsed).toMatchObject({
      source: "binary",
      phase: "download_progress",
      agentId: "codex",
      version: "0.14.0",
      receivedBytes: 12_345_678,
      totalBytes: 45_678_910,
    });
  });

  it("omits byte fields for phases that don't carry them (extract, install_start)", async () => {
    const stream = makeControlledStream();
    const connection = new JsonRpcConnection(stream);
    const forward = makeInstallProgressForwarder(connection);

    forward({
      source: "binary",
      phase: "extract",
      agentId: "codex",
      version: "0.14.0",
    });
    forward({
      source: "npm",
      phase: "install_start",
      agentId: "claude-acp",
      version: "0.33.1",
      packageSpec: "@anthropic-ai/claude-agent-acp@0.33.1",
    });

    await new Promise((r) => setImmediate(r));
    expect(stream.sent.length).toBe(2);
    const extractMsg = stream.sent[0] as JsonRpcNotification;
    const installMsg = stream.sent[1] as JsonRpcNotification;
    const extractParams = AgentInstallProgressParams.parse(extractMsg.params);
    const installParams = AgentInstallProgressParams.parse(installMsg.params);
    expect(extractParams.receivedBytes).toBeUndefined();
    expect(extractParams.totalBytes).toBeUndefined();
    expect(extractParams.packageSpec).toBeUndefined();
    expect(installParams.receivedBytes).toBeUndefined();
    expect(installParams.totalBytes).toBeUndefined();
    expect(installParams.packageSpec).toBe(
      "@anthropic-ai/claude-agent-acp@0.33.1",
    );
  });

  it("does not throw when the connection is closed mid-download", async () => {
    const stream = makeControlledStream();
    const connection = new JsonRpcConnection(stream);
    const forward = makeInstallProgressForwarder(connection);

    await connection.close();

    // After close, notify() returns Promise.resolve() without sending —
    // the forwarder must not surface that as an exception.
    expect(() => {
      forward({
        source: "binary",
        phase: "download_progress",
        agentId: "codex",
        version: "0.14.0",
        receivedBytes: 1,
        totalBytes: 100,
      });
    }).not.toThrow();
  });

  it("each call is fire-and-forget so a slow send doesn't backpressure the install", () => {
    // The install pipeline emits structured callbacks synchronously from
    // the fetch stream's "data" event. If makeInstallProgressForwarder
    // ever started awaiting connection.notify() instead of fire-and-
    // forgetting it, an HTTP/2 backpressure stall on one side could
    // pause the byte stream on the other. Guard that behaviour by
    // confirming the forwarder returns synchronously even with many
    // events queued.
    const stream = makeControlledStream();
    const connection = new JsonRpcConnection(stream);
    const forward = makeInstallProgressForwarder(connection);
    const start = Date.now();
    for (let i = 0; i < 1000; i++) {
      forward({
        source: "binary",
        phase: "download_progress",
        agentId: "codex",
        version: "0.14.0",
        receivedBytes: i * 1024,
        totalBytes: 1024 * 1024,
      });
    }
    expect(Date.now() - start).toBeLessThan(200);
  });
});
