// Authorization header parsing shared by the MCP routes.
//
// Both /mcp/hydra-acp-stdin and /mcp/<extension-name> mint per-session bearer tokens
// and embed them as `Authorization: Bearer <token>` in the agent's
// mcpServers config. The route handlers extract the token here and look
// it up in the McpTokenRegistry.

import type { FastifyRequest } from "fastify";

const BEARER_PREFIX = "Bearer ";

export function extractBearer(req: FastifyRequest): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== "string") {
    return undefined;
  }
  if (!header.startsWith(BEARER_PREFIX)) {
    return undefined;
  }
  const token = header.slice(BEARER_PREFIX.length).trim();
  return token.length > 0 ? token : undefined;
}
