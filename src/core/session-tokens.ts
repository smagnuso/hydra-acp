import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { paths } from "./paths.js";

// Stored at ~/.hydra-acp/session-tokens.json (mode 0600). The plaintext
// token is never persisted — only sha256(token). Tokens are 32 bytes of
// entropy from crypto.randomBytes, so a fast hash is appropriate; we use
// it purely so a leak of the file doesn't hand over live credentials.

export interface SessionTokenRecord {
  id: string;
  hash: string;
  label?: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string;
}

export interface SessionTokenSummary {
  id: string;
  label?: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string;
}

export interface IssueOptions {
  label?: string;
  ttlSec?: number;
}

export interface IssuedSessionToken {
  id: string;
  token: string;
  expiresAt: string;
}

const TOKEN_PREFIX = "hydra_session_";
const DEFAULT_TTL_SEC = 60 * 60 * 24 * 30;
const ID_LENGTH = 12;
const TOKEN_BYTES = 32;
const WRITE_DEBOUNCE_MS = 50;

function tokensFilePath(): string {
  return path.join(paths.home(), "session-tokens.json");
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function generateId(): string {
  return randomHex(ID_LENGTH).slice(0, ID_LENGTH * 2);
}

function generateToken(): string {
  return `${TOKEN_PREFIX}${randomHex(TOKEN_BYTES)}`;
}

// In-memory store of session tokens, backed by a JSON file. Writes are
// debounced to keep verify-heavy traffic off the disk hot path.
export class SessionTokenStore {
  private records = new Map<string, SessionTokenRecord>(); // keyed by hash
  private writeTimer: NodeJS.Timeout | null = null;
  private writeInflight: Promise<void> | null = null;

  private constructor(records: SessionTokenRecord[]) {
    for (const r of records) {
      this.records.set(r.hash, r);
    }
  }

  static async load(): Promise<SessionTokenStore> {
    let records: SessionTokenRecord[] = [];
    try {
      const raw = await fs.readFile(tokensFilePath(), "utf8");
      const parsed = JSON.parse(raw) as { records?: SessionTokenRecord[] };
      if (parsed && Array.isArray(parsed.records)) {
        records = parsed.records.filter(isRecord);
      }
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "ENOENT") {
        throw err;
      }
    }
    const store = new SessionTokenStore(records);
    const removed = store.sweepExpired(new Date());
    if (removed > 0) {
      await store.flush();
    }
    return store;
  }

  async issue(opts: IssueOptions = {}): Promise<IssuedSessionToken> {
    const token = generateToken();
    const hash = sha256Hex(token);
    const id = generateId();
    const now = new Date();
    const ttlSec = opts.ttlSec && opts.ttlSec > 0 ? opts.ttlSec : DEFAULT_TTL_SEC;
    const expiresAt = new Date(now.getTime() + ttlSec * 1000);
    const record: SessionTokenRecord = {
      id,
      hash,
      label: opts.label,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      lastUsedAt: now.toISOString(),
    };
    this.records.set(hash, record);
    this.scheduleWrite();
    return { id, token, expiresAt: record.expiresAt };
  }

  // Verifies a presented token. Returns the matching record id (so the
  // caller can revoke it on logout) and bumps lastUsedAt; returns
  // undefined when no record matches or when the matched record has
  // expired.
  async verify(token: string): Promise<string | undefined> {
    if (typeof token !== "string" || !token.startsWith(TOKEN_PREFIX)) {
      return undefined;
    }
    const hash = sha256Hex(token);
    const record = this.records.get(hash);
    if (!record) {
      return undefined;
    }
    // Constant-time hash compare. Map lookup is already O(1); this is a
    // defense in depth so an attacker who has the hash file can't time
    // the lookup against the in-memory map shape.
    const expected = Buffer.from(record.hash, "hex");
    const actual = Buffer.from(hash, "hex");
    if (
      expected.length !== actual.length ||
      !timingSafeEqual(expected, actual)
    ) {
      return undefined;
    }
    const now = new Date();
    if (new Date(record.expiresAt).getTime() <= now.getTime()) {
      this.records.delete(hash);
      this.scheduleWrite();
      return undefined;
    }
    record.lastUsedAt = now.toISOString();
    this.scheduleWrite();
    return record.id;
  }

  async revoke(id: string): Promise<boolean> {
    for (const [hash, r] of this.records) {
      if (r.id === id) {
        this.records.delete(hash);
        this.scheduleWrite();
        return true;
      }
    }
    return false;
  }

  async revokeAll(): Promise<number> {
    const n = this.records.size;
    this.records.clear();
    this.scheduleWrite();
    return n;
  }

  list(): SessionTokenSummary[] {
    return Array.from(this.records.values())
      .map(({ id, label, createdAt, expiresAt, lastUsedAt }) => ({
        id,
        label,
        createdAt,
        expiresAt,
        lastUsedAt,
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  sweepExpired(now: Date = new Date()): number {
    let removed = 0;
    for (const [hash, r] of this.records) {
      if (new Date(r.expiresAt).getTime() <= now.getTime()) {
        this.records.delete(hash);
        removed += 1;
      }
    }
    if (removed > 0) {
      this.scheduleWrite();
    }
    return removed;
  }

  // Force any pending write to complete. Useful in tests and at shutdown.
  async flush(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    await this.persist();
  }

  private scheduleWrite(): void {
    if (this.writeTimer) {
      return;
    }
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.persist().catch(() => {
        // Errors are swallowed here so a transient disk hiccup doesn't
        // crash the daemon. The next write attempt will retry.
      });
    }, WRITE_DEBOUNCE_MS);
  }

  private async persist(): Promise<void> {
    if (this.writeInflight) {
      await this.writeInflight;
    }
    const records = Array.from(this.records.values());
    const payload = JSON.stringify({ records }, null, 2) + "\n";
    this.writeInflight = (async () => {
      await fs.mkdir(paths.home(), { recursive: true });
      await fs.writeFile(tokensFilePath(), payload, {
        encoding: "utf8",
        mode: 0o600,
      });
    })();
    try {
      await this.writeInflight;
    } finally {
      this.writeInflight = null;
    }
  }
}

function isRecord(value: unknown): value is SessionTokenRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.hash === "string" &&
    typeof v.createdAt === "string" &&
    typeof v.expiresAt === "string" &&
    typeof v.lastUsedAt === "string" &&
    (v.label === undefined || typeof v.label === "string")
  );
}
