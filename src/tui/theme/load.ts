// Turn a `tui.theme` config value into a palette, or into an explanation of why
// it could not be one.
//
// Errors are returned rather than thrown, and never swallowed. A theme is
// hand-edited JSON, so a typo is the expected failure — and the worst outcome is
// silently rendering the default while the user stares at a file that looks
// right. The caller surfaces `problems` on the `notice-error` token.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { builtinNames, builtinTheme } from "./builtins.js";
import { parseColor, type Color } from "./color.js";
import { DEFAULT_PALETTE, type Palette, type PaletteSlot } from "./index.js";

const SLOTS: PaletteSlot[] = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
];

const EXTRAS = ["bg", "fg"] as const;

export interface LoadedTheme {
  /** The palette to hand to setTheme. Always usable, even with problems. */
  palette: Palette;
  /** Resolved name, for display. */
  name: string;
  /**
   * Everything wrong with the theme, in the order found. Non-empty means the
   * result fell back somewhere; it is never a reason to refuse to render.
   */
  problems: string[];
}

interface ThemeSpec {
  extends?: unknown;
  palette?: unknown;
}

/**
 * Resolve a theme.
 *
 * `value` is whatever `tui.theme` held: a name, or an inline spec. `themesDir`
 * is searched before the built-ins, so a user file can shadow a shipped theme
 * of the same name.
 */
export async function loadTheme(
  value: unknown,
  themesDir: string,
): Promise<LoadedTheme> {
  const problems: string[] = [];
  const fallback = (): LoadedTheme => ({
    palette: DEFAULT_PALETTE,
    name: "terminal",
    problems,
  });

  if (value === undefined || value === null) {
    return { palette: DEFAULT_PALETTE, name: "terminal", problems };
  }

  if (typeof value === "string") {
    const resolved = await resolveByName(value, themesDir, problems, new Set());
    return resolved ?? fallback();
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    problems.push(
      `tui.theme must be a theme name or an object, got ${describe(value)}`,
    );
    return fallback();
  }

  const built = await buildFromSpec(
    value as ThemeSpec,
    "tui.theme",
    themesDir,
    problems,
    new Set(),
  );
  return { palette: built, name: "custom", problems };
}

function describe(value: unknown): string {
  if (Array.isArray(value)) {
    return "an array";
  }
  return typeof value;
}

async function resolveByName(
  name: string,
  themesDir: string,
  problems: string[],
  seen: Set<string>,
): Promise<LoadedTheme | null> {
  if (seen.has(name)) {
    // `extends` pointing back at itself, directly or round a cycle.
    problems.push(`theme "${name}": extends forms a cycle`);
    return null;
  }
  seen.add(name);

  // A user file wins, so a shipped theme can be replaced by name.
  const fromFile = await readThemeFile(name, themesDir, problems);
  if (fromFile !== null) {
    const palette = await buildFromSpec(
      fromFile,
      `theme "${name}"`,
      themesDir,
      problems,
      seen,
    );
    return { palette, name, problems };
  }

  const builtin = builtinTheme(name);
  if (builtin !== undefined) {
    return { palette: builtin.palette, name, problems };
  }

  problems.push(
    `unknown theme "${name}" — expected one of ${builtinNames().join(", ")}, ` +
      `or a file at ${join(themesDir, `${name}.json`)}`,
  );
  return null;
}

async function readThemeFile(
  name: string,
  themesDir: string,
  problems: string[],
): Promise<ThemeSpec | null> {
  // Refuse anything that could escape the themes directory. A theme name comes
  // from config, so this is not hostile input, but "../../etc/passwd" producing
  // a confusing parse error is worse than saying no.
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith(".")) {
    return null;
  }
  const path = join(themesDir, `${name}.json`);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      problems.push(`theme file ${path}: expected a JSON object`);
      return null;
    }
    return parsed as ThemeSpec;
  } catch (err) {
    problems.push(
      `theme file ${path}: ${(err as Error).message.split("\n")[0]}`,
    );
    return null;
  }
}

async function buildFromSpec(
  spec: ThemeSpec,
  where: string,
  themesDir: string,
  problems: string[],
  seen: Set<string>,
): Promise<Palette> {
  let base: Palette = DEFAULT_PALETTE;

  if (spec.extends !== undefined) {
    if (typeof spec.extends !== "string") {
      problems.push(`${where}: extends must be a theme name`);
    } else {
      const parent = await resolveByName(
        spec.extends,
        themesDir,
        problems,
        seen,
      );
      if (parent !== null) {
        base = parent.palette;
      }
    }
  }

  const out: Record<string, Color> = { ...base };

  if (spec.palette !== undefined) {
    if (
      typeof spec.palette !== "object" ||
      spec.palette === null ||
      Array.isArray(spec.palette)
    ) {
      problems.push(`${where}: palette must be an object`);
    } else {
      const known = new Set<string>([...SLOTS, ...EXTRAS]);
      for (const [key, raw] of Object.entries(
        spec.palette as Record<string, unknown>,
      )) {
        if (!known.has(key)) {
          // A silently-ignored typo is the worst outcome for a hand-edited
          // file, so unknown keys are reported rather than dropped.
          problems.push(
            `${where}: unknown palette slot "${key}" — expected one of ` +
              `${[...SLOTS, ...EXTRAS].join(", ")}`,
          );
          continue;
        }
        if (typeof raw !== "string") {
          problems.push(
            `${where}: palette.${key} must be a colour string, got ${describe(raw)}`,
          );
          continue;
        }
        const color = parseColor(raw);
        if (color === null) {
          problems.push(
            `${where}: palette.${key} is not a colour ("${raw}") — ` +
              `expected #rgb, #rrggbb, or rgb(r,g,b)`,
          );
          continue;
        }
        out[key] = color;
      }
    }
  }

  return out as Palette;
}
