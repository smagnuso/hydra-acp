import { z } from "zod";
import {
  PersistedAgentCommand,
  PersistedAgentMode,
  PersistedUsage,
  type SessionRecord,
} from "./session-store.js";
import type { HistoryEntry } from "./history-store.js";

// On-disk shape of a history entry as it appears in history.jsonl. The
// runtime HistoryEntry interface (history-store.ts) is intentionally
// loose on params; we mirror that here so a bundle can carry any
// shape an agent emits without per-field validation.
const HistoryEntrySchema = z.object({
  method: z.string(),
  params: z.unknown(),
  recordedAt: z.number(),
});

const BundleSession = z.object({
  // The exporter's local id. Regenerated fresh on import (sessionId is
  // the local namespace; lineageId is what survives across hops).
  sessionId: z.string(),
  // Required on bundles — the export path backfills if the source
  // record was written before lineageId existed.
  lineageId: z.string(),
  // The exporter's agent-side session id at export time. Carried so
  // importers can persist it as a breadcrumb (and, eventually, as the
  // handle a "connect back to origin" feature would need). Omitted on
  // bundles whose source record never bound to an agent (e.g. a
  // re-export of an imported, not-yet-attached session).
  upstreamSessionId: z.string().optional(),
  agentId: z.string(),
  cwd: z.string(),
  title: z.string().optional(),
  currentModel: z.string().optional(),
  currentMode: z.string().optional(),
  currentUsage: PersistedUsage.optional(),
  agentCommands: z.array(PersistedAgentCommand).optional(),
  agentModes: z.array(PersistedAgentMode).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const Bundle = z.object({
  version: z.literal(1),
  exportedAt: z.string(),
  exportedFrom: z.object({
    hydraVersion: z.string(),
    machine: z.string(),
    // Externally-reachable name (and optional ":port") for the exporting
    // daemon, sourced from config.daemon.publicHost (or daemon.host when
    // non-loopback). Carried so an importer can construct a hydra:// URL
    // that dials back to the origin — e.g. over Tailscale. Omitted when
    // the exporter has no routable address; never falls back to loopback.
    hydraHost: z.string().optional(),
  }),
  session: BundleSession,
  history: z.array(HistoryEntrySchema),
  promptHistory: z.array(z.string()).optional(),
});
export type Bundle = z.infer<typeof Bundle>;

export interface EncodeBundleParams {
  record: SessionRecord & { lineageId: string };
  history: HistoryEntry[];
  promptHistory?: string[];
  hydraVersion: string;
  machine: string;
  hydraHost?: string;
}

export function encodeBundle(params: EncodeBundleParams): Bundle {
  const bundle: Bundle = {
    version: 1,
    exportedAt: new Date().toISOString(),
    exportedFrom: {
      hydraVersion: params.hydraVersion,
      machine: params.machine,
      ...(params.hydraHost !== undefined && params.hydraHost.length > 0
        ? { hydraHost: params.hydraHost }
        : {}),
    },
    session: {
      sessionId: params.record.sessionId,
      lineageId: params.record.lineageId,
      ...(params.record.upstreamSessionId
        ? { upstreamSessionId: params.record.upstreamSessionId }
        : {}),
      agentId: params.record.agentId,
      cwd: params.record.cwd,
      ...(params.record.title !== undefined ? { title: params.record.title } : {}),
      ...(params.record.currentModel !== undefined
        ? { currentModel: params.record.currentModel }
        : {}),
      ...(params.record.currentMode !== undefined
        ? { currentMode: params.record.currentMode }
        : {}),
      ...(params.record.currentUsage !== undefined
        ? { currentUsage: params.record.currentUsage }
        : {}),
      ...(params.record.agentCommands !== undefined
        ? { agentCommands: params.record.agentCommands }
        : {}),
      ...(params.record.agentModes !== undefined
        ? { agentModes: params.record.agentModes }
        : {}),
      createdAt: params.record.createdAt,
      updatedAt: params.record.updatedAt,
    },
    history: params.history,
  };
  if (params.promptHistory !== undefined) {
    bundle.promptHistory = params.promptHistory;
  }
  return bundle;
}

// Strict parse. Throws a zod error on malformed input — callers turn
// that into a 400 / -32602 InvalidParams response.
export function decodeBundle(raw: unknown): Bundle {
  return Bundle.parse(raw);
}
