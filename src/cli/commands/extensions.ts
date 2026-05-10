import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { loadConfig } from "../../core/config.js";
import { paths } from "../../core/paths.js";
import { httpBase } from "./sessions.js";

interface ExtensionInfo {
  name: string;
  status: string;
  pid: number | null;
  enabled: boolean;
  restartCount: number;
  startedAt: number | null;
  lastExitCode: number | null;
  logPath: string;
}

export async function runExtensionsList(): Promise<void> {
  const config = await loadConfig();
  const baseUrl = httpBase(config.daemon.host, config.daemon.port, !!config.daemon.tls);
  let body: { extensions: ExtensionInfo[] };
  try {
    const r = await fetch(`${baseUrl}/v1/extensions`, {
      headers: { Authorization: `Bearer ${config.daemon.authToken}` },
    });
    if (!r.ok) {
      process.stderr.write(`Daemon returned HTTP ${r.status}\n`);
      process.exit(1);
    }
    body = (await r.json()) as { extensions: ExtensionInfo[] };
  } catch (err) {
    process.stderr.write(
      `Could not reach daemon at ${baseUrl}: ${(err as Error).message}\n`,
    );
    process.exit(1);
    return;
  }

  if (body.extensions.length === 0) {
    process.stdout.write("No extensions configured.\n");
    return;
  }

  const rows = body.extensions.map((e) => ({
    name: e.name,
    status: e.status.toUpperCase(),
    pid: e.pid != null ? String(e.pid) : "-",
    restarts: String(e.restartCount),
    started: e.startedAt ? formatRelative(e.startedAt) : "-",
    log: e.logPath,
  }));
  const header = {
    name: "NAME",
    status: "STATUS",
    pid: "PID",
    restarts: "RESTARTS",
    started: "STARTED",
    log: "LOG",
  };
  const widths = {
    name: maxLen(header.name, rows.map((r) => r.name)),
    status: maxLen(header.status, rows.map((r) => r.status)),
    pid: maxLen(header.pid, rows.map((r) => r.pid)),
    restarts: maxLen(header.restarts, rows.map((r) => r.restarts)),
    started: maxLen(header.started, rows.map((r) => r.started)),
  };
  const fmt = (r: typeof header): string =>
    [
      r.name.padEnd(widths.name),
      r.status.padEnd(widths.status),
      r.pid.padStart(widths.pid),
      r.restarts.padStart(widths.restarts),
      r.started.padEnd(widths.started),
      r.log,
    ].join("  ");
  process.stdout.write(fmt(header) + "\n");
  for (const r of rows) {
    process.stdout.write(fmt(r) + "\n");
  }
}

export async function runExtensionsAdd(
  name: string | undefined,
  argv: string[],
): Promise<void> {
  if (!name) {
    process.stderr.write(
      "Usage: acp-hydra extensions add <name> [--command CMD] [--args A,B,C] [--env K=V]... [--disabled]\n",
    );
    process.exit(2);
    return;
  }
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    process.stderr.write(
      `Invalid extension name '${name}': must match [A-Za-z0-9._-]+\n`,
    );
    process.exit(2);
    return;
  }

  // Validate the existing config parses cleanly (so we don't blindly write
  // alongside a broken file), then mutate the raw JSON so we only touch
  // the targeted entry — going through writeConfig would re-emit every
  // existing extension's defaults explicitly.
  await loadConfig();
  const raw = await readRawConfig();
  if (!raw.extensions || typeof raw.extensions !== "object") {
    raw.extensions = {};
  }
  const exts = raw.extensions as Record<string, unknown>;
  if (exts[name]) {
    process.stderr.write(`Extension '${name}' already exists in config.\n`);
    process.exit(1);
    return;
  }

  const { command, args, env, enabled } = parseAddFlags(argv);
  const body: Record<string, unknown> = {};
  if (command.length > 0) {
    body.command = command;
  }
  if (args.length > 0) {
    body.args = args;
  }
  if (Object.keys(env).length > 0) {
    body.env = env;
  }
  if (!enabled) {
    body.enabled = false;
  }
  exts[name] = body;

  await writeRawConfig(raw);
  process.stdout.write(`Added extension '${name}' to ${paths.config()}\n`);
  process.stdout.write(
    "Restart the daemon (or `acp-hydra daemon stop && acp-hydra daemon start`) to apply.\n",
  );
}

