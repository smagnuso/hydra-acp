import * as fs from "node:fs";
import { ndjsonStreamFromStdio } from "../acp/framing.js";
import { loadConfig } from "../core/config.js";
import {
  resolveLocalTarget,
  type RemoteTarget,
} from "../core/remote-target.js";
import { ensureDaemonReachable } from "../core/daemon-bootstrap.js";
import {
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
} from "../acp/types.js";
import { ResilientWsStream } from "./resilient-ws.js";
import { SessionTracker, type ResumeContext } from "./session-tracker.js";
import type { MessageStream } from "../acp/framing.js";
import { buildApproveResponse } from "../acp/permission-pick.js";
import { HYDRA_VERSION } from "../core/hydra-version.js";
import { paths } from "../core/paths.js";
import {
  buildTitleFromArgv,
  setHydraProcessTitle,
} from "../core/process-title.js";

export interface ShimOptions {
  sessionId?: string;
  agentId?: string;
  agentArgs?: string[];
  name?: string;
  model?: string;
  // Pre-resolved daemon target. Set by the cli.ts dispatcher when
  // --session is a hydra:// URL so the shim talks to a remote daemon
  // rather than the local one. Local invocations leave this
  // undefined and fall through to resolveLocalTarget(config).
  target?: RemoteTarget;
  // Approve every session/request_permission from the daemon without
  // forwarding it to the downstream editor. The CLI prints a stderr
  // warning at startup so it's never silent.
  dangerouslySkipPermissions?: boolean;
}

export async function runShim(opts: ShimOptions): Promise<void> {
  // Shim mode is non-interactive — invoked by an editor over piped
  // stdio, not typed by the user. Pin the comm name to "hydra-shim"
  // so `killall hydra` (matches user-invoked TUI/cat) leaves these
  // alone, and `killall hydra-shim` cleanly takes out only the
  // editor-spawned children. Same logic as the daemon's
  // process.title = "hydra-daemon" override: the user didn't pick
  // this name, so it shouldn't follow the bin they invoked.
  //
  // The `ps`/`top` argv column still shows the full invocation
  // (`hydra-acp shim ...` or `hydra launch claude-acp ...`) so
  // multiple editor-spawned shims remain distinguishable from each
  // other by cwd / session id / agent.
  setHydraProcessTitle(buildTitleFromArgv(process.argv.slice(2)), {
    commName: "hydra-shim",
  });
  const config = await loadConfig();
  const target = opts.target ?? (await resolveLocalTarget(config));
  // Only autostart the daemon when we're talking to a local one. A
  // remote target either has the daemon up (good) or doesn't (we
  // can't help from here; the WS layer will surface the failure).
  if (target.isLocal && !opts.target) {
    await ensureDaemonReachable(config);
  }

  const tracker = new SessionTracker();
  const downstream = ndjsonStreamFromStdio(process.stdin, process.stdout);

  const url = target.wsUrl;
  const subprotocols = ["acp.v1", `hydra-acp-token.${target.token}`];
  const upstream = new ResilientWsStream({
    url,
    subprotocols,
    onConnect: async (firstConnect) => {
      if (firstConnect) {
        return;
      }
      tracker.clearPending();
      await cancelPendingPermissions(tracker, downstream);
      const contexts = tracker.list();
      if (contexts.length === 0) {
        return;
      }
      process.stderr.write(
        `hydra-acp: reconnected; resuming ${contexts.length} session(s)\n`,
      );
      for (const ctx of contexts) {
        await replayAttach(upstream, ctx, tracker.lastMessageId(ctx.sessionId));
      }
    },
  });

  wireShim({ opts, upstream, downstream, tracker });

  upstream.onClose((err) => {
    if (err) {
      process.stderr.write(`hydra-acp: ${err.message}\n`);
    }
    void downstream.close();
    process.exit(err ? 1 : 0);
  });
  downstream.onClose(() => {
    void upstream.close();
    process.exit(0);
  });

  await upstream.start();
}

