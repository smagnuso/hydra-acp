import { ndjsonStreamFromStdio } from "../acp/framing.js";
import { ensureConfig } from "../core/config.js";
import { ensureDaemonReachable } from "../core/daemon-bootstrap.js";
import {
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
} from "../acp/types.js";
import { ResilientWsStream } from "./resilient-ws.js";
import { SessionTracker, type ResumeContext } from "./session-tracker.js";
import type { MessageStream } from "../acp/framing.js";

export interface ShimOptions {
  sessionId?: string;
  agentId?: string;
  agentArgs?: string[];
  name?: string;
  model?: string;
}

export async function runShim(opts: ShimOptions): Promise<void> {
  const config = await ensureConfig();
  await ensureDaemonReachable(config);

  const tracker = new SessionTracker();
  const downstream = ndjsonStreamFromStdio(process.stdin, process.stdout);

  const protocol = config.daemon.tls ? "wss" : "ws";
  const url = `${protocol}://${config.daemon.host}:${config.daemon.port}/acp`;
  const subprotocols = ["acp.v1", `hydra-acp-token.${config.daemon.authToken}`];
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
        await replayAttach(upstream, ctx);
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
    tracker.observeFromServer(msg);
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
    tracker.observeFromClient(msg);
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
  const request: JsonRpcRequest = {
    jsonrpc: "2.0",
    id: `resume-${ctx.sessionId}-${Date.now()}`,
    method: "session/attach",
    params: {
      sessionId: ctx.sessionId,
      historyPolicy: "pending_only",
      _meta: {
        "hydra-acp": {
          resume: resumeHints,
        },
      },
    },
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

