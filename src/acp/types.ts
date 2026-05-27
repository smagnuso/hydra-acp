import { z } from "zod";

// The ACP wire protocol version that hydra speaks. Single source of
// truth for every `initialize` handshake (daemon → agent, TUI → daemon,
// shim proxy) so the value isn't repeated as a literal across the
// codebase. A protocol bump touches this constant and the matching
// agreed version negotiation logic — not every callsite.
export const ACP_PROTOCOL_VERSION = 1;

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export const JsonRpcErrorCodes = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  // -32001…-32003 reserved for RFD #533 attach semantics:
  //   -32001 Session not found
  //   -32002 Not authorised to attach
  //   -32003 Session does not support multi-client attach
  // We emit -32001 (matching); the other two are reserved for spec
  // alignment even though we don't currently emit them (we bearer-auth
  // at WS upgrade time and always support multi-client attach).
  SessionNotFound: -32001,
  NotAuthorisedToAttach: -32002,
  MultiClientNotSupported: -32003,
  AgentNotInstalled: -32005,
  // Hydra-internal codes — outside the RFD's reserved range so they
  // can't collide with future spec assignments.
  BundleAlreadyImported: -32010,
  PermissionDenied: -32011,
  AlreadyAttached: -32012,
  StreamNotEnabled: -32013,
} as const;

export const InitializeParams = z.object({
  protocolVersion: z.number().optional(),
  clientCapabilities: z.record(z.unknown()).optional(),
  clientInfo: z
    .object({
      name: z.string(),
      version: z.string().optional(),
    })
    .optional(),
});
export type InitializeParams = z.infer<typeof InitializeParams>;

export const HistoryPolicy = z.enum([
  "full",
  "pending_only",
  "none",
  "after_message",
]);
export type HistoryPolicy = z.infer<typeof HistoryPolicy>;

export const SessionNewParams = z.object({
  cwd: z.string(),
  agentId: z.string().optional(),
  mcpServers: z.array(z.unknown()).optional(),
});
export type SessionNewParams = z.infer<typeof SessionNewParams>;

export const SessionResumeHints = z.object({
  upstreamSessionId: z.string(),
  agentId: z.string(),
  cwd: z.string(),
  title: z.string().optional(),
  agentArgs: z.array(z.string()).optional(),
});
export type SessionResumeHints = z.infer<typeof SessionResumeHints>;

export const SessionAttachParams = z.object({
  sessionId: z.string(),
  historyPolicy: HistoryPolicy.default("full"),
  // Required when historyPolicy is "after_message"; ignored otherwise.
  // The proxy replays history entries strictly after the entry whose
  // messageId matches this value. If the id isn't found in the buffer,
  // the response.historyPolicy field surfaces "full" so the caller
  // knows we fell back. Per RFD #533.
  afterMessageId: z.string().optional(),
  // Caller-assigned opaque id (e.g. a UUID). When provided, the proxy
  // echoes it in resolvedBy/sentBy and lifecycle events so other
  // clients can disambiguate multiple instances of the same
  // clientInfo.name. When omitted, the proxy assigns one and returns
  // it in the response. Per RFD #533.
  clientId: z.string().optional(),
  clientInfo: z
    .object({
      name: z.string(),
      version: z.string().optional(),
    })
    .optional(),
  // When true, the connection observes the session but cannot mutate
  // it: state-changing methods (session/prompt, session/cancel,
  // session/set_model, etc.) are rejected with -32011, and attaching
  // to a cold session does not resurrect or spawn an agent — just
  // streams history from disk. Used by the TUI's view-only mode.
  readonly: z.boolean().optional(),
  _meta: z.record(z.unknown()).optional(),
});
export type SessionAttachParams = z.infer<typeof SessionAttachParams>;

export const HYDRA_META_KEY = "hydra-acp";

export interface HydraAdvertisedCommand {
  name: string;
  description?: string;
}

export interface HydraAdvertisedMode {
  id: string;
  name?: string;
  description?: string;
}

export interface HydraAdvertisedModel {
  modelId: string;
  name?: string;
  description?: string;
}

// Identity of the client whose composer originated a prompt. Used as
// the `originator` field on prompt_queue_* notifications so peer
// clients can render "queued from <name>" chips.
export interface PromptOriginator {
  clientId: string;
  name?: string;
  version?: string;
}

