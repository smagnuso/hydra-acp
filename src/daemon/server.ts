import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import Fastify, { type FastifyInstance } from "fastify";
import websocketPlugin from "@fastify/websocket";
import type { HydraConfig } from "../core/config.js";
import { Registry } from "../core/registry.js";
import { SessionManager } from "../core/session-manager.js";
import { paths } from "../core/paths.js";
import { bearerAuth } from "./auth.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerAcpWsEndpoint } from "./acp-ws.js";

const HYDRA_VERSION = "0.1.0";

declare module "fastify" {
  interface FastifyContextConfig {
    skipAuth?: boolean;
  }
}

export interface DaemonHandle {
  app: FastifyInstance;
  manager: SessionManager;
  registry: Registry;
  shutdown: () => Promise<void>;
}

export async function startDaemon(config: HydraConfig): Promise<DaemonHandle> {
  ensureLoopbackOrTls(config);

  const httpsOptions = config.daemon.tls
    ? {
        key: await fsp.readFile(config.daemon.tls.key),
        cert: await fsp.readFile(config.daemon.tls.cert),
      }
    : undefined;

  const app = Fastify({
    logger: { level: config.daemon.logLevel },
    https: httpsOptions ?? null,
  });

  await app.register(websocketPlugin);

  const auth = bearerAuth({ config });
  app.addHook("onRequest", async (request, reply) => {
    if (request.routeOptions.config?.skipAuth) {
      return;
    }
    if (request.url === "/acp" || request.url?.startsWith("/acp?")) {
      return;
    }
    await auth(request, reply);
  });

  const registry = new Registry(config);
  const manager = new SessionManager(registry);

  registerHealthRoutes(app, HYDRA_VERSION);
  registerSessionRoutes(app, manager);
  registerAgentRoutes(app, registry);
  registerAcpWsEndpoint(app, {
    config,
    manager,
    defaultAgent: config.defaultAgent,
  });

  await app.listen({ host: config.daemon.host, port: config.daemon.port });

  const address = app.server.address();
  const boundPort =
    address && typeof address === "object" ? address.port : config.daemon.port;

  await fsp.mkdir(paths.home(), { recursive: true });
  await fsp.writeFile(
    paths.pidFile(),
    JSON.stringify({
      pid: process.pid,
      host: config.daemon.host,
      port: boundPort,
      startedAt: new Date().toISOString(),
    }) + "\n",
    { encoding: "utf8", mode: 0o600 },
  );

  const shutdown = async (): Promise<void> => {
    await manager.closeAll();
    await app.close();
    try {
      fs.unlinkSync(paths.pidFile());
    } catch {
      void 0;
    }
  };

  return { app, manager, registry, shutdown };
}

function ensureLoopbackOrTls(config: HydraConfig): void {
  const host = config.daemon.host;
  const isLoopback =
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "localhost" ||
    host === "[::1]";
  if (!isLoopback && !config.daemon.tls) {
    throw new Error(
      `Refusing to bind to non-loopback host ${host} without TLS configured.`,
    );
  }
}
