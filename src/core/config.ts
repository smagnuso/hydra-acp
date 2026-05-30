import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import { z } from "zod";
import { paths } from "./paths.js";
import { writeServiceToken } from "./service-token.js";
import { readJsonSafe, writeJsonAtomic } from "./json-store.js";

const REGISTRY_URL_DEFAULT =
  "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

const TlsConfig = z.object({
  cert: z.string(),
  key: z.string(),
});

export const DEFAULT_DAEMON_PORT = 55514;

const DaemonConfig = z.object({
  host: z.string().default("127.0.0.1"),
  port: z.number().int().positive().default(DEFAULT_DAEMON_PORT),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  tls: TlsConfig.optional(),
  sessionIdleTimeoutSeconds: z.number().int().nonnegative().default(3600),
  // Cap on entries kept in a session's on-disk replay log (history.jsonl).
  // Compaction trims to this many on a periodic basis; reads also slice
  // to the tail at this length as a defensive measure against older
  // daemons that may have written unbounded files.
  sessionHistoryMaxEntries: z.number().int().positive().default(10_000),
  // Bytes of trailing agent stderr buffered per AgentInstance so the
  // daemon can include it in the diagnostic message when a spawn fails.
  // Bump if your agents emit large tracebacks you want surfaced.
  agentStderrTailBytes: z.number().int().positive().default(4096),
  // Externally-reachable hostname for this daemon, used when `hydra
  // session share` constructs a URL to advertise. Useful when the
  // daemon binds to loopback (the normal case) but is exposed via a
  // tunnel (ngrok) or VPN (Tailscale) under a different name. The
  // `--host` flag on `share` overrides this; omitting both falls
  // back to `daemon.host`, then to "127.0.0.1" with a stderr warning.
  publicHost: z.string().optional(),
  // How often (minutes) the daemon runs `agent sync` against every
  // installed (non-uvx) agent in the background, picking up sessions
  // created outside hydra so the picker can resurrect them. Spawns
  // are staggered across the window — N agents on a 60-minute interval
  // mean one agent spawn every 60/N minutes. Set 0 to disable entirely.
  agentSyncIntervalMinutes: z.number().nonnegative().default(60),
});

const RegistryConfig = z.object({
  url: z.string().url().default(REGISTRY_URL_DEFAULT),
  ttlHours: z.number().positive().default(24),
});

const TuiConfig = z.object({
  // Minimum interval (ms) between full-screen repaints driven by content
  // events (agent text chunks, tool/plan updates, elapsed-tick refreshes).
  // User-action repaints — scrolling, prompt-row changes, modal open/close,
  // /clear, ^L, resize — bypass this throttle. Default 1000 (1 Hz) keeps
  // CPU low during heavy streaming; bump to 250 for 4 Hz, 100 for ~10 Hz,
  // or 0 to disable throttling entirely.
  repaintThrottleMs: z.number().int().nonnegative().default(1000),
  // Cap on logical lines retained in the in-memory scrollback render
  // buffer. Oldest lines are dropped on overflow. The on-disk session
  // history is unaffected; this only bounds the TUI's local view buffer.
  maxScrollbackLines: z.number().int().positive().default(10_000),
  // When true, the TUI captures mouse events so the wheel can drive
  // scrollback. The cost: terminals route clicks to the app, so text
  // selection requires shift+drag to bypass mouse reporting. Default
  // false — wheel scrollback stops working, but plain click-drag
  // selects text via the terminal emulator. Set true to opt back in.
  mouse: z.boolean().default(false),
  // Size at which the TUI's session/update debug log (tui.log) rotates
  // to tui.log.0 and resets. Bounds on-disk use at ~2x this value.
  logMaxBytes: z.number().int().positive().default(5 * 1024 * 1024),
  // Width cap on the cwd column in the `sessions list` output and the
  // TUI picker. Set higher if you keep deeply-nested working directories
  // and want them visible; the elastic title column shrinks to make room.
  cwdColumnMaxWidth: z.number().int().positive().default(32),
  // When true (default), emit OSC 9;4 progress-bar control codes so the
  // host terminal can show an indeterminate busy indicator (taskbar pulse
  // on Windows Terminal, dock badge on KDE/Konsole, etc.) while a turn is
  // running. Set false if your terminal renders this obnoxiously or you
  // just don't want it.
  progressIndicator: z.boolean().default(true),
  // What the unmodified Enter key does in the prompt composer.
  //   "amend" (default) — Enter amends the in-flight turn; Shift+Enter
  //     enqueues. With no turn in flight either key just enqueues,
  //     since there's nothing to amend.
  //   "enqueue" — flips the two: Enter enqueues the prompt (sends
  //     immediately when idle, queues behind an in-flight turn);
  //     Shift+Enter amends the in-flight turn.
  defaultEnterAction: z.enum(["enqueue", "amend"]).default("amend"),
  // When true (default), agent_thought events render as dim italic
  // streaming lines beneath the live thinking block. Set false to
  // suppress them — the TUI hotkey ^T toggles this at runtime without
  // persisting back to config.
  showThoughts: z.boolean().default(true),
  // Cap on entries kept in the cross-session global prompt-history file
  // (~/.hydra-acp/prompt-history). This is the ^P / ^R recall list
  // shared across all sessions; it's append-only on disk, so long-lived
  // installs can grow past this — it's enforced at load time and per
  // append in memory.
  promptHistoryMaxEntries: z.number().int().positive().default(2_000),
  // Cap on tool rows shown inside the collapsed tools block. When more
  // tools have fired than the cap, only the most recent N are visible
  // and the header advertises "^O expand" so the user can see the rest.
  // 0 disables the cap entirely — every tool row stays visible.
  maxToolItems: z.number().int().nonnegative().default(5),
  // Cap on plan entries rendered before the formatter switches to a
  // sliding window around the active (in_progress / first pending)
  // entry. Counters in the header summarize what's done and what's
  // left when truncation kicks in. 0 disables the cap — every plan
  // entry is rendered.
  maxPlanItems: z.number().int().nonnegative().default(5),
  // How edit-style tool calls (Edit, Write, str_replace) render in
  // scrollback, *in addition to* the normal tool row inside the tools
  // block.
  //   "none" — nothing extra; the collapsed tool row is the only signal.
  //   "edit" (default) — a one-line scrollback mark naming the file
  //     that was touched, so the user can scroll back and see which
  //     files moved without expanding the tools block. Suppressed on
  //     tool-only turns (no agent prose) since the marks would only
  //     duplicate the still-visible tool rows.
  //   "diff" — same mark plus a syntax-highlighted unified diff body,
  //     Claude Code's Update(file) look.
  // The diff payload is extracted from the ACP wire (content[]
  // type:"diff" entries, falling back to rawInput shapes), so any agent
  // that emits one of those shapes gets the treatment.
  showFileUpdates: z.enum(["none", "edit", "diff"]).default("edit"),
  // Columns shown in the `sessions list` output and the TUI picker, in
  // the given order — so this controls both which columns appear and
  // their left-to-right order. Valid names: session, upstream, host,
  // state, agent, model, age, cwd, title, cost. Omit to use the built-in
  // default (session, state, agent, age, cwd, title, cost — UPSTREAM,
  // HOST, and MODEL hidden). The CLI's `--columns` flag overrides this
  // per-invocation. Duplicate or unknown names are rejected.
  sessionColumns: z
    .array(
      z.enum([
        "session",
        "upstream",
        "host",
        "state",
        "agent",
        "model",
        "age",
        "cwd",
        "title",
        "cost",
      ]),
    )
    .nonempty()
    .optional(),
});