// One entry in the daemon-owned prompt queue, surfaced to clients via
// the attach-response queue snapshot and the prompt_queue_added
// notification. `prompt` is the original session/prompt prompt array
// (text + attachments) so peer clients can render the chip preview
// without needing the prompt to start before they see what it is.
export interface PromptQueueEntry {
  messageId: string;
  originator: PromptOriginator;
  prompt: unknown[];
  // 0 = currently in-flight (head); 1..N = waiting. At enqueue time
  // this is the count of entries already ahead of the new one.
  position: number;
  enqueuedAt: number;
}

export interface HydraMeta {
  upstreamSessionId?: string;
  agentId?: string;
  cwd?: string;
  name?: string;
  agentArgs?: string[];
  // Transformer names to attach to the session chain. Falls back to the
  // daemon's defaultTransformers when absent.
  transformers?: string[];
  resume?: SessionResumeHints;
  // Caller-requested model id for a fresh session/new. One-shot: the daemon
  // issues session/set_model with this value during bootstrapAgent and then
  // forgets it — meta.json carries `currentModel` (response-shaped) instead.
  // Resurrect ignores this field by design.
  model?: string;
  // Snapshot state delivered on the attach/new response so clients
  // don't need to wait for history replay to know the current model,
  // mode, or command palette.
  currentModel?: string;
  currentMode?: string;
  // Last-known usage (tokens + cost). Delivered on attach so the TUI's
  // sessionbar can show tokens/cost immediately instead of waiting for
  // the next live usage_update.
  currentUsage?: SessionListUsage;
  availableCommands?: HydraAdvertisedCommand[];
  availableModes?: HydraAdvertisedMode[];
  availableModels?: HydraAdvertisedModel[];
  // Epoch-ms when the in-flight agent turn began. Present only when
  // mid-turn at attach response time; lets a fresh client boot with
  // the busy banner already showing the right elapsed time rather
  // than waiting for the next live update.
  turnStartedAt?: number;
  // Daemon advertises whether it accepts concurrent session/prompt
  // requests for a given session (queueing the second behind the
  // first). Surfaced on the initialize response so capability-aware
  // clients can stop running their own local queues.
  promptQueueing?: boolean;
  // Daemon supports hydra-acp/cancel_prompt for cancelling queued
  // (not-yet-running) prompts. Backfilled for consistency with the
  // newer capability flags — clients that already call the method
  // unconditionally aren't affected; future clients can gate UI
  // surface on the flag instead of relying on method-not-found.
  promptCancelling?: boolean;
  // Daemon supports hydra-acp/update_prompt for editing the content
  // of a queued (not-yet-running) prompt. Backfilled, same as
  // promptCancelling.
  promptUpdating?: boolean;
  // Daemon supports hydra-acp/amend_prompt — interrupt the in-flight
  // head turn with a replacement (cancel-and-resubmit, with the
  // partial agent response preserved in conversation history).
  promptAmending?: boolean;
  // Daemon forwards concurrent session/prompt requests directly to
  // the agent (true only when the agent supports streaming-input
  // style absorption). Implies promptQueueing.
  promptPipelining?: boolean;
  // Snapshot of the daemon-side prompt queue at attach time. Lets a
  // late-joining client paint queue chips for entries that landed
  // before it attached without waiting for new prompt_queue_added
  // notifications.
  queue?: PromptQueueEntry[];
  // Set by `hydra cat --stream` on session/new. The daemon mints a
  // per-session MCP bearer token, opens an in-memory stdin stream
  // (no /tmp file), injects an HTTP MCP descriptor into the agent's
  // mcpServers, and registers the (token → session) pair so the agent
  // can call tail_stdin / read_stdin / wait_for_more against the ring.
  mcpStdin?: boolean;
}

