#!/usr/bin/env node
import { parseArgs, resolveOption } from "./cli/parse-args.js";
import { runInit } from "./cli/commands/init.js";
import {
  runDaemonStart,
  runDaemonStatus,
  runDaemonStop,
} from "./cli/commands/daemon.js";
import { runSessionsKill, runSessionsList } from "./cli/commands/sessions.js";
import {
  runExtensionsAdd,
  runExtensionsList,
  runExtensionsLogs,
  runExtensionsRemove,
  runExtensionsRestart,
  runExtensionsStart,
  runExtensionsStop,
} from "./cli/commands/extensions.js";
import { runAgentsList, runAgentsRefresh } from "./cli/commands/agents.js";
import { runShim } from "./shim/proxy.js";
import type { SessionRole } from "./acp/types.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  const launchIdx = argv.indexOf("launch");

  if (launchIdx !== -1) {
    const beforeLaunch = argv.slice(0, launchIdx);
    const afterLaunch = argv.slice(launchIdx + 1);
    const positionalAgentId = afterLaunch[0];
    const agentArgs = afterLaunch.slice(1);

    const { flags } = parseArgs(beforeLaunch);
    const agentId =
      positionalAgentId ?? resolveOption(flags, "agent-id");
    if (!agentId) {
      process.stderr.write(
        "Usage: acp-hydra launch <agent-id> [agent-args...]\n",
      );
      process.exit(2);
      return;
    }
    const sessionId = resolveOption(flags, "session-id");
    const role = resolveSessionRole(resolveOption(flags, "role"));
    const name = resolveOption(flags, "name");
    await runShim({ sessionId, role, agentId, agentArgs, name });
    return;
  }

  const { positional, flags } = parseArgs(argv);

  if (flags.version === true || positional[0] === "--version") {
    process.stdout.write("acp-hydra 0.1.0\n");
    return;
  }
  if (flags.help === true) {
    printHelp();
    return;
  }

  const subcommand = positional[0];
  const sessionId = resolveOption(flags, "session-id");
  const role = resolveSessionRole(resolveOption(flags, "role"));
  const name = resolveOption(flags, "name");
  const agentIdFromFlag = resolveOption(flags, "agent-id");

  if (!subcommand) {
    // Auto-dispatch when invoked with no subcommand: TUI when attached to
    // a terminal, shim when stdio is piped (the editor-spawned case).
    // Either path is forced explicitly via `acp-hydra tui` or
    // `acp-hydra shim` if the caller wants to bypass detection.
    if (process.stdout.isTTY) {
      await dispatchTui(flags, {
        sessionId,
        role,
        agentId: agentIdFromFlag,
        name,
      });
      return;
    }
    await runShim({ sessionId, role, name, agentId: agentIdFromFlag });
    return;
  }

  switch (subcommand) {
    case "shim":
      await runShim({ sessionId, role, name, agentId: agentIdFromFlag });
      return;
    case "init":
      await runInit(flags);
      return;
    case "daemon": {
      const sub = positional[1];
      if (sub === "start" || sub === undefined) {
        await runDaemonStart();
        return;
      }
      if (sub === "stop") {
        await runDaemonStop();
        return;
      }
      if (sub === "status") {
        await runDaemonStatus();
        return;
      }
      process.stderr.write(`Unknown daemon subcommand: ${sub}\n`);
      process.exit(2);
      return;
    }
    case "sessions": {
      const sub = positional[1];
      if (sub === undefined || sub === "list") {
        await runSessionsList({ all: flags.all === true });
        return;
      }
      if (sub === "kill") {
        await runSessionsKill(positional[2]);
        return;
      }
      process.stderr.write(`Unknown sessions subcommand: ${sub}\n`);
      process.exit(2);
      return;
    }
    case "extensions": {
      const extIdx = argv.indexOf("extensions");
      const tail = argv.slice(extIdx + 1);
      const sub = tail[0];
      const name = tail[1];
      const rest = tail.slice(2);
      if (sub === undefined || sub === "list") {
        await runExtensionsList();
        return;
      }
      if (sub === "add") {
        await runExtensionsAdd(name, rest);
        return;
      }
      if (sub === "remove") {
        await runExtensionsRemove(name);
        return;
      }
      if (sub === "start") {
        await runExtensionsStart(name);
        return;
      }
      if (sub === "stop") {
        await runExtensionsStop(name);
        return;
      }
      if (sub === "restart") {
        await runExtensionsRestart(name);
        return;
      }
      if (sub === "logs") {
        await runExtensionsLogs(name, rest);
        return;
      }
      process.stderr.write(`Unknown extensions subcommand: ${sub}\n`);
      process.exit(2);
      return;
    }
    case "agents": {
      const sub = positional[1];
      if (sub === undefined || sub === "list") {
        await runAgentsList();
        return;
      }
      if (sub === "refresh") {
        await runAgentsRefresh();
        return;
      }
      process.stderr.write(`Unknown agents subcommand: ${sub}\n`);
      process.exit(2);
      return;
    }
    case "tui":
      await dispatchTui(flags, {
        sessionId,
        role,
        agentId: agentIdFromFlag,
        name,
      });
      return;
    default:
      process.stderr.write(`Unknown command: ${subcommand}\n`);
      printHelp();
      process.exit(2);
  }
}