export interface WireShimArgs {
  opts: ShimOptions;
  upstream: MessageStream;
  downstream: MessageStream;
  tracker: SessionTracker;
}

export function wireShim({
  opts,
  upstream,
  downstream,
  tracker,
}: WireShimArgs): void {
  upstream.onMessage((msg) => {
    wireLog("daemon→client", msg);
    tracker.observeFromServer(msg);
    // --dangerously-skip-permissions: when the daemon asks us to
    // approve a tool call, reply directly to upstream with an "allow"
    // option and DON'T forward to downstream — the editor would just
    // see a permission UI for a decision we've already made.
    if (
      opts.dangerouslySkipPermissions === true &&
      isPermissionRequest(msg)
    ) {
      void upstream.send({
        jsonrpc: "2.0",
        id: msg.id,
        result: buildApproveResponse(msg.params),
      });
      return;
    }
    // Daemon-side `session/update`/`permission_resolved` (sibling answered
    // first). Forward the notification AND synthesize a JSON-RPC response
    // so local clients (agent-shell, hydra-tui) that only register an
    // `onRequest` handler still see their pending request resolve and
    // their UI clear.
    maybeReplyToResolvedPermission(msg, tracker, downstream);
    void downstream.send(msg);
  });

  const namingState = { name: opts.name, used: false };

  downstream.onMessage((msg) => {
    wireLog("client→daemon", msg);
    tracker.observeFromClient(msg);
    if (isInitializeRequest(msg)) {
      void upstream.send(normaliseInitializeClientInfo(msg));
      return;
    }
    if (isSessionNewRequest(msg)) {
      if (opts.sessionId) {
        void upstream.send(buildAttachFromNew(msg, opts.sessionId));
        return;
      }
      let outgoing = msg;
      if (opts.agentId) {
        outgoing = rewriteSessionNewWithAgent(outgoing, opts.agentId);
      }
      if (opts.agentArgs && opts.agentArgs.length > 0) {
        outgoing = injectHydraMeta(outgoing, { agentArgs: opts.agentArgs });
      }
      if (namingState.name && !namingState.used) {
        outgoing = injectHydraMeta(outgoing, { name: namingState.name });
        namingState.used = true;
      }
      if (opts.model) {
        outgoing = injectHydraMeta(outgoing, { model: opts.model });
      }
      void upstream.send(outgoing);
      return;
    }
    void upstream.send(msg);
  });
}

function maybeReplyToResolvedPermission(
  msg: JsonRpcMessage,
  tracker: SessionTracker,
  downstream: MessageStream,
): void {
  const update = extractPermissionResolvedUpdate(msg);
  if (!update) {
    return;
  }
  const toolCallId =
    typeof update.toolCallId === "string" ? update.toolCallId : undefined;
  if (!toolCallId) {
    return;
  }
  const pending = tracker.takePendingPermissionByToolCall(toolCallId);
  if (!pending) {
    return;
  }
  const outcome = reconstructOutcome(update);
  void downstream
    .send({
      jsonrpc: "2.0",
      id: pending.requestId,
      result: outcome ? { outcome } : null,
    })
    .catch(() => undefined);
}

interface PermissionResolvedUpdate {
  sessionUpdate: "permission_resolved";
  toolCallId?: unknown;
  chosenOptionId?: unknown;
  outcome?: unknown;
  resolvedBy?: unknown;
}

function extractPermissionResolvedUpdate(
  msg: JsonRpcMessage,
): PermissionResolvedUpdate | undefined {
  if (!isSessionUpdateNotification(msg)) {
    return undefined;
  }
  const params = (msg.params ?? {}) as { update?: unknown };
  const update = params.update;
  if (
    !update ||
    typeof update !== "object" ||
    (update as { sessionUpdate?: unknown }).sessionUpdate !==
      "permission_resolved"
  ) {
    return undefined;
  }
  return update as PermissionResolvedUpdate;
}