export function extractHydraMeta(
  meta: Record<string, unknown> | undefined,
): HydraMeta {
  if (!meta) {
    return {};
  }
  const namespaced = meta[HYDRA_META_KEY];
  if (!namespaced || typeof namespaced !== "object" || Array.isArray(namespaced)) {
    return {};
  }
  const obj = namespaced as Record<string, unknown>;
  const out: HydraMeta = {};
  if (typeof obj.upstreamSessionId === "string") {
    out.upstreamSessionId = obj.upstreamSessionId;
  }
  if (typeof obj.agentId === "string") {
    out.agentId = obj.agentId;
  }
  if (typeof obj.cwd === "string") {
    out.cwd = obj.cwd;
  }
  if (typeof obj.name === "string") {
    out.name = obj.name;
  }
  if (Array.isArray(obj.agentArgs) && obj.agentArgs.every((a) => typeof a === "string")) {
    out.agentArgs = obj.agentArgs as string[];
  }
  if (Array.isArray(obj.transformers) && obj.transformers.every((t) => typeof t === "string")) {
    out.transformers = obj.transformers as string[];
  }
  if (obj.resume) {
    const parsed = SessionResumeHints.safeParse(obj.resume);
    if (parsed.success) {
      out.resume = parsed.data;
    }
  }
  if (typeof obj.model === "string") {
    out.model = obj.model;
  }
  if (typeof obj.currentModel === "string") {
    out.currentModel = obj.currentModel;
  }
  if (typeof obj.currentMode === "string") {
    out.currentMode = obj.currentMode;
  }
  if (obj.currentUsage) {
    const parsed = SessionListUsage.safeParse(obj.currentUsage);
    if (parsed.success) {
      out.currentUsage = parsed.data;
    }
  }
  if (typeof obj.turnStartedAt === "number" && obj.turnStartedAt > 0) {
    out.turnStartedAt = obj.turnStartedAt;
  }
  if (Array.isArray(obj.availableCommands)) {
    const cmds: HydraAdvertisedCommand[] = [];
    for (const raw of obj.availableCommands) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        continue;
      }
      const c = raw as Record<string, unknown>;
      if (typeof c.name !== "string") {
        continue;
      }
      const cmd: HydraAdvertisedCommand = { name: c.name };
      if (typeof c.description === "string") {
        cmd.description = c.description;
      }
      cmds.push(cmd);
    }
    if (cmds.length > 0) {
      out.availableCommands = cmds;
    }
  }
  if (typeof obj.promptQueueing === "boolean") {
    out.promptQueueing = obj.promptQueueing;
  }
  if (typeof obj.promptCancelling === "boolean") {
    out.promptCancelling = obj.promptCancelling;
  }
  if (typeof obj.promptUpdating === "boolean") {
    out.promptUpdating = obj.promptUpdating;
  }
  if (typeof obj.mcpStdin === "boolean") {
    out.mcpStdin = obj.mcpStdin;
  }
  if (typeof obj.promptAmending === "boolean") {
    out.promptAmending = obj.promptAmending;
  }
  if (typeof obj.promptPipelining === "boolean") {
    out.promptPipelining = obj.promptPipelining;
  }
  if (Array.isArray(obj.queue)) {
    const entries: PromptQueueEntry[] = [];
    for (const raw of obj.queue) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        continue;
      }
      const r = raw as Record<string, unknown>;
      const orig = r.originator as Record<string, unknown> | undefined;
      if (
        typeof r.messageId !== "string" ||
        !orig ||
        typeof orig.clientId !== "string" ||
        !Array.isArray(r.prompt) ||
        typeof r.position !== "number" ||
        typeof r.enqueuedAt !== "number"
      ) {
        continue;
      }
      const originator: PromptOriginator = { clientId: orig.clientId };
      if (typeof orig.name === "string") originator.name = orig.name;
      if (typeof orig.version === "string") originator.version = orig.version;
      entries.push({
        messageId: r.messageId,
        originator,
        prompt: r.prompt as unknown[],
        position: r.position,
        enqueuedAt: r.enqueuedAt,
      });
    }
    if (entries.length > 0) {
      out.queue = entries;
    }
  }
  if (Array.isArray(obj.availableModes)) {
    const modes: HydraAdvertisedMode[] = [];
    for (const raw of obj.availableModes) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        continue;
      }
      const m = raw as Record<string, unknown>;
      if (typeof m.id !== "string") {
        continue;
      }
      const mode: HydraAdvertisedMode = { id: m.id };
      if (typeof m.name === "string") {
        mode.name = m.name;
      }
      if (typeof m.description === "string") {
        mode.description = m.description;
      }
      modes.push(mode);
    }
    if (modes.length > 0) {
      out.availableModes = modes;
    }
  }
  if (Array.isArray(obj.availableModels)) {
    const models: HydraAdvertisedModel[] = [];
    for (const raw of obj.availableModels) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        continue;
      }
      const m = raw as Record<string, unknown>;
      if (typeof m.modelId !== "string") {
        continue;
      }
      const model: HydraAdvertisedModel = { modelId: m.modelId };
      if (typeof m.name === "string") {
        model.name = m.name;
      }
      if (typeof m.description === "string") {
        model.description = m.description;
      }
      models.push(model);
    }
    if (models.length > 0) {
      out.availableModels = models;
    }
  }
  return out;
}

