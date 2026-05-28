import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import Fastify, { type FastifyInstance } from "fastify";
import websocketPlugin from "@fastify/websocket";
import { selectAcpSubprotocol } from "./ws-protocol.js";
import pino, { type Level } from "pino";
import createPinoRoll from "pino-roll";
import { type HydraConfig, extensionList, transformerList } from "../core/config.js";
import { Registry } from "../core/registry.js";
import { AgentInstance } from "../core/agent-instance.js";
import { SessionManager, type AgentSpawner } from "../core/session-manager.js";
import { ExtensionManager } from "../core/extensions.js";
import { TransformerManager } from "../core/transformer-manager.js";
import { ExtensionCommandRegistry } from "../core/extension-commands.js";
import { paths } from "../core/paths.js";
import { setBinaryInstallLogger } from "../core/binary-install.js";
import { setNpmInstallLogger } from "../core/npm-install.js";
import {
  pruneStaleAgentVersions,
  setAgentPruneLogger,
} from "../core/agent-prune.js";
import { startAgentSyncScheduler } from "../core/agent-sync-scheduler.js";
import { HYDRA_VERSION } from "../core/hydra-version.js";
import { SessionTokenStore } from "../core/session-tokens.js";
import {
  bearerAuth,
  CompositeTokenValidator,
  ProcessTokenRegistry,
  SessionTokenValidator,
  StaticTokenValidator,
} from "./auth.js";
import { AuthRateLimiter } from "./rate-limit.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerExtensionRoutes } from "./routes/extensions.js";
import { registerTransformerRoutes } from "./routes/transformers.js";
import { registerConfigRoutes } from "./routes/config.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerAcpWsEndpoint } from "./acp-ws.js";
import { McpTokenRegistry } from "./mcp/token-registry.js";
import { registerStdinMcpRoutes } from "./mcp/stdin-server.js";
import { ExtensionMcpRegistry } from "../core/extension-mcp.js";
import { registerExtensionMcpRoutes } from "./mcp/extension-route.js";

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
  transformers: TransformerManager;
  // Exposed for integration tests + future programmatic consumers; the
  // daemon-internal lookup paths don't go through these handles.
  mcpTokenRegistry: McpTokenRegistry;
  extensionMcp: ExtensionMcpRegistry;
  processRegistry: ProcessTokenRegistry;
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
  const processRegistry = new ProcessTokenRegistry();
  const validator = new CompositeTokenValidator([
    new StaticTokenValidator(serviceToken),
    new SessionTokenValidator(sessionTokenStore),
    processRegistry,
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
  const extensionCommands = new ExtensionCommandRegistry();
  const manager = new SessionManager(registry, spawner, undefined, {
    idleTimeoutMs: config.daemon.sessionIdleTimeoutSeconds * 1_000,
    defaultModels: config.defaultModels,
    synopsisAgent: config.synopsisAgent,
    synopsisModel: config.synopsisModel,
    synopsisOnClose: config.synopsisOnClose,
    defaultTransformers: config.defaultTransformers,
    sessionHistoryMaxEntries: config.daemon.sessionHistoryMaxEntries,
    logger: agentLogger,
    npmRegistry: config.npmRegistry,
    extensionCommands,
  });

  const extensions = new ExtensionManager(extensionList(config), undefined, {
    tokenRegistry: processRegistry,
  });
  const transformers = new TransformerManager(transformerList(config), undefined, {
    tokenRegistry: processRegistry,
  });

  registerHealthRoutes(app, HYDRA_VERSION);
  registerSessionRoutes(app, manager, {
    agentId: config.defaultAgent,
    cwd: config.defaultCwd,
    publicHost: config.daemon.publicHost,
    host: config.daemon.host,
    port: config.daemon.port,
  });
  registerAgentRoutes(app, registry, manager, { npmRegistry: config.npmRegistry });
  registerExtensionRoutes(app, extensions);
  registerTransformerRoutes(app, transformers);
  registerConfigRoutes(app, {
    defaultAgent: config.defaultAgent,
    defaultCwd: config.defaultCwd,
  });
  registerAuthRoutes(app, {
    store: sessionTokenStore,
    rateLimiter: authRateLimiter,
  });
  const mcpTokenRegistry = new McpTokenRegistry();
  const extensionMcp = new ExtensionMcpRegistry();
  registerStdinMcpRoutes(app, mcpTokenRegistry);
  registerExtensionMcpRoutes(app, mcpTokenRegistry, extensionMcp);
  // Captured lazily by the session/new handler. The bound port isn't
  // known until app.listen() completes below, so we defer composition
  // until request time.
  let daemonOriginCached: string | undefined;
  const getDaemonOrigin = (): string => {
    if (daemonOriginCached !== undefined) {
      return daemonOriginCached;
    }
    const addr = app.server.address();
    const port =
      addr && typeof addr === "object" ? addr.port : config.daemon.port;
    const scheme = config.daemon.tls ? "https" : "http";
    daemonOriginCached = `${scheme}://${config.daemon.host}:${port}`;
    return daemonOriginCached;
  };
  registerAcpWsEndpoint(app, {
    validator,
    manager,
    defaultAgent: config.defaultAgent,
    processRegistry,
    onExtensionVersion: (name, version) => extensions.reportVersion(name, version),
    onTransformerVersion: (name, version) => transformers.reportVersion(name, version),
    transformers,
    extensionCommands,
    mcpTokenRegistry,
    extensionMcp,
    getDaemonOrigin,
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
  const processContext = {
    daemonUrl: `${scheme}://${config.daemon.host}:${boundPort}`,
    daemonHost: config.daemon.host,
    daemonPort: boundPort,
    serviceToken,
    daemonWsUrl: `${wsScheme}://${config.daemon.host}:${boundPort}/acp`,
    hydraHome: paths.home(),
  };
  extensions.setContext(processContext);
  transformers.setContext(processContext);
  await extensions.start();
  await transformers.start();

  // Fire-and-forget: resurrect any sessions that had pending queued
  // prompts at the last shutdown / crash and replay them. Errors are
  // logged inside the method; not awaited so daemon boot isn't held
  // up by N agent spawns.
  void manager.resurrectPendingQueues().catch((err: unknown) => {
    app.log.warn(
      `queue replay scan failed: ${(err as Error).message}`,
    );
  });

  // Background poll: walk every installed agent on a staggered
  // schedule and run syncFromAgent so sessions created outside hydra
  // (or by other tools) show up in `sessions list` without the user
  // having to remember `hydra agent sync <id>`. Disabled when the
  // interval is 0.
  const intervalMs = config.daemon.agentSyncIntervalMinutes * 60 * 1_000;
  const stopAgentSync =
    intervalMs > 0
      ? startAgentSyncScheduler({
          registry,
          manager,
          intervalMs,
          logger: agentLogger,
        })
      : undefined;

  const shutdown = async (): Promise<void> => {
    if (stopAgentSync) {
      stopAgentSync();
    }
    clearInterval(sweepInterval);
    await sessionTokenStore.flush();
    await extensions.stop();
    await transformers.stop();
    await manager.closeAll();
    // Wait for any in-flight background synopsis to land (and queued
    // ones to drain). The 30s cap bounds total shutdown latency; queued
    // jobs that didn't get to run before the cap are dropped by
    // shutdownSynopsis. Smoke testing showed ephemeral synopsis on
    // Haiku finishes in 2-3s even for deep histories.
    await manager.flushSynopsis(30_000);
    await manager.shutdownSynopsis();
    // Drain pending meta.json writes after closing sessions so any
    // final persistTitle/persistSynopsis call has a chance to hit disk
    // before the daemon exits.
    await manager.flushMetaWrites();
    // Same for history.jsonl — markClosed emits a turn_complete
    // (interrupted) for the in-flight turn via fire-and-forget append.
    // Without this flush, a SIGTERM can race ahead of that write and
    // leave an unmatched prompt_received that leaks pendingTurns on
    // every client that later replays the session.
    await manager.flushHistoryWrites();
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

  return {
    app,
    manager,
    registry,
    extensions,
    transformers,
    mcpTokenRegistry,
    extensionMcp,
    processRegistry,
    shutdown,
  };
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
