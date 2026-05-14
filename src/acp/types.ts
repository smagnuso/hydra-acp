import { z } from "zod";

// The ACP wire protocol version that hydra speaks. Single source of
// truth for every `initialize` handshake (daemon → agent, TUI → daemon,
// shim proxy) so the value isn't repeated as a literal across the
// codebase. A protocol bump touches this constant and the matching
// agreed version negotiation logic — not every callsite.
export const ACP_PROTOCOL_VERSION = 1;

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export const JsonRpcErrorCodes = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  // -32001…-32003 reserved for RFD #533 attach semantics:
  //   -32001 Session not found
  //   -32002 Not authorised to attach
  //   -32003 Session does not support multi-client attach
  // We emit -32001 (matching); the other two are reserved for spec
  // alignment even though we don't currently emit them (we bearer-auth
  // at WS upgrade time and always support multi-client attach).
  SessionNotFound: -32001,
  NotAuthorisedToAttach: -32002,
  MultiClientNotSupported: -32003,
  AgentNotInstalled: -32005,
  // Hydra-internal codes — outside the RFD's reserved range so they
  // can't collide with future spec assignments.
  BundleAlreadyImported: -32010,
  PermissionDenied: -32011,
  AlreadyAttached: -32012,
} as const;

export const InitializeParams = z.object({
  protocolVersion: z.number().optional(),
  clientCapabilities: z.record(z.unknown()).optional(),
  clientInfo: z
    .object({
      name: z.string(),
      version: z.string().optional(),
    })
    .optional(),
});
export type InitializeParams = z.infer<typeof InitializeParams>;

export const HistoryPolicy = z.enum(["full", "pending_only", "none"]);
export type HistoryPolicy = z.infer<typeof HistoryPolicy>;

export const SessionNewParams = z.object({
  cwd: z.string(),
  agentId: z.string().optional(),
  mcpServers: z.array(z.unknown()).optional(),
});
export type SessionNewParams = z.infer<typeof SessionNewParams>;

export const SessionResumeHints = z.object({
  upstreamSessionId: z.string(),
  agentId: z.string(),
  cwd: z.string(),
  title: z.string().optional(),
  agentArgs: z.array(z.string()).optional(),
});
export type SessionResumeHints = z.infer<typeof SessionResumeHints>;

export const SessionAttachParams = z.object({
  sessionId: z.string(),
  historyPolicy: HistoryPolicy.default("full"),
  // Caller-assigned opaque id (e.g. a UUID). When provided, the proxy
  // echoes it in resolvedBy/sentBy and lifecycle events so other
  // clients can disambiguate multiple instances of the same
  // clientInfo.name. When omitted, the proxy assigns one and returns
  // it in the response. Per RFD #533.
  clientId: z.string().optional(),
  clientInfo: z
    .object({
      name: z.string(),
      version: z.string().optional(),
    })
    .optional(),
  _meta: z.record(z.unknown()).optional(),
});
export type SessionAttachParams = z.infer<typeof SessionAttachParams>;

export const HYDRA_META_KEY = "hydra-acp";

export interface HydraAdvertisedCommand {
  name: string;
  description?: string;
}

export interface HydraMeta {
  upstreamSessionId?: string;
  agentId?: string;
  cwd?: string;
  name?: string;
  agentArgs?: string[];
  resume?: SessionResumeHints;
  // Caller-requested model id for a fresh session/new. One-shot: the daemon
  // issues session/set_model with this value during bootstrapAgent and then
  // forgets it — meta.json carries `currentModel` (response-shaped) instead.
  // Resurrect ignores this field by design.
  model?: string;
  // Snapshot state delivered on the attach/new response so clients
  // don't need to wait for history replay to know the current model,
  // mode, or command palette.
  currentModel?: string;
  currentMode?: string;
  availableCommands?: HydraAdvertisedCommand[];
  // Epoch-ms when the in-flight agent turn began. Present only when
  // mid-turn at attach response time; lets a fresh client boot with
  // the busy banner already showing the right elapsed time rather
  // than waiting for the next live update.
  turnStartedAt?: number;
}

