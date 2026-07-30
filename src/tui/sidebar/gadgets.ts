// The built-in sidebar gadgets.
//
// Every gadget is a pure function of the snapshot. Rules of the road:
//   - relevant() must be cheap and side-effect free; false means the
//     gadget contributes zero rows (no header, no separator).
//   - versionKey() must include every snapshot field render() reads,
//     quantized to what is actually visible (whole seconds, not ms), so
//     the memo cache in registry.ts doesn't churn on invisible changes.
//   - render() must not exceed ctx.width cells per row.

import type { FormattedLine } from "../format.js";
import type {
  Gadget,
  SidebarContext,
  SidebarLine,
  SidebarSnapshot,
} from "./types.js";

// Compact duration: 45s, 3m 20s, 1h 04m. Deliberately not shared with
// format.ts formatElapsed — that one targets the separator's wider
// budget and spells things out more.
export function shortDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) {
    return `${total}s`;
  }
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  if (mins < 60) {
    return `${mins}m ${String(secs).padStart(2, "0")}s`;
  }
  const hours = Math.floor(mins / 60);
  return `${hours}h ${String(mins % 60).padStart(2, "0")}m`;
}

export function compactCount(n: number): string {
  if (n < 1000) {
    return String(n);
  }
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k < 10 ? k.toFixed(1) : Math.round(k)}K`;
  }
  return `${(n / 1_000_000).toFixed(1)}M`;
}

// Unicode eighths bar. Fractional fill uses partial blocks so a 20-cell
// bar still moves visibly on a 1% context change.
export function meterBar(fraction: number, width: number): string {
  if (width <= 0) {
    return "";
  }
  const clamped = Math.max(0, Math.min(1, fraction));
  const eighths = Math.round(clamped * width * 8);
  const full = Math.floor(eighths / 8);
  const rem = eighths % 8;
  const partial = rem === 0 ? "" : "▏▎▍▌▋▊▉"[rem - 1]!;
  const filled = "█".repeat(Math.min(width, full)) + (full < width ? partial : "");
  return filled + "·".repeat(Math.max(0, width - full - (partial ? 1 : 0)));
}

function row(body: string, bodyStyle?: FormattedLine["bodyStyle"]): SidebarLine {
  return { body, bodyStyle };
}

// A label/value row where the two halves are styled independently: the
// label is dim (it's scaffolding) and the value keeps the terminal's
// default foreground.
//
// COLOUR POLICY for the sidebar: colour marks STATE, not structure. A
// running timer, a context meter filling toward its limit, a file's git
// state, a plan entry's status — those earn a colour because the colour
// carries the information. Identity strings (agent, model, mode, session
// id, branch name) do not: they read the same whatever they say, so
// colouring them only competes for attention with the rows that matter.
// The sessionbar already renders agent(model) unstyled for the same
// reason; this keeps the two surfaces consistent.
//
// Uses FormattedLine's prefix/body split so the screen layer styles each
// half on its own. The label carries the alignment padding, since
// writeFormattedLine measures the prefix and gives the body the remainder.
function fieldRow(
  label: string,
  value: string,
  ctx: SidebarContext,
): SidebarLine {
  const { cellWidth, truncate } = ctx.metrics;
  const gap = ctx.width - cellWidth(label) - cellWidth(value);
  if (gap < 1) {
    return { body: truncate(`${label} ${value}`, ctx.width), bodyStyle: "dim" };
  }
  return {
    prefix: `${label}${" ".repeat(gap)}`,
    prefixStyle: "dim",
    body: value,
  };
}

// A row that double-click opens in the configured editor. Carrying the
// path on the line (rather than re-deriving it from the rendered text)
// means truncation, basename display and disambiguation can do whatever
// reads best without breaking the click target.
function fileRow(
  body: string,
  openPath: string,
  bodyStyle?: FormattedLine["bodyStyle"],
): SidebarLine {
  return { body, bodyStyle, openPath };
}

// Right-align a value against a label on one row, filling the gap with
// spaces. Falls back to plain truncation when the pair doesn't fit.
function labelValue(
  label: string,
  value: string,
  ctx: SidebarContext,
): string {
  const { cellWidth, truncate } = ctx.metrics;
  const gap = ctx.width - cellWidth(label) - cellWidth(value);
  if (gap < 1) {
    return truncate(`${label} ${value}`, ctx.width);
  }
  return `${label}${" ".repeat(gap)}${value}`;
}

// Thinking and idle are one gadget, not two. As separate gadgets gated on
// busy/not-busy they'd be mutually exclusive for free, but every gadget
// below them would shift up or down a row at each turn boundary. One
// gadget in a fixed slot keeps the whole column stable.
export const activityGadget: Gadget = {
  id: "activity",
  relevant: () => true,
  versionKey: (s) => {
    if (s.busySince !== null) {
      return `busy:${Math.floor((s.now - s.busySince) / 1000)}`;
    }
    if (s.lastTurnEndedAt !== null) {
      return `idle:${Math.floor((s.now - s.lastTurnEndedAt) / 1000)}`;
    }
    return "fresh";
  },
  render: (s, ctx) => {
    if (s.busySince !== null) {
      return [
        row(
          labelValue("● thinking", shortDuration(s.now - s.busySince), ctx),
          "tool-status-running",
        ),
      ];
    }
    if (s.lastTurnEndedAt !== null) {
      return [
        row(
          labelValue("○ idle", shortDuration(s.now - s.lastTurnEndedAt), ctx),
          "dim",
        ),
      ];
    }
    return [row("○ ready", "dim")];
  },
};

export const contextGadget: Gadget = {
  id: "context",
  title: "context",
  relevant: (s) => s.usage.used !== undefined || s.usage.costAmount !== undefined,
  versionKey: (s, ctx) =>
    `${s.usage.used ?? ""}/${s.usage.size ?? ""}/${s.usage.costAmount ?? ""}/${ctx.width}`,
  render: (s, ctx) => {
    const lines: FormattedLine[] = [];
    const { used, size, costAmount, costCurrency } = s.usage;
    if (used !== undefined && size !== undefined && size > 0) {
      const pct = used / size;
      lines.push(
        row(
          labelValue(
            `${compactCount(used)}/${compactCount(size)}`,
            `${Math.round(pct * 100)}%`,
            ctx,
          ),
          // Kept coloured, and deliberately: this figure is the state the
          // meter below it visualises, and it turns into the warning that a
          // compaction is imminent.
          pct >= 0.9 ? "tool-status-fail" : "info",
        ),
      );
      // Over 90% of the window the bar turns into a warning — this is the
      // cue that a compaction is imminent.
      lines.push(row(meterBar(pct, ctx.width), pct >= 0.9 ? "tool-status-fail" : "plan-done"));
    } else if (used !== undefined) {
      lines.push(row(labelValue("tokens", compactCount(used), ctx), "info"));
    }
    if (costAmount !== undefined) {
      const cur = costCurrency === "USD" || costCurrency === undefined ? "$" : `${costCurrency} `;
      lines.push(row(labelValue("cost", `${cur}${costAmount.toFixed(2)}`, ctx), "dim"));
    }
    return lines;
  },
};

export const queueGadget: Gadget = {
  id: "queue",
  relevant: (s) => s.queued > 0,
  versionKey: (s, ctx) => `${s.queued}/${ctx.width}`,
  render: (s, ctx) => [
    row(
      labelValue("queued", String(s.queued), ctx),
      "tool-status-pending",
    ),
  ],
};

export const todoGadget: Gadget = {
  id: "todo",
  title: "todo",
  relevant: (s) => s.plan.length > 0,
  versionKey: (s, ctx) =>
    `${ctx.width}|` + s.plan.map((e) => `${e.status}:${e.content}`).join("\u0000"),
  render: (s, ctx) => {
    const { truncate } = ctx.metrics;
    const done = s.plan.filter((e) => e.status === "completed").length;
    const lines: FormattedLine[] = [
      row(labelValue("", `${done}/${s.plan.length}`, ctx), "dim"),
    ];
    // Every entry, not a window: the column scrolls under the wheel, so
    // truncating here would hide entries the user has no way to reach.
    for (const entry of s.plan) {
      const glyph =
        entry.status === "completed" ? "✓" : entry.status === "in_progress" ? "▸" : "·";
      const style =
        entry.status === "completed"
          ? "plan-done"
          : entry.status === "in_progress"
            ? "plan"
            : "plan-pending";
      lines.push(row(truncate(`${glyph} ${entry.content}`, ctx.width), style));
    }
    return lines;
  },
};

// Basename-with-disambiguation: show just the filename, but when two
// edited files share a basename fall back to parent/name so the rows
// aren't ambiguous.
export function displayPaths(paths: string[]): string[] {
  const base = paths.map((p) => p.split("/").pop() ?? p);
  const counts = new Map<string, number>();
  for (const b of base) {
    counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  return paths.map((p, i) => {
    const b = base[i]!;
    if ((counts.get(b) ?? 0) <= 1) {
      return b;
    }
    const parts = p.split("/");
    return parts.slice(-2).join("/");
  });
}

export const filesGadget: Gadget = {
  id: "files",
  title: "edited",
  relevant: (s) => s.editedFiles.length > 0,
  versionKey: (s, ctx) =>
    `${ctx.width}|` +
    s.editedFiles.map((f) => `${f.path}:${f.added ?? ""}:${f.removed ?? ""}`).join("\u0000"),
  render: (s, ctx) => {
    const { truncate, cellWidth } = ctx.metrics;
    // Most recent first, all of them — the column scrolls, so a cap here
    // would make older edits unreachable rather than merely off-screen.
    const shown = [...s.editedFiles].reverse();
    const lines: FormattedLine[] = [];
    if (shown.length > 1) {
      lines.push(row(labelValue("", `${shown.length} files`, ctx), "dim"));
    }
    const names = displayPaths(shown.map((f) => f.path));
    shown.forEach((file, i) => {
      const delta =
        file.added !== undefined || file.removed !== undefined
          ? `+${file.added ?? 0} -${file.removed ?? 0}`
          : "";
      const budget = ctx.width - (delta ? cellWidth(delta) + 1 : 0);
      const name = truncate(names[i]!, Math.max(1, budget));
      lines.push(
        fileRow(
          delta ? labelValue(name, delta, ctx) : name,
          file.path,
          "tool",
        ),
      );
    });
    return lines;
  },
};

export const gitGadget: Gadget = {
  id: "git",
  title: "git",
  // Clean repos and non-repos both contribute nothing: a row reading
  // "0 changes" is noise, and s.git stays null outside a work tree.
  relevant: (s) =>
    s.git !== null &&
    (s.git.staged > 0 ||
      s.git.unstaged > 0 ||
      s.git.untracked > 0 ||
      s.git.ahead > 0 ||
      s.git.behind > 0),
  versionKey: (s, ctx) => {
    const g = s.git;
    if (g === null) {
      return "none";
    }
    const files = g.files.map((f) => `${f.state}:${f.path}`).join("\u0000");
    return `${ctx.width}|${g.branch}|${g.staged}|${g.unstaged}|${g.untracked}|${g.ahead}|${g.behind}|${files}`;
  },
  render: (s, ctx) => {
    const g = s.git;
    if (g === null) {
      return [];
    }
    const { truncate } = ctx.metrics;
    const lines: FormattedLine[] = [];
    if (g.branch !== null) {
      const track =
        (g.ahead > 0 ? `↑${g.ahead}` : "") + (g.behind > 0 ? `↓${g.behind}` : "");
      // Branch name is an identity string; the ahead/behind marker beside
      // it is state, but it's small enough that splitting the row's styling
      // would read as noise.
      lines.push(
        track
          ? fieldRow(truncate(g.branch, ctx.width - track.length - 1), track, ctx)
          : { body: truncate(g.branch, ctx.width) },
      );
    }
    const parts: string[] = [];
    if (g.staged > 0) {
      parts.push(`${g.staged} staged`);
    }
    if (g.unstaged > 0) {
      parts.push(`${g.unstaged} dirty`);
    }
    if (g.untracked > 0) {
      parts.push(`${g.untracked} new`);
    }
    if (parts.length > 0) {
      lines.push(row(truncate(parts.join(" · "), ctx.width), "dim"));
    }
    // Individual files, so a double-click can open them. All of them: the
    // column scrolls, and the summary row above already gives the shape of
    // the change set at a glance.
    const shown = g.files;
    const names = displayPaths(shown.map((f) => f.path));
    shown.forEach((file, i) => {
      const glyph =
        file.state === "staged" ? "●" : file.state === "dirty" ? "○" : "+";
      const style =
        file.state === "staged"
          ? "plan-done"
          : file.state === "dirty"
            ? "tool"
            : "plan-pending";
      lines.push(
        fileRow(
          truncate(`${glyph} ${names[i]!}`, ctx.width),
          file.path,
          style,
        ),
      );
    });
    return lines;
  },
};

// Values in the session block are opaque identifiers, so each row needs a
// label — an unlabelled column of "hydra / ncp-anthropic/claude-opus-5 /
// build / hydra_se" is unreadable. Labels go left, values right-aligned,
// matching the context block.
//
// Values too long for the remaining space lose their LEAST distinctive
// part: a provider-qualified model drops the provider ("ncp-anthropic/
// claude-opus-5" → "claude-opus-5"), and anything still over budget is
// clipped from the head with a leading ellipsis so the tail — which is
// what actually distinguishes one id or model from another — survives.
export function fitIdentifier(
  value: string,
  budget: number,
  ctx: SidebarContext,
): string {
  const { cellWidth, truncate } = ctx.metrics;
  if (budget <= 0) {
    return "";
  }
  if (cellWidth(value) <= budget) {
    return value;
  }
  const lastSegment = value.slice(value.lastIndexOf("/") + 1);
  if (lastSegment !== value && cellWidth(lastSegment) <= budget) {
    return lastSegment;
  }
  const candidate = lastSegment.length < value.length ? lastSegment : value;
  // Head-clip: walk in from the left until the tail fits beside the "…".
  for (let i = 1; i < candidate.length; i++) {
    const tail = `…${candidate.slice(i)}`;
    if (cellWidth(tail) <= budget) {
      return tail;
    }
  }
  return truncate(candidate, budget);
}

export const sessionGadget: Gadget = {
  id: "session",
  title: "session",
  relevant: (s) => s.agent !== null || s.model !== null || s.sessionId !== null,
  versionKey: (s, ctx) =>
    `${ctx.width}|${s.agent}|${s.model}|${s.mode}|${s.sessionId}`,
  render: (s, ctx) => {
    const { cellWidth } = ctx.metrics;
    const lines: SidebarLine[] = [];
    const field = (label: string, value: string): void => {
      // One column of separation between label and value at minimum.
      const budget = ctx.width - cellWidth(label) - 1;
      lines.push(fieldRow(label, fitIdentifier(value, budget, ctx), ctx));
    };
    // All four are identity strings, so none of them takes a colour.
    if (s.agent !== null) {
      field("agent", s.agent);
    }
    if (s.model !== null) {
      field("model", s.model);
    }
    if (s.mode !== null) {
      field("mode", s.mode);
    }
    if (s.sessionId !== null) {
      field("sid", s.sessionId);
    }
    return lines;
  },
};

// Default order == display order, top to bottom. Also the order the
// screen layer sheds gadgets in when the column is too short — from the
// bottom up, so activity and context survive.
export const BUILTIN_GADGETS: Gadget[] = [
  activityGadget,
  contextGadget,
  queueGadget,
  todoGadget,
  filesGadget,
  gitGadget,
  sessionGadget,
];
