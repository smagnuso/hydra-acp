// The built-in sidebar gadgets.
//
// Every gadget is a pure function of the snapshot. Rules of the road:
//   - relevant() must be cheap and side-effect free; false means the
//     gadget contributes zero rows (no header, no separator).
//   - versionKey() must include every snapshot field render() reads,
//     quantized to what is actually visible (whole seconds, not ms), so
//     the memo cache in registry.ts doesn't churn on invisible changes.
//   - render() must not exceed ctx.width cells per row.

import type { ChromeActionTarget } from "../chrome-action.js";
import type { FormattedLine } from "../format.js";
import { RUNNING_TOOL_CAP } from "./running-tools.js";
import type {
  Gadget,
  SidebarContext,
  SidebarLine,
  SidebarLiveSession,
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

// Round a duration DOWN to a whole multiple of `stepMs`.
//
// Used for the idle counter, which refreshes every few seconds: rendering
// exact seconds at that cadence made the value visibly jump ("idle 4s" →
// "idle 9s" → "idle 14s"), advertising a precision the clock doesn't keep.
// Quantizing to the refresh step means every value shown is one the next
// refresh will still agree with.
export function quantizeDuration(ms: number, stepMs: number): number {
  if (stepMs <= 0) {
    return ms;
  }
  return Math.floor(Math.max(0, ms) / stepMs) * stepMs;
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

// Item rows per page for the list gadgets. Bounding each gadget keeps every
// gadget visible at once, which is the point: an unbounded list pushed the
// ones below it off the bottom of the column even though the column scrolls.
const SIDEBAR_PAGE_SIZE = 5;

function row(body: string, bodyStyle?: FormattedLine["bodyStyle"]): SidebarLine {
  return { body, bodyStyle };
}

// A label/value row where the two halves are styled independently: the
// label is `muted` (it's scaffolding) and the value keeps the terminal's
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
// The policy used to have a hole: idle / quiet / ready rows carried STATE
// but were painted with the same `dim` token as the scaffolding labels, so
// "nothing is happening" and "this is structure" were indistinguishable and
// retinting either moved both. Those rows now use `status-idle`, which sits
// with the other status tokens — it renders the same today, but it is the
// quiescent arm of a state enum and can be tuned as one.
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
    // The merged row loses the label/value distinction the wide path relies
    // on, so it all reads as scaffolding.
    return {
      body: truncate(`${label} ${value}`, ctx.width),
      bodyStyle: "muted",
    };
  }
  return {
    prefix: `${label}${" ".repeat(gap)}`,
    prefixStyle: "muted",
    body: value,
    // Explicit rather than relying on an absent style resolving to the body
    // colour. It resolves the same, but it says so — and it is the token the
    // sessions list matches to look like a value rather than like furniture.
    bodyStyle: "sidebar-value",
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
  // The displayed file name as it appears in `body`. Used to derive the
  // hyperlink span; pass it whenever `body` is a composite so only the
  // name underlines. Located by indexOf, which is unambiguous here
  // because the name is the only free-form text in these rows.
  displayName?: string,
): SidebarLine {
  // item: these are the rows pagination windows; the block's title and
  // summary rows are structural and always shown.
  const line: SidebarLine = { body, bodyStyle, openPath, item: true };
  if (displayName !== undefined && displayName.length > 0) {
    const at = body.indexOf(displayName);
    if (at !== -1) {
      line.openSpan = { start: at, end: at + displayName.length };
    }
  }
  return line;
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
// Granularity of the idle readout, matching the sidebar ticker's slow
// cadence (app.ts SIDEBAR_SLOW_TICKS × 1s). Keep the two in step: showing
// finer detail than the clock delivers makes the counter stutter, and
// coarser wastes refreshes.
const IDLE_STEP_MS = 5_000;

export const activityGadget: Gadget = {
  id: "activity",
  relevant: () => true,
  versionKey: (s) => {
    if (s.busySince !== null) {
      return `busy:${Math.floor((s.now - s.busySince) / 1000)}`;
    }
    if (s.armedSince !== null) {
      return `running:${Math.floor((s.now - s.armedSince) / 1000)}`;
    }
    if (s.lastTurnEndedAt !== null) {
      // Quantized, so the key changes exactly as often as the display does
      // — an un-quantized key re-rendered the gadget every second to
      // produce identical bytes.
      return `idle:${quantizeDuration(s.now - s.lastTurnEndedAt, IDLE_STEP_MS)}`;
    }
    return "fresh";
  },
  render: (s, ctx) => {
    if (s.busySince !== null) {
      return [
        row(
          labelValue("● thinking", shortDuration(s.now - s.busySince), ctx),
          // The session is in a turn. "thinking" is the label; the state
          // covers tool execution and streaming too.
          "status-active",
        ),
      ];
    }
    // Between thinking and idle: the agent handed the turn back, but a
    // background task it started is still going and can wake it up. Clocked
    // from when the job started, not from the turn end, because the useful
    // reading is how long the job has run.
    if (s.armedSince !== null) {
      return [
        row(
          labelValue("◐ running", shortDuration(s.now - s.armedSince), ctx),
          "status-active",
        ),
      ];
    }
    if (s.lastTurnEndedAt !== null) {
      return [
        row(
          labelValue(
            "○ idle",
            shortDuration(
              quantizeDuration(s.now - s.lastTurnEndedAt, IDLE_STEP_MS),
            ),
            ctx,
          ),
          "status-idle",
        ),
      ];
    }
    return [row("○ ready", "status-idle")];
  },
};

// What the agent is doing RIGHT NOW. The tools block lives in scrollback
// and scrolls off the top on a long turn, which leaves no way to see the
// in-flight call; this is that view, pinned.
//
// Deliberately declares no `pageSize`. See running-tools.ts — the
// renderer's page budget is shared across all paginated gadgets, and a
// list that churns on a per-tool-call cadence would resize todo/edited
// underneath the user. It caps itself instead.
//
// Sits LAST in the default order for the same reason. This list appears
// and empties on a per-tool-call cadence, so anything below it visibly
// jumps every few seconds; at the bottom there is nothing below it to
// shove around. The cost is that the bottom is also where the column
// sheds gadgets when the terminal is short — see BUILTIN_GADGETS.
//
// The snapshot field stays `running` while the gadget is titled "tools":
// the gadget answers "what are the tools doing", but the field holds
// specifically the IN-FLIGHT ones, and calling it `tools` would invite
// someone to start putting completed calls in it.
export const toolsGadget: Gadget = {
  id: "tools",
  title: "tools",
  relevant: (s) => s.running.length > 0,
  versionKey: (s, ctx) => {
    const shown = s.running.slice(0, RUNNING_TOOL_CAP);
    return (
      `${ctx.width}|${s.running.length}|` +
      shown
        .map((t) => {
          // Quantized to whole seconds, which is all the row displays.
          // Keying on raw startedAt vs now would re-render every frame to
          // emit identical bytes (same trap as the activity gadget).
          const secs =
            t.startedAt === undefined
              ? ""
              : Math.floor(Math.max(0, s.now - t.startedAt) / 1000);
          return `${t.verb}:${t.detail ?? ""}:${secs}`;
        })
        .join("\u0000")
    );
  },
  render: (s, ctx) => {
    const { truncate, cellWidth } = ctx.metrics;
    const lines: SidebarLine[] = [];
    const shown = s.running.slice(0, RUNNING_TOOL_CAP);
    for (const tool of shown) {
      const elapsed =
        tool.startedAt === undefined
          ? ""
          : shortDuration(Math.max(0, s.now - tool.startedAt));
      // The verb is the part that must never be clipped — it's the
      // at-a-glance signal. The detail gets whatever's left, and an
      // execute call's command is routinely longer than that.
      const head = `▸ ${tool.verb}`;
      const budget =
        ctx.width - cellWidth(head) - (elapsed === "" ? 0 : cellWidth(elapsed) + 1) - 1;
      const detail =
        tool.detail === undefined || budget < 4
          ? ""
          : ` ${truncate(tool.detail, budget)}`;
      const body = `${head}${detail}`;
      const rendered = elapsed === "" ? body : labelValue(body, elapsed, ctx);
      const toolLine: SidebarLine = {
        body: rendered,
        bodyStyle: "tool-status-running",
        openPath: tool.path,
      };
      // Link the file name only when it's actually visible in the row.
      // `detail` is often a command rather than a path (an execute call),
      // and underlining a command as if it were the file would misdescribe
      // the target. No span means no hyperlink; the row stays clickable
      // via openPath either way.
      if (tool.path !== undefined) {
        const base = tool.path.slice(tool.path.lastIndexOf("/") + 1);
        const at = base.length > 0 ? rendered.indexOf(base) : -1;
        if (at !== -1) {
          toolLine.openSpan = { start: at, end: at + base.length };
        }
      }
      lines.push(toolLine);
    }
    if (s.running.length > shown.length) {
      lines.push(row(`  +${s.running.length - shown.length} more`, "muted"));
    }
    return lines;
  },
};

export const contextGadget: Gadget = {
  id: "context",
  title: "context",
  relevant: (s) => s.usage.used !== undefined || s.usage.costAmount !== undefined,
  versionKey: (s, ctx) =>
    `${s.usage.used ?? ""}/${s.usage.size ?? ""}/${s.usage.costAmount ?? ""}/${ctx.width}`,
  render: (s, ctx) => {
    const lines: SidebarLine[] = [];
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
          pct >= 0.9 ? "meter-warn" : "metric",
        ),
      );
      // Over 90% of the window the bar turns into a warning — this is the
      // cue that a compaction is imminent.
      lines.push(
        row(meterBar(pct, ctx.width), pct >= 0.9 ? "meter-warn" : "meter-fill"),
      );
    } else if (used !== undefined) {
      lines.push(row(labelValue("tokens", compactCount(used), ctx), "metric"));
    }
    if (costAmount !== undefined) {
      const cur = costCurrency === "USD" || costCurrency === undefined ? "$" : `${costCurrency} `;
      // A metric by shape, but muted by intent: unlike context usage it never
      // becomes something to act on, so it stays scaffolding-coloured.
      lines.push(
        row(labelValue("cost", `${cur}${costAmount.toFixed(2)}`, ctx), "muted"),
      );
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
      // Matches the separator's counter. This row used to be dim while the
      // separator showed the same fact in the accent colour.
      "status-queued",
    ),
  ],
};

