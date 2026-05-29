import type { FastifyInstance } from "fastify";

export interface DaemonConfigView {
  defaultAgent: string;
  defaultCwd: string;
  defaultModels: Record<string, string>;
  synopsisAgent?: string;
  synopsisModel?: string;
  synopsisOnClose: boolean;
  defaultTransformers: string[];
}

export function registerConfigRoutes(
  app: FastifyInstance,
  snapshot: DaemonConfigView,
): void {
  app.get("/v1/config", async () => snapshot);
}
