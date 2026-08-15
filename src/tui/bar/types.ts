import type { BarSideConfig } from "../../core/config.js";

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

export interface BannerInfo {
  status: string;
  currentMode: string | undefined;
  hint: string;
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
}

/** Resolved slot contents for all three chrome rows. */
export interface BarLayoutConfig {
  composer: {
    top: { left: BarSideConfig; right: BarSideConfig };
    bottom: { left: BarSideConfig; right: BarSideConfig };
  };
  sessionbar: { left: BarSideConfig; right: BarSideConfig };
}
