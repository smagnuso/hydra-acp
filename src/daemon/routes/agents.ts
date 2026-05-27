import type { FastifyInstance } from "fastify";
import {
  agentInstallState,
  planSpawn,
  type Registry,
} from "../../core/registry.js";
import type { SessionManager } from "../../core/session-manager.js";
import { JsonRpcErrorCodes } from "../../acp/types.js";

export function registerAgentRoutes(
  app: FastifyInstance,
  registry: Registry,
  manager: SessionManager,
  opts: { npmRegistry?: string } = {},
): void {
  app.get("/v1/agents", async () => {
    const doc = await registry.load();
    const agents = await Promise.all(
      doc.agents.map(async (a) => ({
        id: a.id,
        name: a.name,
        version: a.version,
        description: a.description,
        distributions: Object.keys(a.distribution),
        installed: await agentInstallState(a),
      })),
    );
    return {
      version: doc.version,
      fetchedAt: registry.lastFetchedAt(),
      agents,
    };
  });

  app.get("/v1/registry", async () => {
    return registry.load();
  });

  app.post("/v1/registry/refresh", async () => {
    const doc = await registry.refresh();
    return { version: doc.version, agentCount: doc.agents.length };
  });

  // Pre-install an agent so the first session/new doesn't pay the
  // download cost. Resolves the id against the registry (with the
  // same npx-package-basename fallback session/new uses), then runs
  // planSpawn — its install side-effects (ensureNpmPackage /
  // ensureBinary) are exactly what we want. uvx agents don't have a
  // hydra-side install step; we return early with distribution: "uvx"
  // so the CLI can tell the user it'll resolve lazily on first run.
  app.post("/v1/agents/:id/install", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const agent = await registry.getAgent(id);
    if (!agent) {
      reply.code(404).send({ error: `agent ${id} not found in registry` });
      return;
    }
    if (agent.distribution.uvx && !agent.distribution.npx && !agent.distribution.binary) {
      reply.send({
        agentId: agent.id,
        version: agent.version ?? "current",
        distribution: "uvx",
        installed: false,
        message: "uvx agents resolve on first run; nothing to pre-install.",
      });
      return;
    }
    try {
      const plan = await planSpawn(agent, [], { npmRegistry: opts.npmRegistry });
      const distribution = agent.distribution.npx
        ? "npx"
        : agent.distribution.binary
          ? "binary"
          : "unknown";
      reply.send({
        agentId: agent.id,
        version: plan.version,
        distribution,
        installed: true,
        command: plan.command,
      });
    } catch (err) {
      reply.code(500).send({ error: (err as Error).message });
    }
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
