import * as os from "node:os";
import type { FastifyInstance } from "fastify";
import { expandHome } from "../../core/config.js";
import type { SessionManager } from "../../core/session-manager.js";
import { decodeBundle, encodeBundle } from "../../core/bundle.js";
import { bundleToMarkdown } from "../../core/transcript.js";
import { JsonRpcErrorCodes } from "../../acp/types.js";
import { HYDRA_VERSION } from "../../core/hydra-version.js";
import { isLoopbackHost } from "../../core/remote-url.js";
import { searchHistories } from "../../core/history-search.js";

export interface SessionRouteDefaults {
  agentId: string;
  cwd: string;
  // Externally-reachable name (and optional ":port") for this daemon,
  // stamped into exported bundles as exportedFrom.hydraHost so importers
  // can dial back. Resolution mirrors `hydra session share`: publicHost
  // wins; daemon.host is used when non-loopback; loopback is never
  // stamped (the field is omitted instead).
  publicHost?: string;
  host?: string;
  port?: number;
}

function resolveHydraHost(defaults: SessionRouteDefaults): string | undefined {
  if (defaults.publicHost && defaults.publicHost.length > 0) {
    return defaults.publicHost;
  }
  if (defaults.host && !isLoopbackHost(defaults.host)) {
    return defaults.port !== undefined
      ? `${defaults.host}:${defaults.port}`
      : defaults.host;
  }
  return undefined;
}

