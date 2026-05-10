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
}

export function formatEvent(event: RenderEvent): FormattedLine[] {
  switch (event.kind) {
    case "user-text":
      return formatBlock(event.text, "▎ ", "user", undefined, event.sentBy);
    case "agent-text":
      return formatBlock(event.text, "  ", "agent");
    case "agent-thought":
      return formatBlock(event.text, "· ", "thought", "thought");
    case "tool-call":
      return formatToolCall(event);
    case "tool-call-update":
      return formatToolCallUpdate(event);
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
): FormattedLine[] {
  const lines = text.split("\n");
  const out: FormattedLine[] = [];
  if (sentBy) {
    out.push({
      prefix,
      prefixStyle: prefixStyle ?? bodyStyle,
      body: `(${sentBy})`,
      bodyStyle: "dim",
    });
  }
  for (const line of lines) {
    out.push({
      prefix,
      prefixStyle: prefixStyle ?? bodyStyle,
      body: line,
      bodyStyle,
    });
  }
  return out;
}

function formatToolCall(event: Extract<RenderEvent, { kind: "tool-call" }>): FormattedLine[] {
  const status = event.status ?? "pending";
  const statusStyle = toolStatusStyle(status);
  return [
    {
      prefix: "⚒ ",
      prefixStyle: "tool",
      body: `${event.title}  [${status}]`,
      bodyStyle: statusStyle,
    },
  ];
}

function formatToolCallUpdate(
  event: Extract<RenderEvent, { kind: "tool-call-update" }>,
): FormattedLine[] {
  const status = event.status ?? "updated";
  const title = event.title ?? event.toolCallId;
  return [
    {
      prefix: "  ",
      body: `${title} → ${status}`,
      bodyStyle: toolStatusStyle(status),
    },
  ];
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
    default:
      return "tool-status-pending";
  }
}