export async function runExtensionsRemove(name: string | undefined): Promise<void> {
  if (!name) {
    process.stderr.write("Usage: acp-hydra extensions remove <name>\n");
    process.exit(2);
    return;
  }
  await loadConfig();
  const raw = await readRawConfig();
  const exts = (raw.extensions ?? {}) as Record<string, unknown>;
  if (!exts[name]) {
    process.stderr.write(`Extension '${name}' not found in config.\n`);
    process.exit(1);
    return;
  }
  delete exts[name];
  raw.extensions = exts;
  await writeRawConfig(raw);
  process.stdout.write(`Removed extension '${name}' from ${paths.config()}\n`);
}

async function readRawConfig(): Promise<Record<string, unknown>> {
  const raw = await fsp.readFile(paths.config(), "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

async function writeRawConfig(raw: Record<string, unknown>): Promise<void> {
  await fsp.writeFile(
    paths.config(),
    JSON.stringify(raw, null, 2) + "\n",
    { encoding: "utf8", mode: 0o600 },
  );
}

export async function runExtensionsStart(name: string | undefined): Promise<void> {
  await postLifecycle(name, "start");
}

export async function runExtensionsStop(name: string | undefined): Promise<void> {
  await postLifecycle(name, "stop");
}

export async function runExtensionsRestart(name: string | undefined): Promise<void> {
  await postLifecycle(name, "restart");
}

async function postLifecycle(
  name: string | undefined,
  verb: "start" | "stop" | "restart",
): Promise<void> {
  if (!name) {
    process.stderr.write(
      `Usage: acp-hydra extensions ${verb} <name|all>\n`,
    );
    process.exit(2);
    return;
  }
  if (name === "all") {
    await postLifecycleAll(verb);
    return;
  }
  const config = await loadConfig();
  const baseUrl = httpBase(config.daemon.host, config.daemon.port, !!config.daemon.tls);
  let r: Response;
  try {
    r = await fetch(`${baseUrl}/v1/extensions/${encodeURIComponent(name)}/${verb}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.daemon.authToken}` },
    });
  } catch (err) {
    process.stderr.write(
      `Could not reach daemon at ${baseUrl}: ${(err as Error).message}\n`,
    );
    process.exit(1);
    return;
  }
  if (!r.ok) {
    let detail = "";
    try {
      const body = (await r.json()) as { error?: string };
      if (body.error) {
        detail = `: ${body.error}`;
      }
    } catch {
      void 0;
    }
    process.stderr.write(`HTTP ${r.status}${detail}\n`);
    process.exit(1);
    return;
  }
  const info = (await r.json()) as ExtensionInfo;
  const pid = info.pid != null ? ` pid=${info.pid}` : "";
  process.stdout.write(`${name}: ${info.status}${pid}\n`);
}

async function postLifecycleAll(
  verb: "start" | "stop" | "restart",
): Promise<void> {
  const config = await loadConfig();
  const baseUrl = httpBase(config.daemon.host, config.daemon.port, !!config.daemon.tls);
  const auth = { Authorization: `Bearer ${config.daemon.authToken}` };

  let listBody: { extensions: ExtensionInfo[] };
  try {
    const r = await fetch(`${baseUrl}/v1/extensions`, { headers: auth });
    if (!r.ok) {
      process.stderr.write(`Daemon returned HTTP ${r.status}\n`);
      process.exit(1);
    }
    listBody = (await r.json()) as { extensions: ExtensionInfo[] };
  } catch (err) {
    process.stderr.write(
      `Could not reach daemon at ${baseUrl}: ${(err as Error).message}\n`,
    );
    process.exit(1);
    return;
  }

  // Filter by what makes sense for each verb. start touches enabled-but-not-running;
  // stop and restart touch only currently-running extensions.
  const targets = listBody.extensions.filter((e) => {
    if (verb === "start") {
      return e.enabled && e.status !== "running";
    }
    return e.status === "running";
  });

  if (targets.length === 0) {
    const reason =
      verb === "start"
        ? "no enabled extensions are stopped"
        : "no extensions are running";
    process.stdout.write(`Nothing to ${verb}: ${reason}.\n`);
    return;
  }

  let failed = 0;
  for (const ext of targets) {
    try {
      const r = await fetch(
        `${baseUrl}/v1/extensions/${encodeURIComponent(ext.name)}/${verb}`,
        { method: "POST", headers: auth },
      );
      if (!r.ok) {
        let detail = "";
        try {
          const body = (await r.json()) as { error?: string };
          if (body.error) {
            detail = `: ${body.error}`;
          }
        } catch {
          void 0;
        }
        process.stdout.write(`${ext.name}: ERROR HTTP ${r.status}${detail}\n`);
        failed += 1;
        continue;
      }
      const info = (await r.json()) as ExtensionInfo;
      const pid = info.pid != null ? ` pid=${info.pid}` : "";
      process.stdout.write(`${ext.name}: ${info.status}${pid}\n`);
    } catch (err) {
      process.stdout.write(
        `${ext.name}: ERROR ${(err as Error).message}\n`,
      );
      failed += 1;
    }
  }
  if (failed > 0) {
    process.exit(1);
  }
}

