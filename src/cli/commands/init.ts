import * as fs from "node:fs/promises";
import { paths } from "../../core/paths.js";
import {
  HydraConfig,
  defaultConfig,
  generateAuthToken,
  loadConfig,
  writeConfig,
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
    const config = defaultConfig();
    await writeConfig(config);
    process.stdout.write(
      `Initialized ${paths.config()}\nAuth token: ${config.daemon.authToken}\n`,
    );
    return;
  }

  if (flagBool(flags, "rotate-token")) {
    existing.daemon.authToken = generateAuthToken();
    await writeConfig(existing);
    process.stdout.write(
      `Rotated token in ${paths.config()}\nNew token: ${existing.daemon.authToken}\n`,
    );
    return;
  }

  process.stdout.write(`Config already exists at ${paths.config()}.\n`);
  process.stdout.write("Pass --rotate-token to generate a new auth token.\n");
}
