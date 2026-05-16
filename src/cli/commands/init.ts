import * as fs from "node:fs/promises";
import { paths } from "../../core/paths.js";
import { migrateLegacyAuthToken } from "../../core/config.js";
import {
  generateServiceToken,
  readServiceToken,
  writeServiceToken,
} from "../../core/service-token.js";
import { flagBool } from "../parse-args.js";

export async function runInit(flags: Record<string, string | boolean>): Promise<void> {
  await fs.mkdir(paths.home(), { recursive: true });
  // Heal legacy daemon.authToken-in-config.json layout first so a user
  // with only legacy state doesn't end up with both a fresh token file
  // and an orphan field in config.json (which loadConfig would error on).
  await migrateLegacyAuthToken();
  const existingToken = await readServiceToken();

  if (!existingToken) {
    const token = generateServiceToken();
    await writeServiceToken(token);
    process.stdout.write(
      `Initialized ${paths.authToken()}\nService token: ${token}\n`,
    );
    return;
  }

  if (flagBool(flags, "rotate-token")) {
    const newToken = generateServiceToken();
    await writeServiceToken(newToken);
    process.stdout.write(
      `Rotated token in ${paths.authToken()}\nNew token: ${newToken}\n`,
    );
    return;
  }

  process.stdout.write(`Service token already exists at ${paths.authToken()}.\n`);
  process.stdout.write("Pass --rotate-token to generate a new service token.\n");
}