export async function runExtensionsLogs(
  name: string | undefined,
  argv: string[],
): Promise<void> {
  if (!name) {
    process.stderr.write(
      "Usage: acp-hydra extensions logs <name> [--tail N] [--follow]\n",
    );
    process.exit(2);
    return;
  }
  const { tail, follow } = parseLogsFlags(argv);
  const logPath = paths.extensionLogFile(name);

  let stat: fs.Stats;
  try {
    stat = await fsp.stat(logPath);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      process.stderr.write(`No log file at ${logPath} (extension never ran?)\n`);
      process.exit(1);
      return;
    }
    throw err;
  }

  let position = await printTail(logPath, stat.size, tail);

  if (!follow) {
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
          // truncated or no new bytes; reset to current size to avoid loop
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

function parseAddFlags(argv: string[]): {
  command: string[];
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
} {
  let command: string[] = [];
  let argList: string[] = [];
  const env: Record<string, string> = {};
  let enabled = true;
  let i = 0;
  while (i < argv.length) {
    const tok = argv[i];
    if (tok === "--command") {
      const v = argv[i + 1];
      if (v === undefined) {
        process.stderr.write("--command requires a value\n");
        process.exit(2);
      }
      command = splitShellWords(v);
      i += 2;
      continue;
    }
    if (tok === "--args") {
      const v = argv[i + 1];
      if (v === undefined) {
        process.stderr.write("--args requires a value\n");
        process.exit(2);
      }
      argList = v.split(",").filter((s) => s.length > 0);
      i += 2;
      continue;
    }
    if (tok === "--env") {
      const v = argv[i + 1];
      if (v === undefined) {
        process.stderr.write("--env requires KEY=VALUE\n");
        process.exit(2);
      }
      const eq = v.indexOf("=");
      if (eq <= 0) {
        process.stderr.write(`Invalid --env value '${v}': expected KEY=VALUE\n`);
        process.exit(2);
      }
      env[v.slice(0, eq)] = v.slice(eq + 1);
      i += 2;
      continue;
    }
    if (tok === "--disabled") {
      enabled = false;
      i += 1;
      continue;
    }
    process.stderr.write(`Unknown flag: ${tok}\n`);
    process.exit(2);
    return { command: [], args: [], env: {}, enabled: true };
  }
  return { command, args: argList, env, enabled };
}

function parseLogsFlags(argv: string[]): { tail: number; follow: boolean } {
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

function splitShellWords(s: string): string[] {
  return s.split(/\s+/).filter((p) => p.length > 0);
}

function formatRelative(ms: number): string {
  const diff = Math.max(0, Date.now() - ms);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) {
    return `${sec}s ago`;
  }
  const min = Math.floor(sec / 60);
  if (min < 60) {
    return `${min}m ago`;
  }
  const hr = Math.floor(min / 60);
  if (hr < 24) {
    return `${hr}h ago`;
  }
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function maxLen(headerCell: string, values: string[]): number {
  let max = headerCell.length;
  for (const v of values) {
    if (v.length > max) {
      max = v.length;
    }
  }
  return max;
}
