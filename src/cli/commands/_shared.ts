// Shared helpers used by every cli/commands/*.ts file that talks to the
// daemon over HTTP, formats relative timestamps, parses `--command /
// --args / --env / --disabled` add-flags, or reads/writes the raw user
// config JSON. Lifted out so each command file stops re-implementing
// the same fetch+auth+error boilerplate three different ways.

import * as fsp from "node:fs/promises";
import { loadConfig } from "../../core/config.js";
import { loadServiceToken } from "../../core/service-token.js";
import { paths } from "../../core/paths.js";
export function httpBase(host: string, port: number, tls: boolean): string {
  const protocol = tls ? "https" : "http";
  return `${protocol}://${host}:${port}`;
}

export { openWs } from "../../shim/open-ws.js";

export interface DaemonFetchOpts {
  method?: string;
  body?: unknown;
  // When set, daemonFetch will treat any response whose status isn't in
  // this list as a hard error: it tries to parse `{error}` out of the
  // body and exits the process with `errorPrefix: detail` on stderr.
  // Leave unset to opt out of that behavior and inspect {ok,status,body}
  // yourself (sessions.ts has 404/409 branches that need this).
  expectStatus?: number | number[];
  errorPrefix?: string;
  // Default: a network/transport error exits the process with the
  // "Could not reach daemon at $url: ..." message. Set true to let
  // the error bubble out via throw — for callers that want to fall
  // through silently when the daemon isn't running (extensions /
  // transformers register/unregister save config first, then make a
  // best-effort daemon call).
  rethrowNetworkError?: boolean;
}

export interface DaemonFetchResult {
  ok: boolean;
  status: number;
  body: unknown;
}

export async function daemonFetch(
  path: string,
  opts: DaemonFetchOpts = {},
): Promise<DaemonFetchResult> {
  const config = await loadConfig();
  const serviceToken = await loadServiceToken();
  const baseUrl = httpBase(
    config.daemon.host,
    config.daemon.port,
    !!config.daemon.tls,
  );
  const url = path.startsWith("http") ? path : `${baseUrl}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${serviceToken}`,
  };
  let bodyInit: string | undefined;
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    bodyInit = JSON.stringify(opts.body);
  }
  let response: Response;
  try {
    response = await fetch(url, {
      method: opts.method,
      headers,
      ...(bodyInit !== undefined ? { body: bodyInit } : {}),
    });
  } catch (err) {
    if (opts.rethrowNetworkError) {
      throw err;
    }
    process.stderr.write(
      `Could not reach daemon at ${baseUrl}: ${(err as Error).message}\n`,
    );
    process.exit(1);
  }
  let parsed: unknown = null;
  // 204 has no body. Anything else: best-effort JSON parse, swallow
  // failures so a non-JSON error page doesn't mask the real status.
  if (response.status !== 204) {
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }
  }
  const expect = opts.expectStatus;
  const matches =
    expect === undefined
      ? response.ok
      : Array.isArray(expect)
        ? expect.includes(response.status)
        : expect === response.status;
  if (expect !== undefined && !matches) {
    let detail = `HTTP ${response.status}`;
    if (parsed && typeof parsed === "object" && "error" in parsed) {
      const e = (parsed as { error?: unknown }).error;
      if (typeof e === "string" && e.length > 0) {
        detail = e;
      }
    }
    const prefix = opts.errorPrefix ?? "Daemon returned";
    process.stderr.write(`${prefix} ${detail}\n`);
    process.exit(1);
  }
  return { ok: response.ok, status: response.status, body: parsed };
}

// Single canonical time-ago formatter. Output shape: "Xs ago", "Xm ago",
// "Xh ago", "Xd ago" — the form previously used by extensions.ts and
// transformers.ts. Replaces the longer "X minute(s)" form from agents.ts
// and the unit-only form from sessions.ts so every list/info command
// reads the same way.
export function formatRelative(date: Date | string | number): string {
  let ms: number;
  if (date instanceof Date) {
    ms = date.getTime();
  } else if (typeof date === "string") {
    ms = Date.parse(date);
  } else {
    ms = date;
  }
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

export interface ParsedAddFlags {
  // For `agent add`: a single command string (no shell splitting).
  // For `extensions/transformers add`: a string[] split on whitespace
  // so `--command "node script.js"` becomes ["node", "script.js"].
  command: string | string[] | undefined;
  args: string[];
  env: Record<string, string>;
  // Only meaningful for extensions/transformers. Always present so
  // callers can destructure uniformly.
  enabled: boolean;
}

export function parseAddFlags(
  argv: string[],
  kind: "agent" | "extension" | "transformer",
): ParsedAddFlags {
  const splitCommand = kind !== "agent";
  // `agent` keeps the command as a single string (run as-is). Extension
  // and transformer split into argv-style string[] so the daemon doesn't
  // re-shell-parse. Default reflects that: undefined vs empty array.
  let command: string | string[] | undefined = splitCommand ? [] : undefined;
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
      command = splitCommand ? splitShellWords(v) : v;
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
    if (tok === "--disabled" && kind !== "agent") {
      enabled = false;
      i += 1;
      continue;
    }
    process.stderr.write(`Unknown flag: ${tok}\n`);
    process.exit(2);
  }
  return { command, args: argList, env, enabled };
}

export function splitShellWords(s: string): string[] {
  return s.split(/\s+/).filter((p) => p.length > 0);
}

export async function readRawConfig(): Promise<Record<string, unknown>> {
  const raw = await fsp.readFile(paths.config(), "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

export async function writeRawConfig(
  raw: Record<string, unknown>,
): Promise<void> {
  await fsp.writeFile(paths.config(), JSON.stringify(raw, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
}
