// Sidechain helper — fork a session, attach, send an ancillary prompt, and
// stream updates without any TTY or terminal-kit dependency.
//
// This is the daemon-side plumbing that downstream tasks (e.g. Slack bot,
// browser extension) need to drive a forked agent conversation purely over
// the WebSocket + HTTP API, keeping the fork out of the interactive-promotion
// path via the `ancillary` flag.

import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import type { MessageStream } from "../../acp/framing.js";
import type { RemoteTarget } from "../../core/remote-target.js";
import { forkSession, killSession } from "../discovery.js";
import { JsonRpcConnection } from "../../acp/connection.js";
import { wsToMessageStream } from "../../acp/ws-stream.js";
import { ACP_PROTOCOL_VERSION, HYDRA_META_KEY } from "../../acp/types.js";

export interface SidechainOptions {
  // Agent to use for the forked session. Defaults to the source session's agent.
  agentId?: string;
  // Model override for the forked session.
  model?: string;
  // Which turn_complete to fork from. Default is "last" (the most recent).
  forkAt?: string;
  // CWD for the new session. Defaults to the source session's cwd.
  cwd?: string;
  // Custom fetch implementation. Injected so tests can mock daemon HTTP.
  fetchImpl?: typeof fetch;
  // Internal: stream factory for test injection. Production code omits this.
  _streamFactory?: (url: string, subprotocols: string[]) => Promise<MessageStream>;
}

export type SidechainEvent =
  | { kind: "update"; update: unknown }
  | { kind: "completed" }
  | { kind: "cancelled" }
  | { kind: "errored"; error: Error };

