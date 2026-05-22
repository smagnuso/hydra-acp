import { WebSocket } from "ws";
import { JsonRpcConnection } from "../../acp/connection.js";
import { wsToMessageStream } from "../../acp/ws-stream.js";
import { loadConfig } from "../../core/config.js";
import {
  resolveLocalTarget,
  type RemoteTarget,
} from "../../core/remote-target.js";
import { ensureDaemonReachable } from "../../core/daemon-bootstrap.js";
import { mapUpdate } from "../../core/render-update.js";
import {
  ACP_PROTOCOL_VERSION,
  HYDRA_META_KEY,
  extractHydraMeta,
} from "../../acp/types.js";
import { HYDRA_VERSION } from "../../core/hydra-version.js";
import { createChunker } from "./cat-chunker.js";
import {
  buildTitleFromArgv,
  setHydraProcessTitle,
} from "../../core/process-title.js";

// `hydra-acp cat` — pipe-friendly headless mode.
//
// Reads stdin as freeform text (not JSON-RPC, unlike shim mode), batches
// it into chunks, sends each chunk as a `session/prompt` against a fresh
// hydra session, and streams the agent's text response to stdout. Exits
// when stdin closes (default) or stays attached if --detach is given.
//
// This is the verb that makes `tail -f app.log | hydra-acp cat -p "..."`
// work end-to-end: the standing prompt (the -p text) is sent on each
// chunk so the agent re-evaluates the new lines against the same
// instruction. Session lifetime defaults to "same as the process" so a
// closed pipe takes the session with it; --detach keeps the session
// alive in the daemon for the slack/browser/notifier extensions to ride
// on.

export interface CatOptions {
  prompt?: string | undefined;
  agentId?: string | undefined;
  model?: string | undefined;
  name?: string | undefined;
  sessionId?: string | undefined;
  cwd?: string | undefined;
  detach?: boolean | undefined;
  // Pre-resolved daemon target. Set by the cli.ts dispatcher when
  // --session is a hydra:// URL so cat talks to a remote daemon. Local
  // invocations leave this undefined and fall through to
  // resolveLocalTarget(config).
  target?: RemoteTarget | undefined;
}

export async function runCat(opts: CatOptions): Promise<void> {
  // Match the TUI/shim process title so `killall hydra` reaps cat
  // processes too without clobbering the daemon. setHydraProcessTitle
  // keeps the comm name as the short anchor while showing the full
  // command line in ps so multiple concurrent cat invocations are
  // distinguishable.
  setHydraProcessTitle(buildTitleFromArgv(process.argv.slice(2)));

  if (process.stdin.isTTY && !opts.prompt && !opts.sessionId) {
    // No piped stdin + no -p + no session to attach to: nothing to
    // say and nothing to listen to. Refuse rather than block on a TTY
    // hoping the user knows to type and hit ^D for a brand-new
    // session that has no agent yet primed to do anything.
    process.stderr.write(
      "hydra-acp cat: nothing to send. Pipe input on stdin, pass -p <text>, or attach to an existing session with --session.\n",
    );
    process.exit(2);
    return;
  }

  const config = await loadConfig();
  const target = opts.target ?? (await resolveLocalTarget(config));
  if (target.isLocal && !opts.target) {
    await ensureDaemonReachable(config);
  }

  const subprotocols = ["acp.v1", `hydra-acp-token.${target.token}`];
  const ws = await openWs(target.wsUrl, subprotocols);
  const stream = wsToMessageStream(ws);
  const conn = new JsonRpcConnection(stream);

  const result = await runCatLoop({
    conn,
    opts,
    stdin: process.stdin,
    stdinIsTty: process.stdin.isTTY === true,
    stdout: (chunk) => process.stdout.write(chunk),
    stderr: (chunk) => {
      process.stderr.write(chunk);
    },
  });
  process.exit(result.exitCode);
}

// Resolved when the cat loop finishes — either stdin closed and all
// chunks drained, or the daemon-side connection dropped. Lets the
// test driver assert on the result without having to intercept
// process.exit.
export interface CatLoopResult {
  exitCode: number;
}

// Minimal stdin surface we depend on. Subset of NodeJS.ReadStream so
// process.stdin satisfies it, but loose enough that a plain EventEmitter
// (with an optional setEncoding) works as a test fake.
export interface CatStdin {
  on(event: "data", listener: (data: string | Buffer) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  setEncoding?: (enc: BufferEncoding) => unknown;
}

export interface CatLoopArgs {
  conn: JsonRpcConnection;
  opts: CatOptions;
  stdin: CatStdin;
  // If true, the loop treats the lack of piped stdin as "fire the
  // standing prompt once and exit"; if false, it wires up stdin
  // listeners and waits for "end".
  stdinIsTty: boolean;
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
}

// The orchestration core. Pure-ish: takes injected I/O so a test can
// drive it with a controlled stream + a fake stdin emitter and observe
// what got written to stdout. The real runCat() wires it to process.*
// and a WS connection.
export async function runCatLoop(args: CatLoopArgs): Promise<CatLoopResult> {
  const { conn, opts, stdin, stdinIsTty, stdout, stderr } = args;

  // We never accept a request from the daemon in cat mode (no FS, no
  // terminal, no permission UI). Refuse politely so anything the daemon
  // tries to send doesn't dangle.
  conn.setDefaultHandler(async () => {
    return { error: { code: -32601, message: "method not implemented" } };
  });

  try {
    await conn.request("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "hydra-acp-cat", version: HYDRA_VERSION },
    });
  } catch {
    // initialize is best-effort on the daemon side; proceed.
  }

