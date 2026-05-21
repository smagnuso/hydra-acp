// Pre-screen prompt for imported sessions on first local launch.
//
// When the user picks (with Enter, not `v`) a session that was imported
// from another machine and has never been attached locally yet
// (importedFromMachine set + upstreamSessionId empty), the cwd stored on
// disk usually points at a path that doesn't exist on this machine
// (e.g. /home/alice/projects/foo on Bob's box). Without intervention,
// the daemon silently falls back to $HOME when resurrecting the agent.
// This prompt lets the user pick a local cwd instead.
//
// UI is modeled on picker.ts's "rename" mode: a single-line text input
// with Enter/Esc/Backspace/^U/^W. Lives outside the main Screen so it
// can run between picker close and WS attach.

import type { Terminal } from "terminal-kit";
import * as os from "node:os";
import { shortenHomePath } from "../core/paths.js";
import { stripHydraSessionPrefix } from "../core/session.js";
import { validateLocalCwd } from "../core/cwd.js";
import type { DiscoveredSession } from "./discovery.js";

export interface PromptOptions {
  // Allow tests / callers to override the default pre-fill. Defaults to
  // os.homedir() so the user can just press Enter to accept the same
  // fallback the daemon would have used silently.
  defaultCwd?: string;
}

// Returns the user-chosen absolute cwd, or null if the user cancelled
// (Esc / ^C / ^D). The returned path is guaranteed to be an existing
// directory on this machine — validateLocalCwd is awaited before
// resolve().
export async function promptForImportCwd(
  term: Terminal,
  session: DiscoveredSession,
  opts: PromptOptions = {},
): Promise<string | null> {
  const defaultCwd = opts.defaultCwd ?? os.homedir();
  // Reset terminal state the same way the picker does. Without this the
  // alternate screen / kitty / mouse modes from a previous picker run
  // (or a crashed prior session) can swallow arrows and ESC.
  process.stdout.write("\x1b[<u");
  process.stdout.write("\x1b[?2004l");
  process.stdout.write("\x1b[>4;0m");
  process.stdout.write("\x1b[>5;0m");
  process.stdout.write("\x1b[?1000l");
  process.stdout.write("\x1b[?1002l");
  process.stdout.write("\x1b[?1006l");
  process.stdout.write("\x1b[?1l");
  process.stdout.write("\x1b>");

  const shortId = stripHydraSessionPrefix(session.sessionId);
  const fromMachine = session.importedFromMachine ?? "another machine";
  const originalCwd = session.cwd;

  let buffer = defaultCwd;
  let errorLine: string | null = null;
  let busy = false;

  const render = (): void => {
    term("\n");
    term.bold.cyan("Imported session: ");
    term(`${shortId}\n`);
    term.dim(`  from machine:   `);
    term(`${fromMachine}\n`);
    term.dim(`  original cwd:   `);
    term(`${shortenHomePath(originalCwd)}\n`);
    term("\n");
    term(
      "This session has never been launched on this machine. Pick a local\n",
    );
    term("cwd for the agent (Enter to accept, Esc to cancel):\n\n");
    paintInput();
    if (errorLine) {
      term("\n");
      term.red(`  ${errorLine}\n`);
    }
  };

  const paintInput = (): void => {
    term.bold("cwd: ");
    term(buffer);
    if (!busy) {
      term.bgWhite(" ");
    }
  };

  // Repaint just the input + error lines without reprinting the header
  // block. The input lives on its own line so we can rewrite the whole
  // line in place rather than tracking column positions.
  const repaintInput = (): void => {
    term.column(1);
    term.eraseLine();
    paintInput();
    if (errorLine !== null) {
      term("\n");
      term.eraseLine();
      term.red(`  ${errorLine}`);
      // Move back up so subsequent repaints land on the input row.
      term.up(1);
      term.column(1);
    }
  };

  render();

  return await new Promise<string | null>((resolve) => {
    let resolved = false;
    const cleanup = (): void => {
      if (resolved) {
        return;
      }
      resolved = true;
      term.off("key", onKey);
      term.grabInput(false);
      term.hideCursor(false);
      term("\n\n");
    };
    const finish = (value: string | null): void => {
      cleanup();
      resolve(value);
    };
    const onKey = (name: string, _matches: string[], data?: { isCharacter?: boolean }): void => {
      if (busy) {
        return;
      }
      if (name === "ENTER" || name === "KP_ENTER") {
        const candidate = buffer;
        busy = true;
        errorLine = null;
        repaintInput();
        void validateLocalCwd(candidate).then((result) => {
          busy = false;
          if (result.ok) {
            finish(result.path);
            return;
          }
          errorLine = result.reason;
          repaintInput();
        });
        return;
      }
      if (name === "ESCAPE" || name === "CTRL_C" || name === "CTRL_D") {
        finish(null);
        return;
      }
      if (name === "BACKSPACE") {
        if (buffer.length > 0) {
          buffer = buffer.slice(0, -1);
          errorLine = null;
          repaintInput();
        }
        return;
      }
      if (name === "CTRL_U") {
        buffer = "";
        errorLine = null;
        repaintInput();
        return;
      }
      if (name === "CTRL_W") {
        const trimmedRight = buffer.replace(/[/\s]+$/, "");
        // Drop the last path segment (or whitespace-delimited word as a
        // fallback). Mirrors what most readline-style editors do.
        const lastSep = Math.max(
          trimmedRight.lastIndexOf("/"),
          trimmedRight.lastIndexOf(" "),
        );
        buffer = lastSep >= 0 ? trimmedRight.slice(0, lastSep + 1) : "";
        errorLine = null;
        repaintInput();
        return;
      }
      if (data?.isCharacter) {
        buffer += name;
        errorLine = null;
        repaintInput();
        return;
      }
    };
    term.grabInput({});
    term.on("key", onKey);
  });
}
