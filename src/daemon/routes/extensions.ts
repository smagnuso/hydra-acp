import type { FastifyInstance } from "fastify";
import type { ExtensionManager } from "../../core/extensions.js";
import { registerProcessRoutes } from "./_process-routes.js";

export function registerExtensionRoutes(
  app: FastifyInstance,
  extensions: ExtensionManager,
): void {
  registerProcessRoutes(app, "extension", extensions);
}
