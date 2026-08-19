// Argv construction for the double-click open-file gesture. Split out of
// Screen so the placeholder rules are testable without a terminal, and so
// the line-number handling sits next to the table that knows each editor's
// syntax for it.

export interface OpenFilePlan {
  program: string;
  args: string[];
}

// How an editor takes a line number when the command line didn't say.
//   "plus"  — `vim +42 path`
//   "colon" — `hx path:42`
// Only editors whose syntax is certain belong here: a wrong guess makes
// "+42" a filename and the editor cheerfully creates it. An unknown
// program just loses the line number, which is what every $EDITOR
// fallback did before this table existed.
const LINE_ARG_SYNTAX: Readonly<Record<string, "plus" | "colon">> = {
  vi: "plus",
  vim: "plus",
  "vim.basic": "plus",
  "vim.tiny": "plus",
  vimdiff: "plus",
  view: "plus",
  ex: "plus",
  nvim: "plus",
  nvimdiff: "plus",
  gvim: "plus",
  mvim: "plus",
  nano: "plus",
  pico: "plus",
  micro: "plus",
  kak: "plus",
  joe: "plus",
  emacs: "plus",
  emacsclient: "plus",
  hx: "colon",
  helix: "colon",
};

function programKey(program: string): string {
  const base = program.split(/[/\\]/).pop() ?? program;
  return base.replace(/\.exe$/i, "").toLowerCase();
}

// Substitutes %f / %n into `argv` and returns the program + args to spawn.
// Returns null when argv has no program to run.
//
// Rules, in order:
//   - %f becomes the absolute path, %n the line number.
//   - An arg mentioning %n is dropped entirely when no line number is
//     known. Otherwise a placeholder like "+%n" would collapse to a bare
//     "+", which emacsclient (and most editors) read as a filename.
//   - When no arg mentioned %f, the path is appended last.
//   - When no arg mentioned %n either and we know both the line number and
//     this editor's syntax for one, the line is supplied in that syntax.
export function planOpenFile(
  argv: readonly string[],
  file: string,
  line: number | null,
): OpenFilePlan | null {
  const [program, ...rest] = argv;
  if (!program) {
    return null;
  }
  const lineStr = line === null ? "" : String(line);
  let sawFilePlaceholder = false;
  let sawLinePlaceholder = false;
  const args: string[] = [];
  for (const arg of rest) {
    if (arg.includes("%f")) {
      sawFilePlaceholder = true;
    }
    if (arg.includes("%n")) {
      sawLinePlaceholder = true;
      if (lineStr === "") {
        continue;
      }
    }
    args.push(arg.replaceAll("%f", file).replaceAll("%n", lineStr));
  }
  if (sawFilePlaceholder) {
    return { program, args };
  }
  const syntax =
    lineStr === "" || sawLinePlaceholder
      ? undefined
      : LINE_ARG_SYNTAX[programKey(program)];
  if (syntax === "plus") {
    args.push(`+${lineStr}`, file);
  } else if (syntax === "colon") {
    args.push(`${file}:${lineStr}`);
  } else {
    args.push(file);
  }
  return { program, args };
}