export function registerSessionRoutes(
  app: FastifyInstance,
  manager: SessionManager,
  defaults: SessionRouteDefaults,
): void {
  app.get("/v1/sessions", async (request) => {
    const query = request.query as { cwd?: string } | undefined;
    const sessions = await manager.list({ cwd: query?.cwd });
    return { sessions };
  });

  // Substring-search session transcripts. `q` is required; `sessionIds`
  // optionally scopes the scan to a comma-separated allowlist (the
  // picker passes its currently-visible rows so `o`/`h`/`/` filters
  // compose with the find scope). See core/history-search.ts for the
  // coverage rules (which update kinds and which tool fields are
  // scanned).
  app.get("/v1/sessions/search", async (request, reply) => {
    const query = request.query as
      | { q?: string; sessionIds?: string }
      | undefined;
    const q = query?.q ?? "";
    if (q.trim().length === 0) {
      reply.code(400).send({ error: "q is required" });
      return reply;
    }
    const ids = query?.sessionIds
      ? query.sessionIds.split(",").filter((s) => s.length > 0)
      : undefined;
    const out = await searchHistories(manager, q, { sessionIds: ids });
    return out;
  });

  app.post("/v1/sessions", async (request, reply) => {
    const body = (request.body ?? {}) as {
      cwd?: string;
      agentId?: string;
      mcpServers?: unknown[];
    };
    const cwd = expandHome(body.cwd ?? defaults.cwd);
    const agentId = body.agentId ?? defaults.agentId;
    try {
      const session = await manager.create({
        cwd,
        agentId,
        mcpServers: body.mcpServers,
      });
      reply.code(201).send({
        sessionId: session.sessionId,
        agentId: session.agentId,
        cwd: session.cwd,
      });
    } catch (err) {
      reply.code(500).send({ error: (err as Error).message });
    }
  });

  // Demote a live session to cold: close the in-memory session but keep
  // the on-disk record so it can be resurrected later. Idempotent — a
  // session that's already cold returns 204 without touching disk. Use
  // DELETE /v1/sessions/:id when you want the record gone too.
  app.post("/v1/sessions/:id/kill", async (request, reply) => {
    const raw = (request.params as { id: string }).id;
    const id = (await manager.resolveCanonicalId(raw)) ?? raw;
    const session = manager.get(id);
    if (session) {
      // Same posture as closeAll on shutdown: ask the agent for a final
      // title + synopsis before kill so the cold record carries the
      // freshest digest. 8s timeout matches the shutdown path — kill
      // should be snappy, but a few seconds of regen is the difference
      // between a useful cold record and a featureless one.
      await session.close({
        deleteRecord: false,
        regenSnapshot: true,
        regenSnapshotTimeoutMs: 8_000,
      });
      reply.code(204).send();
      return;
    }
    const exists = await manager.hasRecord(id);
    if (!exists) {
      reply.code(404).send({ error: "session not found" });
      return;
    }
    reply.code(204).send();
  });

  // Retitle a session. Body shape: { title: string } sets the title
  // directly; { regen: true } triggers the LLM-regen path (same as bare
  // /hydra title in the composer). Plain retitle works on live AND cold
  // sessions — cold just persists straight to meta.json. Regen still
  // requires a live session (no agent to talk to when cold) and 409s
  // otherwise. Empty/whitespace title without regen is rejected as 400.
  //
  // Regen is fire-and-forget: we accept the request, queue it on the
  // session's prompt queue, and respond 202 immediately so the picker
  // doesn't hang waiting for an in-flight turn to finish. The new title
  // surfaces on the next list/refresh once the regen completes.
  app.patch("/v1/sessions/:id", async (request, reply) => {
    const raw = (request.params as { id: string }).id;
    const id = (await manager.resolveCanonicalId(raw)) ?? raw;
    const body = (request.body ?? {}) as { title?: unknown; regen?: unknown };
    if (body.regen === true) {
      const session = manager.get(id);
      if (!session) {
        reply.code(409).send({ error: "regen requires a live session" });
        return;
      }
      void session.retitleFromAgent().catch((err) => {
        app.log.warn(
          `title regen failed for ${id}: ${(err as Error).message}`,
        );
      });
      reply.code(202).send();
      return;
    }
    if (typeof body.title !== "string" || body.title.trim().length === 0) {
      reply.code(400).send({ error: "title must be a non-empty string" });
      return;
    }
    const ok = await manager.setTitle(id, body.title);
    if (!ok) {
      reply.code(404).send({ error: "session not found" });
      return;
    }
    reply.code(204).send();
  });

  app.delete("/v1/sessions/:id", async (request, reply) => {
    const raw = (request.params as { id: string }).id;
    const id = (await manager.resolveCanonicalId(raw)) ?? raw;
    const session = manager.get(id);
    if (session) {
      await session.close({ deleteRecord: true });
      reply.code(204).send();
      return;
    }
    const removed = await manager.deleteRecord(id);
    if (!removed) {
      reply.code(404).send({ error: "session not found" });
      return;
    }
    reply.code(204).send();
  });

  // Export a session as a JSON bundle: meta + history + (optional)
  // prompt history. Recipients can import via POST /v1/sessions/import.
  // Resolves the bundle's lineageId lazily — pre-lineage records get
  // a fresh one persisted on export so subsequent re-exports stay
  // consistent. Filename in Content-Disposition uses the local id and
  // a UTC timestamp; consumers can rename freely.
  app.get("/v1/sessions/:id/export", async (request, reply) => {
    const raw = (request.params as { id: string }).id;
    const id = (await manager.resolveCanonicalId(raw)) ?? raw;
    const exported = await manager.exportBundle(id);
    if (!exported) {
      reply.code(404).send({ error: "session not found" });
      return;
    }
    const bundle = encodeBundle({
      record: exported.record,
      history: exported.history,
      promptHistory:
        exported.promptHistory.length > 0 ? exported.promptHistory : undefined,
      hydraVersion: HYDRA_VERSION,
      machine: os.hostname(),
      hydraHost: resolveHydraHost(defaults),
    });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    reply.header(
      "Content-Disposition",
      `attachment; filename="${id}-${stamp}.hydra"`,
    );
    reply.code(200).send(bundle);
  });

  // Render a session as a markdown transcript. Shares the bundle
  // assembly with /export and pipes the result through
  // bundleToMarkdown — the same function the CLI's file-path branch
  // calls locally — so output is byte-identical across surfaces.
  app.get("/v1/sessions/:id/transcript", async (request, reply) => {
    const raw = (request.params as { id: string }).id;
    const id = (await manager.resolveCanonicalId(raw)) ?? raw;
    const exported = await manager.exportBundle(id);
    if (!exported) {
      reply.code(404).send({ error: "session not found" });
      return;
    }
    const bundle = encodeBundle({
      record: exported.record,
      history: exported.history,
      promptHistory:
        exported.promptHistory.length > 0 ? exported.promptHistory : undefined,
      hydraVersion: HYDRA_VERSION,
      machine: os.hostname(),
      hydraHost: resolveHydraHost(defaults),
    });
    reply.header("Content-Type", "text/markdown; charset=utf-8");
    reply.code(200).send(bundleToMarkdown(bundle));
  });

  // Import a session bundle. Body shape: { bundle, replace? }. Without
  // replace, a lineageId clash with an existing local session returns
  // 409 BundleAlreadyImported citing the existing local id. With
  // replace:true, the existing local session is overwritten in-place
  // (its local id is preserved); any live in-memory copy is closed so
  // the next attach triggers the import-reseed path.
  // Branch an existing local session. Source can be live or cold. The
  // new session is minted with a fresh local sessionId + lineageId and
  // marked with forkedFromSessionId so list views can trace ancestry.
  // forkAt defaults to the source's most recent turn_complete; cwd
  // and agentId default to the source's. The new session carries
  // upstreamSessionId="" so its first attach triggers seedFromImport.
  app.post("/v1/sessions/:id/fork", async (request, reply) => {
    const raw = (request.params as { id: string }).id;
    const id = (await manager.resolveCanonicalId(raw)) ?? raw;
    const body = (request.body ?? {}) as {
      forkAt?: unknown;
      cwd?: unknown;
      agentId?: unknown;
    };
    const opts: { forkAt?: string; cwd?: string; agentId?: string } = {};
    if (body.forkAt !== undefined) {
      if (typeof body.forkAt !== "string" || body.forkAt.length === 0) {
        reply.code(400).send({ error: "forkAt must be a non-empty string" });
        return;
      }
      opts.forkAt = body.forkAt;
    }
    if (body.cwd !== undefined) {
      if (typeof body.cwd !== "string" || body.cwd.length === 0) {
        reply.code(400).send({ error: "cwd must be a non-empty string" });
        return;
      }
      opts.cwd = expandHome(body.cwd);
    }
    if (body.agentId !== undefined) {
      if (typeof body.agentId !== "string" || body.agentId.length === 0) {
        reply.code(400).send({ error: "agentId must be a non-empty string" });
        return;
      }
      opts.agentId = body.agentId;
    }
    try {
      const result = await manager.forkSession(id, opts);
      reply.code(201).send(result);
    } catch (err) {
      const e = err as Error & { code?: number };
      if (e.code === JsonRpcErrorCodes.SessionNotFound) {
        reply.code(404).send({ error: e.message });
        return;
      }
      if (
        e.code === JsonRpcErrorCodes.InvalidParams ||
        e.code === JsonRpcErrorCodes.AgentNotInstalled
      ) {
        reply.code(400).send({ error: e.message });
        return;
      }
      reply.code(500).send({ error: e.message });
    }
  });

  app.post("/v1/sessions/import", async (request, reply) => {
    const body = (request.body ?? {}) as {
      bundle?: unknown;
      replace?: boolean;
      cwd?: unknown;
    };
    if (body.bundle === undefined) {
      reply.code(400).send({ error: "missing bundle" });
      return;
    }
    let cwdOverride: string | undefined;
    if (body.cwd !== undefined) {
      if (typeof body.cwd !== "string" || body.cwd.length === 0) {
        reply.code(400).send({ error: "cwd must be a non-empty string" });
        return;
      }
      cwdOverride = body.cwd;
    }
    let bundle;
    try {
      bundle = decodeBundle(body.bundle);
    } catch (err) {
      reply.code(400).send({
        error: "invalid bundle",
        details: (err as Error).message,
      });
      return;
    }
    try {
      const result = await manager.importBundle(bundle, {
        replace: body.replace === true,
        ...(cwdOverride !== undefined ? { cwd: cwdOverride } : {}),
      });
      reply.code(201).send(result);
    } catch (err) {
      const e = err as Error & { code?: number; existingSessionId?: string };
      if (e.code === JsonRpcErrorCodes.BundleAlreadyImported) {
        reply.code(409).send({
          error: "bundle already imported",
          existingSessionId: e.existingSessionId,
        });
        return;
      }
      reply.code(500).send({ error: e.message });
    }
  });

  // Tail a session's recorded conversation as NDJSON (one entry per
  // line). One-shot by default; ?follow=1 keeps the connection open
  // and streams new entries as they're broadcast — useful for
  // external archivers (slack uploader, web export) that want the
  // canonical conversation stream without participating as an ACP
  // client. Snapshot state (model/mode/title/commands) lives on the
  // session record, not here; fetch it from GET /v1/sessions if
  // needed alongside.
  app.get("/v1/sessions/:id/history", async (request, reply) => {
    const raw = (request.params as { id: string }).id;
    const query = request.query as { follow?: string } | undefined;
    const follow = query?.follow === "1" || query?.follow === "true";
    const id = (await manager.resolveCanonicalId(raw)) ?? raw;

    const live = manager.get(id);
    // For follow mode against a live session, subscribe BEFORE reading
    // the snapshot so we don't lose entries that land during the
    // disk-read window. Buffer those into `pending` and flush after
    // the snapshot to preserve order; switch to direct emission once
    // we've drained.
    let snapshot: ReadonlyArray<unknown> | undefined;
    let unsubscribe: (() => void) | undefined;
    let snapshotDone = false;
    const pending: unknown[] = [];
    if (live) {
      if (follow) {
        unsubscribe = live.onBroadcast((entry) => {
          if (reply.raw.writableEnded) {
            return;
          }
          if (snapshotDone) {
            reply.raw.write(JSON.stringify(entry) + "\n");
          } else {
            pending.push(entry);
          }
        });
      }
      snapshot = await live.getHistorySnapshot();
    } else {
      const cold = await manager.getHistory(id);
      if (cold === undefined) {
        reply.code(404).send({ error: "session not found" });
        return reply;
      }
      snapshot = cold;
    }

    reply.raw.setHeader("Content-Type", "application/x-ndjson");
    reply.raw.setHeader("Cache-Control", "no-cache");
    reply.raw.statusCode = 200;
    const snapshotKeys = new Set<string>();
    for (const entry of snapshot ?? []) {
      reply.raw.write(JSON.stringify(entry) + "\n");
      const e = entry as { recordedAt?: number };
      if (typeof e.recordedAt === "number") {
        snapshotKeys.add(String(e.recordedAt));
      }
    }
    // Drain any entries that landed during the snapshot read window,
    // skipping ones already in the snapshot.
    for (const entry of pending) {
      const e = entry as { recordedAt?: number };
      const key = typeof e.recordedAt === "number" ? String(e.recordedAt) : "";
      if (key && snapshotKeys.has(key)) {
        continue;
      }
      reply.raw.write(JSON.stringify(entry) + "\n");
    }
    snapshotDone = true;

    if (!unsubscribe) {
      reply.raw.end();
      return reply;
    }

    // Follow mode against a live session — keep the connection open
    // until the client disconnects, then unsubscribe so the handler
    // doesn't keep firing for nobody.
    request.raw.on("close", () => {
      unsubscribe?.();
      if (!reply.raw.writableEnded) {
        reply.raw.end();
      }
    });
    return reply;
  });
}
