// Paseo (https://paseo.sh) as a TerminalHost.
//
// Everything Paseo-specific lives here. Core knows about snapshots, tab
// labels and capabilities; it does not know Paseo exists. If this file were
// deleted, the only thing lost would be one entry in the candidate list.
//
// ---------------------------------------------------------------------
// TRANSPORT: subprocess per call, same shape as tmux.ts. Paseo has no
// long-lived control socket exposed to us — every openTab call is a `paseo`
// CLI invocation against the local daemon, using whatever daemon connection
// the user already has configured (same as any interactive `paseo` command
// they'd type themselves).
//
// REPORTING IS DIRECT HTTP, NOT THE CLI. Paseo injects
// PASEO_TERMINAL_ID / PASEO_ACTIVITY_TOKEN / PASEO_TERMINAL_ACTIVITY_URL
// into every terminal it creates — the exact mechanism `paseo hooks <agent>
// <event>` uses under the hood (verified against @getpaseo/cli's
// commands/hooks.js): POST {terminalId, token, state} to the activity URL.
// No agent-identity check on that endpoint, no dependency on Paseo's
// `enableTerminalAgentHooks` setting (that only gates auto-installing hooks
// into OTHER agents' own config files; the env vars and the endpoint work
// unconditionally). Hydra already knows its own real activity state, so it
// posts directly instead of pretending to be a recognized provider.
//
// OPENTAB IS A WORKAROUND, NOT A PRIMITIVE. `paseo terminal create` accepts
// only --cwd/--name at the CLI today. The daemon protocol underneath
// (create_terminal_request, per @getpaseo/client's createTerminal) already
// supports launching a command+args directly — the CLI just doesn't expose
// it yet. Landing --command/--args on `paseo terminal create` would be a
// clean, small ask that turns this into a real launch-argv primitive like
// herdr's/tmux's. Until then: create a blank terminal, then `send-keys` the
// argv as literal keystrokes plus Enter. That means shell-quoting it
// ourselves — unlike herdr/tmux, which exec argv directly with no shell in
// the middle, this really does type through a live prompt.
//
// NOT IMPLEMENTED: reveal, label. Nothing in the CLI or client SDK reads or
// writes a terminal's UI-visible name after creation, and nothing brings an
// existing terminal to the front in a connected client — Paseo's terminals
// are app/web UI panels, not native OS windows a CLI can focus. If that
// surface appears later, add it here; core doesn't need to change.
// ---------------------------------------------------------------------

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  AgentActivity,
  OpenTabResult,
  OpenTabSpec,
  TerminalHost,
  TerminalHostCandidate,
  TerminalHostSnapshot,
} from "./types.js";

const run = promisify(execFile);

const COMMAND_TIMEOUT_MS = 5_000;
const REPORT_TIMEOUT_MS = 1_000;

/**
 * How long a `needs-input` transition has to hold before Paseo hears about
 * it. Matches herdr's own `ui.toast.delay_seconds` default (1s) — herdr
 * gates its OS-level toast behind exactly this kind of hold, re-checking the
 * pane's live state at delivery time, which is why the same multi-client
 * permission race that spams Paseo has never been visible there. Paseo has
 * no equivalent on its end, so it has to happen here instead.
 */
const NEEDS_INPUT_NOTIFY_DELAY_MS = 1_000;

/**
 * Env vars Paseo uses to identify a terminal. PASEO_TERMINAL_ACTIVITY_URL
 * and PASEO_HOOK_CLI are deliberately absent: they're "how do I reach the
 * server" (URL) and "which binary" (CLI path), valid for as long as Paseo
 * runs, which outlasts the daemon. PASEO_TERMINAL_ID and
 * PASEO_ACTIVITY_TOKEN name and authorize reporting for THIS terminal
 * specifically and must not outlive it — a child process inheriting them
 * would be able to post activity as a terminal it isn't.
 */
export const PASEO_PANE_SCOPED_ENV = [
  "PASEO_TERMINAL_ID",
  "PASEO_ACTIVITY_TOKEN",
] as const;

function detect(env: NodeJS.ProcessEnv): boolean {
  return (
    !!env.PASEO_TERMINAL_ID &&
    !!env.PASEO_ACTIVITY_TOKEN &&
    !!env.PASEO_TERMINAL_ACTIVITY_URL
  );
}

/**
 * Hydra's four activity states map onto Paseo's three. `blocked` reads as
 * `needs-input` — Paseo's own closest concept (a permission/question the
 * agent is waiting on). `unknown` has no equivalent on the wire; treated as
 * idle rather than skipped, since Paseo's own tracker defaults to no
 * indicator at rest and there is no dedicated "I don't know" value the way
 * herdr's report can simply be withheld until a real state arrives.
 */
export function toPaseoState(
  state: AgentActivity,
): "running" | "idle" | "needs-input" {
  switch (state) {
    case "working":
      return "running";
    case "blocked":
      return "needs-input";
    case "idle":
    case "unknown":
      return "idle";
  }
}

/**
 * Single-quote a token for a POSIX shell. Paseo's send-keys types raw
 * keystrokes into a live prompt, so — unlike herdr/tmux, which exec argv
 * directly — this is real shell input we have to escape ourselves.
 */
