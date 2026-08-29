import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ProcessTokenRegistry } from "../auth.js";

const MintBody = z.object({
  sessionLabel: z.string().min(1).max(256),
});

export interface ProcessTokenRoutesDeps {
  processRegistry: ProcessTokenRegistry;
}

// Mints/revokes "script"-kind tokens for composer-bar script slots (and,
// eventually, sidebar process gadgets). One TUI process mints every one of
// its script tokens under the same caller-supplied sessionLabel, so a
// single revoke call at shutdown cleans them all up — see auth.ts's
// ProcessTokenRegistry docs.
export function registerProcessTokenRoutes(
  app: FastifyInstance,
  deps: ProcessTokenRoutesDeps,
): void {
  app.post("/v1/process-tokens", async (request, reply) => {
    if (request.authIdentity !== "service") {
      return reply.code(403).send({ error: "Requires the service token" });
    }
    let body: z.infer<typeof MintBody>;
    try {
      body = MintBody.parse(request.body);
    } catch {
      return reply.code(400).send({ error: "Invalid request body" });
    }
    const token = deps.processRegistry.mint(body.sessionLabel, "script");
    return reply.code(201).send({ token });
  });

  app.delete<{ Params: { sessionLabel: string } }>(
    "/v1/process-tokens/:sessionLabel",
    async (request, reply) => {
      if (request.authIdentity !== "service") {
        return reply.code(403).send({ error: "Requires the service token" });
      }
      deps.processRegistry.revoke(request.params.sessionLabel);
      return reply.code(204).send();
    },
  );
}