  const sessionId = await openOrAttachSession(conn, opts);

  // Wire session/update → stdout. We render agent_message_chunk text
  // straight (no prefix, no styling) so consumers piping cat into grep
  // / jq / tee get only the agent's prose. Tool calls, plans, mode
  // changes, etc. are intentionally not surfaced — they belong to the
  // TUI / Slack thread / browser, not to the unix-pipe consumer.
  // mapUpdate's sanitizeWireText strips ANSI escapes and C0 controls
  // from the text before we ever see it, so stdout stays free of any
  // terminal-control sequences even when piped into a TTY.
  let turnHadOutput = false;
  let lastCharWasNewline = true;

  const writeStdout = (text: string): void => {
    if (text.length === 0) {
      return;
    }
    stdout(text);
    lastCharWasNewline = text.charCodeAt(text.length - 1) === 10;
  };

  // Flush the trailing newline for whichever turn just finished and
  // reset our output-tracking state for the next one. Called in two
  // places:
  //   1. After our own session/prompt response returns — the daemon
  //      excludes the originator from turn_complete broadcasts and
  //      treats the response as our end-of-turn signal (see
  //      core/session.ts:177 + tui/app.ts:2386 for the same workaround
  //      in the TUI).
  //   2. On a peer's turn_complete notification — when we attached via
  //      --session and another client is driving the session, the
  //      daemon DOES broadcast turn_complete to us, and we still want
  //      a clean line break before the next chunk of text streams in.
  const finalizeTurn = (): void => {
    if (turnHadOutput && !lastCharWasNewline) {
      writeStdout("\n");
    }
    turnHadOutput = false;
  };

  conn.onNotification("session/update", (params) => {
    const update = (params as { update?: unknown } | undefined)?.update;
    const event = mapUpdate(update);
    if (!event) {
      return;
    }
    if (event.kind === "agent-text") {
      turnHadOutput = true;
      writeStdout(event.text);
    } else if (event.kind === "turn-complete") {
      // Peer-driven turn ending. Our own turns finish via the
      // session/prompt response; this branch only fires when someone
      // else's session/prompt was the originator (e.g. we attached
      // via --session and a TUI / Slack client is driving the
      // conversation).
      finalizeTurn();
    }
  });

  const sendChunk = async (text: string): Promise<void> => {
    const promptBlocks: Array<Record<string, unknown>> = [];
    if (opts.prompt) {
      promptBlocks.push({ type: "text", text: opts.prompt });
    }
    if (text.length > 0) {
      promptBlocks.push({ type: "text", text });
    }
    if (promptBlocks.length === 0) {
      return;
    }
    try {
      await conn.request("session/prompt", {
        sessionId,
        prompt: promptBlocks,
      });
    } catch (err) {
      stderr(`hydra-acp cat: prompt failed: ${(err as Error).message}\n`);
      // Don't finalize — the response failed, so any in-flight text
      // (probably none) is in an unknown state. Just bail and let the
      // outer drain loop decide whether to keep going.
      return;
    }
    // The response IS our end-of-turn signal. agent_message_chunk
    // notifications arrive before the response (the daemon flushes
    // them in order, then returns the stopReason), so by the time we
    // reach this line the streaming text for this turn has already
    // landed in stdout and finalizeTurn() can safely insert a
    // separator.
    finalizeTurn();
  };

  // Loop state and the promise the function returns from. The two
  // pipeline-ending conditions we react to:
  //   1. stdin closes (the unix-pipe case — tail finishes, ^C upstream)
  //   2. the daemon-side connection drops (network blip, daemon kill)
  // Either way we flush in-flight work and resolve. We do NOT
  // auto-reconnect — that's the shim's job for editor sessions; for a
  // cat pipeline a dropped connection is terminal.
  let exitCode = 0;
  let resolveDone: (result: CatLoopResult) => void;
  const done = new Promise<CatLoopResult>((resolve) => {
    resolveDone = resolve;
  });
  let settled = false;
  const settle = async (code: number): Promise<void> => {
    if (settled) {
      return;
    }
    settled = true;
    // Fire session/detach without awaiting the response. The daemon
    // will detach us anyway when the WS drops; the explicit detach is
    // a politeness so the daemon's log shows a clean teardown.
    // Awaiting here would let an unresponsive daemon hang shutdown.
    if (!opts.detach) {
      conn.request("session/detach", { sessionId }).catch(() => undefined);
    }
    await conn.close().catch(() => undefined);
    resolveDone({ exitCode: code });
  };