export function shellQuote(token: string): string {
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

class PaseoHost implements TerminalHost {
  readonly id = "paseo";

  readonly caps = {
    openTab: true,
    // No split concept exposed: Paseo terminals are workspace-scoped
    // panels, not panes a window can be divided into.
    split: false,
    label: false,
    report: true,
    reveal: false,
  };

  private readonly cli: string;
  private readonly terminalId: string;
  private readonly token: string;
  private readonly activityUrl: string;
  private readonly fetchImpl: typeof fetch;

  // Dedup on the mapped state alone, not the raw snapshot: report() is
  // called at whatever cadence core's funnels tick (the banner ticks at
  // 1Hz mid-turn), and Paseo has no use for title/model/cost — only state
  // is wire-visible, so only state changes are worth a POST.
  private lastState: string | null = null;
  private claimed = false;

  // Holds a pending `needs-input` POST during NEEDS_INPUT_NOTIFY_DELAY_MS.
  // A session attached from more than one client (e.g. reopened from
  // hydra's own picker into a second Paseo tab) broadcasts every permission
  // request to all of them; the client that loses the "first response wins"
  // race still sees a real blocked -> resolved transition, just one nobody
  // needed to act on. Without this, that transition alone is enough to fire
  // a push notification for a request answered elsewhere in well under a
  // second.
  private pendingNeedsInput: ReturnType<typeof setTimeout> | null = null;

  private cancelPendingNeedsInput(): void {
    if (this.pendingNeedsInput !== null) {
      clearTimeout(this.pendingNeedsInput);
      this.pendingNeedsInput = null;
    }
  }

  constructor(env: NodeJS.ProcessEnv, fetchImpl: typeof fetch = fetch) {
    this.cli = env.PASEO_HOOK_CLI || "paseo";
    this.terminalId = env.PASEO_TERMINAL_ID as string;
    this.token = env.PASEO_ACTIVITY_TOKEN as string;
    this.activityUrl = env.PASEO_TERMINAL_ACTIVITY_URL as string;
    this.fetchImpl = fetchImpl;
  }

  private async post(state: string): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REPORT_TIMEOUT_MS);
    try {
      await this.fetchImpl(this.activityUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          terminalId: this.terminalId,
          token: this.token,
          state,
        }),
        signal: controller.signal,
      });
    } catch {
      // Best-effort, same posture as `paseo hooks` itself — a dropped
      // report just leaves the tab indicator stale until the next one.
    } finally {
      clearTimeout(timeout);
    }
  }

  async report(snap: TerminalHostSnapshot): Promise<void> {
    const state = toPaseoState(snap.state);
    if (state === this.lastState) {
      return;
    }
    this.lastState = state;
    this.claimed = true;
    this.cancelPendingNeedsInput();
    if (state === "needs-input") {
      this.pendingNeedsInput = setTimeout(() => {
        this.pendingNeedsInput = null;
        // lastState may have moved on again while the timer was pending
        // (resolved, then blocked again for a genuinely new reason) — only
        // deliver if it's still what we're holding.
        if (this.lastState === "needs-input") {
          void this.post("needs-input");
        }
      }, NEEDS_INPUT_NOTIFY_DELAY_MS);
      // Same reasoning as the unreachable-hold timer in report.ts: must not
      // be what keeps the process alive past a clean exit.
      this.pendingNeedsInput.unref?.();
      return;
    }
    await this.post(state);
  }

  /**
   * No dedicated "unset" value exists on the wire — see the header note on
   * reporting. Posting idle is the closest available withdrawal: it clears
   * whatever "running"/"needs-input" indicator Paseo is showing for this
   * terminal, which is the only user-visible state report() ever set.
   */
  async release(): Promise<void> {
    this.cancelPendingNeedsInput();
    if (!this.claimed) {
      return;
    }
    this.claimed = false;
    this.lastState = null;
    await this.post("idle");
  }

  /**
   * Create a blank terminal, then type the argv into it as literal
   * keystrokes. See the header note on why this isn't a real launch-argv
   * primitive today. Any spec.env is folded into the same typed command as
   * leading POSIX `KEY=value` assignments — send-keys has no separate
   * channel for it, but that's ordinary, correct shell syntax for scoping
   * env to one command.
   */
  async openTab(spec: OpenTabSpec): Promise<OpenTabResult> {
    let created: { id?: unknown };
    try {
      const args = ["terminal", "create", "--json", "--name", spec.label];
      if (spec.cwd) {
        args.push("--cwd", spec.cwd);
      }
      const { stdout } = await run(this.cli, args, {
        timeout: COMMAND_TIMEOUT_MS,
      });
      created = JSON.parse(stdout) as { id?: unknown };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    if (typeof created.id !== "string" || created.id.length === 0) {
      return { ok: false, error: "paseo terminal create returned no id" };
    }
    const envPrefix = Object.entries(spec.env ?? {})
      .map(([k, v]) => `${k}=${shellQuote(v)}`)
      .join(" ");
    const argv = spec.argv.map(shellQuote).join(" ");
    const command = envPrefix ? `${envPrefix} ${argv}` : argv;
    try {
      await run(
        this.cli,
        ["terminal", "send-keys", created.id, command, "Enter"],
        { timeout: COMMAND_TIMEOUT_MS },
      );
    } catch (err) {
      // The tab exists but never got its command typed into it — that
      // isn't the "open this session" the caller asked for, so report
      // failure even though a (useless) blank terminal is now sitting
      // there. Matches OpenTabResult's contract: error only rides ok:false.
      return { ok: false, error: (err as Error).message };
    }
    return { ok: true };
  }
}

export const paseoCandidate: TerminalHostCandidate = {
  id: "paseo",
  paneScopedEnv: PASEO_PANE_SCOPED_ENV,
  detect,
  create: () => new PaseoHost(process.env),
};
