// Returns the name of the binary the user invoked. The package ships
// two bins (`hydra` and `hydra-acp`) both pointing at dist/cli.js;
// echoing back whichever was used keeps help text and resume hints
// consistent with how the user is actually driving the tool.
//
// `process.argv[1]` is the script path Node executed. When run via a
// PATH-installed bin, that's the symlink (`/usr/local/bin/hydra` or
// `.../hydra-acp`). `basename` gives us the symlink name; the fallback
// covers edge cases (REPL embeds, ts-node, tests).

import * as path from "node:path";

export function invokedBinName(): string {
  const argv1 = process.argv[1];
  if (!argv1) {
    return "hydra-acp";
  }
  const base = path.basename(argv1);
  // Strip a trailing ".js" so a developer running `node dist/cli.js`
  // gets "hydra-acp" in messages rather than "cli.js".
  if (base === "cli.js" || base === "cli") {
    return "hydra-acp";
  }
  return base;
}