export const todoGadget: Gadget = {
  id: "todo",
  title: "todo",
  pageSize: SIDEBAR_PAGE_SIZE,
  relevant: (s) => s.plan.length > 0,
  titleNote: (s) =>
    `${s.plan.filter((e) => e.status === "completed").length}/${s.plan.length}`,
  versionKey: (s, ctx) =>
    `${ctx.width}|` + s.plan.map((e) => `${e.status}:${e.content}`).join("\u0000"),
  render: (s, ctx) => {
    const { truncate } = ctx.metrics;
    const lines: SidebarLine[] = [];
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
      lines.push({
        body: truncate(`${glyph} ${entry.content}`, ctx.width),
        bodyStyle: style,
        item: true,
      });
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
  pageSize: SIDEBAR_PAGE_SIZE,
  relevant: (s) => s.editedFiles.length > 0,
  // Only once there's more than one: "1 files" is noise, and a single row
  // counts itself.
  titleNote: (s) =>
    s.editedFiles.length > 1 ? `${s.editedFiles.length} files` : undefined,
  versionKey: (s, ctx) =>
    `${ctx.width}|` +
    s.editedFiles.map((f) => `${f.path}:${f.added ?? ""}:${f.removed ?? ""}`).join("\u0000"),
  render: (s, ctx) => {
    const { truncate, cellWidth } = ctx.metrics;
    // Most recently edited first, all of them — the column scrolls, so a cap
    // here would make older edits unreachable rather than merely off-screen.
    // The reverse relies on collapseEditedFiles ordering by LAST touch; with
    // first-touch order this puts the file the agent has finished with above
    // the one it's editing now, which is precisely inverted when pagination
    // squeezes the list down to one row.
    const shown = [...s.editedFiles].reverse();
    const lines: SidebarLine[] = [];
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
          "file-path",
          name,
        ),
      );
    });
    return lines;
  },
};

