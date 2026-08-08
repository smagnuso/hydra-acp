// Shared layout engine for the three chrome rows at the bottom of the
// TUI: composer.top (the rule above the prompt), composer.bottom (the
// rule below it) and the sessionbar (the last terminal row).
//
// Every row has the same shape:
//
//   <prefix><pad><left content><pad><fill...><pad><right content><pad><suffix>
//
// with `pad` emitted only on the sides that actually have content, and
// `fill` absorbing whatever slack is left. That one template reproduces
// all three rows exactly:
//
//   top         prefix "──"  suffix "──"  fill "─"  pad " "
//   bottom      prefix ""    suffix "──"  fill "─"  pad " "
//   sessionbar  prefix ""    suffix ""    fill " "  pad ""   minGap 1
//
// When the two sides would collide the engine sheds whole fields in
// ascending priority order, then shrinks the ones marked `flex` down to
// their `minWidth`, then hard-truncates. Previously each row rolled its
// own arithmetic and two of the three simply overflowed the terminal
// width and wrapped.

import stringWidth from "string-width";
import type { ThemeToken } from "../theme/index.js";
import { CHROME_ACTIONS, type ChromeAction } from "../chrome-action.js";

/**
 * What a click on a bar chunk does. The vocabulary is shared with the
 * sidebar (see chrome-action.ts) so both dispatch through one function;
 * `BarAction` remains the name the bar modules use for it.
 */
export type BarAction = ChromeAction;

export const BAR_ACTIONS: readonly BarAction[] = CHROME_ACTIONS;

/** One painted run of text. Fields resolve to zero or more of these. */
export interface Chunk {
  text: string;
  token: ThemeToken;
  /**
   * Stable identity for hover tracking and hit dispatch, unique within
   * a row. Filled in by resolveSide from the field group id; chunks
   * without one are decoration (separators, rules, padding).
   */
  id?: string;
  /** Left-click action. Omitted or "none" means inert. */
  action?: BarAction;
  /** Double-click action. Falls back to nothing, not to `action`. */
  doubleAction?: BarAction;
  /**
   * Payload for "copy" / "open". Defaults to the chunk text, which is
   * wrong for anything abbreviated — `cwd` renders "~/dev/x" but must
   * open "/home/me/dev/x", and a truncated title must copy in full.
   */
  value?: string;
  /** May be truncated rather than dropped when space runs out. */
  flex?: boolean;
  /** Floor for a flex chunk, in columns. Ignored when !flex. */
  minWidth?: number;
}

/** A click target on a painted row. */
export interface HitRegion {
  id: string;
  /** 1-based inclusive column range. */
  start: number;
  end: number;
  action: BarAction;
  doubleAction: BarAction;
  value: string;
}

/**
 * Chunks contributed by one configured field, kept together so shedding
 * removes a field as a unit (a half-dropped "12.4k/200.0k · $0.31" would
 * be worse than no usage readout at all).
 */
export interface FieldGroup {
  /** Field id, for diagnostics and the skip-separator rules. */
  id: string;
  chunks: Chunk[];
  /**
   * Shed order. Lower goes first when the row overflows. Fields that
   * must never disappear use Infinity.
   */
  priority: number;
  /** Separator painted before this group, overriding the slot default. */
  separator?: string;
}

export interface SlotStyle {
  prefix: string;
  suffix: string;
  fill: string;
  pad: string;
  /** Separator inserted between adjacent field groups. */
  separator: string;
  separatorToken: ThemeToken;
  /** Token for prefix/suffix/fill. */
  ruleToken: ThemeToken;
  /** Token for the pad runs. */
  padToken: ThemeToken;
  /** Minimum columns of fill between the two sides. */
  minGap: number;
}

/** A chunk placed at a known column, ready to paint. */
export interface PlacedChunk extends Chunk {
  /** 1-based inclusive start column. */
  start: number;
  width: number;
}

export interface LayoutResult {
  chunks: PlacedChunk[];
  /** Signature capturing everything that affects visible output. */
  signature: string;
  /** Click targets, in paint order. */
  hits: HitRegion[];
}

function widthOf(chunks: Chunk[]): number {
  let total = 0;
  for (const c of chunks) {
    total += stringWidth(c.text);
  }
  return total;
}

