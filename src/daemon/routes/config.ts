import type { FastifyInstance } from "fastify";

export function registerConfigRoutes(
  app: FastifyInstance,
  defaults: { defaultAgent: string; defaultCwd: string },
): void {
  app.get("/v1/config", async () => {
    return {
      defaultAgent: defaults.defaultAgent,
      defaultCwd: defaults.defaultCwd,
    };
  });
}
