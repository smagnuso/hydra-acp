import type { FastifyRequest, FastifyReply } from "fastify";
import type { SessionTokenStore } from "../core/session-tokens.js";

const BEARER_PREFIX = "Bearer ";

// A TokenValidator decides whether a presented bearer token grants
// access. The daemon uses a composite validator that accepts either the
// machine-spawned service token (long-lived, used by extensions) or a
// human-issued session token (revocable, from /v1/auth/login).
export interface TokenValidator {
  // Returns the identifier of the matched token kind/record when valid,
  // or undefined when the token is rejected. For the service token, the
  // identifier is the constant string "service". For session tokens, it
  // is the per-record id so callers (e.g. logout) can revoke it.
  validate(token: string): Promise<string | undefined>;
}

export class StaticTokenValidator implements TokenValidator {
  constructor(private readonly token: string) {}
  async validate(token: string): Promise<string | undefined> {
    return constantTimeEqual(token, this.token) ? "service" : undefined;
  }
}

export class SessionTokenValidator implements TokenValidator {
  constructor(private readonly store: SessionTokenStore) {}
  async validate(token: string): Promise<string | undefined> {
    return this.store.verify(token);
  }
}

export class CompositeTokenValidator implements TokenValidator {
  constructor(private readonly validators: TokenValidator[]) {}
  async validate(token: string): Promise<string | undefined> {
    for (const v of this.validators) {
      const id = await v.validate(token);
      if (id !== undefined) {
        return id;
      }
    }
    return undefined;
  }
}

declare module "fastify" {
  interface FastifyRequest {
    // Identifier of the matched token: "service" for the service-token
    // bearer, the session-token record id for human-issued tokens.
    authIdentity?: string;
  }
}

export interface AuthOptions {
  validator: TokenValidator;
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
    const identity = await opts.validator.validate(token);
    if (!identity) {
      reply.code(403).send({ error: "Invalid token" });
      return;
    }
    request.authIdentity = identity;
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
