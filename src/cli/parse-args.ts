export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

// Flags known to never carry a value. Listing them lets the parser
// treat `--info file.hydra` and `file.hydra --info` the same way; without
// this set, the next non-`--` token would be eaten as the flag's value.
// --resume is intentionally omitted so the CLI can detect bare `--resume`
// (which is no longer supported) and emit a friendly error pointing the
// user at --reattach.
const KNOWN_BOOLEAN_FLAGS = new Set([
  "all",
  "foreground",
  "help",
  "info",
  "json",
  "new",
  "reattach",
  "readonly",
  "replace",
  "rotate-token",
  "version",
]);

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let i = 0;
  while (i < argv.length) {
    const token = argv[i];
    if (token === undefined) {
      break;
    }
    if (token.startsWith("--")) {
      const eqIdx = token.indexOf("=");
      if (eqIdx !== -1) {
        const key = token.slice(2, eqIdx);
        flags[key] = token.slice(eqIdx + 1);
        i += 1;
        continue;
      }
      const key = token.slice(2);
      if (KNOWN_BOOLEAN_FLAGS.has(key)) {
        flags[key] = true;
        i += 1;
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i += 2;
        continue;
      }
      flags[key] = true;
      i += 1;
      continue;
    }
    positional.push(token);
    i += 1;
  }
  return { positional, flags };
}

export function flagString(
  flags: Record<string, string | boolean>,
  key: string,
): string | undefined {
  const v = flags[key];
  if (typeof v === "string") {
    return v;
  }
  return undefined;
}

export function flagBool(
  flags: Record<string, string | boolean>,
  key: string,
): boolean {
  return flags[key] === true || flags[key] === "true";
}

const ENV_PREFIX = "HYDRA_ACP_";

export function envKeyForFlag(flagKey: string): string {
  return ENV_PREFIX + flagKey.toUpperCase().replace(/-/g, "_");
}

export function resolveOption(
  flags: Record<string, string | boolean>,
  key: string,
): string | undefined {
  const fromFlag = flagString(flags, key);
  if (fromFlag !== undefined) {
    return fromFlag;
  }
  return process.env[envKeyForFlag(key)];
}
