import * as fsp from "node:fs/promises";
import { loadConfig } from "../../core/config.js";
import { loadServiceToken } from "../../core/service-token.js";
import { paths } from "../../core/paths.js";
import { runLogTail, splitNameFromLogTailArgs } from "./log-tail.js";
import { httpBase } from "./sessions.js";

interface TransformerInfo {
  name: string;
  status: string;
  pid: number | null;
  enabled: boolean;
  restartCount: number;
  startedAt: number | null;
  lastExitCode: number | null;
  logPath: string;
  version: string | null;
  failureReason: string | null;
}

export async function runTransformersList(): Promise<void> {
  const config = await loadConfig();
  const serviceToken = await loadServiceToken();
  const baseUrl = httpBase(
    config.daemon.host,
    config.daemon.port,
    !!config.daemon.tls,
  );
  let body: { transformers: TransformerInfo[] };
  try {
    const r = await fetch(`${baseUrl}/v1/transformers`, {
      headers: { Authorization: `Bearer ${serviceToken}` },
    });
    if (!r.ok) {
      process.stderr.write(`Daemon returned HTTP ${r.status}\n`);
      process.exit(1);
    }
    body = (await r.json()) as { transformers: TransformerInfo[] };
  } catch (err) {
    process.stderr.write(
      `Could not reach daemon at ${baseUrl}: ${(err as Error).message}\n`,
    );
    process.exit(1);
    return;
  }

  if (body.transformers.length === 0) {
    process.stdout.write("No transformers configured.\n");
    return;
  }

  const rows = body.transformers.map((t) => ({
    name: t.name,
    status: t.status.toUpperCase(),
    version: t.version ?? "-",
    pid: t.pid != null ? String(t.pid) : "-",
    restarts: String(t.restartCount),
    started: t.startedAt ? formatRelative(t.startedAt) : "-",
    log: t.logPath,
  }));
  const header = {
    name: "NAME",
    status: "STATUS",
    version: "VERSION",
    pid: "PID",
    restarts: "RESTARTS",
    started: "STARTED",
    log: "LOG",
  };
  const widths = {
    name: maxLen(header.name, rows.map((r) => r.name)),
    status: maxLen(header.status, rows.map((r) => r.status)),
    version: maxLen(header.version, rows.map((r) => r.version)),
    pid: maxLen(header.pid, rows.map((r) => r.pid)),
    restarts: maxLen(header.restarts, rows.map((r) => r.restarts)),
    started: maxLen(header.started, rows.map((r) => r.started)),
  };
  const fmt = (r: typeof header): string =>
    [
      r.name.padEnd(widths.name),
      r.status.padEnd(widths.status),
      r.version.padEnd(widths.version),
      r.pid.padStart(widths.pid),
      r.restarts.padStart(widths.restarts),
      r.started.padEnd(widths.started),
      r.log,
    ].join("  ");
  process.stdout.write(fmt(header) + "\n");
  for (const r of rows) {
    process.stdout.write(fmt(r) + "\n");
  }
  for (const t of body.transformers) {
    if (t.failureReason) {
      process.stdout.write(`  ↳ ${t.name}: ${t.failureReason}\n`);
    }
  }
}

export async function runTransformersAdd(
  name: string | undefined,
  argv: string[],
): Promise<void> {
  if (!name) {
    process.stderr.write(
      "Usage: hydra-acp transformers add <name> [--command CMD] [--args A,B,C] [--env K=V]... [--disabled]\n",
    );
    process.exit(2);
    return;
  }
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    process.stderr.write(
      `Invalid transformer name '${name}': must match [A-Za-z0-9._-]+\n`,
    );
    process.exit(2);
    return;
  }

  await loadConfig();
  const raw = await readRawConfig();
  if (!raw.transformers || typeof raw.transformers !== "object") {
    raw.transformers = {};
  }
  const trs = raw.transformers as Record<string, unknown>;
  if (trs[name]) {
    process.stderr.write(`Transformer '${name}' already exists in config.\n`);
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
  trs[name] = body;

  await writeRawConfig(raw);
  process.stdout.write(`Added transformer '${name}' to ${paths.config()}\n`);

  const config = await loadConfig();
  const serviceToken = await loadServiceToken();
  const baseUrl = httpBase(
    config.daemon.host,
    config.daemon.port,
    !!config.daemon.tls,
  );
  const registerBody = { name, ...body };
  try {
    const r = await fetch(`${baseUrl}/v1/transformers`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(registerBody),
    });
    if (r.ok) {
      const info = (await r.json()) as TransformerInfo;
      const pid = info.pid != null ? ` pid=${info.pid}` : "";
      process.stdout.write(`${name}: ${info.status}${pid}\n`);
      return;
    }
    let detail = "";
    try {
      const errBody = (await r.json()) as { error?: string };
      if (errBody.error) {
        detail = `: ${errBody.error}`;
      }
    } catch {
      void 0;
    }
    process.stderr.write(
      `Daemon refused to register ${name} (HTTP ${r.status}${detail}). Restart the daemon to apply.\n`,
    );
  } catch {
    // Daemon not running; the new transformer will be picked up on next launch.
  }
}

