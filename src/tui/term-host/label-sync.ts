// Keep the host's TAB label following the hydra session title.
//
// This is additive rather than redundant with report(): the snapshot's
// `title` drives whatever the host shows for the PANE, while the tab label is
// what shows in the tab bar. For a tab created by ^t, the tab bar is exactly
// where you want the session name.
//
// All of the policy lives here, backend-independent. The adapter supplies
// only three primitives — readLabel / writeLabel / isAutoLabel — because the
// hard part isn't the transport, it's knowing when you're allowed to write.
//
// ---------------------------------------------------------------------
// THE TWO GUARDS
//
// (1) Never stomp a label the user chose. Renaming unconditionally silently
//     outranks the human's own rename with no way for them to make it
//     stick. So we read the tab first and only write when the current label
//     is one the host auto-generated (adapter's isAutoLabel) or one we
//     ourselves last wrote.
//
// (2) Only when the tab holds exactly one pane. In a split tab, no single
//     pane's session has any claim to name the whole tab — and the other
//     pane may be a second hydra doing the same thing, which would give two
//     writers fighting over one label.
//
// Both guards are re-evaluated on every rename, not cached: the user can
// rename the tab, or split it, at any point mid-session.
//
// Both also depend on being able to READ the label back, which is why
// caps.label requires read and write together. A host that can only write
// (zellij) gets no label sync at all rather than a best-effort version that
// would stomp names.
// ---------------------------------------------------------------------

import { terminalHost } from "./index.js";

/**
 * Env var carrying the tab label hydra assigned when it created the tab.
 *
 * Read below to establish ownership across a process boundary. Only
 * meaningful while it still matches the tab's actual label — a human
 * renaming over it takes ownership straight back.
 *
 * Host-agnostic on purpose: it describes hydra's own claim, not any
 * particular host's tab. Listed in core/scrub-env.ts, since it names one
 * specific tab and so must not outlive the pane.
 */
export const TAB_LABEL_ENV = "HYDRA_TAB_LABEL";

/**
 * What the tab is called while the picker is up.
 *
 * Deliberately not a name a human would plausibly type. It used to be
 * plain "hydra", which collided with the ownership guard in a way that
 * bricked tabs: restoreTabLabel puts the real label back on a clean exit,
 * but a process killed with the picker up — a crash, or a restart to pick
 * up a new build — leaves the tab holding this string. The next process
 * starts with `applied` null, sees a label that is neither auto-shaped nor
 * one it remembers writing, and concludes a human named the tab. That tab
 * then never syncs its title again, with no indication why.
 *
 * The marker makes hydra's own leftovers self-identifying, so
 * adoptExistingLabel can reclaim them without ever touching a real name.
 */
export const TRANSIENT_TAB_LABEL = "hydra…";

/**
 * Longest tab label hydra will write.
 *
 * Tab bars divide a fixed width between every tab, so one long label
 * doesn't just clip itself, it squeezes its neighbours. Session titles
 * are frequently the user's opening message and run to hundreds of
 * characters, which is unusable in a tab bar.
 *
 * Same 40 as the prompt-derived labels in open.ts, which have always
 * been truncated for exactly this reason — session titles were simply
 * never routed through the same policy.
 */
export const TAB_LABEL_MAX = 40;

/**
 * Reduce arbitrary text to something a tab bar can render.
 *
 * First line only: a pasted multi-line prompt can become a session
 * title, and a newline in a tab label corrupts the bar rather than
 * wrapping. Then truncate, counting the ellipsis toward the budget so
 * the result is never longer than TAB_LABEL_MAX.
 */
export function tabLabelFor(text: string): string {
  const first = text.split("\n")[0]?.trim() ?? "";
  if (first.length <= TAB_LABEL_MAX) {
    return first;
  }
  return `${first.slice(0, TAB_LABEL_MAX - 1).trimEnd()}…`;
}

// The label we last successfully wrote. This is what makes guard (1) stable
// across the many title updates in one session: after our first rename the
// label is no longer auto-generated, so without this we would rename exactly
// once and then treat our own label as user-owned forever.
let applied: string | null = null;
let adoptChecked = false;

// A tab that hydra created via ^t arrives already labelled, by a DIFFERENT
// hydra process. `applied` starts null there, so guard (1) would see a
// non-auto label nobody remembers writing and hand the tab to a human who
// doesn't exist. The creating process passes the label it set through the
// pane env; matching it is what transfers ownership across the process
// boundary.
//
// Matching rather than merely trusting the variable's presence is the point:
// if the user has renamed the tab since it was created, the label no longer
// matches and ownership stays with them.
function adoptExistingLabel(current: string): void {
  if (adoptChecked) {
    return;
  }
  adoptChecked = true;
  const fromEnv = process.env[TAB_LABEL_ENV];
  if (fromEnv && fromEnv === current) {
    applied = current;
    // Adoption means the tab already holds a session-derived label, so it
    // counts as the last real one — that's what a transient label has to be
    // able to fall back to.
    lastReal = current;
    adopted = true;
    return;
  }
  if (current === TRANSIENT_TAB_LABEL) {
    // Our own leftover from a process that died with the picker up. Claim
    // it so the guard lets us write over it. `lastReal` stays null on
    // purpose: a transient label is not a real one to fall back to, and
    // marking `adopted` keeps exit restoring to the next real title rather
    // than putting this marker back.
    applied = current;
    adopted = true;
  }
}

// True when the label we own came from the environment rather than from a
// rename of ours. Redirects the exit-time restore: the "original" label of a
// tab hydra created for this session is a snapshot of an older session title,
// so such a tab is restored to the last real session label instead.
let adopted = false;

