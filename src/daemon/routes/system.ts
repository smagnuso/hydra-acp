import type { FastifyInstance } from "fastify";
import { buildSystemInfo } from "../../core/system-info.js";

export function registerSystemRoutes(
  app: FastifyInstance,
  startedAt: string,
  // Starts the process's graceful shutdown. Absent for a daemon embedded in
  // another process (tests, library use), which must not exit its host.
  requestShutdown?: () => void,
): void {
  app.get("/v1/system", async () => buildSystemInfo(startedAt));

  // Windows has no way to ask a process to shut down: SIGTERM there is an
  // immediate TerminateProcess, so the daemon's own shutdown (closing
  // sessions, flushing history, removing the pidfile, stopping agents) never
  // ran. This is the portable request for it. Only the service token may
  // stop the daemon; a session or script token must not.
  app.post("/v1/daemon/shutdown", async (request, reply) => {
    if (request.authIdentity !== "service") {
      return reply.code(403).send({ error: "only the service token may stop the daemon" });
    }
    if (requestShutdown === undefined) {
      return reply.code(501).send({ error: "this daemon cannot shut itself down" });
    }
    reply.code(202).send({ status: "shutting-down" });
    // After the reply has gone out: shutdown closes the HTTP server.
    setTimeout(requestShutdown, 50);
    return reply;
  });
}
