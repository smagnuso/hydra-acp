// Federation forwarding for every /v1/sessions/:id... REST route, plus
// two standalone helpers used by the sessions.ts route file directly:
// listForeignSessions (the GET /v1/sessions list-merge) and
// createOnRemote (POST /v1/sessions with a `remote` field, creating a
// brand new session directly on a peer instead of locally — there's
// no id to key a preHandler hook off yet at create time).
//
// Registered once as a global preHandler hook rather than per-route:
// the hook is a no-op unless the matched route's *pattern* starts with
// "/v1/sessions/:id" (checked via request.routeOptions.url, so it
// can't misfire on lookalikes like /v1/auth/sessions/:id, which also
// has an `:id` param but means something else entirely) AND the `id`
// value itself parses as a foreign session id. Everything else, most
// requests, falls through to the normal local handler untouched.
//
// This runs as a preHandler, after bearerAuth's onRequest hook has
// already authenticated the caller against *this* daemon — forwarding
// then uses *this* daemon's own stored credential for the peer, not
// the caller's. That's the whole point: callers never need their own
// peer credentials.

import type { FastifyInstance } from "fastify";
import { DEFAULT_DAEMON_PORT } from "../../core/config.js";
import { isLoopbackHost } from "../../core/remote-url.js";
import {
  formatForeignSessionId,
  parseForeignSessionId,
} from "../../core/foreign-session-id.js";
import type { PeerStore } from "../../core/peer-store.js";

export interface SessionForwardDeps {
  store: PeerStore;
  fetchImpl?: typeof fetch;
}

// Routes that can stay open indefinitely (?follow=1) rather than
// answer once. Buffering a forward with `.text()` would hang for the
// lifetime of that stream instead of erroring, so these get an
// explicit, honest 501 instead of a silent hang.
const STREAMING_ROUTES = new Set([
  "/v1/sessions/:id/history",
  "/v1/sessions/:id/events",
]);

export function registerSessionForwardHook(
  app: FastifyInstance,
  deps: SessionForwardDeps,
): void {
  const fetchImpl = deps.fetchImpl ?? fetch;

  app.addHook("preHandler", async (request, reply) => {
    const pattern = request.routeOptions.url;
    if (!pattern || !pattern.startsWith("/v1/sessions/:id")) {
      return;
    }
    const params = request.params as Record<string, string>;
    const id = params.id;
    if (typeof id !== "string") {
      return;
    }
    const foreign = parseForeignSessionId(id);
    if (!foreign) {
      return; // Not name-prefixed — handle locally, as always.
    }
    const peer = deps.store.get(foreign.name);
    if (!peer) {
      reply.code(404).send({
        error: `No remote named "${foreign.name}". Run \`hydra remote add\` first.`,
      });
      return;
    }

    const query = request.query as Record<string, unknown> | undefined;
    if (STREAMING_ROUTES.has(pattern) && isTruthy(query?.follow)) {
      const portSuffix =
        peer.port === DEFAULT_DAEMON_PORT ? "" : `:${peer.port}`;
      reply.code(501).send({
        error:
          `Streaming a federated session isn't supported yet. ` +
          `Attach directly with hydra://${peer.host}${portSuffix}/${foreign.localId} instead.`,
      });
      return;
    }

    const forwardPath = buildForwardPath(pattern, params, foreign.localId, request.url);
    const scheme = isLoopbackHost(peer.host) ? "http" : "https";
    const url = `${scheme}://${peer.host}:${peer.port}${forwardPath}`;

    let upstream: Response;
    try {
      upstream = await fetchImpl(url, {
        method: request.method,
        headers: {
          Authorization: `Bearer ${peer.token}`,
          ...(request.body !== undefined
            ? { "Content-Type": "application/json" }
            : {}),
        },
        ...(request.body !== undefined && request.method !== "GET"
          ? { body: JSON.stringify(request.body) }
          : {}),
      });
    } catch (err) {
      reply.code(502).send({
        error: `Could not reach remote "${foreign.name}" (${peer.host}:${peer.port}): ${(err as Error).message}`,
      });
      return;
    }

    if (upstream.status === 204) {
      reply.code(204).send();
      return;
    }
    const text = await upstream.text();
    const contentType = upstream.headers.get("content-type");
    if (contentType) {
      reply.header("content-type", contentType);
    }
    reply.code(upstream.status).send(text);
  });
}

