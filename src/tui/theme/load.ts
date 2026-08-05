// Turn a `tui.theme` config value into a palette, or into an explanation of why
// it could not be one.
//
// Errors are returned rather than thrown, and never swallowed. A theme is
// hand-edited JSON, so a typo is the expected failure — and the worst outcome is
// silently rendering the default while the user stares at a file that looks
// right. The caller surfaces `problems` on the `notice-error` token.

import { readdir, readFile } from "node:fs/promises";
import { backgroundHint } from "./capability.js";
import { join } from "node:path";
import { builtinNames, builtinTheme } from "./builtins.js";
import { parseColor, rgb, type Color } from "./color.js";
import {
  DEFAULT_PALETTE,
  elementNames,
  elementTakesFg,
  roleNames,
  roleTakesFg,
  type ColorOverride,
  type Palette,
  type PaletteSlot,
} from "./index.js";

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

export interface ThemeOverrides {
  roles: Record<string, ColorOverride>;
  elements: Record<string, ColorOverride>;
}

export interface LoadedTheme {
  /** The palette to hand to setTheme. Always usable, even with problems. */
  palette: Palette;
  /** Role and element overrides, applied on top of the palette. */
  overrides: ThemeOverrides;
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
  roles?: unknown;
  elements?: unknown;
}

/**
 * Parse one override value: a bare colour string, or `{ fg, bg }`.
 *
 * `takesFg` decides what a bare string means. Most targets have a foreground so
 * it is `fg`; the cursor and band roles have only a background, where `bg` is
 * the only sensible reading.
 */
function parseOverride(
  raw: unknown,
  where: string,
  takesFg: boolean,
  problems: string[],
): ColorOverride | null {
  const one = (value: unknown, field: string): Color | null | undefined => {
    if (value === undefined) {
      return undefined;
    }
    if (typeof value !== "string") {
      problems.push(
        `${where}${field}: must be a colour string, got ${describe(value)}`,
      );
      return null;
    }
    const c = parseColor(value);
    if (c === null) {
      problems.push(
        `${where}${field}: is not a colour ("${value}") — expected #rgb, ` +
          `#rrggbb, or rgb(r,g,b)`,
      );
      return null;
    }
    return c;
  };

  if (typeof raw === "string") {
    const c = one(raw, "");
    if (c === null || c === undefined) {
      return null;
    }
    return takesFg ? { fg: c } : { bg: c };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    problems.push(
      `${where}: must be a colour string or { fg, bg }, got ${describe(raw)}`,
    );
    return null;
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (key !== "fg" && key !== "bg") {
      problems.push(`${where}: unknown key "${key}" — expected fg or bg`);
    }
  }
  const fg = one(obj.fg, ".fg");
  const bg = one(obj.bg, ".bg");
  if (fg === null || bg === null) {
    return null;
  }
  if (fg === undefined && bg === undefined) {
    problems.push(`${where}: needs at least one of fg or bg`);
    return null;
  }
  const out: ColorOverride = {};
  if (fg !== undefined) out.fg = fg;
  if (bg !== undefined) out.bg = bg;
  return out;
}

/** Parse a `roles` or `elements` block, rejecting unknown names. */
function parseOverrideBlock(
  raw: unknown,
  label: "roles" | "elements",
  where: string,
  known: string[],
  takesFg: (name: string) => boolean,
  problems: string[],
): Record<string, ColorOverride> {
  const out: Record<string, ColorOverride> = {};
  if (raw === undefined) {
    return out;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    problems.push(`${where}: ${label} must be an object`);
    return out;
  }
  const set = new Set(known);
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!set.has(name)) {
      // Listing 100+ element names would drown the message, so suggest near
      // misses and point at the full list instead.
      const near = known.filter(
        (k) => k.includes(name) || name.includes(k),
      );
      problems.push(
        `${where}: unknown ${label === "roles" ? "role" : "element"} ` +
          `"${name}"` +
          (near.length > 0 ? ` — did you mean ${near.slice(0, 4).join(", ")}?` : "") +
          ` (${known.length} available)`,
      );
      continue;
    }
    const parsed = parseOverride(
      value,
      `${where}: ${label}.${name}`,
      takesFg(name),
      problems,
    );
    if (parsed !== null) {
      out[name] = parsed;
    }
  }
  return out;
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
    overrides: { roles: {}, elements: {} },
    name: "terminal",
    problems,
  });

  if (value === undefined || value === null) {
    return fallback();
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
  return { ...built, name: "custom", problems };
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
    const built = await buildFromSpec(
      fromFile,
      `theme "${name}"`,
      themesDir,
      problems,
      seen,
    );
    return { ...built, name, problems };
  }

  const builtin = builtinTheme(name);
  if (builtin !== undefined) {
    return {
      palette: builtin.palette,
      overrides: { roles: { ...(builtin.roles ?? {}) }, elements: {} },
      name,
      problems,
    };
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
): Promise<{ palette: Palette; overrides: ThemeOverrides }> {
  let base: Palette = DEFAULT_PALETTE;
  // Overrides accumulate down the extends chain, so a child can add to what its
  // parent set rather than replacing the block.
  const overrides: ThemeOverrides = { roles: {}, elements: {} };

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
        Object.assign(overrides.roles, parent.overrides.roles);
        Object.assign(overrides.elements, parent.overrides.elements);
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

  Object.assign(
    overrides.roles,
    parseOverrideBlock(
      spec.roles,
      "roles",
      where,
      roleNames(),
      roleTakesFg,
      problems,
    ),
  );
  Object.assign(
    overrides.elements,
    parseOverrideBlock(
      spec.elements,
      "elements",
      where,
      elementNames(),
      elementTakesFg,
      problems,
    ),
  );

  return { palette: out as Palette, overrides };
}

