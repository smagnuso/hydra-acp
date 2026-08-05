// tmux as a TerminalHost.
//
// Everything tmux-specific lives here. The interesting difference from the
// herdr adapter isn't the feature set, it's the shape of the transport:
// herdr is a long-lived unix socket speaking JSON-RPC, tmux is a subprocess
// per call. Core doesn't know or care, which is the point.
//
// ---------------------------------------------------------------------
// FOUR TMUX BEHAVIOURS THAT DRIVE THIS FILE
//
// 1. WINDOW COMMANDS REJECT A PANE TARGET. `new-window -t %3` fails outright
//    with "can't specify pane here" — the target must be a session (or a
//    window). So we resolve our pane's session id once and target that.
//    Targeting *something* explicitly is not optional: with no -t, tmux acts
//    on the client's current window, so a background hydra would create
//    windows in, and rename, whatever the user happens to be looking at.
//    That is the wrong-pane bug class this whole area already produced once.
//
// 2. `automatic-rename` IS A FACT, NOT A GUESS. tmux tracks per window
//    whether the name is one it generated (after the running command, e.g.
//    "zsh", "node") or one someone set. So this adapter can answer the
//    ownership question authoritatively via TabLabelView.auto instead of
//    pattern-matching the string the way herdr must.
//
//    The corollary matters too: `rename-window` CLEARS automatic-rename for
//    that window, permanently. So our first rename takes the window out of
//    tmux's naming entirely — see the note on restore below.
//
// 3. ARGV IS PRESERVED VERBATIM. Given multiple arguments tmux execs them
//    directly rather than re-parsing through a shell — verified with an
//    argument containing `$(...)`, backticks and quotes, which arrived at
//    the child byte-identical. So, as with herdr, nothing needs escaping and
//    a prompt can be passed as a plain argv element.
//
// 4. COMMANDS CHAIN IN ONE INVOCATION. A literal ";" argument separates
//    commands, so a whole report is one spawn rather than one per key.
//    Without this, `report` would fork seven processes per change.
// ---------------------------------------------------------------------
//
// NOT IMPLEMENTED YET, DELIBERATELY
//
// Restore-on-exit is wrong for tmux and is knowingly left wrong for now.
// Core's restore calls writeLabel(original), which puts the old text back
// but leaves automatic-rename off, so the window freezes at that name
// instead of resuming tracking the running command. The correct action is
// `set-window-option automatic-rename on`, which the interface has no way to
// express. That needs an optional restoreLabel() on TerminalHost; until then
// a tmux window that hydra renamed stays manually named after hydra exits.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  OpenTabResult,
  OpenTabSpec,
  TabLabelView,
  TerminalHost,
  TerminalHostCandidate,
  TerminalHostSnapshot,
} from "./types.js";

const run = promisify(execFile);

const COMMAND_TIMEOUT_MS = 2_000;

/**
 * Env vars tmux uses to name a pane.
 *
 * TMUX itself is deliberately absent: it carries the server socket path, so
 * it's the "how do I reach the server" half and stays valid for as long as
 * the server runs. TMUX_PANE is the pane identity and must not outlive it.
 */
export const TMUX_PANE_SCOPED_ENV = ["TMUX_PANE"] as const;

/**
 * The complete token set this adapter owns, as tmux user options.
 *
 * Every report writes all of them — setting the ones with values and
 * unsetting the rest — so a session switch can't leave the previous
 * session's model or cost showing. Same discipline as the herdr token map,
 * for the same reason.
 *
 * These render NOWHERE by default. tmux has no sidebar; the user opts in by
 * referencing them in their own format strings, e.g.
 *
 *   set -g window-status-format '#I:#W#{?#{==:#{@hydra_state},blocked},!,}'
 *
 * which marks the windows whose sessions are waiting on you. Values are
 * therefore semantic words rather than glyphs: tmux format strings can
 * branch on them, so the user picks the icon and the colour. Shipping `⚠`
 * from here would bake in a font assumption they couldn't undo.
 */