export function extractHydraMeta(
  meta: Record<string, unknown> | undefined,
): HydraMeta {
  if (!meta) {
    return {};
  }
  const namespaced = meta[HYDRA_META_KEY];
  if (!namespaced || typeof namespaced !== "object" || Array.isArray(namespaced)) {
    return {};
  }
  const obj = namespaced as Record<string, unknown>;
  const out: HydraMeta = {};
  if (typeof obj.upstreamSessionId === "string") {
    out.upstreamSessionId = obj.upstreamSessionId;
  }
  if (typeof obj.agentId === "string") {
    out.agentId = obj.agentId;
  }
  if (typeof obj.cwd === "string") {
    out.cwd = obj.cwd;
  }
  if (typeof obj.name === "string") {
    out.name = obj.name;
  }
  if (Array.isArray(obj.agentArgs) && obj.agentArgs.every((a) => typeof a === "string")) {
    out.agentArgs = obj.agentArgs as string[];
  }
  if (obj.resume) {
    const parsed = SessionResumeHints.safeParse(obj.resume);
    if (parsed.success) {
      out.resume = parsed.data;
    }
  }
  if (typeof obj.model === "string") {
    out.model = obj.model;
  }
  if (typeof obj.currentModel === "string") {
    out.currentModel = obj.currentModel;
  }
  if (typeof obj.currentMode === "string") {
    out.currentMode = obj.currentMode;
  }
  if (typeof obj.turnStartedAt === "number" && obj.turnStartedAt > 0) {
    out.turnStartedAt = obj.turnStartedAt;
  }
  if (Array.isArray(obj.availableCommands)) {
    const cmds: HydraAdvertisedCommand[] = [];
    for (const raw of obj.availableCommands) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        continue;
      }
      const c = raw as Record<string, unknown>;
      if (typeof c.name !== "string") {
        continue;
      }
      const cmd: HydraAdvertisedCommand = { name: c.name };
      if (typeof c.description === "string") {
        cmd.description = c.description;
      }
      cmds.push(cmd);
    }
    if (cmds.length > 0) {
      out.availableCommands = cmds;
    }
  }
  return out;
}

export function mergeMeta(
  passthrough: Record<string, unknown> | undefined,
  ours: Record<string, unknown>,
): Record<string, unknown> {
  return { ...(passthrough ?? {}), [HYDRA_META_KEY]: ours };
}

export const SessionDetachParams = z.object({
  sessionId: z.string(),
});
export type SessionDetachParams = z.infer<typeof SessionDetachParams>;

export const SessionListParams = z.object({
  cwd: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.number().int().positive().max(200).optional(),
});
export type SessionListParams = z.infer<typeof SessionListParams>;

// Last-known usage snapshot (tokens + cost) for a session. Fields are
// individually optional — agents emit varying subsets and the persisted
// record merges them across events. Listed sessions surface whatever
// was last seen on disk; live sessions surface the in-memory state.
export const SessionListUsage = z.object({
  used: z.number().optional(),
  size: z.number().optional(),
  costAmount: z.number().optional(),
  costCurrency: z.string().optional(),
});
export type SessionListUsage = z.infer<typeof SessionListUsage>;

export const SessionListEntry = z.object({
  sessionId: z.string(),
  upstreamSessionId: z.string().optional(),
  cwd: z.string(),
  title: z.string().optional(),
  agentId: z.string().optional(),
  // Last-known model id, so list views can render `<agent>(<model>)`
  // without resurrecting cold sessions to look it up.
  currentModel: z.string().optional(),
  // Last-known usage snapshot so list views can show per-session cost
  // (and tokens, in callers that care) without resurrecting cold sessions.
  currentUsage: SessionListUsage.optional(),
  updatedAt: z.string(),
  attachedClients: z.number().int().nonnegative(),
  status: z.enum(["live", "cold"]).default("live"),
  _meta: z.record(z.unknown()).optional(),
});
export type SessionListEntry = z.infer<typeof SessionListEntry>;

export const SessionListResult = z.object({
  sessions: z.array(SessionListEntry),
  nextCursor: z.string().optional(),
});
export type SessionListResult = z.infer<typeof SessionListResult>;

export const SessionPromptParams = z.object({
  sessionId: z.string(),
  prompt: z.array(z.unknown()),
});
export type SessionPromptParams = z.infer<typeof SessionPromptParams>;

export const SessionCancelParams = z.object({
  sessionId: z.string(),
});
export type SessionCancelParams = z.infer<typeof SessionCancelParams>;

export interface SessionCapabilities {
  attach?: Record<string, never>;
  list?: boolean;
}

export interface PromptCapabilities {
  image?: boolean;
  audio?: boolean;
  embeddedContext?: boolean;
}

export interface McpCapabilities {
  http?: boolean;
  sse?: boolean;
}

export interface AgentCapabilities {
  promptCapabilities?: PromptCapabilities;
  mcpCapabilities?: McpCapabilities;
  loadSession?: boolean;
  sessionCapabilities?: SessionCapabilities;
}

export interface InitializeResult {
  protocolVersion: number;
  agentCapabilities: AgentCapabilities;
  agentInfo: {
    name: string;
    version: string;
  };
  authMethods?: Array<{
    id: string;
    description: string;
  }>;
}

export const ProxyInitializeParams = z.object({
  protocolVersion: z.number().optional(),
  proxyInfo: z
    .object({
      name: z.string(),
      version: z.string().optional(),
    })
    .optional(),
  successor: z
    .object({
      command: z.array(z.string()),
      env: z.record(z.string()).optional(),
    })
    .optional(),
});
export type ProxyInitializeParams = z.infer<typeof ProxyInitializeParams>;
