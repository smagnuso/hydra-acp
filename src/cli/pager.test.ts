import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { openPager } from "./pager.js";

interface FakeChild extends EventEmitter {
  stdin: PassThrough;
}

function fakeSpawn(): {
  spawn: ReturnType<typeof vi.fn>;
  child: FakeChild;
  finish: () => void;
} {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  const spawn = vi.fn().mockReturnValue(child);
  const finish = (): void => {
    child.stdin.end();
    child.emit("exit", 0);
  };
  return { spawn, child, finish };
}

describe("openPager", () => {
  it("returns process.stdout when stdout is not a TTY", async () => {
    const fake = fakeSpawn();
    const handle = openPager({
      isTTY: false,
      env: { PAGER: "less" },
      spawn: fake.spawn as unknown as typeof import("node:child_process").spawn,
    });
    expect(handle.stream).toBe(process.stdout);
    expect(fake.spawn).not.toHaveBeenCalled();
    await handle.flush();
  });

  it("returns process.stdout when disabled is true even on a TTY", async () => {
    const fake = fakeSpawn();
    const handle = openPager({
      isTTY: true,
      disabled: true,
      env: { PAGER: "less" },
      spawn: fake.spawn as unknown as typeof import("node:child_process").spawn,
    });
    expect(handle.stream).toBe(process.stdout);
    expect(fake.spawn).not.toHaveBeenCalled();
    await handle.flush();
  });

  it("spawns the pager from $PAGER on a TTY", async () => {
    const fake = fakeSpawn();
    const handle = openPager({
      isTTY: true,
      env: { PAGER: "my-pager" },
      spawn: fake.spawn as unknown as typeof import("node:child_process").spawn,
    });
    expect(fake.spawn).toHaveBeenCalledTimes(1);
    expect(fake.spawn.mock.calls[0]![0]).toBe("my-pager");
    handle.stream.write("hello");
    const collected: Buffer[] = [];
    fake.child.stdin.on("data", (chunk: Buffer) => collected.push(chunk));
    const flushPromise = handle.flush();
    fake.finish();
    await flushPromise;
    expect(Buffer.concat(collected).toString()).toBe("hello");
  });

  it("prefers HYDRA_ACP_PAGER over PAGER", async () => {
    const fake = fakeSpawn();
    openPager({
      isTTY: true,
      env: { HYDRA_ACP_PAGER: "hp", PAGER: "fallback" },
      spawn: fake.spawn as unknown as typeof import("node:child_process").spawn,
    });
    expect(fake.spawn.mock.calls[0]![0]).toBe("hp");
  });

  it("falls back to 'less' when no pager env var is set", async () => {
    const fake = fakeSpawn();
    openPager({
      isTTY: true,
      env: {},
      spawn: fake.spawn as unknown as typeof import("node:child_process").spawn,
    });
    expect(fake.spawn.mock.calls[0]![0]).toBe("less");
  });

  it("treats an empty PAGER as 'no pager'", async () => {
    const fake = fakeSpawn();
    const handle = openPager({
      isTTY: true,
      env: { PAGER: "" },
      spawn: fake.spawn as unknown as typeof import("node:child_process").spawn,
    });
    expect(handle.stream).toBe(process.stdout);
    expect(fake.spawn).not.toHaveBeenCalled();
  });

  it("sets LESS=FRX in the child env when not already set", async () => {
    const fake = fakeSpawn();
    openPager({
      isTTY: true,
      env: {},
      spawn: fake.spawn as unknown as typeof import("node:child_process").spawn,
    });
    const childOpts = fake.spawn.mock.calls[0]![2] as { env: NodeJS.ProcessEnv };
    expect(childOpts.env.LESS).toBe("FRX");
  });

  it("respects an explicit LESS env var", async () => {
    const fake = fakeSpawn();
    openPager({
      isTTY: true,
      env: { LESS: "S" },
      spawn: fake.spawn as unknown as typeof import("node:child_process").spawn,
    });
    const childOpts = fake.spawn.mock.calls[0]![2] as { env: NodeJS.ProcessEnv };
    expect(childOpts.env.LESS).toBe("S");
  });

  it("swallows EPIPE when the pager quits early", async () => {
    const fake = fakeSpawn();
    const handle = openPager({
      isTTY: true,
      env: { PAGER: "less" },
      spawn: fake.spawn as unknown as typeof import("node:child_process").spawn,
    });
    // Simulate the pager exiting (user hit q): the child's stdin emits
    // EPIPE on the next write. We listen on the wrapper for an
    // unhandled error — the helper should swallow it.
    let unhandled = false;
    handle.stream.on("error", () => {
      unhandled = true;
    });
    fake.child.stdin.emit("error", Object.assign(new Error("epipe"), { code: "EPIPE" }));
    handle.stream.write("after-quit");
    fake.finish();
    await handle.flush();
    expect(unhandled).toBe(false);
  });

  it("flush() resolves after the child exits", async () => {
    const fake = fakeSpawn();
    const handle = openPager({
      isTTY: true,
      env: { PAGER: "less" },
      spawn: fake.spawn as unknown as typeof import("node:child_process").spawn,
    });
    handle.stream.write("done");
    let resolved = false;
    const flushPromise = handle.flush().then(() => {
      resolved = true;
    });
    // Before the child exits, flush should not have resolved.
    await new Promise((r) => setImmediate(r));
    expect(resolved).toBe(false);
    fake.finish();
    await flushPromise;
    expect(resolved).toBe(true);
  });
});