export const gitGadget: Gadget = {
  id: "git",
  title: "git",
  pageSize: SIDEBAR_PAGE_SIZE,
  // Clean repos and non-repos both contribute nothing: a row reading
  // "0 changes" is noise, and s.git stays null outside a work tree.
  relevant: (s) =>
    s.git !== null &&
    (s.git.staged > 0 ||
      s.git.unstaged > 0 ||
      s.git.untracked > 0 ||
      s.git.ahead > 0 ||
      s.git.behind > 0),
  // A count, not the staged/dirty/new breakdown, for two reasons: the
  // breakdown is 26 cells wide and the body is ~24, and every file row now
  // carries its own state word — so the split is on screen already and the
  // header only has to say how many rows there are. Omitted for one file,
  // which counts itself.
  //
  // Counts ROWS, not g.staged + g.unstaged + g.untracked: a file that is
  // both staged and dirty increments two of those counters while producing
  // a single row, so the sum overstates the list.
  titleNote: (s) =>
    s.git !== null && s.git.files.length > 1
      ? `${s.git.files.length} files`
      : undefined,
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
    const { truncate, cellWidth } = ctx.metrics;
    const lines: SidebarLine[] = [];
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
    // Individual files, so a double-click can open them. All of them: the
    // column scrolls, and the summary row above already gives the shape of
    // the change set at a glance.
    const shown = g.files;
    const names = displayPaths(shown.map((f) => f.path));
    shown.forEach((file, i) => {
      // The state as a WORD, right-aligned, rather than a leading glyph.
      // Two reasons, one taste and one mechanical:
      //
      //   - "● / ○ / +" has to be learned, and nothing on screen teaches
      //     it. The words are the same vocabulary as the summary row above
      //     ("3 staged · 2 dirty · 1 new"), so the block explains itself.
      //   - ● and ○ are East Asian AMBIGUOUS width. Terminals disagree on
      //     whether they occupy one cell or two, and a row that guesses
      //     wrong shifts every character after it — which is why these rows
      //     didn't line up with each other. The words are pure ASCII and
      //     right-alignment puts the ragged edge where names already differ.
      const style =
        file.state === "staged"
          ? "git-staged"
          : file.state === "dirty"
            ? "git-dirty"
            : "git-untracked";
      const budget = ctx.width - cellWidth(file.state) - 1;
      const name = truncate(names[i]!, Math.max(1, budget));
      lines.push(
        fileRow(labelValue(name, file.state, ctx), file.path, style, name),
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

export const sessionInfoGadget: Gadget = {
  // Not "session": the `sessions` gadget above lists the OTHER live
  // sessions, and two config ids one character apart is a typo waiting to
  // silently drop a block. This one describes what you are attached to.
  id: "info",
  title: "info",
  relevant: (s) =>
    s.agent !== null || s.model !== null || s.sessionId !== null || s.workspace !== null,
  versionKey: (s, ctx) =>
    `${ctx.width}|${s.agent}|${s.model}|${s.mode}|${s.sessionId}|${s.workspace?.label ?? ""}`,
  render: (s, ctx) => {
    const { cellWidth } = ctx.metrics;
    const lines: SidebarLine[] = [];
    // `target` makes the row a double-click target. The three config
    // dimensions open the same chooser their sessionbar field opens,
    // through the same dispatch; the value is the config id, not the
    // displayed setting, since the chooser reads the live option list.
    const field = (
      label: string,
      value: string,
      target?: ChromeActionTarget,
    ): void => {
      // One column of separation between label and value at minimum.
      const budget = ctx.width - cellWidth(label) - 1;
      const row = fieldRow(label, fitIdentifier(value, budget, ctx), ctx);
      lines.push(target === undefined ? row : { ...row, doubleAction: target });
    };
    // All four are identity strings, so none of them takes a colour.
    if (s.agent !== null) {
      field("agent", s.agent, { action: "choose-agent", value: "agent" });
    }
    if (s.model !== null) {
      field("model", s.model, { action: "choose-model", value: "model" });
    }
    if (s.mode !== null) {
      field("mode", s.mode, { action: "choose-mode", value: "mode" });
    }
    if (s.sessionId !== null) {
      // Not a chooser: the id is what it is, so copy it — and copy the
      // whole id, not the head-clipped form the row displays.
      field("id", s.sessionId, { action: "copy", value: s.sessionId });
    }
    if (s.workspace !== null) {
      // Label only; the project it belongs to is already the sessionbar's
      // cwd field. openPath rather than a copy action: a directory you can
      // see is a directory you will try to open, and routing through
      // openPath puts the row in the same resolution path as every other
      // clickable path — including the check that refuses a workspace
      // which no longer exists.
      const wsRow = fieldRow("workspace", s.workspace.label, ctx);
      lines.push({ ...wsRow, openPath: s.workspace.path });
    }
    return lines;
  },
};

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${Math.max(0, Math.round(bytes))}B`;
  }
  const mb = bytes / (1024 * 1024);
  if (mb < 1) {
    return `${Math.round(bytes / 1024)}K`;
  }
  if (mb < 1024) {
    return mb < 10 ? `${mb.toFixed(1)}M` : `${Math.round(mb)}M`;
  }
  const gb = mb / 1024;
  return `${gb.toFixed(1)}G`;
}

// CPU as a percentage of one core. Not clamped at 100: a tree spanning
// several cores really does use more, and hiding that would misreport the
// thing the row exists to show.
//
// Padded to a fixed width so the rows form columns. The whole value is
// right-aligned in the row, so a variable-width CPU field drags the memory
// figure left and right with it and the two readings never line up. One
// decimal below 100% (where readings normally sit) and whole percent above,
// which keeps the field at CPU_FIELD_WIDTH for everything up to 9999%.
const CPU_FIELD_WIDTH = 5;

export function formatCpu(fraction: number | undefined): string {
  if (fraction === undefined) {
    // No baseline yet (first sample). A dash reads as "not known", where a
    // "0%" would be a claim.
    return "–".padStart(CPU_FIELD_WIDTH);
  }
  const pct = fraction * 100;
  const text = pct < 100 ? `${pct.toFixed(1)}%` : `${Math.round(pct)}%`;
  return text.padStart(CPU_FIELD_WIDTH);
}

// Other live sessions: whether each is working, and whether any of them is
// blocked on you. Two independent axes, shown as a two-cell marker at the
// right edge of the row.
//
//   ● working / ○ quiet — the same pair the activity gadget uses at the top
//   of this very column ("● thinking" / "○ idle"), so the glyph means the
//   same thing whether it describes this session or another.
//
//   ◦ in the cell to its left when something is waiting on you, blank
//   otherwise. Matches the picker's and `hydra session list`'s "WARM◦",
//   which likewise hangs the marker off the RIGHT of the text. A different
//   shape from the busy/quiet pair, so the two axes can't be confused.
//
// Both markers sit on the right so the labels stay flush with every other
// gadget's rows — an indent here and nowhere else read as a mistake. The
// slot is two cells whether or not the ◦ is present, which keeps the
// busy/quiet bubbles in one column.
//
// The label goes in `prefix` and the marker in `body` so the marker can
// carry its own colour (yellow while working) without tinting the title.
// That costs the OSC 8 link span, which the screen layer only paints for
// filesystem paths anyway (see rowLinkSpans) — the row stays
// double-clickable through openPath.
const BUSY_MARK = "●";
const IDLE_MARK = "○";
const WAITING_MARK = "◦";

export const sessionsGadget: Gadget = {
  id: "sessions",
  title: "sessions",
  pageSize: SIDEBAR_PAGE_SIZE,
  relevant: (s) => s.liveSessions.length > 0,
  // Only when folded. Open, a "1 waiting" counter restates what the rows
  // already say — waiting sorts to the top and each row carries its own
  // marker — so it just competed with them for the eye. Folded, the rows are
  // gone and this is the only thing left that can tell you something is
  // blocked on you.
  titleNote: (s, _ctx, folded) => {
    if (!folded) {
      return undefined;
    }
    const waiting = s.liveSessions.filter((p) => p.waiting).length;
    return waiting > 0 ? `${waiting} waiting` : `${s.liveSessions.length} live`;
  },
  versionKey: (s, ctx) =>
    `${ctx.width}|` +
    s.liveSessions
      .map((p) => `${p.waiting ? "w" : ""}${p.busy ? "b" : ""}:${p.sessionId}:${p.label}`)
      .join("\u0000"),
  render: (s, ctx) => {
    const { truncate, cellWidth } = ctx.metrics;
    // Anything blocked on the user first, then whatever is working. Stable
    // within a group: the caller supplies them most-recently-used first, and
    // a list that reshuffles under the pointer is worse than one that
    // doesn't move.
    const rank = (e: SidebarLiveSession): number =>
      (e.waiting ? 0 : 2) + (e.busy ? 0 : 1);
    const sorted = [...s.liveSessions].sort((a, b) => rank(a) - rank(b));
    return sorted.map((entry) => {
      const marker = `${entry.waiting ? WAITING_MARK : " "}${
        entry.busy ? BUSY_MARK : IDLE_MARK
      }`;
      const markerWidth = cellWidth(marker);
      const label = truncate(
        entry.label,
        Math.max(1, ctx.width - markerWidth - 1),
      );
      const gap = Math.max(1, ctx.width - cellWidth(label) - markerWidth);
      return {
        prefix: `${label}${" ".repeat(gap)}`,
        // A label is a value — a session's name — so by default it reads like
        // the agent and model values in the info gadget rather than like
        // scaffolding. Busy is the exception: a session actively working is the
        // one state worth pulling the eye across the whole row for, so it keeps
        // the accent it has always had.
        //
        // What changed, and why: the label used to carry state for every case.
        // Quiet sessions took `status-idle`, and idle is the common case, so the
        // list as a whole read as dim and unimportant. Worse, `status-waiting`
        // resolves to the same muted grey as idle, so a session actually blocked
        // on you was dimmed too — despite the comment here once claiming it
        // stayed bright. Only busy was ever really highlighted, and then only by
        // accident: its style was undefined and the painter falls back to
        // `prefixStyle ?? bodyStyle`, so it inherited the marker's colour.
        //
        // Now it is deliberate. Busy is loud, everything else is legible, and
        // idle-versus-waiting is left to the marker, which carries it as both a
        // glyph and a colour.
        prefixStyle: entry.busy ? "status-active" : "sidebar-value",
        body: marker,
        // Shares status-active with the banner and the activity gadget, so the
        // three surfaces cannot drift apart. Waiting has its own token rather
        // than falling through to idle: it renders the same today, but it is a
        // distinct state. Deliberately not red — red means failure everywhere
        // else, and a session on a permission prompt hasn't failed.
        bodyStyle: entry.busy
          ? "status-active"
          : entry.waiting
            ? "status-waiting"
            : "status-idle",
        doubleAction: { action: "open-session", value: entry.sessionId },
        item: true,
      } satisfies SidebarLine;
    });
  },
};

export const resourcesGadget: Gadget = {
  id: "resources",
  title: "resources",
  relevant: (s) => s.resources.length > 0,
  versionKey: (s, ctx) =>
    `${ctx.width}|` +
    s.resources
      .map(
        (r) =>
          // Quantized to what's displayed: raw byte counts and CPU
          // fractions change on every sample, so keying on them would
          // re-render the gadget to produce identical text.
          `${r.label}:${formatBytes(r.rssBytes)}:${formatCpu(r.cpuFraction)}:${r.processes}`,
      )
      .join("\u0000"),
  render: (s, ctx) => {
    const { cellWidth, truncate } = ctx.metrics;
    return s.resources.map((usage) => {
      const value = `${formatBytes(usage.rssBytes)} ${formatCpu(usage.cpuFraction)}`;
      // The process count only earns space once a tree is more than the
      // root: "agent ×4" is informative, "×1" is noise.
      const label =
        usage.processes > 1 ? `${usage.label} ×${usage.processes}` : usage.label;
      const budget = ctx.width - cellWidth(value) - 1;
      // fieldRow gives the dim-label / plain-value pairing and the
      // right-alignment padding, same as the session block.
      return fieldRow(truncate(label, Math.max(1, budget)), value, ctx);
    });
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
  sessionsGadget,
  resourcesGadget,
  sessionInfoGadget,
  toolsGadget,
];