const ExtensionName = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9._-]+$/, "extension name must be filename-safe");

const ExtensionBody = z.object({
  // Optional: if omitted, the spawn command defaults to [name], so a
  // package called `hydra-acp-slack` that exposes a `hydra-acp-slack` bin
  // can be enabled with just an empty body `{}`.
  command: z.array(z.string()).default([]),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
  enabled: z.boolean().default(true),
});

export type ExtensionBody = z.infer<typeof ExtensionBody>;
export type ExtensionConfig = ExtensionBody & { name: string };

const TransformerBody = z.object({
  command: z.array(z.string()).default([]),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
  enabled: z.boolean().default(true),
});

export type TransformerBody = z.infer<typeof TransformerBody>;
export type TransformerConfig = TransformerBody & { name: string };

export const HydraConfig = z.object({
  daemon: DaemonConfig.default({}),
  registry: RegistryConfig.default({ url: REGISTRY_URL_DEFAULT, ttlHours: 24 }),
  defaultAgent: z.string().default("opencode"),
  // Optional per-agent default model id. When a brand-new agent process
  // is spawned (session/new path), hydra issues session/set_model with
  // the matching entry so the user lands on their preferred model from
  // the first prompt. Not applied on resurrect — those sessions keep
  // whatever the user last selected. Keys are agent ids; values are the
  // raw model id strings the agent expects (claude-acp: "claude-opus-4-7",
  // opencode: "openai/gpt-5-codex" or "ncp-anthropic/claude-opus-4-7", …).
  defaultModels: z.record(z.string(), z.string()).default({}),
  // Optional override: the agent used to produce session synopses
  // (title + structured digest) at close / picker T / `/hydra title`.
  // When set, every background synopsis spawns an ephemeral copy of
  // this agent, independent of what the session was created with.
  // Useful when one agent is cheaper / more reliable at structured
  // JSON output than the dev agent. Unset → fall back to the
  // session's own agentId.
  synopsisAgent: z.string().optional(),
  // Optional override: model id passed to session/set_model on the
  // ephemeral synopsis agent. Unset → the agent uses its default.
  synopsisModel: z.string().optional(),
  // Background synopsis on session close is opt-in. The coordinator
  // spawns a fresh ephemeral agent per close, holds the full history
  // in memory for the duration, and can stack up under bursty idle
  // sweeps — defaulting off keeps the daemon's resident set predictable.
  // Explicit user paths (picker T, `/hydra title`) are unaffected by
  // this flag — they always schedule, since the user just asked.
  synopsisOnClose: z.boolean().default(false),
  // Where new sessions land when POST /v1/sessions omits cwd. Stored as
  // a literal string ("~", "~/dev", "$HOME/work") so the config file is
  // portable across machines; expanded via expandHome at use time.
  defaultCwd: z.string().default("~"),
  // Cap on cold sessions shown in CLI `sessions` listing and the TUI
  // picker. Live sessions are always included; cold are sorted by
  // recency and truncated to this count. `--all` overrides in the CLI.
  sessionListColdLimit: z.number().int().nonnegative().default(20),
  extensions: z.record(ExtensionName, ExtensionBody).default({}),
  transformers: z.record(ExtensionName, TransformerBody).default({}),
  defaultTransformers: z.array(z.string()).default([]),
  // npm registry URL used when installing npm-distributed agents into
  // ~/.hydra-acp/agents. Overrides the global ~/.npmrc registry so a
  // corporate .npmrc pointing at an internal registry doesn't break
  // public-package installs. Omit to let npm use its own defaults.
  npmRegistry: z.string().url().optional(),
  tui: TuiConfig.default({
    repaintThrottleMs: 1000,
    maxScrollbackLines: 10_000,
    mouse: false,
    logMaxBytes: 5 * 1024 * 1024,
    cwdColumnMaxWidth: 32,
    progressIndicator: true,
    defaultEnterAction: "amend",
    showThoughts: true,
    promptHistoryMaxEntries: 2_000,
    maxToolItems: 5,
    maxPlanItems: 5,
    showFileUpdates: "edit",
  }),
});

