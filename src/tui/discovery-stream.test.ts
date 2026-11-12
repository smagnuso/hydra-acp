import { describe, expect, it, vi } from "vitest";
import {
  drainSseData,
  mergeSessionStreamFrame,
  parseSessionPage,
  streamSessionPages,
  type DiscoveredSession,
  type SessionListPage,
} from "./discovery.js";
import type { RemoteTarget } from "../core/remote-target.js";

// Not the real daemon port: a test that forgot to inject fetch must fail
// fast instead of reaching a live daemon.
const target: RemoteTarget = {
  baseUrl: "http://127.0.0.1:1",
  wsUrl: "ws://127.0.0.1:1/acp",
  token: "tok",
  display: "127.0.0.1:1",
  isLocal: true,
};

const row = (sessionId: string, extra: Record<string, unknown> = {}) => ({
  sessionId,
  cwd: "/w",
  updatedAt: "2026-01-01T00:00:00Z",
  status: "warm",
  ...extra,
});

const sse = (body: unknown): string =>
  `event: sessions\ndata: ${JSON.stringify(body)}\n\n`;

function streamResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) {
        controller.enqueue(encoder.encode(c));
      }
      controller.close();
    },
  });
  return new Response(status === 200 ? body : null, { status });
}

describe("drainSseData", () => {
  it("returns complete payloads and keeps a partial frame", () => {
    const out = drainSseData('event: sessions\ndata: {"a":1}\n\ndata: {"b"');
    expect(out.payloads).toEqual(['{"a":1}']);
    expect(out.rest).toBe('data: {"b"');
  });

  it("skips comment-only blocks", () => {
    expect(drainSseData(": ping\n\n").payloads).toEqual([]);
  });
});

describe("mergeSessionStreamFrame", () => {
  const warm = (id: string, busy = false) =>
    ({ ...row(id), busy, attachedClients: 0 }) as unknown as DiscoveredSession;

  it("keeps rows the frame does not mention", () => {
    const frame: SessionListPage = {
      sessions: [warm("b", true)],
      removed: [],
      cursor: 2,
    };
    const merged = mergeSessionStreamFrame([warm("a"), warm("b")], frame);
    expect(merged.map((s) => s.sessionId).sort()).toEqual(["a", "b"]);
    expect(merged.find((s) => s.sessionId === "b")?.busy).toBe(true);
  });

  it("drops removed ids", () => {
    const merged = mergeSessionStreamFrame([warm("a"), warm("b")], {
      sessions: [],
      removed: ["a"],
      cursor: 3,
    });
    expect(merged.map((s) => s.sessionId)).toEqual(["b"]);
  });
});

describe("streamSessionPages", () => {
  it("delivers frames, including one split across chunks", async () => {
    const abort = new AbortController();
    const frames: SessionListPage[] = [];
    const whole = sse({ sessions: [row("a")], removed: [], cursor: 5 });
    const fetchImpl = vi.fn(async () =>
      streamResponse([whole.slice(0, 20), whole.slice(20)]),
    );
    const done = streamSessionPages(target, {
      status: "warm",
      signal: abort.signal,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onFrame: (f) => {
        frames.push(f);
        abort.abort();
      },
    });
    expect(await done).toBe("aborted");
    expect(frames).toHaveLength(1);
    expect(frames[0]?.sessions[0]?.sessionId).toBe("a");
    expect(frames[0]?.cursor).toBe(5);
    const url = String((fetchImpl.mock.calls[0] as unknown[])[0]);
    expect(url).toContain("/v1/sessions/stream");
    expect(url).toContain("status=warm");
    expect(url).not.toContain("since=");
  });

  it("reconnects with the last cursor after the stream ends", async () => {
    const abort = new AbortController();
    const urls: string[] = [];
    let call = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url);
      call++;
      return streamResponse([
        sse({ sessions: [], removed: [], cursor: call === 1 ? 7 : 9 }),
      ]);
    });
    const disconnects = vi.fn();
    let seen = 0;
    await streamSessionPages(target, {
      signal: abort.signal,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => undefined,
      onDisconnect: disconnects,
      onFrame: () => {
        seen++;
        if (seen === 2) {
          abort.abort();
        }
      },
    });
    expect(urls[0]).not.toContain("since=");
    expect(urls[1]).toContain("since=7");
    expect(disconnects).toHaveBeenCalledTimes(1);
  });

  it("backs off after a failure and retries", async () => {
    const abort = new AbortController();
    const waits: number[] = [];
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call++;
      if (call < 3) {
        throw new Error("down");
      }
      return streamResponse([sse({ sessions: [], removed: [], cursor: 1 })]);
    });
    await streamSessionPages(target, {
      signal: abort.signal,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async (ms) => {
        waits.push(ms);
      },
      onFrame: () => abort.abort(),
    });
    expect(waits).toEqual([1000, 2000]);
  });

  it("reports an older daemon (404) as unsupported without retrying", async () => {
    const abort = new AbortController();
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404 }));
    const outcome = await streamSessionPages(target, {
      signal: abort.signal,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => undefined,
      onFrame: () => undefined,
    });
    expect(outcome).toBe("unsupported");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("ignores a malformed payload and keeps reading", async () => {
    const abort = new AbortController();
    const frames: SessionListPage[] = [];
    const fetchImpl = vi.fn(async () =>
      streamResponse([
        "data: {not json\n\n",
        sse({ sessions: [row("a")], removed: [], cursor: 2 }),
      ]),
    );
    await streamSessionPages(target, {
      signal: abort.signal,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onFrame: (f) => {
        frames.push(f);
        abort.abort();
      },
    });
    expect(frames).toHaveLength(1);
  });
});

describe("parseSessionPage", () => {
  it("defaults missing removed and cursor", () => {
    expect(parseSessionPage({ sessions: [] })).toEqual({
      sessions: [],
      removed: [],
      cursor: 0,
    });
  });
});
