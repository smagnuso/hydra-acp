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
    const query = request.query as { cwd?: string } | undefined;
    const sessions = await manager.list({ cwd: query?.cwd });
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

  // Demote a live session to cold: close the in-memory session but keep
  // the on-disk record so it can be resurrected later. Idempotent — a
  // session that's already cold returns 204 without touching disk. Use
  // DELETE /v1/sessions/:id when you want the record gone too.
  app.post("/v1/sessions/:id/kill", async (request, reply) => {
    const raw = (request.params as { id: string }).id;
    const id = (await manager.resolveCanonicalId(raw)) ?? raw;
    const session = manager.get(id);
    if (session) {
      await session.close({ deleteRecord: false });
      reply.code(204).send();
      return;
    }
    const exists = await manager.hasRecord(id);
    if (!exists) {
      reply.code(404).send({ error: "session not found" });
      return;
    }
    reply.code(204).send();
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
    // For follow mode against a live session, subscribe BEFORE reading
    // the snapshot so we don't lose entries that land during the
    // disk-read window. Buffer those into `pending` and flush after
    // the snapshot to preserve order; switch to direct emission once
    // we've drained.
    let snapshot: ReadonlyArray<unknown> | undefined;
    let unsubscribe: (() => void) | undefined;
    let snapshotDone = false;
    const pending: unknown[] = [];
    if (live) {
      if (follow) {
        unsubscribe = live.onBroadcast((entry) => {
          if (reply.raw.writableEnded) {
            return;
          }
          if (snapshotDone) {
            reply.raw.write(JSON.stringify(entry) + "\n");
          } else {
            pending.push(entry);
          }
        });
      }
      snapshot = await live.getHistorySnapshot();
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
    const snapshotKeys = new Set<string>();
    for (const entry of snapshot ?? []) {
      reply.raw.write(JSON.stringify(entry) + "\n");
      const e = entry as { recordedAt?: number };
      if (typeof e.recordedAt === "number") {
        snapshotKeys.add(String(e.recordedAt));
      }
    }
    // Drain any entries that landed during the snapshot read window,
    // skipping ones already in the snapshot.
    for (const entry of pending) {
      const e = entry as { recordedAt?: number };
      const key = typeof e.recordedAt === "number" ? String(e.recordedAt) : "";
      if (key && snapshotKeys.has(key)) {
        continue;
      }
      reply.raw.write(JSON.stringify(entry) + "\n");
    }
    snapshotDone = true;

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