export type HydraConfig = z.infer<typeof HydraConfig>;

export function extensionList(config: HydraConfig): ExtensionConfig[] {
  return Object.entries(config.extensions).map(([name, body]) => ({
    name,
    ...body,
  }));
}

export function transformerList(config: HydraConfig): TransformerConfig[] {
  return Object.entries(config.transformers).map(([name, body]) => ({
    name,
    ...body,
  }));
}

// Read config.json from disk and return its parsed object, or `{}` if
// the file is missing, empty, or corrupted. Genuine IO errors
// (permission, etc.) still throw.
async function readConfigFile(): Promise<Record<string, unknown>> {
  const parsed = await readJsonSafe<Record<string, unknown>>(paths.config());
  return parsed ?? {};
}

// One-shot heal for installs predating the auth-token split: if
// config.json carries a legacy daemon.authToken, move it to the
// service-token file and strip it from config.json. Idempotent: if no
// legacy field is present, returns without writing. Throws if BOTH
// sources hold a token, since we can't pick a winner safely.
//
// Callers that subsequently load a service token (daemon start, CLI
// commands, init, shim, TUI) should invoke this first so the legacy
// state heals before service-token lookup runs.
export async function migrateLegacyAuthToken(): Promise<void> {
  const raw = await readConfigFile();
  const daemon = raw.daemon as Record<string, unknown> | undefined;
  const legacy =
    daemon && typeof daemon.authToken === "string"
      ? daemon.authToken
      : undefined;
  if (!legacy) {
    return;
  }

  let tokenFileExists = false;
  try {
    await fs.access(paths.authToken());
    tokenFileExists = true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== "ENOENT") {
      throw err;
    }
  }
  if (tokenFileExists) {
    throw new Error(
      `Auth token present in both ${paths.authToken()} and ${paths.config()} (daemon.authToken). ` +
        `Remove daemon.authToken from config.json to resolve.`,
    );
  }

  await writeServiceToken(legacy);
  delete daemon!.authToken;
  if (Object.keys(daemon!).length === 0) {
    delete raw.daemon;
  }
  await writeJsonAtomic(paths.config(), raw, { mode: 0o600 });
  process.stderr.write(
    `hydra-acp: migrated auth token from ${paths.config()} to ${paths.authToken()}.\n`,
  );
}

export async function loadConfig(): Promise<HydraConfig> {
  // Heal legacy layout before reading config.json so the parse sees the
  // post-migration shape rather than a stale snapshot.
  await migrateLegacyAuthToken();
  return HydraConfig.parse(await readConfigFile());
}

export async function writeConfig(config: HydraConfig): Promise<void> {
  await writeJsonAtomic(paths.config(), config, { mode: 0o600 });
}

export function defaultConfig(): HydraConfig {
  return HydraConfig.parse({});
}

// Expand a leading "~", "~/...", "$HOME", or "$HOME/..." to the current
// user's home directory. Other paths pass through unchanged. Used so
// defaultCwd in the config can be portable across linux ("/home/x")
// and mac ("/Users/x") machines.
export function expandHome(p: string): string {
  if (p === "~" || p === "$HOME") {
    return homedir();
  }
  if (p.startsWith("~/")) {
    return homedir() + p.slice(1);
  }
  if (p.startsWith("$HOME/")) {
    return homedir() + p.slice("$HOME".length);
  }
  return p;
}
