// User-defined hotkey plumbing: expand percent-substitutions in the
// configured `tui.hotkeys[<key>].command`, build the argv + env, spawn
// the process, and echo its captured stdout/stderr back into TUI
// scrollback when it exits.
//
// Output policy: stdout and stderr are captured (not detached to
// /dev/null) up to a byte cap (default 16 KiB combined) and emitted as
// a single block on exit — captured lines, then a trailing status
// marker if the exit was non-zero or signaled. Nothing is echoed
// before the child runs. This is capture-on-exit rather than live
// streaming, since interleaving arbitrary script output with live
// agent chunks would be visually confusing. Scripts that want a
// "look, it did the thing" signal should print something to stdout;
// silent scripts produce no scrollback output on a clean exit.
//
// The program path and every arg go through expandHome() so a leading
// `~` or `$HOME` resolves against the user's home directory — the
// spawn is not run through a shell, so this is the only way to get
// tilde-style paths to work.
//
// Substitutions in string args (matches openFileCommand style):
//   %s  session id
//   %c  session cwd
//   %a  agent id
//   %u  daemon base URL
//   %t  path to the service-token file on disk
//   %%  literal %
// Unknown %-tokens are left intact.
//
// The same values are also exported to the child's env as
// HYDRA_SESSION_ID / HYDRA_CWD / HYDRA_AGENT / HYDRA_BASE_URL /
// HYDRA_TOKEN_FILE.
//
// The spawn is not detached: killing the TUI kills the child. That's
// deliberate — the child is talking to us (via captured stdio), so it
// has no business outliving the TUI.

import { spawn, type ChildProcess } from "node:child_process";
import { expandHome } from "../core/config.js";

export interface HotkeyContext {
  sessionId: string;
  cwd: string;
  agentId: string;
  baseUrl: string;
  tokenFile: string;
}

export interface HotkeyCommand {
  command: string | readonly string[];
}

export interface HotkeyInvocation {
  program: string;
  args: string[];
  env: Record<string, string>;
}

export type HotkeyLineStyle = "meta" | "stdout" | "stderr" | "error";

export interface HotkeyOutputLine {
  text: string;
  style: HotkeyLineStyle;
}

function substitute(arg: string, ctx: HotkeyContext): string {
  let out = "";
  for (let i = 0; i < arg.length; i++) {
    const ch = arg[i];
    if (ch !== "%" || i === arg.length - 1) {
      out += ch;
      continue;
    }
    const next = arg[i + 1]!;
    switch (next) {
      case "%":
        out += "%";
        i++;
        break;
      case "s":
        out += ctx.sessionId;
        i++;
        break;
      case "c":
        out += ctx.cwd;
        i++;
        break;
      case "a":
        out += ctx.agentId;
        i++;
        break;
      case "u":
        out += ctx.baseUrl;
        i++;
        break;
      case "t":
        out += ctx.tokenFile;
        i++;
        break;
      default:
        out += ch;
        break;
    }
  }
  return out;
}

function toArgv(command: string | readonly string[]): string[] {
  if (Array.isArray(command)) {
    return [...command];
  }
  const s = command as string;
  return s.trim().length === 0 ? [] : s.trim().split(/\s+/);
}

export function buildHotkeyInvocation(
  spec: HotkeyCommand,
  ctx: HotkeyContext,
): HotkeyInvocation | null {
  const raw = toArgv(spec.command);
  if (raw.length === 0) {
    return null;
  }
  const expanded = raw.map((a) => expandHome(substitute(a, ctx)));
  const [program, ...args] = expanded;
  if (!program) {
    return null;
  }
  const env: Record<string, string> = {
    HYDRA_SESSION_ID: ctx.sessionId,
    HYDRA_CWD: ctx.cwd,
    HYDRA_AGENT: ctx.agentId,
    HYDRA_BASE_URL: ctx.baseUrl,
    HYDRA_TOKEN_FILE: ctx.tokenFile,
  };
  return { program, args, env };
}

