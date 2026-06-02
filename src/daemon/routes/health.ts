import type { FastifyInstance } from "fastify";

export function registerHealthRoutes(
  app: FastifyInstance,
  version: string,
  configDigest: string,
): void {
  app.get("/v1/health", { config: { skipAuth: true } }, async () => {
    return { status: "ok", version, configDigest };
  });
}
