import * as os from "node:os";
import * as path from "node:path";
import type { FastifyInstance } from "fastify";
import { expandHome } from "../../core/config.js";
import type { SessionManager } from "../../core/session-manager.js";
import { decodeBundle, encodeBundle } from "../../core/bundle.js";
import { aggregateFileEdits, foldHunks } from "../../core/history-edits.js";
import {
  applyToolContentMode,
  parseToolContentMode,
} from "../../core/tool-content.js";
import { bundleToMarkdown } from "../../core/transcript.js";
import { JsonRpcErrorCodes } from "../../acp/types.js";
import { HYDRA_VERSION } from "../../core/hydra-version.js";
import { isLoopbackHost } from "../../core/remote-url.js";
import { searchHistories } from "../../core/history-search.js";
import { sweepNonInteractiveSessions } from "../../core/session-gc.js";

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
    const query = request.query as
      | { cwd?: string; includeNonInteractive?: string }
      | undefined;
    const includeNonInteractive =
      query?.includeNonInteractive === "1" ||
      query?.includeNonInteractive === "true";
    const sessions = await manager.list({
      cwd: query?.cwd,
      includeNonInteractive,
    });
    return { sessions };
  });

  // Single-session info — the same shape as one `GET /v1/sessions`
  // entry, looked up by id. Useful for callers that already know the
  // sessionId and just want its `_meta` (agentId, currentModel, busy,
  // status, etc.) without scanning the full list. The planner uses
  // this at project-create time to seed `board.orchestratorAgent` /
  // `orchestratorModel` so the status view can show the effective
  // agent/model immediately — before any new `session_info_update`
  // happens to fire.
  app.get("/v1/sessions/:id", async (request, reply) => {
    const raw = (request.params as { id: string }).id;
    const id = (await manager.resolveCanonicalId(raw)) ?? raw;
    const entries = await manager.list({ includeNonInteractive: true });
    const entry = entries.find((e) => e.sessionId === id);
    if (!entry) {
      reply.code(404).send({ error: "session not found" });
      return reply;
    }
    return entry;
  });

  // Substring-search session transcripts. `q` is required; `sessionIds`
  // optionally scopes the scan to an allowlist (the picker passes its
  // currently-visible rows so `o`/`h`/`/` filters compose with the
  // find scope). See core/history-search.ts for the coverage rules
  // (which update kinds and which tool fields are scanned).
  //
  // POST rather than GET because the picker passes every visible
  // session id and that allowlist can run thousands of entries on
  // long-lived installs — well past the header size limit when
  // serialized in a query string (HTTP 431).
  app.post("/v1/sessions/search", async (request, reply) => {
    const body = (request.body ?? {}) as {
      q?: unknown;
      sessionIds?: unknown;
    };
    const q = typeof body.q === "string" ? body.q : "";
    if (q.trim().length === 0) {
      reply.code(400).send({ error: "q is required" });
      return reply;
    }
    const ids = Array.isArray(body.sessionIds)
      ? body.sessionIds.filter((s): s is string => typeof s === "string" && s.length > 0)
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

  // On-demand sweep of non-interactive cold session records. Mirrors
  // what the background GC does, but driven by the user via
  // `hydra sessions collect`. Body lets the caller override the daemon
  // config defaults: `maxAgeDays` (0 / unset → "any age"), `limit`
  // (per-call deletion cap; default 1000 — generous since the CLI is
  // interactive and the daemon is the one doing the work).
  app.post("/v1/sessions/collect", async (request, reply) => {
    const body = (request.body ?? {}) as {
      maxAgeDays?: number;
      limit?: number;
      selection?: "explicit" | "unpromoted";
    };
    const maxAgeMs =
      typeof body.maxAgeDays === "number" && body.maxAgeDays > 0
        ? body.maxAgeDays * 24 * 60 * 60 * 1_000
        : 0;
    const maxDeletions =
      typeof body.limit === "number" && body.limit > 0 ? body.limit : 1000;
    const selection =
      body.selection === "explicit" || body.selection === "unpromoted"
        ? body.selection
        : "unpromoted";
    try {
      const result = await sweepNonInteractiveSessions({
        manager,
        maxAgeMs,
        maxDeletions,
        selection,
        verbose: false,
      });
      reply.code(200).send(result);
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
      // Fire-and-forget kill. Agent dies immediately; the synopsis is
      // regenerated out-of-band by the synopsis coordinator (scheduled
      // by SessionManager's onClose hook). 202 returns to the caller as
      // soon as the close starts; the actual agent teardown takes <1s.
      void session.close({ deleteRecord: false }).catch(() => undefined);
      reply.code(202).send();
      return;
    }
    const exists = await manager.hasRecord(id);
    if (!exists) {
      reply.code(404).send({ error: "session not found" });
      return;
    }
    reply.code(204).send();
  });

  // Producer side of `hydra cat --stream`: feed piped stdin into a live
  // session's in-memory ring, which the agent reads through the
  // `hydra-acp-stdin` MCP server. `open` sizes the ring; `POST /stdin`
  // appends a base64 chunk (and optionally marks EOF).
  app.post("/v1/sessions/:id/stdin/open", async (request, reply) => {
    const raw = (request.params as { id: string }).id;
    const id = (await manager.resolveCanonicalId(raw)) ?? raw;
    const session = manager.get(id);
    if (!session) {
      reply.code(404).send({ error: "session not found" });
      return reply;
    }
    const body = (request.body ?? {}) as {
      mode?: unknown;
      capacityBytes?: unknown;
      fileCapBytes?: unknown;
    };
    const openOpts: Parameters<typeof session.openStream>[0] = {};
    if (body.mode === "memory" || body.mode === "file") {
      openOpts.mode = body.mode;
    }
    if (typeof body.capacityBytes === "number") {
      openOpts.capacityBytes = body.capacityBytes;
    }
    if (typeof body.fileCapBytes === "number") {
      openOpts.fileCapBytes = body.fileCapBytes;
    }
    if ((openOpts.mode ?? "memory") === "file") {
      openOpts.filePathFor = (sid) =>
        path.join(os.tmpdir(), `hydra-acp-stdin-${sid}.log`);
    }
    try {
      return session.openStream(openOpts);
    } catch (err) {
      reply.code(409).send({ error: (err as Error).message });
      return reply;
    }
  });

  app.post("/v1/sessions/:id/stdin", async (request, reply) => {
    const raw = (request.params as { id: string }).id;
    const id = (await manager.resolveCanonicalId(raw)) ?? raw;
    const session = manager.get(id);
    if (!session) {
      reply.code(404).send({ error: "session not found" });
      return reply;
    }
    const body = (request.body ?? {}) as { chunk?: unknown; eof?: unknown };
    const chunk = typeof body.chunk === "string" ? body.chunk : "";
    const eof = body.eof === true;
    try {
      return session.streamWrite(chunk, eof);
    } catch (err) {
      reply.code(409).send({ error: (err as Error).message });
      return reply;
    }
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
    const body = (request.body ?? {}) as {
      title?: unknown;
      regen?: unknown;
      priority?: unknown;
    };
    if (body.priority !== undefined) {
      // Accept any non-negative integer; 0 / null clears. Reject other
      // shapes so a typo doesn't silently no-op.
      const raw = body.priority;
      let next: number | undefined;
      if (raw === null || raw === 0) {
        next = undefined;
      } else if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) {
        next = raw;
      } else {
        reply.code(400).send({
          error: "priority must be a non-negative integer (or null to clear)",
        });
        return;
      }
      const ok = await manager.setPriority(id, next);
      if (!ok) {
        reply.code(404).send({ error: "session not found" });
        return;
      }
      reply.code(204).send();
      return;
    }
    if (body.regen === true) {
      // Picker T and /hydra title (no arg) both land here. The synopsis
      // coordinator handles live and cold sessions uniformly: live agents
      // are kept alive; the ephemeral synopsis agent runs in parallel
      // from the cold record + history.jsonl. Return 202 immediately.
      const exists = manager.get(id) !== undefined || (await manager.hasRecord(id));
      if (!exists) {
        reply.code(404).send({ error: "session not found" });
        return;
      }
      manager.scheduleSynopsis(id);
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
    // `?tools=` shapes tool payload in the bundle:
    //   inline (default) — byte-for-byte the recorded history.
    //   references       — ref-form history + deduped, gzipped toolBlobs
    //                      (complete + compact backup; archiver uses this).
    //   summary          — shed bodies entirely (smallest, lossy).
    const toolsRaw = (request.query as { tools?: unknown } | undefined)?.tools;
    const toolMode =
      toolsRaw === "references"
        ? "references"
        : parseToolContentMode(toolsRaw);
    const exported = await manager.exportBundle(
      id,
      toolMode === "references" ? { tools: "references" } : {},
    );
    if (!exported) {
      reply.code(404).send({ error: "session not found" });
      return;
    }
    const bundle = encodeBundle({
      record: exported.record,
      history:
        toolMode === "summary"
          ? applyToolContentMode(exported.history, "summary")
          : exported.history,
      promptHistory:
        exported.promptHistory.length > 0 ? exported.promptHistory : undefined,
      ...(exported.toolBlobs !== undefined
        ? { toolBlobs: exported.toolBlobs }
        : {}),
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

  // Reconstructed per-file diff for a session — the same aggregation
  // `hydra session diff --json` runs client-side, but server-side so
  // other consumers (e.g. the planner's verified_diff audit) can fetch
  // a ready-made shape with a single HTTP call instead of pulling the
  // full export and redoing the walk. Output shape matches the CLI's
  // --json output exactly: an array of { path, hunks: [...], created }.
  //
  // Query params:
  //   ?fold=true       — collapse sequential hunks that rewrite the
  //                      same region into one net-effect hunk (same
  //                      semantics as the CLI's --fold flag).
  //   ?paths=a,b,c     — filter results to only the listed paths.
  //                      Order is preserved from the aggregation.
  app.get("/v1/sessions/:id/diff", async (request, reply) => {
    const raw = (request.params as { id: string }).id;
    const id = (await manager.resolveCanonicalId(raw)) ?? raw;
    const exported = await manager.exportBundle(id);
    if (!exported) {
      reply.code(404).send({ error: "session not found" });
      return;
    }
    const query = (request.query as
      | { fold?: string; paths?: string }
      | undefined) ?? {};
    const fold = query.fold === "true" || query.fold === "1";
    const pathFilter =
      typeof query.paths === "string" && query.paths.length > 0
        ? new Set(query.paths.split(",").map((p) => p.trim()).filter((p) => p.length > 0))
        : undefined;
    let files = aggregateFileEdits(exported.history as unknown as Parameters<typeof aggregateFileEdits>[0]);
    if (pathFilter) {
      files = files.filter((f) => pathFilter.has(f.path));
    }
    if (fold) {
      files = files.map((f) => ({ ...f, hunks: foldHunks(f.hunks) }));
    }
    reply.code(200).send(files);
  });

  // Fetch a single externalized tool-content blob by its sha256. Used by
  // clients attached in `tools: "references"` mode to lazily pull a diff /
  // stdout body when the user expands it. Content-addressed, so the body is
  // immutable for a given hash.
  app.get("/v1/sessions/:id/tools/:hash", async (request, reply) => {
    const params = request.params as { id: string; hash: string };
    const id = (await manager.resolveCanonicalId(params.id)) ?? params.id;
    const blob = await manager.loadToolBlob(id, params.hash);
    if (blob === null) {
      reply.code(404).send({ error: "tool blob not found" });
      return;
    }
    reply.header("Content-Type", "text/plain; charset=utf-8");
    reply.code(200).send(blob);
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
      title?: unknown;
    };
    const opts: {
      forkAt?: string;
      cwd?: string;
      agentId?: string;
      title?: string;
    } = {};
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
    if (body.title !== undefined) {
      if (typeof body.title !== "string") {
        reply.code(400).send({ error: "title must be a string" });
        return;
      }
      opts.title = body.title;
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
    // Bound the bridge buffer so a chatty session during the snapshot
    // read window can't grow it unboundedly. Drop oldest on overflow —
    // those entries should also appear in the snapshot most of the time
    // (we de-dupe by recordedAt below).
    const PENDING_MAX = 10_000;
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
            if (pending.length > PENDING_MAX) {
              pending.shift();
            }
          }
        });
      }
      try {
        snapshot = await live.getHistorySnapshot();
      } catch (err) {
        unsubscribe?.();
        throw err;
      }
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
