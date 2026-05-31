import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import {
  HYDRA_CAT_CLIENT_NAME,
  HYDRA_VERSION,
} from "../../core/hydra-version.js";
import {
  buildApproveResponse,
  buildRejectResponse,
} from "../../acp/permission-pick.js";
import { createChunker } from "./cat-chunker.js";
import { renderMarkdownForCat, type CatRenderMode } from "./cat-render.js";
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
  // Threshold (bytes) at which piped stdin promotes from one inline
  // text-block prompt to the daemon's in-memory MCP stdin surface. Small
  // inputs stay inline; larger inputs let the agent pull via
  // head_stdin / tail_stdin / grep_stdin / read_stdin tools rather than
  // bloating the prompt.
  streamThreshold?: number | undefined;
  streamBufferBytes?: number | undefined;
  // --follow: per-burst chunking via cat-chunker, one prompt per burst.
  // Default (when this is falsy) for piped non-TTY stdin is auto-stream
  // (one prompt; bytes via MCP tools for inputs above the threshold).
  // --follow restores the per-burst behavior, useful for `tail -f`.
  follow?: boolean | undefined;
  // Approve every session/request_permission instead of just the
  // hydra-acp-stdin tool family. Wire bypass for the user — agent is free
  // to do anything its tools allow. The CLI prints a stderr warning at
  // startup so it's never silent.
  dangerouslySkipPermissions?: boolean | undefined;
  // --raw: bypass markdown post-processing and emit agent_message_chunk
  // text verbatim, the way cat behaved before the renderer landed. Keeps
  // streaming behavior intact for callers that want progressive output
  // or that prefer to consume the original markdown unmodified.
  raw?: boolean | undefined;
}

const DEFAULT_STREAM_THRESHOLD = 1 * 1024 * 1024;

// claude-acp prefixes MCP tools with `mcp__<serverName>__<toolName>`. We
// inject the server as `hydra-acp-stdin` in acp-ws.ts, so any tool call
// whose title (the agent-facing identifier in the permission request)
// starts with this prefix is one of our read-the-pipe tools.
const HYDRA_STDIN_TOOL_PREFIX = "mcp__hydra-acp-stdin__";

// `hydra cat` is a one-shot ancillary client — its turns must never
// promote the session to interactive. Every session/prompt cat sends
// goes through here so the `ancillary` flag is set in one place rather
// than at each call site.
function catPromptParams(
  sessionId: string,
  prompt: unknown[],
): Record<string, unknown> {
  return {
    sessionId,
    prompt,
    _meta: { [HYDRA_META_KEY]: { ancillary: true } },
  };
}

function deriveTitleFromPrompt(prompt: string | undefined): string | undefined {
  if (!prompt) {
    return undefined;
  }
  for (const raw of prompt.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    return line.length > 80 ? `${line.slice(0, 80)}…` : line;
  }
  return undefined;
}

