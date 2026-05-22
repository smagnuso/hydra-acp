import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import Fastify, { type FastifyInstance } from "fastify";
import websocketPlugin from "@fastify/websocket";
import { selectAcpSubprotocol } from "./ws-protocol.js";
import pino, { type Level } from "pino";
import createPinoRoll from "pino-roll";
import { type HydraConfig, extensionList } from "../core/config.js";
import { Registry } from "../core/registry.js";
import { AgentInstance } from "../core/agent-instance.js";
import { SessionManager, type AgentSpawner } from "../core/session-manager.js";
import { ExtensionManager } from "../core/extensions.js";
import { paths } from "../core/paths.js";
import { setBinaryInstallLogger } from "../core/binary-install.js";
import { setNpmInstallLogger } from "../core/npm-install.js";
import {
  pruneStaleAgentVersions,
  setAgentPruneLogger,
} from "../core/agent-prune.js";
import { HYDRA_VERSION } from "../core/hydra-version.js";
import { SessionTokenStore } from "../core/session-tokens.js";
import {
  bearerAuth,
  CompositeTokenValidator,
  SessionTokenValidator,
  StaticTokenValidator,
} from "./auth.js";
import { AuthRateLimiter } from "./rate-limit.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerExtensionRoutes } from "./routes/extensions.js";
import { registerConfigRoutes } from "./routes/config.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerAcpWsEndpoint } from "./acp-ws.js";

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

export async function startDaemon(
  config: HydraConfig,
  serviceToken: string,
): Promise<DaemonHandle> {
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
    // Session bundles can be large (full history + tool output);
    // the 1MB Fastify default rejects ordinary imports.
    bodyLimit: 256 * 1024 * 1024,
  });

  // `handleProtocols` makes WS subprotocol negotiation deliberate.
  // Without it the underlying `ws` library echoes the first advertised
  // protocol unconditionally — fine while the first slot always holds
  // `acp.v1`, but it would silently echo arbitrary client-controlled
  // strings if that ever changed. See src/daemon/ws-protocol.ts.
  await app.register(websocketPlugin, {
    options: { handleProtocols: selectAcpSubprotocol },
  });

  // Route binary-install progress through the daemon's pino logger so
  // `hydra logs` (and daemon.log) surface tarball downloads — otherwise
  // they'd write to a stderr that spawnDaemonDetached redirects to
  // /dev/null and the user sees an opaque "Starting new session…" hang.
  setBinaryInstallLogger((msg) => {
    app.log.info(msg);
  });
  setNpmInstallLogger((msg) => {
    app.log.info(msg);
  });

  const sessionTokenStore = await SessionTokenStore.load();
  const authRateLimiter = new AuthRateLimiter();
  const validator = new CompositeTokenValidator([
    new StaticTokenValidator(serviceToken),
    new SessionTokenValidator(sessionTokenStore),
  ]);

  const auth = bearerAuth({ validator });
  app.addHook("onRequest", async (request, reply) => {
    if (request.routeOptions.config?.skipAuth) {
      return;
    }
    if (request.url === "/acp" || request.url?.startsWith("/acp?")) {
      return;
    }
    await auth(request, reply);
  });

  // Periodically remove expired session tokens. Cheap O(n) walk; the
  // store also sweeps on load and on verify-of-expired, so this is a
  // safety net for long-running daemons that don't see verify traffic
  // for a given token.
  const sweepInterval = setInterval(
    () => {
      sessionTokenStore.sweepExpired();
    },
    5 * 60 * 1000,
  );
  sweepInterval.unref();

  // `registry` and `manager` reference each other through the prune hook:
  // the registry's onFetched closure reads `manager` to discover live
  // sessions, while `manager` is constructed from `registry`. Both names
  // are captured by reference (the closure only fires after construction
  // returns), so this is safe at runtime.
  const registry: Registry = new Registry(config, {
    onFetched: () => {
      void pruneStaleAgentVersions(registry, manager);
    },
  });
  setAgentPruneLogger((msg) => app.log.info(msg));
  // Inject the configured stderr-tail size into every spawned agent so a
  // crash diagnostic includes the user-tuned trailing bytes. The logger
  // routes agent stderr + unexpected exits to daemon.log — without it,
  // both go to fd 2 which is /dev/null in detached mode.
  const agentLogger = {
    info: (msg: string) => app.log.info(msg),
    warn: (msg: string) => app.log.warn(msg),
  };
  const spawner: AgentSpawner = (opts) =>
    AgentInstance.spawn({
      ...opts,
      stderrTailBytes: config.daemon.agentStderrTailBytes,
      logger: agentLogger,
    });
  const manager = new SessionManager(registry, spawner, undefined, {
    idleTimeoutMs: config.daemon.sessionIdleTimeoutSeconds * 1_000,
    defaultModels: config.defaultModels,
    sessionHistoryMaxEntries: config.daemon.sessionHistoryMaxEntries,
    logger: agentLogger,
    npmRegistry: config.npmRegistry,
  });

  const extensions = new ExtensionManager(extensionList(config));

  registerHealthRoutes(app, HYDRA_VERSION);
  registerSessionRoutes(app, manager, {
    agentId: config.defaultAgent,
    cwd: config.defaultCwd,
  });
  registerAgentRoutes(app, registry, manager, { npmRegistry: config.npmRegistry });
  registerExtensionRoutes(app, extensions);
  registerConfigRoutes(app, {
    defaultAgent: config.defaultAgent,
    defaultCwd: config.defaultCwd,
  });
  registerAuthRoutes(app, {
    store: sessionTokenStore,
    rateLimiter: authRateLimiter,
  });
  registerAcpWsEndpoint(app, {
    validator,
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
    serviceToken,
    daemonWsUrl: `${wsScheme}://${config.daemon.host}:${boundPort}/acp`,
    hydraHome: paths.home(),
  });
  await extensions.start();

  // Fire-and-forget: resurrect any sessions that had pending queued
  // prompts at the last shutdown / crash and replay them. Errors are
  // logged inside the method; not awaited so daemon boot isn't held
  // up by N agent spawns.
  void manager.resurrectPendingQueues().catch((err: unknown) => {
    app.log.warn(
      `queue replay scan failed: ${(err as Error).message}`,
    );
  });

  const shutdown = async (): Promise<void> => {
    clearInterval(sweepInterval);
    await sessionTokenStore.flush();
    await extensions.stop();
    await manager.closeAll();
    // Drain pending meta.json writes after closing sessions so any
    // final regenTitle/persistTitle from idle-close has a chance to
    // hit disk before the daemon exits.
    await manager.flushMetaWrites();
    setBinaryInstallLogger(null);
    setNpmInstallLogger(null);
    setAgentPruneLogger(null);
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
