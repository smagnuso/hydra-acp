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

// Build a callback suitable for SessionInit.mintMcpServersForSwap. The
// callback re-mints the per-session mcpServers config that was originally
// provided at session/new time, generating fresh tokens so the cached
// MCP server builds (keyed by token) miss and are rebuilt against the
// current Session state — primarily, recall_* tools gate on
// summarizedThroughEntry which only goes up after compaction.
//
// Closes over the baseline user-supplied mcpServers (passed through
// unchanged), whether stdin streaming was active at create time, and
// the daemon deps needed to re-mint. The returned closure binds each
// fresh token to the session's onClose disposer so it cleans up when
// the session goes cold.
export interface BuildMintForSwapOpts {
  baselineMcpServers: unknown[] | undefined;
  stdinEnabled: boolean;
  deps: ExtensionMcpMintDeps;
}

// Re-mint a single per-session, per-descriptor bearer + URL descriptor
// for the built-in MCP servers Hydra hosts in-process (stdin, recall).
// Shared between session/new (where we mint the initial descriptor) and
// the swap callback (where we re-mint to force a fresh MCP-server
// build, e.g. so the recall server re-evaluates its
// summarizedThroughEntry gate). The token is reserved + bound to the
// session and torn down on close.
function mintInternalMcpDescriptor(opts: {
  name: "hydra-acp-stdin" | "hydra-acp-recall";
  session: Session;
  tokenRegistry: McpTokenRegistry;
  getOrigin: () => string;
}): { name: string; type: string; url: string; headers: Array<{ name: string; value: string }> } {
  const token = randomBytes(32).toString("hex");
  const reservation = opts.tokenRegistry.reserve(token);
  reservation.complete(opts.session);
  opts.session.onClose(() => {
    void opts.tokenRegistry.unbind(token);
  });
  return {
    name: opts.name,
    type: "http",
    url: `${opts.getOrigin()}/mcp/${opts.name}`,
    headers: [{ name: "Authorization", value: `Bearer ${token}` }],
  };
}

export function buildMintMcpServersForSwap(
  opts: BuildMintForSwapOpts,
): ((session: Session) => Promise<unknown[]>) | undefined {
  if (
    opts.deps.mcpTokenRegistry === undefined ||
    opts.deps.getDaemonOrigin === undefined
  ) {
    // No registry / origin → can't mint anything; let swap fall back
    // to the captured baseline mcpServersConfig.
    return undefined;
  }
  const tokenRegistry = opts.deps.mcpTokenRegistry;
  const getOrigin = opts.deps.getDaemonOrigin;
  return async (session: Session): Promise<unknown[]> => {
    let descriptors: unknown[] = [...(opts.baselineMcpServers ?? [])];
    if (opts.stdinEnabled) {
      descriptors.push(
        mintInternalMcpDescriptor({
          name: "hydra-acp-stdin",
          session,
          tokenRegistry,
          getOrigin,
        }),
      );
    }
    // Always re-mint the recall descriptor on swap. The recall server's
    // tool list is gated on summarizedThroughEntry > 0 — a fresh token
    // forces the route's per-token build cache to miss and the gate to
    // re-evaluate, which is the whole point of mint-for-swap after a
    // compaction has advanced the watermark.
    descriptors.push(
      mintInternalMcpDescriptor({
        name: "hydra-acp-recall",
        session,
        tokenRegistry,
        getOrigin,
      }),
    );
    const extMcp = mintExtensionMcpDescriptors(opts.deps);
    if (extMcp !== undefined) {
      extMcp.bindToSession(session);
      descriptors = [...descriptors, ...extMcp.descriptors];
    }
    return descriptors;
  };
}

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
