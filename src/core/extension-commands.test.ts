import { describe, it, expect, vi } from "vitest";
import { ExtensionCommandRegistry } from "./extension-commands.js";
import type { JsonRpcConnection } from "../acp/connection.js";

function fakeConnection(): JsonRpcConnection {
  return { request: vi.fn() } as unknown as JsonRpcConnection;
}

describe("ExtensionCommandRegistry", () => {
  it("register() stores the connection and command list", () => {
    const reg = new ExtensionCommandRegistry();
    const conn = fakeConnection();
    reg.register("budgeter", conn, [
      { verb: "reset", description: "Reset spend" },
    ]);
    expect(reg.has("budgeter")).toBe(true);
    const entry = reg.get("budgeter")!;
    expect(entry.connection).toBe(conn);
    expect(entry.commands).toEqual([
      { verb: "reset", description: "Reset spend" },
    ]);
  });

  it("clear() removes the entry and reports change", () => {
    const reg = new ExtensionCommandRegistry();
    reg.register("budgeter", fakeConnection(), [{ verb: "reset" }]);
    expect(reg.has("budgeter")).toBe(true);
    reg.clear("budgeter");
    expect(reg.has("budgeter")).toBe(false);
  });

  it("re-register overwrites the prior entry's command list", () => {
    const reg = new ExtensionCommandRegistry();
    reg.register("budgeter", fakeConnection(), [{ verb: "reset" }]);
    reg.register("budgeter", fakeConnection(), [
      { verb: "status" },
      { verb: "reset" },
    ]);
    const entry = reg.get("budgeter")!;
    expect(entry.commands.map((c) => c.verb)).toEqual(["status", "reset"]);
  });

  it("list() flattens (name, command) pairs across processes", () => {
    const reg = new ExtensionCommandRegistry();
    reg.register("a", fakeConnection(), [
      { verb: "one" },
      { verb: "two" },
    ]);
    reg.register("b", fakeConnection(), [{ verb: "three" }]);
    expect(reg.list().map((e) => `${e.name}.${e.command.verb}`)).toEqual([
      "a.one",
      "a.two",
      "b.three",
    ]);
  });

  it("onChange fires on register and on clear", () => {
    const reg = new ExtensionCommandRegistry();
    const handler = vi.fn();
    reg.onChange(handler);
    reg.register("budgeter", fakeConnection(), [{ verb: "reset" }]);
    expect(handler).toHaveBeenCalledTimes(1);
    reg.clear("budgeter");
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("onChange does not fire when clearing a name that was never registered", () => {
    const reg = new ExtensionCommandRegistry();
    const handler = vi.fn();
    reg.onChange(handler);
    reg.clear("ghost");
    expect(handler).not.toHaveBeenCalled();
  });

  it("returned unsubscribe function detaches the handler", () => {
    const reg = new ExtensionCommandRegistry();
    const handler = vi.fn();
    const unsubscribe = reg.onChange(handler);
    reg.register("a", fakeConnection(), [{ verb: "x" }]);
    expect(handler).toHaveBeenCalledTimes(1);
    unsubscribe();
    reg.register("b", fakeConnection(), [{ verb: "y" }]);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
