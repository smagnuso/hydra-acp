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

const DEFAULT_CAPACITY_BYTES = 64 * 1024 * 1024;
// Initial allocation. Grows by doubling until it hits the configured
// cap. Bounded so a session that pipes 100 bytes doesn't pay 64 MiB of
// daemon RAM up front.
const INITIAL_CAPACITY_BYTES = 1 * 1024 * 1024;
// Hard cap on a single read's byte count. Server-enforced even when the
// caller asks for more; one tool call shouldn't blow out the model's
// context.
export const STREAM_READ_MAX_BYTES = 64 * 1024;
// Hard cap on long-poll wait. Avoids holding a connection forever if
// a misbehaving client passes Number.MAX_SAFE_INTEGER.
export const STREAM_WAIT_MAX_MS = 60_000;

export const STREAM_GREP_DEFAULT_MATCHES = 100;
export const STREAM_GREP_MAX_MATCHES = 1000;
export const STREAM_GREP_DEFAULT_BYTES = 64 * 1024;
export const STREAM_GREP_MAX_BYTES = 256 * 1024;
export const STREAM_GREP_MAX_CONTEXT = 20;

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

export interface StreamGrepLine {
  cursor: number;
  line: string;
}

export interface StreamGrepMatch extends StreamGrepLine {
  before?: StreamGrepLine[];
  after?: StreamGrepLine[];
}

export interface StreamGrepResult {
  matches: StreamGrepMatch[];
  truncated: boolean;
  nextCursor: number;
  gap?: number;
  scannedBytes: number;
  eof?: boolean;
}

export interface StreamGrepOptions {
  pattern: string;
  regex?: boolean;
  caseInsensitive?: boolean;
  invert?: boolean;
  maxMatches?: number;
  maxBytes?: number;
  contextBefore?: number;
  contextAfter?: number;
  cursor?: number;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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
  // The configured cap. Eviction begins once writeCursor exceeds this.
  private maxCapacityBytes: number;
  // The size of the currently-allocated `storage`. Starts at
  // INITIAL_CAPACITY_BYTES (clamped to maxCapacityBytes) and doubles on
  // demand. Once it reaches maxCapacityBytes the ring behaves like a
  // fixed-size buffer; before then, writeCursor < currentCapacityBytes
  // always, so no wrap-around math is in play.
  private currentCapacityBytes: number;
  // Absolute monotonic byte offset of the next byte to be written. Also
  // the count of bytes ever appended. `writeCursor - currentCapacityBytes`
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
  // Single-flight chain for file appends so concurrent stdin writes
  // don't interleave their file writes.
  private fileWriteChain: Promise<unknown> = Promise.resolve();

  constructor(opts: StreamBufferOptions = {}) {
    this.maxCapacityBytes = opts.capacityBytes ?? DEFAULT_CAPACITY_BYTES;
    if (this.maxCapacityBytes <= 0) {
      throw new Error("capacityBytes must be > 0");
    }
    this.currentCapacityBytes = Math.min(
      INITIAL_CAPACITY_BYTES,
      this.maxCapacityBytes,
    );
    this.storage = Buffer.alloc(this.currentCapacityBytes);
    this.filePath = opts.filePath;
    this.fileCapBytes = opts.fileCapBytes ?? Number.POSITIVE_INFINITY;
    this.onFileCapReached = opts.onFileCapReached;
    this.logWriteError = opts.logWriteError;
  }

  get capacity(): number {
    return this.maxCapacityBytes;
  }

  // Currently-allocated storage size (for observability / tests). May be
  // anywhere between INITIAL_CAPACITY_BYTES and capacity.
  get allocatedBytes(): number {
    return this.currentCapacityBytes;
  }

  get writeCursorPos(): number {
    return this.writeCursor;
  }

