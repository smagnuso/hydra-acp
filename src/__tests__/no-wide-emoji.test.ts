import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Emoji-presentation characters are two cells wide, ignore the theme and
// NO_COLOR, and render as boxes or mismatched widths in the classic Windows
// console, so the UI's own text uses single-cell glyphs instead. Agent and
// user text is not affected: this only checks hydra's source.
const WIDE = /\p{Emoji_Presentation}/u;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("source text", () => {
  it("contains no wide emoji", () => {
    const hits: string[] = [];
    for (const file of sourceFiles(join(__dirname, ".."))) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (WIDE.test(line)) {
            hits.push(`${file}:${i + 1}: ${line.trim().slice(0, 80)}`);
          }
        });
    }
    expect(hits).toEqual([]);
  });
});