// Open a WebSocket connection to the daemon. Uses the standard subprotocol
// negotiation (`acp.v1` + hydra-acp-token bearer) so it works against both
// local and remote daemons.
function defaultOpenWs(
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

export function runBtwSidechain(
  target: RemoteTarget,
  sourceSessionId: string,
  prompt: string,
  opts: SidechainOptions = {},
): Promise<SidechainEventEmitter> {
  return new Promise((resolve, reject) => {
    (async () => {
      const fetchImpl = opts.fetchImpl ?? fetch;
      const streamFactory = opts._streamFactory ?? defaultOpenWs;

      const subprotocols = ["acp.v1", `hydra-acp-token.${target.token}`];
      const stream = await streamFactory(target.wsUrl, subprotocols);
      const conn = new JsonRpcConnection(stream);

      // If anything between here and emitter-creation throws, we must
      // close the WebSocket — otherwise a startup failure leaks an open
      // TCP socket that keeps the event loop alive and the TUI hangs at
      // ^D exit. The emitter (returned to the caller) takes responsibility
      // for cleanup once it exists; before that, this function owns it.
      let forkedSessionId: string;
      try {
        try {
          await conn.request("initialize", {
            protocolVersion: ACP_PROTOCOL_VERSION,
            clientCapabilities: {
              fs: { readTextFile: false, writeTextFile: false },
              terminal: false,
            },
            clientInfo: { name: "hydra-acp-sidechain" },
          });
        } catch {
          void 0;
        }
        // Title the fork so it's identifiable in `hydra sessions list
        // --all`. Without this the fork inherits the source's title and
        // every /btw shows up looking exactly like its parent. Threaded
        // through forkSession itself (single round-trip, no rename
        // race window).
        const titlePreview = prompt.replace(/\s+/g, " ").trim().slice(0, 60);
        const forkResult = await forkSession(
          target,
          sourceSessionId,
          {
            forkAt: opts.forkAt,
            cwd: opts.cwd,
            agentId: opts.agentId,
            title: `btw: ${titlePreview}`,
          },
          fetchImpl,
        );
        forkedSessionId = forkResult.sessionId;
      } catch (err) {
        void stream.close().catch(() => undefined);
        throw err;
      }

      const emitter = new SidechainEventEmitter(
        conn,
        stream,
        forkedSessionId,
        target,
        fetchImpl,
      );

      // Register notification handlers BEFORE sending session/prompt so no
      // session/update or turn_complete can race past us into the buffer.
      // The emitter is also resolved before the prompt is sent (see below)
      // so the caller's .then() listener attaches before any event fires.
      //
      // settle() closes the WebSocket too: on natural completion the
      // consumer drops its reference to the emitter, so if the sidechain
      // didn't close its own WS the underlying TCP socket would keep the
      // event loop alive and the TUI would hang at ^D exit.
      let settled = false;
      const settle = (event: SidechainEvent): void => {
        if (settled) return;
        settled = true;
        emitter.emit("event", event);
        void stream.close().catch(() => undefined);
      };

      // The daemon broadcasts session/update notifications to peers but
      // EXCLUDES the originator of session/prompt from turn_complete
      // (and prompt_received) — the originator's completion signal is
      // the session/prompt response with stopReason instead. See
      // core/session.ts ~255 and cli/commands/cat.ts ~427 for the same
      // contract. So we forward agent_message_chunk / tool_call / etc.
      // through this notification handler for rendering, but rely on
      // the session/prompt response below to settle the terminal event.
      conn.onNotification("session/update", (params) => {
        const update = (params as { update?: unknown } | undefined)?.update;
        if (update === undefined) {
          return;
        }
        emitter.emit("event", { kind: "update", update } as SidechainEvent);
      });

      conn.onClose(() => {
        if (!settled) {
          settle({ kind: "completed" });
        }
      });

      // Attach BEFORE the prompt — same connection, same call order as
      // the existing TUI attach path. If attach fails, close the stream
      // and the daemon-side fork before propagating the error (otherwise
      // both leak — the WS keeps the event loop alive, the cold fork
      // sits orphaned until GC).
      try {
        await conn.request("session/attach", {
          sessionId: forkedSessionId,
          historyPolicy: "full",
          clientInfo: { name: "hydra-acp-sidechain" },
        });
      } catch (err) {
        void stream.close().catch(() => undefined);
        void killSession(target, forkedSessionId, fetchImpl).catch(() => undefined);
        throw err;
      }

      // Hand the emitter back to the caller. The session/prompt send is
      // deferred to setImmediate so the caller's `.then(emitter => emitter.on(...))`
      // listener is attached before any session/update notification can fire.
      // session/prompt is fire-and-forget here: it only resolves at
      // turn-end with stopReason, but completion is driven by the
      // turn_complete notification above. We still attach a .catch so a
      // prompt rejection surfaces as an errored terminal event.
      resolve(emitter);

      setImmediate(() => {
        conn
          .request<{ stopReason?: string }>("session/prompt", {
            sessionId: forkedSessionId,
            prompt: [{ type: "text", text: prompt }],
            _meta: { [HYDRA_META_KEY]: { ancillary: true } },
          })
          .then((response) => {
            // session/prompt response carries the terminal stopReason for
            // the originator (us). Map to our terminal event shape.
            const stopReason =
              response && typeof response === "object"
                ? (response as { stopReason?: string }).stopReason
                : undefined;
            if (stopReason === "cancelled") {
              settle({ kind: "cancelled" });
            } else if (stopReason === "error" || stopReason === "errored") {
              settle({
                kind: "errored",
                error: new Error("turn ended with error stopReason"),
              });
            } else {
              settle({ kind: "completed" });
            }
          })
          .catch((err: unknown) => {
            settle({
              kind: "errored",
              error: err instanceof Error ? err : new Error(String(err)),
            });
          });
      });
    })().catch(reject);
  });
}

// Internal wrapper around EventEmitter that exposes cancel() and the event
// stream. Connection closure is tracked so cancel can detect a completed run.
export class SidechainEventEmitter extends EventEmitter {
  private readonly _conn: JsonRpcConnection;
  private readonly _stream: MessageStream;
  private readonly _sessionId: string;
  private readonly _target: RemoteTarget;
  private readonly _fetchImpl: typeof fetch;
  private _cancelled = false;

  constructor(
    conn: JsonRpcConnection,
    stream: MessageStream,
    sessionId: string,
    target: RemoteTarget,
    fetchImpl: typeof fetch,
  ) {
    super();
    this._conn = conn;
    this._stream = stream;
    this._sessionId = sessionId;
    this._target = target;
    this._fetchImpl = fetchImpl;
  }

  /** The daemon-side forked session ID. Used by the TUI to killSession the
   * ancillary fork when the user dismisses the overlay with `d`. */
  get sessionId(): string {
    return this._sessionId;
  }

  // Cancel the in-flight turn AND kill the daemon-side fork. Idempotent.
  // Sends session/cancel (with sessionId), closes the WS, and posts
  // killSession so the fork's agent process is torn down. Without the
  // killSession, an interrupted /btw would leave the agent bun process
  // running indefinitely against an unattached cold session.
  cancel(): void {
    if (this._cancelled) return;
    this._cancelled = true;
    void this._conn
      .notify("session/cancel", { sessionId: this._sessionId })
      .catch(() => undefined);
    void this._stream.close().catch(() => undefined);
    void killSession(this._target, this._sessionId, this._fetchImpl).catch(
      () => undefined,
    );
  }

  override once(event: "event", listener: (event: SidechainEvent) => void): this {
    return super.once(event, listener);
  }

  override on(event: "event", listener: (event: SidechainEvent) => void): this {
    return super.on(event, listener);
  }

  override off(event: "event", listener: (event: SidechainEvent) => void): this {
    return super.off(event, listener);
  }
}
