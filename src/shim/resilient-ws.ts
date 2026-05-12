import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket } from "ws";
import type { MessageStream } from "../acp/framing.js";
import { wsToMessageStream } from "../acp/ws-stream.js";
import {
  JsonRpcErrorCodes,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "../acp/types.js";

export interface ResilientWsOptions {
  url: string;
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
    if (this.connectGate || !this.current) {
      this.outboundQueue.push(message);
      return;
    }
    try {
      await this.current.send(message);
    } catch (err) {
      this.outboundQueue.push(message);
      this.scheduleReconnect(err as Error);
    }
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
    if (this.current) {
      await this.current.close().catch(() => undefined);
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
        const stream = await openWs(this.opts.url, this.opts.subprotocols);
        this.bindStream(stream);
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
        backoff = Math.min(backoff * BACKOFF_MULTIPLIER, BACKOFF_MAX_MS);
      }
    }
  }

  private bindStream(stream: MessageStream): void {
    this.current = stream;
    stream.onMessage((msg) => {
      if (isResponse(msg)) {
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
    if (!this.current) {
      return;
    }
    const queue = this.outboundQueue;
    this.outboundQueue = [];
    for (const msg of queue) {
      try {
        await this.current.send(msg);
      } catch (err) {
        this.outboundQueue.unshift(msg);
        this.scheduleReconnect(err as Error);
        return;
      }
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

async function openWs(
  url: string,
  subprotocols: string[],
): Promise<MessageStream> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, subprotocols);
    const onOpen = (): void => {
      ws.off("error", onError);
      resolve(wsToMessageStream(ws));
    };
    const onError = (err: Error): void => {
      ws.off("open", onOpen);
      reject(err);
    };
    ws.once("open", onOpen);
    ws.once("error", onError);
  });
}

export function isResurrectableError(err: unknown): boolean {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code: unknown }).code;
    return code === JsonRpcErrorCodes.SessionNotFound;
  }
  return false;
}
