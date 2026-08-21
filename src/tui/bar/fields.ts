// The set of session facts that can be placed in a chrome slot.
//
// Adding something the bars can show is one entry in FIELDS. Anything
// in here is addressable from config as `"<id>"` or
// `{ "field": "<id>", ... }` in tui.composer.* / tui.sessionbar.

import { formatAgentWithModel, formatCost } from "../../core/agent-display.js";
import { shortenHomePath } from "../../core/paths.js";
import { stripHydraSessionPrefix } from "../../core/session.js";
import { formatElapsed } from "../format.js";
import type { ThemeToken } from "../theme/index.js";
import type { Chunk, FieldGroup } from "./layout.js";
import type { FieldContext, UsageState } from "./types.js";

export interface FieldDef {
  /** Default shed priority; lower goes first when the row overflows. */
  priority: number;
  /**
   * Resolve to the runs this field contributes, or null when it has
   * nothing to say right now (no title, nothing queued, not scrolled).
   * Absent fields take their separator with them.
   */
  resolve(ctx: FieldContext): Chunk[] | null;
  /**
   * Opt out of "one field, one shed unit" and emit several. Used by
   * `helpHint`, whose chunks are independently meaningful: a narrow
   * terminal should drop "^d detach" and keep "⇧⇥ mode", not blank the
   * whole row. When present this wins over `resolve`.
   */
  resolveGroups?(ctx: FieldContext): FieldGroup[] | null;
}

// "Thinking" rather than "Busy" so the composer matches the two other
// places that name this state (the sidebar's `● thinking` and the
// scrollback block's `thinking · Xs`); the composer was the odd one out.
//
// "Waiting" is a separate word for a separate thing: the agent is idle and
// will take a prompt, but a background task it started is still going and
// can restart it. Folding that into "Thinking" would be wrong twice over,
// since nothing is thinking and the session is not busy. It is the SESSION
// that is waiting; the job is the thing running.
//
// Distinct from BLOCKED (the sidebar `sessions` gadget, `awaitingInput` on
// the wire), which means the session cannot advance until the user does
// something. Waiting needs nothing from anyone; blocked needs you. That
// split is why the two words are not interchangeable here.
function armedAndIdle(ctx: FieldContext): boolean {
  return ctx.banner.status === "ready" && ctx.banner.armedSince !== undefined;
}

function statusLabel(ctx: FieldContext): { label: string; token: ThemeToken } {
  const status = ctx.banner.status;
  const stalled = status === "busy" && ctx.banner.stalled === true;
  let label: string;
  if (ctx.statusLabel !== undefined) {
    label = ctx.statusLabel;
  } else if (stalled) {
    label = "Stalled";
  } else if (status === "busy") {
    label = "Thinking";
  } else if (armedAndIdle(ctx)) {
    label = "Waiting";
  } else {
    label = status.charAt(0).toUpperCase() + status.slice(1);
  }
  let token: ThemeToken;
  if (stalled || status === "disconnected") {
    token = "status-alert";
  } else if (status === "busy" || armedAndIdle(ctx)) {
    token = "status-active";
  } else if (status === "cold") {
    token = "status-cold";
  } else {
    token = "status-ready";
  }
  return { label, token };
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1000) {
    return `${(n / 1000).toFixed(1)}k`;
  }
  return String(n);
}

export function formatUsage(usage: UsageState | undefined): string | null {
  if (!usage) {
    return null;
  }
  const parts: string[] = [];
  if (typeof usage.used === "number") {
    if (typeof usage.size === "number" && usage.size > 0) {
      parts.push(`${formatTokens(usage.used)}/${formatTokens(usage.size)}`);
    } else {
      parts.push(formatTokens(usage.used));
    }
  } else if (typeof usage.size === "number") {
    parts.push(`/${formatTokens(usage.size)}`);
  }
  if (typeof usage.costAmount === "number") {
    parts.push(formatCost(usage.costAmount, usage.costCurrency));
  }
  return parts.length === 0 ? null : parts.join(" · ");
}

// Each hint is an independently hoverable and clickable target, so the
// field emits one group per item. Everything else in the registry is a
// single group.
//
// Once the session has driven past tui.composer.hintTurns the field
// resolves to nothing at all rather than to a placeholder glyph: with no
// right-side group, layoutRow emits no pads and the fill absorbs the
// whole row, so the rule paints unbroken. A collapsed run of fill
// characters would instead sit inside those pads and leave two
// one-column holes in the rule.
//
// `hintsRevealed` overrides the threshold rather than being folded into
// it, which is what makes hintTurns: 0 mean "hover-only" rather than
// "gone": the two states are indistinguishable here by design.
function helpHintGroups(ctx: FieldContext): FieldGroup[] | null {
  if (ctx.banner.hintsExhausted === true && !ctx.hintsRevealed) {
    return null;
  }
  const items = ctx.banner.hint;
  if (items.length === 0) {
    return null;
  }
  return items.map((item, i) => {
    const label =
      item.id === "mode" && (ctx.banner.currentMode ?? "") !== ""
        ? `${item.label}: ${ctx.banner.currentMode}`
        : item.label;
    const chunk: Chunk = {
      text: label,
      token: "modal-hint",
      action: item.action,
    };
    return {
      id: item.id,
      chunks: [chunk],
      // Leftmost hint is the most important, so it sheds last.
      priority: 20 + (items.length - i),
    };
  });
}

