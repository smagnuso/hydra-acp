// A raw NUL byte in a source file is legal inside a JS string literal and
// invisible in an editor, but it makes `grep` classify the whole file as
// binary and skip it. Silently losing session.ts from a repo-wide grep is
// the kind of thing you lose an afternoon to before noticing.
//
// Written after doing exactly that twice in one sitting. Both times the
// intent was the six-character escape sequence backslash-u-0-0-0-0 as a
// versionKey separator, which is the right separator there because labels
// can contain spaces. Both times a literal byte landed instead. The escape
// and the raw byte behave identically at runtime, so nothing else catches
// it: not tsc, not the linter, not the tests that exercise the code.
//
// Scoped to NUL alone. Other C0 bytes (ESC, 0x01) appear on purpose in the
// terminal-rendering fixtures under tui/, where they are the subject under
// test rather than a typo.
import { describe, it, expect } from "vitest";
import { readFileSync, globSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("source hygiene", () => {
  it("has no raw NUL bytes in any TypeScript source", () => {
    const offenders: string[] = [];
    for (const rel of globSync("**/*.ts", { cwd: SRC })) {
      const buf = readFileSync(join(SRC, rel));
      const at = buf.indexOf(0);
      if (at !== -1) {
        const line = buf.subarray(0, at).toString("utf8").split("\n").length;
        offenders.push(`${rel}:${line}`);
      }
    }
    expect(offenders, "write the \\u0000 escape, not the byte").toEqual([]);
  });
});
