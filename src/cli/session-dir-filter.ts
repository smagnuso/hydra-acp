// Directory scoping for the session listing (`session list --dir`).
// Kept out of the command module so the TUI picker can reuse it.

import * as path from "node:path";
import { expandHome } from "../core/config.js";

export interface DirFilterable {
  cwd: string;
  // Isolated sessions record the workspace in `cwd`; the tree the user
  // thinks of as "the directory" is sourceCwd.
  workspace?: { sourceCwd: string };
}

// Normalizes `--dir` input the same way the import prompt normalizes a
// cwd: tilde/$HOME expansion, then resolve against the process cwd. No
// realpath — session records hold the path as it was given, so
// canonicalizing here would stop a symlinked source tree from matching
// its own sessions.
export function resolveDirFilter(input: string): string {
  const trimmed = input.trim();
  const resolved = path.resolve(expandHome(trimmed.length === 0 ? "." : trimmed));
  if (resolved.length > 1 && resolved.endsWith(path.sep)) {
    return resolved.slice(0, -1);
  }
  return resolved;
}

// True when the session lives at `dir` or anywhere beneath it. Matches
// on either recorded path, so an isolated session is found by its source
// tree and by its workspace.
export function sessionMatchesDir(s: DirFilterable, dir: string): boolean {
  const candidates = [s.cwd, s.workspace?.sourceCwd];
  const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || candidate.length === 0) {
      continue;
    }
    const normalized = path.resolve(candidate);
    if (normalized === dir || normalized.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}
