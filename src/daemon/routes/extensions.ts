import type { FastifyInstance } from "fastify";
import type { ExtensionManager } from "../../core/extensions.js";

export function registerExtensionRoutes(
  app: FastifyInstance,
  extensions: ExtensionManager,
): void {
  app.get("/v1/extensions", async () => {
    return { extensions: extensions.list() };
  });

  app.get("/v1/extensions/:name", async (request, reply) => {
    const name = (request.params as { name: string }).name;
    const info = extensions.get(name);
    if (!info) {
      reply.code(404).send({ error: `unknown extension: ${name}` });
      return;
    }
    return info;
  });

  app.post("/v1/extensions/:name/start", async (request, reply) => {
    const name = (request.params as { name: string }).name;
    try {
      const info = await extensions.startByName(name);
      reply.code(200).send(info);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post("/v1/extensions/:name/stop", async (request, reply) => {
    const name = (request.params as { name: string }).name;
    try {
      const info = await extensions.stopByName(name);
      reply.code(200).send(info);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post("/v1/extensions/:name/restart", async (request, reply) => {
    const name = (request.params as { name: string }).name;
    try {
      const info = await extensions.restartByName(name);
      reply.code(200).send(info);
    } catch (err) {
      sendError(reply, err);
    }
  });
}

function sendError(reply: { code: (n: number) => { send: (b: unknown) => void } }, err: unknown): void {
  const code = (err as { code?: string }).code;
  const message = (err as Error).message ?? "unknown error";
  if (code === "NOT_FOUND") {
    reply.code(404).send({ error: message });
    return;
  }
  if (code === "CONFLICT") {
    reply.code(409).send({ error: message });
    return;
  }
  reply.code(500).send({ error: message });
}
