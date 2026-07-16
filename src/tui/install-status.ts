import type { Terminal as TermkitTerminal } from "terminal-kit";

import type { AgentInstallProgressParams } from "../acp/types-capabilities.js";

// Sink for the launch/install status line. Two implementations live in
// the tree: an in-place stdout redraw (used in the pre-alt-screen gap
// when no picker frame is on screen) and a picker-composer-row sink
// (used when the picker is still visible so the status appears in the
// gap between composer and session list instead of at the bottom).
export interface InstallStatusSink {
  write(text: string): void;
  finalize(): void;
}

export interface InstallStatusLine {
  write(text: string): void;
  applyProgress(event: AgentInstallProgressParams): void;
  finalize(): void;
}

// OSC 9;4 taskbar-progress escape. `3` = indeterminate pulse,
// `0` = clear. Terminals that don't implement it ignore the escape
// silently. Emitted directly to stdout — orthogonal to whichever sink
// paints the visible text.
function writeOsc94(state: 0 | 3): void {
  process.stdout.write(`\x1b]9;4;${state}\x1b\\`);
}

// Compose the human-readable progress line from a daemon event. Kept
// pure so both sinks share the exact phrasing.
function formatProgressText(
  baseLabel: string,
  lastText: string,
  event: AgentInstallProgressParams,
): string {
  const idVer = `${event.agentId}@${event.version}`;
  if (event.source === "npm") {
    if (event.phase === "install_start" || event.phase === "download_start") {
      return `${baseLabel} installing ${idVer} via npm…`;
    }
    if (event.phase === "installed") {
      return `${baseLabel} ${idVer} installed`;
    }
    return `${baseLabel} installing ${idVer} via npm…`;
  }
  if (event.phase === "download_start" || event.phase === "download_progress") {
    const received = event.receivedBytes ?? 0;
    const total = event.totalBytes ?? 0;
    const rxMb = (received / 1_000_000).toFixed(1);
    if (total > 0) {
      const totalMb = (total / 1_000_000).toFixed(1);
      const pct = Math.min(100, Math.floor((received / total) * 100));
      return `${baseLabel} downloading ${idVer} ${rxMb}/${totalMb} MB (${pct}%)`;
    }
    return `${baseLabel} downloading ${idVer} ${rxMb} MB`;
  }
  if (event.phase === "download_done") {
    return `${baseLabel} downloaded ${idVer}, verifying…`;
  }
  if (event.phase === "extract") {
    return `${baseLabel} extracting ${idVer}…`;
  }
  if (event.phase === "installed") {
    return `${baseLabel} ${idVer} installed`;
  }
  return lastText || baseLabel;
}

// Wrap a sink with the shared progress-composition + OSC-9;4 lifecycle.
// The sink decides *where* the text lands; this layer decides *what*
// text lands and manages the taskbar-pulse escape.
export function createInstallStatusLine(
  baseLabel: string,
  sink: InstallStatusSink,
): InstallStatusLine {
  let finalized = false;
  let lastText = "";
  let osc94Active = false;
  let currentBase = baseLabel;

  const setOsc94 = (state: 0 | 3): void => {
    if (finalized) {
      return;
    }
    if (state === 3 && osc94Active) {
      return;
    }
    if (state === 0 && !osc94Active) {
      return;
    }
    osc94Active = state === 3;
    writeOsc94(state);
  };

  return {
    write(text) {
      if (finalized) {
        return;
      }
      currentBase = text;
      lastText = text;
      sink.write(text);
    },
    applyProgress(event) {
      if (finalized) {
        return;
      }
      const isActive =
        event.phase === "download_start" ||
        event.phase === "download_progress" ||
        event.phase === "install_start" ||
        event.phase === "extract" ||
        event.phase === "download_done";
      if (isActive) {
        setOsc94(3);
      } else if (event.phase === "installed") {
        setOsc94(0);
      }
      const text = formatProgressText(currentBase, lastText, event);
      lastText = text;
      sink.write(text);
    },
    finalize() {
      if (finalized) {
        return;
      }
      finalized = true;
      setOsc94(0);
      sink.finalize();
    },
  };
}

// Stdout redraw-in-place sink. Rewrites the current terminal line via
// CR + eraseLineAfter without emitting a trailing newline; finalize()
// drops one newline so subsequent output starts fresh.
//
// Used in the pre-alt-screen gap between the picker closing and
// screen.start() entering fullscreen — where there's no other visible
// UI to hang the status on.
export function createStdoutInstallStatusSink(
  term: TermkitTerminal,
): InstallStatusSink {
  let finalized = false;
  return {
    write(text) {
      if (finalized) {
        return;
      }
      process.stdout.write("\r");
      term.eraseLineAfter();
      term.brightYellow(text);
    },
    finalize() {
      if (finalized) {
        return;
      }
      finalized = true;
      process.stdout.write("\n");
    },
  };
}
