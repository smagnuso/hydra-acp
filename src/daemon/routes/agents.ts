import type { FastifyInstance } from "fastify";
import type { Registry } from "../../core/registry.js";

export function registerAgentRoutes(
  app: FastifyInstance,
  registry: Registry,
): void {
  app.get("/v1/agents", async () => {
    const doc = await registry.load();
    return {
      version: doc.version,
      agents: doc.agents.map((a) => ({
        id: a.id,
        name: a.name,
        version: a.version,
        description: a.description,
        distributions: Object.keys(a.distribution),
      })),
    };
  });

  app.get("/v1/registry", async () => {
    return registry.load();
  });

  app.post("/v1/registry/refresh", async () => {
    const doc = await registry.refresh();
    return { version: doc.version, agentCount: doc.agents.length };
  });
}