  get oldestAvailable(): number {
    return Math.max(0, this.writeCursor - this.currentCapacityBytes);
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

  // Scan the resident region line-by-line, returning lines that match
  // `pattern`. Server-side filtering so the agent doesn't have to pull
  // and decode 64 KiB base64 windows just to grep a multi-MB log.
  //
  // Lines are split on `\n` (LF). A trailing partial line (no LF) is
  // skipped when the buffer is still open — its bytes might be the
  // start of a longer line that's still being written — but is treated
  // as a final full line once the buffer is closed.
  //
  // Caps: max 1000 matches and 256 KiB of output bytes per call. The
  // agent should re-call with `cursor = nextCursor` to resume when
  // `truncated:true`.
  grep(opts: StreamGrepOptions): StreamGrepResult {
    const oldest = this.oldestAvailable;
    const requested = opts.cursor;
    let start = requested ?? oldest;
    let gap = 0;
    if (requested !== undefined && requested < oldest) {
      gap = oldest - requested;
      start = oldest;
    }
    if (start > this.writeCursor) {
      start = this.writeCursor;
    }
    const slice = this.sliceFromRing(start, this.writeCursor - start);
    const useRegex = opts.regex ?? true;
    const flags = opts.caseInsensitive === true ? "i" : "";
    const re = useRegex
      ? new RegExp(opts.pattern, flags)
      : new RegExp(escapeRegex(opts.pattern), flags);
    const invert = opts.invert ?? false;
    const maxMatches = Math.max(
      1,
      Math.min(
        opts.maxMatches ?? STREAM_GREP_DEFAULT_MATCHES,
        STREAM_GREP_MAX_MATCHES,
      ),
    );
    const maxBytes = Math.max(
      1,
      Math.min(opts.maxBytes ?? STREAM_GREP_DEFAULT_BYTES, STREAM_GREP_MAX_BYTES),
    );
    const contextBefore = Math.max(
      0,
      Math.min(opts.contextBefore ?? 0, STREAM_GREP_MAX_CONTEXT),
    );
    const contextAfter = Math.max(
      0,
      Math.min(opts.contextAfter ?? 0, STREAM_GREP_MAX_CONTEXT),
    );

    const matches: StreamGrepMatch[] = [];
    const beforeRing: StreamGrepLine[] = [];
    const pendingAfter: Array<{ match: StreamGrepMatch; remaining: number }> =
      [];
    let bytesUsed = 0;
    let truncated = false;
    let lineStartByte = 0;
    let resumeFromLineStart = 0;

    const processLine = (lineCursor: number, lineText: string): boolean => {
      for (const pa of pendingAfter) {
        if (pa.remaining > 0) {
          if (pa.match.after === undefined) {
            pa.match.after = [];
          }
          pa.match.after.push({ cursor: lineCursor, line: lineText });
          pa.remaining--;
          bytesUsed += lineText.length;
        }
      }
      while (pendingAfter.length > 0 && pendingAfter[0]!.remaining === 0) {
        pendingAfter.shift();
      }
      const matched = re.test(lineText) !== invert;
      if (matched && matches.length < maxMatches) {
        const m: StreamGrepMatch = { cursor: lineCursor, line: lineText };
        if (contextBefore > 0 && beforeRing.length > 0) {
          m.before = beforeRing.slice();
          for (const b of m.before) {
            bytesUsed += b.line.length;
          }
        }
        bytesUsed += lineText.length;
        matches.push(m);
        if (contextAfter > 0) {
          pendingAfter.push({ match: m, remaining: contextAfter });
        }
      }
      if (contextBefore > 0) {
        beforeRing.push({ cursor: lineCursor, line: lineText });
        while (beforeRing.length > contextBefore) {
          beforeRing.shift();
        }
      }
      const hitMaxMatches =
        matches.length >= maxMatches && pendingAfter.length === 0;
      const hitMaxBytes = bytesUsed >= maxBytes;
      return hitMaxMatches || hitMaxBytes;
    };

    for (let i = 0; i < slice.length; i++) {
      if (slice[i] !== 0x0a) {
        continue;
      }
      const lineText = slice.subarray(lineStartByte, i).toString("utf8");
      const lineCursor = start + lineStartByte;
      lineStartByte = i + 1;
      resumeFromLineStart = lineStartByte;
      if (processLine(lineCursor, lineText)) {
        truncated = true;
        break;
      }
    }
    if (!truncated && lineStartByte < slice.length && this.closed) {
      const lineText = slice.subarray(lineStartByte).toString("utf8");
      const lineCursor = start + lineStartByte;
      if (processLine(lineCursor, lineText)) {
        truncated = true;
      }
      resumeFromLineStart = slice.length;
    }

    const nextCursor = Math.min(start + resumeFromLineStart, this.writeCursor);
    const result: StreamGrepResult = {
      matches,
      truncated,
      nextCursor,
      scannedBytes: resumeFromLineStart,
    };
    if (gap > 0) {
      result.gap = gap;
    }
    if (this.closed && nextCursor >= this.writeCursor) {
      result.eof = true;
    }
    return result;
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

  // Grow `storage` if needed to fit `additionalBytes` more bytes without
  // wrapping. Caps at maxCapacityBytes; once we're at the cap, callers
  // fall back to ring-wrap behavior. Doubles each grow so we amortize.
  // Only called before we've ever wrapped (writeCursor < currentCapacity
  // always holds while we're growing), so the existing bytes live at
  // storage[0..writeCursor] and we can just copy them flat.
  private growIfNeeded(additionalBytes: number): void {
    if (this.currentCapacityBytes >= this.maxCapacityBytes) {
      return;
    }
    const needed = this.writeCursor + additionalBytes;
    if (needed <= this.currentCapacityBytes) {
      return;
    }
    let next = this.currentCapacityBytes;
    while (next < needed && next < this.maxCapacityBytes) {
      next = Math.min(this.maxCapacityBytes, next * 2);
    }
    if (next === this.currentCapacityBytes) {
      return;
    }
    const newStorage = Buffer.alloc(next);
    this.storage.copy(newStorage, 0, 0, this.writeCursor);
    this.storage = newStorage;
    this.currentCapacityBytes = next;
  }

  private writeRing(chunk: Buffer): void {
    const len = chunk.length;
    this.growIfNeeded(len);
    if (len >= this.currentCapacityBytes) {
      // Chunk larger than the entire buffer — only the tail
      // currentCapacityBytes are retained. Skip the prefix entirely.
      const tailStart = len - this.currentCapacityBytes;
      chunk.copy(this.storage, 0, tailStart, len);
      return;
    }
    const offset = this.writeCursor % this.currentCapacityBytes;
    const tailRoom = this.currentCapacityBytes - offset;
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
    const offset = fromCursor % this.currentCapacityBytes;
    const tailLen = Math.min(length, this.currentCapacityBytes - offset);
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