interface TuiBaseOpts {
  sessionId?: string | undefined;
  role?: SessionRole | undefined;
  agentId?: string | undefined;
  name?: string | undefined;
}

async function dispatchTui(
  flags: Record<string, string | boolean>,
  base: TuiBaseOpts,
): Promise<void> {
  const cwd = resolveOption(flags, "cwd");
  const resume = flags.resume === true;
  const forceNew = flags.new === true;
  const { runTui } = await import("./tui/index.js");
  const tuiOpts: Parameters<typeof runTui>[0] = { resume, forceNew };
  if (base.sessionId !== undefined) {
    tuiOpts.sessionId = base.sessionId;
  }
  if (base.role !== undefined) {
    tuiOpts.role = base.role;
  }
  if (base.agentId !== undefined) {
    tuiOpts.agentId = base.agentId;
  }
  if (cwd !== undefined) {
    tuiOpts.cwd = cwd;
  }
  if (base.name !== undefined) {
    tuiOpts.name = base.name;
  }
  await runTui(tuiOpts);
}

function resolveSessionRole(raw: string | undefined): SessionRole | undefined {
  if (raw === "controller" || raw === "observer") {
    return raw;
  }
  return undefined;
}

function printHelp(): void {
  process.stdout.write(
    [
      "acp-hydra — multi-client ACP session daemon",
      "",
      "Usage:",
      "  acp-hydra                          Auto: TUI when stdout is a TTY, shim otherwise (the editor-spawned case)",
      "  acp-hydra shim                     Run as ACP shim explicitly (forces shim mode regardless of TTY)",
      "  acp-hydra tui [opts]               Run the terminal UI explicitly (see below for opts)",
      "  acp-hydra launch <agent-id> [agent-args...]",
      "                                     Shim mode, force daemon to spawn <agent-id>",
      "                                     from the registry. Args after <agent-id>",
      "                                     are forwarded to the agent's command.",
      "  acp-hydra --session-id <id> [--role controller|observer]",
      "                                     Attach to an existing session (TUI when in a terminal, shim otherwise)",
      "  acp-hydra init [--rotate-token]    Initialize ~/.acp-hydra/config.json",
      "  acp-hydra daemon start|stop|status",
      "  acp-hydra sessions [list] [--all]  List sessions (live + recent cold; --all for full disk view)",
      "  acp-hydra sessions kill <id>       Kill a session (live or cold)",
      "  acp-hydra extensions list                   List configured extensions and live state",
      "  acp-hydra extensions add <name> [opts]      Add an extension to config",
      "  acp-hydra extensions remove <name>          Remove an extension from config",
      "  acp-hydra extensions start|stop|restart <n>|all  Lifecycle on one or all",
      "  acp-hydra extensions logs <name> [-f] [-n N]Tail or follow an extension's log",
      "  acp-hydra agents [list]                     List agents in the cached registry",
      "  acp-hydra agents refresh                    Force a registry re-fetch",
      "  acp-hydra tui flags: [--session-id <id>] [--resume] [--new] [--agent-id <id>] [--cwd <path>] [--role controller|observer] [--name <label>]",
      "                                     Smart default: picks an existing live session if any exist in cwd, else creates a new one",
      "  acp-hydra --version                Print version",
      "  acp-hydra --help                   Show this help",
      "",
      "Config knob flags accept env-var equivalents (flag wins):",
      "  --agent-id    ACP_HYDRA_AGENT_ID",
      "  --session-id  ACP_HYDRA_SESSION_ID",
      "  --role        ACP_HYDRA_ROLE",
      "  --name        ACP_HYDRA_NAME",
      "",
    ].join("\n"),
  );
}

main().catch((err) => {
  process.stderr.write(`acp-hydra: ${(err as Error).message}\n`);
  process.exit(1);
});
