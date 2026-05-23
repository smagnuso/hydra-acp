// Per-session ring buffer for piped stdin. Producers (cat --stream)
// append bytes; consumers (the agent, via MCP tools or shell-tool
// reads of a file projection) read against a monotonically increasing
// absolute byte cursor that survives eviction — when the ring wraps
// and a reader's cursor is older than the oldest byte still held, the
// read returns a `gap` count telling the agent exactly how much was
// lost.
//
// In-memory only for v1. Lifetime is the session's: SessionManager
// wires close() into the same closeHandlers path that tears down the
// agent.

import * as fsp from "node:fs/promises";

const DEFAULT_CAPACITY_BYTES = 16 * 1024 * 1024;
// Hard cap on a single read's byte count. Server-enforced even when the
// caller asks for more; one tool call shouldn't blow out the model's
// context.
export const STREAM_READ_MAX_BYTES = 64 * 1024;
// Hard cap on long-poll wait. Avoids holding a connection forever if
// a misbehaving client passes Number.MAX_SAFE_INTEGER.
export const STREAM_WAIT_MAX_MS = 60_000;

export interface StreamReadResult {
  bytes: Buffer;
  nextCursor: number;
  gap?: number;
  eof?: boolean;
}

export interface StreamTailResult {
  bytes: Buffer;
  startCursor: number;
  endCursor: number;
  truncated: boolean;
}

export type WaitOutcome = "data" | "eof" | "timeout";

interface Waiter {
  resolve: (outcome: WaitOutcome) => void;
  timer: NodeJS.Timeout | undefined;
}

export interface StreamBufferOptions {
  capacityBytes?: number;
  // When set, every append is also written to this file path. The buffer
  // does NOT create or truncate the file; the caller is responsible for
  // opening / closing the handle (we just append). Bytes dropped after
  // the soft cap is hit are NOT written to the file either — the file
  // and the ring stay in sync. Errors writing to the file are swallowed
  // (logged via logWriteError if provided) so a flaky disk doesn't kill
  // the in-memory ring.
  filePath?: string;
  // Soft cap on file bytes written. After this many bytes, further
  // appends still land in the ring but are dropped on the floor for the
  // file. Caller is notified via onFileCapReached (once per buffer).
  fileCapBytes?: number;
  onFileCapReached?: () => void;
  logWriteError?: (err: Error) => void;
}

export class SessionStreamBuffer {
  private storage: Buffer;
  private capacityBytes: number;
  // Absolute monotonic byte offset of the next byte to be written. Also
  // the count of bytes ever appended. `writeCursor - capacityBytes`
  // (clamped at 0) is the oldest still-resident byte's cursor.
  private writeCursor = 0;
  private closed = false;
  private waiters: Waiter[] = [];
  private filePath: string | undefined;
  private fileCapBytes: number;
  private fileBytesWritten = 0;
  private fileCapReached = false;
  private onFileCapReached: (() => void) | undefined;
  private logWriteError: ((err: Error) => void) | undefined;
  // Single-flight chain for file appends so concurrent stream_write
  // calls don't interleave their writes.
  private fileWriteChain: Promise<unknown> = Promise.resolve();

  constructor(opts: StreamBufferOptions = {}) {
    this.capacityBytes = opts.capacityBytes ?? DEFAULT_CAPACITY_BYTES;
    if (this.capacityBytes <= 0) {
      throw new Error("capacityBytes must be > 0");
    }
    this.storage = Buffer.alloc(this.capacityBytes);
    this.filePath = opts.filePath;
    this.fileCapBytes = opts.fileCapBytes ?? Number.POSITIVE_INFINITY;
    this.onFileCapReached = opts.onFileCapReached;
    this.logWriteError = opts.logWriteError;
  }

  get capacity(): number {
    return this.capacityBytes;
  }

  get writeCursorPos(): number {
    return this.writeCursor;
  }

