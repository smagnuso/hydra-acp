import * as fs from "node:fs/promises";
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
  sessionRecentMinutes: z.number().int().nonnegative().default(30),
});

const RegistryConfig = z.object({
  url: z.string().url().default(REGISTRY_URL_DEFAULT),
  ttlHours: z.number().positive().default(24),
});

const ExtensionConfig = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9._-]+$/, "extension name must be filename-safe"),
  // Optional: if omitted, the spawn command defaults to [name], so a
  // package called `acp-hydra-slack` that exposes a `acp-hydra-slack` bin
  // can be enabled with just `{ name: "acp-hydra-slack" }`.
  command: z.array(z.string()).default([]),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
  enabled: z.boolean().default(true),
});
export type ExtensionConfig = z.infer<typeof ExtensionConfig>;

export const HydraConfig = z.object({
  daemon: DaemonConfig,
  registry: RegistryConfig.default({ url: REGISTRY_URL_DEFAULT, ttlHours: 24 }),
  defaultAgent: z.string().default("claude-code"),
  extensions: z.array(ExtensionConfig).default([]),
});

export type HydraConfig = z.infer<typeof HydraConfig>;

export async function loadConfig(): Promise<HydraConfig> {
  const configPath = paths.config();
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      throw new Error(
        `No config found at ${configPath}. Run \`acp-hydra init\` to create one.`,
      );
    }
    throw err;
  }
  const parsed = JSON.parse(raw);
  return HydraConfig.parse(parsed);
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
