import * as fs from "node:fs/promises";
import { paths } from "./paths.js";

// 32 random bytes encoded as hex, prefixed for log-grep friendliness.
export function generateServiceToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, "0");
  }
  return `hydra_token_${hex}`;
}

// Read the token file. Returns undefined if absent or empty. Does not
// migrate the legacy in-config form — that lives in config.ts since it
// needs to rewrite config.json.
export async function readServiceToken(): Promise<string | undefined> {
  try {
    const text = await fs.readFile(paths.authToken(), "utf8");
    const trimmed = text.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
}

export async function loadServiceToken(): Promise<string> {
  const token = await readServiceToken();
  if (!token) {
    throw new Error(
      `No service token found at ${paths.authToken()}. Run \`hydra-acp init\` to create one.`,
    );
  }
  return token;
}

export async function writeServiceToken(token: string): Promise<void> {
  await fs.mkdir(paths.home(), { recursive: true });
  await fs.writeFile(paths.authToken(), token + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
}

// First-run helper: if no token is on disk, generate and persist one,
// then return it. Used by entry points that imply "actually running
// hydra" (daemon start, shim, TUI) so a fresh user doesn't have to
// call `hydra-acp init` first.
export async function ensureServiceToken(): Promise<string> {
  const existing = await readServiceToken();
  if (existing) {
    return existing;
  }
  const token = generateServiceToken();
  await writeServiceToken(token);
  process.stderr.write(
    `hydra-acp: initialized ${paths.authToken()} with a fresh service token.\n`,
  );
  return token;
}

export async function rotateServiceToken(): Promise<string> {
  const token = generateServiceToken();
  await writeServiceToken(token);
  return token;
}
