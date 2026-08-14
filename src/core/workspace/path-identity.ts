// Making an isolated agent understand where it is.
//
// The agent runs in a workspace; the user thinks and types in terms of
// their own tree. "Look at ~/dev/proj/foo.cpp" names a real file that is
// NOT the one the agent should touch, and nothing about the request
// looks wrong.
//
// Three failures, in increasing order of damage:
//
//   - the agent reads the source copy and reasons about the wrong branch
//   - the agent WRITES to the source tree, voiding the isolation the
//     user asked for
//   - the agent decides the workspace is broken and "repairs" it, e.g.
//     re-adding an uninitialized submodule's contents as ordinary files,
//     which silently corrupts the eventual integration
//
// The daemon cannot intercept the agent's own file I/O: it observes tool
// calls as notifications, after the write. So prevention has to happen
// where the daemon genuinely sits, which is in front of the prompt.
//
// Two mechanisms here, both pure and both tested directly:
//
//   1. rewriteSourcePaths — the reliable one. Absolute paths under the
//      source tree become their workspace equivalents before the agent
//      ever sees them.
//   2. buildWorkspacePreamble — the advisory one, for everything a
//      rewrite cannot express (why .git is a file, why submodules are
//      empty, prefer repo-relative paths).

/** Escape a string for literal use inside a RegExp. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface RewriteResult {
  text: string;
  /** Paths that were rewritten, in order of first appearance. */
  rewritten: string[];
}

/**
 * Rewrite absolute source-tree paths in prompt text to their workspace
 * equivalents.
 *
 * Rewrites rather than merely annotating: an annotated prompt still
 * leaves the original string in front of the agent, and it will
 * reproduce it verbatim in a tool call. The substitution is reported so
 * the caller can tell the user what changed, since a path silently
 * differing from what they typed is its own kind of confusing.
 *
 * Only matches at a path boundary (the source root followed by `/` or
 * end-of-token), so `/home/u/project-notes` is untouched while
 * `/home/u/project/src/a.ts` is rewritten. Bare mentions of the source
 * root with no trailing path are left alone: "the repo at /home/u/proj"
 * is prose about the project, not a file reference.
 */
export function rewriteSourcePaths(
  text: string,
  sourceCwd: string,
  workspacePath: string,
): RewriteResult {
  if (sourceCwd.length === 0 || sourceCwd === workspacePath) {
    return { text, rewritten: [] };
  }
  const root = sourceCwd.endsWith("/") ? sourceCwd.slice(0, -1) : sourceCwd;
  const target = workspacePath.endsWith("/") ? workspacePath.slice(0, -1) : workspacePath;
  const rewritten: string[] = [];

  // The trailing separator is required: it is what distinguishes a path
  // INTO the tree from a mention OF the tree.
  const pattern = new RegExp(`${escapeRegExp(root)}/(?![/\\s])`, "g");
  const out = text.replace(pattern, (match, offset: number) => {
    // Capture the whole token for reporting, not just the matched root.
    const rest = text.slice(offset + match.length);
    const end = rest.search(/[\s"'`,;:)\]}]|$/);
    rewritten.push(`${root}/${rest.slice(0, end < 0 ? undefined : end)}`);
    return `${target}/`;
  });

  return { text: out, rewritten };
}

/** Does this text reference the source tree at all? Cheap gate. */
export function mentionsSourceTree(text: string, sourceCwd: string): boolean {
  if (sourceCwd.length === 0) {
    return false;
  }
  const root = sourceCwd.endsWith("/") ? sourceCwd.slice(0, -1) : sourceCwd;
  return text.includes(root);
}

export interface PreambleContext {
  workspacePath: string;
  sourceCwd: string;
  /** Provider-supplied caveats, conditional on inspected repo state. */
  notes: readonly string[];
  /** True when re-asserting mid-session rather than introducing. */
  reassert?: boolean;
}

/**
 * The block prepended to a prompt so the agent knows where it is.
 *
 * ACP has no system-prompt field, so a preamble on the prompt is the
 * only universally available channel. That makes it vulnerable to
 * compaction: a one-time note at session start is exactly the kind of
 * thing dropped from a long conversation, and an agent that has
 * forgotten this starts writing to the source tree two hundred turns
 * later. Hence `reassert`, which the caller sets when a prompt mentions
 * the source tree — the moment the reminder matters most.
 *
 * Kept deliberately short. It is paid on the first prompt of every
 * isolated session and again on every prompt that names the source tree,
 * and a long block dilutes the parts that matter.
 */
export function buildWorkspacePreamble(ctx: PreambleContext): string {
  const lines: string[] = [];
  lines.push(
    ctx.reassert === true
      ? "[workspace] Reminder: you are NOT working in the directory that path names."
      : "[workspace] Before anything else, note where you are working:",
  );
  lines.push(`- Your working directory is ${ctx.workspacePath}`);
  lines.push(`- It is an isolated copy of ${ctx.sourceCwd}`);
  lines.push(
    `- Any absolute path under ${ctx.sourceCwd} refers to the matching file under your working directory. Do not read or write ${ctx.sourceCwd} directly.`,
  );
  lines.push(
    "- Prefer repo-relative paths (`src/foo.ts`). They are identical in both trees, so they cannot be misread.",
  );
  for (const note of ctx.notes) {
    lines.push(`- ${note}`);
  }
  return lines.join("\n");
}

/**
 * Is this path outside the workspace but inside the source tree?
 *
 * The isolation-breach test. Used after the fact against edit tool
 * calls: the daemon cannot block the write, but a breach that nobody
 * notices is far worse than one that is reported loudly.
 */
export function isSourceTreeBreach(
  editedPath: string,
  sourceCwd: string,
  workspacePath: string,
): boolean {
  if (editedPath.length === 0 || !editedPath.startsWith("/")) {
    return false;
  }
  const src = sourceCwd.endsWith("/") ? sourceCwd : `${sourceCwd}/`;
  const ws = workspacePath.endsWith("/") ? workspacePath : `${workspacePath}/`;
  // A workspace nested inside the source tree would make every workspace
  // write look like a breach, so the workspace check wins.
  if (editedPath.startsWith(ws)) {
    return false;
  }
  return editedPath.startsWith(src);
}
