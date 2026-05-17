import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { paths } from "./paths.js";

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem?: number },
) => Promise<Buffer>;

// Stored at ~/.hydra-acp/password-hash (mode 0600). Format is a single
// line: scrypt$N$r$p$saltHex$keyHex. Bump N (or switch the prefix to
// e.g. argon2id$...) later without breaking existing hashes.
function passwordHashPath(): string {
  return path.join(paths.home(), "password-hash");
}

// ~50ms on a 2024 laptop. Bump N if you want more work.
const DEFAULT_N = 1 << 15;
const DEFAULT_R = 8;
const DEFAULT_P = 1;
const KEY_LEN = 64;
const SALT_LEN = 16;
// scrypt's default maxmem (32 MiB) is too small for N=2^15. Allow up to
// 128 MiB so the work factor sticks.
const MAX_MEM = 128 * 1024 * 1024;

export async function setPassword(plaintext: string): Promise<void> {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new Error("password must be a non-empty string");
  }
  const salt = randomBytes(SALT_LEN);
  const key = await scryptAsync(plaintext, salt, KEY_LEN, {
    N: DEFAULT_N,
    r: DEFAULT_R,
    p: DEFAULT_P,
    maxmem: MAX_MEM,
  });
  const encoded =
    `scrypt$${DEFAULT_N}$${DEFAULT_R}$${DEFAULT_P}$${salt.toString("hex")}$${key.toString("hex")}\n`;
  await fs.mkdir(paths.home(), { recursive: true });
  await fs.writeFile(passwordHashPath(), encoded, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export async function hasPassword(): Promise<boolean> {
  try {
    const text = await fs.readFile(passwordHashPath(), "utf8");
    return text.trim().length > 0;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

export async function verifyPassword(plaintext: string): Promise<boolean> {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    return false;
  }
  let line: string;
  try {
    line = (await fs.readFile(passwordHashPath(), "utf8")).trim();
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      return false;
    }
    throw err;
  }
  const parts = line.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    return false;
  }
  const N = parseInt(parts[1]!, 10);
  const r = parseInt(parts[2]!, 10);
  const p = parseInt(parts[3]!, 10);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) {
    return false;
  }
  const salt = Buffer.from(parts[4]!, "hex");
  const expected = Buffer.from(parts[5]!, "hex");
  if (salt.length === 0 || expected.length === 0) {
    return false;
  }
  const actual = await scryptAsync(plaintext, salt, expected.length, {
    N,
    r,
    p,
    maxmem: MAX_MEM,
  });
  if (actual.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(actual, expected);
}

export async function deletePassword(): Promise<void> {
  try {
    await fs.unlink(passwordHashPath());
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== "ENOENT") {
      throw err;
    }
  }
}
