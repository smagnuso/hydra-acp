import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DEFAULT_DAEMON_PORT } from "../../core/config.js";
import { PEER_NAME_PATTERN, PeerStore } from "../../core/peer-store.js";
import {
  PeerLoginError,
  loginToPeer,
  logoutFromPeer,
} from "../../core/peer-login.js";

const AddBody = z.object({
  name: z.string().min(1).max(64).regex(PEER_NAME_PATTERN),
  host: z.string().min(1),
  port: z.number().int().positive().optional(),
  password: z.string().min(1),
  label: z.string().min(1).max(256).optional(),
  ttlSec: z.number().int().positive().optional(),
});

export interface RemoteRoutesDeps {
  store: PeerStore;
}

// `hydra remote add/list/remove`. See core/peer-store.ts for why this
// is a separate registry from RemotesStore/remotes.json.
export function registerRemoteRoutes(
  app: FastifyInstance,
  deps: RemoteRoutesDeps,
): void {
  app.post("/v1/remotes", async (request, reply) => {
    let body: z.infer<typeof AddBody>;
    try {
      body = AddBody.parse(request.body);
    } catch {
      return reply.code(400).send({
        error:
          "Invalid request body (name must match " +
          `${PEER_NAME_PATTERN} and the rest is a normal login request)`,
      });
    }
    const port = body.port ?? DEFAULT_DAEMON_PORT;

    let issued: { token: string; expiresAt: string };
    try {
      issued = await loginToPeer({
        host: body.host,
        port,
        password: body.password,
        label: body.label,
        ttlSec: body.ttlSec,
      });
    } catch (err) {
      if (err instanceof PeerLoginError) {
        return reply.code(err.status).send({ error: err.message });
      }
      throw err;
    }

    // Upsert, not create-or-409: re-running `remote add` under the
    // same name is the documented way to refresh a token before it
    // expires (see peer-store.ts). Diverges from `git remote add`,
    // which errors on a name collision — a deliberate choice here.
    const addedAt = new Date().toISOString();
    const record = {
      name: body.name,
      host: body.host,
      port,
      token: issued.token,
      expiresAt: issued.expiresAt,
      addedAt,
      ...(body.label !== undefined ? { label: body.label } : {}),
    };
    await deps.store.set(record);
    return reply.code(201).send({
      name: record.name,
      host: record.host,
      port: record.port,
      expiresAt: record.expiresAt,
      label: record.label,
      addedAt: record.addedAt,
    });
  });

  app.get("/v1/remotes", async (_request, reply) => {
    return reply.code(200).send({ remotes: deps.store.list() });
  });

  app.delete<{ Params: { name: string } }>(
    "/v1/remotes/:name",
    async (request, reply) => {
      const name = request.params.name;
      const existing = deps.store.get(name);
      if (!existing) {
        return reply.code(404).send({ error: "Not found" });
      }
      await logoutFromPeer({
        host: existing.host,
        port: existing.port,
        token: existing.token,
      });
      await deps.store.delete(name);
      return reply.code(204).send();
    },
  );
}
