// Turns the declarative slot config into resolved FieldGroups, and
// holds the per-row style constants (prefix / suffix / fill / pad) that
// used to be string literals scattered through the three draw methods.

import type { BarSideConfig, BarSlotEntry } from "../../core/config.js";
import {
  DEFAULT_COMPOSER_BOTTOM_LEFT,
  DEFAULT_COMPOSER_BOTTOM_RIGHT,
  DEFAULT_COMPOSER_TOP_LEFT,
  DEFAULT_COMPOSER_TOP_RIGHT,
  DEFAULT_SESSIONBAR_LEFT,
  DEFAULT_SESSIONBAR_RIGHT,
} from "../../core/config.js";
import { FIELDS } from "./fields.js";
import type { BarAction, Chunk, FieldGroup, SlotStyle } from "./layout.js";
import { BAR_ACTIONS } from "./layout.js";
import { truncateToWidth } from "./layout.js";
import type { ThemeToken } from "../theme/index.js";
import type { BarLayoutConfig, FieldContext } from "./types.js";

export type SlotName =
  | "composerTop"
  | "composerBottom"
  | "sessionbar"
  | "btw";

// The only thing that differs between the three rows once the content
// is config-driven. Verified against the pre-refactor output:
//
//   top         "── " + left + " " + ───… + " " + right + " ──"
//   bottom             ───… + " " + right + " ──"
//   sessionbar         left + "   …   " + right
export const SLOT_STYLES: Record<SlotName, SlotStyle> = {
  composerTop: {
    prefix: "──",
    suffix: "──",
    fill: "─",
    pad: " ",
    separator: " · ",
    separatorToken: "rule-meta",
    ruleToken: "rule",
    padToken: "rule-pad",
    minGap: 0,
  },
  composerBottom: {
    prefix: "",
    suffix: "──",
    fill: "─",
    pad: " ",
    separator: " · ",
    separatorToken: "rule-meta",
    ruleToken: "rule",
    padToken: "rule-pad",
    minGap: 0,
  },
  // The frame above the btw overlay. Same style *and* same content
  // config as composerTop — it was always showing the same three things
  // (a status label, a session id, a usage readout), just hardcoded.
  // Only the data behind them differs: the fork's id and usage, and a
  // "By the way" label in place of the turn status.
  btw: {
    prefix: "──",
    suffix: "──",
    fill: "─",
    pad: " ",
    separator: " · ",
    separatorToken: "rule-meta",
    ruleToken: "rule",
    padToken: "rule-pad",
    minGap: 0,
  },
  sessionbar: {
    prefix: "",
    suffix: "",
    fill: " ",
    pad: "",
    separator: " · ",
    separatorToken: "content",
    ruleToken: "content",
    padToken: "content",
    minGap: 1,
  },
};

// Stands in for "everything the built-in layout puts here". Lets a user
// append one field without restating the default list — which they
// would otherwise have to copy verbatim, freezing today's defaults into
// their config and, worse, having to know that `elapsed` needs
// {"separator": " "} to render "Busy 1m 2s" rather than "Busy · 1m 2s".
export const DEFAULTS_SENTINEL = "...";

const SIDE_DEFAULTS: Record<SlotName, { left: BarSideConfig; right: BarSideConfig }> = {
  composerTop: {
    left: DEFAULT_COMPOSER_TOP_LEFT,
    right: DEFAULT_COMPOSER_TOP_RIGHT,
  },
  // The btw frame renders composer.top's slot list, so "..." there means
  // composer.top's defaults too.
  btw: {
    left: DEFAULT_COMPOSER_TOP_LEFT,
    right: DEFAULT_COMPOSER_TOP_RIGHT,
  },
  composerBottom: {
    left: DEFAULT_COMPOSER_BOTTOM_LEFT,
    right: DEFAULT_COMPOSER_BOTTOM_RIGHT,
  },
  sessionbar: {
    left: DEFAULT_SESSIONBAR_LEFT,
    right: DEFAULT_SESSIONBAR_RIGHT,
  },
};

function fieldIdOf(entry: BarSlotEntry): string | null {
  if (typeof entry === "string") {
    return entry === DEFAULTS_SENTINEL ? null : entry;
  }
  return entry.field ?? null;
}

/**
 * Splice the built-in list in wherever "..." appears.
 *
 * A field named explicitly elsewhere in the list is dropped from the
 * expansion, so ["status", "cwd", "..."] repositions nothing and
 * duplicates nothing — it yields status, cwd, elapsed, sessionId,
 * queued, scroll. That rule is what makes "move a field to the front"
 * expressible without also having to delete it from the tail.
 *
 * Only the first "..." expands; later ones are dropped. Two expansions
 * would duplicate every field, which is never what anyone means.
 */
export function expandSide(
  slot: SlotName,
  side: "left" | "right",
  entries: BarSideConfig,
): BarSideConfig {
  if (!entries.some((e) => e === DEFAULTS_SENTINEL)) {
    return entries;
  }
  const explicit = new Set<string>();
  for (const e of entries) {
    const id = fieldIdOf(e);
    if (id !== null) {
      explicit.add(id);
    }
  }
  const expansion = SIDE_DEFAULTS[slot][side].filter((d) => {
    const id = fieldIdOf(d);
    return id === null || !explicit.has(id);
  });
  const out: BarSideConfig = [];
  let expanded = false;
  for (const e of entries) {
    if (e === DEFAULTS_SENTINEL) {
      if (!expanded) {
        out.push(...expansion);
        expanded = true;
      }
      continue;
    }
    out.push(e);
  }
  return out;
}