function isSessionUpdateNotification(
  msg: JsonRpcMessage,
): msg is JsonRpcNotification & { method: "session/update" } {
  return (
    "method" in msg &&
    msg.method === "session/update" &&
    !("id" in msg && msg.id !== undefined)
  );
}

// Rebuild the `{ outcome }` body that downstream clients expect as the
// JSON-RPC response to their original `session/request_permission`.
// Prefer the daemon's explicit `outcome` (our proposed extension) and
// fall back to reconstructing one from `chosenOptionId` so a future
// spec-strict emitter still works.
function reconstructOutcome(
  update: PermissionResolvedUpdate,
): Record<string, unknown> | undefined {
  if (update.outcome && typeof update.outcome === "object") {
    return update.outcome as Record<string, unknown>;
  }
  if (typeof update.chosenOptionId === "string") {
    return { kind: "selected", optionId: update.chosenOptionId };
  }
  return undefined;
}

async function cancelPendingPermissions(
  tracker: SessionTracker,
  downstream: MessageStream,
): Promise<void> {
  const pendings = tracker.takePendingPermissions();
  if (pendings.length === 0) {
    return;
  }
  process.stderr.write(
    `hydra-acp: cancelling ${pendings.length} pending permission request(s)\n`,
  );
  for (const pending of pendings) {
    const sessionId =
      typeof pending.params.sessionId === "string"
        ? pending.params.sessionId
        : undefined;
    if (!sessionId) {
      continue;
    }
    const update: Record<string, unknown> = {
      sessionUpdate: "permission_resolved",
      outcome: { kind: "cancelled", reason: "daemon-disconnected" },
      resolvedBy: { clientId: "hydra-acp" },
    };
    if (pending.toolCallId) {
      update.toolCallId = pending.toolCallId;
    }
    await downstream
      .send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update },
      })
      .catch(() => undefined);
  }
}


async function replayAttach(
  stream: ResilientWsStream,
  ctx: ResumeContext,
  afterMessageId: string | undefined,
): Promise<void> {
  const resumeHints: Record<string, unknown> = {
    upstreamSessionId: ctx.upstreamSessionId,
    agentId: ctx.agentId,
    cwd: ctx.cwd,
  };
  if (ctx.title !== undefined) {
    resumeHints.title = ctx.title;
  }
  if (ctx.agentArgs && ctx.agentArgs.length > 0) {
    resumeHints.agentArgs = ctx.agentArgs;
  }
  // Prefer after_message replay so we only resync what was missed
  // during the disconnect. Falls back to pending_only when we have no
  // anchor (no prompt_received/turn_complete observed yet this
  // session). The daemon will silently downgrade after_message to
  // "full" if the id is unknown — surfaced in response.historyPolicy
  // but harmless either way.
  const params: Record<string, unknown> = {
    sessionId: ctx.sessionId,
    _meta: { "hydra-acp": { resume: resumeHints } },
  };
  if (afterMessageId) {
    params.historyPolicy = "after_message";
    params.afterMessageId = afterMessageId;
  } else {
    params.historyPolicy = "pending_only";
  }
  const request: JsonRpcRequest = {
    jsonrpc: "2.0",
    id: `resume-${ctx.sessionId}-${Date.now()}`,
    method: "session/attach",
    params,
  };
  try {
    const resp = await stream.request(request);
    if (resp.error) {
      process.stderr.write(
        `hydra-acp: replay attach for ${ctx.sessionId} failed: ${resp.error.message}\n`,
      );
    }
  } catch (err) {
    process.stderr.write(
      `hydra-acp: failed to replay attach for ${ctx.sessionId}: ${(err as Error).message}\n`,
    );
  }
}

function isSessionNewRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return (
    "method" in msg &&
    "id" in msg &&
    msg.id !== undefined &&
    msg.method === "session/new"
  );
}

function isInitializeRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return (
    "method" in msg &&
    "id" in msg &&
    msg.id !== undefined &&
    msg.method === "initialize"
  );
}

