import { setTimeout as sleep } from "node:timers/promises";
import { openWs } from "./open-ws.js";
import type { MessageStream } from "../acp/framing.js";
import { wsToMessageStream } from "../acp/ws-stream.js";
import {
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "../acp/types.js";

// The dial URL can be either a fixed string or a resolver that's
// invoked on every reconnect attempt. The resolver form is for the
// local-attach case where the daemon's plain-HTTP loopback Fastify
// lives on an ephemeral port that changes across restarts — the
// resolver re-reads the pidfile each time so a `hydra daemon
// restart` doesn't strand the live TUI's reconnect loop.
export type ResilientWsUrl =
  | string
  | (() => string | Promise<string>);

export interface ResilientWsOptions {
  url: ResilientWsUrl;
  subprotocols: string[];
  // onConnect runs after WS open. During its execution, regular send() is
  // gated (queued) and the queued downstream backlog is held back; use
  // request() inside onConnect for raw, awaitable writes so things like
  // session/attach can complete BEFORE any queued prompts get flushed.
  onConnect?: (firstConnect: boolean) => Promise<void> | void;
  onConnectFailure?: (err: Error) => void;
  // Fires the moment the underlying ws closes and a reconnect is queued —
  // before the new connection is established. Lets the caller react to
  // the "now offline" transition (e.g. a TUI banner) separately from the
  // eventual "back online" signal in onConnect.
  onDisconnect?: (err?: Error) => void;
  log?: (line: string) => void;
}

const BACKOFF_INITIAL_MS = 200;
const BACKOFF_MAX_MS = 5_000;
const BACKOFF_MULTIPLIER = 2;
const MAX_RECONNECT_ATTEMPTS = 60;

export class ResilientWsStream implements MessageStream {
  private current: MessageStream | undefined;
  private outboundQueue: JsonRpcMessage[] = [];
  private flushing = false;
  private messageHandlers: Array<(m: JsonRpcMessage) => void> = [];
  private closeHandlers: Array<(err?: Error) => void> = [];
  private destroyed = false;
  private firstConnect = true;
  private reconnectInFlight: Promise<void> | undefined;
  private connectGate: Promise<void> | undefined;
  private releaseConnectGate: (() => void) | undefined;
  private pendingRequests = new Map<
    JsonRpcId,
    {
      resolve: (r: JsonRpcResponse) => void;
      reject: (err: Error) => void;
    }
  >();

  constructor(private opts: ResilientWsOptions) {}

  async start(): Promise<void> {
    await this.connectWithRetry();
  }

  onMessage(handler: (m: JsonRpcMessage) => void): void {
    this.messageHandlers.push(handler);
  }

  onClose(handler: (err?: Error) => void): void {
    this.closeHandlers.push(handler);
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (this.destroyed) {
      throw new Error("resilient ws stream is destroyed");
    }
    // Hold back routine sends while onConnect is running — it's mid-replay
    // of session/attach requests and any prompts that slip past would race
    // against an in-flight resurrect on the daemon.
    if (this.connectGate || !this.current || this.flushing) {
      // Always go through the queue while a flush is in progress so
      // ordering is preserved and a concurrent send() can't be stranded
      // by the loop having already snapshotted the prior queue. The
      // in-flight flushQueue() loop re-checks outboundQueue.length each
      // iteration, so appending here is sufficient — no second drain
      // call is needed (and any such call would be unreachable: the
      // outer guard already encompasses every case where draining
      // would be safe).
      this.outboundQueue.push(message);
      return;
    }
    this.outboundQueue.push(message);
    await this.flushQueue();
  }

  // Send a request directly and resolve when the matching response arrives
  // on the same connection. Used by onConnect handlers to await replay-attach
  // responses before letting the outbound queue drain. Bypasses the
  // connectGate intentionally.
  async request(message: JsonRpcRequest): Promise<JsonRpcResponse> {
    if (this.destroyed) {
      throw new Error("resilient ws stream is destroyed");
    }
    if (!this.current) {
      throw new Error("resilient ws stream not connected");
    }
    const id = message.id;
    const promise = new Promise<JsonRpcResponse>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
    });
    try {
      await this.current.send(message);
    } catch (err) {
      this.pendingRequests.delete(id);
      throw err;
    }
    return promise;
  }

  async close(): Promise<void> {
    this.destroyed = true;
    // Wait for any in-flight reconnect attempt to settle before tearing
    // down. Otherwise connectWithRetry could bind a fresh socket AFTER
    // close() returns and leave the caller with a phantom live stream.
    // Cap the wait so a stuck retry loop (e.g. openWs hanging on a
    // never-resolving handshake) can't block shutdown forever.
    if (this.reconnectInFlight) {
      const CLOSE_RECONNECT_WAIT_MS = 2_000;
      await Promise.race([
        this.reconnectInFlight.catch(() => undefined),
        sleep(CLOSE_RECONNECT_WAIT_MS),
      ]);
    }
    if (this.current) {
      await this.current.close().catch(() => undefined);
    }
    // Reject any request() promises still waiting on a response — the
    // stream is gone, no reply will ever arrive. Without this, callers
    // awaiting request() hang forever even though we've signalled close.
    if (this.pendingRequests.size > 0) {
      const reason = new Error("resilient ws stream is destroyed");
      for (const { reject } of this.pendingRequests.values()) {
        reject(reason);
      }
      this.pendingRequests.clear();
    }
    for (const handler of this.closeHandlers) {
      handler();
    }
  }

  private async connectWithRetry(): Promise<void> {
    let attempt = 0;
    let backoff = BACKOFF_INITIAL_MS;
    while (!this.destroyed) {
      try {
        const url =
          typeof this.opts.url === "function"
            ? await this.opts.url()
            : this.opts.url;
        const ws = await openWs(url, this.opts.subprotocols);
        this.bindStream(wsToMessageStream(ws));
        const wasFirst = this.firstConnect;
        this.firstConnect = false;
        // Gate routine outbound traffic while onConnect runs. onConnect can
        // call request() to send AND await responses (e.g. replayAttach) —
        // those bypass the gate. Once onConnect returns the queue drains.
        this.connectGate = new Promise<void>((resolve) => {
          this.releaseConnectGate = resolve;
        });
        try {
          if (this.opts.onConnect) {
            try {
              await this.opts.onConnect(wasFirst);
            } catch (err) {
              this.log(
                `hydra-acp: post-connect handler failed: ${(err as Error).message}`,
              );
            }
          }
        } finally {
          this.releaseConnectGate?.();
          this.releaseConnectGate = undefined;
          this.connectGate = undefined;
        }
        await this.flushQueue();
        return;
      } catch (err) {
        attempt += 1;
        if (this.opts.onConnectFailure) {
          this.opts.onConnectFailure(err as Error);
        }
        if (attempt >= MAX_RECONNECT_ATTEMPTS) {
          throw new Error(
            `hydra-acp: gave up reconnecting after ${attempt} attempts: ${(err as Error).message}`,
          );
        }
        this.log(
          `hydra-acp: connect attempt ${attempt} failed (${(err as Error).message}); retrying in ${backoff}ms`,
        );
        await sleep(backoff);
        // close() may have flipped destroyed while we were sleeping;
        // bail before opening another socket the caller no longer wants.
        if (this.destroyed) {
          return;
        }
        backoff = Math.min(backoff * BACKOFF_MULTIPLIER, BACKOFF_MAX_MS);
      }
    }
  }

  private bindStream(stream: MessageStream): void {
    this.current = stream;
    stream.onMessage((msg) => {
      if (isResponse(msg) && msg.id !== null) {
        const pending = this.pendingRequests.get(msg.id);
        if (pending) {
          this.pendingRequests.delete(msg.id);
          pending.resolve(msg);
        }
      }
      for (const handler of this.messageHandlers) {
        handler(msg);
      }
    });
    stream.onClose((err) => {
      if (this.destroyed) {
        return;
      }
      this.current = undefined;
      // Reject any in-flight request() promises; their response would have
      // come back on this now-dead stream and never will.
      if (this.pendingRequests.size > 0) {
        const reason =
          err ?? new Error("ws closed before response");
        for (const { reject } of this.pendingRequests.values()) {
          reject(reason);
        }
        this.pendingRequests.clear();
      }
      this.scheduleReconnect(err);
    });
  }

  private async flushQueue(): Promise<void> {
    if (this.flushing) {
      return;
    }
    this.flushing = true;
    try {
      // Re-check the queue inside the loop rather than snapshotting it
      // up-front: a concurrent send() can append while we're awaiting a
      // network write, and leaving the failing head in place avoids the
      // unshift() re-ordering hazard the old code had.
      while (
        !this.destroyed &&
        this.current &&
        this.outboundQueue.length > 0
      ) {
        const msg = this.outboundQueue[0]!;
        try {
          await this.current.send(msg);
        } catch (err) {
          this.scheduleReconnect(err as Error);
          return;
        }
        this.outboundQueue.shift();
      }
    } finally {
      this.flushing = false;
    }
  }

  private scheduleReconnect(err?: Error): void {
    if (this.destroyed || this.reconnectInFlight) {
      return;
    }
    this.log(
      `hydra-acp: connection lost (${err?.message ?? "no error"}); reconnecting...`,
    );
    if (this.opts.onDisconnect) {
      try {
        this.opts.onDisconnect(err);
      } catch (hookErr) {
        this.log(
          `hydra-acp: onDisconnect handler threw: ${(hookErr as Error).message}`,
        );
      }
    }
    this.reconnectInFlight = (async () => {
      try {
        await this.connectWithRetry();
      } catch (final) {
        for (const handler of this.closeHandlers) {
          handler(final as Error);
        }
        this.destroyed = true;
      } finally {
        this.reconnectInFlight = undefined;
      }
    })();
  }

  private log(line: string): void {
    if (this.opts.log) {
      this.opts.log(line);
      return;
    }
    process.stderr.write(`${line}\n`);
  }
}

function isResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return (
    !("method" in msg) &&
    "id" in msg &&
    (msg as JsonRpcResponse).id !== undefined
  );
}


