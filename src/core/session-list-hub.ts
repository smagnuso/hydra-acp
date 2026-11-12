// Coalesces "something a session list row shows may have changed" into one
// tick per window. It carries no data: each subscriber re-reads what it
// needs on a tick, so a subscriber with its own filter and cursor sees a
// consistent view and a missed tick is healed by the next.
export class SessionListHub {
  private subscribers = new Set<() => void>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly windowMs = 100) {}

  subscribe(handler: () => void): () => void {
    this.subscribers.add(handler);
    return () => {
      this.subscribers.delete(handler);
    };
  }

  get size(): number {
    return this.subscribers.size;
  }

  poke(): void {
    if (this.timer !== null || this.subscribers.size === 0) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      for (const handler of [...this.subscribers]) {
        try {
          handler();
        } catch {
          void 0;
        }
      }
    }, this.windowMs);
    this.timer.unref?.();
  }

  dispose(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.subscribers.clear();
  }
}
