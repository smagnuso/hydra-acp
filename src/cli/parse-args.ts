export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

// Flags known to never carry a value. Listing them lets the parser
// treat `--info file.hydra` and `file.hydra --info` the same way; without
// this set, the next non-`--` token would be eaten as the flag's value.
// Value-taking flags (--session, --agent, --model, --host, ...) are
// omitted so the parser slurps the next token as their value.
const KNOWN_BOOLEAN_FLAGS = new Set([
  "all",
  "dangerously-skip-permissions",
  "detach",
  "diff",
  "disabled",
  "drip",
  "fold",
  "follow",
  "force",
  "foreground",
  "help",
  "include-cat",
  "info",
  "json",
  "new",
  "no-color",
  "no-pager",
  "tools",
  "raw",
  "reattach",
  "readonly",
  "replace",
  "rotate-token",
  "verbose",
  "version",
]);

// Flags that take a value. Together with KNOWN_BOOLEAN_FLAGS this is the
// full set of `--name` tokens the top-level CLI accepts. Includes flags
// consumed by downstream parsers (extension/transformer add, log tail) —
// the top-level parseArgs still sees them in its flags map and we don't
// want validateKnownFlags to reject them.
const KNOWN_VALUE_FLAGS = new Set([
  "agent",
  "args",
  "columns",
  "command",
  "cwd",
  "drip-speed",
  "env",
  "host",
  "model",
  "name",
  "out",
  "prompt",
  "session",
  "stream-bytes",
  "stream-threshold",
  "tail",
]);

export function validateKnownFlags(
  flags: Record<string, string | boolean>,
): string | undefined {
  for (const key of Object.keys(flags)) {
    if (!KNOWN_BOOLEAN_FLAGS.has(key) && !KNOWN_VALUE_FLAGS.has(key)) {
      return key;
    }
  }
  return undefined;
}

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