/**
 * Every theme that can be selected: the built-ins, plus any file in
 * `themesDir`.
 *
 * Palettes are resolved up front so the picker can cycle without an await —
 * there are a handful, and a synchronous toggle is what makes it feel live.
 * A user file shadows a built-in of the same name, matching loadTheme.
 */
export async function listThemes(
  themesDir: string,
): Promise<Array<{ name: string; palette: Palette; overrides: ThemeOverrides }>> {
  const names: string[] = [...builtinNames()];
  try {
    for (const entry of await readdir(themesDir)) {
      if (!entry.endsWith(".json")) {
        continue;
      }
      const name = entry.slice(0, -".json".length);
      if (!names.includes(name)) {
        names.push(name);
      }
    }
  } catch {
    // No themes directory is the normal case.
  }
  const out: Array<{
    name: string;
    palette: Palette;
    overrides: ThemeOverrides;
  }> = [];
  for (const name of names) {
    // Problems are ignored here: a broken user theme should not remove every
    // other choice from the picker. Selecting it reports them through
    // loadTheme's normal path.
    const loaded = await loadTheme(name, themesDir);
    out.push({ name, palette: loaded.palette, overrides: loaded.overrides });
  }
  return out;
}

/**
 * Resolve `tui.themeBackground` into a band reference colour.
 *
 * Precedence, most to least authoritative:
 *   1. the config value — the user telling us directly
 *   2. an OSC 11 answer — the terminal telling us its actual background
 *   3. COLORFGBG — the terminal telling us dark-or-light, when it does
 *   4. undefined, meaning fall back to the theme's own `bg`
 *
 * The first three describe the terminal in front of you; a theme's `bg` only
 * describes what it was designed for. That is the whole distinction: a light
 * theme on a dark terminal needs dark bands, and only (1)-(3) know that.
 *
 * Config outranks the sensed value deliberately. Sensing is right almost always,
 * and `tui.themeBackground` exists for the almost — a terminal that answers with
 * the wrong colour, or a user who wants bands derived from something else.
 *
 * "dark" resolves to pure black and "light" to pure white, chosen so the derived
 * bands land on the same values the pre-theme code used — band(#000, 0.17) is 43,
 * which is exactly the legacy user-band level.
 */
export function resolveThemeBackground(
  value: unknown,
  problems: string[],
  env: NodeJS.ProcessEnv = process.env,
  sensed?: Color,
): Color | undefined {
  if (value !== undefined && value !== null) {
    if (typeof value !== "string") {
      problems.push(
        `tui.themeBackground must be "dark", "light", or a colour, got ${typeof value}`,
      );
    } else {
      const named = namedBackground(value.trim().toLowerCase());
      if (named !== undefined) {
        return named;
      }
      const parsed = parseColor(value);
      if (parsed !== null) {
        return parsed;
      }
      problems.push(
        `tui.themeBackground is not "dark", "light", or a colour ("${value}")`,
      );
    }
  }
  if (sensed !== undefined) {
    return sensed;
  }
  const hint = backgroundHint(env);
  return hint === undefined ? undefined : namedBackground(hint);
}

function namedBackground(name: string): Color | undefined {
  if (name === "dark") {
    return rgb(0, 0, 0);
  }
  if (name === "light") {
    return rgb(255, 255, 255);
  }
  return undefined;
}