// Preserve every field the downstream client sent; only stamp
// clientInfo.name + version when the client didn't identify itself. This
// keeps a future client that sets clientInfo.name="zed" (or anything
// else) flowing through unchanged, while anonymous initialises land on
// the daemon tagged as `hydra-acp-shim` so they're not invisible in
// session listings.
export function normaliseInitializeClientInfo(
  msg: JsonRpcRequest,
): JsonRpcRequest {
  const params = (msg.params ?? {}) as Record<string, unknown>;
  const existing = params.clientInfo;
  const existingObj =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : undefined;
  const existingName =
    existingObj && typeof existingObj.name === "string"
      ? existingObj.name.trim()
      : "";
  if (existingName.length > 0) {
    return msg;
  }
  return {
    ...msg,
    params: {
      ...params,
      clientInfo: {
        ...(existingObj ?? {}),
        name: "hydra-acp-shim",
        version: HYDRA_VERSION,
      },
    },
  };
}

function isPermissionRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return (
    "method" in msg &&
    "id" in msg &&
    msg.id !== undefined &&
    msg.method === "session/request_permission"
  );
}

function buildAttachFromNew(
  msg: JsonRpcRequest,
  sessionId: string,
): JsonRpcRequest {
  return {
    jsonrpc: "2.0",
    id: msg.id,
    method: "session/attach",
    params: {
      sessionId,
      historyPolicy: "full",
    },
  };
}

function rewriteSessionNewWithAgent(
  msg: JsonRpcRequest,
  agentId: string,
): JsonRpcRequest {
  const params = (msg.params ?? {}) as Record<string, unknown>;
  return {
    ...msg,
    params: { ...params, agentId },
  };
}

// Diagnostic wire dump. Opt-in via HYDRA_SHIM_WIRE_LOG (any non-empty
// value enables it). Append-only NDJSON at paths.shimWireLogFile(). Pid
// is included on every line so concurrent shims (Zed spawns one per
// agent panel) remain distinguishable. The file is rotated once on
// first write of each process if it has grown past WIRE_LOG_MAX_BYTES,
// so an enabled long-running install doesn't accumulate gigabytes.
const WIRE_LOG_MAX_BYTES = 25 * 1024 * 1024;
let wireLogChecked = false;
let wireLogPath: string | null = null;
function wireLog(direction: "client→daemon" | "daemon→client", msg: unknown): void {
  if (!process.env.HYDRA_SHIM_WIRE_LOG) {
    return;
  }
  if (!wireLogChecked) {
    wireLogChecked = true;
    try {
      wireLogPath = paths.shimWireLogFile();
      fs.mkdirSync(paths.home(), { recursive: true });
      const st = fs.statSync(wireLogPath, { throwIfNoEntry: false });
      if (st && st.size > WIRE_LOG_MAX_BYTES) {
        fs.renameSync(wireLogPath, `${wireLogPath}.1`);
      }
    } catch {
      wireLogPath = null;
    }
  }
  if (!wireLogPath) {
    return;
  }
  try {
    const line =
      JSON.stringify({
        t: new Date().toISOString(),
        pid: process.pid,
        dir: direction,
        msg,
      }) + "\n";
    fs.appendFile(wireLogPath, line, () => undefined);
  } catch {
    // Diagnostic logging is best-effort; never block the shim on IO.
  }
}

function injectHydraMeta(
  msg: JsonRpcRequest,
  additions: Record<string, unknown>,
): JsonRpcRequest {
  const params = (msg.params ?? {}) as Record<string, unknown>;
  const existingMeta = (params._meta ?? {}) as Record<string, unknown>;
  const existingHydra =
    (existingMeta["hydra-acp"] as Record<string, unknown> | undefined) ?? {};
  return {
    ...msg,
    params: {
      ...params,
      _meta: {
        ...existingMeta,
        "hydra-acp": {
          ...existingHydra,
          ...additions,
        },
      },
    },
  };
}

