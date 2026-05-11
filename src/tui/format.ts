// Maps RenderEvents to FormattedLines. Pure (no I/O, no terminal-kit) so the
// screen layer is the only place that knows how to translate Style names
// into ANSI/terminal-kit calls.

import type { RenderEvent } from "./render-update.js";

export type Style =
  | "user"
  | "agent"
  | "thought"
  | "tool"
  | "tool-status-ok"
  | "tool-status-fail"
  | "tool-status-pending"
  | "tool-status-running"
  | "tool-status-cancelled"
  | "plan"
  | "plan-done"
  | "plan-pending"
  | "system"
  | "info"
  | "dim";

export interface FormattedLine {
  prefix?: string;
  prefixStyle?: Style;
  body: string;
  bodyStyle?: Style;
  // When set, the screen layer pads the body with spaces (using bodyStyle)
  // to fill the remainder of the terminal row, so a background-colored
  // style extends as a continuous stripe across the whole line. Used to
  // visually band user turns in scrollback.
  fillRow?: boolean;
}

export function formatEvent(event: RenderEvent): FormattedLine[] {
  switch (event.kind) {
    case "user-text":
      return formatBlock(event.text, "▎ ", "user", undefined, event.sentBy, true);
    case "agent-text":
      return formatBlock(event.text, "  ", "agent");
    case "agent-thought":
      return formatBlock(event.text, "· ", "thought", "thought");
    case "tool-call":
    case "tool-call-update":
      // Tool calls render as a single mutating line keyed by toolCallId —
      // see formatToolLine + Screen.upsertLine. app.ts intercepts these
      // events before reaching here, so this case is unreachable in
      // production but kept exhaustive for the switch.
      return [];
    case "plan":
      return formatPlan(event);
    case "mode-changed":
      return [
        {
          prefix: "» ",
          prefixStyle: "info",
          body: `mode: ${event.mode}`,
          bodyStyle: "info",
        },
      ];
    case "model-changed":
      return [
        {
          prefix: "» ",
          prefixStyle: "info",
          body: `model: ${event.model}`,
          bodyStyle: "info",
        },
      ];
    case "turn-complete":
      // Boundary is rendered as a blank separator only — see the
      // ensureSeparator() call in app.ts after a turn-complete event.
      return [];
    case "usage-update":
      // Usage is rendered in the header by the app, not in scrollback.
      return [];
    case "available-commands":
      // Commands are stored as completion data, not rendered to scrollback.
      return [];
    case "unknown":
      // Silently drop notification kinds we don't have a styled rendering
      // for (available_commands_update, config_option_update, etc.). The
      // mapper still produces the event, so a debug mode could surface it
      // in the future.
      return [];
  }
}

function formatBlock(
  text: string,
  prefix: string,
  bodyStyle: Style,
  prefixStyle?: Style,
  sentBy?: string,
  fillRow?: boolean,
): FormattedLine[] {
  const lines = text.split("\n");
  const out: FormattedLine[] = [];
  if (sentBy) {
    out.push({
      prefix: "↳ ",
      prefixStyle: "dim",
      body: `from ${sentBy}`,
      bodyStyle: "dim",
    });
  }
  for (const line of lines) {
    const entry: FormattedLine = {
      prefix,
      prefixStyle: prefixStyle ?? bodyStyle,
      body: line,
      bodyStyle,
    };
    if (fillRow) {
      entry.fillRow = true;
    }
    out.push(entry);
  }
  return out;
}

export interface ToolLineState {
  // The title from the initial `tool_call` event — usually the tool's
  // generic name (e.g. "Terminal", "Read File").
  initialTitle: string;
  // The most recent title from a `tool_call_update` event, if one carried
  // a refined label (e.g. the actual command, the file path). Falls back
  // to initialTitle.
  latestTitle: string;
  status: string;
}

// Render the single line that represents a tool call. Combines the initial
// (generic) title with the refined update title when they add information,
// and folds them into one when the refinement subsumes the initial label.
// A single status icon sits between the ⚒ gutter and the title so a stack
// of tool calls scans as a clean column without burning horizontal space
// on text labels. Color + weight encode state: dim while queued, bold
// while running, normal-weight when done.
export function formatToolLine(state: ToolLineState): FormattedLine {
  const initial = state.initialTitle;
  const latest = state.latestTitle;
  const initialLc = initial.toLowerCase();
  const latestLc = latest.toLowerCase();
  let title: string;
  if (latest === initial || latestLc.includes(initialLc)) {
    title = latest;
  } else if (initialLc.includes(latestLc)) {
    title = initial;
  } else {
    title = `${initial} · ${latest}`;
  }
  return {
    prefix: "⚒ ",
    prefixStyle: "tool",
    body: `${toolStatusIcon(state.status)} ${title}`,
    bodyStyle: toolStatusStyle(state.status),
  };
}

function toolStatusIcon(status: string): string {
  switch (status) {
    case "completed":
    case "succeeded":
    case "ok":
      return "✓";
    case "failed":
    case "error":
      return "✗";
    case "rejected":
      return "⊘";
    case "cancelled":
      return "⊝";
    case "in_progress":
    case "running":
    case "updated":
    case "pending":
    default:
      // Same spinner glyph for queued vs. running — bodyStyle distinguishes
      // them visually (dim vs. bold).
      return "◐";
  }
}

function formatPlan(event: Extract<RenderEvent, { kind: "plan" }>): FormattedLine[] {
  if (event.entries.length === 0) {
    return [
      {
        prefix: "▣ ",
        prefixStyle: "plan",
        body: "(empty plan)",
        bodyStyle: "dim",
      },
    ];
  }
  const lines: FormattedLine[] = [
    { prefix: "▣ ", prefixStyle: "plan", body: "Plan", bodyStyle: "plan" },
  ];
  for (const entry of event.entries) {
    const status = entry.status ?? "pending";
    const marker =
      status === "completed"
        ? "[x]"
        : status === "in_progress"
          ? "[~]"
          : "[ ]";
    const style: Style =
      status === "completed"
        ? "plan-done"
        : status === "in_progress"
          ? "plan"
          : "plan-pending";
    lines.push({
      prefix: "  ",
      body: `${marker} ${entry.content}`,
      bodyStyle: style,
    });
  }
  return lines;
}

function toolStatusStyle(status: string): Style {
  switch (status) {
    case "completed":
    case "succeeded":
    case "ok":
      return "tool-status-ok";
    case "failed":
    case "error":
    case "rejected":
      return "tool-status-fail";
    case "in_progress":
    case "running":
    case "updated":
      return "tool-status-running";
    case "cancelled":
      return "tool-status-cancelled";
    default:
      // pending / unknown — the "waiting" state
      return "tool-status-pending";
  }
}
