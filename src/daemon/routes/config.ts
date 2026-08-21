import type { FastifyInstance } from "fastify";

export interface DaemonConfigView {
  defaultAgent: string;
  defaultCwd: string;
  defaultModels: Record<string, string>;
  synopsisAgent?: string;
  synopsisModel?: string;
  defaultTransformers: string[];
}

// `view` is a getter, not a snapshot: tier-"live" keys (defaultAgent,
// defaultCwd, defaultModels) are re-read by the config reloader while the
// daemon runs, and this route is what `hydra agent set` with no arguments
// reports back. A captured object would confidently print the value the
// daemon booted with long after it stopped being true.
export function registerConfigRoutes(
  app: FastifyInstance,
  view: () => DaemonConfigView,
): void {
  app.get("/v1/config", async () => view());
}
