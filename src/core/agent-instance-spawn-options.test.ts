import { EventEmitter, PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock };
});

import { AgentInstance } from "./agent-instance.js";
import { onPlatform } from "./platform-stub.js";

function fakeChild(): EventEmitter {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  child["stdin"] = new PassThrough();
  child["stdout"] = new PassThrough();
  child["stderr"] = new PassThrough();
  child["pid"] = 4242;
  child["unref"] = () => undefined;
  child["kill"] = () => true;
  return child;
}

describe("agent spawn options", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => fakeChild());
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const spawnOptions = (): Record<string, unknown> =>
    spawnMock.mock.calls[0]![2] as Record<string, unknown>;

  const plan = { command: "agent", args: [], env: {}, version: "test" };

  it("is not detached on Windows, so windowsHide can keep a .cmd shim's console hidden", async () => {
    await onPlatform("win32", () => {
      AgentInstance.spawn({ agentId: "a", cwd: process.cwd(), plan });
    });
    expect(spawnOptions()["windowsHide"]).toBe(true);
    expect(spawnOptions()["detached"]).toBe(false);
  });

  it("stays detached into its own session elsewhere", async () => {
    await onPlatform("linux", () => {
      AgentInstance.spawn({ agentId: "a", cwd: process.cwd(), plan });
    });
    expect(spawnOptions()["detached"]).toBe(true);
  });
});
