// Pager helper. Mirrors git's behavior:
//   - Only page when stdout is a TTY and pagination isn't disabled.
//   - Pager precedence: $HYDRA_ACP_PAGER > $PAGER > "less".
//   - When invoking "less" with no LESS env var, default to "FRX" so it
//     quits if one screen fits (-F), passes raw ANSI through (-R), and
//     doesn't clear the screen on exit (-X). Same defaults git uses.
//   - If the user quits the pager early (q), EPIPE on our writes is
//     swallowed — the writer just stops accepting more bytes rather
//     than crashing the process.
//   - The caller awaits flush() so the pager has finished painting
//     before the CLI returns control to the shell.

import { spawn, type ChildProcess } from "node:child_process";
import { Writable } from "node:stream";

export interface PagerOptions {
  // Force pagination off — wired to --no-pager and useful when stdout
  // is a TTY but the caller wants raw output (--json, scripted use).
  disabled?: boolean;
  // Test-only override of process.stdout's isTTY signal. In real use
  // the helper reads process.stdout.isTTY directly.
  isTTY?: boolean;
  // Test-only override of process.env. In real use we read process.env.
  env?: NodeJS.ProcessEnv;
  // Test-only override of the spawn target so unit tests can inject a
  // recorder without forking less / cat.
  spawn?: typeof spawn;
}

export interface PagerHandle {
  // The stream the caller writes their formatted output to. Either
  // process.stdout (no pager) or the pager subprocess's stdin.
  stream: NodeJS.WritableStream;
  // Resolves once the caller's data has been delivered to the pager
  // and (when paging) the pager subprocess has exited. Always
  // resolves; it never rejects, since pager failures shouldn't be
  // fatal to the CLI command that invoked it.
  flush: () => Promise<void>;
}

export function openPager(opts: PagerOptions = {}): PagerHandle {
  const isTTY = opts.isTTY ?? process.stdout.isTTY === true;
  if (opts.disabled === true || !isTTY) {
    return {
      stream: process.stdout,
      flush: async () => {
        // No-op: process.stdout drains on its own; the caller's awaits
        // happen at the outer process.exit boundary.
      },
    };
  }
  const env = opts.env ?? process.env;
  const command = resolvePagerCommand(env);
  if (command === null) {
    return {
      stream: process.stdout,
      flush: async () => {
        // No-op: no pager configured (e.g. PAGER explicitly empty).
      },
    };
  }
  const spawnImpl = opts.spawn ?? spawn;
  const childEnv = { ...env };
  if (childEnv.LESS === undefined) {
    childEnv.LESS = "FRX";
  }
  const child: ChildProcess = spawnImpl(command, [], {
    shell: true,
    stdio: ["pipe", "inherit", "inherit"],
    env: childEnv,
  });
  // The pager's stdin is our write target. If the user quits the pager
  // early, the kernel sends EPIPE on the next write — swallow it
  // rather than tearing down the process. Wrapping in a Writable also
  // means the caller's `.end()` reliably finalizes the pipe.
  const childStdin = child.stdin;
  if (childStdin === null) {
    return {
      stream: process.stdout,
      flush: async () => {
        // Best-effort: if the pager couldn't open a stdin pipe we just
        // fall through to direct stdout writes; the child will exit on
        // its own.
      },
    };
  }
  childStdin.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") {
      return;
    }
    // Anything else is a real failure — emit through stderr but don't
    // crash. The caller's content has already been generated.
    process.stderr.write(`pager: ${err.message}\n`);
  });
  // Wrap so the caller can write/end as if it were process.stdout.
  // Without this, callers that detect EPIPE between write() and end()
  // would still throw on the end() call.
  const wrapper = new Writable({
    write(chunk, _encoding, callback) {
      if (!childStdin.writable) {
        callback();
        return;
      }
      const ok = childStdin.write(chunk, (err: Error | null | undefined) => {
        if (err && (err as NodeJS.ErrnoException).code !== "EPIPE") {
          callback(err);
          return;
        }
        callback();
      });
      if (!ok) {
        childStdin.once("drain", () => undefined);
      }
    },
    final(callback) {
      if (childStdin.writable) {
        childStdin.end();
      }
      callback();
    },
  });
  // Mirror writer-side EPIPE handling so a `.write()` race doesn't
  // bubble an uncaught error out of the wrapper either.
  wrapper.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code !== "EPIPE") {
      process.stderr.write(`pager: ${err.message}\n`);
    }
  });

  const childExited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });

  return {
    stream: wrapper,
    flush: async () => {
      if (childStdin.writable) {
        await new Promise<void>((resolve) => {
          wrapper.end(() => resolve());
        });
      }
      await childExited;
    },
  };
}

// Resolve the pager command. `null` means "no pager configured" — the
// caller falls back to direct stdout. An empty string from the env
// counts as "no pager" (matches git's `PAGER=` behavior).
function resolvePagerCommand(env: NodeJS.ProcessEnv): string | null {
  const hydra = env.HYDRA_ACP_PAGER;
  if (hydra !== undefined) {
    return hydra.length === 0 ? null : hydra;
  }
  const generic = env.PAGER;
  if (generic !== undefined) {
    return generic.length === 0 ? null : generic;
  }
  return "less";
}
