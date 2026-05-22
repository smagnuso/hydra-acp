// Burst-based stdin batching for `hydra-acp cat`.
//
// Stdin doesn't tell us "the input is bounded" or "the input is a
// stream" — it just emits "data" events as bytes become available, and
// eventually an "end" event when the writer closes its end. The
// chunker rides that natural rhythm:
//
//   - On each "data" event, append to the buffer and schedule a flush
//     check.
//   - The flush check runs on `setImmediate` (or whatever scheduler is
//     injected) — i.e. AFTER any pending I/O has been polled. If a new
//     "data" event landed before the scheduler fired, the burst is
//     still going and the check sees a fresh "data arrived" flag, so it
//     re-schedules instead of flushing. The buffer keeps growing.
//   - When the scheduler finally runs without a new "data" event having
//     arrived in the meantime, the kernel pipe buffer is drained — the
//     writer paused — and we flush the buffer as one chunk.
//   - On EOF, any buffered data is flushed as a final chunk.
//
// This means:
//   `cat netflix.log | hydra cat -p "..."`  → one chunk of the full
//      file (cat blasts back-to-back; setImmediate never sees a quiet
//      moment until EOF).
//   `tail -f app.log | hydra cat -p "..."`  → one chunk per
//      tail-emitted burst (each line triggers a "data" then a quiet
//      gap, so setImmediate flushes between lines).
//   `cat huge.log | hydra cat -p "..."`     → one chunk no matter how
//      big the file. If it exceeds the model's context window, the
//      agent's API will reject it — that's the agent's job to enforce,
//      not ours to pre-empt with arbitrary byte slicing.
//
// The chunker itself does no I/O — callers drive it by calling
// feed/eof and reacting to onChunk callbacks. That keeps it
// test-friendly and lets the cat command focus on wiring stdin →
// chunker → JSON-RPC.
export interface ChunkerOptions {
  // Scheduler used to defer flush checks until after the current I/O
  // turn. Defaults to setImmediate in cat.ts; tests inject a manual
  // scheduler so they can step through bursts deterministically.
  // Returns a cancel function in case the chunker needs to abandon a
  // scheduled flush (none of the current call sites do, but the API
  // mirrors the prior `setTimer` shape so tests look familiar).
  scheduleFlushCheck: (cb: () => void) => () => void;
  onChunk: (text: string) => void;
}

export interface Chunker {
  feed: (data: string) => void;
  eof: () => void;
}

export function createChunker(opts: ChunkerOptions): Chunker {
  let buffer = "";
  // Set to true by `feed` ONLY AFTER a check has already been
  // scheduled — i.e. the check captured a snapshot of the buffer, and
  // then more data arrived before it ran. The check clears the flag
  // and re-defers in that case; otherwise it flushes.
  //
  // The first feed of a burst doesn't set this — it just schedules
  // the check. Only subsequent feeds, while a check is in flight, do.
  let dataArrivedSinceSchedule = false;
  let scheduled = false;
  let ended = false;

  const flush = (): void => {
    if (buffer.length === 0) {
      return;
    }
    const out = buffer;
    buffer = "";
    opts.onChunk(out);
  };

  const scheduleCheck = (): void => {
    if (scheduled) {
      return;
    }
    scheduled = true;
    // Reset the "new data" flag now, BEFORE the scheduler runs. Any
    // feed that lands between now and the check firing will set it
    // back to true and cause the check to re-defer instead of flush.
    dataArrivedSinceSchedule = false;
    opts.scheduleFlushCheck(() => {
      scheduled = false;
      if (dataArrivedSinceSchedule) {
        // More data arrived while we were waiting — burst is still
        // going. Re-schedule with a fresh snapshot.
        scheduleCheck();
        return;
      }
      flush();
    });
  };

  return {
    feed(data: string): void {
      if (ended || data.length === 0) {
        return;
      }
      buffer += data;
      // If a check is already scheduled, this feed is "new since"
      // that schedule and the check must defer. If no check is
      // scheduled, scheduleCheck() will set up a fresh snapshot.
      if (scheduled) {
        dataArrivedSinceSchedule = true;
      } else {
        scheduleCheck();
      }
    },
    eof(): void {
      if (ended) {
        return;
      }
      ended = true;
      flush();
    },
  };
}
