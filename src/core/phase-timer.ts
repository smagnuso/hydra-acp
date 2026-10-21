// Wall-clock phase recorder for latency investigations. mark(name) closes
// the phase that has been running since the previous mark (or construction).
// Phases are laid end to end, so they sum to the total.
export class PhaseTimer {
  private readonly started = performance.now();
  private last = this.started;
  private readonly phases: Array<[string, number]> = [];

  mark(name: string): void {
    const now = performance.now();
    this.phases.push([name, now - this.last]);
    this.last = now;
  }

  // Folds another timer's phases in under a prefix, for nested stages.
  absorb(prefix: string, other: PhaseTimer): void {
    for (const [name, ms] of other.phases) {
      this.phases.push([`${prefix}.${name}`, ms]);
    }
    this.last = performance.now();
  }

  totalMs(): number {
    return performance.now() - this.started;
  }

  summary(): string {
    const parts = this.phases.map(([name, ms]) => `${name}=${Math.round(ms)}ms`);
    return `total=${Math.round(this.totalMs())}ms ${parts.join(" ")}`;
  }
}
