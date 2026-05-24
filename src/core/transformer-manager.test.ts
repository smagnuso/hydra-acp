import { describe, it, expect, vi } from "vitest";
import { TransformerManager } from "./transformer-manager.js";
import type { JsonRpcConnection } from "../acp/connection.js";

function fakeConnection(): JsonRpcConnection {
  return {
    request: vi.fn().mockResolvedValue(undefined),
    notify: vi.fn().mockResolvedValue(undefined),
    onRequest: vi.fn(),
    onNotification: vi.fn(),
    onClose: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as JsonRpcConnection;
}

function makeManager(configs: { name: string }[] = []) {
  return new TransformerManager(
    configs.map((c) => ({
      name: c.name,
      command: ["node", `${c.name}.mjs`],
      args: [],
      env: {},
      enabled: true,
    })),
  );
}

describe("TransformerManager — connection registry", () => {
  it("resolveChain returns empty array when no transformers are connected", () => {
    const m = makeManager([{ name: "t1" }]);
    expect(m.resolveChain(["t1"])).toHaveLength(0);
  });

  it("resolveChain returns a ref for a connected transformer", () => {
    const m = makeManager([{ name: "t1" }]);
    const conn = fakeConnection();
    m.registerConnection("t1", conn, ["request:session/prompt"]);
    const chain = m.resolveChain(["t1"]);
    expect(chain).toHaveLength(1);
    expect(chain[0]!.name).toBe("t1");
    expect(chain[0]!.intercepts.has("request:session/prompt")).toBe(true);
    expect(chain[0]!.connection).toBe(conn);
  });

  it("resolveChain preserves the requested order", () => {
    const m = makeManager([{ name: "t1" }, { name: "t2" }, { name: "t3" }]);
    m.registerConnection("t1", fakeConnection(), []);
    m.registerConnection("t2", fakeConnection(), []);
    m.registerConnection("t3", fakeConnection(), []);
    const chain = m.resolveChain(["t3", "t1"]);
    expect(chain.map((r) => r.name)).toEqual(["t3", "t1"]);
  });

  it("resolveChain silently skips names that are not connected", () => {
    const m = makeManager([{ name: "t1" }, { name: "t2" }]);
    m.registerConnection("t1", fakeConnection(), []);
    // t2 not connected
    const chain = m.resolveChain(["t1", "t2"]);
    expect(chain.map((r) => r.name)).toEqual(["t1"]);
  });

  it("deregisterConnection removes the transformer from the registry", () => {
    const m = makeManager([{ name: "t1" }]);
    m.registerConnection("t1", fakeConnection(), []);
    expect(m.resolveChain(["t1"])).toHaveLength(1);
    m.deregisterConnection("t1");
    expect(m.resolveChain(["t1"])).toHaveLength(0);
  });

  it("re-registering after deregister works", () => {
    const m = makeManager([{ name: "t1" }]);
    const conn1 = fakeConnection();
    const conn2 = fakeConnection();
    m.registerConnection("t1", conn1, ["response:session/update"]);
    m.deregisterConnection("t1");
    m.registerConnection("t1", conn2, ["request:session/prompt"]);
    const chain = m.resolveChain(["t1"]);
    expect(chain[0]!.connection).toBe(conn2);
    expect(chain[0]!.intercepts.has("request:session/prompt")).toBe(true);
    expect(chain[0]!.intercepts.has("response:session/update")).toBe(false);
  });

  it("reportVersion stores the version visible via list()", () => {
    const m = makeManager([{ name: "t1" }]);
    expect(m.list()[0]!.version).toBeUndefined();
    m.reportVersion("t1", "1.2.3");
    expect(m.list()[0]!.version).toBe("1.2.3");
  });
});
