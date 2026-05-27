import { describe, it, expect } from "vitest";
import { Session } from "../../core/session.js";
import { makeMockAgent } from "../../__tests__/test-utils.js";
import { McpTokenRegistry } from "./token-registry.js";

function makeSession(): Session {
  const mock = makeMockAgent({ agentId: "mock", cwd: "/work" });
  return new Session({
    cwd: "/work",
    agentId: "mock",
    agent: mock.agent,
    upstreamSessionId: "u-test",
  });
}

describe("McpTokenRegistry — reserve/complete/abandon", () => {
  it("reserve creates an entry whose session is undefined until complete()", async () => {
    const reg = new McpTokenRegistry();
    const { complete } = reg.reserve("tok");
    const entry = reg.lookup("tok");
    expect(entry).toBeDefined();
    expect(entry!.session).toBeUndefined();
    const session = makeSession();
    complete(session);
    expect(entry!.session).toBe(session);
    await expect(entry!.sessionReady).resolves.toBe(session);
  });

  it("bind is reserve + complete in one call", async () => {
    const reg = new McpTokenRegistry();
    const session = makeSession();
    reg.bind("tok", session);
    const entry = reg.lookup("tok");
    expect(entry!.session).toBe(session);
    await expect(entry!.sessionReady).resolves.toBe(session);
  });

  it("reserve throws on duplicate token", () => {
    const reg = new McpTokenRegistry();
    reg.reserve("tok");
    expect(() => reg.reserve("tok")).toThrow();
  });

  it("abandon removes the entry and rejects sessionReady", async () => {
    const reg = new McpTokenRegistry();
    const { abandon } = reg.reserve("tok");
    const entry = reg.lookup("tok");
    abandon(new Error("create failed"));
    expect(reg.lookup("tok")).toBeUndefined();
    await expect(entry!.sessionReady).rejects.toThrow(/create failed/);
  });

  it("abandon without a reason uses a default message", async () => {
    const reg = new McpTokenRegistry();
    const { abandon } = reg.reserve("tok");
    const entry = reg.lookup("tok");
    abandon();
    await expect(entry!.sessionReady).rejects.toThrow(/abandoned/);
  });
});

describe("McpTokenRegistry — unbind / disposers", () => {
  it("unbind drops the entry and is idempotent", async () => {
    const reg = new McpTokenRegistry();
    reg.bind("tok", makeSession());
    expect(reg.lookup("tok")).toBeDefined();
    await reg.unbind("tok");
    expect(reg.lookup("tok")).toBeUndefined();
    await reg.unbind("tok");
  });

  it("unbind fires registered disposers in registration order", async () => {
    const reg = new McpTokenRegistry();
    reg.bind("tok", makeSession());
    const order: number[] = [];
    reg.addDisposer("tok", async () => {
      order.push(1);
    });
    reg.addDisposer("tok", async () => {
      order.push(2);
    });
    reg.addDisposer("tok", async () => {
      order.push(3);
    });
    await reg.unbind("tok");
    expect(order).toEqual([1, 2, 3]);
  });

  it("a throwing disposer does not prevent later disposers from running", async () => {
    const reg = new McpTokenRegistry();
    reg.bind("tok", makeSession());
    const after: number[] = [];
    reg.addDisposer("tok", async () => {
      throw new Error("boom");
    });
    reg.addDisposer("tok", async () => {
      after.push(1);
    });
    await reg.unbind("tok");
    expect(after).toEqual([1]);
  });

  it("addDisposer after unbind is a silent no-op", async () => {
    const reg = new McpTokenRegistry();
    reg.bind("tok", makeSession());
    await reg.unbind("tok");
    expect(() =>
      reg.addDisposer("tok", async () => {
        // never runs
      }),
    ).not.toThrow();
  });

  it("addDisposer on an unknown token is a silent no-op", () => {
    const reg = new McpTokenRegistry();
    expect(() =>
      reg.addDisposer("ghost", async () => {
        // never runs
      }),
    ).not.toThrow();
  });
});

describe("McpTokenRegistry — size", () => {
  it("size reflects only currently-bound tokens", async () => {
    const reg = new McpTokenRegistry();
    expect(reg.size()).toBe(0);
    reg.bind("a", makeSession());
    reg.bind("b", makeSession());
    expect(reg.size()).toBe(2);
    await reg.unbind("a");
    expect(reg.size()).toBe(1);
    const { abandon } = reg.reserve("c");
    expect(reg.size()).toBe(2);
    abandon();
    expect(reg.size()).toBe(1);
  });
});