function isHydraStdinPermissionRequest(params: unknown): boolean {
  if (!params || typeof params !== "object") {
    return false;
  }
  const toolCall = (params as { toolCall?: unknown }).toolCall;
  if (!toolCall || typeof toolCall !== "object") {
    return false;
  }
  const title = (toolCall as { title?: unknown }).title;
  if (typeof title === "string" && title.startsWith(HYDRA_STDIN_TOOL_PREFIX)) {
    return true;
  }
  // Some agents may surface the raw name on `toolCall.rawInput.tool_name`
  // or expose a top-level `toolName`; check both for forward-compat.
  const toolName = (toolCall as { toolName?: unknown }).toolName;
  if (typeof toolName === "string" && toolName.startsWith(HYDRA_STDIN_TOOL_PREFIX)) {
    return true;
  }
  return false;
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

  // Sandbox new sessions in an empty temp dir by default so the agent's
  // Read / Glob / Grep / Bash-ls have nothing local to peek at — the only
  // input we expose is whatever the user piped (inline or via the MCP
  // stdin tools). The permission handler in runCatLoop also rejects
  // every non-`mcp__hydra-acp-stdin__*` tool call, but cwd is a stronger
  // defense: if any agent path ever skips the permission gate (Read
  // inside cwd in standalone Claude Code is normally auto-allowed),
  // there's still nothing here to read. Override with --cwd <path>
  // (or HYDRA_ACP_CWD) when the user explicitly wants the project dir
  // exposed (e.g. "find docs in the codebase that match this error").
  // --session preserves the existing session's cwd; we don't touch it.
  // No-pipe runs (`hydra cat -p "..."` with no stdin) skip the sandbox:
  // the user is asking about their project, not about piped data.
  if (
    !opts.sessionId &&
    opts.cwd === undefined &&
    process.stdin.isTTY !== true
  ) {
    const sandbox = mkdtempSync(join(tmpdir(), "hydra-cat-"));
    opts.cwd = sandbox;
    if (!opts.detach) {
      // Best-effort cleanup on normal exit. --detach leaves the dir
      // intact since the daemon-resident agent may still be using it
      // (and /tmp gets GC'd on reboot anyway).
      process.on("exit", () => {
        try {
          rmSync(sandbox, { recursive: true, force: true });
        } catch {
          // Swallow — nothing useful to do at this point.
        }
      });
    }
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
    stdoutIsTty: process.stdout.isTTY === true,
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
  // Picks the render mode: ANSI escapes when stdout is a TTY, stripped
  // markdown when it's piped. Tests inject false to assert against
  // plain bytes.
  stdoutIsTty: boolean;
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
}

// The orchestration core. Pure-ish: takes injected I/O so a test can
// drive it with a controlled stream + a fake stdin emitter and observe
// what got written to stdout. The real runCat() wires it to process.*
// and a WS connection.
export async function runCatLoop(args: CatLoopArgs): Promise<CatLoopResult> {
  const { conn, opts, stdin, stdinIsTty, stdoutIsTty, stdout, stderr } = args;
  const renderMode: CatRenderMode = stdoutIsTty ? "ansi" : "plain";
  const rawMode = opts.raw === true;

  // Piped (non-TTY) stdin to a fresh session with no --follow auto-uses
  // the daemon-hosted MCP stdin surface: small inputs flow as one inline
  // prompt, large inputs fall through to head/tail/grep/read tools. This
  // is the default because the agent's context window can't accept
  // arbitrarily large piped inputs as text blocks, and forcing the user
  // to opt-in via a flag just produced confusing "prompt too long"
  // failures. --follow restores per-burst chunking; --session attaches
  // to an existing session and uses a simple buffer-then-send.
  const useAutoStream =
    !stdinIsTty && opts.sessionId === undefined && opts.follow !== true;

  // We never accept a request from the daemon in cat mode (no FS, no
  // terminal, no permission UI). Refuse politely so anything the daemon
  // tries to send doesn't dangle.
  conn.setDefaultHandler(async () => {
    return { error: { code: -32601, message: "method not implemented" } };
  });

  // ...with one exception: when --stream is on, the agent will call
  // `hydra-acp-stdin/*` MCP tools to read the piped bytes, and claude-acp
  // gates those behind session/request_permission. There's no human at
  // the keyboard to click "Allow", and the standing prompt has already
  // explicitly directed the agent to use those tools — denying them
  // would just produce another "I need permission to read stdin"
  // dead-end. So we auto-allow tool calls whose toolCall.title is in
  // the `mcp__hydra-acp-stdin__*` namespace and reject everything else.
  // The optionId we pick from `params.options` defaults to "allow"
  // (allow_once) so we don't pollute the agent's persisted permission
  // rules; if "allow" isn't offered we fall back to whatever
  // `allow_once`-kinded option is present.
  conn.onRequest("session/request_permission", async (params) => {
    // --dangerously-skip-permissions: approve anything the agent asks
    // for, not just hydra-acp-stdin tools. The startup warning in cli.ts
    // already told the user they opted into this.
    if (opts.dangerouslySkipPermissions) {
      return buildApproveResponse(params);
    }
    if (!isHydraStdinPermissionRequest(params)) {
      return buildRejectResponse(params);
    }
    return buildApproveResponse(params);
  });

  try {
    await conn.request("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: HYDRA_CAT_CLIENT_NAME, version: HYDRA_VERSION },
    });
  } catch {
    // initialize is best-effort on the daemon side; proceed.
  }

  const sessionId = await openOrAttachSession(conn, opts, useAutoStream);

  // Wire session/update → stdout. Two modes:
  //   - Default: agent_message_chunk text is buffered until the block
  //     closes (a non-text event such as a tool call, plan update, mode
  //     change, or turn-complete). The full block is then rendered
  //     through cat-render — ANSI-styled on a TTY, stripped-to-plain on a
  //     pipe — and emitted with a blank-line separator before the next
  //     block. Boundary events themselves stay invisible, matching the
  //     pre-renderer contract that tool calls / plans / thoughts belong
  //     to the TUI / Slack / browser, not to a unix-pipe consumer. The
  //     boundary flush mirrors the TUI's closeAgentText() in
  //     tui/app.ts:2741, so "I'll check…" / <tool> / "Found it." renders
  //     as two paragraphs in cat just like it does in the TUI.
  //   - --raw: chunks pass through immediately, unmodified, matching the
  //     pre-renderer behavior; boundary events still produce no output.
  // sanitizeWireText in mapUpdate strips ANSI escapes and C0 controls
  // from incoming text before either path sees it, so the only ANSI that
  // ever reaches stdout is what cat-render emits.
  let turnHadOutput = false;
  let lastCharWasNewline = true;
  let blockBuffer = "";
  let blocksEmitted = 0;

  const writeStdout = (text: string): void => {
    if (text.length === 0) {
      return;
    }
    stdout(text);
    lastCharWasNewline = text.charCodeAt(text.length - 1) === 10;
    turnHadOutput = true;
  };

  // Render the accumulated block buffer (if any), prefixing with a blank
  // line when a previous block has already been emitted, so consecutive
  // blocks read as paragraphs rather than running together. Raw mode
  // never buffers, so this is a no-op there.
  const flushBlock = (): void => {
    if (rawMode || blockBuffer.length === 0) {
      return;
    }
    const rendered = renderMarkdownForCat(blockBuffer, renderMode);
    blockBuffer = "";
    if (rendered.length === 0) {
      return;
    }
    const separator = blocksEmitted > 0 ? "\n" : "";
    writeStdout(separator + rendered);
    blocksEmitted += 1;
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
    flushBlock();
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
      if (rawMode) {
        writeStdout(event.text);
      } else {
        blockBuffer += event.text;
      }
      return;
    }
    if (event.kind === "turn-complete") {
      // Peer-driven turn ending. Our own turns finish via the
      // session/prompt response; this branch only fires when someone
      // else's session/prompt was the originator (e.g. we attached
      // via --session and a TUI / Slack client is driving the
      // conversation).
      finalizeTurn();
      return;
    }
    // Block-boundary events. We don't surface these in cat output —
    // tools / thoughts / plan updates belong to the TUI / Slack /
    // browser — but we DO use them as separators so a mid-turn tool
    // call splits the agent's prose into distinct paragraphs (same
    // behavior as the TUI's closeAgentText). model-changed, usage,
    // session-info etc. are header/metadata and intentionally do not
    // flush a block.
    switch (event.kind) {
      case "agent-thought":
      case "tool-call":
      case "tool-call-update":
      case "exit-plan-mode":
      case "plan":
      case "mode-changed":
      case "user-text":
        flushBlock();
        return;
      default:
        return;
    }
  });

  // The standing prompt (-p) is the agent's mission — sent once, on the
  // first turn of the session. Subsequent --follow chunks are bytes-only
  // so a long-running tail doesn't repeat the instruction N times and
  // bloat the context. The flag flips only after the request succeeds;
  // a failed first turn leaves it false so a retry would re-send the
  // mission.
  let firstChunkSent = false;
  const sendChunk = async (text: string): Promise<void> => {
    const promptBlocks: Array<Record<string, unknown>> = [];
    if (opts.prompt && !firstChunkSent) {
      promptBlocks.push({ type: "text", text: opts.prompt });
    }
    if (text.length > 0) {
      promptBlocks.push({ type: "text", text });
    }
    if (promptBlocks.length === 0) {
      return;
    }
    try {
      await conn.request("session/prompt", catPromptParams(sessionId, promptBlocks));
      firstChunkSent = true;
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
    // Flush any buffered block before tearing down. Cheap when the
    // buffer is empty (the common case for sendChunk-driven flow, which
    // already finalized on the prompt response), critical for the
    // auto-stream FILE path — that path fires session/prompt directly
    // and resolves via onEof without going through sendChunk's
    // finalizeTurn(), so without this every >1MB pipe would lose the
    // agent's answer.
    finalizeTurn();
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
    // Connection is already gone; can't send session/detach. Mirror
    // settle()'s buffer flush so a daemon-side drop mid-answer still
    // shows whatever the agent already streamed.
    if (!settled) {
      settled = true;
      finalizeTurn();
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

  // Auto-stream: buffer the head, decide between INLINE (small) and
  // FILE (everything else) at threshold-cross or EOF, then either send
  // one inline prompt or open the daemon's in-memory MCP stdin surface
  // and let the agent pull via head/tail/grep/read tools. Gated above
  // as `useAutoStream` — non-TTY piped stdin, no --follow, no --session.
  if (useAutoStream) {
    if (typeof stdin.setEncoding === "function") {
      stdin.setEncoding("utf8");
    }
    runStreamingPath({
      conn,
      sessionId,
      opts,
      stdin,
      stderr,
      sendInline: sendChunk,
      onEof: () => {
        stdinEnded = true;
        if (!draining && chunkQueue.length === 0) {
          void settle(exitCode);
        }
      },
      onError: (err) => {
        stderr(`hydra-acp cat: stdin error: ${err.message}\n`);
        exitCode = 1;
        stdinEnded = true;
        if (!draining && chunkQueue.length === 0) {
          void settle(exitCode);
        }
      },
      onPromptFailed: (err) => {
        stderr(`hydra-acp cat: ${err.message}\n`);
        exitCode = 1;
        stdinEnded = true;
        if (!draining && chunkQueue.length === 0) {
          void settle(exitCode);
        }
      },
    });
    return done;
  }

  if (typeof stdin.setEncoding === "function") {
    stdin.setEncoding("utf8");
  }

  // Promote to follow-style burst chunking either when the user asked
  // for it (`--follow`, e.g. `tail -f | hydra cat --follow`) OR when
  // they're typing into an attached session at the keyboard
  // (TTY stdin + --session). The latter is interactive: each line the
  // user types should fire immediately, not buffer until ^D.
  const useFollow = opts.follow === true || (stdinIsTty && Boolean(opts.sessionId));

  if (useFollow) {
    // Per-burst chunking: each quiet gap in stdin (detected by
    // setImmediate riding the libuv check phase) flushes the buffered
    // bytes as a new turn. Right for `tail -f` style live streams; the
    // -p mission is sent only on the first chunk (sendChunk gates that
    // via firstChunkSent), so subsequent chunks carry only the new
    // bytes.
    const chunker = createChunker({
      scheduleFlushCheck: (cb) => {
        const h = setImmediate(cb);
        return () => clearImmediate(h);
      },
      onChunk: (text) => {
        chunkQueue.push(text);
        void drainQueue();
      },
    });
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

  // Remaining path: non-TTY stdin attached to an existing session (no
  // --follow). Buffer everything until EOF and send a single prompt —
  // we can't auto-promote to MCP-stream here because mcpStdin is set at
  // session/new time and the existing session may have a totally
  // different MCP configuration.
  let oneShotBuffer = "";
  stdin.on("data", (data: string | Buffer) => {
    oneShotBuffer += typeof data === "string" ? data : data.toString("utf8");
  });
  stdin.on("end", () => {
    stdinEnded = true;
    if (oneShotBuffer.length > 0) {
      chunkQueue.push(oneShotBuffer);
    }
    void drainQueue();
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

// Drives stdin for --stream mode. Heads up at most streamThreshold bytes
// into memory; when we cross the threshold OR see EOF below it, picks
// between INLINE (one text-block prompt) and FILE (open a daemon-side
// stream, hand the agent a file path, pump stdin into it).
interface StreamingPathArgs {
  conn: JsonRpcConnection;
  sessionId: string;
  opts: CatOptions;
  stdin: CatStdin;
  stderr: (chunk: string) => void;
  sendInline: (text: string) => Promise<void>;
  onEof: () => void;
  onError: (err: Error) => void;
  onPromptFailed: (err: Error) => void;
}

function runStreamingPath(args: StreamingPathArgs): void {
  const { conn, sessionId, opts, stdin, stderr, sendInline } = args;
  const threshold = opts.streamThreshold ?? DEFAULT_STREAM_THRESHOLD;

  type Mode = "undecided" | "inline" | "file";
  let mode: Mode = "undecided";
  let headBuffer = Buffer.alloc(0);
  let stdinClosed = false;
  // Once we're in FILE mode, every stdin chunk goes through this
  // promise chain so writes land in order even though they're fired
  // sync from the "data" handler.
  let writeChain: Promise<unknown> = Promise.resolve();

  const writeToStream = (chunk: Buffer, eof: boolean): void => {
    const payload: Record<string, unknown> = {
      sessionId,
      chunk: chunk.toString("base64"),
    };
    if (eof) {
      payload.eof = true;
    }
    writeChain = writeChain
      .then(() => conn.request("hydra-acp/stream/write", payload))
      .catch((err) => {
        stderr(
          `hydra-acp cat: stream_write failed: ${(err as Error).message}\n`,
        );
      });
  };

  const flushInline = async (): Promise<void> => {
    mode = "inline";
    const text = headBuffer.toString("utf8");
    headBuffer = Buffer.alloc(0);
    try {
      await sendInline(text);
    } catch (err) {
      args.onPromptFailed(err as Error);
      return;
    }
    args.onEof();
  };

  const switchToFile = async (): Promise<void> => {
    mode = "file";
    let open: { capacityBytes: number };
    try {
      const openParams: Record<string, unknown> = {
        sessionId,
        mode: "memory",
      };
      if (opts.streamBufferBytes !== undefined) {
        openParams.capacityBytes = opts.streamBufferBytes;
      }
      open = (await conn.request("hydra-acp/stream/open", openParams)) as {
        capacityBytes: number;
      };
    } catch (err) {
      args.onPromptFailed(
        new Error(`stream_open failed: ${(err as Error).message}`),
      );
      return;
    }
    // Drain the head buffer into the ring BEFORE firing the kick-off
    // prompt — that way when the agent calls tail_stdin / read_stdin
    // it sees at minimum what cat had already buffered locally.
    if (headBuffer.length > 0) {
      writeToStream(headBuffer, false);
      headBuffer = Buffer.alloc(0);
    }
    await writeChain.catch(() => undefined);

    const promptText = buildStreamPromptText(opts.prompt, open.capacityBytes);
    // Fire the kick-off prompt without awaiting — its response (turn
    // completion) is what triggers settle below. We need to keep
    // pumping stdin into the stream while the agent works.
    const promptDone = conn
      .request(
        "session/prompt",
        catPromptParams(sessionId, [{ type: "text", text: promptText }]),
      )
      .catch((err) => {
        args.onPromptFailed(
          new Error(`prompt failed: ${(err as Error).message}`),
        );
      });
    // When the prompt resolves (turn_complete), let the caller know so
    // it can settle. If stdin is still open, the caller will treat the
    // remaining stdin as orphan output — which matches today's "agent
    // ended the turn first" semantics.
    void promptDone.then(() => {
      // Mark eof on the stream so any agent doing a follow-up live
      // tail sees a clean end-of-input.
      if (!stdinClosed) {
        writeToStream(Buffer.alloc(0), true);
      }
      args.onEof();
    });
  };

  stdin.on("data", (data: string | Buffer) => {
    const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    if (mode === "undecided") {
      headBuffer = Buffer.concat([headBuffer, buf]);
      if (headBuffer.length > threshold) {
        void switchToFile();
      }
      return;
    }
    if (mode === "file") {
      writeToStream(buf, false);
      return;
    }
    // inline mode shouldn't see post-EOF data; if it does, just hold
    // it in the buffer in case the caller wants to peek.
    headBuffer = Buffer.concat([headBuffer, buf]);
  });

  stdin.on("end", () => {
    stdinClosed = true;
    if (mode === "undecided") {
      void flushInline();
      return;
    }
    if (mode === "file") {
      writeToStream(Buffer.alloc(0), true);
      // settle happens in switchToFile's promptDone.then() — don't
      // double-fire.
    }
  });

  stdin.on("error", args.onError);
}

function buildStreamPromptText(
  standing: string | undefined,
  ringCapacityBytes: number,
): string {
  const capHuman =
    ringCapacityBytes >= 1024 * 1024
      ? `${(ringCapacityBytes / (1024 * 1024)).toFixed(0)} MB`
      : `${(ringCapacityBytes / 1024).toFixed(0)} KB`;
  const toolNote =
    `The user has piped data into this session. The bytes are NOT in your prompt; ` +
    `they live in the \`hydra-acp-stdin\` MCP server and you read them via its tools:\n` +
    `- \`info()\` — current writeCursor / oldestAvailable / capacity / closed. Cheap; call first to see how much data is there.\n` +
    `- \`grep({pattern, regex?, case_insensitive?, context_before?, context_after?, cursor?})\` — server-side line filter; returns matching lines as decoded strings (not base64). Prefer this for "find lines that mention X" questions on multi-MB inputs.\n` +
    `- \`head({bytes})\` — first N bytes (good for headers / preamble / file signatures).\n` +
    `- \`tail({bytes})\` — most recent N bytes (good for log endings / recent errors).\n` +
    `- \`read({cursor, max_bytes, wait_ms})\` — windowed read at an absolute byte cursor; iterate to sweep the whole stream.\n` +
    `- \`wait_for_more({cursor, timeout_ms})\` — block for new bytes past a cursor (only useful for live tails).\n\n` +
    `Byte payloads (head/tail/read) come back base64-encoded — decode before reading them as text. ` +
    `\`grep\` returns plain strings. ` +
    `The ring holds the most recent ~${capHuman}; older bytes are evicted, and the byte tools report the gap when that happens. ` +
    `Per-call cap is 64 KiB for byte tools; loop \`read\` (advancing the cursor by \`nextCursor\`) when you need more.`;
  if (standing && standing.length > 0) {
    return (
      `${toolNote}\n\n` +
      `Use those tools NOW to answer the user's question — do not ask whether to check stdin; just check it. ` +
      `Pick the right tool for the question (grep for finding specific lines, head for preamble / file type, ` +
      `tail for recent events, read + cursor sweep for whole-stream scans), then answer.\n\n` +
      `User's question:\n${standing}`
    );
  }
  return (
    `${toolNote}\n\n` +
    `Use those tools to inspect the piped input and report what's there. ` +
    `Start with \`info()\` to see the size, then \`head\` and/or \`tail\` to look at the bytes.`
  );
}

async function openOrAttachSession(
  conn: JsonRpcConnection,
  opts: CatOptions,
  useAutoStream: boolean,
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
      clientInfo: { name: HYDRA_CAT_CLIENT_NAME, version: HYDRA_VERSION },
    })) as { sessionId: string };
    return attached.sessionId;
  }
  const hydraMeta: Record<string, unknown> = {};
  if (opts.name) {
    hydraMeta.name = opts.name;
  } else {
    const derived = deriveTitleFromPrompt(opts.prompt);
    if (derived) {
      hydraMeta.name = derived;
    }
  }
  if (opts.model) {
    hydraMeta.model = opts.model;
  }
  if (useAutoStream) {
    // Tell the daemon to mint a per-session MCP token, open the stdin
    // ring in-memory, and inject `hydra-acp-stdin` into the agent's
    // mcpServers so it has tail / read / wait_for_more / info / head /
    // grep available for this turn.
    hydraMeta.mcpStdin = true;
  }
  // The session is born undecided (interactive: undefined). cat keeps it
  // out of default listings not at birth but per-turn: every prompt cat
  // sends carries _meta.ancillary (see catPromptParams), so the daemon's
  // promotion gate never flips it to interactive. Leaving it undefined
  // means a human who later attaches and sends a real turn promotes it.
  const cwd = opts.cwd ?? process.cwd();
  const params: Record<string, unknown> = { cwd };
  if (opts.agentId) {
    hydraMeta.agentId = opts.agentId;
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
