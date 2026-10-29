// Report the session's activity to the host terminal via OSC 7501, the
// Program Status Protocol (https://mitchellh.com/writing/program-status-osc7501).
//
// Host-independent like OSC 7 and OSC 9;4: terminals that don't know the code
// ignore it, so it sits beside the TerminalHost adapters rather than behind
// them. On by default; HYDRA_OSC7501=0 turns it off.
//
// `done` is never sent: it means "finished, result not yet seen", and the TUI
// has no unseen-completion signal to drive it from.

import type { AgentActivity } from "./term-host/types.js";

const APP = "hydra";

function enabled(): boolean {
  const v = process.env.HYDRA_OSC7501?.toLowerCase();
  return v !== "0" && v !== "false" && v !== "off";
}

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

export function encodeProgramStatus(state: AgentActivity): string {
  let body: string;
  switch (state) {
    case "working":
      body = `state=working:app=${APP}`;
      break;
    case "idle":
      body = `state=idle:app=${APP}`;
      break;
    case "blocked":
      body = `state=blocked:kind=permission:app=${APP}:msg=${b64("Permission requested")}`;
      break;
    default:
      body = `state=clear:app=${APP}`;
      break;
  }
  return `\x1b]7501;${body}\x1b\\`;
}

// Same DCS passthrough as the OSC 52 path; needs `allow-passthrough on`.
function wrapForHost(seq: string): string {
  if (process.env.TMUX) {
    return `\x1bPtmux;${seq.replace(/\x1b/g, "\x1b\x1b")}\x1b\\`;
  }
  return seq;
}

let last: string | null = null;

export function programStatusEnabled(): boolean {
  return enabled();
}

export function publishProgramStatus(state: AgentActivity): void {
  if (!enabled() || !process.stdout.isTTY) {
    return;
  }
  const seq = encodeProgramStatus(state);
  if (seq === last) {
    return;
  }
  last = seq;
  process.stdout.write(wrapForHost(seq));
}

export function clearProgramStatus(): void {
  publishProgramStatus("unknown");
  last = null;
}
