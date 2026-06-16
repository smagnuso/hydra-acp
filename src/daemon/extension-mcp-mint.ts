// Mint a per-session bearer token covering every currently-registered
// extension MCP server and produce HTTP descriptors for them.
//
// Used by every session-creation path (session/new on the ACP WS,
// POST /v1/sessions on the REST surface) and by the three resurrect
// paths (session/attach, session/prompt auto-resurrect, session/load)
// so a resurrected session regains the MCP tools it had at original
// create time. Without this, the daemon's in-memory token registry is
// wiped on restart and resurrect passes no mcpServers, leaving the
// agent's tool registry empty.
//
// Returns undefined when there are no extensions registered or the
// registries needed for token minting aren't wired up. On success the
// caller must invoke bindToSession(session) once the session exists
// (binds the bearer + arranges unbind on close) or abandon(err) if
// session creation fails.

import { randomBytes } from "node:crypto";
import type { Session } from "../core/session.js";
import type { ExtensionMcpRegistry } from "../core/extension-mcp.js";
import type { McpTokenRegistry } from "./mcp/token-registry.js";

export interface ExtensionMcpMintDeps {
  extensionMcp?: ExtensionMcpRegistry;
  mcpTokenRegistry?: McpTokenRegistry;
  getDaemonOrigin?: () => string;
}

export interface ExtensionMcpMintResult {
  descriptors: unknown[];
  bindToSession: (session: Session) => void;
  abandon: (err?: Error) => void;
}

export function mintExtensionMcpDescriptors(
  deps: ExtensionMcpMintDeps,
): ExtensionMcpMintResult | undefined {
  if (
    deps.extensionMcp === undefined ||
    deps.mcpTokenRegistry === undefined ||
    deps.getDaemonOrigin === undefined
  ) {
    return undefined;
  }
  const extNames = deps.extensionMcp.list();
  if (extNames.length === 0) {
    return undefined;
  }
  const token = randomBytes(32).toString("hex");
  const reservation = deps.mcpTokenRegistry.reserve(token);
  const origin = deps.getDaemonOrigin();
  const descriptors = extNames.map((name) => ({
    name,
    type: "http",
    url: `${origin}/mcp/${name}`,
    headers: [{ name: "Authorization", value: `Bearer ${token}` }],
  }));
  const registry = deps.mcpTokenRegistry;
  return {
    descriptors,
    bindToSession: (session) => {
      reservation.complete(session);
      session.onClose(() => {
        void registry.unbind(token);
      });
    },
    abandon: (err) => reservation.abandon(err),
  };
}