/**
 * Splice slot separators between groups and flatten to chunks. Groups
 * that resolved to nothing were already dropped by the caller, so no
 * separator can end up dangling against an empty field — the bug the
 * old bottom-separator had, where a leading " · " was painted before
 * the first hint chunk and pushed the row three columns past the
 * terminal width.
 */
function flatten(groups: FieldGroup[], style: SlotStyle): Chunk[] {
  const out: Chunk[] = [];
  for (const g of groups) {
    if (out.length > 0) {
      const sep = g.separator ?? style.separator;
      if (sep.length > 0) {
        out.push({ text: sep, token: style.separatorToken });
      }
    }
    out.push(...g.chunks);
  }
  return out;
}

/**
 * Shrink flex chunks so the side fits in `budget` columns. Takes from
 * the widest overshoot first so one very long field (a deep cwd) gives
 * ground before a short one (a title) is touched.
 */
function shrink(chunks: Chunk[], budget: number): Chunk[] {
  let over = widthOf(chunks) - budget;
  if (over <= 0) {
    return chunks;
  }
  const result = chunks.map((c) => ({ ...c }));
  const flexIdx = result
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.flex === true)
    .map(({ i }) => i);
  while (over > 0 && flexIdx.length > 0) {
    // Pick the flex chunk with the most room above its floor.
    let best = -1;
    let bestSlack = 0;
    for (const i of flexIdx) {
      const c = result[i];
      if (c === undefined) continue;
      const slack = stringWidth(c.text) - (c.minWidth ?? 0);
      if (slack > bestSlack) {
        bestSlack = slack;
        best = i;
      }
    }
    if (best < 0) {
      break;
    }
    const c = result[best];
    if (c === undefined) break;
    const take = Math.min(over, bestSlack);
    const target = stringWidth(c.text) - take;
    c.text = truncateToWidth(c.text, target);
    over -= take;
  }
  return result;
}

/**
 * Width-correct right truncation with an ellipsis. Deliberately local
 * rather than reaching into screen.ts: the layout engine is imported by
 * screen.ts, and the reverse edge would be a cycle.
 */
export function truncateToWidth(text: string, max: number): string {
  if (max <= 0) {
    return "";
  }
  if (stringWidth(text) <= max) {
    return text;
  }
  if (max === 1) {
    return "…";
  }
  const chars = [...text];
  let acc = "";
  let w = 0;
  for (const ch of chars) {
    const cw = stringWidth(ch);
    if (w + cw > max - 1) {
      break;
    }
    acc += ch;
    w += cw;
  }
  return acc + "…";
}

/** Drop the whole tail of a side that still will not fit. */
function hardTruncate(chunks: Chunk[], budget: number): Chunk[] {
  const out: Chunk[] = [];
  let used = 0;
  for (const c of chunks) {
    const remaining = budget - used;
    if (remaining <= 0) {
      break;
    }
    const w = stringWidth(c.text);
    if (w <= remaining) {
      out.push(c);
      used += w;
    } else {
      out.push({ ...c, text: truncateToWidth(c.text, remaining) });
      break;
    }
  }
  return out;
}

/**
 * Lay out one chrome row.
 *
 * `left` and `right` are already-resolved field groups; groups that
 * produced no chunks must be filtered out by the caller.
 */
