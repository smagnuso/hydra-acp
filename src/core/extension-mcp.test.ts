import { describe, it, expect } from "vitest";
import type { JsonRpcConnection } from "../acp/connection.js";
import {
  ExtensionMcpRegistry,
  type ExtensionMcpChangeKind,
} from "./extension-mcp.js";

// Stand-in for JsonRpcConnection. The registry only stores the reference;
// it never invokes methods on it, so a tag is enough for identity checks.
function fakeConn(tag: string): JsonRpcConnection {
  return { __tag: tag } as unknown as JsonRpcConnection;
}

describe("ExtensionMcpRegistry — register/lookup/clear", () => {
  it("register then lookup returns the entry", () => {
    const reg = new ExtensionMcpRegistry();
    const conn = fakeConn("memory");
    reg.register("memory", conn, "search past sessions", [
      { name: "search", description: "find stuff", inputSchema: {} },
    ]);
    const entry = reg.lookup("memory");
    expect(entry).toBeDefined();
    expect(entry!.connection).toBe(conn);
    expect(entry!.instructions).toBe("search past sessions");
    expect(entry!.tools).toEqual([
      { name: "search", description: "find stuff", inputSchema: {} },
    ]);
  });

  it("lookup returns undefined for unknown names", () => {
    const reg = new ExtensionMcpRegistry();
    expect(reg.lookup("ghost")).toBeUndefined();
  });

  it("register for an existing name overwrites tools and instructions", () => {
    const reg = new ExtensionMcpRegistry();
    reg.register("memory", fakeConn("memory"), "v1", [
      { name: "old", description: "old", inputSchema: {} },
    ]);
    const newConn = fakeConn("memory-v2");
    reg.register("memory", newConn, "v2", [
      { name: "new", description: "new", inputSchema: {} },
    ]);
    const entry = reg.lookup("memory");
    expect(entry!.connection).toBe(newConn);
    expect(entry!.instructions).toBe("v2");
    expect(entry!.tools.map((t) => t.name)).toEqual(["new"]);
  });

  it("clear removes the entry; lookup is then undefined", () => {
    const reg = new ExtensionMcpRegistry();
    reg.register("memory", fakeConn("memory"), undefined, [
      { name: "t", description: "", inputSchema: {} },
    ]);
    reg.clear("memory");
    expect(reg.lookup("memory")).toBeUndefined();
  });

  it("clear on an unregistered name is a silent no-op", () => {
    const reg = new ExtensionMcpRegistry();
    expect(() => reg.clear("ghost")).not.toThrow();
  });

  it("tools list is defensively copied (caller mutations don't leak in)", () => {
    const reg = new ExtensionMcpRegistry();
    const tools = [
      { name: "search", description: "find stuff", inputSchema: {} },
    ];
    reg.register("memory", fakeConn("memory"), undefined, tools);
    tools.push({ name: "intruder", description: "", inputSchema: {} });
    const entry = reg.lookup("memory");
    expect(entry!.tools.map((t) => t.name)).toEqual(["search"]);
  });
});

describe("ExtensionMcpRegistry — list", () => {
  it("returns currently-registered extension names", () => {
    const reg = new ExtensionMcpRegistry();
    expect(reg.list()).toEqual([]);
    reg.register("memory", fakeConn("memory"), undefined, [
      { name: "t", description: "", inputSchema: {} },
    ]);
    reg.register("notifier", fakeConn("notifier"), undefined, [
      { name: "t", description: "", inputSchema: {} },
    ]);
    expect(reg.list().sort()).toEqual(["memory", "notifier"]);
    reg.clear("memory");
    expect(reg.list()).toEqual(["notifier"]);
  });
});

describe("ExtensionMcpRegistry — onChange", () => {
  it("fires on register with kind='register' and extName", () => {
    const reg = new ExtensionMcpRegistry();
    const events: Array<[string, ExtensionMcpChangeKind]> = [];
    reg.onChange((n, k) => events.push([n, k]));
    reg.register("memory", fakeConn("memory"), undefined, [
      { name: "t", description: "", inputSchema: {} },
    ]);
    expect(events).toEqual([["memory", "register"]]);
  });

  it("fires on clear with kind='clear' and extName", () => {
    const reg = new ExtensionMcpRegistry();
    reg.register("memory", fakeConn("memory"), undefined, [
      { name: "t", description: "", inputSchema: {} },
    ]);
    const events: Array<[string, ExtensionMcpChangeKind]> = [];
    reg.onChange((n, k) => events.push([n, k]));
    reg.clear("memory");
    expect(events).toEqual([["memory", "clear"]]);
  });

  it("does not fire on clear when the entry didn't exist", () => {
    const reg = new ExtensionMcpRegistry();
    const events: Array<[string, ExtensionMcpChangeKind]> = [];
    reg.onChange((n, k) => events.push([n, k]));
    reg.clear("ghost");
    expect(events).toEqual([]);
  });

  it("fires on re-registration so the route can invalidate stale caches", () => {
    const reg = new ExtensionMcpRegistry();
    const events: Array<[string, ExtensionMcpChangeKind]> = [];
    reg.onChange((n, k) => events.push([n, k]));
    reg.register("memory", fakeConn("v1"), undefined, [
      { name: "t", description: "", inputSchema: {} },
    ]);
    reg.register("memory", fakeConn("v2"), undefined, [
      { name: "t", description: "", inputSchema: {} },
    ]);
    expect(events).toEqual([
      ["memory", "register"],
      ["memory", "register"],
    ]);
  });

  it("unsubscribe stops further notifications", () => {
    const reg = new ExtensionMcpRegistry();
    const events: string[] = [];
    const unsub = reg.onChange((n) => events.push(n));
    reg.register("a", fakeConn("a"), undefined, [
      { name: "t", description: "", inputSchema: {} },
    ]);
    unsub();
    reg.register("b", fakeConn("b"), undefined, [
      { name: "t", description: "", inputSchema: {} },
    ]);
    expect(events).toEqual(["a"]);
  });

  it("a throwing handler does not block other handlers", () => {
    const reg = new ExtensionMcpRegistry();
    const log: string[] = [];
    reg.onChange(() => {
      throw new Error("boom");
    });
    reg.onChange((n) => log.push(n));
    reg.register("memory", fakeConn("memory"), undefined, [
      { name: "t", description: "", inputSchema: {} },
    ]);
    expect(log).toEqual(["memory"]);
  });
});