export function mergeMeta(
  passthrough: Record<string, unknown> | undefined,
  ours: Record<string, unknown>,
): Record<string, unknown> {
  return { ...(passthrough ?? {}), [HYDRA_META_KEY]: ours };
}

export const SessionDetachParams = z.object({
  sessionId: z.string(),
});
export type SessionDetachParams = z.infer<typeof SessionDetachParams>;

// Per the ratified Session List spec
// (https://agentclientprotocol.com/protocol/session-list), the only request
// parameters are `cwd` (optional filter) and `cursor` (opaque pagination
// token). `limit` was removed from the spec in the 2025-11-23 revision; we
// don't accept it on the wire so we stay strictly compliant.
export const SessionListParams = z.object({
  cwd: z.string().optional(),
  cursor: z.string().optional(),
});
export type SessionListParams = z.infer<typeof SessionListParams>;

// Last-known usage snapshot (tokens + cost) for a session. Fields are
// individually optional — agents emit varying subsets and the persisted
// record merges them across events. Listed sessions surface whatever
// was last seen on disk; live sessions surface the in-memory state.
export const SessionListUsage = z.object({
  used: z.number().optional(),
  size: z.number().optional(),
  costAmount: z.number().optional(),
  costCurrency: z.string().optional(),
});
export type SessionListUsage = z.infer<typeof SessionListUsage>;

// Internal session list entry — used by the REST API (/v1/sessions),
// the picker, and other hydra-internal callers. Carries hydra-specific
// fields at the top level for convenience. The ACP wire shape is a
// stripped-down subset; see SessionListEntryWire below.
export const SessionListEntry = z.object({
  sessionId: z.string(),
  upstreamSessionId: z.string().optional(),
  cwd: z.string(),
  title: z.string().optional(),
  agentId: z.string().optional(),
  // Last-known model id, so list views can render `<agent>(<model>)`
  // without resurrecting cold sessions to look it up.
  currentModel: z.string().optional(),
  // Last-known usage snapshot so list views can show per-session cost
  // (and tokens, in callers that care) without resurrecting cold sessions.
  currentUsage: SessionListUsage.optional(),
  // Origin host (and origin upstream id) for imported sessions. Picker
  // uses the host to fill in the UPSTREAM cell pre-first-attach;
  // future "connect back to origin" callers would dial both.
  importedFromMachine: z.string().optional(),
  importedFromUpstreamSessionId: z.string().optional(),
  // Set when this session was spawned as a child by a transformer.
  parentSessionId: z.string().optional(),
  // clientInfo from the process that issued session/new. Lets list views
  // hide cat-style ancillary sessions by default while letting an
  // override flag surface them.
  originatingClient: z
    .object({ name: z.string(), version: z.string().optional() })
    .optional(),
  updatedAt: z.string(),
  attachedClients: z.number().int().nonnegative(),
  status: z.enum(["live", "cold"]).default("live"),
  // True while the session is mid-turn (an agent prompt is in flight).
  // Always false for cold sessions. Lets pickers render a busy dot
  // without having to attach.
  busy: z.boolean().default(false),
  _meta: z.record(z.unknown()).optional(),
});
export type SessionListEntry = z.infer<typeof SessionListEntry>;

// ACP-compliant `session/list` entry. Per the ratified spec
// (https://agentclientprotocol.com/protocol/session-list), `sessionId`
// and `cwd` are required; `title`, `updatedAt`, and `_meta` are optional.
// Hydra-specific fields (agentId, currentModel, attachedClients, status,
// upstream/import provenance) ride under `_meta["hydra-acp"]` per the
// extensibility convention.
export const SessionListEntryWire = z.object({
  sessionId: z.string(),
  cwd: z.string(),
  title: z.string().optional(),
  updatedAt: z.string().optional(),
  _meta: z.record(z.unknown()).optional(),
});
export type SessionListEntryWire = z.infer<typeof SessionListEntryWire>;

