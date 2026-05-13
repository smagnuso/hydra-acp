import * as fs from "node:fs/promises";
import * as path from "node:path";
import { customAlphabet } from "nanoid";
import { z } from "zod";
import { paths } from "./paths.js";

// Mirror the alphabet/length used for session ids (see session.ts). Plain
// alphanumeric, length 16 → ~95 bits — collisions across a personal
// fleet are vanishingly unlikely.
const HYDRA_ID_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const generateRawId = customAlphabet(HYDRA_ID_ALPHABET, 16);

export const HYDRA_LINEAGE_PREFIX = "hydra_lineage_";

// Stable identifier set once when a session is first created. Preserved
// through every export/import so re-importing the same session (even
// after multi-hop transfers A→B→C→A) can be detected and either
// rejected or replaced. Distinct from sessionId, which is regenerated
// fresh on every import to avoid collisions in the local namespace.
export function generateLineageId(): string {
  return `${HYDRA_LINEAGE_PREFIX}${generateRawId()}`;
}

// One agent-advertised command. Shape mirrors the
// available_commands_update notification's entries (name + description),
// stored persistently here so attach responses can deliver the merged
// (hydra ∪ agent) command list to clients without depending on history
// replay of a notification that may have aged out.
export const PersistedAgentCommand = z.object({
  name: z.string(),
  description: z.string().optional(),
});
export type PersistedAgentCommand = z.infer<typeof PersistedAgentCommand>;

export const SessionRecord = z.object({
  version: z.literal(1),
  sessionId: z.string(),
  // Optional for back-compat with records written before this field
  // existed; mergeForPersistence generates one on next write so any
  // touched session converges to having a lineageId. A record that
  // never gets written again (truly cold and untouched) just won't
  // participate in lineage-based dedup, which is correct — it was
  // never exported, so no incoming bundle can claim its lineage.
  lineageId: z.string().optional(),
  upstreamSessionId: z.string(),
  // When non-empty, marks a session that was created by import and is
  // waiting for its first attach to bootstrap a fresh upstream agent
  // and replay the imported history as a takeover transcript. The
  // origin's local id at export time, kept for debuggability and as a
  // breadcrumb in `sessions list` (informational, not used for routing).
  importedFromSessionId: z.string().optional(),
  agentId: z.string(),
  cwd: z.string(),
  title: z.string().optional(),
  agentArgs: z.array(z.string()).optional(),
  // Snapshot of "what is currently true about this session" carried in
  // meta.json so a late-attaching or cold-resurrected client can be
  // told via the attach response _meta without depending on history
  // replay of a snapshot-shaped notification.
  currentModel: z.string().optional(),
  currentMode: z.string().optional(),
  agentCommands: z.array(PersistedAgentCommand).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SessionRecord = z.infer<typeof SessionRecord>;

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function assertSafeId(id: string): void {
  if (!SESSION_ID_PATTERN.test(id)) {
    throw new Error(`unsafe session id: ${id}`);
  }
}

export class SessionStore {
  async write(record: Omit<SessionRecord, "version">): Promise<void> {
    assertSafeId(record.sessionId);
    await fs.mkdir(paths.sessionDir(record.sessionId), { recursive: true });
    const full: SessionRecord = { version: 1, ...record };
    await fs.writeFile(
      paths.sessionFile(record.sessionId),
      JSON.stringify(full, null, 2) + "\n",
      { encoding: "utf8", mode: 0o600 },
    );
  }

  async read(sessionId: string): Promise<SessionRecord | undefined> {
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      return undefined;
    }
    let raw: string;
    try {
      raw = await fs.readFile(paths.sessionFile(sessionId), "utf8");
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        return undefined;
      }
      throw err;
    }
    try {
      return SessionRecord.parse(JSON.parse(raw));
    } catch {
      return undefined;
    }
  }

  async delete(sessionId: string): Promise<void> {
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      return;
    }
    try {
      await fs.unlink(paths.sessionFile(sessionId));
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "ENOENT") {
        throw err;
      }
    }
    // Best-effort cleanup: if no other tenant (transcript, etc.) is
    // left in the session dir, drop it. Both this and
    // TranscriptStore.delete attempt this; whichever runs last (after
    // both files are gone) is the one that succeeds.
    try {
      await fs.rmdir(paths.sessionDir(sessionId));
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "ENOENT" && e.code !== "ENOTEMPTY") {
        throw err;
      }
    }
  }

  // Find a persisted session by lineageId. Used by SessionManager.import
  // to detect bundles that have already been imported (lineageId match)
  // so we can either error out or, with replace:true, overwrite.
  // Returns undefined if no record has that lineageId. Records that
  // pre-date the lineageId field simply don't match — which is
  // correct: they were never exported, so no incoming bundle can
  // legitimately claim their lineage.
  async findByLineageId(lineageId: string): Promise<SessionRecord | undefined> {
    if (lineageId.length === 0) {
      return undefined;
    }
    const all = await this.list().catch(() => []);
    for (const record of all) {
      if (record.lineageId === lineageId) {
        return record;
      }
    }
    return undefined;
  }

  async list(): Promise<SessionRecord[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(paths.sessionsDir());
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        return [];
      }
      throw err;
    }
    const records: SessionRecord[] = [];
    for (const entry of entries) {
      // Each session is a directory under sessions/; non-conforming
      // names get filtered by assertSafeId via read().
      const record = await this.read(entry);
      if (record) {
        records.push(record);
      }
    }
    return records;
  }
}

export function recordFromMemorySession(args: {
  sessionId: string;
  lineageId?: string;
  upstreamSessionId: string;
  importedFromSessionId?: string;
  agentId: string;
  cwd: string;
  title?: string;
  agentArgs?: string[];
  currentModel?: string;
  currentMode?: string;
  agentCommands?: PersistedAgentCommand[];
  createdAt?: string;
  updatedAt?: string;
}): Omit<SessionRecord, "version"> {
  const now = new Date().toISOString();
  return {
    sessionId: args.sessionId,
    lineageId: args.lineageId,
    upstreamSessionId: args.upstreamSessionId,
    importedFromSessionId: args.importedFromSessionId,
    agentId: args.agentId,
    cwd: args.cwd,
    title: args.title,
    agentArgs: args.agentArgs,
    currentModel: args.currentModel,
    currentMode: args.currentMode,
    agentCommands: args.agentCommands,
    createdAt: args.createdAt ?? now,
    updatedAt: args.updatedAt ?? now,
  };
}

void path;