  conn.onClose((err) => {
    if (err) {
      stderr(`hydra-acp cat: ${err.message}\n`);
      exitCode = 1;
    }
    // Connection is already gone; can't send session/detach. Just
    // resolve.
    if (!settled) {
      settled = true;
      resolveDone({ exitCode });
    }
  });

  const chunkQueue: string[] = [];
  let draining = false;
  let stdinEnded = false;

  const drainQueue = async (): Promise<void> => {
    if (draining) {
      return;
    }
    draining = true;
    try {
      while (chunkQueue.length > 0) {
        const next = chunkQueue.shift();
        if (next === undefined) {
          break;
        }
        await sendChunk(next);
      }
    } finally {
      draining = false;
      if (stdinEnded && chunkQueue.length === 0) {
        await settle(exitCode);
      }
    }
  };

  const chunker = createChunker({
    // setImmediate fires in the libuv "check" phase, after pending
    // I/O has been polled and any back-to-back "data" events have
    // been emitted. That makes it the natural hook for "the writer
    // has paused, time to flush": if more bytes were sitting in the
    // pipe buffer, Node would have emitted another "data" event
    // before this fires, and the chunker would detect that and defer.
    scheduleFlushCheck: (cb) => {
      const h = setImmediate(cb);
      return () => clearImmediate(h);
    },
    onChunk: (text) => {
      chunkQueue.push(text);
      void drainQueue();
    },
  });

  // TTY-stdin behaviour splits on whether we have an obvious reason
  // to read from the keyboard:
  //
  //   - With --session, the user is attaching to an existing
  //     session; typing into stdin (^D when done) is the natural way
  //     to drive that session from the terminal. Fall through to the
  //     read-stdin path below.
  //
  //   - Without --session, this is a one-shot like `qwen -p`. The
  //     user passed -p with the whole instruction inline and isn't
  //     expecting an interactive prompt. Fire the standing prompt
  //     once and exit; reading the keyboard here would hang on a
  //     phantom ^D the user has no way to know is expected.
  if (stdinIsTty && !opts.sessionId) {
    if (opts.prompt) {
      await sendChunk("");
    }
    await settle(0);
    return done;
  }

  if (typeof stdin.setEncoding === "function") {
    stdin.setEncoding("utf8");
  }
  stdin.on("data", (data: string | Buffer) => {
    chunker.feed(typeof data === "string" ? data : data.toString("utf8"));
  });
  stdin.on("end", () => {
    chunker.eof();
    stdinEnded = true;
    if (!draining && chunkQueue.length === 0) {
      void settle(exitCode);
    }
  });
  stdin.on("error", (err: Error) => {
    stderr(`hydra-acp cat: stdin error: ${err.message}\n`);
    exitCode = 1;
    stdinEnded = true;
    if (!draining && chunkQueue.length === 0) {
      void settle(exitCode);
    }
  });

  return done;
}

async function openOrAttachSession(
  conn: JsonRpcConnection,
  opts: CatOptions,
): Promise<string> {
  if (opts.sessionId) {
    // "pending_only" replays just the in-flight turn (if any) plus
    // queued prompts. Full history would drown a pipe consumer in
    // backlog; "none" would hide a turn that's mid-stream at attach
    // time, leaving the user staring at a paused agent. Pending is
    // the right middle: see what's happening right now, but nothing
    // from the past.
    const attached = (await conn.request("session/attach", {
      sessionId: opts.sessionId,
      historyPolicy: "pending_only",
      clientInfo: { name: "hydra-acp-cat", version: HYDRA_VERSION },
    })) as { sessionId: string };
    return attached.sessionId;
  }
  const hydraMeta: Record<string, unknown> = {};
  if (opts.name) {
    hydraMeta.name = opts.name;
  }
  if (opts.model) {
    hydraMeta.model = opts.model;
  }
  const cwd = opts.cwd ?? process.cwd();
  const params: Record<string, unknown> = { cwd };
  if (opts.agentId) {
    params.agentId = opts.agentId;
  }
  if (Object.keys(hydraMeta).length > 0) {
    params._meta = { [HYDRA_META_KEY]: hydraMeta };
  }
  const created = (await conn.request("session/new", params)) as {
    sessionId: string;
    _meta?: Record<string, unknown>;
  };
  // Touch extractHydraMeta to keep the response side validated; future
  // work (e.g. surfacing the upstreamSessionId for resume hints) plugs
  // in here.
  void extractHydraMeta(created._meta);
  return created.sessionId;
}

async function openWs(
  url: string,
  subprotocols: string[],
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, subprotocols);
    const onOpen = (): void => {
      ws.off("error", onError);
      resolve(ws);
    };
    const onError = (err: Error): void => {
      ws.off("open", onOpen);
      reject(err);
    };
    ws.once("open", onOpen);
    ws.once("error", onError);
  });
}