export async function runTransformersRemove(
  name: string | undefined,
): Promise<void> {
  if (!name) {
    process.stderr.write("Usage: hydra-acp transformers remove <name>\n");
    process.exit(2);
    return;
  }
  await loadConfig();
  const raw = await readRawConfig();
  const trs = (raw.transformers ?? {}) as Record<string, unknown>;
  if (!trs[name]) {
    process.stderr.write(`Transformer '${name}' not found in config.\n`);
    process.exit(1);
    return;
  }
  delete trs[name];
  raw.transformers = trs;
  await writeRawConfig(raw);
  process.stdout.write(`Removed transformer '${name}' from ${paths.config()}\n`);

  const config = await loadConfig();
  const serviceToken = await loadServiceToken();
  const baseUrl = httpBase(
    config.daemon.host,
    config.daemon.port,
    !!config.daemon.tls,
  );
  try {
    const r = await fetch(
      `${baseUrl}/v1/transformers/${encodeURIComponent(name)}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${serviceToken}` },
      },
    );
    if (r.status === 204 || r.status === 404) {
      process.stdout.write(`${name}: stopped\n`);
      return;
    }
    let detail = "";
    try {
      const errBody = (await r.json()) as { error?: string };
      if (errBody.error) {
        detail = `: ${errBody.error}`;
      }
    } catch {
      void 0;
    }
    process.stderr.write(
      `Daemon refused to unregister ${name} (HTTP ${r.status}${detail}).\n`,
    );
  } catch (err) {
    process.stderr.write(
      `Daemon not reachable (${(err as Error).message}). Config saved.\n`,
    );
  }
}

export async function runTransformersStart(
  name: string | undefined,
): Promise<void> {
  await postLifecycle(name, "start");
}

export async function runTransformersStop(
  name: string | undefined,
): Promise<void> {
  await postLifecycle(name, "stop");
}

export async function runTransformersRestart(
  name: string | undefined,
): Promise<void> {
  await postLifecycle(name, "restart");
}

async function postLifecycle(
  name: string | undefined,
  verb: "start" | "stop" | "restart",
): Promise<void> {
  if (!name) {
    process.stderr.write(
      `Usage: hydra-acp transformers ${verb} <name|all>\n`,
    );
    process.exit(2);
    return;
  }
  if (name === "all") {
    await postLifecycleAll(verb);
    return;
  }
  const config = await loadConfig();
  const serviceToken = await loadServiceToken();
  const baseUrl = httpBase(
    config.daemon.host,
    config.daemon.port,
    !!config.daemon.tls,
  );
  let r: Response;
  try {
    r = await fetch(
      `${baseUrl}/v1/transformers/${encodeURIComponent(name)}/${verb}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${serviceToken}` },
      },
    );
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
  const info = (await r.json()) as TransformerInfo;
  const pid = info.pid != null ? ` pid=${info.pid}` : "";
  process.stdout.write(`${name}: ${info.status}${pid}\n`);
}

async function postLifecycleAll(
  verb: "start" | "stop" | "restart",
): Promise<void> {
  const config = await loadConfig();
  const serviceToken = await loadServiceToken();
  const baseUrl = httpBase(
    config.daemon.host,
    config.daemon.port,
    !!config.daemon.tls,
  );
  const auth = { Authorization: `Bearer ${serviceToken}` };

  let listBody: { transformers: TransformerInfo[] };
  try {
    const r = await fetch(`${baseUrl}/v1/transformers`, { headers: auth });
    if (!r.ok) {
      process.stderr.write(`Daemon returned HTTP ${r.status}\n`);
      process.exit(1);
    }
    listBody = (await r.json()) as { transformers: TransformerInfo[] };
  } catch (err) {
    process.stderr.write(
      `Could not reach daemon at ${baseUrl}: ${(err as Error).message}\n`,
    );
    process.exit(1);
    return;
  }

  const targets = listBody.transformers.filter((t) => {
    if (verb === "start") {
      return t.enabled && t.status !== "running";
    }
    return t.status === "running";
  });

  if (targets.length === 0) {
    const reason =
      verb === "start"
        ? "no enabled transformers are stopped"
        : "no transformers are running";
    process.stdout.write(`Nothing to ${verb}: ${reason}.\n`);
    return;
  }

  let failed = 0;
  for (const t of targets) {
    try {
      const r = await fetch(
        `${baseUrl}/v1/transformers/${encodeURIComponent(t.name)}/${verb}`,
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
        process.stdout.write(`${t.name}: ERROR HTTP ${r.status}${detail}\n`);
        failed += 1;
        continue;
      }
      const info = (await r.json()) as TransformerInfo;
      const pid = info.pid != null ? ` pid=${info.pid}` : "";
      process.stdout.write(`${t.name}: ${info.status}${pid}\n`);
    } catch (err) {
      process.stdout.write(`${t.name}: ERROR ${(err as Error).message}\n`);
      failed += 1;
    }
  }
  if (failed > 0) {
    process.exit(1);
  }
}

export async function runTransformersLogs(argv: string[]): Promise<void> {
  const { name, rest } = splitNameFromLogTailArgs(argv);
  if (!name) {
    process.stderr.write(
      "Usage: hydra-acp transformers log <name> [--tail N] [--follow]\n",
    );
    process.exit(2);
    return;
  }
  const logPath = paths.transformerLogFile(name);
  await runLogTail(logPath, rest, "No log file (transformer never ran?)");
}

async function readRawConfig(): Promise<Record<string, unknown>> {
  const raw = await fsp.readFile(paths.config(), "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

async function writeRawConfig(raw: Record<string, unknown>): Promise<void> {
  await fsp.writeFile(paths.config(), JSON.stringify(raw, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
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
        process.stderr.write(
          `Invalid --env value '${v}': expected KEY=VALUE\n`,
        );
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
    return { command: [], args: [], env: {}, enabled: false };
  }
  return { command, args: argList, env, enabled };
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
