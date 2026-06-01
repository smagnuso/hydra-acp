// Tombstones: persistent record that hydra deleted a session, so the
// periodic agent sync (SessionManager.syncFromAgent) won't reimport
// the same upstream entry under a fresh hydra_session_* id. One file
// per (agentId, upstreamSessionId) under sessions/.tombstones/<agent>/.
// File existence is the source of truth; the JSON contents are
// diagnostic plus the upstreamUpdatedAt snapshot that lets us
// resurrect the tombstone if the agent reports the conversation has
// advanced since we deleted it (i.e. the user picked it back up).
import * as fs from "node:fs/promises";
import { z } from "zod";
import { paths } from "./paths.js";
import { readJsonSafe, writeJsonAtomic } from "./json-store.js";

export const Tombstone = z.object({
  version: z.literal(1),
  agentId: z.string(),
  upstreamSessionId: z.string(),
  deletedAt: z.string(),
  // Agent's last-reported updatedAt for this session at the moment we
  // deleted, snapshotted from SessionRecord.updatedAt. Compared against
  // the listing's updatedAt on subsequent syncs to detect that the
  // conversation has moved on (the agent / user revived it), in which
  // case the tombstone is dropped and the session re-imports. Absent
  // when the deleted record never carried a meaningful updatedAt.
  upstreamUpdatedAt: z.string().optional(),
  cwd: z.string().optional(),
  title: z.string().optional(),
  reason: z.enum(["user", "expired"]).optional(),
});
export type Tombstone = z.infer<typeof Tombstone>;

export class TombstoneStore {
  async add(t: Omit<Tombstone, "version">): Promise<void> {
    const full: Tombstone = { version: 1, ...t };
    await writeJsonAtomic(
      paths.tombstoneFile(t.agentId, t.upstreamSessionId),
      full,
      { mode: 0o600 },
    );
  }

  async has(agentId: string, upstreamSessionId: string): Promise<boolean> {
    try {
      await fs.access(paths.tombstoneFile(agentId, upstreamSessionId));
      return true;
    } catch {
      return false;
    }
  }

  // Returns the tombstone payload if the file exists. An unreadable or
  // unparseable file still counts as a tombstone — we synthesize a
  // bare record so the caller's "is this dead?" check stays correct,
  // but with no upstreamUpdatedAt the resurrection rule treats any
  // listed updatedAt as advancement (see SessionManager.syncFromAgent).
  async read(
    agentId: string,
    upstreamSessionId: string,
  ): Promise<Tombstone | undefined> {
    const file = paths.tombstoneFile(agentId, upstreamSessionId);
    const parsed = await readJsonSafe(file);
    if (parsed === undefined) {
      if (await this.has(agentId, upstreamSessionId)) {
        return {
          version: 1,
          agentId,
          upstreamSessionId,
          deletedAt: new Date(0).toISOString(),
        };
      }
      return undefined;
    }
    try {
      return Tombstone.parse(parsed);
    } catch {
      return {
        version: 1,
        agentId,
        upstreamSessionId,
        deletedAt: new Date(0).toISOString(),
      };
    }
  }

  async remove(agentId: string, upstreamSessionId: string): Promise<void> {
    try {
      await fs.unlink(paths.tombstoneFile(agentId, upstreamSessionId));
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "ENOENT") {
        throw err;
      }
    }
    // Best-effort: drop the now-empty agent dir so a `tombstones list`
    // doesn't show a ghost agent. ENOTEMPTY just means another
    // tombstone is still there for the same agent — fine.
    try {
      await fs.rmdir(paths.tombstoneAgentDir(agentId));
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "ENOENT" && e.code !== "ENOTEMPTY") {
        throw err;
      }
    }
  }

  async list(agentId?: string): Promise<Tombstone[]> {
    if (agentId !== undefined) {
      return this.listForAgent(agentId);
    }
    let agents: string[];
    try {
      agents = await fs.readdir(paths.tombstonesDir());
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        return [];
      }
      throw err;
    }
    const out: Tombstone[] = [];
    for (const enc of agents) {
      let decoded: string;
      try {
        decoded = decodeURIComponent(enc);
      } catch {
        continue;
      }
      out.push(...(await this.listForAgent(decoded)));
    }
    return out;
  }

  private async listForAgent(agentId: string): Promise<Tombstone[]> {
    let files: string[];
    try {
      files = await fs.readdir(paths.tombstoneAgentDir(agentId));
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        return [];
      }
      throw err;
    }
    const out: Tombstone[] = [];
    for (const f of files) {
      let upstreamId: string;
      try {
        upstreamId = decodeURIComponent(f);
      } catch {
        continue;
      }
      const t = await this.read(agentId, upstreamId);
      if (t) {
        out.push(t);
      }
    }
    return out;
  }
}

// Resurrection rule used by syncFromAgent. The agent's reported
// updatedAt must be strictly greater than the snapshot we took at
// delete time; an equal value means no progress since deletion. A
// tombstone with no upstreamUpdatedAt (deleted before that field was
// populated, or never reported by the agent) accepts any listed
// updatedAt as advancement — better to resurrect what might be a live
// conversation than to silently swallow it forever.
export function shouldResurrectFromUpstream(
  tombstone: Tombstone,
  listingUpdatedAt: string | undefined,
): boolean {
  if (listingUpdatedAt === undefined) {
    return false;
  }
  if (tombstone.upstreamUpdatedAt === undefined) {
    return true;
  }
  return listingUpdatedAt > tombstone.upstreamUpdatedAt;
}
