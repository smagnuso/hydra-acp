import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as net from "node:net";
import * as tls from "node:tls";
import Fastify, { type FastifyInstance } from "fastify";
import websocketPlugin from "@fastify/websocket";
import { selectAcpSubprotocol } from "./ws-protocol.js";
import pino, { type Level } from "pino";
import createPinoRoll from "pino-roll";
import {
  expandHome,
  type HydraConfig,
  extensionList,
  transformerList,
} from "../core/config.js";
import { setToolBlobCompression } from "../core/tool-store.js";
import { Registry } from "../core/registry.js";
import { AgentInstance } from "../core/agent-instance.js";
import { SessionManager, type AgentSpawner } from "../core/session-manager.js";
import { ExtensionManager } from "../core/extensions.js";
import { TransformerManager } from "../core/transformer-manager.js";
import { ExtensionCommandRegistry } from "../core/extension-commands.js";
import { paths } from "../core/paths.js";
import { writeDaemonPidFile } from "../core/daemon-pidfile.js";
import { setBinaryInstallLogger } from "../core/binary-install.js";
import { setNpmInstallLogger } from "../core/npm-install.js";
import {
  pruneStaleAgentVersions,
  setAgentPruneLogger,
} from "../core/agent-prune.js";
import { startAgentSyncScheduler } from "../core/agent-sync-scheduler.js";
import { startSessionGc } from "../core/session-gc.js";
import { HYDRA_VERSION } from "../core/hydra-version.js";
import { computeConfigDigest } from "../core/config-digest.js";
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
import { registerRecallMcpRoutes } from "./mcp/recall-server.js";
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

  // ~/.hydra-acp/tls/cert.pem etc. — expand leading ~ / $HOME so a
  // portable config.json works regardless of the user's home dir.
  // The cert/key are NOT handed to Fastify directly; Fastify always
  // speaks plain HTTP so co-resident extensions can dial it without
  // any TLS trust story. When TLS is configured, a bare TCP-level
  // tls.Server (set up further down) terminates TLS on the public
  // interface and pipes decrypted bytes to the plain Fastify on a
  // loopback ephemeral port.
  const tlsKey = config.daemon.tls
    ? await fsp.readFile(expandHome(config.daemon.tls.key))
    : undefined;
  const tlsCert = config.daemon.tls
    ? await fsp.readFile(expandHome(config.daemon.tls.cert))
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

  const rateLimitSweepInterval = setInterval(
    () => {
      authRateLimiter.sweepExpired();
    },
    5 * 60 * 1000,
  );
  rateLimitSweepInterval.unref();

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
  // Honor the tool-blob compression escape hatch before any history write.
  setToolBlobCompression(config.compressToolContent);
  const extensionCommands = new ExtensionCommandRegistry();
  const manager = new SessionManager(registry, spawner, undefined, {
    idleTimeoutMs: config.daemon.sessionIdleTimeoutSeconds * 1_000,
    defaultModels: config.defaultModels,
    synopsisAgent: config.synopsisAgent,
    synopsisModel: config.synopsisModel,
    compactionAgent: config.compaction?.agent,
    compactionModel: config.compaction?.model,
    defaultTransformers: config.defaultTransformers,
    sessionHistoryMaxEntries: config.daemon.sessionHistoryMaxEntries,
    logger: agentLogger,
    npmRegistry: config.npmRegistry,
    extensionCommands,
    defaultCwd: config.defaultCwd,
  });

  const extensions = new ExtensionManager(extensionList(config), undefined, {
    tokenRegistry: processRegistry,
  });
  const transformers = new TransformerManager(transformerList(config), undefined, {
    tokenRegistry: processRegistry,
  });

  registerHealthRoutes(app, HYDRA_VERSION, computeConfigDigest(config));
  const mcpTokenRegistry = new McpTokenRegistry();
  const extensionMcp = new ExtensionMcpRegistry();
  // Captured lazily by handlers that need to mint MCP descriptors.
  // MCP servers run as co-resident extensions, so we hand them the
  // plain-HTTP loopback URL — same reason we point extensions there:
  // no TLS trust story to inherit.
  let daemonOriginCached: string | undefined;
  const getDaemonOrigin = (): string => {
    if (daemonOriginCached !== undefined) {
      return daemonOriginCached;
    }
    const addr = app.server.address();
    const port =
      addr && typeof addr === "object" ? addr.port : config.daemon.port;
    daemonOriginCached = `http://127.0.0.1:${port}`;
    return daemonOriginCached;
  };
  registerSessionRoutes(
    app,
    manager,
    {
      agentId: config.defaultAgent,
      cwd: config.defaultCwd,
      publicHost: config.daemon.publicHost,
      host: config.daemon.host,
      port: config.daemon.port,
      compaction: config.compaction,
    },
    { extensionMcp, mcpTokenRegistry, getDaemonOrigin },
  );
  registerAgentRoutes(app, registry, manager, { npmRegistry: config.npmRegistry });
  registerExtensionRoutes(app, extensions);
  registerTransformerRoutes(app, transformers);
  registerConfigRoutes(app, {
    defaultAgent: config.defaultAgent,
    defaultCwd: config.defaultCwd,
    defaultModels: { ...config.defaultModels },
    ...(config.synopsisAgent !== undefined
      ? { synopsisAgent: config.synopsisAgent }
      : {}),
    ...(config.synopsisModel !== undefined
      ? { synopsisModel: config.synopsisModel }
      : {}),
    defaultTransformers: [...config.defaultTransformers],
  });
  registerAuthRoutes(app, {
    store: sessionTokenStore,
    rateLimiter: authRateLimiter,
  });
  registerStdinMcpRoutes(app, mcpTokenRegistry);
  registerRecallMcpRoutes(app, mcpTokenRegistry);
  registerExtensionMcpRoutes(app, mcpTokenRegistry, extensionMcp);
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
    registry,
  });

  // Plain-HTTP listener placement:
  //   - TLS configured  → Fastify on 127.0.0.1:<ephemeral>, and a TCP-
  //                       level TLS terminator on config.daemon.host:
  //                       config.daemon.port forwards decrypted bytes
  //                       to it. Co-resident extensions dial the
  //                       loopback ephemeral URL and never see TLS.
  //   - TLS not set     → Fastify on config.daemon.host:config.daemon.port
  //                       as before. ensureLoopbackOrTls keeps this from
  //                       binding a wildcard without TLS.
  const tlsConfigured = !!config.daemon.tls;
  await app.listen({
    host: tlsConfigured ? "127.0.0.1" : config.daemon.host,
    port: tlsConfigured ? 0 : config.daemon.port,
  });

  const plainAddress = app.server.address();
  const plainBoundPort =
    plainAddress && typeof plainAddress === "object"
      ? plainAddress.port
      : config.daemon.port;

  let tlsTerminator: tls.Server | undefined;
  let publicHost = config.daemon.host;
  let publicPort = plainBoundPort;
  if (tlsConfigured && tlsKey && tlsCert) {
    tlsTerminator = startTlsTerminator({
      listenHost: config.daemon.host,
      listenPort: config.daemon.port,
      upstreamHost: "127.0.0.1",
      upstreamPort: plainBoundPort,
      tlsOptions: { key: tlsKey, cert: tlsCert },
      logger: app.log,
    });
    const addr = tlsTerminator.address();
    if (addr && typeof addr === "object") {
      publicPort = addr.port;
    }
  }

  await fsp.mkdir(paths.home(), { recursive: true });
  await writeDaemonPidFile({
    pid: process.pid,
    host: publicHost,
    port: publicPort,
    loopbackPort: plainBoundPort,
    startedAt: new Date().toISOString(),
  });

  // Children always dial plain HTTP on loopback — no TLS trust story
  // for them to inherit, regardless of what the public listener does.
  const processContext = {
    daemonUrl: `http://127.0.0.1:${plainBoundPort}`,
    daemonHost: "127.0.0.1",
    daemonPort: plainBoundPort,
    serviceToken,
    daemonWsUrl: `ws://127.0.0.1:${plainBoundPort}/acp`,
    hydraHome: paths.home(),
  };
  extensions.setContext(processContext);
  transformers.setContext(processContext);
  await extensions.start();
  await transformers.start();

  // Reconcile stale permission attention flags from all persisted
  // session records before the daemon begins any background work.
  // This ensures fast-attaching clients never observe stale
  // awaitingInput=true for permission requests whose agents are dead.
  try {
    await manager.reconcilePermissionFlags();
  } catch (err) {
    app.log.warn(
      `permission flag reconcile failed: ${(err as Error).message}`,
    );
  }

  // Fire-and-forget: resurrect any sessions that had pending queued
  // prompts at the last shutdown / crash and replay them. Errors are
  // logged inside the method; not awaited so daemon boot isn't held
  // up by N agent spawns.
  void manager.resurrectPendingQueues().catch((err: unknown) => {
    app.log.warn(
      `queue replay scan failed: ${(err as Error).message}`,
    );
  });

  // Fire-and-forget: resume any in-flight compactions from the prior
  // daemon run. Sequential iteration avoids a startup thundering herd.
  void manager.resumePendingCompactions().catch((err: unknown) => {
    app.log.warn(
      `compaction resume scan failed: ${(err as Error).message}`,
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

  // Background sweep: delete non-interactive cold session records
  // (mostly one-shot `hydra cat` runs) that haven't been touched in
  // sessionGcMaxAgeDays. Keeps ~/.hydra-acp/sessions/ from growing
  // unbounded — every cat invocation writes a meta.json + history.jsonl
  // that no one ever lists by default, and on long-lived installs the
  // accumulated rows slow every list() sweep. Disabled when interval
  // is 0.
  const gcIntervalMs = config.daemon.sessionGcIntervalMinutes * 60 * 1_000;
  const gcMaxAgeMs = config.daemon.sessionGcMaxAgeDays * 24 * 60 * 60 * 1_000;
  const stopSessionGc =
    gcIntervalMs > 0
      ? startSessionGc({
          manager,
          intervalMs: gcIntervalMs,
          maxAgeMs: gcMaxAgeMs,
          logger: agentLogger,
        })
      : undefined;

  const shutdown = async (): Promise<void> => {
    if (stopSessionGc) {
      stopSessionGc();
    }
    if (stopAgentSync) {
      stopAgentSync();
    }
    clearInterval(sweepInterval);
    clearInterval(rateLimitSweepInterval);
    const safeStep = async (name: string, fn: () => Promise<unknown> | unknown): Promise<void> => {
      try {
        await fn();
      } catch (err) {
        app.log.warn(`shutdown step ${name} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    await safeStep("sessionTokenStore.flush", () => sessionTokenStore.flush());
    await safeStep("extensions.stop", () => extensions.stop());
    await safeStep("transformers.stop", () => transformers.stop());
    await safeStep("manager.closeAll", () => manager.closeAll());
    // Wait for any in-flight background synopsis to land (and queued
    // ones to drain). The 30s cap bounds total shutdown latency; queued
    // jobs that didn't get to run before the cap are dropped by
    // shutdownSynopsis. Smoke testing showed ephemeral synopsis on
    // Haiku finishes in 2-3s even for deep histories.
    await safeStep("manager.flushSynopsis", () => manager.flushSynopsis(30_000));
    await safeStep("manager.shutdownSynopsis", () => manager.shutdownSynopsis());
    // Drain pending meta.json writes after closing sessions so any
    // final persistTitle/persistSynopsis call has a chance to hit disk
    // before the daemon exits.
    await safeStep("manager.flushMetaWrites", () => manager.flushMetaWrites());
    // Same for history.jsonl — markClosed emits a turn_complete
    // (interrupted) for the in-flight turn via fire-and-forget append.
    // Without this flush, a SIGTERM can race ahead of that write and
    // leave an unmatched prompt_received that leaks pendingTurns on
    // every client that later replays the session.
    await safeStep("manager.flushHistoryWrites", () => manager.flushHistoryWrites());
    setBinaryInstallLogger(null);
    setNpmInstallLogger(null);
    setAgentPruneLogger(null);
    if (tlsTerminator) {
      await safeStep("tlsTerminator.close", () =>
        new Promise<void>((resolve) =>
          tlsTerminator!.close(() => resolve()),
        ),
      );
    }
    await safeStep("app.close", () => app.close());
    try {
      fs.unlinkSync(paths.pidFile());
    } catch {
      void 0;
    }
    await safeStep("fileStream.flushSync", () => fileStream.flushSync());
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
    mkdir: true,
    symlink: true,
    // Retain only the most recent files. Without this pino-roll
    // happily rotates forever; we've seen the directory grow into
    // the hundreds-of-MB range. Combined with the size cap above,
    // total disk use is bounded at ~200MB.
    //
    // Note: `frequency` was previously also set to "daily", but in
    // pino-roll v4 the size accountant under-counts when both knobs
    // are engaged via pino.multistream — single files grew into
    // the hundreds of MB despite the 10m cap. Size-only is reliable.
    limit: { count: 20 },
  });
  const stderrStream = pino.destination(2);
  const stream = pino.multistream([
    { stream: fileStream, level: level as Level },
    { stream: stderrStream, level: level as Level },
  ]);
  return { stream, fileStream };
}

// TCP-level TLS terminator. Accepts TLS connections on (listenHost,
// listenPort), opens a plain TCP connection to (upstreamHost,
// upstreamPort), and pipes decrypted bytes between them. HTTP and
// WebSocket upgrades both pass through transparently because the
// forwarder doesn't speak HTTP — it just shuttles raw bytes after
// the TLS handshake completes. Used so co-resident extensions can
// dial a plain-HTTP Fastify on loopback while off-box clients still
// reach a TLS endpoint on the configured public address.
interface TlsTerminatorOptions {
  listenHost: string;
  listenPort: number;
  upstreamHost: string;
  upstreamPort: number;
  tlsOptions: tls.SecureContextOptions;
  logger: { warn: (msg: string) => void };
}

function startTlsTerminator(opts: TlsTerminatorOptions): tls.Server {
  const server = tls.createServer(opts.tlsOptions, (clientSocket) => {
    const upstream = net.connect({
      host: opts.upstreamHost,
      port: opts.upstreamPort,
    });
    let closed = false;
    const teardown = (err?: Error): void => {
      if (closed) {
        return;
      }
      closed = true;
      if (err) {
        opts.logger.warn(
          `tls terminator forwarder error: ${err.message ?? String(err)}`,
        );
      }
      try {
        clientSocket.destroy();
      } catch {
        // best effort
      }
      try {
        upstream.destroy();
      } catch {
        // best effort
      }
    };
    clientSocket.on("error", teardown);
    upstream.on("error", teardown);
    clientSocket.on("close", () => teardown());
    upstream.on("close", () => teardown());
    clientSocket.pipe(upstream);
    upstream.pipe(clientSocket);
  });
  server.on("tlsClientError", (err) => {
    opts.logger.warn(`tls handshake error: ${err.message}`);
  });
  server.listen({ host: opts.listenHost, port: opts.listenPort });
  return server;
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