export const SessionListResult = z.object({
  sessions: z.array(SessionListEntryWire),
  nextCursor: z.string().optional(),
});
export type SessionListResult = z.infer<typeof SessionListResult>;

// Map an internal SessionListEntry to the ACP wire shape, packing
// hydra-specific fields into `_meta["hydra-acp"]` per the
// Extensibility convention. Any pre-existing `_meta` keys outside
// the hydra-acp namespace are passed through unchanged via mergeMeta.
export function sessionListEntryToWire(
  entry: SessionListEntry,
): SessionListEntryWire {
  const hydraMeta: Record<string, unknown> = {
    attachedClients: entry.attachedClients,
    status: entry.status,
    busy: entry.busy,
  };
  if (entry.agentId !== undefined) {
    hydraMeta.agentId = entry.agentId;
  }
  if (entry.upstreamSessionId !== undefined) {
    hydraMeta.upstreamSessionId = entry.upstreamSessionId;
  }
  if (entry.currentModel !== undefined) {
    hydraMeta.currentModel = entry.currentModel;
  }
  if (entry.currentUsage !== undefined) {
    hydraMeta.currentUsage = entry.currentUsage;
  }
  if (entry.importedFromMachine !== undefined) {
    hydraMeta.importedFromMachine = entry.importedFromMachine;
  }
  if (entry.importedFromUpstreamSessionId !== undefined) {
    hydraMeta.importedFromUpstreamSessionId = entry.importedFromUpstreamSessionId;
  }
  const wire: SessionListEntryWire = {
    sessionId: entry.sessionId,
    cwd: entry.cwd,
    updatedAt: entry.updatedAt,
    _meta: mergeMeta(entry._meta, hydraMeta),
  };
  if (entry.title !== undefined) {
    wire.title = entry.title;
  }
  return wire;
}

export const SessionPromptParams = z.object({
  sessionId: z.string(),
  prompt: z.array(z.unknown()),
});
export type SessionPromptParams = z.infer<typeof SessionPromptParams>;

export const SessionCancelParams = z.object({
  sessionId: z.string(),
});
export type SessionCancelParams = z.infer<typeof SessionCancelParams>;

// hydra-acp/prompt_queue_* wire shapes. The daemon owns the prompt
// queue per RFD-draft "Prompt Queueing" + visibility extensions; these
// notifications keep all attached clients in sync so any of them can
// render queue chips, cancel a queued entry, or edit it before it runs.

const PromptOriginatorSchema = z.object({
  clientId: z.string(),
  name: z.string().optional(),
  version: z.string().optional(),
});

export const PromptQueueAddedParams = z.object({
  sessionId: z.string(),
  messageId: z.string(),
  originator: PromptOriginatorSchema,
  prompt: z.array(z.unknown()),
  // 0 = head (currently in-flight). At enqueue time the new entry's
  // position equals the count of entries already ahead of it.
  position: z.number().int().nonnegative(),
  queueDepth: z.number().int().positive(),
  enqueuedAt: z.number(),
});
export type PromptQueueAddedParams = z.infer<typeof PromptQueueAddedParams>;

export const PromptQueueUpdatedParams = z.object({
  sessionId: z.string(),
  messageId: z.string(),
  prompt: z.array(z.unknown()),
});
export type PromptQueueUpdatedParams = z.infer<typeof PromptQueueUpdatedParams>;

// `started` = head transitioned to in-flight (the active turn begins).
// `cancelled` = explicit hydra-acp/cancel_prompt. `abandoned` = session
// tear-down with queued entries that never ran.
export const PromptQueueRemovedParams = z.object({
  sessionId: z.string(),
  messageId: z.string(),
  reason: z.enum(["started", "cancelled", "abandoned"]),
});
export type PromptQueueRemovedParams = z.infer<typeof PromptQueueRemovedParams>;

export const CancelPromptParams = z.object({
  sessionId: z.string(),
  messageId: z.string(),
});
export type CancelPromptParams = z.infer<typeof CancelPromptParams>;

