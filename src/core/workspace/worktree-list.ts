// Parser for `git worktree list --porcelain`.
//
// Extracted from git-provider.ts so the record shape can be tested
// directly, following the same reasoning as git-status.ts: the format is
// line-oriented with a mix of "key value" and bare-key attributes, so the
// obvious split-on-whitespace implementation quietly mangles paths
// containing spaces and silently drops the valueless attributes that
// matter most (`locked`, `prunable`, `detached`).
//
// Format (git-worktree(1), "Porcelain Format"): records separated by a
// blank line. `worktree <path>` opens each record. `locked` and
// `prunable` may appear bare or with a trailing reason. A `bare` main
// worktree has no HEAD or branch line at all.
//
//   worktree /home/u/proj
//   HEAD 0e78d0d...
//   branch refs/heads/main
//
//   worktree /home/u/.hydra-acp/workspaces/ab12/feature
//   HEAD 4f2a1b9...
//   branch refs/heads/hydra/feature
//   locked held by hydra session S1
//
// Paths are emitted verbatim by git and may contain spaces, so the value
// is everything after the first space rather than the second field.

export interface WorktreeEntry {
  path: string;
  head?: string;
  /** Full ref, e.g. "refs/heads/main". Absent when detached or bare. */
  branch?: string;
  bare: boolean;
  detached: boolean;
  /** Present when locked. Empty string means locked with no stated reason. */
  lockedReason?: string;
  /** Present when git considers it prunable. */
  prunableReason?: string;
}

function splitKeyValue(line: string): { key: string; value: string } {
  const space = line.indexOf(" ");
  if (space === -1) {
    return { key: line, value: "" };
  }
  return { key: line.slice(0, space), value: line.slice(space + 1) };
}

export function parseWorktreeListPorcelain(stdout: string): WorktreeEntry[] {
  const out: WorktreeEntry[] = [];
  let current: WorktreeEntry | undefined;

  const flush = (): void => {
    if (current !== undefined) {
      out.push(current);
      current = undefined;
    }
  };

  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.length === 0) {
      flush();
      continue;
    }
    const { key, value } = splitKeyValue(line);
    if (key === "worktree") {
      flush();
      current = { path: value, bare: false, detached: false };
      continue;
    }
    if (current === undefined) {
      // Attribute line with no open record. Malformed input; skip rather
      // than fabricate an entry with no path.
      continue;
    }
    switch (key) {
      case "HEAD":
        current.head = value;
        break;
      case "branch":
        current.branch = value;
        break;
      case "bare":
        current.bare = true;
        break;
      case "detached":
        current.detached = true;
        break;
      case "locked":
        current.lockedReason = value;
        break;
      case "prunable":
        current.prunableReason = value;
        break;
      default:
        break;
    }
  }
  flush();
  return out;
}

/** Strip "refs/heads/" for display. Leaves other ref namespaces intact. */
export function shortBranchName(ref: string | undefined): string | undefined {
  if (ref === undefined) {
    return undefined;
  }
  const prefix = "refs/heads/";
  return ref.startsWith(prefix) ? ref.slice(prefix.length) : ref;
}
