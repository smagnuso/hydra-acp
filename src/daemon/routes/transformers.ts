import type { FastifyInstance } from "fastify";
import type { TransformerManager } from "../../core/transformer-manager.js";
import type { TransformerConfig } from "../../core/config.js";

const NAME_RE = /^[A-Za-z0-9._-]+$/;

export function registerTransformerRoutes(
  app: FastifyInstance,
  transformers: TransformerManager,
): void {
  app.get("/v1/transformers", async () => {
    return { transformers: transformers.list() };
  });

  app.get("/v1/transformers/:name", async (request, reply) => {
    const name = (request.params as { name: string }).name;
    const info = transformers.get(name);
    if (!info) {
      reply.code(404).send({ error: `unknown transformer: ${name}` });
      return;
    }
    return info;
  });

  app.post("/v1/transformers", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const parsed = parseRegisterBody(body);
    if ("error" in parsed) {
      reply.code(400).send({ error: parsed.error });
      return;
    }
    try {
      const info = transformers.register(parsed.config);
      reply.code(201).send(info);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.delete("/v1/transformers/:name", async (request, reply) => {
    const name = (request.params as { name: string }).name;
    try {
      await transformers.unregister(name);
      reply.code(204).send();
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post("/v1/transformers/:name/start", async (request, reply) => {
    const name = (request.params as { name: string }).name;
    try {
      const info = await transformers.startByName(name);
      reply.code(200).send(info);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post("/v1/transformers/:name/stop", async (request, reply) => {
    const name = (request.params as { name: string }).name;
    try {
      const info = await transformers.stopByName(name);
      reply.code(200).send(info);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post("/v1/transformers/:name/restart", async (request, reply) => {
    const name = (request.params as { name: string }).name;
    try {
      const info = await transformers.restartByName(name);
      reply.code(200).send(info);
    } catch (err) {
      sendError(reply, err);
    }
  });
}

function sendError(
  reply: { code: (n: number) => { send: (b: unknown) => void } },
  err: unknown,
): void {
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

function parseRegisterBody(
  body: Record<string, unknown>,
): { config: TransformerConfig } | { error: string } {
  const name = body.name;
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    return { error: "name must match [A-Za-z0-9._-]+" };
  }
  const command = body.command;
  if (
    command !== undefined &&
    (!Array.isArray(command) || command.some((c) => typeof c !== "string"))
  ) {
    return { error: "command must be string[]" };
  }
  const args = body.args;
  if (
    args !== undefined &&
    (!Array.isArray(args) || args.some((a) => typeof a !== "string"))
  ) {
    return { error: "args must be string[]" };
  }
  const env = body.env;
  if (
    env !== undefined &&
    (typeof env !== "object" || env === null || Array.isArray(env))
  ) {
    return { error: "env must be an object of string→string" };
  }
  if (
    env &&
    Object.values(env as Record<string, unknown>).some(
      (v) => typeof v !== "string",
    )
  ) {
    return { error: "env values must be strings" };
  }
  const enabled = body.enabled;
  if (enabled !== undefined && typeof enabled !== "boolean") {
    return { error: "enabled must be a boolean" };
  }
  return {
    config: {
      name,
      command: (command as string[] | undefined) ?? [],
      args: (args as string[] | undefined) ?? [],
      env: (env as Record<string, string> | undefined) ?? {},
      enabled: enabled === undefined ? true : enabled,
    },
  };
}
