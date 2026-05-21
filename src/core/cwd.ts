// Shared local-cwd validation. Used by `sessions import --cwd`, the
// TUI's import-cwd prompt, and (eventually) the daemon's
// /v1/sessions/import route so all three accept the same input shapes
// (tilde / $HOME expansion, relative paths, etc.) and report the same
// error reasons.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { expandHome } from "./config.js";

export type CwdValidation =
  | { ok: true; path: string }
  | { ok: false; reason: string };

export async function validateLocalCwd(input: string): Promise<CwdValidation> {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "path is empty" };
  }
  const resolved = path.resolve(expandHome(trimmed));
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(resolved);
  } catch {
    return { ok: false, reason: `${resolved} does not exist` };
  }
  if (!stat.isDirectory()) {
    return { ok: false, reason: `${resolved} is not a directory` };
  }
  return { ok: true, path: resolved };
}