// Best-effort merge for GET /v1/sessions: ask every stored peer for
// its own list (forwarding only the filters that still mean something
// off-box — includeNonInteractive, status; `cwd` and `since` are the
// caller's job to exclude before calling this, they're local-
// filesystem- and local-cursor-scoped respectively) and stamp each
// returned sessionId with its origin so it round-trips correctly if
// the caller acts on it later. An unreachable or misbehaving peer is
// skipped rather than failing the whole listing — there's no
// liveness tracking yet (see peer-store.ts), so "can't reach it right
// now" and "not federated" aren't distinguished here.
export async function listForeignSessions(
  store: PeerStore,
  filters: { includeNonInteractive?: boolean; status?: "warm" | "cold" },
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, unknown>[]> {
  const peers = store.list();
  const results = await Promise.allSettled(
    peers.map(async (summary) => {
      const record = store.get(summary.name);
      if (!record) {
        return [];
      }
      const scheme = isLoopbackHost(record.host) ? "http" : "https";
      const params = new URLSearchParams();
      if (filters.includeNonInteractive) {
        params.set("includeNonInteractive", "1");
      }
      if (filters.status) {
        params.set("status", filters.status);
      }
      const qs = params.toString();
      const url = `${scheme}://${record.host}:${record.port}/v1/sessions${qs ? `?${qs}` : ""}`;
      const res = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${record.token}` },
      });
      if (!res.ok) {
        return [];
      }
      const body = (await res.json()) as { sessions?: Record<string, unknown>[] };
      return (body.sessions ?? []).map((entry) => ({
        ...entry,
        sessionId: formatForeignSessionId({
          name: record.name,
          localId: String(entry.sessionId),
        }),
        // Distinct from `importedFromMachine` on purpose — that field
        // marks a cold bundle-imported mirror and drives the picker's/
        // browser's "attach to pull this in locally" prompt. This
        // entry is live and stays live on the peer; folding it into
        // that same signal would trigger the wrong client action on
        // click. See core/peer-store.ts and PROTOCOL.md's Sessions
        // section for the addressing this pairs with.
        remote: record.name,
      }));
    }),
  );
  return results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
}

export interface CreateOnRemoteResult {
  status: number;
  body: unknown;
}

// POST /v1/sessions with a `remote` field forwards here instead of
// calling manager.create() locally. Deliberately forwards only the
// protocol-level fields (cwd, agentId, mcpServers, workspace) — the
// local handler's enrichment (extension-MCP token minting, directory-
// config resolution, transformer chain) is all specific to *this*
// daemon's filesystem and registered extensions, and would be wrong
// (or point at unreachable loopback URLs) if applied to a session
// that's actually going to live on the peer. The peer runs that same
// enrichment itself, against its own filesystem and its own
// extensions, when it handles the forwarded plain create.
export async function createOnRemote(
  store: PeerStore,
  remoteName: string,
  body: {
    cwd?: string;
    agentId?: string;
    mcpServers?: unknown[];
    workspace?: unknown;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<CreateOnRemoteResult> {
  const record = store.get(remoteName);
  if (!record) {
    return {
      status: 404,
      body: { error: `No remote named "${remoteName}". Run \`hydra remote add\` first.` },
    };
  }
  const scheme = isLoopbackHost(record.host) ? "http" : "https";
  const url = `${scheme}://${record.host}:${record.port}/v1/sessions`;
  let upstream: Response;
  try {
    upstream = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${record.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return {
      status: 502,
      body: {
        error: `Could not reach remote "${remoteName}" (${record.host}:${record.port}): ${(err as Error).message}`,
      },
    };
  }
  const text = await upstream.text();
  let parsed: unknown = null;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!upstream.ok) {
    return { status: upstream.status, body: parsed };
  }
  const result = parsed as { sessionId?: unknown } | null;
  if (result && typeof result.sessionId === "string") {
    return {
      status: upstream.status,
      body: {
        ...result,
        sessionId: formatForeignSessionId({ name: remoteName, localId: result.sessionId }),
      },
    };
  }
  return { status: upstream.status, body: parsed };
}

function isTruthy(v: unknown): boolean {
  return v === "1" || v === "true" || v === true;
}

// Rebuilds the request path against the peer using the *route
// pattern* (e.g. "/v1/sessions/:id/prompt/:messageId/notify") rather
// than string-replacing inside the raw URL, so it's correct
// regardless of how many params a given route has. Only `:id` is
// substituted with the unwrapped local id; every other param keeps
// its original value. The query string, if any, passes through
// unchanged.
function buildForwardPath(
  pattern: string,
  params: Record<string, string>,
  localId: string,
  rawUrl: string,
): string {
  const path = pattern.replace(/:([A-Za-z_]+)/g, (_, name: string) =>
    encodeURIComponent(name === "id" ? localId : (params[name] ?? "")),
  );
  const queryIndex = rawUrl.indexOf("?");
  return queryIndex === -1 ? path : path + rawUrl.slice(queryIndex);
}
