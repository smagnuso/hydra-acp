import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import type { FastifyInstance } from "fastify";
import { paths } from "../../core/paths.js";
import { expandHome, type CompactionConfig } from "../../core/config.js";
import { shouldCompactSession, estimateTokens } from "../../core/compaction-heuristic.js";
import type { SessionManager } from "../../core/session-manager.js";
import type { HistoryEntry as HistoryStoreEntry } from "../../core/history-store.js";
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
import type { AttentionFlag } from "../../acp/types-attention.js";
import { searchHistories } from "../../core/history-search.js";
import { sweepNonInteractiveSessions } from "../../core/session-gc.js";
import {
  mintExtensionMcpDescriptors,
  type ExtensionMcpMintDeps,
} from "../extension-mcp-mint.js";

// The public wire contract for GET /v1/sessions/:id/events and
// GET /v1/sessions/events. Additive only — new kinds may be added
// without a version bump; removing or renaming entries requires one.
const QUERYABLE_EVENT_KINDS = new Set([
  "usage_update",
  "tool_call",
  "tool_call_update",
  "prompt_received",
  "turn_complete",
  "permission_resolved",
]);

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
  // Compaction heuristic config used by the GET /compact/status endpoint to
  // compute shouldCompact for clients deciding whether to surface a compaction prompt.
  compaction?: CompactionConfig;
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
  // Optional. When provided, POST /v1/sessions augments the new
  // session's mcpServers with HTTP descriptors for every
  // currently-registered extension MCP server, mirroring what the ACP
  // WS session/new handler does. Sessions created via the REST surface
  // (Slack `!session`, browser, etc.) need this or their agent's tool
  // registry comes up empty — no `set_plan`, no planner tools at all.
  extMcpDeps: ExtensionMcpMintDeps = {},
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
    const entry = await manager.getOne(id);
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
    // Mirror the ACP WS session/new path: mint one per-session token
    // covering every currently-registered extension MCP server and
    // append the resulting HTTP descriptors to the agent's mcpServers
    // list. Without this, REST-initiated sessions (Slack `!session`,
    // browser, …) come up without planner/extension tools.
    const extMcpMint = mintExtensionMcpDescriptors(extMcpDeps);
    const mcpServers =
      extMcpMint !== undefined
        ? [...(body.mcpServers ?? []), ...extMcpMint.descriptors]
        : body.mcpServers;
    try {
      const session = await manager.create({
        cwd,
        agentId,
        mcpServers,
      });
      if (extMcpMint !== undefined) {
        extMcpMint.bindToSession(session);
      }
      reply.code(201).send({
        sessionId: session.sessionId,
        agentId: session.agentId,
        cwd: session.cwd,
      });
    } catch (err) {
      if (extMcpMint !== undefined) {
        extMcpMint.abandon(err instanceof Error ? err : undefined);
      }
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

  // Demote a warm session to cold: close the in-memory session but keep
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
  // requires a warm session (no agent to talk to when cold) and 409s
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
      // coordinator handles warm and cold sessions uniformly: warm agents
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
      await manager.waitForDeletion(id);
      // Safety net: if the live close raced an earlier markClosed (e.g.
      // agent.onExit fired before our DELETE landed), the deleteRecord
      // intent may not have produced a pendingDeletion chain. Fall
      // through to the cold-record delete so the on-disk record is
      // guaranteed gone before we 204.
      if (await manager.hasRecord(id)) {
        await manager.deleteRecord(id);
      }
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
      mode?: unknown;
      model?: unknown;
    };
    const opts: {
      forkAt?: string;
      cwd?: string;
      agentId?: string;
      title?: string;
      mode?: "verbatim" | "synthesis";
      model?: string;
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
    if (body.mode !== undefined) {
      if (body.mode !== "verbatim" && body.mode !== "synthesis") {
        reply.code(400).send({ error: "mode must be \"verbatim\" or \"synthesis\"" });
        return;
      }
      opts.mode = body.mode;
    }
    if (body.model !== undefined) {
      if (typeof body.model !== "string" || body.model.length === 0) {
        reply.code(400).send({ error: "model must be a non-empty string" });
        return;
      }
      opts.model = body.model;
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

  // Compaction state — current watermark + the daemon-computed
  // shouldCompact boolean so callers can decide whether to prompt the
  // user. Read-only; does not schedule any work. POST /compact is the
  // separate endpoint that actually starts a compaction.
  app.get("/v1/sessions/:id/compact/status", async (request, reply) => {
    const raw = (request.params as { id: string }).id;
    const id = (await manager.resolveCanonicalId(raw)) ?? raw;
    const session = manager.get(id);
    let summarizedThroughEntry: number | undefined;
    if (session) {
      summarizedThroughEntry = session.summarizedThroughEntry;
    } else {
      summarizedThroughEntry = await manager.getSummarizedThroughEntry(id);
    }
    if (summarizedThroughEntry === undefined && !(await manager.hasRecord(id))) {
      reply.code(404).send({ error: "session not found" });
      return reply;
    }
    // synopsisCoordinator.size() is global; if any compaction is
    // in flight or queued session-wide, report inFlight=true.
    const compactionState = await manager.getCompactionState(id);
    const rollbackBreadcrumb = await manager.getRollbackBreadcrumb(id);

    // Compute shouldCompact for clients deciding whether to surface a compaction prompt.
    let shouldCompact = false;
    let approxTokens: number | undefined;
    const rawHistory = await manager.getHistory(id).catch(() => [] as HistoryStoreEntry[]);
    const history = rawHistory ?? [];
    if (history.length > 0 && defaults.compaction) {
      const summarized = summarizedThroughEntry ?? 0;
      const totalEntries = history.length;
      const unsummarizedLines = history.slice(summarized);
      // Use a rough char estimate from the raw line lengths stored in
      // history.jsonl (each line is a JSON stringified entry).
      const unsummarizedChars = unsummarizedLines.reduce(
        (sum, entry) => sum + JSON.stringify(entry.params).length,
        0,
      );
      approxTokens = estimateTokens(unsummarizedChars);
      const currentModel = session?.currentModel;
      const lastActivityMs = history.at(-1)!.recordedAt;
      // Pull authoritative usage from the warm session if attached.
      // The heuristic prefers these over the char-estimate so utilization
      // matches what the status bar shows the user.
      const usage = session?.currentUsage;
      shouldCompact = shouldCompactSession({
        summarizedThroughEntry: summarized,
        totalEntries,
        unsummarizedChars,
        compactionInFlight: manager.getCompactionInFlight(),
        currentModel,
        lastActivityMs,
        nowMs: Date.now(),
        config: defaults.compaction as unknown as import("../../core/compaction-heuristic.js").CompactionHeuristicConfig,
        ...(typeof usage?.used === "number" ? { agentReportedUsed: usage.used } : {}),
        ...(typeof usage?.size === "number" ? { agentReportedSize: usage.size } : {}),
      });
    }

    return {
      summarizedThroughEntry: summarizedThroughEntry ?? undefined,
      inFlight: manager.getCompactionInFlight(),
      shouldCompact,
      ...(approxTokens != null ? { approxTokens } : {}),
      ...(compactionState != null ? { compactionState } : {}),
      ...(rollbackBreadcrumb != null ? { rollbackBreadcrumb } : {}),
    };
  });

  // Trigger compaction on a session. Fire-and-forget: returns 202
  // immediately and the synopsis coordinator runs the compaction
  // asynchronously (it may defer if the session is non-quiesced).
  app.post("/v1/sessions/:id/compact", async (request, reply) => {
    const raw = (request.params as { id: string }).id;
    const id = (await manager.resolveCanonicalId(raw)) ?? raw;
    const session = manager.get(id);
    if (session) {
      manager.scheduleCompaction(id);
      reply.code(202).send({ scheduled: true });
      return;
    }
    const exists = await manager.hasRecord(id);
    if (!exists) {
      reply.code(404).send({ error: "session not found" });
      return;
    }
    // Cold session — still schedule (coordinator reads from disk).
    manager.scheduleCompaction(id);
    reply.code(202).send({ scheduled: true });
  });

  // Roll back the most recent compaction swap on a session. Only
  // succeeds when a rollback breadcrumb exists and the session is
  // quiesced with no new turns since the swap. Returns 202 on success,
  // 404 for unknown sessions, 409 for guard failures.
  app.post("/v1/sessions/:id/compact/rollback", async (request, reply) => {
    const raw = (request.params as { id: string }).id;
    const id = (await manager.resolveCanonicalId(raw)) ?? raw;
    if (!(await manager.hasRecord(id))) {
      reply.code(404).send({ error: "session not found" });
      return;
    }
    try {
      await manager.performUncompact(id);
      reply.code(202).send({ rolledBack: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      reply.code(409).send({ error: message });
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
    // For follow mode against a warm session, subscribe BEFORE reading
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
      request.raw.on("close", () => {
        unsubscribe?.();
        if (!reply.raw.writableEnded) {
          reply.raw.end();
        }
      });
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
    // skipping ones already in the snapshot. Loop until pending is
    // empty so entries that arrive during the drain are also flushed
    // before we flip snapshotDone and switch to direct emission.
    while (pending.length > 0) {
      const batch = pending.splice(0, pending.length);
      for (const entry of batch) {
        const e = entry as { recordedAt?: number };
        const key = typeof e.recordedAt === "number" ? String(e.recordedAt) : "";
        if (key && snapshotKeys.has(key)) {
          continue;
        }
        reply.raw.write(JSON.stringify(entry) + "\n");
      }
    }
    snapshotDone = true;

    if (!unsubscribe) {
      reply.raw.end();
      return reply;
    }

    // Follow mode against a warm session — keep the connection open
    // until the client disconnects. The on('close') handler that
    // unsubscribes was registered earlier (before the snapshot await)
    // so an abort during the snapshot phase also cleans up.
    return reply;
  });

  // Parse one line from a history.jsonl file and return structured event data
  // if it matches the kind allowlist and since boundary, or null otherwise.
  // The caller must supply the same `kindSet` and `sinceMs` used for validation.
  function parseHistoryLine(
    line: string,
    kindSet: Set<string>,
    sinceMs: number | undefined,
  ): { recordedAt: number; entry: Record<string, unknown> } | null {
    const trimmed = typeof line === "string" ? line.trim() : "";
    if (trimmed.length === 0) {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      console.debug("events endpoint: skipping malformed JSONL line");
      return null;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.debug("events endpoint: skipping non-object JSONL line");
      return null;
    }
    const entry = parsed as { method?: string; params?: unknown; recordedAt?: number };
    if (typeof entry.recordedAt !== "number") {
      return null;
    }
    if (sinceMs !== undefined && entry.recordedAt < sinceMs) {
      return null;
    }
    if (typeof entry.params !== "object" || entry.params === null || Array.isArray(entry.params)) {
      return null;
    }
    const params = entry.params as Record<string, unknown>;
    if (typeof params.update !== "object" || params.update === null || Array.isArray(params.update)) {
      return null;
    }
    const updateObj = params.update as Record<string, unknown>;
    const kind = updateObj.sessionUpdate;
    if (typeof kind !== "string") {
      return null;
    }
    if (!kindSet.has(kind)) {
      return null;
    }
    return {
      recordedAt: entry.recordedAt,
      entry: parsed as Record<string, unknown>,
    };
  }

  // Build the output row for a cross-session event (includes sessionId).
  function buildCrossSessionRow(
    sessionId: string,
    entry: Record<string, unknown>,
    kind: string,
  ): Record<string, unknown> {
    const params = entry.params as Record<string, unknown>;
    const updateObj = params.update as Record<string, unknown>;
    const row: Record<string, unknown> = {
      sessionId,
      ts: new Date(entry.recordedAt as number).toISOString(),
      kind,
      update: updateObj,
    };
    if (updateObj.messageId !== undefined && updateObj.messageId !== null) {
      row.messageId = updateObj.messageId;
    }
    return row;
  }

  // K-way merge iterator state for cross-session events.
  //
  // Each iterator owns one async generator over its session's history.jsonl
  // that yields only matching parsed lines. We deliberately do NOT use two
  // separate `for await` blocks on the same readline.Interface — breaking
  // out of `for await` calls the async iterator's `return()` method, which
  // closes the readline. A subsequent `for await` on the same `rl` yields
  // nothing, which silently truncated the cross-session stream (each
  // session emitted at most its first matching event).
  interface SessionIterator {
    sessionId: string;
    rl: readline.Interface;
    gen: AsyncGenerator<{ ts: number; row: Record<string, unknown> }, void, undefined>;
    current: { ts: number; row: Record<string, unknown> } | null;
    exhausted: boolean;
  }

  async function* matchingEvents(
    sessionId: string,
    rl: readline.Interface,
    kindSet: Set<string>,
    sinceMs: number | undefined,
  ): AsyncGenerator<{ ts: number; row: Record<string, unknown> }, void, undefined> {
    for await (const line of rl) {
      const parsed = parseHistoryLine(line, kindSet, sinceMs);
      if (parsed) {
        const kind = ((parsed.entry.params as Record<string, unknown>)
          .update as Record<string, unknown>).sessionUpdate as string;
        yield { ts: parsed.recordedAt, row: buildCrossSessionRow(sessionId, parsed.entry, kind) };
      }
    }
  }

  async function initIterator(
    sessionId: string,
    historyPath: string,
    kindSet: Set<string>,
    sinceMs: number | undefined,
  ): Promise<SessionIterator> {
    const rl = readline.createInterface({ input: fs.createReadStream(historyPath), crlfDelay: Infinity });
    const gen = matchingEvents(sessionId, rl, kindSet, sinceMs);
    const first = await gen.next();
    const current = first.done ? null : first.value;
    return { sessionId, rl, gen, current, exhausted: current === null };
  }

  async function advanceIterator(it: SessionIterator): Promise<void> {
    const next = await it.gen.next();
    if (next.done) {
      it.exhausted = true;
      it.current = null;
    } else {
      it.current = next.value;
    }
  }

 // Stream selected session/update kinds from every session's history.jsonl,
  // interleaved by ts ascending (k-way merge). `kinds` is required and
  // validated against QUERYABLE_EVENT_KINDS. `since` is an optional ISO-8601
  // lower bound on recordedAt. Sessions whose updatedAt falls before `since`
  // are pre-filtered out so their history.jsonl is never opened. Each emitted
  // row carries a `sessionId` field alongside the standard shape. Streams via
  // Content-Type: application/x-ndjson.

  app.get<{ Querystring: { kinds?: string; since?: string } }>(
    "/v1/sessions/events",
    async (request, reply) => {
      const query = request.query as { kinds?: string; since?: string };

      const kindsParam = query.kinds;
      if (!kindsParam || kindsParam.trim().length === 0) {
        reply.code(400).send({ error: "kinds parameter is required" });
        return reply;
      }

      const requestedKinds = kindsParam.split(",").map((k) => k.trim());
      if (requestedKinds.length === 0) {
        reply.code(400).send({ error: "kinds parameter is required" });
        return reply;
      }

      for (const kind of requestedKinds) {
        if (!QUERYABLE_EVENT_KINDS.has(kind)) {
          reply.code(400).send({
            error: `kind "${kind}" is not queryable; allowed kinds: ${[...QUERYABLE_EVENT_KINDS].join(", ")}`,
          });
          return reply;
        }
      }

      const kindSet = new Set(requestedKinds);
      let sinceMs: number | undefined;
      if (query.since !== undefined && query.since.trim().length > 0) {
        const parsed = new Date(query.since);
        if (isNaN(parsed.getTime())) {
          reply.code(400).send({ error: "since is not a valid ISO-8601 timestamp" });
          return reply;
        }
        sinceMs = parsed.getTime();
      }

      // Pre-filter sessions by updatedAt to avoid opening history.jsonl
      // for sessions that definitely have no matching events.
      const allSessions = await manager.list({ includeNonInteractive: true });
      const survivingSessions =
        sinceMs !== undefined
          ? allSessions.filter((s) => new Date(s.updatedAt).getTime() >= sinceMs)
          : allSessions;

      reply.raw.setHeader("content-type", "application/x-ndjson");
      reply.raw.statusCode = 200;

      // Init iterators: each reads the first matching line from its session.
      const iterators: SessionIterator[] = [];
      for (const session of survivingSessions) {
        try {
          const historyPath = paths.historyFile(session.sessionId);
          const it = await initIterator(session.sessionId, historyPath, kindSet, sinceMs);
          if (!it.exhausted) {
            iterators.push(it);
          }
        } catch (err) {
          const e = err as NodeJS.ErrnoException;
          if (e.code === "ENOENT") {
            continue;
          }
          throw err;
        }
      }

      // Handle client disconnect — abort all open file streams.
      request.raw.on("close", () => {
        for (const it of iterators) {
          try {
            it.rl.close();
          } catch {
            /* ignore */
          }
        }
        if (!reply.raw.writableEnded) {
          reply.raw.end();
        }
      });

      // K-way merge: pick the smallest ts, emit, advance that iterator.
      try {
        while (iterators.length > 0) {
          let minIdx = -1;
          let minTs = Infinity;
          for (let i = 0; i < iterators.length; i++) {
            const it = iterators[i]!;
            if (it.current !== null && it.current.ts < minTs) {
              minTs = it.current.ts;
              minIdx = i;
            }
          }

          if (minIdx === -1) break;
          const chosen = iterators[minIdx]!;

          reply.raw.write(JSON.stringify(chosen.current!.row) + "\n");

          await advanceIterator(chosen);

          if (chosen.exhausted) {
            try {
              chosen.rl.close();
            } catch {
              /* ignore */
            }
            iterators.splice(minIdx, 1);
          }
        }
      } catch (err) {
        for (const it of iterators) {
          try {
            it.rl.close();
          } catch {
            /* ignore */
          }
        }
        throw err;
      }

      reply.raw.end();
      return reply;
    },
  );

  app.get<{ Params: { id: string }; Querystring: { kinds?: string; since?: string } }>(
    "/v1/sessions/:id/events",
    async (request, reply) => {
      const raw = (request.params as { id: string }).id;
      const query = request.query as { kinds?: string; since?: string };
      const id = (await manager.resolveCanonicalId(raw)) ?? raw;

      const session = manager.get(id);
      if (!session) {
        const exists = await manager.hasRecord(id);
        if (!exists) {
          reply.code(404).send({ error: "session not found" });
          return reply;
        }
      }

      const kindsParam = query.kinds;
      if (!kindsParam || kindsParam.trim().length === 0) {
        reply.code(400).send({ error: "kinds parameter is required" });
        return reply;
      }

      const requestedKinds = kindsParam.split(",").map((k) => k.trim());
      if (requestedKinds.length === 0) {
        reply.code(400).send({ error: "kinds parameter is required" });
        return reply;
      }

      for (const kind of requestedKinds) {
        if (!QUERYABLE_EVENT_KINDS.has(kind)) {
          reply.code(400).send({
            error: `kind "${kind}" is not queryable; allowed kinds: ${[...QUERYABLE_EVENT_KINDS].join(", ")}`,
          });
          return reply;
        }
      }

      const kindSet = new Set(requestedKinds);
      let sinceMs: number | undefined;
      if (query.since !== undefined && query.since.trim().length > 0) {
        const parsed = new Date(query.since);
        if (isNaN(parsed.getTime())) {
          reply.code(400).send({ error: "since is not a valid ISO-8601 timestamp" });
          return reply;
        }
        sinceMs = parsed.getTime();
      }

      const historyPath = paths.historyFile(id);
      const fileStream = fs.createReadStream(historyPath);
      const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

      reply.raw.setHeader("content-type", "application/x-ndjson");
      reply.raw.statusCode = 200;

      try {
        for await (const line of rl) {
        const trimmed = typeof line === "string" ? line.trim() : "";
        if (trimmed.length === 0) {
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          console.debug("events endpoint: skipping malformed JSONL line in %s", historyPath);
          continue;
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          console.debug("events endpoint: skipping non-object JSONL line in %s", historyPath);
          continue;
        }
        const entry = parsed as { method?: string; params?: unknown; recordedAt?: number };
        if (typeof entry.recordedAt !== "number") {
          continue;
        }
        if (typeof entry.params !== "object" || entry.params === null || Array.isArray(entry.params)) {
          continue;
        }
        const params = entry.params as Record<string, unknown>;
        if (typeof params.update !== "object" || params.update === null || Array.isArray(params.update)) {
          continue;
        }
        const updateObj = params.update as Record<string, unknown>;
        const kind = updateObj.sessionUpdate;
        if (typeof kind !== "string") {
          continue;
        }
        if (!kindSet.has(kind)) {
          continue;
        }
        if (sinceMs !== undefined && entry.recordedAt < sinceMs) {
          continue;
        }
        const output: Record<string, unknown> = {
          ts: new Date(entry.recordedAt).toISOString(),
          kind,
          update: updateObj,
        };
        if (updateObj.messageId !== undefined && updateObj.messageId !== null) {
          output.messageId = updateObj.messageId;
        }
        reply.raw.write(JSON.stringify(output) + "\n");
      }
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === "ENOENT") {
          reply.raw.end();
          return reply;
        }
        throw err;
      }

      reply.raw.end();
      return reply;
    },
  );

  // GET /v1/sessions/:id/attention — return the attention flags for a
  // single session. 404 when the session is unknown.
  app.get<{ Params: { id: string } }>("/v1/sessions/:id/attention", async (request, reply) => {
    const raw = (request.params as { id: string }).id;
    const id = (await manager.resolveCanonicalId(raw)) ?? raw;
    const session = manager.get(id);
    if (!session && !(await manager.hasRecord(id))) {
      reply.code(404).send({ error: "session not found" });
      return reply;
    }
    if (session) {
      return { flags: session.listAttentionFlags() };
    }
    // Cold session — read flags from the persisted record.
    const store = (manager as unknown as { store: import("../../core/session-store.js").SessionStore }).store;
    const record = await store.read(id);
    const flags = record?.attentionFlags ?? [];
    return { flags };
  });

  // GET /v1/sessions/attention?source=<name> — return attention flags
  // from ALL sessions (warm + cold) whose source matches the query
  // parameter. Each entry includes sessionId alongside the standard
  // AttentionFlag shape.
  app.get<{ Querystring: { source?: string } }>("/v1/sessions/attention", async (request, reply) => {
    const query = request.query as { source?: string };
    if (!query.source || query.source.trim().length === 0) {
      reply.code(400).send({ error: "source query parameter is required" });
      return reply;
    }
    const allSessions = await manager.list({ includeNonInteractive: true });
    const results: Array<AttentionFlag & { sessionId: string }> = [];
    for (const sess of allSessions) {
      const live = manager.get(sess.sessionId);
      let flags: AttentionFlag[];
      if (live) {
        flags = live.listAttentionFlags();
      } else {
        // Cold session — read from the persisted store.
        const store = (manager as unknown as { store: import("../../core/session-store.js").SessionStore }).store;
        const record = await store.read(sess.sessionId);
        flags = record?.attentionFlags ?? [];
      }
      for (const flag of flags) {
        if (flag.source === query.source) {
          results.push({ ...flag, sessionId: sess.sessionId });
        }
      }
    }
    return { flags: results };
  });

  // POST /v1/sessions/:id/attention/clear — clear attention flags on a
  // session. Body `{source, reason}` clears exactly that flag; body `{}`
  // clears all flags. For warm sessions this uses the in-memory mutation
  // path (which broadcasts to attached clients). For cold sessions it
  // reads the persisted record, mutates the flags array, and writes back
  // through mutateRecord so the change survives a daemon restart.
  app.post<{ Params: { id: string } }>("/v1/sessions/:id/attention/clear", async (request, reply) => {
    const raw = (request.params as { id: string }).id;
    const id = (await manager.resolveCanonicalId(raw)) ?? raw;
    const body = request.body as Record<string, unknown> | undefined;
    const parsed = (body ?? {}) as { source?: unknown; reason?: unknown };

    // Determine clear mode. Both source and reason must be non-empty strings
    // to clear a specific flag; otherwise the body must be {} to clear all.
    const src = typeof parsed.source === "string" ? parsed.source : "";
    const rsn = typeof parsed.reason === "string" ? parsed.reason : "";
    if ((src.length > 0 || rsn.length > 0) && !(src.length > 0 && rsn.length > 0)) {
      reply.code(400).send({ error: "both source and reason are required to clear a specific flag, or omit both to clear all" });
      return;
    }
    if (src.length === 0 && rsn.length === 0) {
      // body is {} — will clear all flags.
    }

    const session = manager.get(id);
    if (session) {
      if (src.length > 0 && rsn.length > 0) {
        session.clearAttentionFlag(src, rsn);
      } else {
        // Clear all flags by iterating a snapshot of keys.
        const keys = Array.from(session.listAttentionFlags()).map((f) => `${f.source}::${f.reason}`);
        for (const key of keys) {
          session.clearAttentionFlag(key.split("::")[0]!, key.split("::").slice(1).join("::"));
        }
      }
      reply.code(204).send();
      return;
    }

    // Cold session — persist directly via mutateRecord.
    if (!(await manager.hasRecord(id))) {
      reply.code(404).send({ error: "session not found" });
      return;
    }

    const store = (manager as unknown as { store: import("../../core/session-store.js").SessionStore }).store;
    const record = await store.read(id);
    if (!record) {
      reply.code(404).send({ error: "session not found" });
      return;
    }

    const currentFlags = record.attentionFlags ?? [];
    let nextFlags: AttentionFlag[];
    if (src.length > 0 && rsn.length > 0) {
      const key = `${src}::${rsn}`;
      nextFlags = currentFlags.filter((f) => `${f.source}::${f.reason}` !== key);
    } else {
      nextFlags = [];
    }

    if (nextFlags.length === currentFlags.length && nextFlags.every((f, i) => f.source === currentFlags[i]!.source && f.reason === currentFlags[i]!.reason)) {
      // No change — the flag was already absent or all flags were already empty.
      reply.code(204).send();
      return;
    }

    await store.write({ ...record, attentionFlags: nextFlags });
    reply.code(204).send();
  });
}