const TOKEN_KEYS = [
  "@hydra_state",
  "@hydra_title",
  "@hydra_cwd",
  "@hydra_agent",
  "@hydra_model",
  "@hydra_cost",
  "@hydra_queue",
] as const;

function detect(env: NodeJS.ProcessEnv): boolean {
  return !!env.TMUX && !!env.TMUX_PANE;
}

/**
 * The server socket, from the first comma-separated field of $TMUX
 * (`socket_path,server_pid,session_id`).
 *
 * Passed explicitly as -S rather than relying on tmux reading $TMUX itself,
 * so we keep talking to the right server even if something rewrites the
 * variable — and so the adapter still works from a process whose env has
 * been through the pane-scoped scrub.
 */
function socketPath(env: NodeJS.ProcessEnv): string | null {
  const first = env.TMUX?.split(",")[0];
  return first && first.length > 0 ? first : null;
}

class TmuxHost implements TerminalHost {
  readonly id = "tmux";

  readonly caps = {
    openTab: true,
    // The first host that can actually do this. herdr forced the capability
    // to exist and then had to decline it.
    split: true,
    label: true,
    report: true,
  };

  private readonly socket: string;
  private readonly pane: string;

  // Resolved lazily and cached: create() is synchronous and this needs a
  // subprocess. A pane cannot move between sessions in tmux without being
  // broken out into a new one (which restarts nothing but does change the
  // id), so caching is safe.
  private session: string | null = null;

  // Last token set written, so an unchanged report costs no spawn. Core
  // already dedupes whole snapshots; this only catches the case where two
  // different snapshots produce identical tokens.
  private sentTokens: string | null = null;

  constructor(socket: string, pane: string) {
    this.socket = socket;
    this.pane = pane;
  }

  /** Run one tmux invocation. Rejects on non-zero exit. */
  private async tmux(...args: string[]): Promise<string> {
    const { stdout } = await run("tmux", ["-S", this.socket, ...args], {
      timeout: COMMAND_TIMEOUT_MS,
      // A pane title or prompt is arbitrary user text and tmux will happily
      // echo it back; cap the buffer rather than trusting it to be small.
      maxBuffer: 1024 * 1024,
    });
    return stdout;
  }

  private async sessionId(): Promise<string> {
    if (this.session === null) {
      this.session = (
        await this.tmux("display-message", "-p", "-t", this.pane, "-F", "#{session_id}")
      ).trim();
    }
    return this.session;
  }

  private tokenValues(snap: TerminalHostSnapshot): Record<string, string | null> {
    return {
      "@hydra_state": snap.state,
      "@hydra_title": snap.title,
      "@hydra_cwd": snap.cwd,
      "@hydra_agent": snap.agent,
      "@hydra_model": snap.model,
      "@hydra_cost": snap.cost,
      "@hydra_queue": snap.queued !== null && snap.queued > 0 ? String(snap.queued) : null,
    };
  }

  async report(snap: TerminalHostSnapshot): Promise<void> {
    const values = this.tokenValues(snap);
    const key = JSON.stringify(values);
    if (this.sentTokens === key) {
      return;
    }
    // One invocation for the whole set: `;` as its own argument separates
    // tmux commands. Seven spawns per report would be absurd at the banner
    // funnel's 1Hz.
    const args: string[] = [];
    for (const name of TOKEN_KEYS) {
      if (args.length > 0) {
        args.push(";");
      }
      const value = values[name] ?? null;
      args.push("set-option", "-p", "-t", this.pane);
      if (value === null || value === "") {
        // -u unsets, which is how a key is cleared. Omitting it instead
        // would leave the previous session's value in place.
        args.push("-u", name);
      } else {
        args.push(name, value);
      }
    }
    this.sentTokens = key;
    try {
      await this.tmux(...args);
    } catch (err) {
      this.sentTokens = null;
      throw err;
    }
  }

