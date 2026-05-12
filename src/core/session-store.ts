import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import { paths } from "./paths.js";

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
  upstreamSessionId: z.string(),
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
  upstreamSessionId: string;
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
    upstreamSessionId: args.upstreamSessionId,
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
