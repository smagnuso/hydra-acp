import { z } from "zod";

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
  SessionNotFound: -32001,
  PermissionDenied: -32002,
  AlreadyAttached: -32003,
  RoleNotPermitted: -32004,
  AgentNotInstalled: -32005,
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

export const SessionRole = z.enum(["controller", "observer"]);
export type SessionRole = z.infer<typeof SessionRole>;

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
  role: SessionRole.default("controller"),
  historyPolicy: HistoryPolicy.default("full"),
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

export interface HydraMeta {
  upstreamSessionId?: string;
  agentId?: string;
  cwd?: string;
  name?: string;
  agentArgs?: string[];
  resume?: SessionResumeHints;
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

export const SessionListEntry = z.object({
  sessionId: z.string(),
  upstreamSessionId: z.string().optional(),
  cwd: z.string(),
  title: z.string().optional(),
  agentId: z.string().optional(),
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

export interface AttachCapability {
  roles: SessionRole[];
}

export interface SessionCapabilities {
  attach?: AttachCapability;
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