export function layoutRow(
  width: number,
  left: FieldGroup[],
  right: FieldGroup[],
  style: SlotStyle,
): LayoutResult {
  const fixed = stringWidth(style.prefix) + stringWidth(style.suffix);
  const padW = stringWidth(style.pad);

  let leftGroups = [...left];
  let rightGroups = [...right];

  // Measure at the *smallest* the current field set could render at:
  // flex chunks count as their minWidth. Shedding only kicks in once
  // even the fully-shrunk row would not fit, so a long cwd gets an
  // ellipsis rather than disappearing while a short title survives.
  const minWidthOf = (chunks: Chunk[]): number => {
    let total = 0;
    for (const c of chunks) {
      const w = stringWidth(c.text);
      total += c.flex === true ? Math.min(w, c.minWidth ?? 0) : w;
    }
    return total;
  };
  const measure = (): number => {
    const l = flatten(leftGroups, style);
    const r = flatten(rightGroups, style);
    return (
      fixed +
      (l.length > 0 ? minWidthOf(l) + padW * 2 : 0) +
      (r.length > 0 ? minWidthOf(r) + padW * 2 : 0) +
      style.minGap
    );
  };

  // 1. Shed whole fields, lowest priority first, until it fits or only
  //    unsheddable fields remain. Both sides compete in one ordering so
  //    a low-value left field goes before a high-value right one.
  while (measure() > width) {
    let victimSide: "l" | "r" | null = null;
    let victimIdx = -1;
    let victimPriority = Infinity;
    leftGroups.forEach((g, i) => {
      if (g.priority < victimPriority) {
        victimPriority = g.priority;
        victimSide = "l";
        victimIdx = i;
      }
    });
    rightGroups.forEach((g, i) => {
      if (g.priority < victimPriority) {
        victimPriority = g.priority;
        victimSide = "r";
        victimIdx = i;
      }
    });
    if (victimSide === null || victimPriority === Infinity) {
      break;
    }
    if (victimSide === "l") {
      leftGroups = leftGroups.filter((_, i) => i !== victimIdx);
    } else {
      rightGroups = rightGroups.filter((_, i) => i !== victimIdx);
    }
  }

  let leftChunks = flatten(leftGroups, style);
  let rightChunks = flatten(rightGroups, style);

  // 2. Shrink flex chunks. The right side is reserved first (it is the
  //    anchored edge on every row), so the left absorbs the deficit.
  const overhead =
    fixed +
    (leftChunks.length > 0 ? padW * 2 : 0) +
    (rightChunks.length > 0 ? padW * 2 : 0) +
    style.minGap;
  let avail = Math.max(0, width - overhead);
  const rightW = widthOf(rightChunks);
  if (widthOf(leftChunks) + rightW > avail) {
    leftChunks = shrink(leftChunks, Math.max(0, avail - rightW));
  }
  if (widthOf(leftChunks) + widthOf(rightChunks) > avail) {
    rightChunks = shrink(rightChunks, Math.max(0, avail - widthOf(leftChunks)));
  }

  // 3. Last resort: chop. Keeps the row inside the terminal even at
  //    absurd widths, where the old code wrapped.
  if (widthOf(leftChunks) + widthOf(rightChunks) > avail) {
    rightChunks = hardTruncate(rightChunks, avail);
    leftChunks = hardTruncate(leftChunks, Math.max(0, avail - widthOf(rightChunks)));
  }

  // 4. Place.
  const placed: PlacedChunk[] = [];
  const hits: HitRegion[] = [];
  let col = 1;
  const emit = (text: string, token: ThemeToken, meta?: Chunk): void => {
    if (text.length === 0) {
      return;
    }
    const w = stringWidth(text);
    const chunk: PlacedChunk = { ...(meta ?? {}), text, token, start: col, width: w };
    placed.push(chunk);
    // A region is recorded for every identified chunk, action or not:
    // hover feedback and "which field is under the pointer" are useful
    // even for inert ones, and dispatch checks the action separately.
    if (chunk.id !== undefined) {
      const existing = hits.find((h) => h.id === chunk.id);
      if (existing !== undefined) {
        // Multi-run field (a prefix/suffix pair): widen the region
        // rather than registering a second target.
        existing.end = col + w - 1;
      } else {
        hits.push({
          id: chunk.id,
          start: col,
          end: col + w - 1,
          action: chunk.action ?? "none",
          doubleAction: chunk.doubleAction ?? "none",
          value: chunk.value ?? chunk.text,
        });
      }
    }
    col += w;
  };

  emit(style.prefix, style.ruleToken);
  if (leftChunks.length > 0) {
    emit(style.pad, style.padToken);
    for (const c of leftChunks) {
      emit(c.text, c.token, c);
    }
    emit(style.pad, style.padToken);
  }
  const consumed =
    fixed +
    (leftChunks.length > 0 ? widthOf(leftChunks) + padW * 2 : 0) +
    (rightChunks.length > 0 ? widthOf(rightChunks) + padW * 2 : 0);
  const fillCols = Math.max(style.minGap, width - consumed);
  if (fillCols > 0 && style.fill.length > 0) {
    emit(style.fill.repeat(fillCols), style.ruleToken);
  }
  if (rightChunks.length > 0) {
    emit(style.pad, style.padToken);
    for (const c of rightChunks) {
      emit(c.text, c.token, c);
    }
    emit(style.pad, style.padToken);
  }
  emit(style.suffix, style.ruleToken);

  const signature = placed.map((c) => `${c.token}\u0001${c.text}`).join("\u0000");
  return { chunks: placed, signature, hits };
}
