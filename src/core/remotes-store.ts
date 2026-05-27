// Per-host cache of password-issued session tokens for
// `hydra session attach hydra://<host>/...`. Stored at
// ~/.hydra-acp/remotes.json with mode 0600.
//
// The cache is keyed by "host:port" so two daemons on the same host
// (different ports) don't collide, and so loopback entries never
// shadow a remote entry sharing the same hostname.
//
// On read, expired entries are sliced out and the file is rewritten
// in-place so the disk stays tidy. The daemon's
// SessionTokenStore.sweepExpired() does the server-side equivalent.

import { paths } from "./paths.js";
import { readJsonSafe, writeJsonAtomic } from "./json-store.js";

export interface RemoteCredential {
  // The password-issued session token returned by /v1/auth/login.
  // Presented to the daemon as a bearer for both REST and the /acp
  // WS upgrade. Long-lived (TTL configured per-issue on the daemon)
  // but revocable from either side.
  token: string;
  // ISO-8601 UTC timestamp. The daemon sets this; we cache it so we
  // can skip re-using a token we already know to be expired.
  expiresAt: string;
  // Optional human-readable label, shown by `hydra-acp auth list`
  // on the daemon side and surfaced in CLI listings on this side.
  // Falls back to the hostname when unset.
  label?: string;
}

interface RemotesFile {
  version: 1;
  entries: Record<string, RemoteCredential>;
}

export function hostKey(host: string, port: number): string {
  return `${host}:${port}`;
}

export class RemotesStore {
  private data: RemotesFile;

  private constructor(data: RemotesFile) {
    this.data = data;
  }

  static async load(): Promise<RemotesStore> {
    const data = await readFile();
    // Drop already-expired entries on load so callers don't have to
    // re-check. Save back only if anything changed so we don't churn
    // disk on every CLI invocation.
    const now = Date.now();
    const filtered: Record<string, RemoteCredential> = {};
    let dropped = false;
    for (const [key, entry] of Object.entries(data.entries)) {
      if (isExpired(entry, now)) {
        dropped = true;
        continue;
      }
      filtered[key] = entry;
    }
    const final: RemotesFile = { version: 1, entries: filtered };
    if (dropped) {
      await writeFile(final);
    }
    return new RemotesStore(final);
  }

  get(host: string, port: number): RemoteCredential | undefined {
    const entry = this.data.entries[hostKey(host, port)];
    if (!entry) {
      return undefined;
    }
    if (isExpired(entry, Date.now())) {
      return undefined;
    }
    return entry;
  }

  async set(
    host: string,
    port: number,
    credential: RemoteCredential,
  ): Promise<void> {
    this.data.entries[hostKey(host, port)] = credential;
    await writeFile(this.data);
  }

  async delete(host: string, port: number): Promise<boolean> {
    const key = hostKey(host, port);
    if (!(key in this.data.entries)) {
      return false;
    }
    delete this.data.entries[key];
    await writeFile(this.data);
    return true;
  }

  list(): ReadonlyArray<{ host: string; port: number; entry: RemoteCredential }> {
    const out: Array<{ host: string; port: number; entry: RemoteCredential }> = [];
    for (const [key, entry] of Object.entries(this.data.entries)) {
      const split = splitKey(key);
      if (split) {
        out.push({ host: split.host, port: split.port, entry });
      }
    }
    return out;
  }
}

function isExpired(entry: RemoteCredential, nowMs: number): boolean {
  const t = Date.parse(entry.expiresAt);
  if (!Number.isFinite(t)) {
    // Unparseable timestamp — treat as expired so we don't keep a
    // stale entry around forever. The next login will replace it.
    return true;
  }
  return t <= nowMs;
}

function splitKey(key: string): { host: string; port: number } | null {
  const colon = key.lastIndexOf(":");
  if (colon < 0) {
    return null;
  }
  const host = key.slice(0, colon);
  const port = Number(key.slice(colon + 1));
  if (!Number.isInteger(port)) {
    return null;
  }
  return { host, port };
}

async function readFile(): Promise<RemotesFile> {
  const parsed = await readJsonSafe(paths.remotes());
  if (parsed === undefined) {
    return { version: 1, entries: {} };
  }
  return normalise(parsed);
}

function normalise(raw: unknown): RemotesFile {
  if (!raw || typeof raw !== "object") {
    return { version: 1, entries: {} };
  }
  const obj = raw as Record<string, unknown>;
  const entries =
    obj.entries && typeof obj.entries === "object"
      ? (obj.entries as Record<string, unknown>)
      : {};
  const out: Record<string, RemoteCredential> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (!value || typeof value !== "object") {
      continue;
    }
    const v = value as Record<string, unknown>;
    if (typeof v.token !== "string" || typeof v.expiresAt !== "string") {
      continue;
    }
    const cred: RemoteCredential = {
      token: v.token,
      expiresAt: v.expiresAt,
    };
    if (typeof v.label === "string") {
      cred.label = v.label;
    }
    out[key] = cred;
  }
  return { version: 1, entries: out };
}

async function writeFile(data: RemotesFile): Promise<void> {
  await writeJsonAtomic(paths.remotes(), data, { mode: 0o600 });
}
