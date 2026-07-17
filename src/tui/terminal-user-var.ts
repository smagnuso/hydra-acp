// Advertise a hydra-owned key/value pair to the surrounding terminal
// / multiplexer so external tooling can query it (tmux bindings,
// terminal integrations, etc.). Two independent channels:
//
//  1. iTerm2's OSC 1337 SetUserVar sequence, honored by iTerm2 and
//     Kitty natively. Format:
//       ESC ] 1337 ; SetUserVar=<name>=<base64-of-value> BEL
//     Note: tmux (as of 3.4) does NOT capture SetUserVar into pane
//     options despite what the older iTerm2 docs suggest, so this
//     channel alone isn't enough for tmux users.
//
//  2. A direct `tmux set-option -p @<name> <value>` when $TMUX_PANE
//     is set. This writes to the pane's user options table, which is
//     queryable via `tmux show-options -pv @<name>` or the
//     `#{@<name>}` format spec in bindings.
//
// Both fire on every emit so tooling on either side works. Errors
// from the tmux shellout are swallowed — a missing tmux binary or an
// unreachable server shouldn't crash the TUI.

import { spawn } from "node:child_process";

const OSC = "\x1b]";
const BEL = "\x07";

function writeOSC(name: string, value: string): void {
  const encoded = Buffer.from(value, "utf8").toString("base64");
  process.stdout.write(`${OSC}1337;SetUserVar=${name}=${encoded}${BEL}`);
}

function runTmux(args: string[]): void {
  if (!process.env.TMUX_PANE) {
    return;
  }
  try {
    const child = spawn("tmux", args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Best-effort — nothing to surface to the user here.
  }
}

export function emitSetUserVar(name: string, value: string): void {
  writeOSC(name, value);
  const pane = process.env.TMUX_PANE;
  if (pane) {
    runTmux(["set-option", "-pt", pane, `@${name}`, value]);
  }
}

export function clearUserVar(name: string): void {
  writeOSC(name, "");
  const pane = process.env.TMUX_PANE;
  if (pane) {
    runTmux(["set-option", "-put", pane, `@${name}`]);
  }
}
