import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import Fastify, { type FastifyInstance } from "fastify";
import websocketPlugin from "@fastify/websocket";
import pino, { type Level } from "pino";
import createPinoRoll from "pino-roll";
import { type HydraConfig, extensionList } from "../core/config.js";
import { Registry } from "../core/registry.js";
import { SessionManager } from "../core/session-manager.js";
import { ExtensionManager } from "../core/extensions.js";
import { paths } from "../core/paths.js";
import { bearerAuth } from "./auth.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerExtensionRoutes } from "./routes/extensions.js";
import { registerConfigRoutes } from "./routes/config.js";
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
  extensions: ExtensionManager;
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

  await fsp.mkdir(paths.home(), { recursive: true });
  const { stream: logStream, fileStream } = await buildLogStream(
    config.daemon.logLevel,
  );

  const app = Fastify({
    logger: {
      level: config.daemon.logLevel,
      stream: logStream,
    },
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
  const manager = new SessionManager(registry, undefined, undefined, {
    idleTimeoutMs: config.daemon.sessionIdleTimeoutSeconds * 1_000,
  });

  const extensions = new ExtensionManager(extensionList(config));

  registerHealthRoutes(app, HYDRA_VERSION);
  registerSessionRoutes(app, manager, {
    agentId: config.defaultAgent,
    cwd: config.defaultCwd,
  });
  registerAgentRoutes(app, registry);
  registerExtensionRoutes(app, extensions);
  registerConfigRoutes(app, {
    defaultAgent: config.defaultAgent,
    defaultCwd: config.defaultCwd,
  });
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

  const scheme = config.daemon.tls ? "https" : "http";
  const wsScheme = config.daemon.tls ? "wss" : "ws";
  extensions.setContext({
    daemonUrl: `${scheme}://${config.daemon.host}:${boundPort}`,
    daemonHost: config.daemon.host,
    daemonPort: boundPort,
    daemonToken: config.daemon.authToken,
    daemonWsUrl: `${wsScheme}://${config.daemon.host}:${boundPort}/acp`,
    hydraHome: paths.home(),
  });
  await extensions.start();

  const shutdown = async (): Promise<void> => {
    await extensions.stop();
    await manager.closeAll();
    // Drain pending meta.json writes after closing sessions so any
    // final regenTitle/persistTitle from idle-close has a chance to
    // hit disk before the daemon exits.
    await manager.flushMetaWrites();
    await app.close();
    try {
      fs.unlinkSync(paths.pidFile());
    } catch {
      void 0;
    }
    try {
      fileStream.flushSync();
    } catch {
      void 0;
    }
  };

  return { app, manager, registry, extensions, shutdown };
}

async function buildLogStream(level: string) {
  const fileStream = await createPinoRoll({
    file: paths.logFile(),
    size: "10m",
    frequency: "daily",
    mkdir: true,
    symlink: true,
  });
  const stderrStream = pino.destination(2);
  const stream = pino.multistream([
    { stream: fileStream, level: level as Level },
    { stream: stderrStream, level: level as Level },
  ]);
  return { stream, fileStream };
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
