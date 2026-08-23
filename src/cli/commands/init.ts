import * as fs from "node:fs/promises";
import { paths } from "../../core/paths.js";
import { migrateLegacyAuthToken } from "../../core/config.js";
import {
  generateServiceToken,
  readServiceToken,
  writeServiceToken,
} from "../../core/service-token.js";
import { flagBool } from "../parse-args.js";
import { daemonFetch } from "./_shared.js";

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
    // Call the daemon (authenticated with the OLD token still on disk)
    // before overwriting anything, so a running daemon's live validator
    // gets the new token instead of silently keeping the old one until a
    // restart. daemonFetch reads the service token off disk itself, so
    // ordering here matters: the file must still hold the old value.
    try {
      const res = await daemonFetch("/v1/auth/rotate-token", {
        method: "POST",
        body: { token: newToken },
        rethrowNetworkError: true,
      });
      if (!res.ok) {
        process.stderr.write(
          `Daemon rejected the token rotation (HTTP ${res.status}). Not writing the new token to ` +
            `disk — that would leave it out of sync with what the running daemon still accepts.\n`,
        );
        process.exit(1);
      }
      await writeServiceToken(newToken);
      process.stdout.write(
        `Rotated token in ${paths.authToken()}\nNew token: ${newToken}\nThe running daemon has already adopted it.\n`,
      );
    } catch (err) {
      // Daemon unreachable: nothing live to diverge from, so it's safe
      // to just write the new token — it'll be what the daemon reads on
      // its next start.
      await writeServiceToken(newToken);
      process.stdout.write(
        `Rotated token in ${paths.authToken()}\nNew token: ${newToken}\n` +
          `Couldn't reach the daemon (${(err as Error).message}) — it'll pick up the new token next time it starts.\n`,
      );
    }
    return;
  }

  process.stdout.write(`Service token already exists at ${paths.authToken()}.\n`);
  process.stdout.write("Pass --rotate-token to generate a new service token.\n");
}
