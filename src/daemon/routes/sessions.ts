import type { FastifyInstance } from "fastify";
import { expandHome } from "../../core/config.js";
import type { SessionManager } from "../../core/session-manager.js";

export interface SessionRouteDefaults {
  agentId: string;
  cwd: string;
}

export function registerSessionRoutes(
  app: FastifyInstance,
  manager: SessionManager,
  defaults: SessionRouteDefaults,
): void {
  app.get("/v1/sessions", async (request) => {
    const query = request.query as { cwd?: string; all?: string } | undefined;
    const all = query?.all === "true" || query?.all === "1";
    const sessions = await manager.list({ cwd: query?.cwd, all });
    return { sessions };
  });

  app.post("/v1/sessions", async (request, reply) => {
    const body = (request.body ?? {}) as {
      cwd?: string;
      agentId?: string;
      mcpServers?: unknown[];
    };
    const cwd = expandHome(body.cwd ?? defaults.cwd);
    const agentId = body.agentId ?? defaults.agentId;
    try {
      const session = await manager.create({
        cwd,
        agentId,
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
    const raw = (request.params as { id: string }).id;
    const id = (await manager.resolveCanonicalId(raw)) ?? raw;
    const session = manager.get(id);
    if (session) {
      await session.close({ deleteRecord: true });
      reply.code(204).send();
      return;
    }
    const removed = await manager.deleteRecord(id);
    if (!removed) {
      reply.code(404).send({ error: "session not found" });
      return;
    }
    reply.code(204).send();
  });

  // Tail a session's recorded conversation as NDJSON (one entry per
  // line). One-shot by default; ?follow=1 keeps the connection open
  // and streams new entries as they're broadcast — useful for
  // external archivers (slack uploader, web export) that want the
  // canonical conversation stream without participating as an ACP
  // client. Snapshot state (model/mode/title/commands) lives on the
  // session record, not here; fetch it from GET /v1/sessions if
  // needed alongside.
  app.get("/v1/sessions/:id/history", async (request, reply) => {
    const raw = (request.params as { id: string }).id;
    const query = request.query as { follow?: string } | undefined;
    const follow = query?.follow === "1" || query?.follow === "true";
    const id = (await manager.resolveCanonicalId(raw)) ?? raw;

    const live = manager.get(id);
    // Snapshot atomically with subscription if we'll be following a
    // live session — Node is single-threaded so the two synchronous
    // statements have no broadcast interleave between them.
    let snapshot: ReadonlyArray<unknown> | undefined;
    let unsubscribe: (() => void) | undefined;
    if (live) {
      snapshot = live.getHistorySnapshot();
      if (follow) {
        unsubscribe = live.onBroadcast((entry) => {
          if (reply.raw.writableEnded) {
            return;
          }
          reply.raw.write(JSON.stringify(entry) + "\n");
        });
      }
    } else {
      const cold = await manager.getHistory(id);
      if (cold === undefined) {
        reply.code(404).send({ error: "session not found" });
        return reply;
      }
      snapshot = cold;
    }

    reply.raw.setHeader("Content-Type", "application/x-ndjson");
    reply.raw.setHeader("Cache-Control", "no-cache");
    reply.raw.statusCode = 200;
    for (const entry of snapshot ?? []) {
      reply.raw.write(JSON.stringify(entry) + "\n");
    }

    if (!unsubscribe) {
      reply.raw.end();
      return reply;
    }

    // Follow mode against a live session — keep the connection open
    // until the client disconnects, then unsubscribe so the handler
    // doesn't keep firing for nobody.
    request.raw.on("close", () => {
      unsubscribe?.();
      if (!reply.raw.writableEnded) {
        reply.raw.end();
      }
    });
    return reply;
  });
}