// The last non-transient label we wrote (or adopted) — i.e. one derived from
// a session rather than from a passing UI state like the picker.
//
// Exists because a transient label must never be what the tab is left
// holding. Without it, quitting the TUI straight out of the picker (the
// normal way to quit) would leave the tab named after the picker forever on a
// ^t-created tab, since those skip the restore-to-original path.
let lastReal: string | null = null;

// The label the tab had before we first touched it, so exit can put it back.
// Left null when we never renamed, which is also the "nothing to restore"
// signal.
let original: string | null = null;

// Coalesce: while a round trip is in flight, later titles overwrite this
// rather than queueing. Only the newest title is worth writing.
let pending: { label: string; transient: boolean } | null = null;
let inFlight = false;

/** The active host, but only when it can actually do label sync. */
function labelHost(): {
  readLabel: NonNullable<import("./types.js").TerminalHost["readLabel"]>;
  writeLabel: NonNullable<import("./types.js").TerminalHost["writeLabel"]>;
  isAutoLabel: NonNullable<import("./types.js").TerminalHost["isAutoLabel"]>;
} | null {
  const host = terminalHost();
  if (
    !host ||
    !host.caps.label ||
    !host.readLabel ||
    !host.writeLabel ||
    !host.isAutoLabel
  ) {
    return null;
  }
  return {
    readLabel: host.readLabel.bind(host),
    writeLabel: host.writeLabel.bind(host),
    isAutoLabel: host.isAutoLabel.bind(host),
  };
}

/**
 * Whether we may overwrite `current` with a session title.
 *
 * `auto` is the host's authoritative answer when it has one; otherwise fall
 * back to the adapter's naming-convention guess.
 */
export function mayRenameTab(
  current: string,
  paneCount: number,
  isAutoLabel: (label: string) => boolean,
  auto?: boolean,
): boolean {
  if (paneCount !== 1) {
    return false;
  }
  if (current === applied) {
    return true;
  }
  return auto ?? isAutoLabel(current);
}

async function drain(): Promise<void> {
  while (pending !== null) {
    const host = labelHost();
    if (!host) {
      pending = null;
      return;
    }
    const want = pending;
    pending = null;
    if (want.label === applied) {
      continue;
    }
    let info: Awaited<ReturnType<typeof host.readLabel>>;
    try {
      info = await host.readLabel();
    } catch {
      return;
    }
    if (!info) {
      continue;
    }
    adoptExistingLabel(info.label);
    if (!mayRenameTab(info.label, info.paneCount, host.isAutoLabel, info.auto)) {
      // Not ours to write. Drop the pending title rather than retrying: the
      // user owns this label now, and the next title change will ask again
      // anyway.
      continue;
    }
    try {
      if (!(await host.writeLabel(want.label))) {
        return;
      }
    } catch {
      return;
    }
    if (original === null) {
      original = info.label;
    }
    applied = want.label;
    if (!want.transient) {
      lastReal = want.label;
    }
  }
}

/**
 * Point the tab label at `title`.
 *
 * No-op when the host can't do labels, when the title is empty, or when
 * either guard says the label isn't ours.
 *
 * `transient` marks a label that describes a passing UI state rather than a
 * session (the picker). Such a label is written like any other but can never
 * be what the tab is left holding on exit.
 *
 * Fire-and-forget by design — this is cosmetic, and the caller is a
 * synchronous render funnel.
 */
export function syncTabLabel(
  title: string | null | undefined,
  opts: { transient?: boolean } = {},
): void {
  if (!labelHost()) {
    return;
  }
  // Truncate here rather than at the call sites: this is the only way a
  // tab label is written, so capping it here means no caller can forget.
  const want = title ? tabLabelFor(title) : "";
  if (!want) {
    return;
  }
  pending = { label: want, transient: opts.transient === true };
  if (inFlight) {
    return;
  }
  inFlight = true;
  void drain().finally(() => {
    inFlight = false;
    // A title that arrived while the last drain was finishing would
    // otherwise sit unsent until the next change.
    const again = pending;
    if (again !== null && again.label !== applied) {
      syncTabLabel(again.label, { transient: again.transient });
    }
  });
}

/**
 * Put the tab label back on TUI exit.
 *
 * Awaited rather than fire-and-forget: the process is about to leave, and an
 * unflushed write would just be dropped. Skipped when we never renamed, and
 * when the user has since renamed over us.
 */
export async function restoreTabLabel(): Promise<void> {
  const host = labelHost();
  pending = null;
  // A tab hydra created for this session goes back to the last real session
  // label, not to `original` (a stale title snapshot). Any other tab goes
  // back to whatever it was called before we touched it. Either way the tab
  // must not be left holding a transient label.
  const back = adopted ? lastReal : original;
  if (!host || back === null || applied === null) {
    return;
  }
  // Already correct — the common exit-from-a-session case on an adopted tab.
  // Nothing to undo, so don't spend a round trip saying so.
  if (back === applied) {
    return;
  }
  const ours = applied;
  original = null;
  applied = null;
  lastReal = null;
  try {
    const info = await host.readLabel();
    if (!info || info.label !== ours) {
      return;
    }
    await host.writeLabel(back);
  } catch {
    // Cosmetic cleanup on the way out; nothing useful to do here.
  }
}

/** The env a ^t-created pane needs so it knows it owns its tab label. */
export function tabLabelOwnershipEnv(label: string): Record<string, string> {
  return { [TAB_LABEL_ENV]: label };
}

export function __resetLabelSyncForTests(): void {
  applied = null;
  original = null;
  pending = null;
  inFlight = false;
  adopted = false;
  adoptChecked = false;
  lastReal = null;
}
