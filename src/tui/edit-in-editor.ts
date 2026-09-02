// Round-trips composer text through $HYDRA_EDITOR/$VISUAL/$EDITOR: write the
// buffer to a temp file, hand the terminal to the editor via
// runForegroundChild, read the result back once it exits cleanly.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runForegroundChild,
  type ForegroundDeps,
  type ForegroundSpec,
} from "./foreground-run.js";

// Same fallback and blank-value handling as resolveOpenFileCommand
// (app.ts): $HYDRA_EDITOR then $VISUAL then $EDITOR, skipping a blank
// value rather than letting it shadow the next one. Unlike openFileCommand
// there's no hydra-specific config to check first — this feature has no
// file to target, so there's nothing for a %f/%n command to point at.
export function resolveEditorCommand(
  env: NodeJS.ProcessEnv = process.env,
): string[] | null {
  const fromEnv = [env.HYDRA_EDITOR, env.VISUAL, env.EDITOR].find(
    (value) => value !== undefined && value.trim() !== "",
  );
  if (fromEnv === undefined) {
    return null;
  }
  const argv = fromEnv.split(/\s+/).filter((s) => s.length > 0);
  return argv.length > 0 ? argv : null;
}

export interface EditTextDeps extends ForegroundDeps {
  env?: NodeJS.ProcessEnv;
  runForeground?: typeof runForegroundChild;
}

// Returns the edited text, or null when nothing should replace the
// caller's buffer: no $HYDRA_EDITOR/$VISUAL/$EDITOR configured, the editor
// failed to launch, or it exited nonzero. foreground-run.ts already
// notifies why in the nonzero/error cases.
export async function editTextInEditor(
  text: string,
  deps: EditTextDeps,
): Promise<string | null> {
  const argv = resolveEditorCommand(deps.env);
  if (argv === null) {
    deps.notify?.("no $HYDRA_EDITOR, $VISUAL or $EDITOR set — nothing to edit with");
    return null;
  }
  const [program, ...args] = argv as [string, ...string[]];
  const dir = mkdtempSync(join(tmpdir(), "hydra-acp-edit-"));
  const file = join(dir, "prompt.md");
  writeFileSync(file, text, "utf8");
  try {
    const spec: ForegroundSpec = {
      program,
      args: [...args, file],
      banner: `─ ${program} — save and quit to return to hydra ─\n`,
    };
    const runForeground = deps.runForeground ?? runForegroundChild;
    const outcome = await runForeground(spec, deps);
    if (
      outcome.error ||
      (outcome.exitCode !== null && outcome.exitCode !== 0)
    ) {
      return null;
    }
    const edited = readFileSync(file, "utf8");
    return edited.endsWith("\n") ? edited.slice(0, -1) : edited;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
