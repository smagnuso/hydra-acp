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
  runSessionsRemove,
  runSessionsTranscript,
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
import {
  runAuthList,
  runAuthPasswordSet,
  runAuthRevoke,
} from "./cli/commands/auth.js";
import { runShim } from "./shim/proxy.js";
import {
  buildTitleFromArgv,
  setHydraProcessTitle,
} from "./core/process-title.js";
import {
  formatUpdateNoticeLine,
  getPendingUpdate,
} from "./core/update-check.js";

// Set when a code path takes over the process for the long haul (shim
// over piped stdio, or the TUI's alternate screen) so the post-main
// notice doesn't corrupt the JSON-RPC stream or print over the TUI's
// last frame after it exits. The TUI handles its own notice in
// scrollback.
let suppressUpdateNotice = false;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  const launchIdx = argv.indexOf("launch");

  if (launchIdx !== -1) {
    const beforeLaunch = argv.slice(0, launchIdx);
    const afterLaunch = argv.slice(launchIdx + 1);
    const positionalAgentId = afterLaunch[0];
    const agentArgs = afterLaunch.slice(1);

    const { flags } = parseArgs(beforeLaunch);
    if (flags.resume === true) {
      bareResumeError();
      return;
    }
    if (flags.reattach === true) {
      process.stderr.write(
        "hydra-acp launch: --reattach is not valid here. Pass --resume <id> to attach to a specific session.\n",
      );
      process.exit(2);
      return;
    }
    const agentId =
      positionalAgentId ?? resolveOption(flags, "agent");
    if (!agentId) {
      process.stderr.write(
        "Usage: hydra-acp launch <agent> [agent-args...]\n",
      );
      process.exit(2);
      return;
    }
    const sessionId =
      typeof flags.resume === "string"
        ? flags.resume
        : resolveOption(flags, "session-id");
    const name = resolveOption(flags, "name");
    const model = resolveOption(flags, "model");
    suppressUpdateNotice = true;
    await runShim({ sessionId, agentId, agentArgs, name, model });
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
  if (flags.resume === true) {
    bareResumeError();
    return;
  }
  // --resume <id> attaches to a specific session. --session-id <id> is kept
  // for env-var / backwards compatibility. --reattach (boolean) picks the
  // most recent session for cwd; it used to be bare --resume.
  const sessionId =
    typeof flags.resume === "string"
      ? flags.resume
      : resolveOption(flags, "session-id");
  const name = resolveOption(flags, "name");
  const agentIdFromFlag = resolveOption(flags, "agent");
  const model = resolveOption(flags, "model");

  if (!subcommand) {
    // Auto-dispatch when invoked with no subcommand: TUI when attached to
    // a terminal, shim when stdio is piped (the editor-spawned case).
    // Either path is forced explicitly via `hydra-acp tui` or
    // `hydra-acp shim` if the caller wants to bypass detection.
    if (process.stdout.isTTY) {
      suppressUpdateNotice = true;
      await dispatchTui(flags, {
        sessionId,
        agentId: agentIdFromFlag,
        name,
        model,
      });
      return;
    }
    suppressUpdateNotice = true;
    await runShim({ sessionId, name, agentId: agentIdFromFlag, model });
    return;
  }

  switch (subcommand) {
    case "shim":
      suppressUpdateNotice = true;
      await runShim({ sessionId, name, agentId: agentIdFromFlag, model });
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
    case "session":
    case "sessions": {
      const sub = positional[1];
      if (sub === undefined || sub === "list") {
        await runSessionsList({
          all: flags.all === true,
          json: flags.json === true,
          host: typeof flags.host === "string" ? flags.host : undefined,
        });
        return;
      }
      if (sub === "kill") {
        await runSessionsKill(positional[2]);
        return;
      }
      if (sub === "remove") {
        await runSessionsRemove(positional[2]);
        return;
      }
      if (sub === "export") {
        const out = resolveOption(flags, "out");
        await runSessionsExport(positional[2], out);
        return;
      }
      if (sub === "transcript") {
        const out = resolveOption(flags, "out");
        await runSessionsTranscript(positional[2], out);
        return;
      }
      if (sub === "import") {
        const cwd = resolveOption(flags, "cwd");
        await runSessionsImport(positional[2], {
          replace: flags.replace === true,
          info: flags.info === true,
          ...(cwd !== undefined ? { cwd } : {}),
        });
        return;
      }
      process.stderr.write(`Unknown session subcommand: ${sub}\n`);
      process.exit(2);
      return;
    }
    case "extension":
    case "extensions": {
      const extIdx = argv.indexOf(subcommand);
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
      process.stderr.write(`Unknown extension subcommand: ${sub}\n`);
      process.exit(2);
      return;
    }
    case "agent":
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
      process.stderr.write(`Unknown agent subcommand: ${sub}\n`);
      process.exit(2);
      return;
    }
    case "auth": {
      const sub = positional[1];
      if (sub === "password") {
        const action = positional[2];
        if (action === undefined || action === "set") {
          await runAuthPasswordSet(flags);
          return;
        }
        process.stderr.write(`Unknown auth password action: ${action}\n`);
        process.exit(2);
        return;
      }
      if (sub === undefined || sub === "list") {
        await runAuthList();
        return;
      }
      if (sub === "revoke") {
        await runAuthRevoke(positional[2]);
        return;
      }
      process.stderr.write(`Unknown auth subcommand: ${sub}\n`);
      process.exit(2);
      return;
    }
    case "tui":
      suppressUpdateNotice = true;
      await dispatchTui(flags, {
        sessionId,
        agentId: agentIdFromFlag,
        name,
        model,
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
  model?: string | undefined;
}

async function dispatchTui(
  flags: Record<string, string | boolean>,
  base: TuiBaseOpts,
): Promise<void> {
  const cwd = resolveOption(flags, "cwd");
  // --resume <id> was already promoted to base.sessionId in main();
  // --reattach is what now triggers "pick most recent in cwd".
  const resume = flags.reattach === true;
  const forceNew = flags.new === true;
  const readonly = flags.readonly === true;
  // --readonly opens an existing session as a transcript viewer; it
  // doesn't make sense without a target. Bare --readonly without a
  // session id has nothing to view — error so the user uses the
  // picker's `v` keystroke instead.
  if (readonly && base.sessionId === undefined) {
    process.stderr.write(
      "hydra-acp: --readonly requires a session id. Pass --resume <id> --readonly, or open the picker and press `v` on a session.\n",
    );
    process.exit(2);
  }
  // Rewrite argv0 so `ps`/`top` show the full command (TUI vs which
  // session etc.) while `killall hydra` still finds every interactive
  // hydra process without also killing the daemon. The daemon sets
  // its own kernel comm name to "hydra-daemon" in runDaemonStart;
  // setHydraProcessTitle keeps interactive procs anchored at "hydra".
  setHydraProcessTitle(buildTitleFromArgv(process.argv.slice(2)));
  const { runTui } = await import("./tui/index.js");
  const tuiOpts: Parameters<typeof runTui>[0] = { resume, forceNew, readonly };
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
  if (base.model !== undefined) {
    tuiOpts.model = base.model;
  }
  await runTui(tuiOpts);
}

function bareResumeError(): void {
  process.stderr.write(
    "hydra-acp: --resume requires a session id. Use --resume <id> to attach to a specific session, or --reattach to pick the most recent one in cwd.\n",
  );
  process.exit(2);
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
      "  hydra-acp launch <agent> [agent-args...]",
      "                                     Shim mode, force daemon to spawn <agent>",
      "                                     from the registry. Args after <agent>",
      "                                     are forwarded to the agent's command.",
      "  hydra-acp --resume <id>            Attach to an existing session (TUI when in a terminal, shim otherwise)",
      "  hydra-acp --reattach               Attach to the most-recent session for the current cwd (TUI/shim auto-pick)",
      "  hydra-acp init [--rotate-token]    Initialize ~/.hydra-acp/config.json",
      "  hydra-acp daemon start [--foreground]   Start daemon (detached by default; --foreground to attach)",
      "  hydra-acp daemon stop|restart|status",
      "  hydra-acp daemon logs [-f] [-n N]  Tail or follow the daemon log",
      "  hydra-acp session [list] [--all] [--json] [--host=<host>]",
      "                                     List sessions (live + 20 most-recent cold; --all for everything; --json emits JSON for scripts).",
      "                                     --host filters by origin machine: 'local' (default) shows only sessions created here, 'all' shows everything, or pass a hostname (e.g. machine-b) to show only imports from that peer.",
      "  hydra-acp session kill <id>        Demote a live session to cold (keeps the on-disk record)",
      "  hydra-acp session remove <id>      Remove a session entirely (live or cold)",
      "  hydra-acp session export <id> [--out <file>|.]",
      "                                     Write a session bundle to <file>, to a default-named file when --out=., or to stdout",
      "  hydra-acp session transcript <id>|<file> [--out <file>|.]",
      "                                     Render a session as a markdown transcript. Accepts a session id (renders via the daemon) or a local .hydra bundle file (rendered in-process). Writes to <file>, to a default-named file when --out=., or to stdout",
      "  hydra-acp session import <file>|- [--replace] [--cwd <path>] [--info]",
      "                                     Import a bundle from <file> or stdin (-); --replace overwrites a lineage match (kills it if live); --cwd overrides the bundle's recorded working directory; --info prints the bundle's meta without importing",
      "  hydra-acp extension list                    List configured extensions and live state",
      "  hydra-acp extension add <name> [opts]       Add an extension to config",
      "  hydra-acp extension remove <name>           Remove an extension from config",
      "  hydra-acp extension start|stop|restart <n>|all   Lifecycle on one or all",
      "  hydra-acp extension logs <name> [-f] [-n N]      Tail or follow an extension's log",
      "  hydra-acp agent [list]                      List agents in the cached registry",
      "  hydra-acp agent refresh                     Force a registry re-fetch",
      "  hydra-acp auth password [--force]           Set the daemon's master password",
      "  hydra-acp auth [list]                       List active session tokens",
      "  hydra-acp auth revoke <id>                  Revoke a session token",
      "  hydra-acp tui flags: [--resume <id>] [--reattach] [--new] [--readonly] [--agent <id>] [--model <id>] [--cwd <path>] [--name <label>]",
      "                                     --resume <id> attaches to a specific session; --reattach picks the most-recent in cwd.",
      "                                     --readonly opens a session as a transcript viewer (no agent spawn, no prompting). Requires --resume.",
      "                                     Smart default (no flags): shows a picker when sessions exist, else new.",
      "  hydra-acp --version                Print version",
      "  hydra-acp --help                   Show this help",
      "",
      "Config knob flags accept env-var equivalents (flag wins):",
      "  --agent                 HYDRA_ACP_AGENT",
      "  --model                 HYDRA_ACP_MODEL    (one-shot at session/new; ignored on --resume)",
      "  --resume / --session-id HYDRA_ACP_SESSION_ID",
      "  --name                  HYDRA_ACP_NAME",
      "",
    ].join("\n"),
  );
}

async function maybePrintUpdateNotice(): Promise<void> {
  if (suppressUpdateNotice) {
    return;
  }
  try {
    const info = await getPendingUpdate();
    if (info) {
      process.stderr.write(`✨ ${formatUpdateNoticeLine(info)}\n`);
    }
  } catch {
    // Update check is best-effort; never let it disrupt the exit code.
  }
}

main()
  .then(maybePrintUpdateNotice)
  .catch(async (err) => {
    process.stderr.write(`hydra-acp: ${(err as Error).message}\n`);
    await maybePrintUpdateNotice();
    process.exit(1);
  });
