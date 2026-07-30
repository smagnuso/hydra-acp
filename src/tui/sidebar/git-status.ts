// Parser for `git status --porcelain=v2 --branch`.
//
// Extracted from app.ts so the field layout can be tested directly:
// porcelain v2 puts the path LAST but with a different number of
// preceding fields per record type, and the path itself may contain
// spaces. Splitting on whitespace and taking the last field — the
// obvious implementation — silently truncates "src/my file.ts" to
// "file.ts".
//
// Record layouts (git-status(1), "Porcelain Format Version 2"):
//   1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
//   2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path><sep><origPath>
//   u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
//   ? <path>
//   ! <path>                                    (ignored, needs --ignored)
// The separator in a rename record is a TAB in line-oriented output (it
// is NUL under -z, which we don't use).

import { resolve as resolvePath } from "node:path";
import type { SidebarGitFile, SidebarGitStatus } from "./types.js";

// Field counts BEFORE the path field, per record type.
const PREFIX_FIELDS: Record<string, number> = {
  "1": 8,
  "2": 9,
  u: 10,
};

// Split off the first `count` whitespace-separated fields and return the
// untouched remainder, which is the path (possibly containing spaces).
function pathAfterFields(line: string, count: number): string {
  let idx = 0;
  for (let field = 0; field < count; field++) {
    const next = line.indexOf(" ", idx);
    if (next === -1) {
      return "";
    }
    idx = next + 1;
  }
  return line.slice(idx);
}

export function emptyGitStatus(): SidebarGitStatus {
  return {
    branch: null,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    ahead: 0,
    behind: 0,
    files: [],
  };
}

// `topLevel` is the repo root; git reports paths relative to it, which is
// not necessarily the session cwd. When it's null the counts are still
// parsed but no file rows are produced — a path we can't make absolute
// isn't safe to hand to an editor.
export function parseGitPorcelainV2(
  out: string,
  topLevel: string | null,
): SidebarGitStatus {
  const status = emptyGitStatus();
  const addFile = (rawPath: string, state: SidebarGitFile["state"]): void => {
    if (topLevel === null || rawPath === "") {
      return;
    }
    status.files.push({ path: resolvePath(topLevel, rawPath), state });
  };
  for (const line of out.split("\n")) {
    if (line.startsWith("# branch.head ")) {
      const head = line.slice("# branch.head ".length).trim();
      // Detached HEAD reports the literal "(detached)".
      status.branch = head === "(detached)" ? null : head;
      continue;
    }
    if (line.startsWith("# branch.ab ")) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m !== null) {
        status.ahead = Number(m[1]);
        status.behind = Number(m[2]);
      }
      continue;
    }
    if (line.startsWith("? ")) {
      status.untracked++;
      addFile(line.slice(2), "new");
      continue;
    }
    const kind = line.slice(0, 1);
    const prefix = PREFIX_FIELDS[kind];
    if (prefix === undefined || line[1] !== " ") {
      continue;
    }
    const xy = line.slice(2, 4);
    const staged = xy[0] !== undefined && xy[0] !== ".";
    const unstaged = xy[1] !== undefined && xy[1] !== ".";
    if (staged) {
      status.staged++;
    }
    if (unstaged) {
      status.unstaged++;
    }
    // Rename records append "\t<origPath>"; the new name is the one that
    // exists on disk, so it's the one worth opening.
    const rawPath = pathAfterFields(line, prefix).split("\t")[0] ?? "";
    // A file that is both staged and dirty reads as dirty: the unstaged
    // part is what the user still has to deal with.
    addFile(rawPath, unstaged ? "dirty" : "staged");
  }
  return status;
}