  get oldestAvailable(): number {
    return Math.max(0, this.writeCursor - this.capacityBytes);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  // Append-or-noop. Calls after close() are silently dropped (the
  // producer ought not to keep writing, but it's not worth throwing if
  // a chunk arrives late).
  append(chunk: Buffer): void {
    if (this.closed || chunk.length === 0) {
      return;
    }
    this.writeRing(chunk);
    this.writeCursor += chunk.length;
    if (this.filePath !== undefined) {
      this.scheduleFileWrite(chunk);
    }
    this.wakeWaiters("data");
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.wakeWaiters("eof");
  }

  // Read up to `maxBytes` bytes starting at `cursor`. If `cursor` is
  // behind the oldest still-resident byte, gap-skip to the oldest and
  // report how many bytes were dropped. If `cursor` is at writeCursor
  // and the buffer is closed, return eof:true.
  read(cursor: number, maxBytes: number): StreamReadResult {
    const cap = Math.max(0, Math.min(maxBytes, STREAM_READ_MAX_BYTES));
    if (cap === 0) {
      const tail: StreamReadResult = {
        bytes: Buffer.alloc(0),
        nextCursor: cursor,
      };
      if (this.closed && cursor >= this.writeCursor) {
        tail.eof = true;
      }
      return tail;
    }
    let from = cursor;
    let gap = 0;
    const oldest = this.oldestAvailable;
    if (from < oldest) {
      gap = oldest - from;
      from = oldest;
    }
    const available = this.writeCursor - from;
    if (available <= 0) {
      const result: StreamReadResult = {
        bytes: Buffer.alloc(0),
        nextCursor: from,
      };
      if (gap > 0) {
        result.gap = gap;
      }
      if (this.closed) {
        result.eof = true;
      }
      return result;
    }
    const take = Math.min(available, cap);
    const bytes = this.sliceFromRing(from, take);
    const result: StreamReadResult = {
      bytes,
      nextCursor: from + take,
    };
    if (gap > 0) {
      result.gap = gap;
    }
    if (this.closed && from + take >= this.writeCursor) {
      result.eof = true;
    }
    return result;
  }

  // Latest N bytes from the tail, capped at capacity / STREAM_READ_MAX_BYTES.
  // truncated:true when the requested span extends past the oldest
  // still-resident byte (i.e. there was more upstream that we don't have
  // anymore).
  tail(bytes: number): StreamTailResult {
    const want = Math.max(0, Math.min(bytes, STREAM_READ_MAX_BYTES));
    const oldest = this.oldestAvailable;
    const startWant = this.writeCursor - want;
    const start = Math.max(oldest, startWant);
    const truncated = startWant < oldest;
    const slice = this.sliceFromRing(start, this.writeCursor - start);
    return {
      bytes: slice,
      startCursor: start,
      endCursor: this.writeCursor,
      truncated,
    };
  }

  // First N bytes since the stream began. Returns truncated:true when
  // the head has already been evicted (cursor 0 is no longer resident).
  head(bytes: number): StreamTailResult {
    const want = Math.max(0, Math.min(bytes, STREAM_READ_MAX_BYTES));
    const oldest = this.oldestAvailable;
    const truncated = oldest > 0;
    const start = oldest;
    const end = Math.min(this.writeCursor, start + want);
    const slice = this.sliceFromRing(start, end - start);
    return {
      bytes: slice,
      startCursor: start,
      endCursor: end,
      truncated,
    };
  }

  // Long-poll until new bytes arrive past `cursor`, the buffer closes, or
  // the timeout expires. Resolves with "data" / "eof" / "timeout".
  waitForData(cursor: number, timeoutMs: number): Promise<WaitOutcome> {
    if (cursor < this.writeCursor) {
      return Promise.resolve("data");
    }
    if (this.closed) {
      return Promise.resolve("eof");
    }
    const cap = Math.max(0, Math.min(timeoutMs, STREAM_WAIT_MAX_MS));
    if (cap === 0) {
      return Promise.resolve("timeout");
    }
    return new Promise((resolve) => {
      const waiter: Waiter = {
        resolve: (outcome) => {
          if (waiter.timer !== undefined) {
            clearTimeout(waiter.timer);
            waiter.timer = undefined;
          }
          resolve(outcome);
        },
        timer: setTimeout(() => {
          const idx = this.waiters.indexOf(waiter);
          if (idx >= 0) {
            this.waiters.splice(idx, 1);
          }
          waiter.timer = undefined;
          resolve("timeout");
        }, cap),
      };
      this.waiters.push(waiter);
    });
  }

  private wakeWaiters(outcome: WaitOutcome): void {
    if (this.waiters.length === 0) {
      return;
    }
    const wake = this.waiters;
    this.waiters = [];
    for (const w of wake) {
      w.resolve(outcome);
    }
  }

  private writeRing(chunk: Buffer): void {
    const len = chunk.length;
    if (len >= this.capacityBytes) {
      // Chunk larger than the entire buffer — only the tail capacityBytes
      // are retained. Skip the prefix entirely.
      const tailStart = len - this.capacityBytes;
      chunk.copy(this.storage, 0, tailStart, len);
      return;
    }
    const offset = this.writeCursor % this.capacityBytes;
    const tailRoom = this.capacityBytes - offset;
    if (len <= tailRoom) {
      chunk.copy(this.storage, offset, 0, len);
    } else {
      chunk.copy(this.storage, offset, 0, tailRoom);
      chunk.copy(this.storage, 0, tailRoom, len);
    }
  }

  private sliceFromRing(fromCursor: number, length: number): Buffer {
    if (length <= 0) {
      return Buffer.alloc(0);
    }
    const out = Buffer.alloc(length);
    const offset = fromCursor % this.capacityBytes;
    const tailLen = Math.min(length, this.capacityBytes - offset);
    this.storage.copy(out, 0, offset, offset + tailLen);
    if (tailLen < length) {
      this.storage.copy(out, tailLen, 0, length - tailLen);
    }
    return out;
  }

  private scheduleFileWrite(chunk: Buffer): void {
    const path = this.filePath;
    if (path === undefined) {
      return;
    }
    if (this.fileCapReached) {
      return;
    }
    const remaining = this.fileCapBytes - this.fileBytesWritten;
    if (remaining <= 0) {
      this.fileCapReached = true;
      this.onFileCapReached?.();
      return;
    }
    const slice = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
    this.fileBytesWritten += slice.length;
    const willHitCap = this.fileBytesWritten >= this.fileCapBytes;
    this.fileWriteChain = this.fileWriteChain
      .then(() => fsp.appendFile(path, slice))
      .catch((err) => {
        this.logWriteError?.(err as Error);
      });
    if (willHitCap && !this.fileCapReached) {
      this.fileCapReached = true;
      this.onFileCapReached?.();
    }
  }

  // Wait for any pending file appends to flush. Used by tests and by
  // session close handlers that want to ensure the file is durable
  // before unlinking.
  async drainFileWrites(): Promise<void> {
    await this.fileWriteChain.catch(() => undefined);
  }
}
