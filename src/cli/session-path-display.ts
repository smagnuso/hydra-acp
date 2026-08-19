// How a file path recorded in a session's history is shown to a human.
//
// Two problems, one rule. Recorded paths are absolute, so a diff header
// reads `a//home/u/dev/repo/src/tui/app.ts` (note the double slash — the
// renderer prepends `a/` to something already rooted) where git would say
// `a/src/tui/app.ts`. And a workspace-isolated session records every edit
// under its workspace, so the same file reads as
// `/home/u/.hydra-acp/workspaces/<hash>/<label>/src/tui/app.ts` — a path
// that tells you nothing about which project it belongs to, and that stops
// existing at all once the workspace is merged or removed.
//
// The rule: map into source-tree coordinates, then show relative to the
// session's root. A path outside that root keeps its absolute form
// (home-shortened) rather than growing a `../../..` prefix, because for
// those the absolute path IS the informative rendering.
//
// Presentation only. `--json` and the REST endpoints keep raw absolute
// paths: the planner's verified_diff audit reads /v1/sessions/:id/diff,
// and `?paths=` filters against the recorded values.

import * as path from "node:path";
import { shortenHomePath } from "../core/paths.js";
import { workspacePathNormalizer } from "../core/history-search.js";

export interface SessionPathContext {
  cwd: string;
  // `path` is the workspace root; it equals `cwd` while the binding is
  // live, and the list-entry shape omits it, hence the fallback.
  workspace?: { sourceCwd: string; path?: string };
}

// Where the path is going to be printed, which decides only what happens
// to a path that escapes the session root:
//   "list" — home-shortened (`~/.claude/plans/x.md`). Right for a human
//            list of files.
//   "diff" — left fully absolute. A `~` inside `--- a/…` would be a lie:
//            tilde is shell syntax, not a path, and the header is supposed
//            to name a file. The resulting `a//tmp/x.mjs` double slash is
//            then a feature — it marks the path as absolute, which is
//            exactly what distinguishes it from a root-relative one.
export type PathDisplayStyle = "list" | "diff";

export function makeSessionPathDisplay(
  session: SessionPathContext | undefined,
  style: PathDisplayStyle = "list",
): (p: string) => string {
  const escaped = (p: string): string =>
    style === "diff" ? p : shortenHomePath(p);
  if (session === undefined) {
    return (p) => p;
  }
  const normalize =
    workspacePathNormalizer({
      cwd: session.workspace?.path ?? session.cwd,
      ...(session.workspace !== undefined
        ? { workspace: { sourceCwd: session.workspace.sourceCwd } }
        : {}),
    }) ?? ((p: string) => p);
  const root = trimSlash(session.workspace?.sourceCwd ?? session.cwd);
  return (p: string): string => {
    const mapped = normalize(p);
    if (root.length === 0) {
      return escaped(mapped);
    }
    const rel = path.relative(root, mapped);
    if (rel.length === 0 || rel.startsWith("..") || path.isAbsolute(rel)) {
      return escaped(mapped);
    }
    return rel;
  };
}

function trimSlash(p: string): string {
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}
