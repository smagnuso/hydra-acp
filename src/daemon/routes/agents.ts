import type { FastifyInstance } from "fastify";
import type { Registry } from "../../core/registry.js";
import type { SessionManager } from "../../core/session-manager.js";
import { JsonRpcErrorCodes } from "../../acp/types.js";

export function registerAgentRoutes(
  app: FastifyInstance,
  registry: Registry,
  manager: SessionManager,
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

  // Spawn a transient agent process, ask it via ACP session/list which
  // sessions it remembers (across every cwd it knows about), and persist
  // a cold hydra record for each one we don't already track. Returns
  // the newly-minted records plus a skipped count for the dedupe hits.
  app.post("/v1/agents/:id/sync", async (request, reply) => {
    const agentId = (request.params as { id: string }).id;
    try {
      const { synced, skipped } = await manager.syncFromAgent(agentId);
      return {
        synced: synced.map((r) => ({
          sessionId: r.sessionId,
          upstreamSessionId: r.upstreamSessionId,
          agentId: r.agentId,
          cwd: r.cwd,
          title: r.title,
          updatedAt: r.updatedAt,
        })),
        skipped,
      };
    } catch (err) {
      const e = err as Error & { code?: number };
      if (e.code === JsonRpcErrorCodes.AgentNotInstalled) {
        reply.code(404).send({ error: e.message });
        return;
      }
      reply.code(409).send({ error: e.message });
    }
  });
}
