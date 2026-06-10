import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthRateLimiter } from "./rate-limit.js";

describe("AuthRateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sweepExpired drops entries whose window has elapsed", () => {
    const limiter = new AuthRateLimiter(3, 60_000);
    limiter.recordFailure("10.0.0.1");
    limiter.recordFailure("10.0.0.2");
    expect(limiter.isBlocked("10.0.0.1")).toBe(false);

    vi.advanceTimersByTime(60_001);
    limiter.recordFailure("10.0.0.3");

    limiter.sweepExpired();

    // The two expired IPs should be gone; recording a failure again starts
    // a fresh window for them, while 10.0.0.3 remains in its window.
    const internal = limiter as unknown as { entries: Map<string, unknown> };
    expect(internal.entries.has("10.0.0.1")).toBe(false);
    expect(internal.entries.has("10.0.0.2")).toBe(false);
    expect(internal.entries.has("10.0.0.3")).toBe(true);
  });

  it("sweepExpired leaves still-valid entries intact", () => {
    const limiter = new AuthRateLimiter(3, 60_000);
    limiter.recordFailure("10.0.0.1");
    limiter.recordFailure("10.0.0.1");
    limiter.recordFailure("10.0.0.1");
    expect(limiter.isBlocked("10.0.0.1")).toBe(true);
    limiter.sweepExpired();
    expect(limiter.isBlocked("10.0.0.1")).toBe(true);
  });
});
