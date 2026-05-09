export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
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
