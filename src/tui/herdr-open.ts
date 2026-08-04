// Open a hydra session in a new herdr tab.
//
// This is the one place hydra *drives* herdr rather than reporting to it,
// so it lives apart from the reporter in herdr.ts: it needs a
// request/response round trip (the caller shows the outcome), and it must
// work without initHerdrReporting() having run, since the picker is
// reachable from paths that never start the reporter.
//
// Why it's a natural fit rather than a hack: the hydra daemon owns the
// agent process and multi-client attach is the normal case, so "show this
// session in another pane" is what hydra is for. herdr just supplies the
// window management.
//
// ---------------------------------------------------------------------
// WHY layout.apply AND NOT tab.create / pane.split
//
// Neither tab.create nor pane.split can launch a command — their params
// are only cwd/env/focus/label. (herdr's own D#1695, "let pane.split
// launch an exact argv vector", is an open idea.) layout.apply is the only
// method that takes an argv `command`, on the pane nodes of a declarative
// tab tree.
//
// layout.apply's unit is a *tab*. Omitting `tab_id` creates a new one,
// which is what we want. Passing the current `tab_id` would be the way to
// place a pane beside the one we're in, but that path "creates the
// replacement tab first and then closes the old tab" and "does not
// preserve live PTYs, scrollback, or running processes" — i.e. it would
// kill the hydra the user is sitting in to make room. So: new tab only.
// Splits are possible inside a freshly-built tree, not against a live tab.
// ---------------------------------------------------------------------

import * as net from "node:net";

const REQUEST_TIMEOUT_MS = 5_000;

/**
 * Whether this process is running in a herdr pane.
 *
 * Resolved from the environment on every call rather than cached at
 * startup: unlike the reporter, this has no opt-in gate to piggyback on,
 * and the picker can be reached from entry points that never initialise
 * reporting.
 */
export function canOpenInHerdrTab(): boolean {
  return (
    process.env.HERDR_ENV === "1" &&
    !!process.env.HERDR_SOCKET_PATH &&
    !!process.env.HERDR_PANE_ID
  );
}

// herdr serves exactly one request per connection and then resets, so this
// opens its own socket and reads the single reply. See the note in
// herdr.ts: batching frames onto one connection silently drops everything
// after the first.
export function herdrRequest(method: string, params: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socketPath = process.env.HERDR_SOCKET_PATH;
    if (!socketPath) {
      reject(new Error("not running in herdr"));
      return;
    }
    let sock: net.Socket;
    try {
      sock = net.connect(socketPath);
    } catch (err) {
      reject(err as Error);
      return;
    }
    let buf = "";
    let settled = false;
    const finish = (err: Error | null, value?: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      sock.destroy();
      if (err) {
        reject(err);
      } else {
        resolve(value);
      }
    };
    sock.on("connect", () => {
      sock.write(`${JSON.stringify({ id: "hydra-open", method, params })}\n`);
    });
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      const nl = buf.indexOf("\n");
      const line = nl === -1 ? buf : buf.slice(0, nl);
      if (nl === -1 && line.length === 0) {
        return;
      }
      try {
        finish(null, JSON.parse(line.trim()));
      } catch {
        // Partial frame — wait for more bytes.
      }
    });
    sock.on("error", (err) => finish(err));
    sock.on("close", () => finish(new Error("herdr closed the connection")));
    sock.setTimeout(REQUEST_TIMEOUT_MS, () => finish(new Error("herdr did not respond")));
  });
}

// Entry-point basenames we're willing to relaunch. hydra ships `hydra` and
// `hydra-acp` bins, both of which resolve to dist/cli.js.
const HYDRA_ENTRY_NAMES = new Set(["cli.js", "hydra", "hydra-acp"]);

/**
 * Whether `process.argv[1]` really is hydra's entry point.
 *
 * This check is not paranoia, it is load-bearing. An earlier version passed
 * `argv[1]` through unvalidated, which is correct whenever the process is
 * hydra — but when it isn't, "launch hydra in a new tab" becomes "launch
 * whatever started me in a new tab". If that thing in turn opens a tab, the
 * result is self-replicating: each new pane re-runs the caller, which opens
 * another pane. Verified the hard way — it produced ~97 tabs before it
 * burned out.
 *
 * The blast radius is what makes this worth guarding rather than assuming.
 * A wrong-but-inert argv would just fail to start; a wrong-and-recursive
 * one takes the user's whole workspace with it.
 */
function hydraEntryPoint(): string | null {
  const entry = process.argv[1];
  if (!entry) {
    return null;
  }
  const base = entry.replace(/\\/g, "/").split("/").pop() ?? "";
  return HYDRA_ENTRY_NAMES.has(base) ? entry : null;
}

/**
 * The argv herdr should launch.
 *
 * Prefers this process's own entry point so the new tab runs the same build
 * as the tab that spawned it — which matters on a linked or checked-out dev
 * build, where PATH `hydra` can be a different version. Falls back to
 * `hydra` on PATH when we can't confirm what we're running from.
 *
 * herdr launches argv directly with no shell, so there's no quoting to get
 * wrong, and `tui` is named explicitly rather than relying on the bare-verb
 * default.
 */
function hydraArgv(args: string[]): string[] {
  const entry = hydraEntryPoint();
  const base = entry ? [process.execPath, entry] : ["hydra"];
  return [...base, "tui", ...args];
}

export interface OpenInHerdrTabRequest {
  sessionId: string;
  /** Session title, used as the tab label. Falls back to the session id. */
  title?: string | undefined;
  /** Session cwd, so the pane (and anything split off it) starts there. */
  cwd?: string | undefined;
}

