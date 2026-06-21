import { z } from "zod";
import { mergeMeta } from "./types-hydra-meta.js";
import type { CompactionState } from "../core/snapshot.js";

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
  // Present when compaction is in progress (requested, running,
  // swap_pending, or swap_deferred). Absent for idle sessions and
  // those that have never been compacted. Lets list views surface a
  // badge without needing a per-session GET /compact call.
  compactionState: z.any().optional(),
  // Present when this session is a fork whose synopsis is being
  // generated in the background. Values: "running" | "failed".
  // Absent when not a synthesis fork or when synopsis is already
  // present and clean. Lets list views render a synthesizing indicator.
  forkSynthesisState: z.enum(["running", "failed"]).optional(),
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
  // True when this session/attach call is what brought the session
  // from cold → live (the daemon's resurrect path ran inside the
  // handler). False/absent when attaching to an already-live session.
  // Clients use this to decide whether to surface attach-time UX like
  // the compaction prompt: ask once per wake, not on every re-attach.
  resurrected?: boolean;
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
  if (entry.compactionState !== undefined) {
    meta.compactionState = entry.compactionState;
  }
  if (entry.forkSynthesisState !== undefined) {
    meta.forkSynthesisState = entry.forkSynthesisState;
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
    if (extras.resurrected === true) {
      meta.resurrected = true;
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
