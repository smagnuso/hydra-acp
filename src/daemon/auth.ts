import type { FastifyRequest, FastifyReply } from "fastify";
import type { HydraConfig } from "../core/config.js";

const BEARER_PREFIX = "Bearer ";

export interface AuthOptions {
  config: HydraConfig;
}

export function bearerAuth(opts: AuthOptions) {
  return async function authMiddleware(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const header = request.headers.authorization;
    if (!header || !header.startsWith(BEARER_PREFIX)) {
      reply.code(401).send({ error: "Missing bearer token" });
      return;
    }
    const token = header.slice(BEARER_PREFIX.length).trim();
    if (!constantTimeEqual(token, opts.config.daemon.authToken)) {
      reply.code(403).send({ error: "Invalid token" });
      return;
    }
  };
}

export function tokenFromUpgradeRequest(
  req: { headers: NodeJS.Dict<string | string[]>; url?: string },
): string | undefined {
  const proto = req.headers["sec-websocket-protocol"];
  const protoString = Array.isArray(proto) ? proto.join(",") : proto;
  if (protoString) {
    for (const part of protoString.split(",")) {
      const trimmed = part.trim();
      const prefix = "hydra-acp-token.";
      if (trimmed.startsWith(prefix)) {
        return trimmed.slice(prefix.length);
      }
    }
  }
  if (req.url) {
    try {
      const u = new URL(req.url, "http://localhost");
      const queryToken = u.searchParams.get("token");
      if (queryToken) {
        return queryToken;
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
