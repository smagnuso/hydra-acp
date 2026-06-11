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
  // Per JSON-RPC 2.0, `id` MUST be null when a server-side error makes
  // the request id undeterminable (e.g. a parse error on the frame
  // itself). The framing layers synthesize such responses with id=null;
  // peer-correlated responses use the same id as the request.
  id: JsonRpcId | null;
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
  // -32000 is the first server-defined slot per JSON-RPC 2.0; the ACP
  // AUTHENTICATION.md spec assigns it to AUTH_REQUIRED, returned by an
  // agent when a method needs a prior `authenticate` round-trip.
  AuthRequired: -32000,
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
  StreamNotEnabled: -32013,
  // Session is mid-close (regen running, agent about to be killed).
  // Attach succeeds (read-only view of what was already there) but
  // mutating operations like session/prompt and slash commands are
  // rejected — accepting a new turn whose result we'd discard within
  // seconds would just lose the user's input silently.
  SessionClosing: -32014,
} as const;
