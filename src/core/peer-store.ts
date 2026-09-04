// Daemon-owned registry of federated peer daemons, backing `hydra
// remote add/list/remove`. Stored at ~/.hydra-acp/peers.json (mode
// 0600).
//
// This is the server-side sibling of RemotesStore: RemotesStore is a
// per-human-machine cache of credentials a *client* (CLI/TUI) uses to
// attach to other daemons; PeerStore is credentials this *daemon*
// holds so it can act as a client of its peers on its own (forwarding
// requests, listing remote sessions). Deliberately a separate file —
// they answer different questions ("what have I logged into?" vs.
// "what do I proxy for?") even though the record shape looks similar.
//
// Keyed by `name`, a human-chosen local alias (`hydra remote add
// <name> <host[:port]>`, mirroring `git remote add <name> <url>`)
// rather than by host:port directly. This is deliberate: `name` is
// also what appears in federated session ids (see
// foreign-session-id.ts) and in `hydra://` links, so a peer's raw
// network address never has to leak into anything a client sees.

import { paths } from "./paths.js";
import { readJsonSafe, writeJsonAtomic } from "./json-store.js";

// Mirrors git's remote-name restrictions closely enough for our
// purposes: no colons (that's the foreign-session-id separator) or
// slashes (would break path segments), no leading dash, non-empty.
export const PEER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface PeerRecord {
  name: string;
  host: string;
  port: number;
  // Session token issued by the peer's /v1/auth/login. Never the
  // peer's password — that's used once at `remote add` time and
  // discarded; see peer-login.ts.
  token: string;
  expiresAt: string;
  // Label recorded on the *peer's* token (visible in the peer's own
  // `hydra-acp auth list`) — independent of `name`, which only this
  // daemon ever sees.
  label?: string;
  addedAt: string;
}

export interface PeerSummary {
  name: string;
  host: string;
  port: number;
  expiresAt: string;
  label?: string;
  addedAt: string;
}

interface PeersFile {
  version: 1;
  entries: Record<string, PeerRecord>;
}

export class PeerStore {
  private data: PeersFile;

  private constructor(data: PeersFile) {
    this.data = data;
  }

  static async load(): Promise<PeerStore> {
    const parsed = await readJsonSafe(paths.peers());
    return new PeerStore(normalise(parsed));
  }

  get(name: string): PeerRecord | undefined {
    return this.data.entries[name];
  }

  // Upsert. `hydra remote add` re-running against an existing name is
  // the documented way to refresh a token nearing expiry (see
  // routes/remotes.ts) — unlike `git remote add`, this deliberately
  // does not error on a name that already exists.
  async set(record: PeerRecord): Promise<void> {
    this.data.entries[record.name] = record;
    await writeFile(this.data);
  }

  async delete(name: string): Promise<boolean> {
    if (!(name in this.data.entries)) {
      return false;
    }
    delete this.data.entries[name];
    await writeFile(this.data);
    return true;
  }

  list(): PeerSummary[] {
    return Object.values(this.data.entries)
      .map(({ name, host, port, expiresAt, label, addedAt }) => ({
        name,
        host,
        port,
        expiresAt,
        label,
        addedAt,
      }))
      .sort((a, b) => a.addedAt.localeCompare(b.addedAt));
  }
}

function normalise(raw: unknown): PeersFile {
  if (!raw || typeof raw !== "object") {
    return { version: 1, entries: {} };
  }
  const obj = raw as Record<string, unknown>;
  const entries =
    obj.entries && typeof obj.entries === "object"
      ? (obj.entries as Record<string, unknown>)
      : {};
  const out: Record<string, PeerRecord> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (!value || typeof value !== "object") {
      continue;
    }
    const v = value as Record<string, unknown>;
    if (
      typeof v.name !== "string" ||
      typeof v.host !== "string" ||
      typeof v.port !== "number" ||
      typeof v.token !== "string" ||
      typeof v.expiresAt !== "string" ||
      typeof v.addedAt !== "string"
    ) {
      continue;
    }
    const record: PeerRecord = {
      name: v.name,
      host: v.host,
      port: v.port,
      token: v.token,
      expiresAt: v.expiresAt,
      addedAt: v.addedAt,
    };
    if (typeof v.label === "string") {
      record.label = v.label;
    }
    out[key] = record;
  }
  return { version: 1, entries: out };
}

async function writeFile(data: PeersFile): Promise<void> {
  await writeJsonAtomic(paths.peers(), data, { mode: 0o600 });
}
