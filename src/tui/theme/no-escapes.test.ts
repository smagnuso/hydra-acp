// Guard: no colour decision outside src/tui/theme/.
//
// This exists because "I grepped and it's clean" was wrong twice — first the
// sidebar's gadgets, then `hydra daemon status` and `cat`'s renderer, which
// both restated colours the theme already owned. A test is cheaper than
// remembering to look.
//
// It scans source rather than behaviour, which is unusual, but the thing being
// protected is an architectural invariant: exactly one file decides what a
// token looks like. Anything else emitting an SGR sequence, or reaching for a
// terminal-kit colour method, is by definition a colour the theme cannot
// change.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = new URL("../../", import.meta.url).pathname;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
      continue;
    }
    if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) {
      continue;
    }
    out.push(full);
  }
  return out;
}

/**
 * Files allowed to name a colour, each for a stated reason.
 *
 * `definitional` marks the theme itself, which is exempt from the
 * still-needed check below — it assembles its sequences from a CSI constant
 * rather than literal escapes, and it is the point of the exercise.
 */
const ALLOWED: Array<{ path: string; why: string; definitional?: boolean }> = [
  {
    path: "tui/theme/index.ts",
    why: "the theme itself — the one place a token becomes bytes",
    definitional: true,
  },
];

// An SGR sequence: CSI ... m. Matched as it appears in SOURCE, where the
// escape is written `\x1b` (four characters) rather than as a 0x1B byte — an
// earlier version of this only looked for the byte and so matched nothing at
// all, passing vacuously. A real 0x1B is accepted too, in case one is ever
// pasted in literally.
//
// Deliberately not any escape: OSC 52 clipboard, OSC 9;4 taskbar progress,
// DCS/APC tmux passthrough and key-input sequences are not colour and are none
// of the theme's business.
const SGR = /(?:\\x1[bB]|\\u001[bB]|\\033|\\e|\x1b)\[[0-9;]*m/;

// terminal-kit's styling surface. `styleReset` is excluded: it clears style
// rather than choosing one, and is used defensively at row ends.
const TK_STYLE =
  /\bterm\w*\s*(?:\.\w+)*\.(?:bold|dim|italic|underline|blink|inverse|hidden|strike|black|red|green|yellow|blue|magenta|cyan|white|gray|grey|bright[A-Z]\w*|bg[A-Z]\w*|color|bgColor|colorRgb|bgColorRgb|colorRgbHex|bgColorRgbHex|colorGrayscale|bgColorGrayscale|defaultColor|bgDefaultColor)\b/;

const CHALK = /\bchalk\b/;

describe("colour lives only in the theme", () => {
  const files = sourceFiles(SRC).map((full) => ({
    rel: full.slice(SRC.length),
    text: readFileSync(full, "utf8"),
  }));

  it("scanned a plausible number of files", () => {
    // Cheap canary: a broken path would make every assertion below vacuous.
    expect(files.length).toBeGreaterThan(80);
  });

  // Comments legitimately discuss colour ("closes with \x1b[39m", "renders
  // brightYellow"), so strip them before scanning. Crude but adequate: the
  // patterns are code shapes, not prose.
  const code = (text: string): string =>
    text
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");

  for (const pattern of [
    { name: "SGR escape sequences", re: SGR },
    { name: "terminal-kit colour methods", re: TK_STYLE },
    { name: "chalk", re: CHALK },
  ]) {
    it(`no ${pattern.name} outside the theme`, () => {
      const offenders = files
        .filter((f) => !ALLOWED.some((a) => f.rel === a.path))
        .filter((f) => pattern.re.test(code(f.text)))
        .map((f) => {
          const line = code(f.text)
            .split("\n")
            .find((l) => pattern.re.test(l));
          return `${f.rel}: ${line?.trim()}`;
        });
      expect(offenders).toEqual([]);
    });
  }

  it("every token is expressed through a role, not a raw colour", () => {
    // The point of the role tier: a token says what it MEANS (`roles.error`),
    // never what colour that is. A token reaching straight for the palette
    // would be invisible to a theme that sets roles.
    //
    // This counts the entries it found and compares against the size of the
    // token unions. An earlier version keyed on `layers: [` preceded by an
    // optional `grayBg:`; when that field was renamed to `band:`, three tokens
    // silently dropped out of the check and a loose ">= 75" assertion hid it.
    // Matching the count is what makes the guard notice its own blind spots.
    const theme = files.find((f) => f.rel === "tui/theme/index.ts")!.text;

    const unionSize = (name: string): number => {
      const start = theme.indexOf(`export type ${name} =`);
      expect(start, name).toBeGreaterThan(-1);
      const end = theme.indexOf(";", theme.indexOf('"', start));
      return (theme.slice(start, end).match(/\| "/g) ?? []).length;
    };
    // Style lives in format.ts; the other two here.
    const styleText = files.find((f) => f.rel === "tui/format.ts")!.text;
    const styleStart = styleText.indexOf("export type Style =");
    const styleCount = (
      styleText
        .slice(styleStart, styleText.indexOf(";", styleStart))
        .match(/\| "/g) ?? []
    ).length;
    const expected =
      styleCount + unionSize("ChromeToken") + unionSize("SyntaxToken");

    // Every line in the table that opens a token entry, however its fields are
    // ordered.
    const entries = theme
      .split("\n")
      .filter((l) => /^  "?[a-z][a-z0-9_-]*"?: \{ /.test(l))
      .filter((l) => l.includes("layers:") || l.includes("band:"));

    expect(entries.length, "guard is not seeing every token").toBe(expected);

    const offenders = entries.filter((l) => !l.includes("roles."));
    expect(offenders).toEqual([]);
  });

  it("no chrome file writes visible text without a token", () => {
    // Four rounds of "some text is still green" were all the same thing: text
    // reaching the terminal without going through the theme, so it inherited
    // whatever foreground the terminal had. Three of those rounds I fixed only
    // the instance that was pointed at. This finds them mechanically.
    //
    // A bare write is fine for whitespace — padding and newlines carry no
    // colour — so those are allowed. Anything else has to go through paint() or
    // writeStyled().
    const CHROME = [
      "tui/screen.ts",
      "tui/picker.ts",
      "tui/prompt-utils.ts",
      "tui/agent-prompt.ts",
      "tui/import-cwd-prompt.ts",
      "tui/import-action-prompt.ts",
      "tui/auth-required-banner.ts",
      "tui/startup-failure-banner.ts",
      "tui/install-status.ts",
    ];
    // `term(...)` or `term.noFormat(...)` whose argument is not obviously just
    // whitespace: a quoted run of spaces, a newline, or a .repeat(...) of one.
    const WHITESPACE_ARG =
      /^(?:"(?:\s|\\n)*"|`(?:\s|\\n)*`|" "\.repeat\(|`\s`\.repeat\(|"\\n(?:\\n)?")/;
    const offenders: string[] = [];
    for (const rel of CHROME) {
      const f = files.find((x) => x.rel === rel);
      expect(f, rel).toBeDefined();
      for (const line of code(f!.text).split("\n")) {
        const m = /(?:this\.)?term(?:\.noFormat)?\((.+)\);\s*$/.exec(line);
        if (m === null) {
          continue;
        }
        const arg = m[1]!;
        // Skip the theme's own writer and terminal-control calls.
        if (/^(?:body|s|text)$/.test(arg) || WHITESPACE_ARG.test(arg)) {
          continue;
        }
        offenders.push(`${rel}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every allowance is still needed", () => {
    // Stops the list rotting into a permanent exemption after the underlying
    // reason is gone.
    for (const { path, why, definitional } of ALLOWED) {
      const f = files.find((x) => x.rel === path);
      expect(f, `${path} no longer exists; drop this allowance`).toBeDefined();
      if (definitional) {
        continue;
      }
      const hasColour =
        SGR.test(code(f!.text)) ||
        TK_STYLE.test(code(f!.text)) ||
        CHALK.test(code(f!.text));
      expect(hasColour, `${path} is now clean — drop it (${why})`).toBe(true);
    }
  });
});
