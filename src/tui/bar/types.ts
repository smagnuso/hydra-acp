import type { BarSideConfig } from "../../core/config.js";
import type { ChromeAction } from "../chrome-action.js";

// Data the chrome rows render. Lives here rather than in screen.ts so
// the field registry can import it without a cycle (screen.ts imports
// the registry).

export interface UsageState {
  used?: number;
  size?: number;
  costAmount?: number;
  costCurrency?: string;
}

/**
 * Everything the bar fields know about the current session.
 *
 * Named SessionInfo, not SessionbarState: it feeds all three chrome
 * rows, not just the sessionbar, and `sessionbar` now names a config
 * slot.
 */
export interface SessionInfo {
  agent: string;
  // ALWAYS a real absolute path, never a pre-formatted display string.
  // The cwd field's double-click hands this to the open command, so
  // formatting it upstream silently turns the gesture into an attempt to
  // open a directory that does not exist.
  cwd: string;
  // Set while the session is isolated. Kept as separate state rather than
  // folded into `cwd` so the field can compose the display text while
  // both directories remain independently openable: the path names the
  // project, the label names the workspace, and each opens what it says.
  // `path` is the workspace, `sourceCwd` the project it derives from.
  // Note `cwd` above stays the WORKSPACE while isolated: it is what
  // relative-token double-click resolution resolves against, so it has to
  // remain the directory the agent is actually in.
  workspace?: { label: string; path: string; sourceCwd: string };
  sessionId: string;
  title?: string;
  usage?: UsageState;
  // Last known model id, rendered alongside the agent. Kept separate
  // from `agent` so the TUI can update it independently when
  // current_model_update arrives mid-session.
  model?: string;
}

/**
 * One entry on the composer's help-hint row.
 *
 * Structured rather than " · "-joined prose so adding an entry is a
 * single table row. The prose form needed a substring matcher to recover
 * which effect each chunk fired, and a chunk whose wording drifted
 * silently went inert.
 */
export interface HintItem {
  /** Hit-region id, and what bannerHitAt reports. */
  id: string;
  label: string;
  action: ChromeAction;
}

// Leftmost sheds last (see helpHintGroups), so this is also the order of
// usefulness on a narrow terminal. `mode` carries the current mode as a
// suffix when there is one.
export const DEFAULT_HINT_ITEMS: readonly HintItem[] = [
  { id: "mode", label: "⇧⇥ mode", action: "toggle-mode" },
  { id: "options", label: "⌃O options", action: "toggle-options" },
  { id: "pick", label: "⌃P pick", action: "switch-session" },
  { id: "guide", label: "⌃G guide", action: "show-help" },
  { id: "detach", label: "⌃D detach", action: "detach" },
];

export interface BannerInfo {
  status: string;
  currentMode: string | undefined;
  hint: readonly HintItem[];
  /**
   * Set once this session has sent enough prompts that the help hints
   * have done their onboarding job, at which point helpHint resolves to
   * nothing and the bottom rule paints as an unbroken line. Computed in
   * app.ts from tui.composer.hintTurns against the prompt history.
   */
  hintsExhausted?: boolean;
  queued: number;
  elapsedMs?: number;
  stalled?: boolean;
  // Epoch ms when the oldest still-armed background task was armed, or
  // undefined when none are. A modifier on `ready` rather than a status of
  // its own: the agent really is idle and really will take a prompt, it
  // just also has a job running that can restart it. Drives the "Running"
  // label and clocks its elapsed from the job's start.
  armedSince?: number;
}

export interface TransientInfo {
  text: string;
  kind: "search" | "notify" | "synthesis" | "compaction" | "workspace";
}

/** Everything a field resolver may read. */
export interface FieldContext {
  /**
   * Which surface is being rendered. The btw overlay's frame reuses the
   * composer.top slot config against overlay-scoped data, so a handful
   * of fields adapt: `sessionId` becomes a jump-to-fork link there
   * rather than a copy target.
   */
  scope: "session" | "btw";
  /**
   * Replaces the text of the `status` field. The btw frame uses it for
   * "By the way"; the status *token* still tracks the real state.
   */
  statusLabel?: string;
  session: SessionInfo;
  banner: BannerInfo;
  scrollOffset: number;
  transient: TransientInfo | null;
  /**
   * Id of the hit region under the pointer, or null. Fields do not
   * normally need this: drawBar applies the hover token swap generically
   * from the placed chunks' ids.
   */
  hovered: string | null;
  /**
   * Sticky override that brings collapsed help hints back: the pointer is
   * somewhere on the composer's bottom rule, or an unbound Ctrl chord was
   * pressed. Deliberately NOT derived from `hovered` — the collapsed
   * state has no chunk to hover, and the pad columns between the fill and
   * the first chunk carry no id, so a hover-derived reveal oscillates
   * there.
   */
  hintsRevealed: boolean;
}

/** Resolved slot contents for all three chrome rows. */
export interface BarLayoutConfig {
  composer: {
    top: { left: BarSideConfig; right: BarSideConfig };
    bottom: { left: BarSideConfig; right: BarSideConfig };
  };
  sessionbar: { left: BarSideConfig; right: BarSideConfig };
}