// `already_running` means the messageId matched the in-flight head;
// caller should fall back to session/cancel to abort the active turn.
export const CancelPromptResult = z.object({
  cancelled: z.boolean(),
  reason: z.enum(["ok", "not_found", "already_running"]),
});
export type CancelPromptResult = z.infer<typeof CancelPromptResult>;

export const UpdatePromptParams = z.object({
  sessionId: z.string(),
  messageId: z.string(),
  prompt: z.array(z.unknown()),
});
export type UpdatePromptParams = z.infer<typeof UpdatePromptParams>;

export const UpdatePromptResult = z.object({
  updated: z.boolean(),
  reason: z.enum(["ok", "not_found", "already_running"]),
});
export type UpdatePromptResult = z.infer<typeof UpdatePromptResult>;

// hydra-acp/amend_prompt — interrupt the in-flight head turn with a
// replacement prompt. Pin the prompt being amended via targetMessageId
// so the daemon can resolve the race deterministically (the target
// might finish naturally before the amend arrives). For a queued
// target, the daemon edits in place (same machinery as update_prompt).
export const AmendPromptParams = z.object({
  sessionId: z.string(),
  targetMessageId: z.string(),
  prompt: z.array(z.unknown()),
  replaceQueue: z.boolean().optional(),
  onTargetCompleted: z.enum(["reject", "send_anyway"]).optional(),
});
export type AmendPromptParams = z.infer<typeof AmendPromptParams>;

export const AmendPromptResult = z.object({
  amended: z.boolean(),
  reason: z.enum([
    "ok",
    "target_completed",
    "target_cancelled",
    "target_not_found",
  ]),
  // Present when a prompt was sent or replaced: the amendment's id on
  // success, or the regular follow-up's id when onTargetCompleted is
  // "send_anyway" and the daemon forwarded the prompt anyway.
  messageId: z.string().optional(),
});
export type AmendPromptResult = z.infer<typeof AmendPromptResult>;

// hydra-acp/prompt_amended notification — dedicated linkage event
// fired after a successful amend. Carries both messageIds and the
// amendment content so subscribers that want to render the M1→M2
// relationship don't have to correlate turn_complete + prompt_received
// via _meta or sequence.
export const PromptAmendedParams = z.object({
  sessionId: z.string(),
  cancelledMessageId: z.string(),
  newMessageId: z.string(),
  prompt: z.array(z.unknown()),
  originator: PromptOriginatorSchema,
  amendedAt: z.number(),
});
export type PromptAmendedParams = z.infer<typeof PromptAmendedParams>;

// hydra-acp/stream_* — per-session ring buffer for piped stdin. Cat
// invokes stream_open to allocate a SessionStreamBuffer on the session,
// then streams stdin via stream_write. The agent consumes via either
// the file path returned by stream_open (when running without HTTP MCP)
// or — once Stage 2 lands — an MCP tool surface that wraps the read RPCs
// below. All cursors are absolute monotonic byte offsets, never ring
// indices, so eviction produces a well-defined `gap` count.

export const StreamOpenParams = z.object({
  sessionId: z.string(),
  // 'memory' keeps the ring in RAM only — needed for the eventual MCP
  // tool surface. 'file' adds a temp file projection that the agent can
  // consume with shell tools (tail -f / head / grep) when MCP isn't
  // available. The temp file's path is returned in the response.
  mode: z.enum(["memory", "file"]).optional(),
  // Ring capacity in bytes. Server clamps to a reasonable minimum and
  // its configured max; omitted falls back to the daemon default.
  capacityBytes: z.number().int().positive().optional(),
  // File mode only. Soft cap in bytes; after this many bytes are
  // written to the file, further appends still land in the ring but
  // stop being mirrored to disk. The daemon emits one stream_truncated
  // session/update notification when the cap is first hit.
  fileCapBytes: z.number().int().positive().optional(),
});
export type StreamOpenParams = z.infer<typeof StreamOpenParams>;

export const StreamOpenResult = z.object({
  // Only present when mode === "file".
  filePath: z.string().optional(),
  capacityBytes: z.number().int().positive(),
  fileCapBytes: z.number().int().positive().optional(),
});
export type StreamOpenResult = z.infer<typeof StreamOpenResult>;

