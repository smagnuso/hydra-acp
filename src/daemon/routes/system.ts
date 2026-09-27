import type { FastifyInstance } from "fastify";
import { buildSystemInfo } from "../../core/system-info.js";

export function registerSystemRoutes(app: FastifyInstance, startedAt: string): void {
  app.get("/v1/system", async () => buildSystemInfo(startedAt));
}
