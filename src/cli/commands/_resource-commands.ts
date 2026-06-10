import { loadConfig } from "../../core/config.js";
import { paths } from "../../core/paths.js";
import { runLogTail, splitNameFromLogTailArgs } from "./log-tail.js";
import {
  daemonFetch,
  formatRelative,
  parseAddFlags,
  readRawConfig,
  writeRawConfig,
} from "./_shared.js";

// Shape returned by GET /v1/{extensions,transformers}[/:name][/:verb].
// extensions.ts and transformers.ts each used a locally-named copy of this
// type; the two were byte-identical.
export interface ResourceInfo {
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

export type ResourceKind = "extension" | "transformer";

interface ResourceSpec {
  // Singular noun used in user-facing messages ("extension", "transformer").
  singular: ResourceKind;
  // Plural noun used in CLI subcommand and URL prefix ("extensions",
  // "transformers"). Also the JSON field on the list response and the
  // config key.
  plural: "extensions" | "transformers";
  logFile: (name: string) => string;
}

const SPECS: Record<ResourceKind, ResourceSpec> = {
  extension: {
    singular: "extension",
    plural: "extensions",
    logFile: (n) => paths.extensionLogFile(n),
  },
  transformer: {
    singular: "transformer",
    plural: "transformers",
    logFile: (n) => paths.transformerLogFile(n),
  },
};

function errorDetail(body: unknown): string {
  if (body && typeof body === "object" && "error" in body) {
    const e = (body as { error?: unknown }).error;
    if (typeof e === "string" && e.length > 0) {
      return `: ${e}`;
    }
  }
  return "";
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

export interface ResourceCommands {
  list: () => Promise<void>;
  add: (name: string | undefined, argv: string[]) => Promise<void>;
  remove: (name: string | undefined) => Promise<void>;
  start: (name: string | undefined) => Promise<void>;
  stop: (name: string | undefined) => Promise<void>;
  restart: (name: string | undefined) => Promise<void>;
  logs: (argv: string[]) => Promise<void>;
}

export function createResourceCommands(kind: ResourceKind): ResourceCommands {
  const spec = SPECS[kind];
  const base = `/v1/${spec.plural}`;

  async function list(): Promise<void> {
    const res = await daemonFetch(base, { expectStatus: 200 });
    const body = res.body as Record<string, ResourceInfo[]>;
    const items = body[spec.plural] ?? [];

    if (items.length === 0) {
      process.stdout.write(`No ${spec.plural} configured.\n`);
      return;
    }

    const rows = items.map((e) => ({
      name: e.name,
      status: e.status.toUpperCase(),
      version: e.version ?? "-",
      pid: e.pid != null ? String(e.pid) : "-",
      restarts: String(e.restartCount),
      started: e.startedAt ? formatRelative(e.startedAt) : "-",
      log: e.logPath,
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
    for (const e of items) {
      if (e.failureReason) {
        process.stdout.write(`  ↳ ${e.name}: ${e.failureReason}\n`);
      }
    }
  }

  async function add(
    name: string | undefined,
    argv: string[],
  ): Promise<void> {
    if (!name) {
      process.stderr.write(
        `Usage: hydra-acp ${spec.plural} add <name> [--command CMD] [--args A,B,C] [--env K=V]... [--disabled]\n`,
      );
      process.exit(2);
      return;
    }
    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
      process.stderr.write(
        `Invalid ${spec.singular} name '${name}': must match [A-Za-z0-9._-]+\n`,
      );
      process.exit(2);
      return;
    }

    // Validate the existing config parses cleanly (so we don't blindly write
    // alongside a broken file), then mutate the raw JSON so we only touch
    // the targeted entry — going through writeConfig would re-emit every
    // existing entry's defaults explicitly.
    await loadConfig();
    const raw = await readRawConfig();
    const rawMap = raw as Record<string, unknown>;
    if (!rawMap[spec.plural] || typeof rawMap[spec.plural] !== "object") {
      rawMap[spec.plural] = {};
    }
    const entries = rawMap[spec.plural] as Record<string, unknown>;
    if (entries[name]) {
      process.stderr.write(
        `${capitalize(spec.singular)} '${name}' already exists in config.\n`,
      );
      process.exit(1);
      return;
    }

    const parsed = parseAddFlags(argv, spec.singular);
    const command = parsed.command as string[];
    const body: Record<string, unknown> = {};
    if (command.length > 0) {
      body.command = command;
    }
    if (parsed.args.length > 0) {
      body.args = parsed.args;
    }
    if (Object.keys(parsed.env).length > 0) {
      body.env = parsed.env;
    }
    if (!parsed.enabled) {
      body.enabled = false;
    }
    entries[name] = body;

    await writeRawConfig(raw);
    process.stdout.write(
      `Added ${spec.singular} '${name}' to ${paths.config()}\n`,
    );

    const registerBody = { name, ...body };
    try {
      const res = await daemonFetch(base, {
        method: "POST",
        body: registerBody,
        rethrowNetworkError: true,
      });
      if (res.ok) {
        const info = res.body as ResourceInfo;
        const pid = info.pid != null ? ` pid=${info.pid}` : "";
        process.stdout.write(`${name}: ${info.status}${pid}\n`);
        return;
      }
      process.stderr.write(
        `Daemon refused to register ${name} (HTTP ${res.status}${errorDetail(res.body)}). Restart the daemon to apply.\n`,
      );
    } catch {
      // Daemon not running; the new entry will be picked up on next launch.
    }
  }

  async function remove(name: string | undefined): Promise<void> {
    if (!name) {
      process.stderr.write(
        `Usage: hydra-acp ${spec.plural} remove <name>\n`,
      );
      process.exit(2);
      return;
    }
    await loadConfig();
    const raw = await readRawConfig();
    const rawMap = raw as Record<string, unknown>;
    const entries = (rawMap[spec.plural] ?? {}) as Record<string, unknown>;
    if (!entries[name]) {
      process.stderr.write(
        `${capitalize(spec.singular)} '${name}' not found in config.\n`,
      );
      process.exit(1);
      return;
    }
    delete entries[name];
    rawMap[spec.plural] = entries;
    await writeRawConfig(raw);
    process.stdout.write(
      `Removed ${spec.singular} '${name}' from ${paths.config()}\n`,
    );

    try {
      const res = await daemonFetch(
        `${base}/${encodeURIComponent(name)}`,
        { method: "DELETE", rethrowNetworkError: true },
      );
      if (res.status === 204 || res.status === 404) {
        process.stdout.write(`${name}: stopped\n`);
        return;
      }
      process.stderr.write(
        `Daemon refused to unregister ${name} (HTTP ${res.status}${errorDetail(res.body)}).\n`,
      );
    } catch (err) {
      process.stderr.write(
        `Daemon not reachable (${(err as Error).message}). Config saved.\n`,
      );
    }
  }

  async function postLifecycle(
    name: string | undefined,
    verb: "start" | "stop" | "restart",
  ): Promise<void> {
    if (!name) {
      process.stderr.write(
        `Usage: hydra-acp ${spec.plural} ${verb} <name|all>\n`,
      );
      process.exit(2);
      return;
    }
    if (name === "all") {
      await postLifecycleAll(verb);
      return;
    }
    const res = await daemonFetch(
      `${base}/${encodeURIComponent(name)}/${verb}`,
      { method: "POST" },
    );
    if (!res.ok) {
      process.stderr.write(`HTTP ${res.status}${errorDetail(res.body)}\n`);
      process.exit(1);
      return;
    }
    const info = res.body as ResourceInfo;
    const pid = info.pid != null ? ` pid=${info.pid}` : "";
    process.stdout.write(`${name}: ${info.status}${pid}\n`);
  }

  async function postLifecycleAll(
    verb: "start" | "stop" | "restart",
  ): Promise<void> {
    const list = await daemonFetch(base, { expectStatus: 200 });
    const listBody = list.body as Record<string, ResourceInfo[]>;
    const items = listBody[spec.plural] ?? [];

    // Filter by what makes sense for each verb. start touches enabled-but-not-running;
    // stop and restart touch only currently-running entries.
    const targets = items.filter((e) => {
      if (verb === "start") {
        return e.enabled && e.status !== "running";
      }
      return e.status === "running";
    });

    if (targets.length === 0) {
      const reason =
        verb === "start"
          ? `no enabled ${spec.plural} are stopped`
          : `no ${spec.plural} are running`;
      process.stdout.write(`Nothing to ${verb}: ${reason}.\n`);
      return;
    }

    let failed = 0;
    for (const ent of targets) {
      try {
        const res = await daemonFetch(
          `${base}/${encodeURIComponent(ent.name)}/${verb}`,
          { method: "POST", rethrowNetworkError: true },
        );
        if (!res.ok) {
          process.stdout.write(
            `${ent.name}: ERROR HTTP ${res.status}${errorDetail(res.body)}\n`,
          );
          failed += 1;
          continue;
        }
        const info = res.body as ResourceInfo;
        const pid = info.pid != null ? ` pid=${info.pid}` : "";
        process.stdout.write(`${ent.name}: ${info.status}${pid}\n`);
      } catch (err) {
        process.stdout.write(
          `${ent.name}: ERROR ${(err as Error).message}\n`,
        );
        failed += 1;
      }
    }
    if (failed > 0) {
      process.exit(1);
    }
  }

  async function logs(argv: string[]): Promise<void> {
    const { name, rest } = splitNameFromLogTailArgs(argv);
    if (!name) {
      process.stderr.write(
        `Usage: hydra-acp ${spec.plural} log <name> [--tail N] [--follow]\n`,
      );
      process.exit(2);
      return;
    }
    const logPath = spec.logFile(name);
    await runLogTail(logPath, rest, `No log file (${spec.singular} never ran?)`);
  }

  return {
    list,
    add,
    remove,
    start: (name) => postLifecycle(name, "start"),
    stop: (name) => postLifecycle(name, "stop"),
    restart: (name) => postLifecycle(name, "restart"),
    logs,
  };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
