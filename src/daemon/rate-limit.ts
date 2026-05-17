interface RateEntry {
  fails: number;
  windowStart: number;
}

// Simple per-IP rate limiter for failed auth attempts. Counts failures in
// a sliding window; once the count crosses the threshold inside one
// window, isBlocked() returns true until the window expires. Cleared on
// any successful auth so a legitimate user who fat-fingers a few times
// doesn't get locked out.
export class AuthRateLimiter {
  private entries = new Map<string, RateEntry>();
  private readonly maxFails: number;
  private readonly windowMs: number;

  constructor(maxFails = 10, windowMs = 15 * 60 * 1000) {
    this.maxFails = maxFails;
    this.windowMs = windowMs;
  }

  isBlocked(ip: string): boolean {
    const e = this.entries.get(ip);
    if (!e) {
      return false;
    }
    if (Date.now() - e.windowStart > this.windowMs) {
      this.entries.delete(ip);
      return false;
    }
    return e.fails >= this.maxFails;
  }

  recordFailure(ip: string): void {
    const now = Date.now();
    const e = this.entries.get(ip);
    if (!e || now - e.windowStart > this.windowMs) {
      this.entries.set(ip, { fails: 1, windowStart: now });
      return;
    }
    e.fails += 1;
  }

  recordSuccess(ip: string): void {
    this.entries.delete(ip);
  }
}
