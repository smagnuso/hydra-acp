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
  // Per JSON-RPC 2.0, `id` MUST be null when a server-side error makes
  // the request id undeterminable (e.g. a parse error on the frame
  // itself). The framing layers synthesize such responses with id=null;
  // peer-correlated responses use the same id as the request.
  id: JsonRpcId | null;
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
  // Session is mid-close (regen running, agent about to be killed).
  // Attach succeeds (read-only view of what was already there) but
  // mutating operations like session/prompt and slash commands are
  // rejected — accepting a new turn whose result we'd discard within
  // seconds would just lose the user's input silently.
  SessionClosing: -32014,
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

// Per the ACP spec, NewSessionRequest carries only `cwd` and `mcpServers`.
// Hydra's agent selection rides under `_meta["hydra-acp"].agentId` (parsed
// via extractHydraMeta) rather than a non-spec top-level field.
export const SessionNewParams = z.object({
  cwd: z.string(),
  mcpServers: z.array(z.unknown()).optional(),
  _meta: z.record(z.unknown()).optional(),
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
  // Hydra-specific attach options (readonly, replayMode, dripSpeed) are
  // NOT top-level — they ride under `_meta["hydra-acp"]` (read via
  // extractHydraMeta) so session/attach carries only RFD #533's own
  // fields at the top level.
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

// Daemon prompt-surface capabilities, advertised under
// `_meta["hydra-acp"].prompt` on the initialize response. Each flag gates
// a hydra-acp/prompt/* method (or the streaming-input absorption path).
export interface HydraPromptCapabilities {
  // Accepts concurrent session/prompt requests, queueing the second
  // behind the first — clients can stop running their own local queues.
  queueing?: boolean;
  // hydra-acp/prompt/cancel — cancel a queued (not-yet-running) prompt.
  cancelling?: boolean;
  // hydra-acp/prompt/update — edit the content of a queued prompt.
  updating?: boolean;
  // hydra-acp/prompt/amend — interrupt the in-flight head turn with a
  // replacement (cancel-and-resubmit, partial response preserved).
  amending?: boolean;
  // Forwards concurrent session/prompt requests directly to the agent
  // (only when the agent absorbs streaming input). Implies queueing.
  pipelining?: boolean;
}

// Daemon agent-catalog capabilities, advertised under
// `_meta["hydra-acp"].agents` on the initialize response.
export interface HydraAgentCapabilities {
  // hydra-acp/agents/list is available (entries carry install state).
  list?: boolean;
  // hydra-acp/agents/install_progress notifications are emitted while an
  // agent is fetched during session/new or session/attach.
  installProgress?: boolean;
}

export interface HydraMeta {
  upstreamSessionId?: string;
  agentId?: string;
  cwd?: string;
  // The per-attachment client id the daemon bound to this connection.
  // Surfaced on session/new and session/load responses under _meta (NOT
  // top-level — those are core ACP spec methods). On the RFD-track
  // session/attach response it stays top-level per that method's surface.
  clientId?: string;
  // Hydra-specific session/attach REQUEST options. Ride under _meta so
  // session/attach keeps only RFD #533's own fields at the top level.
  // `readonly`: observe-only attach (mutating methods rejected with
  // -32011; cold sessions stream from disk instead of resurrecting).
  // `replayMode`/`dripSpeed`: debug-only replay pacing.
  readonly?: boolean;
  replayMode?: "instant" | "drip";
  dripSpeed?: number;
  // How tool payload is delivered on replay. "inline" (default) sends full
  // content; "references" sends blob refs and the client fetches bodies on
  // demand via GET /v1/sessions/:id/tools/:hash. Opt-in for lean clients.
  toolContent?: "inline" | "references";
  // Hydra-specific session/detach RESPONSE field (the detach outcome).
  detachStatus?: "detached";
  // Session label (Session.title). Read off session/new params (the
  // `--name`/HYDRA_ACP_NAME label) and off the session-describing
  // responses. Spec-aligned with the top-level `title` on session/list.
  title?: string;
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
  // Daemon capability groups advertised on the initialize response so
  // capability-aware clients can probe support before calling a method
  // (rather than catching MethodNotFound). Grouped by resource to mirror
  // the hydra-acp/<resource>/<action> method namespaces. Named `prompt`
  // and `agents` — NOT `promptCapabilities`/`agentCapabilities`, which
  // are ACP spec names with different meanings.
  prompt?: HydraPromptCapabilities;
  agents?: HydraAgentCapabilities;
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
  // Initial value for the session's interactive tristate. Carried only
  // for the force-visible direction (agent sync / imports): `true` makes
  // an empty-history session show immediately. Honoured only on
  // session/new; the don't-promote direction lives on `ancillary` below.
  interactive?: boolean;
  // Set on a session/prompt by a hydra component acting as an external
  // ACP client (today only `hydra cat`) to mark the turn as ancillary:
  // it does NOT promote an undecided session to interactive. Absent (the
  // default) means a normal human turn that promotes undefined → true.
  ancillary?: boolean;
  // Triage/provenance fields. Emitted on every session-describing response
  // (session/list, session/new, session/attach) by buildHydraSessionMeta so
  // an attaching client gets the same view session/list offers. status,
  // busy, awaitingInput, and attachedClients are always present on the wire;
  // the rest are present only when applicable.
  status?: "live" | "cold";
  busy?: boolean;
  awaitingInput?: boolean;
  priority?: number;
  attachedClients?: number;
  importedFromMachine?: string;
  importedFromUpstreamSessionId?: string;
  parentSessionId?: string;
  forkedFromSessionId?: string;
  forkedFromMessageId?: string;
  originatingClient?: { name: string; version?: string };
  // Agent's own initialize-time capability claim, forwarded verbatim.
  agentCapabilities?: unknown;
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
  if (typeof obj.clientId === "string") {
    out.clientId = obj.clientId;
  }
  if (typeof obj.readonly === "boolean") {
    out.readonly = obj.readonly;
  }
  if (obj.replayMode === "instant" || obj.replayMode === "drip") {
    out.replayMode = obj.replayMode;
  }
  if (typeof obj.dripSpeed === "number" && obj.dripSpeed > 0) {
    out.dripSpeed = obj.dripSpeed;
  }
  if (obj.toolContent === "inline" || obj.toolContent === "references") {
    out.toolContent = obj.toolContent;
  }
  if (obj.detachStatus === "detached") {
    out.detachStatus = obj.detachStatus;
  }
  if (typeof obj.title === "string") {
    out.title = obj.title;
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
  if (obj.prompt && typeof obj.prompt === "object" && !Array.isArray(obj.prompt)) {
    const p = obj.prompt as Record<string, unknown>;
    const caps: HydraPromptCapabilities = {};
    if (typeof p.queueing === "boolean") caps.queueing = p.queueing;
    if (typeof p.cancelling === "boolean") caps.cancelling = p.cancelling;
    if (typeof p.updating === "boolean") caps.updating = p.updating;
    if (typeof p.amending === "boolean") caps.amending = p.amending;
    if (typeof p.pipelining === "boolean") caps.pipelining = p.pipelining;
    out.prompt = caps;
  }
  if (obj.agents && typeof obj.agents === "object" && !Array.isArray(obj.agents)) {
    const a = obj.agents as Record<string, unknown>;
    const caps: HydraAgentCapabilities = {};
    if (typeof a.list === "boolean") caps.list = a.list;
    if (typeof a.installProgress === "boolean") caps.installProgress = a.installProgress;
    out.agents = caps;
  }
  if (typeof obj.mcpStdin === "boolean") {
    out.mcpStdin = obj.mcpStdin;
  }
  if (typeof obj.interactive === "boolean") {
    out.interactive = obj.interactive;
  }
  if (typeof obj.ancillary === "boolean") {
    out.ancillary = obj.ancillary;
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
  if (obj.status === "live" || obj.status === "cold") {
    out.status = obj.status;
  }
  if (typeof obj.busy === "boolean") {
    out.busy = obj.busy;
  }
  if (typeof obj.awaitingInput === "boolean") {
    out.awaitingInput = obj.awaitingInput;
  }
  if (typeof obj.attachedClients === "number") {
    out.attachedClients = obj.attachedClients;
  }
  if (typeof obj.importedFromMachine === "string") {
    out.importedFromMachine = obj.importedFromMachine;
  }
  if (typeof obj.importedFromUpstreamSessionId === "string") {
    out.importedFromUpstreamSessionId = obj.importedFromUpstreamSessionId;
  }
  if (typeof obj.parentSessionId === "string") {
    out.parentSessionId = obj.parentSessionId;
  }
  if (typeof obj.forkedFromSessionId === "string") {
    out.forkedFromSessionId = obj.forkedFromSessionId;
  }
  if (typeof obj.forkedFromMessageId === "string") {
    out.forkedFromMessageId = obj.forkedFromMessageId;
  }
  if (
    obj.originatingClient &&
    typeof obj.originatingClient === "object" &&
    !Array.isArray(obj.originatingClient) &&
    typeof (obj.originatingClient as Record<string, unknown>).name === "string"
  ) {
    const oc = obj.originatingClient as Record<string, unknown>;
    out.originatingClient = {
      name: oc.name as string,
      ...(typeof oc.version === "string" ? { version: oc.version } : {}),
    };
  }
  if (obj.agentCapabilities !== undefined) {
    out.agentCapabilities = obj.agentCapabilities;
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
  // Local-fork breadcrumbs set by hydra-acp/session/fork. Distinct from
  // the imported* family above: a fork is a local branch off another
  // local session, an import is a cross-machine takeover.
  forkedFromSessionId: z.string().optional(),
  forkedFromMessageId: z.string().optional(),
  // clientInfo from the process that issued session/new. Carried for
  // log/display; the effective filtering signal is `interactive` below.
  originatingClient: z
    .object({ name: z.string(), version: z.string().optional() })
    .optional(),
  // Tristate filter signal computed by effectiveInteractive(): explicit
  // when the record stored a value, else inferred (legacy cat hint or
  // history-presence). Clients can use this to render a hint glyph
  // (e.g. dim non-interactive rows when the user toggles them in).
  interactive: z.boolean().optional(),
  // User-set sort weight; >0 floats the session to the top of the
  // picker. Absent / 0 = normal priority.
  priority: z.number().int().nonnegative().optional(),
  updatedAt: z.string(),
  attachedClients: z.number().int().nonnegative(),
  status: z.enum(["live", "cold"]).default("live"),
  // True while the session is mid-turn (an agent prompt is in flight).
  // Always false for cold sessions. Lets pickers render a busy dot
  // without having to attach.
  busy: z.boolean().default(false),
  // True when the agent is blocked on the user (an outstanding
  // session/request_permission, which also covers agent-posed
  // questions). Always false for cold sessions. Lets pickers render a
  // distinct "waiting on you" glyph instead of the busy dot.
  awaitingInput: z.boolean().default(false),
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

// Live-session-only additions to the hydra session meta. These are
// fields that only exist for a session that is currently resident (or
// loadable) — the agent's advertised palette, the in-flight turn clock,
// the prompt queue, etc. The session/list path leaves them undefined;
// the session/new and session/attach paths fill them in. Keeping them
// separate from SessionListEntry lets one builder emit a consistent
// superset across every response that carries session meta.
export interface LiveSessionMetaExtras {
  // Per-attachment client id. Set on session/new and session/load (where
  // it can't ride top-level — those are core spec methods).
  clientId?: string;
  currentMode?: string;
  agentArgs?: string[];
  availableCommands?: unknown[];
  availableModes?: unknown[];
  availableModels?: unknown[];
  turnStartedAt?: number;
  agentCapabilities?: unknown;
  queue?: unknown[];
}

// Single source of truth for the `_meta["hydra-acp"]` object emitted on
// every response that describes a session — session/list, session/new,
// session/attach (live + viewer). Producers derive a SessionListEntry
// for the session and (for the live paths) pass the LiveSessionMetaExtras
// the list path can't know. This keeps the three response shapes in sync:
// add a field here and every surface gets it.
//
// Title is emitted as `title`, matching the top-level session/list
// field. (An older `name` alias was removed once all in-tree readers
// moved to `title`.)
export function buildHydraSessionMeta(
  entry: SessionListEntry,
  extras?: LiveSessionMetaExtras,
): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    attachedClients: entry.attachedClients,
    status: entry.status,
    busy: entry.busy,
    awaitingInput: entry.awaitingInput,
  };
  if (entry.cwd !== undefined) {
    meta.cwd = entry.cwd;
  }
  if (entry.title !== undefined) {
    meta.title = entry.title;
  }
  if (entry.agentId !== undefined) {
    meta.agentId = entry.agentId;
  }
  if (entry.upstreamSessionId !== undefined) {
    meta.upstreamSessionId = entry.upstreamSessionId;
  }
  if (entry.currentModel !== undefined) {
    meta.currentModel = entry.currentModel;
  }
  if (entry.currentUsage !== undefined) {
    meta.currentUsage = entry.currentUsage;
  }
  if (entry.importedFromMachine !== undefined) {
    meta.importedFromMachine = entry.importedFromMachine;
  }
  if (entry.importedFromUpstreamSessionId !== undefined) {
    meta.importedFromUpstreamSessionId = entry.importedFromUpstreamSessionId;
  }
  if (entry.parentSessionId !== undefined) {
    meta.parentSessionId = entry.parentSessionId;
  }
  if (entry.forkedFromSessionId !== undefined) {
    meta.forkedFromSessionId = entry.forkedFromSessionId;
  }
  if (entry.forkedFromMessageId !== undefined) {
    meta.forkedFromMessageId = entry.forkedFromMessageId;
  }
  if (entry.originatingClient !== undefined) {
    meta.originatingClient = entry.originatingClient;
  }
  if (entry.interactive !== undefined) {
    meta.interactive = entry.interactive;
  }
  if (entry.priority !== undefined && entry.priority > 0) {
    meta.priority = entry.priority;
  }
  if (extras) {
    if (extras.clientId !== undefined) {
      meta.clientId = extras.clientId;
    }
    if (extras.currentMode !== undefined) {
      meta.currentMode = extras.currentMode;
    }
    if (extras.agentArgs !== undefined && extras.agentArgs.length > 0) {
      meta.agentArgs = extras.agentArgs;
    }
    if (extras.availableCommands !== undefined && extras.availableCommands.length > 0) {
      meta.availableCommands = extras.availableCommands;
    }
    if (extras.availableModes !== undefined && extras.availableModes.length > 0) {
      meta.availableModes = extras.availableModes;
    }
    if (extras.availableModels !== undefined && extras.availableModels.length > 0) {
      meta.availableModels = extras.availableModels;
    }
    if (extras.turnStartedAt !== undefined) {
      meta.turnStartedAt = extras.turnStartedAt;
    }
    if (extras.agentCapabilities !== undefined) {
      meta.agentCapabilities = extras.agentCapabilities;
    }
    if (extras.queue !== undefined && extras.queue.length > 0) {
      meta.queue = extras.queue;
    }
  }
  return meta;
}

// Map an internal SessionListEntry to the ACP wire shape, packing
// hydra-specific fields into `_meta["hydra-acp"]` per the
// Extensibility convention. Any pre-existing `_meta` keys outside
// the hydra-acp namespace are passed through unchanged via mergeMeta.
export function sessionListEntryToWire(
  entry: SessionListEntry,
): SessionListEntryWire {
  const wire: SessionListEntryWire = {
    sessionId: entry.sessionId,
    cwd: entry.cwd,
    updatedAt: entry.updatedAt,
    _meta: mergeMeta(entry._meta, buildHydraSessionMeta(entry)),
  };
  if (entry.title !== undefined) {
    wire.title = entry.title;
  }
  return wire;
}

export const SessionPromptParams = z.object({
  sessionId: z.string(),
  prompt: z.array(z.unknown()),
  // Hydra extensions ride under _meta["hydra-acp"] (e.g. `ancillary` to
  // mark a non-promoting turn). Kept so Session.prompt can read them.
  _meta: z.record(z.unknown()).optional(),
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
// `cancelled` = explicit hydra-acp/prompt/cancel. `abandoned` = session
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

// hydra-acp/prompt/amend — interrupt the in-flight head turn with a
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

// hydra-acp/prompt/amended notification — dedicated linkage event
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

// hydra-acp/agents/install_progress — daemon → client. Fires while the
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

export const AGENT_INSTALL_PROGRESS_METHOD = "hydra-acp/agents/install_progress";

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

