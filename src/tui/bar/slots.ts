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

// Script entries need no special handling here: a bare "$(...)" string
// returns itself, which never collides with a SIDE_DEFAULTS id, and an
// object-form { script } entry returns null (entry.field is undefined),
// same as a text-only entry today.
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

// A bare string of the form "$(some command)" is sugar for a script
// entry, same relationship as any other bare string being sugar for
// { field: entry }. Checked first since it's the more specific shape.
const SCRIPT_SUGAR = /^\$\((.+)\)\s*$/;

function normalize(entry: BarSlotEntry): {
  field?: string;
  text?: string;
  script?: string;
  refreshMs?: number;
  maxWidth?: number;
  minWidth?: number;
  priority?: number;
  prefix?: string;
  suffix?: string;
  separator?: string;
  style?: string;
  truncate?: boolean;
  onClick?: string;
  onDoubleClick?: string;
} {
  if (typeof entry !== "string") {
    return entry;
  }
  const sugar = SCRIPT_SUGAR.exec(entry);
  const command = sugar?.[1];
  return command !== undefined ? { script: command } : { field: entry };
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

type Entry = ReturnType<typeof normalize>;

/**
 * The per-entry overrides that act on a chunk at a time. Null when
 * `maxWidth` truncated every chunk away.
 */
function restyle(chunks: Chunk[], e: Entry): Chunk[] | null {
  let out = chunks;
  if (e.style !== undefined) {
    const token = e.style as ThemeToken;
    out = out.map((c) => ({ ...c, token }));
  }
  if (e.minWidth !== undefined) {
    out = out.map((c) => ({ ...c, flex: true, minWidth: e.minWidth }));
  }
  if (e.maxWidth !== undefined) {
    const max = e.maxWidth;
    out = out
      .map((c) => ({ ...c, text: truncateToWidth(c.text, max) }))
      .filter((c) => c.text.length > 0);
    if (out.length === 0) {
      return null;
    }
  }
  if (e.truncate === false) {
    out = out.map((c) => ({ ...c, truncatable: false }));
  }
  return out;
}

/**
 * Wrap the whole entry in its prefix/suffix — the outer edges of the
 * first and last group, not of every group, so a bracketed multi-group
 * field reads as "[a b]" rather than "[a] [b]".
 */
function bracket(groups: FieldGroup[], e: Entry): FieldGroup[] {
  const out = groups.map((g) => ({ ...g, chunks: [...g.chunks] }));
  const first = out[0];
  if (e.prefix !== undefined && e.prefix.length > 0 && first !== undefined) {
    const head = first.chunks[0];
    if (head !== undefined) {
      first.chunks.unshift({ text: e.prefix, token: head.token });
    }
  }
  const last = out[out.length - 1];
  if (e.suffix !== undefined && e.suffix.length > 0 && last !== undefined) {
    const tail = last.chunks[last.chunks.length - 1];
    if (tail !== undefined) {
      last.chunks.push({ text: e.suffix, token: tail.token });
    }
  }
  return out;
}

export function resolveSide(
  slot: SlotName,
  side: BarSideConfig,
  ctx: FieldContext,
): FieldGroup[] {
  const groups: FieldGroup[] = [];
  for (const raw of side) {
    const e = normalize(raw);
    // Every entry becomes a list of groups, whether the field emits one
    // unit or several, so the per-entry overrides below have a single
    // shape to act on.
    let produced: FieldGroup[];
    if (e.text !== undefined) {
      if (e.text.length === 0) {
        continue;
      }
      produced = [
        {
          id: `text:${e.text}`,
          priority: 10,
          chunks: [{ text: e.text, token: "rule-meta" }],
        },
      ];
    } else if (e.script !== undefined) {
      // Nothing cached yet (first run still pending) or the last run
      // produced no output: drop out like any other field with nothing
      // to report, rather than blanking the row with an empty chunk.
      const out = ctx.scriptOutputs.get(e.script);
      if (out === undefined || out.length === 0) {
        continue;
      }
      produced = [
        {
          id: `script:${e.script}`,
          priority: 10,
          chunks: [{ text: out, token: "rule-meta" }],
        },
      ];
    } else {
      const id = e.field ?? "";
      const def = FIELDS[id];
      if (def === undefined) {
        // Unknown ids are ignored rather than fatal: a config written
        // against a newer build should degrade, not blank the bar.
        continue;
      }
      if (def.resolveGroups !== undefined) {
        const sub = def.resolveGroups(ctx);
        if (sub === null) {
          continue;
        }
        produced = sub;
      } else {
        const chunks = def.resolve(ctx);
        if (chunks === null || chunks.length === 0) {
          continue;
        }
        produced = [{ id, priority: def.priority, chunks }];
      }
    }

    let out: FieldGroup[] = [];
    for (const g of produced) {
      const chunks = restyle(g.chunks, e);
      if (chunks === null) {
        continue;
      }
      out.push({ ...g, priority: e.priority ?? g.priority, chunks });
    }
    if (out.length === 0) {
      continue;
    }
    out = bracket(out, e);

    // Actions last, so a prefix/suffix chunk carries them too: the
    // layout engine reads the action off the first chunk of a hit
    // region, and an inert bracket there would make the field dead.
    const click = asAction(e.onClick);
    const dbl = asAction(e.onDoubleClick);
    if (click !== undefined || dbl !== undefined) {
      out = out.map((g) => ({
        ...g,
        chunks: g.chunks.map((c) => ({
          ...c,
          ...(click !== undefined ? { action: click } : {}),
          ...(dbl !== undefined ? { doubleAction: dbl } : {}),
        })),
      }));
    }
    // A separator sits *before* a group, so an override belongs on the
    // entry's first one; the rest keep whatever the field asked for.
    const head = out[0];
    if (e.separator !== undefined && head !== undefined) {
      head.separator = e.separator;
    }
    for (const g of out) {
      groups.push(identify(slot, g));
    }
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
