import type { FastifyInstance } from "fastify";
import type { SessionManager } from "../../core/session-manager.js";

export function registerSessionRoutes(
  app: FastifyInstance,
  manager: SessionManager,
): void {
  app.get("/v1/sessions", async (request) => {
    const cwd = (request.query as { cwd?: string } | undefined)?.cwd;
    return { sessions: manager.list({ cwd }) };
  });

  app.post("/v1/sessions", async (request, reply) => {
    const body = request.body as {
      cwd?: string;
      agentId?: string;
      mcpServers?: unknown[];
    };
    if (!body?.cwd) {
      reply.code(400).send({ error: "cwd is required" });
      return;
    }
    if (!body.agentId) {
      reply.code(400).send({ error: "agentId is required" });
      return;
    }
    try {
      const session = await manager.create({
        cwd: body.cwd,
        agentId: body.agentId,
        mcpServers: body.mcpServers,
      });
      reply.code(201).send({
        sessionId: session.sessionId,
        agentId: session.agentId,
        cwd: session.cwd,
      });
    } catch (err) {
      reply.code(500).send({ error: (err as Error).message });
    }
  });

  app.delete("/v1/sessions/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const session = manager.get(id);
    if (!session) {
      reply.code(404).send({ error: "session not found" });
      return;
    }
    await session.close();
    reply.code(204).send();
  });
}
