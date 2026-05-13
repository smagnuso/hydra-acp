import * as fs from "node:fs/promises";
import { paths } from "../../core/paths.js";
import {
  HydraConfig,
  generateAuthToken,
  loadConfig,
  updateConfigField,
  writeMinimalInitConfig,
} from "../../core/config.js";
import { flagBool } from "../parse-args.js";

export async function runInit(flags: Record<string, string | boolean>): Promise<void> {
  await fs.mkdir(paths.home(), { recursive: true });
  let existing: HydraConfig | undefined;
  try {
    existing = await loadConfig();
  } catch {
    existing = undefined;
  }

  if (!existing) {
    const config = await writeMinimalInitConfig();
    process.stdout.write(
      `Initialized ${paths.config()}\nAuth token: ${config.daemon.authToken}\n`,
    );
    return;
  }

  if (flagBool(flags, "rotate-token")) {
    const newToken = generateAuthToken();
    await updateConfigField((raw) => {
      const daemon = (raw.daemon ??= {}) as Record<string, unknown>;
      daemon.authToken = newToken;
    });
    process.stdout.write(
      `Rotated token in ${paths.config()}\nNew token: ${newToken}\n`,
    );
    return;
  }

  process.stdout.write(`Config already exists at ${paths.config()}.\n`);
  process.stdout.write("Pass --rotate-token to generate a new auth token.\n");
}
