import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { hasPassword, verifyPassword } from "../../core/password.js";
import type { SessionTokenStore } from "../../core/session-tokens.js";
import type { AuthRateLimiter } from "../rate-limit.js";

const LoginBody = z.object({
  password: z.string().min(1),
  label: z.string().min(1).max(256).optional(),
  ttlSec: z.number().int().positive().optional(),
});

const LogoutBody = z
  .object({
    id: z.string().optional(),
  })
  .optional();

export interface AuthRoutesDeps {
  store: SessionTokenStore;
  rateLimiter: AuthRateLimiter;
}

export function registerAuthRoutes(
  app: FastifyInstance,
  deps: AuthRoutesDeps,
): void {
  // /v1/auth/login is the one endpoint that can't bearer-auth itself
  // (we're producing the bearer). Everything else in this file uses the
  // global bearer-auth hook by virtue of NOT setting skipAuth.
  app.post(
    "/v1/auth/login",
    { config: { skipAuth: true } },
    async (request, reply) => {
      const ip = remoteIp(request);
      if (deps.rateLimiter.isBlocked(ip)) {
        return reply.code(429).send({
          error: "Too many failed attempts; try again later.",
        });
      }

      let body: z.infer<typeof LoginBody>;
      try {
        body = LoginBody.parse(request.body);
      } catch {
        return reply.code(400).send({ error: "Invalid request body" });
      }

      if (!(await hasPassword())) {
        return reply.code(403).send({
          error:
            "No password configured. Run `hydra-acp auth password set` on the daemon host.",
        });
      }

      const ok = await verifyPassword(body.password);
      if (!ok) {
        deps.rateLimiter.recordFailure(ip);
        return reply.code(401).send({ error: "Invalid password" });
      }
      deps.rateLimiter.recordSuccess(ip);

      const issued = await deps.store.issue({
        label: body.label,
        ttlSec: body.ttlSec,
      });
      return reply.code(200).send({
        session_token: issued.token,
        id: issued.id,
        expires_at: issued.expiresAt,
      });
    },
  );

  // Revoke the bearer used to make the call. Convenience for browser /
  // TUI logout buttons; equivalent to DELETE /v1/auth/sessions/<id>
  // for the currently-authenticated session token. No-op (200) when the
  // caller is bearering the service token rather than a session token.
  app.post("/v1/auth/logout", async (request, reply) => {
    let body: z.infer<typeof LogoutBody> = undefined;
    try {
      body = LogoutBody.parse(request.body ?? undefined);
    } catch {
      return reply.code(400).send({ error: "Invalid request body" });
    }
    const id = body?.id ?? request.authIdentity;
    if (!id || id === "service") {
      return reply.code(200).send({ revoked: false });
    }
    const revoked = await deps.store.revoke(id);
    return reply.code(200).send({ revoked });
  });

  // Trivial validity check. Used by the browser server to decide
  // whether to serve the SPA or redirect to the login page.
  app.get("/v1/auth/verify", async (_request, reply) => {
    return reply.code(200).send({ ok: true });
  });

  app.get("/v1/auth/sessions", async (_request, reply) => {
    return reply.code(200).send({ sessions: deps.store.list() });
  });

  app.delete<{ Params: { id: string } }>(
    "/v1/auth/sessions/:id",
    async (request, reply) => {
      const id = request.params.id;
      const revoked = await deps.store.revoke(id);
      if (!revoked) {
        return reply.code(404).send({ error: "Not found" });
      }
      return reply.code(204).send();
    },
  );
}

function remoteIp(request: FastifyRequest): string {
  return request.ip || "unknown";
}
