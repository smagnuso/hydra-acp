#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parseArgs, resolveOption } from "./cli/parse-args.js";
import { runInit } from "./cli/commands/init.js";
import {
  runDaemonLogs,
  runDaemonRestart,
  runDaemonStart,
  runDaemonStatus,
  runDaemonStop,
} from "./cli/commands/daemon.js";
import {
  runSessionsExport,
  runSessionsImport,
  runSessionsKill,
  runSessionsList,
  runSessionsRm,
} from "./cli/commands/sessions.js";
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
        "Usage: hydra-acp launch <agent-id> [agent-args...]\n",
      );
      process.exit(2);
      return;
    }
    const launchResume = flags.resume;
    const sessionId =
      typeof launchResume === "string"
        ? launchResume
        : resolveOption(flags, "session-id");
    const name = resolveOption(flags, "name");
    await runShim({ sessionId, agentId, agentArgs, name });
    return;
  }

  const { positional, flags } = parseArgs(argv);

  if (flags.version === true || positional[0] === "--version") {
    process.stdout.write(`hydra-acp ${readVersion()}\n`);
    return;
  }
  if (flags.help === true) {
    printHelp();
    return;
  }

  const subcommand = positional[0];
  // --resume <id> is the preferred way to attach to a specific session.
  // --session-id <id> is kept for backwards compatibility / env-var use.
  // Bare --resume (no value) still means "pick the most recent in cwd".
  const resumeFlag = flags.resume;
  const sessionId =
    typeof resumeFlag === "string"
      ? resumeFlag
      : resolveOption(flags, "session-id");
  const name = resolveOption(flags, "name");
  const agentIdFromFlag = resolveOption(flags, "agent-id");

  if (!subcommand) {
    // Auto-dispatch when invoked with no subcommand: TUI when attached to
    // a terminal, shim when stdio is piped (the editor-spawned case).
    // Either path is forced explicitly via `hydra-acp tui` or
    // `hydra-acp shim` if the caller wants to bypass detection.
    if (process.stdout.isTTY) {
      await dispatchTui(flags, {
        sessionId,
        agentId: agentIdFromFlag,
        name,
      });
      return;
    }
    await runShim({ sessionId, name, agentId: agentIdFromFlag });
    return;
  }

  switch (subcommand) {
    case "shim":
      await runShim({ sessionId, name, agentId: agentIdFromFlag });
      return;
    case "init":
      await runInit(flags);
      return;
    case "daemon": {
      const daemonIdx = argv.indexOf("daemon");
      const tail = argv.slice(daemonIdx + 1);
      const sub = tail[0];
      if (sub === "start" || sub === undefined) {
        await runDaemonStart(flags);
        return;
      }
      if (sub === "stop") {
        await runDaemonStop();
        return;
      }
      if (sub === "restart") {
        await runDaemonRestart();
        return;
      }
      if (sub === "status") {
        await runDaemonStatus();
        return;
      }
      if (sub === "logs") {
        await runDaemonLogs(tail.slice(1));
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
      if (sub === "rm") {
        await runSessionsRm(positional[2]);
        return;
      }
      if (sub === "export") {
        const out = resolveOption(flags, "out");
        await runSessionsExport(positional[2], out);
        return;
      }
      if (sub === "import") {
        await runSessionsImport(positional[2], {
          replace: flags.replace === true,
        });
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
  agentId?: string | undefined;
  name?: string | undefined;
}

async function dispatchTui(
  flags: Record<string, string | boolean>,
  base: TuiBaseOpts,
): Promise<void> {
  const cwd = resolveOption(flags, "cwd");
  // Only the bare-boolean form of --resume triggers "pick most recent";
  // --resume <id> was already promoted to base.sessionId in main().
  const resume = flags.resume === true;
  const forceNew = flags.new === true;
  const { runTui } = await import("./tui/index.js");
  const tuiOpts: Parameters<typeof runTui>[0] = { resume, forceNew };
  if (base.sessionId !== undefined) {
    tuiOpts.sessionId = base.sessionId;
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

function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      readFileSync(resolve(here, "../package.json"), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function printHelp(): void {
  process.stdout.write(
    [
      "hydra-acp — multi-client ACP session daemon",
      "",
      "Usage:",
      "  hydra-acp                          Auto: TUI when stdout is a TTY, shim otherwise (the editor-spawned case)",
      "  hydra-acp shim                     Run as ACP shim explicitly (forces shim mode regardless of TTY)",
      "  hydra-acp tui [opts]               Run the terminal UI explicitly (see below for opts)",
      "  hydra-acp launch <agent-id> [agent-args...]",
      "                                     Shim mode, force daemon to spawn <agent-id>",
      "                                     from the registry. Args after <agent-id>",
      "                                     are forwarded to the agent's command.",
      "  hydra-acp --resume <id>            Attach to an existing session (TUI when in a terminal, shim otherwise)",
      "  hydra-acp init [--rotate-token]    Initialize ~/.hydra-acp/config.json",
      "  hydra-acp daemon start [--foreground]   Start daemon (detached by default; --foreground to attach)",
      "  hydra-acp daemon stop|restart|status",
      "  hydra-acp daemon logs [-f] [-n N]  Tail or follow the daemon log",
      "  hydra-acp sessions [list] [--all]  List sessions (live + 20 most-recent cold; --all for everything)",
      "  hydra-acp sessions kill <id>       Demote a live session to cold (keeps the on-disk record)",
      "  hydra-acp sessions rm <id>         Remove a session entirely (live or cold)",
      "  hydra-acp sessions export <id> [--out <file>|.]",
      "                                     Write a session bundle to <file>, to a default-named file when --out=., or to stdout",
      "  hydra-acp sessions import <file>|- [--replace]",
      "                                     Import a bundle from <file> or stdin (-); --replace overwrites a lineage match (kills it if live)",
      "  hydra-acp extensions list                   List configured extensions and live state",
      "  hydra-acp extensions add <name> [opts]      Add an extension to config",
      "  hydra-acp extensions remove <name>          Remove an extension from config",
      "  hydra-acp extensions start|stop|restart <n>|all  Lifecycle on one or all",
      "  hydra-acp extensions logs <name> [-f] [-n N]Tail or follow an extension's log",
      "  hydra-acp agents [list]                     List agents in the cached registry",
      "  hydra-acp agents refresh                    Force a registry re-fetch",
      "  hydra-acp tui flags: [--resume [<id>]] [--new] [--agent-id <id>] [--cwd <path>] [--name <label>]",
      "                                     --resume <id> attaches to a specific session; bare --resume picks the most-recent",
      "                                     in cwd. Smart default (no flags): picks if any live sessions exist, else new.",
      "  hydra-acp --version                Print version",
      "  hydra-acp --help                   Show this help",
      "",
      "Config knob flags accept env-var equivalents (flag wins):",
      "  --agent-id              HYDRA_ACP_AGENT_ID",
      "  --resume / --session-id HYDRA_ACP_SESSION_ID",
      "  --name                  HYDRA_ACP_NAME",
      "",
    ].join("\n"),
  );
}

main().catch((err) => {
  process.stderr.write(`hydra-acp: ${(err as Error).message}\n`);
  process.exit(1);
});
