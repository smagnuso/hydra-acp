import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import { z } from "zod";
import { paths } from "./paths.js";

const REGISTRY_URL_DEFAULT =
  "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

const TlsConfig = z.object({
  cert: z.string(),
  key: z.string(),
});

const DaemonConfig = z.object({
  host: z.string().default("127.0.0.1"),
  port: z.number().int().positive().default(8765),
  authToken: z.string().min(16),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  tls: TlsConfig.optional(),
  sessionIdleTimeoutSeconds: z.number().int().nonnegative().default(30),
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

export const HydraConfig = z.object({
  daemon: DaemonConfig,
  registry: RegistryConfig.default({ url: REGISTRY_URL_DEFAULT, ttlHours: 24 }),
  defaultAgent: z.string().default("claude-acp"),
  // Where new sessions land when POST /v1/sessions omits cwd. Stored as
  // a literal string ("~", "~/dev", "$HOME/work") so the config file is
  // portable across machines; expanded via expandHome at use time.
  defaultCwd: z.string().default("~"),
  // Cap on cold sessions shown in CLI `sessions` listing and the TUI
  // picker. Live sessions are always included; cold are sorted by
  // recency and truncated to this count. `--all` overrides in the CLI.
  sessionListColdLimit: z.number().int().nonnegative().default(20),
  extensions: z.record(ExtensionName, ExtensionBody).default({}),
  tui: TuiConfig.default({ repaintThrottleMs: 1000, maxScrollbackLines: 10_000 }),
});

export type HydraConfig = z.infer<typeof HydraConfig>;

export function extensionList(config: HydraConfig): ExtensionConfig[] {
  return Object.entries(config.extensions).map(([name, body]) => ({
    name,
    ...body,
  }));
}

export async function loadConfig(): Promise<HydraConfig> {
  const configPath = paths.config();
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      throw new Error(
        `No config found at ${configPath}. Run \`hydra-acp init\` to create one.`,
      );
    }
    throw err;
  }
  const parsed = JSON.parse(raw);
  return HydraConfig.parse(parsed);
}

// Like loadConfig, but writes a default if the file is missing. Used by
// entry points that imply "actually running hydra" (daemon start, shim,
// TUI) so a first-run user doesn't need to call `hydra-acp init` first —
// matters especially for the registry-distribution case, where editors
// just spawn `hydra-acp shim` and expect it to work.
export async function ensureConfig(): Promise<HydraConfig> {
  try {
    await fs.access(paths.config());
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== "ENOENT") {
      throw err;
    }
    const config = defaultConfig();
    await writeConfig(config);
    process.stderr.write(
      `hydra-acp: initialized ${paths.config()} with a fresh auth token.\n`,
    );
    return config;
  }
  return loadConfig();
}

export async function writeConfig(config: HydraConfig): Promise<void> {
  await fs.mkdir(paths.home(), { recursive: true });
  await fs.writeFile(paths.config(), JSON.stringify(config, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function generateAuthToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, "0");
  }
  return `hydra_token_${hex}`;
}

export function defaultConfig(): HydraConfig {
  return HydraConfig.parse({
    daemon: {
      authToken: generateAuthToken(),
    },
  });
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
