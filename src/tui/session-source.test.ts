import { describe, expect, it } from "vitest";
import type { DiscoveredSession } from "./discovery.js";
import { createSessionSource } from "./session-source.js";

const one = [{ sessionId: "s1" } as DiscoveredSession];
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("createSessionSource", () => {
  it("answers empty first, fetches in the background, then serves the cache", async () => {
    let calls = 0;
    const src = createSessionSource(async () => {
      calls += 1;
      return one;
    });
    expect(src.get()).toEqual([]);
    await tick();
    expect(src.get()).toBe(one);
    expect(calls).toBe(1);
  });

  it("does not refetch inside the ttl, and refetches once it is stale", async () => {
    let calls = 0;
    let t = 0;
    const src = createSessionSource(async () => (calls++, one), 1000, () => t);
    src.get();
    await tick();
    t = 500;
    src.get();
    await tick();
    expect(calls).toBe(1);
    t = 1500;
    src.get();
    await tick();
    expect(calls).toBe(2);
  });

  it("keeps the old list when a refresh fails, and retries only after the ttl", async () => {
    let calls = 0;
    let t = 0;
    const src = createSessionSource(
      async () => {
        calls += 1;
        if (calls === 2) {
          throw new Error("down");
        }
        return one;
      },
      1000,
      () => t,
    );
    src.get();
    await tick();
    t = 2000;
    src.get();
    await tick();
    expect(src.get()).toBe(one);
    expect(calls).toBe(2);
    t = 2100;
    src.get();
    await tick();
    expect(calls).toBe(2);
  });

  it("does not start a second fetch while one is in flight", async () => {
    let calls = 0;
    let release: () => void = () => {};
    const src = createSessionSource(
      () =>
        new Promise<DiscoveredSession[]>((resolve) => {
          calls += 1;
          release = () => resolve(one);
        }),
      0,
    );
    src.get();
    src.get();
    src.get();
    expect(calls).toBe(1);
    release();
    await tick();
  });
});