export const StreamWriteParams = z.object({
  sessionId: z.string(),
  // Base64-encoded bytes. UTF-8 stdin gets re-encoded on the wire; the
  // ring is byte-exact so binary streams (audio, framed protocols) work
  // identically.
  chunk: z.string(),
  // True on the final write. Pending long-poll reads / waits return with
  // eof:true once this is observed.
  eof: z.boolean().optional(),
});
export type StreamWriteParams = z.infer<typeof StreamWriteParams>;

export const StreamWriteResult = z.object({
  // Absolute writeCursor after this append landed.
  writeCursor: z.number().int().nonnegative(),
});
export type StreamWriteResult = z.infer<typeof StreamWriteResult>;

export const StreamReadParams = z.object({
  sessionId: z.string(),
  cursor: z.number().int().nonnegative(),
  // Cap on bytes returned. Server enforces a hard ceiling (STREAM_READ_MAX_BYTES,
  // currently 64 KiB) even when the caller asks for more.
  maxBytes: z.number().int().positive().optional(),
  // Long-poll timeout in ms. 0 / omitted returns immediately with
  // whatever's available (possibly empty). Server cap 60s.
  waitMs: z.number().int().nonnegative().optional(),
});
export type StreamReadParams = z.infer<typeof StreamReadParams>;

export const StreamReadResult = z.object({
  // Base64-encoded bytes. Empty string when nothing new is available
  // and either waitMs was 0 or the long-poll expired without data.
  bytes: z.string(),
  nextCursor: z.number().int().nonnegative(),
  // Set when `cursor` pointed before the oldest still-resident byte —
  // value is the count of bytes that were evicted between the caller's
  // cursor and what we still have.
  gap: z.number().int().nonnegative().optional(),
  // True when the producer has closed AND there are no more bytes
  // after nextCursor.
  eof: z.boolean().optional(),
});
export type StreamReadResult = z.infer<typeof StreamReadResult>;

// hydra-acp/agent_install_progress — daemon → client. Fires while the
// agent's binary or npm package is being fetched during session/new or
// session/attach. The notification is *not* keyed by sessionId (the
// session doesn't exist yet on session/new); the originating WS
// connection is the implicit scope. `phase` mirrors the structured
// callback shape from binary-install / npm-install:
//   - "download_start"     — total size known, bytes still 0
//   - "download_progress"  — periodic byte tick (~150ms)
//   - "download_done"      — last byte received
//   - "extract"            — tar / unzip step (binary only)
//   - "install_start"      — npm install began (npx only)
//   - "installed"          — everything is on disk and ready
// source distinguishes the channel so the TUI can pick the right copy
// ("Downloading…" vs "Installing via npm…").
export const AgentInstallProgressParams = z.object({
  agentId: z.string(),
  version: z.string(),
  source: z.enum(["binary", "npm"]),
  phase: z.enum([
    "download_start",
    "download_progress",
    "download_done",
    "extract",
    "install_start",
    "installed",
  ]),
  receivedBytes: z.number().optional(),
  totalBytes: z.number().optional(),
  packageSpec: z.string().optional(),
});
export type AgentInstallProgressParams = z.infer<typeof AgentInstallProgressParams>;

export const AGENT_INSTALL_PROGRESS_METHOD = "hydra-acp/agent_install_progress";

export interface SessionCapabilities {
  attach?: Record<string, never>;
  // Per the ratified Session List spec (stabilized 2026-03-09), capability
  // is advertised as an empty object `{}`, matching the `attach` shape.
  // See https://agentclientprotocol.com/protocol/session-list
  list?: Record<string, never>;
}

export interface PromptCapabilities {
  image?: boolean;
  audio?: boolean;
  embeddedContext?: boolean;
}

export interface McpCapabilities {
  http?: boolean;
  sse?: boolean;
}

export interface AgentCapabilities {
  promptCapabilities?: PromptCapabilities;
  mcpCapabilities?: McpCapabilities;
  loadSession?: boolean;
  sessionCapabilities?: SessionCapabilities;
}

export interface InitializeResult {
  protocolVersion: number;
  agentCapabilities: AgentCapabilities;
  agentInfo: {
    name: string;
    version: string;
  };
  authMethods?: Array<{
    id: string;
    description: string;
  }>;
  // Hydra-only extensions ride in _meta["hydra-acp"]; see HydraMeta.
  // Generic ACP clients ignore the field, so this is additive only.
  _meta?: Record<string, unknown>;
}

