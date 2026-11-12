import { describe, it, expect, vi, afterEach } from "vitest";
import { SessionListHub } from "./session-list-hub.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("SessionListHub", () => {
  it("coalesces a burst of pokes into one tick", () => {
    vi.useFakeTimers();
    const hub = new SessionListHub(100);
    const handler = vi.fn();
    hub.subscribe(handler);
    hub.poke();
    hub.poke();
    hub.poke();
    vi.advanceTimersByTime(99);
    expect(handler).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("ticks again for a poke after the window", () => {
    vi.useFakeTimers();
    const hub = new SessionListHub(100);
    const handler = vi.fn();
    hub.subscribe(handler);
    hub.poke();
    vi.advanceTimersByTime(100);
    hub.poke();
    vi.advanceTimersByTime(100);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("schedules nothing without subscribers, and unsubscribe detaches", () => {
    vi.useFakeTimers();
    const hub = new SessionListHub(100);
    const handler = vi.fn();
    hub.poke();
    const off = hub.subscribe(handler);
    expect(hub.size).toBe(1);
    off();
    expect(hub.size).toBe(0);
    hub.poke();
    vi.advanceTimersByTime(200);
    expect(handler).not.toHaveBeenCalled();
  });

  it("a throwing subscriber does not stop the others", () => {
    vi.useFakeTimers();
    const hub = new SessionListHub(10);
    const ok = vi.fn();
    hub.subscribe(() => {
      throw new Error("boom");
    });
    hub.subscribe(ok);
    hub.poke();
    vi.advanceTimersByTime(10);
    expect(ok).toHaveBeenCalled();
  });
});
