// Git-style subcommand fallback: when `hydra-acp <name>` is invoked with
// a <name> that isn't a built-in verb, look for a `hydra-acp-<name>`
// binary on PATH and exec it with the remaining argv. Lets ecosystem
// packages (e.g. @hydra-acp/planner shipping `hydra-acp-planner`) be
// reachable as `hydra-acp planner ...` without any coupling between
// hydra-acp itself and the external command.

import { spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

// Every subcommand the top-level CLI handles internally. Anything not in
// this set is a candidate for external dispatch. Keep in sync with the
// switch in cli.ts and the special `launch` handling that runs before
// it.
const BUILTIN_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "agent",
  "agents",
  "auth",
  "cat",
  "daemon",
  "extension",
  "extensions",
  "init",
  "launch",
  "registry",
  "session",
  "sessions",
  "shim",
  "transformer",
  "transformers",
  "tui",
]);

export function isBuiltinSubcommand(name: string): boolean {
  return BUILTIN_SUBCOMMANDS.has(name);
}

// Pull the first non-flag token out of argv — that's the subcommand
// candidate. Mirrors how parseArgs distinguishes positionals from flags
// (anything starting with `--` is a flag) but doesn't allocate a full
// parse just to peek at the first positional.
export function firstPositional(argv: readonly string[]): string | undefined {
  for (const tok of argv) {
    if (tok === undefined) {
      continue;
    }
    if (!tok.startsWith("-")) {
      return tok;
    }
  }
  return undefined;
}

// Return argv with the first non-flag token removed. The external binary
// receives everything else (including flags) as its own argv.
export function argvWithoutFirstPositional(argv: readonly string[]): string[] {
  const out: string[] = [];
  let dropped = false;
  for (const tok of argv) {
    if (!dropped && tok !== undefined && !tok.startsWith("-")) {
      dropped = true;
      continue;
    }
    if (tok !== undefined) {
      out.push(tok);
    }
  }
  return out;
}

function isExecutableFile(path: string): boolean {
  try {
    const s = statSync(path);
    if (!s.isFile()) {
      return false;
    }
  } catch {
    return false;
  }
  if (process.platform === "win32") {
    return true;
  }
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Look up `hydra-acp-<name>` on PATH. Returns the absolute path of the
// first match, or undefined if none. On Windows, also tries the PATHEXT
// extensions (typically .EXE / .CMD / .BAT).
export function findExternalSubcommand(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const pathVar = env["PATH"] ?? env["Path"] ?? "";
  if (pathVar.length === 0) {
    return undefined;
  }
  const dirs = pathVar.split(delimiter).filter((d) => d.length > 0);
  const base = `hydra-acp-${name}`;
  const exts =
    process.platform === "win32"
      ? (env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD").split(";")
      : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, base + ext);
      if (isExecutableFile(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

// Exec the external subcommand synchronously with inherited stdio. The
// child becomes the foreground process; we just wait and propagate its
// exit status. Returns true if the binary ran (the caller should exit
// after this — never returns control to the rest of the CLI dispatcher).
export function execExternalSubcommand(
  binPath: string,
  args: readonly string[],
): never {
  const result = spawnSync(binPath, args, {
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) {
    process.stderr.write(
      `hydra-acp: failed to exec ${binPath}: ${result.error.message}\n`,
    );
    process.exit(1);
  }
  if (typeof result.status === "number") {
    process.exit(result.status);
  }
  if (result.signal) {
    // Re-raise the signal so our parent sees the same disposition.
    process.kill(process.pid, result.signal);
  }
  process.exit(1);
}

// Convenience: combines the lookup and exec. Returns false if no
// matching binary was found (caller falls through to its existing
// unknown-command error path). Otherwise never returns — the process
// is replaced by the child's exit status.
export function maybeDispatchExternal(
  argv: readonly string[],
): boolean {
  const name = firstPositional(argv);
  if (name === undefined) {
    return false;
  }
  if (isBuiltinSubcommand(name)) {
    return false;
  }
  const bin = findExternalSubcommand(name);
  if (bin === undefined) {
    return false;
  }
  execExternalSubcommand(bin, argvWithoutFirstPositional(argv));
}