export const FIELDS: Record<string, FieldDef> = {
  // Never shed: without it the top rule says nothing.
  status: {
    priority: Infinity,
    resolve: (ctx) => {
      const { label, token } = statusLabel(ctx);
      return [{ text: label, token }];
    },
  },
  // Attaches to `status` with a plain space rather than " · " — see the
  // separator override in the default config.
  elapsed: {
    priority: 60,
    resolve: (ctx) => {
      // Armed clocks from when the job started, not from the turn end:
      // "this job has been going 12m" is the question, "you have been idle
      // 12m" is not. Computed here rather than pushed as elapsedMs so it
      // keeps ticking between banner updates.
      if (armedAndIdle(ctx)) {
        const running = Date.now() - ctx.banner.armedSince!;
        if (running < 1000) {
          return null;
        }
        return [{ text: formatElapsed(running), token: "status-active" }];
      }
      if (
        ctx.banner.status !== "busy" ||
        ctx.banner.elapsedMs === undefined ||
        ctx.banner.elapsedMs < 1000
      ) {
        return null;
      }
      const stalled = ctx.banner.stalled === true;
      const token: ThemeToken = stalled ? "status-alert" : "status-active";
      return [{ text: formatElapsed(ctx.banner.elapsedMs), token }];
    },
  },
  sessionId: {
    priority: 40,
    resolve: (ctx) => {
      const sid = stripHydraSessionPrefix(ctx.session.sessionId);
      if (!sid) {
        return null;
      }
      // Copies what it shows. Every consumer of a pasted id — the daemon
      // routes via resolveCanonicalId, `/session <id>`, the picker —
      // re-attaches the hydra_session_ prefix, so the long form buys
      // nothing and is a nuisance to paste. `sessionIdFull` is there for
      // anyone who wants it. On the btw frame the id names the fork,
      // where a single click has always jumped to it.
      const chunk: Chunk = {
        text: sid,
        token: "rule-meta",
        doubleAction: "copy",
        value: sid,
      };
      if (ctx.scope === "btw") {
        chunk.action = "open-session";
      }
      return [chunk];
    },
  },
  sessionIdFull: {
    priority: 40,
    resolve: (ctx) =>
      ctx.session.sessionId
        ? [
            {
              text: ctx.session.sessionId,
              token: "rule-meta",
              doubleAction: "copy",
            },
          ]
        : null,
  },
  queued: {
    priority: 50,
    resolve: (ctx) =>
      ctx.banner.queued > 0
        ? [{ text: `${ctx.banner.queued} queued`, token: "status-queued" }]
        : null,
  },
  scroll: {
    priority: 30,
    resolve: (ctx) =>
      ctx.scrollOffset > 0
        ? [{ text: `↑ ${ctx.scrollOffset}`, token: "bar-indicator" }]
        : null,
  },
  usage: {
    priority: 45,
    resolve: (ctx) => {
      const s = formatUsage(ctx.session.usage);
      return s ? [{ text: s, token: "content", doubleAction: "copy" }] : null;
    },
  },
  tokens: {
    priority: 45,
    resolve: (ctx) => {
      const u = ctx.session.usage;
      if (!u || typeof u.used !== "number") {
        return null;
      }
      const text =
        typeof u.size === "number" && u.size > 0
          ? `${formatTokens(u.used)}/${formatTokens(u.size)}`
          : formatTokens(u.used);
      return [{ text, token: "content", doubleAction: "copy" }];
    },
  },
  cost: {
    priority: 45,
    resolve: (ctx) => {
      const u = ctx.session.usage;
      if (!u || typeof u.costAmount !== "number") {
        return null;
      }
      return [
        {
          text: formatCost(u.costAmount, u.costCurrency),
          token: "content",
          doubleAction: "copy",
        },
      ];
    },
  },
  cwd: {
    priority: 70,
    resolve: () => null,
    // Groups, not runs: every chunk a `resolve` returns carries the same
    // field id and the layout engine merges same-id hit regions, so a
    // second run with its own doubleAction would silently dispatch the
    // first one's. The path and the workspace label open different
    // directories, so they have to be separate groups.
    resolveGroups: (ctx) => {
      const ws = ctx.session.workspace;
      if (ws === undefined) {
        const text = shortenHomePath(ctx.session.cwd);
        if (!text) {
          return null;
        }
        return [
          {
            id: "cwd",
            priority: 70,
            chunks: [
              {
                text,
                token: "bar-text",
                flex: true,
                minWidth: 8,
                // Double-click hands the *absolute* path to
                // tui.openFileCommand (the display form is
                // ~-abbreviated and may be truncated).
                doubleAction: "open",
                value: ctx.session.cwd,
              },
            ],
          },
        ];
      }
      // Isolated: show the PROJECT plus the workspace label, because the
      // literal cwd is a hash directory that names no project.
      const source = shortenHomePath(ws.sourceCwd);
      if (!source) {
        return null;
      }
      return [
        {
          id: "cwd",
          priority: 70,
          chunks: [
            {
              text: source,
              token: "bar-text",
              flex: true,
              minWidth: 8,
              doubleAction: "open",
              value: ws.sourceCwd,
            },
          ],
        },
        {
          id: "cwdWorkspace",
          // Below the project: on a narrow bar, losing which workspace
          // you are in beats losing which project.
          priority: 69,
          // A plain space, not the slot's " · ": the label reads as part
          // of the path field, not as a field of its own.
          separator: " ",
          chunks: [
            {
              text: `[${ws.label}]`,
              token: "bar-text",
              doubleAction: "open",
              value: ws.path,
            },
          ],
        },
      ];
    },
  },
  cwdFull: {
    priority: 70,
    resolve: (ctx) =>
      ctx.session.cwd
        ? [
            {
              text: ctx.session.cwd,
              token: "bar-text",
              flex: true,
              minWidth: 8,
              doubleAction: "open",
            },
          ]
        : null,
  },
  title: {
    priority: 75,
    resolve: (ctx) => {
      const t = ctx.session.title?.trim();
      // Double-click opens the rename prompt seeded with the *full*
      // title (the painted form may be truncated), the same dialog `t`
      // gives you in the picker.
      return t
        ? [
            {
              text: t,
              token: "bar-text",
              flex: true,
              minWidth: 8,
              doubleAction: "rename-session",
              value: t,
            },
          ]
        : null;
    },
  },
  agent: {
    priority: 80,
    resolve: (ctx) =>
      ctx.session.agent
        ? [
            {
              text: ctx.session.agent,
              token: "content",
              doubleAction: "choose-agent",
            },
          ]
        : null,
  },
  model: {
    priority: 65,
    resolve: (ctx) =>
      ctx.session.model
        ? [
            {
              text: ctx.session.model,
              token: "content",
              doubleAction: "choose-model",
            },
          ]
        : null,
  },
  agentModel: {
    priority: 80,
    resolve: (ctx) => {
      const text = formatAgentWithModel(ctx.session.agent, ctx.session.model);
      // One chunk covers both dimensions, and it opens the MODEL chooser:
      // that's the one people switch. Agent switching lives on the `agent`
      // field and `/agent`.
      return text
        ? [
            {
              text,
              token: "content",
              flex: true,
              minWidth: 6,
              doubleAction: "choose-model",
              value: text,
            },
          ]
        : null;
    },
  },
  mode: {
    priority: 55,
    resolve: (ctx) =>
      ctx.banner.currentMode
        ? [
            {
              text: ctx.banner.currentMode,
              token: "rule-meta",
              // Double-click to pick, matching agent and model rather than
              // cycling in place. Cycle-on-single-click used to live here,
              // but the two can't share a chunk: the first click of a
              // double has already changed the mode by the time the chooser
              // opens, so backing out with Esc would leave you somewhere you
              // never asked to be. Shift+Tab still cycles.
              doubleAction: "choose-mode",
              value: "mode",
            },
          ]
        : null,
  },
  // The keybinding cheatsheet on the bottom composer rule ("⇧⇥ mode ·
  // ^p pick · ^g guide · ^d detach"). Named helpHint, not hint, to keep
  // it distinct from the banner's raw `hint` string it is derived from.
  helpHint: {
    priority: 20,
    resolve: () => null,
    resolveGroups: helpHintGroups,
  },
};

export const FIELD_IDS = Object.keys(FIELDS);

/**
 * Search progress, compaction/synthesis progress and every notify()
 * message. Deliberately NOT in FIELDS: this is the app's only
 * out-of-band channel, and making it an ordinary optional field meant
 * emptying composer.bottom.right silently discarded ~180 call sites'
 * worth of messages with no warning. drawBar force-renders it over
 * composer.bottom.right for the duration of the message instead, so
 * there is nothing for a user to remember to keep.
 *
 * Priority Infinity: it displaces whatever else is on that row rather
 * than being shed by it.
 */
export function transientGroup(ctx: FieldContext): FieldGroup | null {
  if (ctx.transient === null) {
    return null;
  }
  const token: ThemeToken =
    ctx.transient.kind === "search" ? "bar-indicator" : "modal-note";
  return {
    id: "transient",
    chunks: [{ text: ctx.transient.text, token }],
    priority: Infinity,
  };
}
