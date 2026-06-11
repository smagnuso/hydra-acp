import { z } from "zod";

// hydra-acp/agents/install_progress — daemon → client. Fires while the
// agent's binary or npm package is being fetched during session/new or
// session/attach. The notification is *not* keyed by sessionId (the
// session doesn't exist yet on session/new); the originating WS
// connection is the implicit scope. `phase` mirrors the structured
// callback shape from binary-install / npm-install:
//   - "download_start"     — total size known, bytes still 0
//   - "download_progress"  — periodic byte tick (~150ms)
//   - "download_done"      — last byte received
//   - "extract"            — tar / unzip step (binary only)
//   - "install_start"      — npm install began (npx only)
//   - "installed"          — everything is on disk and ready
// source distinguishes the channel so the TUI can pick the right copy
// ("Downloading…" vs "Installing via npm…").
export const AgentInstallProgressParams = z.object({
  agentId: z.string(),
  version: z.string(),
  source: z.enum(["binary", "npm"]),
  phase: z.enum([
    "download_start",
    "download_progress",
    "download_done",
    "extract",
    "install_start",
    "installed",
  ]),
  receivedBytes: z.number().optional(),
  totalBytes: z.number().optional(),
  packageSpec: z.string().optional(),
});
export type AgentInstallProgressParams = z.infer<typeof AgentInstallProgressParams>;

export const AGENT_INSTALL_PROGRESS_METHOD = "hydra-acp/agents/install_progress";

export interface SessionCapabilities {
  attach?: Record<string, never>;
  // Per the ratified Session List spec (stabilized 2026-03-09), capability
  // is advertised as an empty object `{}`, matching the `attach` shape.
  // See https://agentclientprotocol.com/protocol/session-list
  list?: Record<string, never>;
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
    // ACP auth method type per AUTHENTICATION.md: "agent" (OAuth flow
    // managed by the agent) or "terminal" (interactive --setup). When
    // omitted, "agent" is assumed for backward compatibility.
    type?: "agent" | "terminal";
  }>;
  // Hydra-only extensions ride in _meta["hydra-acp"]; see HydraMeta.
  // Generic ACP clients ignore the field, so this is additive only.
  _meta?: Record<string, unknown>;
}
