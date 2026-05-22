import { describe, it, expect } from "vitest";
import { createChunker } from "./cat-chunker.js";

// Tiny manual scheduler so the burst-detection logic can be exercised
// deterministically. Each scheduleFlushCheck call queues a callback;
// runOne() fires the oldest queued callback. That lets a test simulate
// "data, data, then a quiet moment when setImmediate fires."
function makeScheduler() {
  const queue: Array<() => void> = [];
  return {
    schedule: (cb: () => void): (() => void) => {
      queue.push(cb);
      const idx = queue.length - 1;
      return () => {
        // Mark as no-op; we don't actually remove because no current
        // call site cancels and shifting indices would be a mess. None
        // of the tests need this either, but keep the API symmetric
        // with the production setImmediate path.
        queue[idx] = () => undefined;
      };
    },
    pending: queue,
    runOne: (): boolean => {
      const cb = queue.shift();
      if (!cb) {
        return false;
      }
      cb();
      return true;
    },
    runAll: (): number => {
      let n = 0;
      while (queue.length > 0) {
        const cb = queue.shift()!;
        cb();
        n += 1;
      }
      return n;
    },
  };
}

describe("createChunker", () => {
  it("buffers a single feed and flushes when the scheduler fires", () => {
    const sched = makeScheduler();
    const chunks: string[] = [];
    const ch = createChunker({
      scheduleFlushCheck: sched.schedule,
      onChunk: (t) => chunks.push(t),
    });
    ch.feed("hello world\n");
    expect(chunks).toEqual([]);
    sched.runOne();
    expect(chunks).toEqual(["hello world\n"]);
  });

  it("coalesces back-to-back feeds into one chunk (burst case)", () => {
    // Simulates `cat huge.log | hydra cat`: many "data" events arrive
    // before the scheduler runs, all part of one burst.
    const sched = makeScheduler();
    const chunks: string[] = [];
    const ch = createChunker({
      scheduleFlushCheck: sched.schedule,
      onChunk: (t) => chunks.push(t),
    });
    ch.feed("part1 ");
    ch.feed("part2 ");
    ch.feed("part3");
    // Multiple feeds piled up while one flush was scheduled. The
    // first scheduled callback sees dataArrivedSinceSchedule=true,
    // re-schedules itself.
    sched.runOne();
    expect(chunks).toEqual([]);
    // Second run sees no new data → flushes.
    sched.runOne();
    expect(chunks).toEqual(["part1 part2 part3"]);
  });

  it("flushes between independent bursts (streaming case)", () => {
    // Simulates `tail -f`: one line, quiet, next line, quiet.
    const sched = makeScheduler();
    const chunks: string[] = [];
    const ch = createChunker({
      scheduleFlushCheck: sched.schedule,
      onChunk: (t) => chunks.push(t),
    });
    ch.feed("line one\n");
    sched.runOne();
    expect(chunks).toEqual(["line one\n"]);
    ch.feed("line two\n");
    sched.runOne();
    expect(chunks).toEqual(["line one\n", "line two\n"]);
  });

  it("re-schedules when data arrives between scheduling and the check firing", () => {
    // Verifies the burst-extension semantics in detail: when a feed
    // happens AFTER the scheduler has captured the flush callback but
    // BEFORE that callback runs, the chunker should re-schedule
    // instead of flushing the partial buffer.
    const sched = makeScheduler();
    const chunks: string[] = [];
    const ch = createChunker({
      scheduleFlushCheck: sched.schedule,
      onChunk: (t) => chunks.push(t),
    });
    ch.feed("a");
    // The scheduled flush callback is now in sched.pending. Simulate
    // "more data arrived before the scheduler fired" by feeding
    // again without running the queue.
    ch.feed("b");
    // Now run the scheduler. The callback sees
    // dataArrivedSinceSchedule=true and re-schedules; no chunk yet.
    sched.runOne();
    expect(chunks).toEqual([]);
    // The re-scheduled callback is now pending. No more feeds → it
    // flushes.
    sched.runOne();
    expect(chunks).toEqual(["ab"]);
  });

  it("emits any leftover buffered text on eof", () => {
    const sched = makeScheduler();
    const chunks: string[] = [];
    const ch = createChunker({
      scheduleFlushCheck: sched.schedule,
      onChunk: (t) => chunks.push(t),
    });
    ch.feed("hi");
    // EOF before the scheduler runs — flush immediately, don't wait.
    ch.eof();
    expect(chunks).toEqual(["hi"]);
  });

  it("ignores feeds after eof", () => {
    const sched = makeScheduler();
    const chunks: string[] = [];
    const ch = createChunker({
      scheduleFlushCheck: sched.schedule,
      onChunk: (t) => chunks.push(t),
    });
    ch.feed("a");
    ch.eof();
    ch.feed("b");
    ch.eof();
    expect(chunks).toEqual(["a"]);
  });

  it("does not emit when stdin closes empty", () => {
    const sched = makeScheduler();
    const chunks: string[] = [];
    const ch = createChunker({
      scheduleFlushCheck: sched.schedule,
      onChunk: (t) => chunks.push(t),
    });
    ch.eof();
    expect(chunks).toEqual([]);
  });

  it("flushes everything buffered as one chunk on EOF even after a long burst", () => {
    // Bounded-but-large input: many feeds during one burst, then EOF
    // arrives. Should emit exactly one chunk with the whole input.
    const sched = makeScheduler();
    const chunks: string[] = [];
    const ch = createChunker({
      scheduleFlushCheck: sched.schedule,
      onChunk: (t) => chunks.push(t),
    });
    for (let i = 0; i < 50; i += 1) {
      ch.feed(`chunk${i} `);
    }
    // EOF before any scheduler tick fires — the burst hasn't
    // "ended" by quiet detection, but EOF is unambiguous.
    ch.eof();
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("chunk0 ");
    expect(chunks[0]).toContain("chunk49 ");
    // Any pending scheduler callbacks should be no-ops now (buffer
    // already flushed; running them must not emit again).
    sched.runAll();
    expect(chunks).toHaveLength(1);
  });
});
