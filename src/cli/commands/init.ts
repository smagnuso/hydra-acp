import * as fs from "node:fs/promises";
import { paths } from "../../core/paths.js";
import {
  generateAuthToken,
  loadAuthToken,
  writeAuthToken,
} from "../../core/config.js";
import { flagBool } from "../parse-args.js";

export async function runInit(flags: Record<string, string | boolean>): Promise<void> {
  await fs.mkdir(paths.home(), { recursive: true });
  const existingToken = await loadAuthToken();

  if (!existingToken) {
    const token = generateAuthToken();
    await writeAuthToken(token);
    process.stdout.write(
      `Initialized ${paths.authToken()}\nAuth token: ${token}\n`,
    );
    return;
  }

  if (flagBool(flags, "rotate-token")) {
    const newToken = generateAuthToken();
    await writeAuthToken(newToken);
    process.stdout.write(
      `Rotated token in ${paths.authToken()}\nNew token: ${newToken}\n`,
    );
    return;
  }

  process.stdout.write(`Auth token already exists at ${paths.authToken()}.\n`);
  process.stdout.write("Pass --rotate-token to generate a new auth token.\n");
}
