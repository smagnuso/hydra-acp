// First-launch agent picker. Shown only on an interactive `hydra` launch
// when the user has never chosen a default agent and didn't pass --agent.
// Enter sets the highlighted agent as the persisted default; `s` uses it
// for this session only; esc/q/^D abort the launch. Drawn in plain
// terminal mode before the TUI takes over the terminal.

import * as fsp from "node:fs/promises";
import { loadConfig } from "../core/config.js";
import { loadServiceToken } from "../core/service-token.js";
import { ensureDaemonReachable } from "../core/daemon-bootstrap.js";
import { paths } from "../core/paths.js";
import { httpBase } from "./commands/sessions.js";

interface AgentChoice {
  id: string;
  name: string;
  description?: string;
}

// Outcome of the picker:
//   { agentId, persist: true }  -> use now AND write config.defaultAgent
//   { agentId, persist: false } -> use for this session only, no write
//   undefined                   -> user aborted; caller should exit
export interface FirstLaunchResult {
  agentId: string;
  persist: boolean;
}

const PREFERRED_DEFAULT = "opencode";

// True when the user has never recorded a defaultAgent in config.json.
// We check the raw file (not the parsed config) because the zod schema
// always fills in a default, which would mask "never chosen".
export async function shouldOfferAgentPicker(): Promise<boolean> {
  try {
    const raw = await fsp.readFile(paths.config(), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return typeof parsed.defaultAgent !== "string";
  } catch {
    // No config file yet (fresh install) — definitely never chosen.
    return true;
  }
}

// Run the interactive picker. Returns the user's choice, or undefined if
// the agent list couldn't be fetched (caller should fall through to the
// schema default) or the user aborted (caller should exit).
export async function offerAgentPicker(): Promise<
  FirstLaunchResult | "fetch-failed" | "aborted"
> {
  const agents = await fetchAgents();
  if (agents === undefined || agents.length === 0) {
    return "fetch-failed";
  }
  const choice = await runMenu(agents);
  if (choice === undefined) {
    return "aborted";
  }
  if (choice.persist) {
    await persistDefaultAgent(choice.agentId);
  }
  return choice;
}

async function fetchAgents(): Promise<AgentChoice[] | undefined> {
  try {
    const config = await loadConfig();
    await ensureDaemonReachable(config);
    const serviceToken = await loadServiceToken();
    const baseUrl = httpBase(
      config.daemon.host,
      config.daemon.port,
      !!config.daemon.tls,
    );
    const r = await fetch(`${baseUrl}/v1/agents`, {
      headers: { Authorization: `Bearer ${serviceToken}` },
    });
    if (!r.ok) {
      return undefined;
    }
    const body = (await r.json()) as {
      agents: { id: string; name: string; description?: string }[];
    };
    return body.agents.map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description,
    }));
  } catch {
    return undefined;
  }
}

async function persistDefaultAgent(agentId: string): Promise<void> {
  // Read-modify-write the raw JSON so we preserve any unknown fields a
  // user may have hand-added, mirroring `hydra agent set`.
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(await fsp.readFile(paths.config(), "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    raw = {};
  }
  raw.defaultAgent = agentId;
  await fsp.mkdir(paths.home(), { recursive: true });
  await fsp.writeFile(
    paths.config(),
    JSON.stringify(raw, null, 2) + "\n",
    { encoding: "utf8", mode: 0o600 },
  );
}

function initialIndex(agents: AgentChoice[]): number {
  const idx = agents.findIndex((a) => a.id === PREFERRED_DEFAULT);
  return idx === -1 ? 0 : idx;
}

// Plain raw-stdin menu. No terminal-kit / TUI takeover — this runs
// before the TUI starts. Arrow keys (and j/k) move; enter sets default,
// `s` is session-only, esc/q/^D abort. Returns undefined on abort.
async function runMenu(
  agents: AgentChoice[],
): Promise<FirstLaunchResult | undefined> {
  if (!process.stdin.isTTY) {
    // No interactive TTY to drive the menu — treat as "use preferred
    // default for this session only" rather than blocking.
    return { agentId: agents[initialIndex(agents)]!.id, persist: false };
  }

  let selected = initialIndex(agents);

  const out = process.stdout;
  out.write("Pick a default agent:\n\n");
  const render = (first: boolean): void => {
    if (!first) {
      // Move cursor back up over the list + footer to redraw in place.
      out.write(`\x1b[${agents.length + 2}A`);
    }
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i]!;
      const marker = i === selected ? "\x1b[36m>\x1b[0m" : " ";
      const label = i === selected ? `\x1b[1m${a.id}\x1b[0m` : a.id;
      const desc = a.description ? `  \x1b[2m${a.description}\x1b[0m` : "";
      out.write(`\x1b[2K ${marker} ${label}${desc}\n`);
    }
    out.write("\x1b[2K\n");
    out.write(
      "\x1b[2K\x1b[2m\u2191/\u2193 move \u00b7 enter set default \u00b7 s this session \u00b7 esc/q cancel\x1b[0m\n",
    );
  };
  render(true);

  return new Promise<FirstLaunchResult | undefined>((resolve) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw === true;
    const cleanup = (): void => {
      stdin.removeListener("data", onData);
      if (!wasRaw) {
        stdin.setRawMode(false);
      }
      stdin.pause();
    };
    const finish = (result: FirstLaunchResult | undefined): void => {
      cleanup();
      out.write("\n");
      resolve(result);
    };
    const onData = (chunk: Buffer): void => {
      const s = chunk.toString("latin1");
      // Arrow keys arrive as escape sequences; a bare ESC (length 1)
      // means cancel.
      if (s === "\x1b[A" || s === "k") {
        selected = (selected - 1 + agents.length) % agents.length;
        render(false);
        return;
      }
      if (s === "\x1b[B" || s === "j") {
        selected = (selected + 1) % agents.length;
        render(false);
        return;
      }
      for (const ch of s) {
        const byte = ch.charCodeAt(0);
        if (byte === 0x0d || byte === 0x0a) {
          finish({ agentId: agents[selected]!.id, persist: true });
          return;
        }
        if (ch === "s" || ch === "S") {
          finish({ agentId: agents[selected]!.id, persist: false });
          return;
        }
        // ^D, ^C, ESC, or q all abort.
        if (byte === 0x04 || byte === 0x03 || byte === 0x1b || ch === "q") {
          finish(undefined);
          return;
        }
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}
