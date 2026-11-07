// Split a command string such as $EDITOR into argv.
//
// Whitespace separates tokens, except inside single or double quotes, which
// group and are removed. A backslash is a literal character, never an escape:
// on Windows it is the path separator, and `"C:\Program Files\Microsoft VS
// Code\bin\code.cmd" --wait` is the normal way to set an editor there.
// Splitting on bare whitespace tore that path apart at "Program Files".
//
// An unterminated quote takes the rest of the string as one token rather than
// failing, since a mangled $EDITOR should still produce something to try.
export function splitCommandLine(text: string): string[] {
  const out: string[] = [];
  let current = "";
  let started = false;
  let quote: '"' | "'" | null = null;
  for (const ch of text) {
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) {
        out.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) {
    out.push(current);
  }
  return out;
}
