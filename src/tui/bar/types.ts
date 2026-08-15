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
  cwd: string;
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
