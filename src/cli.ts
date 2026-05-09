#!/usr/bin/env node
import { parseArgs, flagString } from "./cli/parse-args.js";
import { runInit } from "./cli/commands/init.js";
import {
  runDaemonStart,
  runDaemonStatus,
  runDaemonStop,
} from "./cli/commands/daemon.js";
import { runSessionsKill, runSessionsList } from "./cli/commands/sessions.js";
import { runShim } from "./shim/proxy.js";
import type { SessionRole } from "./acp/types.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
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
  const sessionId = flagString(flags, "session-id");
  const roleFlag = flagString(flags, "role");
  const role: SessionRole | undefined =
    roleFlag === "controller" || roleFlag === "observer" ? roleFlag : undefined;

  if (!subcommand) {
    await runShim({ sessionId, role });
    return;
  }

  switch (subcommand) {
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
        await runSessionsList();
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
    case "launch": {
      const agentId = positional[1];
      if (!agentId) {
        process.stderr.write("Usage: acp-hydra launch <agent-id>\n");
        process.exit(2);
        return;
      }
      await runShim({ sessionId, role, agentId });
      return;
    }
    default:
      process.stderr.write(`Unknown command: ${subcommand}\n`);
      printHelp();
      process.exit(2);
  }
}

function printHelp(): void {
  process.stdout.write(
    [
      "acp-hydra — multi-client ACP session daemon",
      "",
      "Usage:",
      "  acp-hydra                          Run as ACP shim (default; spawned by editors)",
      "  acp-hydra launch <agent-id>        Shim mode, but force the daemon to spawn",
      "                                     <agent-id> from the registry on session/new",
      "  acp-hydra --session-id <id> [--role controller|observer]",
      "                                     Shim mode, attach to existing session",
      "  acp-hydra init [--rotate-token]    Initialize ~/.acp-hydra/config.json",
      "  acp-hydra daemon start|stop|status",
      "  acp-hydra sessions [list]          List active sessions",
      "  acp-hydra sessions kill <id>       Kill a session",
      "  acp-hydra --version                Print version",
      "  acp-hydra --help                   Show this help",
      "",
    ].join("\n"),
  );
}

main().catch((err) => {
  process.stderr.write(`acp-hydra: ${(err as Error).message}\n`);
  process.exit(1);
});
