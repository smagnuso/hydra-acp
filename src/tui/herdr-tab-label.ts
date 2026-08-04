// Keep the herdr TAB label following the hydra session title.
//
// This is additive rather than redundant with the reporter in herdr.ts.
// The `title` we report via pane.report_metadata drives the *pane* label
// (what the sidebar row shows); the tab label is what shows in the tab
// bar. For a tab created by ^t, the tab bar is exactly where you want the
// session name.
//
// It lives apart from herdr.ts because it needs a request/response round
// trip (read the tab, decide, then maybe write) rather than the reporter's
// fire-and-forget frames, and apart from herdr-open.ts because that module
// is about launching tabs, not maintaining them.
//
// ---------------------------------------------------------------------
// WHY THE TWO GUARDS
//
// (1) Never stomp a label the user chose. Renaming unconditionally is the
//     same mistake as setting herdr's `display_agent`: it silently
//     outranks the human's own `tab.rename`, and there is no way for them
//     to make it stick. So we read the tab first and only write when the
//     current label is one herdr auto-generated (its default is the tab
//     *number*, e.g. "1") or one we ourselves last wrote.
//
// (2) Only when the tab holds exactly one pane. In a split tab, no single
//     pane's session has any claim to name the whole tab — and the other
//     pane may be a second hydra doing the same thing, which would give
//     two writers fighting over one label.
//
// Both guards are re-evaluated on every rename, not cached: the user can
// rename the tab, or split it, at any point mid-session.
// ---------------------------------------------------------------------

import { TAB_LABEL_ENV, herdrRequest } from "./herdr-open.js";

// The label we last successfully wrote. This is what makes guard (1)
// stable across the many title updates in one session: after our first
// rename the label is no longer auto-generated, so without this we would
// rename exactly once and then treat our own label as user-owned forever.
//
// Seeded from the environment, not just from our own writes — see
// adoptedLabel below. Resolved lazily rather than at module load so tests
// (and any embedder) can set the variable after import.
let applied: string | null = null;
let adoptChecked = false;

// A tab that hydra created via ^t arrives already labelled, by a DIFFERENT
// hydra process. `applied` starts null there, so guard (1) would see a
// non-numeric label nobody remembers writing and hand the tab to the
// (non-existent) human. herdr-open passes the label it set through the
// pane env; matching it is what transfers ownership across the process
// boundary.
//
// Matching rather than merely trusting the variable's presence is the
// point: if the user has renamed the tab since it was created, the label
// no longer matches and ownership stays with them.
function adoptEnvLabel(current: string): void {
  if (adoptChecked) {
    return;
  }
  adoptChecked = true;
  const fromEnv = process.env[TAB_LABEL_ENV];
  if (fromEnv && fromEnv === current) {
    applied = current;
    adopted = true;
  }
}

// True when the label we own came from the environment rather than from a
// rename of ours. Suppresses the exit-time restore: the "original" label of
// a tab hydra created for this session is a snapshot of an older session
// title, which is a worse thing to leave behind than the current one.
let adopted = false;

// The label the tab had before we first touched it, so exit can put it
// back. Left null when we never renamed, which is also the "nothing to
// restore" signal.
let original: string | null = null;

// Coalesce: while a round trip is in flight, later titles overwrite this
// rather than queueing. Only the newest title is worth writing.
let pending: string | null = null;
let inFlight = false;

function tabTarget(): { tabId: string } | null {
  if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_SOCKET_PATH) {
    return null;
  }
  const tabId = process.env.HERDR_TAB_ID;
  return tabId ? { tabId } : null;
}

/**
 * Whether `label` is a herdr-generated default rather than a human's
 * choice.
 *
 * herdr's default tab label is the tab number rendered as a string, so a
 * purely numeric label means "never named". Empty is treated the same way.
 */
export function isAutoTabLabel(label: string): boolean {
  const trimmed = label.trim();
  return trimmed.length === 0 || /^[0-9]+$/.test(trimmed);
}

/** Whether we may overwrite `current` with a session title. */
export function mayRenameTab(current: string, paneCount: number): boolean {
  if (paneCount !== 1) {
    return false;
  }
  return isAutoTabLabel(current) || current === applied;
}

interface TabInfo {
  label: string;
  pane_count: number;
}

function parseTabInfo(reply: unknown): TabInfo | null {
  const body = reply as { result?: { tab?: unknown }; error?: unknown };
  if (!body || body.error) {
    return null;
  }
  const tab = body.result?.tab as { label?: unknown; pane_count?: unknown } | undefined;
  if (!tab || typeof tab.label !== "string" || typeof tab.pane_count !== "number") {
    return null;
  }
  return { label: tab.label, pane_count: tab.pane_count };
}

async function writeLabel(tabId: string, label: string): Promise<boolean> {
  const reply = (await herdrRequest("tab.rename", { tab_id: tabId, label })) as {
    error?: unknown;
  };
  return !reply?.error;
}

async function drain(tabId: string): Promise<void> {
  while (pending !== null) {
    const want = pending;
    pending = null;
    if (want === applied) {
      continue;
    }
    let info: TabInfo | null;
    try {
      info = parseTabInfo(await herdrRequest("tab.get", { tab_id: tabId }));
    } catch {
      return;
    }
    if (!info) {
      continue;
    }
    adoptEnvLabel(info.label);
    if (!mayRenameTab(info.label, info.pane_count)) {
      // Not ours to write. Drop the pending title rather than retrying:
      // the user owns this label now, and the next title change will ask
      // again anyway.
      continue;
    }
    try {
      if (!(await writeLabel(tabId, want))) {
        return;
      }
    } catch {
      return;
    }
    if (original === null) {
      original = info.label;
    }
    applied = want;
  }
}

/**
 * Point the tab label at `title`. No-op outside herdr, when the title is
 * empty, or when either guard says the label isn't ours.
 *
 * Fire-and-forget by design — this is cosmetic, and the caller is a
 * synchronous render funnel.
 */
export function syncHerdrTabLabel(title: string | null | undefined): void {
  const target = tabTarget();
  if (!target) {
    return;
  }
  const want = title?.trim();
  if (!want) {
    return;
  }
  pending = want;
  if (inFlight) {
    return;
  }
  inFlight = true;
  void drain(target.tabId).finally(() => {
    inFlight = false;
    // A title that arrived while the last drain was finishing would
    // otherwise sit unsent until the next change.
    if (pending !== null && pending !== applied) {
      syncHerdrTabLabel(pending);
    }
  });
}

/**
 * Put the tab label back the way we found it, on TUI exit.
 *
 * Awaited rather than fire-and-forget: the process is about to leave, and
 * an unflushed socket write would just be dropped. Skipped entirely when
 * we never renamed, and when the user has since renamed over us.
 */
export async function restoreHerdrTabLabel(): Promise<void> {
  const target = tabTarget();
  pending = null;
  if (!target || adopted || original === null || applied === null) {
    return;
  }
  const back = original;
  const ours = applied;
  original = null;
  applied = null;
  try {
    const info = parseTabInfo(await herdrRequest("tab.get", { tab_id: target.tabId }));
    if (!info || info.label !== ours) {
      return;
    }
    await writeLabel(target.tabId, back);
  } catch {
    // Cosmetic cleanup on the way out; nothing useful to do here.
  }
}

export function __resetHerdrTabLabelForTests(): void {
  applied = null;
  original = null;
  pending = null;
  inFlight = false;
  adopted = false;
  adoptChecked = false;
}