function normalize(entry: BarSlotEntry): {
  field?: string;
  text?: string;
  maxWidth?: number;
  minWidth?: number;
  priority?: number;
  prefix?: string;
  suffix?: string;
  separator?: string;
  style?: string;
  onClick?: string;
  onDoubleClick?: string;
} {
  return typeof entry === "string" ? { field: entry } : entry;
}

/**
 * Resolve one side of a slot. Entries whose field has nothing to say
 * are dropped here, so the layout engine never sees a group that would
 * leave a dangling separator.
 */
function asAction(name: string | undefined): BarAction | undefined {
  if (name === undefined) {
    return undefined;
  }
  return (BAR_ACTIONS as readonly string[]).includes(name)
    ? (name as BarAction)
    : "none";
}

/**
 * Stamp each chunk of a group with the group's identity, so the layout
 * engine can register one hit region per field and the hover diff has
 * something stable to compare against across repaints.
 */
function identify(slot: string, group: FieldGroup): FieldGroup {
  const id = `${slot}:${group.id}`;
  return { ...group, chunks: group.chunks.map((c) => ({ ...c, id })) };
}

export function resolveSide(
  slot: SlotName,
  side: BarSideConfig,
  ctx: FieldContext,
): FieldGroup[] {
  const groups: FieldGroup[] = [];
  for (const raw of side) {
    const e = normalize(raw);
    let chunks: Chunk[] | null;
    let id: string;
    let basePriority: number;
    if (e.text !== undefined) {
      id = `text:${e.text}`;
      basePriority = 10;
      chunks = e.text.length > 0 ? [{ text: e.text, token: "rule-meta" }] : null;
    } else {
      id = e.field ?? "";
      const def = FIELDS[id];
      if (def === undefined) {
        // Unknown ids are ignored rather than fatal: a config written
        // against a newer build should degrade, not blank the bar.
        continue;
      }
      basePriority = def.priority;
      if (def.resolveGroups !== undefined) {
        // Multi-unit field: emit its groups as-is, only applying the
        // per-entry priority override if one was given.
        const sub = def.resolveGroups(ctx);
        if (sub === null) {
          continue;
        }
        const click = asAction(e.onClick);
        const dbl = asAction(e.onDoubleClick);
        for (const g of sub) {
          const group: FieldGroup = {
            ...g,
            priority: e.priority ?? g.priority,
            chunks: g.chunks.map((c) => ({
              ...c,
              ...(click !== undefined ? { action: click } : {}),
              ...(dbl !== undefined ? { doubleAction: dbl } : {}),
            })),
          };
          if (e.separator !== undefined && groups.length === 0) {
            group.separator = e.separator;
          }
          groups.push(identify(slot, group));
        }
        continue;
      }
      chunks = def.resolve(ctx);
    }
    if (chunks === null || chunks.length === 0) {
      continue;
    }
    if (e.style !== undefined) {
      const token = e.style as ThemeToken;
      chunks = chunks.map((c) => ({ ...c, token }));
    }
    if (e.minWidth !== undefined) {
      chunks = chunks.map((c) => ({ ...c, flex: true, minWidth: e.minWidth }));
    }
    if (e.maxWidth !== undefined) {
      const max = e.maxWidth;
      chunks = chunks.map((c) => ({ ...c, text: truncateToWidth(c.text, max) }));
      chunks = chunks.filter((c) => c.text.length > 0);
      if (chunks.length === 0) {
        continue;
      }
    }
    if (e.prefix !== undefined && e.prefix.length > 0) {
      const first = chunks[0];
      if (first !== undefined) {
        chunks = [{ text: e.prefix, token: first.token }, ...chunks];
      }
    }
    if (e.suffix !== undefined && e.suffix.length > 0) {
      const last = chunks[chunks.length - 1];
      if (last !== undefined) {
        chunks = [...chunks, { text: e.suffix, token: last.token }];
      }
    }
    const click = asAction(e.onClick);
    const dbl = asAction(e.onDoubleClick);
    if (click !== undefined || dbl !== undefined) {
      chunks = chunks.map((c) => ({
        ...c,
        ...(click !== undefined ? { action: click } : {}),
        ...(dbl !== undefined ? { doubleAction: dbl } : {}),
      }));
    }
    const group: FieldGroup = {
      id,
      chunks,
      priority: e.priority ?? basePriority,
    };
    if (e.separator !== undefined) {
      group.separator = e.separator;
    }
    groups.push(identify(slot, group));
  }
  return groups;
}

/**
 * Resolve every "..." in a whole layout config. Done once when the
 * config lands rather than per frame: expansion is pure and the result
 * is what the render path reads sixty times a second.
 */
export function expandBarConfig(cfg: BarLayoutConfig): BarLayoutConfig {
  const side = (
    slot: SlotName,
    s: { left: BarSideConfig; right: BarSideConfig },
  ): { left: BarSideConfig; right: BarSideConfig } => ({
    left: expandSide(slot, "left", s.left),
    right: expandSide(slot, "right", s.right),
  });
  return {
    composer: {
      top: side("composerTop", cfg.composer.top),
      bottom: side("composerBottom", cfg.composer.bottom),
    },
    sessionbar: side("sessionbar", cfg.sessionbar),
  };
}
