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

function statusLabel(ctx: FieldContext): { label: string; token: ThemeToken } {
  const status = ctx.banner.status;
  const stalled = status === "busy" && ctx.banner.stalled === true;
  let label: string;
  if (ctx.statusLabel !== undefined) {
    label = ctx.statusLabel;
  } else if (stalled) {
    label = "Stalled";
  } else if (status === "busy") {
    label = "Busy";
  } else {
    label = status.charAt(0).toUpperCase() + status.slice(1);
  }
  let token: ThemeToken;
  if (stalled || status === "disconnected") {
    token = "status-alert";
  } else if (status === "busy") {
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

// The help-hint string is authored as " · "-joined chunks, each one an
// independently hoverable and clickable target, so the field emits one
// group per chunk. Everything else in the registry is a single group.
//
// Which application effect a hint chunk fires. The mapping is by
// substring because the hint string is authored as prose in app.ts, not
// as structured data.
function helpHintAction(part: string): {
  action: "toggle-mode" | "switch-session" | "show-help" | "detach" | "none";
  key: string;
} {
  if (part.includes("mode")) return { action: "toggle-mode", key: "mode" };
  if (part.includes("pick")) return { action: "switch-session", key: "pick" };
  if (part.includes("guide")) return { action: "show-help", key: "guide" };
  if (part.includes("detach")) return { action: "detach", key: "detach" };
  return { action: "none", key: "" };
}

function helpHintGroups(ctx: FieldContext): FieldGroup[] | null {
  if (ctx.transient !== null) {
    return null;
  }
  const base = ctx.banner.currentMode
    ? ctx.banner.hint.replace("⇧⇥ mode", `⇧⇥ mode: ${ctx.banner.currentMode}`)
    : ctx.banner.hint;
  if (base.length === 0) {
    return null;
  }
  const parts = base.split(" · ").filter((p) => p.length > 0);
  return parts.map((part, i) => {
    const { action, key } = helpHintAction(part);
    const chunk: Chunk = { text: part, token: "modal-hint", action };
    // Keep the legacy hit names as the group id so bannerHitAt keeps
    // answering "mode" / "pick" / "guide" / "detach".
    return {
      id: key !== "" ? key : `helpHint:${i}`,
      chunks: [chunk],
      // Leftmost hint is the most important, so it sheds last.
      priority: 20 + (parts.length - i),
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
      // Copies the *full* id, not the abbreviated form on screen —
      // pasting "a1b2c3d4e5" into `hydra session info` would not
      // resolve. On the btw frame the id names the fork, where a single
      // click has always jumped to it.
      const chunk: Chunk = {
        text: sid,
        token: "rule-meta",
        doubleAction: "copy",
        value: ctx.session.sessionId,
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
    resolve: (ctx) => {
      const text = shortenHomePath(ctx.session.cwd);
      // Double-click hands the *absolute* path to tui.openFileCommand
      // (the display form is ~-abbreviated and may be truncated).
      return text
        ? [
            {
              text,
              token: "bar-text",
              flex: true,
              minWidth: 8,
              doubleAction: "open",
              value: ctx.session.cwd,
            },
          ]
        : null;
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
      return t
        ? [
            {
              text: t,
              token: "bar-text",
              flex: true,
              minWidth: 8,
              doubleAction: "copy",
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
        ? [{ text: ctx.session.agent, token: "content", doubleAction: "copy" }]
        : null,
  },
  model: {
    priority: 65,
    resolve: (ctx) =>
      ctx.session.model
        ? [{ text: ctx.session.model, token: "content", doubleAction: "copy" }]
        : null,
  },
  agentModel: {
    priority: 80,
    resolve: (ctx) => {
      const text = formatAgentWithModel(ctx.session.agent, ctx.session.model);
      return text
        ? [
            {
              text,
              token: "content",
              flex: true,
              minWidth: 6,
              doubleAction: "copy",
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
              action: "toggle-mode",
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
  // Search progress / compaction and synthesis toasts. Outranks
  // `helpHint`, and `helpHint` suppresses itself while one is active, so
  // listing both in a slot gives "transient replaces the hints".
  transient: {
    priority: 90,
    resolve: (ctx) => {
      if (ctx.transient === null) {
        return null;
      }
      const token: ThemeToken =
        ctx.transient.kind === "search" ? "bar-indicator" : "modal-note";
      return [{ text: ctx.transient.text, token }];
    },
  },
};

export const FIELD_IDS = Object.keys(FIELDS);
