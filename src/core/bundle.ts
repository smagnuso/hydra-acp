import { z } from "zod";
import { PersistedAgentCommand, type SessionRecord } from "./session-store.js";
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
  agentId: z.string(),
  cwd: z.string(),
  title: z.string().optional(),
  currentModel: z.string().optional(),
  currentMode: z.string().optional(),
  agentCommands: z.array(PersistedAgentCommand).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const Bundle = z.object({
  version: z.literal(1),
  exportedAt: z.string(),
  exportedFrom: z.object({
    hydraVersion: z.string(),
    machine: z.string(),
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
}

export function encodeBundle(params: EncodeBundleParams): Bundle {
  const bundle: Bundle = {
    version: 1,
    exportedAt: new Date().toISOString(),
    exportedFrom: {
      hydraVersion: params.hydraVersion,
      machine: params.machine,
    },
    session: {
      sessionId: params.record.sessionId,
      lineageId: params.record.lineageId,
      agentId: params.record.agentId,
      cwd: params.record.cwd,
      ...(params.record.title !== undefined ? { title: params.record.title } : {}),
      ...(params.record.currentModel !== undefined
        ? { currentModel: params.record.currentModel }
        : {}),
      ...(params.record.currentMode !== undefined
        ? { currentMode: params.record.currentMode }
        : {}),
      ...(params.record.agentCommands !== undefined
        ? { agentCommands: params.record.agentCommands }
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
