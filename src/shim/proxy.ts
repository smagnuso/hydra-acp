import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { ndjsonStreamFromStdio } from "../acp/framing.js";
import { JsonRpcConnection } from "../acp/connection.js";
import {
  type HydraConfig,
  loadConfig,
} from "../core/config.js";
import {
  type JsonRpcMessage,
  type JsonRpcRequest,
  type SessionRole,
} from "../acp/types.js";
import { ResilientWsStream } from "./resilient-ws.js";
import { SessionTracker, type ResumeContext } from "./session-tracker.js";
import type { MessageStream } from "../acp/framing.js";

export interface ShimOptions {
  sessionId?: string;
  role?: SessionRole;
  agentId?: string;
  agentArgs?: string[];
  name?: string;
}

export async function runShim(opts: ShimOptions): Promise<void> {
  const config = await loadConfig();
  await ensureDaemonReachable(config);

  const tracker = new SessionTracker();
  const downstream = ndjsonStreamFromStdio(process.stdin, process.stdout);

  const protocol = config.daemon.tls ? "wss" : "ws";
  const url = `${protocol}://${config.daemon.host}:${config.daemon.port}/acp`;
  const subprotocols = ["acp.v1", `acp-hydra-token.${config.daemon.authToken}`];
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
        `acp-hydra: reconnected; resuming ${contexts.length} session(s)\n`,
      );
      for (const ctx of contexts) {
        await replayAttach(upstream, ctx);
      }
    },
  });

  upstream.onMessage((msg) => {
    tracker.observeFromServer(msg);
    void downstream.send(msg);
  });

  const namingState = { name: opts.name, used: false };

  downstream.onMessage((msg) => {
    tracker.observeFromClient(msg);
    if (isSessionNewRequest(msg)) {
      if (opts.sessionId) {
        void upstream.send(buildAttachFromNew(msg, opts.sessionId, opts.role));
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
      void upstream.send(outgoing);
      return;
    }
    void upstream.send(msg);
  });

  upstream.onClose((err) => {
    if (err) {
      process.stderr.write(`acp-hydra: ${err.message}\n`);
    }
    void downstream.close();
    process.exit(err ? 1 : 0);
  });
  downstream.onClose(() => {
    void upstream.close();
    process.exit(0);
  });

  void new JsonRpcConnection(downstream);
  void new JsonRpcConnection(upstream);

  await upstream.start();
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
    `acp-hydra: cancelling ${pendings.length} pending permission request(s)\n`,
  );
  for (const pending of pendings) {
    const params = {
      ...pending.params,
      resolvedBy: "acp-hydra",
      result: {
        outcome: { kind: "cancelled", reason: "daemon-disconnected" },
      },
    };
    await downstream
      .send({
        jsonrpc: "2.0",
        method: "session/permission_resolved",
        params,
      })
      .catch(() => undefined);
  }
}


async function ensureDaemonReachable(config: HydraConfig): Promise<void> {
  const reachable = await pingHealth(config);
  if (reachable) {
    return;
  }
  process.stderr.write("acp-hydra: daemon not running; starting it...\n");
  spawnDaemonDetached();
  await waitForDaemonReady(config);
}

async function pingHealth(config: HydraConfig): Promise<boolean> {
  const protocol = config.daemon.tls ? "https" : "http";
  const url = `${protocol}://${config.daemon.host}:${config.daemon.port}/v1/health`;
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function spawnDaemonDetached(): void {
  const cliPath = process.argv[1];
  if (!cliPath) {
    throw new Error("Cannot determine acp-hydra binary path to spawn daemon");
  }
  const child = spawn(process.execPath, [cliPath, "daemon", "start"], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
}

async function waitForDaemonReady(
  config: HydraConfig,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pingHealth(config)) {
      return;
    }
    await sleep(150);
  }
  throw new Error(
    `acp-hydra daemon did not become ready within ${timeoutMs}ms`,
  );
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
      role: ctx.role,
      historyPolicy: "pending_only",
      _meta: {
        "acp-hydra": {
          resume: resumeHints,
        },
      },
    },
  };
  try {
    await stream.send(request);
  } catch (err) {
    process.stderr.write(
      `acp-hydra: failed to replay attach for ${ctx.sessionId}: ${(err as Error).message}\n`,
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
  role: SessionRole | undefined,
): JsonRpcRequest {
  return {
    jsonrpc: "2.0",
    id: msg.id,
    method: "session/attach",
    params: {
      sessionId,
      role: role ?? "controller",
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
    (existingMeta["acp-hydra"] as Record<string, unknown> | undefined) ?? {};
  return {
    ...msg,
    params: {
      ...params,
      _meta: {
        ...existingMeta,
        "acp-hydra": {
          ...existingHydra,
          ...additions,
        },
      },
    },
  };
}

