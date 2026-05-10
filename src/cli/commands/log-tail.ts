import * as fs from "node:fs";
import * as fsp from "node:fs/promises";

interface LogTailOptions {
  tail: number;
  follow: boolean;
}

export async function runLogTail(
  logPath: string,
  argv: string[],
  notFoundMessage: string,
): Promise<void> {
  const opts = parseLogTailFlags(argv);
  let stat: fs.Stats;
  try {
    stat = await fsp.stat(logPath);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      process.stderr.write(`${notFoundMessage} (${logPath})\n`);
      process.exit(1);
      return;
    }
    throw err;
  }

  let position = await printTail(logPath, stat.size, opts.tail);

  if (!opts.follow) {
    return;
  }

  process.stdout.write(`-- following ${logPath} --\n`);
  let pending = false;
  const watcher = fs.watch(logPath, () => {
    if (pending) {
      return;
    }
    pending = true;
    setImmediate(async () => {
      pending = false;
      try {
        const s = await fsp.stat(logPath);
        if (s.size <= position) {
          if (s.size < position) {
            position = s.size;
          }
          return;
        }
        const fd = await fsp.open(logPath, "r");
        try {
          const buf = Buffer.alloc(s.size - position);
          await fd.read(buf, 0, buf.length, position);
          process.stdout.write(buf);
          position = s.size;
        } finally {
          await fd.close();
        }
      } catch {
        void 0;
      }
    });
  });

  await new Promise<void>((resolve) => {
    const finish = (): void => {
      watcher.close();
      resolve();
    };
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
}

async function printTail(
  logPath: string,
  fileSize: number,
  lines: number,
): Promise<number> {
  if (lines <= 0 || fileSize === 0) {
    return fileSize;
  }
  const CHUNK = 64 * 1024;
  const fd = await fsp.open(logPath, "r");
  try {
    let position = fileSize;
    let collected = "";
    let newlineCount = 0;
    while (position > 0 && newlineCount <= lines) {
      const readSize = Math.min(CHUNK, position);
      position -= readSize;
      const buf = Buffer.alloc(readSize);
      await fd.read(buf, 0, readSize, position);
      const piece = buf.toString("utf8");
      collected = piece + collected;
      newlineCount = (collected.match(/\n/g) ?? []).length;
    }
    const allLines = collected.split("\n");
    const tail = allLines.slice(-lines - 1);
    process.stdout.write(tail.join("\n"));
    if (!collected.endsWith("\n")) {
      process.stdout.write("\n");
    }
  } finally {
    await fd.close();
  }
  return fileSize;
}

function parseLogTailFlags(argv: string[]): LogTailOptions {
  let tail = 50;
  let follow = false;
  let i = 0;
  while (i < argv.length) {
    const tok = argv[i];
    if (tok === "--tail" || tok === "-n") {
      const v = argv[i + 1];
      const n = Number.parseInt(v ?? "", 10);
      if (!Number.isInteger(n) || n < 0) {
        process.stderr.write(`Invalid --tail value: ${v}\n`);
        process.exit(2);
      }
      tail = n;
      i += 2;
      continue;
    }
    if (tok === "--follow" || tok === "-f") {
      follow = true;
      i += 1;
      continue;
    }
    process.stderr.write(`Unknown flag: ${tok}\n`);
    process.exit(2);
    return { tail: 50, follow: false };
  }
  return { tail, follow };
}