// Buffer captured stdio and, on exit, split into complete lines and
// prepend a "$ ..." header + append an exit-status line when non-zero.
// Lines exceeding the byte cap are dropped and a truncation marker is
// emitted — mirrors how tool output externalization surfaces oversize
// bodies.
export interface HotkeyOutputBuilder {
  onStdout: (chunk: Buffer) => void;
  onStderr: (chunk: Buffer) => void;
  onExit: (code: number | null, signal: NodeJS.Signals | null) => HotkeyOutputLine[];
}

export function createOutputBuilder(
  maxOutputBytes: number,
): HotkeyOutputBuilder {
  const buf = { stdout: "", stderr: "", bytes: 0, truncated: false };
  const append = (chunk: Buffer, which: "stdout" | "stderr"): void => {
    if (buf.truncated) {
      return;
    }
    const remaining = maxOutputBytes - buf.bytes;
    if (remaining <= 0) {
      buf.truncated = true;
      return;
    }
    const slice =
      chunk.length <= remaining ? chunk.toString("utf8") : chunk.subarray(0, remaining).toString("utf8");
    if (chunk.length > remaining) {
      buf.truncated = true;
    }
    buf[which] += slice;
    buf.bytes += Math.min(chunk.length, remaining);
  };
  return {
    onStdout: (chunk) => append(chunk, "stdout"),
    onStderr: (chunk) => append(chunk, "stderr"),
    onExit: (code, signal) => {
      const lines: HotkeyOutputLine[] = [];
      const push = (text: string, style: HotkeyLineStyle): void => {
        const parts = text.split(/\r?\n/);
        while (parts.length > 0 && parts[parts.length - 1] === "") {
          parts.pop();
        }
        for (const p of parts) {
          lines.push({ text: p, style });
        }
      };
      if (buf.stdout) {
        push(buf.stdout, "stdout");
      }
      if (buf.stderr) {
        push(buf.stderr, "stderr");
      }
      if (buf.truncated) {
        lines.push({
          text: `[output truncated at ${maxOutputBytes} bytes]`,
          style: "meta",
        });
      }
      if (signal) {
        lines.push({ text: `[killed by ${signal}]`, style: "error" });
      } else if (typeof code === "number" && code !== 0) {
        lines.push({ text: `[exit ${code}]`, style: "error" });
      }
      return lines;
    },
  };
}

export interface HotkeySpawnDeps {
  notify: (msg: string) => void;
  emitLines: (lines: HotkeyOutputLine[]) => void;
  cwd: string;
  parentEnv?: NodeJS.ProcessEnv;
  maxOutputBytes?: number;
  spawnFn?: (
    program: string,
    args: string[],
    opts: { cwd: string; env: NodeJS.ProcessEnv; stdio: ["ignore", "pipe", "pipe"] },
  ) => ChildProcess;
}

const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024;

export function runUserHotkey(
  spec: HotkeyCommand,
  ctx: HotkeyContext,
  deps: HotkeySpawnDeps,
): void {
  const inv = buildHotkeyInvocation(spec, ctx);
  if (inv === null) {
    deps.notify("hotkey: empty command");
    return;
  }
  const builder = createOutputBuilder(
    deps.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
  );
  const spawnFn = deps.spawnFn ?? spawn;
  let child: ChildProcess;
  try {
    child = spawnFn(inv.program, inv.args, {
      cwd: deps.cwd,
      env: { ...(deps.parentEnv ?? process.env), ...inv.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    deps.emitLines([
      { text: `[hotkey spawn failed: ${(err as Error).message}]`, style: "error" },
    ]);
    return;
  }
  child.stdout?.on("data", builder.onStdout);
  child.stderr?.on("data", builder.onStderr);
  child.on("error", (err) => {
    deps.emitLines([
      { text: `[hotkey spawn error: ${(err as Error).message}]`, style: "error" },
    ]);
  });
  child.on("close", (code, signal) => {
    deps.emitLines(builder.onExit(code, signal));
  });
}
