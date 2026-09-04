// Federation forwarding for every /v1/sessions/:id... REST route, plus
// two standalone pieces used by the sessions.ts route file directly:
// ForeignSessionCache (the GET /v1/sessions list-merge) and
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

// Best-effort fetch for every stored peer's own session list, stamping
// each returned sessionId with its origin so it round-trips correctly
// if the caller acts on it later. An unreachable or misbehaving peer
// is skipped rather than failing the whole listing — peer-health.ts's
// liveness poll is a separate, slower-cadence signal for visibility;
// this always just tries live and drops what fails.
//
// Not called directly from the GET /v1/sessions route — see
// ForeignSessionCache below, which calls this on its own background
// timer and serves reads from the result. That indirection exists
// because of a real bug this shipped with initially: GET /v1/sessions
// only merged peer data on a *non-incremental* call (no `since=`), on
// the reasoning that `since` is "the caller's job to exclude, it's
// local-cursor-scoped". In practice, once a client has ever completed
// one full fetch, it uses `since=` for every poll from then on — so
// federated sessions appeared exactly once, on a client's very first
// load, and never again after. Reading from a periodically-refreshed
// cache instead means every response (incremental or not) reflects
// federation, without re-fetching every peer's full list on every
// single client poll.
const DEFAULT_FOREIGN_CACHE_INTERVAL_MS = 5_000;

interface PeerCacheState {
  // undefined until the first successful fetch from this peer. Its
  // presence, not any particular value, is what decides whether the
  // next refresh asks that peer incrementally or fetches fresh.
  cursor: number | undefined;
  // Keyed by the already-rewrapped (name-prefixed) sessionId.
  sessions: Map<string, Record<string, unknown>>;
}

// Periodically refreshed cache of every peer's session list, read by
// GET /v1/sessions on both the incremental and full-listing paths —
// see the "GET /v1/sessions additionally merges..." note in
// PROTOCOL.md for why reading the wire live on every caller request
// isn't the right fix.
//
// Refreshes *this daemon's own* connection to each peer incrementally,
// using the exact `since=` mechanism a normal client already uses
// against us — each peer gets its own remembered cursor, independent
// of whatever cursor any *caller* of ours happens to be polling with.
// That distinction matters: a caller's cursor is minted by, and only
// meaningful to, the daemon that issued it, so it can never be
// forwarded to a peer directly. But there's no reason *our* refresh
// has to re-fetch and re-serialize a peer's entire session list every
// tick just because the caller-facing cursor problem exists — that
// would just relocate the exact expense the incremental mechanism
// exists to avoid from client↔daemon to daemon↔daemon. The merge rule
// for folding an incremental page into the running per-peer cache
// mirrors the client-side one in tui/discovery.ts's
// mergeSessionListPage: purge anything not definitively cold (an
// incremental page always carries the complete current warm set, so a
// row leaving it — e.g. no longer attached — isn't named in `removed`,
// that only tracks actual deletions), delete `removed` ids, then
// upsert whatever the page sent.
export class ForeignSessionCache {
  private perPeer = new Map<string, PeerCacheState>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly store: PeerStore,
    private readonly opts: { intervalMs?: number; fetchImpl?: typeof fetch } = {},
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }
    void this.refreshNow();
    this.timer = setInterval(
      () => void this.refreshNow(),
      this.opts.intervalMs ?? DEFAULT_FOREIGN_CACHE_INTERVAL_MS,
    );
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  // Exposed (not just called from start()'s timer) so a test — or a
  // future "I just added a remote, don't make me wait" affordance —
  // can force an immediate refresh without waiting on the interval.
  async refreshNow(): Promise<void> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const active = new Set(this.store.list().map((s) => s.name));
    // A removed remote's cache entry would otherwise linger forever —
    // refreshNow only ever touches peers currently in the store.
    for (const name of [...this.perPeer.keys()]) {
      if (!active.has(name)) {
        this.perPeer.delete(name);
      }
    }
    await Promise.allSettled(
      this.store.list().map(async (summary) => {
        const record = this.store.get(summary.name);
        if (!record) {
          return;
        }
        const prior = this.perPeer.get(summary.name);
        const scheme = isLoopbackHost(record.host) ? "http" : "https";
        const params = new URLSearchParams({ includeNonInteractive: "1" });
        const incremental = prior?.cursor !== undefined;
        if (incremental) {
          params.set("since", String(prior!.cursor));
        }
        const url = `${scheme}://${record.host}:${record.port}/v1/sessions?${params.toString()}`;
        let res: Response;
        try {
          res = await fetchImpl(url, {
            headers: { Authorization: `Bearer ${record.token}` },
          });
        } catch {
          return; // Unreachable this tick — leave the existing cache alone.
        }
        if (!res.ok) {
          return;
        }
        const body = (await res.json()) as {
          sessions?: Record<string, unknown>[];
          removed?: string[];
          cursor?: number;
        };
        const sessions = prior?.sessions ?? new Map<string, Record<string, unknown>>();
        if (incremental) {
          for (const [id, entry] of [...sessions]) {
            if (entry.status !== "cold") {
              sessions.delete(id);
            }
          }
          for (const localId of body.removed ?? []) {
            sessions.delete(formatForeignSessionId({ name: summary.name, localId }));
          }
        } else {
          sessions.clear();
        }
        for (const raw of body.sessions ?? []) {
          // Deliberately NOT excluding the peer's own dormant import
          // mirrors (importedFromMachine set, upstreamSessionId not)
          // here — this cache backs a general-purpose data surface
          // (GET /v1/sessions), and a local dormant mirror isn't
          // excluded from that same endpoint either. "Worth showing in
          // the picker/browser's default view" is a presentation
          // decision, made client-side (see filterByHost's remote:
          // branch), not a reason to make the data not exist.
          const foreignId = formatForeignSessionId({
            name: summary.name,
            localId: String(raw.sessionId),
          });
          sessions.set(foreignId, {
            ...raw,
            sessionId: foreignId,
            // Distinct from `importedFromMachine` on purpose — that
            // field marks a cold bundle-imported mirror and drives the
            // picker's/browser's "attach to pull this in locally"
            // prompt. This entry is live and stays live on the peer;
            // folding it into that same signal would trigger the
            // wrong client action on click. See core/peer-store.ts and
            // PROTOCOL.md's Sessions section for the addressing this
            // pairs with.
            remote: summary.name,
          });
        }
        this.perPeer.set(summary.name, { cursor: body.cursor, sessions });
      }),
    );
  }

  // Mirrors SessionManager's own includeRow rule for the
  // includeNonInteractive default (undefined/false interactive is
  // hidden unless the caller asked for everything) — a federated
  // session should observe the identical default a local one does.
  list(filters: {
    includeNonInteractive?: boolean;
    status?: "warm" | "cold";
  }): Record<string, unknown>[] {
    const all: Record<string, unknown>[] = [];
    for (const state of this.perPeer.values()) {
      all.push(...state.sessions.values());
    }
    return all.filter((entry) => {
      if (filters.status && entry.status !== filters.status) {
        return false;
      }
      if (!filters.includeNonInteractive && entry.interactive !== true) {
        return false;
      }
      return true;
    });
  }
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
