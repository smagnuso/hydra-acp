import { SessionResumeHints } from "./types-session.js";
import { SessionListUsage } from "./types-session-list.js";

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
  // Caller-supplied environment variables to forward into the spawned
  // child agent process for this session. Keys are non-empty strings,
  // values are strings — anything else makes the whole field drop
  // silently (session creation continues without env). An explicit
  // empty map `{}` clears any previously persisted env. Persisted on
  // the session record as `forwardedEnv` and reapplied automatically
  // on respawn / cold-resurrect.
  env?: Record<string, string>;
  // True when the session/attach call that produced this meta is what
  // brought the session from cold → live. Absent / false on re-attach
  // to an already-live session. Drives one-shot attach-time UX such
  // as the compaction prompt.
  resurrected?: boolean;
}

// Validate a candidate _meta["hydra-acp"].env map. Returns the cleaned
// Record<string,string> when the shape is well-formed (every key a
// non-empty string and every value a string), or undefined otherwise.
// An explicit empty object is preserved — callers use it to clear the
// persisted env.
function parseForwardedEnv(
  raw: unknown,
): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof key !== "string" || key.length === 0) {
      return undefined;
    }
    if (typeof value !== "string") {
      return undefined;
    }
    out[key] = value;
  }
  return out;
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
  if (typeof obj.resurrected === "boolean") {
    out.resurrected = obj.resurrected;
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
  if (obj.env !== undefined) {
    const parsedEnv = parseForwardedEnv(obj.env);
    if (parsedEnv !== undefined) {
      out.env = parsedEnv;
    }
  }
  return out;
}

// Build a log-safe view of a raw _meta envelope by replacing
// `_meta["hydra-acp"].env` (if any) with a key-only scaffold so log
// lines that dump _meta don't leak env values. Returns a shallow clone
// — the caller's object is not mutated. Non-record `env` values are
// preserved as-is (already harmless or already redacted upstream).
export function redactHydraMetaForLog(
  meta: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!meta) {
    return meta;
  }
  const ns = meta[HYDRA_META_KEY];
  if (!ns || typeof ns !== "object" || Array.isArray(ns)) {
    return meta;
  }
  const inner = ns as Record<string, unknown>;
  if (inner.env === undefined) {
    return meta;
  }
  let redactedEnv: unknown;
  if (inner.env && typeof inner.env === "object" && !Array.isArray(inner.env)) {
    const keys = Object.keys(inner.env as Record<string, unknown>);
    redactedEnv = { keys, count: keys.length };
  } else {
    redactedEnv = "<redacted>";
  }
  return {
    ...meta,
    [HYDRA_META_KEY]: { ...inner, env: redactedEnv },
  };
}

export function mergeMeta(
  passthrough: Record<string, unknown> | undefined,
  ours: Record<string, unknown>,
): Record<string, unknown> {
  return { ...(passthrough ?? {}), [HYDRA_META_KEY]: ours };
}
