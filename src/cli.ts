#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parseArgs, resolveOption } from "./cli/parse-args.js";
import {
  readSessionInput,
  resolveSessionFlag,
  type ResolvedSession,
} from "./cli/resolve-session.js";
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
  runSessionsShare,
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
import {
  runTransformersAdd,
  runTransformersList,
  runTransformersLogs,
  runTransformersRemove,
  runTransformersRestart,
  runTransformersStart,
  runTransformersStop,
} from "./cli/commands/transformers.js";
import {
  runAgentsInstall,
  runAgentsList,
  runAgentsRefresh,
  runAgentsSync,
} from "./cli/commands/agents.js";
import {
  runAuthList,
  runAuthPasswordSet,
  runAuthRevoke,
} from "./cli/commands/auth.js";
import { runShim } from "./shim/proxy.js";
import { runCat } from "./cli/commands/cat.js";
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
    if (flags.reattach === true) {
      process.stderr.write(
        "hydra-acp launch: --reattach is not valid here. Pass --session <id-or-url> to attach to a specific session.\n",
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
    // `launch` is a non-interactive editor-spawned path (it produces a
    // shim that talks JSON-RPC over stdio), so we never prompt for a
    // password — if --session is a hydra:// URL the resolver must
    // hit a cached credential or fail clearly.
    const resolved = await resolveSessionFlagOrExit(
      readSessionInput(flags),
      { allowPrompt: false },
    );
    const name = resolveOption(flags, "name");
    const model = resolveOption(flags, "model");
    suppressUpdateNotice = true;
    const shimOpts: Parameters<typeof runShim>[0] = {
      agentId,
      agentArgs,
      name,
      model,
    };
    if (resolved?.sessionId !== undefined) {
      shimOpts.sessionId = resolved.sessionId;
    }
    if (resolved?.target !== undefined && resolved.fromUrl) {
      shimOpts.target = resolved.target;
    }
    await runShim(shimOpts);
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
  const name = resolveOption(flags, "name");
  const agentIdFromFlag = resolveOption(flags, "agent");
  const model = resolveOption(flags, "model");
  // `--session <value>` (or HYDRA_ACP_SESSION env var) accepts either a
  // bare session id or a hydra:// URL pointing at any daemon. URL
  // resolution may hit a password prompt; that's gated below based on
  // whether the entry point can support interactive prompting. The
  // resolved RemoteTarget (when fromUrl) is threaded into TUI / shim /
  // cat so they talk to the right daemon.
  const sessionInput = readSessionInput(flags);
  const interactive =
    subcommand === "tui" || (subcommand === undefined && process.stdout.isTTY);
  const resolved = await resolveSessionFlagOrExit(sessionInput, {
    allowPrompt: interactive,
  });
  // --session <id> or <url-with-id> + --reattach is contradictory:
  // one names a specific session, the other says "pick whatever's
  // most recent for cwd." Reject up front rather than picking a
  // winner silently. --session <url-no-id> + --reattach is allowed
  // — the URL just picks the daemon, --reattach picks the session
  // on it.
  if (
    resolved !== undefined &&
    resolved.sessionId !== undefined &&
    flags.reattach === true
  ) {
    process.stderr.write(
      "hydra-acp: --session <id> and --reattach are mutually exclusive. Use one or the other.\n",
    );
    process.exit(2);
  }
  const sessionId = resolved?.sessionId;
  const sessionTarget = resolved?.fromUrl ? resolved.target : undefined;

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
        target: sessionTarget,
      });
      return;
    }
    suppressUpdateNotice = true;
    const shimOpts: Parameters<typeof runShim>[0] = {
      name,
      model,
      agentId: agentIdFromFlag,
    };
    if (sessionId !== undefined) {
      shimOpts.sessionId = sessionId;
    }
    if (sessionTarget !== undefined) {
      shimOpts.target = sessionTarget;
    }
    await runShim(shimOpts);
    return;
  }

  switch (subcommand) {
    case "shim": {
      suppressUpdateNotice = true;
      const shimOpts: Parameters<typeof runShim>[0] = {
        name,
        model,
        agentId: agentIdFromFlag,
      };
      if (sessionId !== undefined) {
        shimOpts.sessionId = sessionId;
      }
      if (sessionTarget !== undefined) {
        shimOpts.target = sessionTarget;
      }
      await runShim(shimOpts);
      return;
    }
    case "cat": {
      // Accept -p as a short alias for --prompt inside the cat verb so
      // the global parser doesn't have to grow short-flag support.
      const promptFromShort = readShortPrompt(argv);
      const longPrompt =
        typeof flags.prompt === "string" ? flags.prompt : undefined;
      const prompt = promptFromShort ?? longPrompt;
      const cwd = resolveOption(flags, "cwd");
      const catOpts: Parameters<typeof runCat>[0] = {
        prompt,
        sessionId,
        name,
        model,
        agentId: agentIdFromFlag,
        detach: flags.detach === true,
        stream: flags.stream === true,
      };
      if (cwd !== undefined) {
        catOpts.cwd = cwd;
      }
      if (sessionTarget !== undefined) {
        catOpts.target = sessionTarget;
      }
      const streamThreshold = parseNumericFlag(flags, "stream-threshold");
      if (streamThreshold !== undefined) {
        catOpts.streamThreshold = streamThreshold;
      }
      const streamBufferBytes = parseNumericFlag(flags, "stream-bytes");
      if (streamBufferBytes !== undefined) {
        catOpts.streamBufferBytes = streamBufferBytes;
      }
      const streamFileCap = parseNumericFlag(flags, "stream-file-cap");
      if (streamFileCap !== undefined) {
        catOpts.streamFileCapBytes = streamFileCap;
      }
      suppressUpdateNotice = true;
      await runCat(catOpts);
      return;
    }
    case "init":
      await runInit(flags);
      return;
    case "daemon": {
      const daemonIdx = argv.indexOf("daemon");
      const tail = argv.slice(daemonIdx + 1);
      const sub = tail[0];
      if (sub === undefined || sub === "status") {
        await runDaemonStatus();
        return;
      }
      if (sub === "start") {
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
      if (sub === "share") {
        const host = resolveOption(flags, "host");
        const cwd = resolveOption(flags, "cwd");
        await runSessionsShare(positional[2], {
          ...(host !== undefined ? { host } : {}),
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
      if (sub === "log" || sub === "logs") {
        await runExtensionsLogs(tail.slice(1));
        return;
      }
      process.stderr.write(`Unknown extension subcommand: ${sub}\n`);
      process.exit(2);
      return;
    }
    case "transformer":
    case "transformers": {
      const trIdx = argv.indexOf(subcommand);
      const tail = argv.slice(trIdx + 1);
      const sub = tail[0];
      const name = tail[1];
      const rest = tail.slice(2);
      if (sub === undefined || sub === "list") {
        await runTransformersList();
        return;
      }
      if (sub === "add") {
        await runTransformersAdd(name, rest);
        return;
      }
      if (sub === "remove") {
        await runTransformersRemove(name);
        return;
      }
      if (sub === "start") {
        await runTransformersStart(name);
        return;
      }
      if (sub === "stop") {
        await runTransformersStop(name);
        return;
      }
      if (sub === "restart") {
        await runTransformersRestart(name);
        return;
      }
      if (sub === "log" || sub === "logs") {
        await runTransformersLogs(tail.slice(1));
        return;
      }
      process.stderr.write(`Unknown transformer subcommand: ${sub}\n`);
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
      if (sub === "install") {
        await runAgentsInstall(positional[2]);
        return;
      }
      if (sub === "sync") {
        await runAgentsSync(positional[2]);
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
        target: sessionTarget,
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
  target?: ResolvedSession["target"] | undefined;
}

async function dispatchTui(
  flags: Record<string, string | boolean>,
  base: TuiBaseOpts,
): Promise<void> {
  const cwd = resolveOption(flags, "cwd");
  // --reattach picks the most-recent session for cwd. --new forces a
  // fresh session. --readonly opens an existing session as a
  // transcript viewer — requires a session id either via --session
  // or via the picker's `v` keystroke.
  const resume = flags.reattach === true;
  const forceNew = flags.new === true;
  const readonly = flags.readonly === true;
  if (readonly && base.sessionId === undefined) {
    process.stderr.write(
      "hydra-acp: --readonly requires a session id. Pass --session <id-or-url> --readonly, or open the picker and press `v` on a session.\n",
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
  if (base.target !== undefined) {
    tuiOpts.target = base.target;
  }
  await runTui(tuiOpts);
}

// Pull a `-p <text>` (or `-p<text>`) value out of argv. Returns the
// first occurrence's value, or undefined if -p wasn't passed. Walked
// once in main() for the `cat` verb so we don't have to grow the
// parser's short-flag surface (which today is long-only).
function parseNumericFlag(
  flags: Record<string, unknown>,
  name: string,
): number | undefined {
  const raw = flags[name];
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === "string") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function readShortPrompt(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok === undefined) {
      continue;
    }
    if (tok === "-p") {
      return argv[i + 1];
    }
    if (tok.startsWith("-p") && !tok.startsWith("--")) {
      return tok.slice(2);
    }
  }
  return undefined;
}

// Thin wrapper around resolveSessionFlag that prints the error message
// to stderr and exits 2 on parse / lookup failure, rather than letting
// the stack trace surface to the user. Returns the resolved value (or
// undefined when no --session was supplied) so the caller can branch
// on it directly. `allowPrompt` mirrors the inner option — pass true
// for the TUI path, false for shim / cat.
async function resolveSessionFlagOrExit(
  input: string | undefined,
  opts: { allowPrompt: boolean },
): Promise<ResolvedSession | undefined> {
  try {
    return await resolveSessionFlag(input, opts);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(1);
  }
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
      "  hydra-acp [--session <id-or-url>] [--reattach] [opts]",
      "                                     Auto: TUI when stdout is a TTY, shim otherwise (the editor-spawned case).",
      "  hydra-acp tui   [same flags]       Force TUI explicitly.",
      "  hydra-acp shim  [same flags]       Force shim explicitly (non-interactive; password prompts not allowed).",
      "  hydra-acp cat [-p <prompt>] [--session <id-or-url>] [--detach] [--agent <id>] [--model <id>] [--name <label>]",
      "                                     Pipe-friendly headless mode. Reads stdin and sends it",
      "                                     as a prompt to a fresh session, streams the agent's",
      "                                     response to stdout, exits when stdin closes. A bounded",
      "                                     input (e.g. `cat file.log | hydra cat -p \"...\"`) goes in",
      "                                     as one turn; a streaming input (e.g. `tail -f`) is",
      "                                     chunked by the natural pauses in the writer. -p is an",
      "                                     optional standing instruction prepended to every chunk;",
      "                                     if stdin already contains the question, -p is not needed.",
      "                                     With --session, attach to an existing session instead",
      "                                     of creating a new one. With --detach, the session",
      "                                     survives in the daemon for slack/browser/notifier",
      "                                     extensions.",
      "  hydra-acp launch <agent> [agent-args...]",
      "                                     Shim mode, force daemon to spawn <agent>",
      "                                     from the registry. Args after <agent>",
      "                                     are forwarded to the agent's command.",
      "",
      "Session selection (any entry point):",
      "  --session <id>                     Attach to a local session by id.",
      "  --session hydra://host[:port]/id   Attach to a session on another daemon (loopback uses the local service",
      "                                     token; remote hosts use the cached credential from ~/.hydra-acp/remotes.json,",
      "                                     falling back to a password prompt — but only on the TUI path).",
      "  --session hydra://host/            URL with no id: picker (TUI) or fresh session (shim/cat).",
      "  --reattach                         Pick the most-recent session for the current cwd.",
      "  --new                              Force a fresh session.",
      "  --readonly                         Open a session as a transcript viewer (requires --session).",
      "  HYDRA_ACP_SESSION                  Env var equivalent of --session (flag wins).",
      "  hydra-acp init [--rotate-token]    Initialize ~/.hydra-acp/config.json",
      "  hydra-acp daemon [status]          Show daemon pid/version (default when no subcommand)",
      "  hydra-acp daemon start [--foreground]   Start daemon (detached by default; --foreground to attach)",
      "  hydra-acp daemon stop|restart",
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
      "  hydra-acp session share [<id>] [--host <name>] [--cwd <path>]",
      "                                     Print a hydra:// URL the recipient can paste into `--session`. With no id, picks the most-recent session for cwd. Host precedence: --host > config.daemon.publicHost > config.daemon.host > 127.0.0.1 (with a stderr warning that the URL is loopback-only).",
      "  hydra-acp extension list                    List configured extensions and live state",
      "  hydra-acp extension add <name> [opts]       Add an extension to config",
      "  hydra-acp extension remove <name>           Remove an extension from config",
      "  hydra-acp extension start|stop|restart <n>|all   Lifecycle on one or all",
      "  hydra-acp extension log <name> [-f] [-n N]       Tail or follow an extension's log",
      "  hydra-acp transformer list                  List configured transformers and live state",
      "  hydra-acp transformer add <name> [opts]     Add a transformer to config (--command, --args, --env, --disabled)",
      "  hydra-acp transformer remove <name>         Remove a transformer from config",
      "  hydra-acp transformer start|stop|restart <n>|all  Lifecycle on one or all",
      "  hydra-acp transformer log <name> [-f] [-n N]      Tail or follow a transformer's log",
      "  hydra-acp agent [list]                      List agents in the cached registry",
      "  hydra-acp agent refresh                     Force a registry re-fetch",
      "  hydra-acp agent install <id>                Pre-install <id> from the registry (else lazy on first session)",
      "  hydra-acp agent sync <id>                   Spawn <id> just long enough to ACP session/list it, then persist any sessions it remembers (across every cwd) as cold rows in `session list`",
      "  hydra-acp auth password [--force]           Set the daemon's master password",
      "  hydra-acp auth [list]                       List active session tokens",
      "  hydra-acp auth revoke <id>                  Revoke a session token",
      "  hydra-acp tui flags: [--session <id-or-url>] [--reattach] [--new] [--readonly] [--agent <id>] [--model <id>] [--cwd <path>] [--name <label>]",
      "                                     Smart default (no flags): shows a picker when sessions exist, else new.",
      "  hydra-acp --version                Print version",
      "  hydra-acp --help                   Show this help",
      "",
      "Config knob flags accept env-var equivalents (flag wins):",
      "  --agent                 HYDRA_ACP_AGENT",
      "  --model                 HYDRA_ACP_MODEL    (one-shot at session/new; ignored on --session resume)",
      "  --session               HYDRA_ACP_SESSION  (session id or hydra:// URL)",
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
