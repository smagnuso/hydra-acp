import type { FastifyInstance } from "fastify";
import { paths } from "../../core/paths.js";

export function registerHealthRoutes(
  app: FastifyInstance,
  version: string,
  configDigest: string,
  // Live view of tier-"warn" keys that differ from what the daemon booted
  // with. A getter rather than a value because the reloader updates it
  // long after routes are registered.
  driftedKeys: () => string[] = () => [],
): void {
  app.get("/v1/health", { config: { skipAuth: true } }, async () => {
    // `home` is the daemon's resolved HYDRA_ACP_HOME. It answers directly
    // the question configDigest was standing in for: is this daemon rooted
    // in the same directory the client is? That's what determines whether
    // the bearer token, session store and pidfile are shared, and a
    // mismatch there is the case where adopting the daemon would fail at
    // the WS handshake. The digest is a poor proxy for it — it never
    // misses, but it fires on every benign config edit.
    //
    // Newly reachable now that a `.hydra-acp.json` can set `home`, which
    // re-roots the client without touching the daemon.
    return {
      status: "ok",
      version,
      configDigest,
      home: paths.home(),
      driftedKeys: driftedKeys(),
    };
  });
}
