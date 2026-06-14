// `hydra-acp config` — read/write config.json keys from the CLI.
//
// Keys are dotted paths into the parsed `HydraConfig` shape (e.g.
// `tui.openFileCommand`, `defaultAgent`, `tui.selectionClipboard`).
// Reads come from the fully-defaulted parse so users see effective
// values even for keys their config.json doesn't mention; writes go
// through updateRawConfig so the on-disk file stays minimal and
// validated against the schema before each save.

import { HydraConfig, loadConfig, updateRawConfig } from "../../core/config.js";
import { paths } from "../../core/paths.js";

function splitKey(key: string): string[] {
  const parts = key.split(".").filter((p) => p.length > 0);
  if (parts.length === 0) {
    throw new Error("config key must be a non-empty dotted path");
  }
  return parts;
}

function getDeep(obj: unknown, parts: readonly string[]): unknown {
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || typeof cur !== "object" || Array.isArray(cur)) {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

// Parse a CLI-supplied value: try strict JSON first so arrays/objects/
// booleans/numbers/null come through with their real types; fall back
// to the literal string when JSON.parse rejects (the common case for
// `hydra config set tui.openFileCommand 'code --goto %f:%n'`).
function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function formatValue(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value, null, 2);
}

export async function runConfigGet(key: string | undefined): Promise<void> {
  if (!key) {
    process.stderr.write("usage: hydra-acp config get <dotted.key>\n");
    process.exit(2);
  }
  const parts = splitKey(key);
  const cfg = await loadConfig();
  const value = getDeep(cfg, parts);
  if (value === undefined) {
    process.stderr.write(`config: key '${key}' is unset\n`);
    process.exit(1);
  }
  process.stdout.write(`${formatValue(value)}\n`);
}

export async function runConfigSet(
  key: string | undefined,
  rawValue: string | undefined,
): Promise<void> {
  if (!key || rawValue === undefined) {
    process.stderr.write("usage: hydra-acp config set <dotted.key> <value>\n");
    process.exit(2);
  }
  const parts = splitKey(key);
  const value = parseValue(rawValue);
  try {
    await updateRawConfig((raw) => {
      let cursor: Record<string, unknown> = raw;
      for (let i = 0; i < parts.length - 1; i++) {
        const seg = parts[i]!;
        const next = cursor[seg];
        if (next === undefined || next === null) {
          const fresh: Record<string, unknown> = {};
          cursor[seg] = fresh;
          cursor = fresh;
          continue;
        }
        if (typeof next !== "object" || Array.isArray(next)) {
          throw new Error(
            `config: cannot descend into '${parts.slice(0, i + 1).join(".")}' (not an object)`,
          );
        }
        cursor = next as Record<string, unknown>;
      }
      cursor[parts[parts.length - 1]!] = value;
    });
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(1);
  }
  process.stdout.write(`set ${key} = ${formatValue(value)}\n`);
}

export async function runConfigUnset(key: string | undefined): Promise<void> {
  if (!key) {
    process.stderr.write("usage: hydra-acp config unset <dotted.key>\n");
    process.exit(2);
  }
  const parts = splitKey(key);
  try {
    await updateRawConfig((raw) => {
      let cursor: Record<string, unknown> = raw;
      for (let i = 0; i < parts.length - 1; i++) {
        const seg = parts[i]!;
        const next = cursor[seg];
        if (
          next === undefined ||
          next === null ||
          typeof next !== "object" ||
          Array.isArray(next)
        ) {
          return;
        }
        cursor = next as Record<string, unknown>;
      }
      delete cursor[parts[parts.length - 1]!];
    });
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(1);
  }
  process.stdout.write(`unset ${key}\n`);
}

export async function runConfigList(key: string | undefined): Promise<void> {
  const cfg = await loadConfig();
  const value = key ? getDeep(cfg, splitKey(key)) : cfg;
  if (value === undefined) {
    process.stderr.write(`config: key '${key}' is unset\n`);
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function runConfigPath(): void {
  process.stdout.write(`${paths.config()}\n`);
}

// Re-exported so the help text / tests can import the schema's top-level
// keys without reaching into core/config.ts directly.
export { HydraConfig };