export interface OpenInHerdrTabResult {
  ok: boolean;
  /** Present when ok is false. */
  error?: string;
}

/**
 * Create a new herdr tab attached to `sessionId`.
 *
 * The new pane inherits herdr's `HERDR_*` env automatically, so the hydra
 * it launches reports its own state and cwd to herdr with no extra work.
 */
export async function openSessionInHerdrTab(
  req: OpenInHerdrTabRequest,
): Promise<OpenInHerdrTabResult> {
  return applyTab({
    label: req.title?.trim() || req.sessionId,
    argv: ["--session", req.sessionId],
    cwd: req.cwd,
  });
}

export interface NewSessionInHerdrTabRequest {
  /** Working directory for the new session. */
  cwd?: string | undefined;
  /** Agent id, as picked in the composer. */
  agentId?: string | undefined;
  /** Model id, as picked in the composer. */
  model?: string | undefined;
  /** Composer text to fire as the new session's first turn. */
  prompt?: string | undefined;
}

/**
 * Create a new herdr tab running a fresh hydra session.
 *
 * `prompt` rides along as `--prompt`, which with `--new` fires as the first
 * turn the moment the session attaches. herdr launches argv directly with
 * no shell, so arbitrary text — newlines, quotes, backticks — needs no
 * escaping and cannot be reinterpreted.
 */
export async function openNewSessionInHerdrTab(
  req: NewSessionInHerdrTabRequest = {},
): Promise<OpenInHerdrTabResult> {
  // --new is what stops the new pane from re-entering the picker (or
  // reattaching to a recent session for the cwd) and instead going straight
  // to a fresh one.
  const argv = ["--new"];
  // --cwd as well as the pane cwd: the pane cwd is what herdr spawns in and
  // is silently dropped when non-absolute, whereas --cwd is what hydra
  // records on the session. Only one of them is load-bearing for the
  // session identity, so pass it explicitly.
  if (req.cwd) {
    argv.push("--cwd", req.cwd);
  }
  if (req.agentId) {
    argv.push("--agent", req.agentId);
  }
  if (req.model) {
    argv.push("--model", req.model);
  }
  // Last, so the long free-text argument doesn't sit between flag pairs in
  // a `ps` listing.
  const prompt = req.prompt?.trim();
  if (prompt) {
    argv.push("--prompt", prompt);
  }
  // The prompt's first line makes a better tab label than "new session",
  // and it's what the pane will be titled once the session gets a real
  // title anyway.
  return applyTab({ label: labelForPrompt(prompt), argv, cwd: req.cwd });
}

/**
 * Env var carrying the tab label hydra itself assigned when it created the
 * tab. Read by herdr-tab-label.ts to establish ownership across the process
 * boundary. Only meaningful while it still matches the tab's actual label —
 * a human renaming over it takes ownership straight back.
 */
export const TAB_LABEL_ENV = "HYDRA_HERDR_TAB_LABEL";

const PROMPT_LABEL_MAX = 40;

/**
 * A tab label derived from the prompt: first line, truncated.
 *
 * Only the first line, because a pasted multi-line prompt would otherwise
 * put newlines in a tab label. Truncated because the tab bar is narrow and
 * herdr renders whatever it's given.
 */
export function labelForPrompt(prompt: string | undefined): string {
  const first = prompt?.split("\n")[0]?.trim();
  if (!first) {
    return "new session";
  }
  return first.length > PROMPT_LABEL_MAX
    ? `${first.slice(0, PROMPT_LABEL_MAX - 1)}…`
    : first;
}

async function applyTab(spec: {
  label: string;
  argv: string[];
  cwd?: string | undefined;
}): Promise<OpenInHerdrTabResult> {
  if (!canOpenInHerdrTab()) {
    return { ok: false, error: "not running in herdr" };
  }
  const label = spec.label;
  const pane: Record<string, unknown> = {
    type: "pane",
    label,
    command: hydraArgv(spec.argv),
    // Hand the child the tab label we're about to set, so it knows the
    // label is HYDRA's and not a human's and may keep it in sync with the
    // session title.
    //
    // Without this the tab-label guard misfires exactly where the feature
    // matters most: a ^t-created tab comes up already named after the
    // session, and the hydra in it — a different process, with no memory
    // of the layout.apply that named it — sees a non-numeric label it
    // doesn't remember writing and correctly concludes "a human named
    // this, leave it alone". Result: the one kind of tab we definitely own
    // is the one kind that never follows the title. Ownership can't be
    // inferred from the label, so it has to be passed.
    env: { [TAB_LABEL_ENV]: label },
  };
  // Only send cwd when it's usable — herdr validates absolute + is_dir and
  // would otherwise reject the whole call rather than just ignoring it.
  if (spec.cwd && spec.cwd.startsWith("/")) {
    pane.cwd = spec.cwd;
  }
  const params: Record<string, unknown> = {
    // tab_id deliberately omitted — that's what makes this a new tab
    // rather than a destructive replacement of the current one.
    tab_label: label,
    focus: true,
    root: pane,
  };
  // Scope to this pane's workspace when herdr told us which one; otherwise
  // let herdr fall back to the active workspace.
  if (process.env.HERDR_WORKSPACE_ID) {
    params.workspace_id = process.env.HERDR_WORKSPACE_ID;
  }
  let reply: unknown;
  try {
    reply = await herdrRequest("layout.apply", params);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  const body = reply as { error?: { code?: string; message?: string } };
  if (body?.error) {
    return {
      ok: false,
      error: body.error.message || body.error.code || "herdr rejected the request",
    };
  }
  return { ok: true };
}