  async release(): Promise<void> {
    if (this.sentTokens === null) {
      return;
    }
    this.sentTokens = null;
    const args: string[] = [];
    for (const name of TOKEN_KEYS) {
      if (args.length > 0) {
        args.push(";");
      }
      args.push("set-option", "-p", "-t", this.pane, "-u", name);
    }
    await this.tmux(...args);
  }

  async openTab(spec: OpenTabSpec): Promise<OpenTabResult> {
    let target: string;
    try {
      target = await this.sessionId();
    } catch (err) {
      return { ok: false, error: tmuxError(err) };
    }
    // -n names the window, which also takes it out of automatic-rename —
    // correct here, since a window we created for a session is ours.
    const args = ["new-window", "-t", target, "-n", spec.label];
    return this.spawnWindow(args, spec);
  }

  async splitTab(spec: OpenTabSpec): Promise<OpenTabResult> {
    // -h splits left/right, which is the right default for a session view:
    // transcripts are tall and narrow-ish, and a top/bottom split halves the
    // lines of scrollback both panes can show.
    //
    // No -n: panes have no name in the window-name sense, and the label
    // belongs to the window, which we are explicitly NOT renaming here. That
    // falls out correctly anyway — the window now has two panes, so the
    // label guard in label-sync refuses to rename it, which is what we want
    // when two sessions share a window.
    return this.spawnWindow(["split-window", "-h", "-t", this.pane], spec);
  }

  private async spawnWindow(
    head: string[],
    spec: OpenTabSpec,
  ): Promise<OpenTabResult> {
    const args = [...head];
    // tmux ACCEPTS a relative cwd (unlike herdr, which rejects the call), and
    // resolves it against a directory we can't predict from here. Dropping it
    // is better than silently landing somewhere surprising.
    if (spec.cwd && spec.cwd.startsWith("/")) {
      args.push("-c", spec.cwd);
    }
    for (const [name, value] of Object.entries(spec.env ?? {})) {
      args.push("-e", `${name}=${value}`);
    }
    // Everything after this is argv, passed through verbatim.
    args.push(...spec.argv);
    try {
      await this.tmux(...args);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: tmuxError(err) };
    }
  }

  async readLabel(): Promise<TabLabelView | null> {
    let out: string;
    try {
      out = await this.tmux(
        "display-message",
        "-p",
        "-t",
        this.pane,
        "-F",
        "#{window_name}\t#{window_panes}\t#{?automatic-rename,1,0}",
      );
    } catch {
      return null;
    }
    // Only the first line: a window name can't contain a newline, but being
    // strict here costs nothing and a malformed read must not become a
    // confident answer.
    const [name, panes, auto] = (out.split("\n")[0] ?? "").split("\t");
    const paneCount = Number.parseInt(panes ?? "", 10);
    if (name === undefined || !Number.isFinite(paneCount)) {
      return null;
    }
    return { label: name, paneCount, auto: auto === "1" };
  }

  async writeLabel(label: string): Promise<boolean> {
    try {
      await this.tmux("rename-window", "-t", this.pane, label);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Fallback only — readLabel answers this authoritatively via
   * `automatic-rename`, so this is reached only if that read somehow lost
   * the flag.
   *
   * Conservative on purpose. tmux's generated names are just the running
   * command ("zsh", "node", "hydra"), which are indistinguishable from names
   * a person might type, so any string heuristic here would eventually
   * overwrite someone's deliberate choice.
   */
  isAutoLabel(): boolean {
    return false;
  }
}

/** tmux reports failures on stderr with a non-zero exit. */
function tmuxError(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  const stderr = e.stderr?.trim();
  return stderr && stderr.length > 0 ? stderr : (e.message ?? "tmux failed");
}

export const tmuxCandidate: TerminalHostCandidate = {
  id: "tmux",
  paneScopedEnv: TMUX_PANE_SCOPED_ENV,
  detect,
  create: () => {
    const socket = socketPath(process.env);
    const pane = process.env.TMUX_PANE;
    if (!socket || !pane) {
      throw new Error("tmux environment incomplete");
    }
    return new TmuxHost(socket, pane);
  },
};
