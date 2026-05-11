export { startDaemon } from "./daemon/server.js";
export { Registry, planSpawn } from "./core/registry.js";
export { SessionManager } from "./core/session-manager.js";
export { Session } from "./core/session.js";
export { AgentInstance } from "./core/agent-instance.js";
export { JsonRpcConnection } from "./acp/connection.js";
export type { MessageStream } from "./acp/framing.js";
export { ndjsonStreamFromStdio } from "./acp/framing.js";
export { wsToMessageStream } from "./acp/ws-stream.js";
export {
  loadConfig,
  ensureConfig,
  writeConfig,
  defaultConfig,
  generateAuthToken,
} from "./core/config.js";
export type { HydraConfig } from "./core/config.js";
export { paths } from "./core/paths.js";
export type {
  SessionAttachParams,
  SessionDetachParams,
  SessionListParams,
  SessionListResult,
  SessionListEntry,
  InitializeResult,
  AgentCapabilities,
  SessionCapabilities,
  HistoryPolicy,
} from "./acp/types.js";
