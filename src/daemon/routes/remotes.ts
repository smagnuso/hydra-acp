import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DEFAULT_DAEMON_PORT } from "../../core/config.js";
import { PEER_NAME_PATTERN, PeerStore } from "../../core/peer-store.js";
import {
  PeerLoginError,
  loginToPeer,
  logoutFromPeer,
} from "../../core/peer-login.js";
import { clearPin, setPin } from "../../core/tls-trust.js";
import type { PeerHealthTracker } from "../peer-health.js";

const AddBody = z.object({
  name: z.string().min(1).max(64).regex(PEER_NAME_PATTERN),
  host: z.string().min(1),
  port: z.number().int().positive().optional(),
  password: z.string().min(1),
  label: z.string().min(1).max(256).optional(),
  ttlSec: z.number().int().positive().optional(),
  // Set by `hydra remote add` after its own TOFU probe/prompt when the
  // peer presents a cert that doesn't validate against the system
  // trust store — see core/remote-target.ts's defaultTlsHandshake for
  // the human-login flow this mirrors. Trusted as given: the CLI is
  // the one with a terminal to actually show the fingerprint to a
  // human, this route just records the decision that was already made.
  pinnedFingerprint: z.string().min(1).optional(),
});

export interface RemoteRoutesDeps {
  store: PeerStore;
  // Optional so existing callers (and tests) that don't care about
  // liveness don't have to construct one. Absent status just doesn't
  // appear on list entries.
  health?: PeerHealthTracker;
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

    // Pin BEFORE logging in, not after: the login fetch itself needs
    // the pinning dispatcher to already trust this fingerprint for a
    // self-signed peer, or it fails cert validation before ever
    // reaching loginToPeer.
    if (body.pinnedFingerprint) {
      setPin(body.host, port, body.pinnedFingerprint);
    }

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
      ...(body.pinnedFingerprint !== undefined
        ? { pinnedFingerprint: body.pinnedFingerprint, pinnedAt: addedAt }
        : {}),
    };
    await deps.store.set(record);
    // We just logged in successfully — seed the health snapshot rather
    // than leaving it "unknown" until the next poll tick.
    deps.health?.markOk(record.name);
    return reply.code(201).send({
      name: record.name,
      host: record.host,
      port: record.port,
      expiresAt: record.expiresAt,
      label: record.label,
      addedAt: record.addedAt,
      pinnedFingerprint: record.pinnedFingerprint,
      status: deps.health?.get(record.name)?.status ?? "unknown",
    });
  });

  app.get("/v1/remotes", async (_request, reply) => {
    const remotes = deps.store.list().map((summary) => {
      const snapshot = deps.health?.get(summary.name);
      return {
        ...summary,
        status: snapshot?.status ?? "unknown",
        ...(snapshot?.checkedAt ? { lastCheckedAt: snapshot.checkedAt } : {}),
      };
    });
    return reply.code(200).send({ remotes });
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
      deps.health?.forget(name);
      // Only unpin if no other remote name still points at this same
      // host:port (see peer-store.ts — two names sharing a host:port
      // is supported) — otherwise this would yank trust out from
      // under an entry that's still using it.
      const stillPinned = deps.store
        .list()
        .some((r) => r.host === existing.host && r.port === existing.port);
      if (!stillPinned) {
        clearPin(existing.host, existing.port);
      }
      return reply.code(204).send();
    },
  );
}
