import type { FastifyInstance } from "fastify";
import type { TransformerManager } from "../../core/transformer-manager.js";
import { registerProcessRoutes } from "./_process-routes.js";

export function registerTransformerRoutes(
  app: FastifyInstance,
  transformers: TransformerManager,
): void {
  registerProcessRoutes(app, "transformer", transformers);
}
