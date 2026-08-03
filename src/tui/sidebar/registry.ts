// Gadget registry + the memoizing layout pass.
//
// SidebarRenderer owns one cache entry per gadget, keyed on the gadget's
// versionKey. A repaint therefore re-renders only the gadgets whose
// inputs actually changed — the 1 Hz busy tick dirties `activity` and
// nothing else, which matters because repaint() runs the whole layout on
// every frame.
//
// The renderer returns a flat FormattedLine[] for the column; screen.ts
// paints it row by row with its own signature cache, so an unchanged
// gadget also costs zero terminal bytes.

import type { FormattedLine } from "../format.js";
import { BUILTIN_GADGETS } from "./gadgets.js";
import { isFramedBorder } from "./types.js";
import type {
  Gadget,
  SidebarAction,
  SidebarContext,
  SidebarLine,
  SidebarSnapshot,
} from "./types.js";

export const DEFAULT_GADGET_IDS = [
  "activity",
  "context",
  "queue",
  "todo",
  "files",
  "git",
  "resources",
  "session",
  "tools",
] as const;

export function gadgetById(id: string): Gadget | undefined {
  return BUILTIN_GADGETS.find((g) => g.id === id);
}

export function knownGadgetIds(): string[] {
  return BUILTIN_GADGETS.map((g) => g.id);
}

// Emitted between gadget blocks in "none" / "rule" mode. Frozen and
// shared rather than allocated per frame.
const BLOCK_SEPARATOR: SidebarLine = Object.freeze({ body: "" });
// Same, for "rule" mode, where the vertical edge runs unbroken through
// the separators too.
const BLOCK_SEPARATOR_RULE: SidebarLine = Object.freeze({
  body: "",
  gutter: "│",
});

// Junctions used by "frame" mode. Which one a rule gets is purely
// positional: the glyph has to agree with whether the vertical edge
// continues above and/or below it, or the frame reads as broken.
type FrameJunction = "┌" | "├" | "└";

function blockRule(width: number, junction: FrameJunction): SidebarLine {
  return {
    body: "─".repeat(Math.max(0, width)),
    bodyStyle: "dim",
    gutter: junction,
  };
}

// Marks a folded gadget. ASCII and single-width on purpose — it sits at
// the right edge of a row whose left side is right-aligned against it.
const COLLAPSED_MARK = "+";

// Pager glyphs. Single characters so the control costs 7 body columns at
// most ("‹ 9/9 ›"), which fits even a 20-column body beside a short title.
const PAGE_PREV = "‹";
const PAGE_NEXT = "›";

// Window a block's item rows to the requested page and stamp the pager onto
// its title row. Returns the block unchanged when it fits on one page, so a
// short list never grows a control it doesn't need.
//
// The pager is right-aligned on the TITLE row rather than given a row of its
// own: a dedicated row would cost exactly the row that paging is trying to
// save. The arrows carry absolute target pages (not deltas) so clamping
// happens here, once, where the page count is known — and an arrow at the
// end of its range simply records no action, rendering inert.
function paginate(
  gadget: Gadget,
  block: SidebarLine[],
  ctx: SidebarContext,
  pageSize: number,
): SidebarLine[] {
  if (pageSize <= 0 || !Number.isFinite(pageSize)) {
    return block;
  }
  const itemCount = countItems(block);
  if (itemCount <= pageSize) {
    return block;
  }
  const pageCount = Math.ceil(itemCount / pageSize);
  const requested = ctx.pages?.[gadget.id] ?? 0;
  const page = Math.max(0, Math.min(pageCount - 1, requested));
  const from = page * pageSize;
  const to = from + pageSize;

  const out: SidebarLine[] = [];
  let seen = 0;
  for (const line of block) {
    if (line.item !== true) {
      out.push(line);
      continue;
    }
    const idx = seen++;
    if (idx >= from && idx < to) {
      out.push(line);
    }
  }

  // Stamp the pager onto the title row, which is the block's first row when
  // the gadget declares a title. Without one there's nowhere to put the
  // control, so the window still applies but silently.
  if (gadget.title === undefined || out.length === 0) {
    return out;
  }
  const { cellWidth, truncate } = ctx.metrics;
  const label = `${PAGE_PREV} ${page + 1}/${pageCount} ${PAGE_NEXT}`;
  const labelWidth = cellWidth(label);
  const room = ctx.width - labelWidth - 1;
  if (room < 1) {
    // Too narrow for title + pager; the window still applies, but showing a
    // truncated control would be worse than showing none.
    return out;
  }
  const title = truncate(gadget.title, room);
  const gap = ctx.width - cellWidth(title) - labelWidth;
  const body = `${title}${" ".repeat(Math.max(1, gap))}${label}`;
  // Body-relative columns of the two arrows (1-based).
  const prevCol = cellWidth(body) - labelWidth + 1;
  const nextCol = cellWidth(body);
  const actions: SidebarAction[] = [];
  // The title row already carries the collapse target across its full
  // width; clip it to the left of the pager so the arrows stay clickable.
  // Rebuilding the row from scratch here would silently drop it.
  for (const existing of out[0]!.actions ?? []) {
    if ("collapse" in existing && prevCol > 2) {
      actions.push({ ...existing, start: 1, end: prevCol - 2 });
    }
  }
  if (page > 0) {
    actions.push({
      start: prevCol,
      end: prevCol,
      page: { gadget: gadget.id, index: page - 1 },
    });
  }
  if (page < pageCount - 1) {
    actions.push({
      start: nextCol,
      end: nextCol,
      page: { gadget: gadget.id, index: page + 1 },
    });
  }
  out[0] = { ...out[0]!, body, actions };
  return out;
}

function countItems(block: SidebarLine[]): number {
  return block.reduce((n, l) => n + (l.item === true ? 1 : 0), 0);
}

// The block's header: the gadget's title, plus its counter right-aligned if
// it has one and the row is wide enough to hold both. Same slot and same
// layout the pager uses — and paginate() overwrites this row when it fires,
// so the two can never collide.
function titleRow(
  gadget: Gadget,
  snapshot: SidebarSnapshot,
  ctx: SidebarContext,
  collapsed: boolean,
): SidebarLine {
  const title = gadget.title ?? "";
  const base = gadget.titleNote?.(snapshot, ctx);
  // A collapsed block is otherwise indistinguishable from one whose gadget
  // has nothing to say, so it earns a marker. Trailing and ASCII: a leading
  // glyph would shift the title, and an ambiguous-width one would shift it
  // by an amount the terminal and we disagree about (see the git rows).
  const note = collapsed
    ? base === undefined || base.length === 0
      ? COLLAPSED_MARK
      : `${base} ${COLLAPSED_MARK}`
    : base;
  // Clicking anywhere on the title folds the gadget away. paginate() clips
  // this span when it stamps its arrows onto the same row.
  const action: SidebarAction = {
    start: 1,
    end: ctx.width,
    collapse: { gadget: gadget.id },
  };
  if (note === undefined || note.length === 0) {
    return { body: title, bodyStyle: "dim", actions: [action] };
  }
  const { cellWidth, truncate } = ctx.metrics;
  const noteWidth = cellWidth(note);
  const room = ctx.width - noteWidth - 1;
  if (room < 1) {
    // Too narrow for both. The title identifies the block, so it wins.
    return { body: truncate(title, ctx.width), bodyStyle: "dim", actions: [action] };
  }
  const clipped = truncate(title, room);
  const gap = ctx.width - cellWidth(clipped) - noteWidth;
  return {
    body: `${clipped}${" ".repeat(Math.max(1, gap))}${note}`,
    bodyStyle: "dim",
    actions: [action],
  };
}

// Largest uniform page size that fits the column, or Infinity when every
// item fits and nothing needs windowing.
//
// Only ITEM rows are elastic: structural rows (titles, summary counts) and
// the border rules are present regardless, and the pager rides on the title
// row rather than claiming one of its own — so total height is
// `structural + Σ min(items, limit)` and the search is one-dimensional.
//
// Returns the largest limit that fits. When even one item per gadget
// overflows, that floor is returned anyway: the column scrolls, which is a
// better failure mode than pages of zero items.
//
// The limit is uniform across gadgets, so with N paginated gadgets the
// height moves in steps of N and up to N-1 rows can go unused. Distributing
// the remainder unevenly would reclaim them, at the cost of a column whose
// gadgets show different numbers of items for no reason the user can see.
function fitPageSize(
  blocks: SidebarLine[][],
  paginated: boolean[],
  structuralRows: number,
  maxRows: number,
): number {
  const itemCounts = blocks.map((b, i) => (paginated[i] ? countItems(b) : 0));
  const fixedItems = blocks.reduce(
    (n, b, i) => n + (paginated[i] ? 0 : countItems(b)),
    0,
  );
  const height = (limit: number): number =>
    structuralRows +
    fixedItems +
    itemCounts.reduce((n, count) => n + Math.min(count, limit), 0);

  const maxItems = Math.max(0, ...itemCounts);
  if (height(maxItems) <= maxRows) {
    return Number.POSITIVE_INFINITY;
  }
  let best = 1;
  for (let limit = 1; limit <= maxItems; limit++) {
    if (height(limit) <= maxRows) {
      best = limit;
    } else {
      break;
    }
  }
  return best;
}

interface CacheEntry {
  key: string;
  lines: SidebarLine[];
}

export class SidebarRenderer {
  private cache = new Map<string, CacheEntry>();
  // The bracket-mode bottom rule, memoized on width so an unchanged frame
  // returns the identical row object here too.
  // Frame rules, memoized per width. Three junctions share one entry
  // because they're always rendered at the same width in a given frame.
  private rules: {
    width: number;
    lines: Record<FrameJunction, SidebarLine>;
  } | null = null;
  private gadgets: Gadget[] = [];

  constructor(ids: readonly string[] = DEFAULT_GADGET_IDS) {
    this.setGadgets(ids);
  }

  // Unknown ids are dropped rather than throwing: the config is
  // hand-editable and a typo shouldn't take the TUI down. Order follows
  // the configured list, so users control the column layout.
  setGadgets(ids: readonly string[]): void {
    const next = ids
      .map((id) => gadgetById(id))
      .filter((g): g is Gadget => g !== undefined);
    const changed =
      next.length !== this.gadgets.length ||
      next.some((g, i) => g !== this.gadgets[i]);
    if (changed) {
      this.gadgets = next;
      this.cache.clear();
    }
  }

  configuredIds(): string[] {
    return this.gadgets.map((g) => g.id);
  }

  // True when the gadget is in the configured list at all. app.ts gates
  // data *collection* on this — the git poller must not shell out for a
  // gadget the user never asked for.
  isConfigured(id: string): boolean {
    return this.gadgets.some((g) => g.id === id);
  }

  invalidate(): void {
    this.cache.clear();
  }

  // Build the whole column, unclipped. Fitting it to the available height
  // is the screen layer's job: it windows this list and scrolls it under
  // the wheel, which is strictly better than dropping gadgets — nothing
  // becomes unreachable just because the terminal is short. Configured
  // order is therefore both display order and priority order: the column
  // is anchored so the first gadgets are the ones visible without
  // scrolling.
  render(snapshot: SidebarSnapshot, ctx: SidebarContext): SidebarLine[] {
    if (ctx.width <= 0) {
      return [];
    }
    const blocks: SidebarLine[][] = [];
    // Parallel to `blocks`; null for a gadget that never paginates.
    const pagedGadgets: Array<Gadget | null> = [];
    for (const gadget of this.gadgets) {
      if (!gadget.relevant(snapshot)) {
        continue;
      }
      // A folded gadget renders its title and nothing else. Note the
      // gadget's own render() is never called: not paying for a body
      // nobody is reading is half the point (the caller stops the
      // gadget's polling for the other half). A gadget with no title has
      // nothing to click and so can't be folded.
      const collapsed =
        gadget.title !== undefined && ctx.collapsed?.has(gadget.id) === true;
      // Border mode participates in the cache key: it decides the gutter
      // glyph baked into every row of the block below. So does the folded
      // state, which changes the row set outright.
      const key = `${ctx.border}|${collapsed ? "c" : "e"}|${gadget.versionKey(snapshot, ctx)}`;
      const cached = this.cache.get(gadget.id);
      let block: SidebarLine[];
      if (cached !== undefined && cached.key === key) {
        block = cached.lines;
      } else if (collapsed) {
        const title = titleRow(gadget, snapshot, ctx, true);
        block = [ctx.border === "none" ? title : { ...title, gutter: "│" }];
        this.cache.set(gadget.id, { key, lines: block });
      } else {
        const lines = gadget.render(snapshot, ctx);
        // The title row is cached with the body rather than re-created
        // per frame: screen.ts's row-signature cache compares rendered
        // output, so a freshly allocated but identical title row costs
        // nothing there — but caching the assembled block keeps this
        // layer's output referentially stable, which is what makes
        // "nothing changed" cheap to assert and to reason about.
        //
        // A gadget that renders nothing is cached as an empty block and
        // dropped below, so relevant() is allowed to be approximate
        // without leaving a stray title row and separator behind.
        const withTitle =
          gadget.title === undefined
            ? lines
            : [titleRow(gadget, snapshot, ctx, false), ...lines];
        // Gutter glyphs are applied here, inside the cache, rather than at
        // assemble time: decorating on every frame would allocate a fresh
        // row object per frame and cost this layer its referential
        // stability (the screen layer's signature cache would still skip
        // the paint, but "nothing changed" stops being cheap to assert).
        block =
          lines.length === 0
            ? []
            : ctx.border === "none"
              ? withTitle
              : withTitle.map((l) => ({ ...l, gutter: "│" }));
        this.cache.set(gadget.id, { key, lines: block });
      }
      if (block.length === 0) {
        continue;
      }
      // Paging is applied to the CACHED block rather than baked into it: the
      // cache key covers the gadget's data, not the user's page, so paging
      // through a list must not invalidate (and re-render) its rows.
      blocks.push(block);
      pagedGadgets.push(collapsed ? null : gadget);
    }
    if (blocks.length === 0) {
      return [];
    }

    // Decide how much to elide, then elide. Pagination is a response to
    // scarcity: with vertical room for every item the column shows them all
    // and no pager appears anywhere. Only when the stack genuinely doesn't
    // fit does windowing start, and even then the page grows to whatever
    // still fits rather than snapping to the gadget's declared default —
    // otherwise a tall terminal would show five of nine files and leave a
    // third of the column empty.
    const borderRows = isFramedBorder(ctx.border)
      ? blocks.length + 1
      : Math.max(0, blocks.length - 1);
    const paginable = pagedGadgets.map(
      (g) => g !== null && g.pageSize !== undefined && g.pageSize > 0,
    );
    const structuralRows =
      borderRows +
      blocks.reduce((n, b) => n + b.length - countItems(b), 0);
    let limit: number;
    if (ctx.maxRows === undefined) {
      // Height unknown: fall back to each gadget's declared page size.
      limit = Number.NaN;
    } else {
      limit = fitPageSize(blocks, paginable, structuralRows, ctx.maxRows);
    }
    const paged = blocks.map((block, i) => {
      const gadget = pagedGadgets[i];
      const pageSize = gadget?.pageSize;
      if (gadget === null || gadget === undefined || pageSize === undefined) {
        return block;
      }
      const effective = Number.isNaN(limit) ? pageSize : limit;
      return paginate(gadget, block, ctx, effective);
    });
    blocks.length = 0;
    blocks.push(...paged);

    // Block boundaries.
    //
    // "none" / "rule": a blank row between blocks, none leading or trailing
    // (shared frozen constants so an unchanged column produces
    // referentially identical rows end to end).
    //
    // "frame": a rule at every boundary, with the junction each position
    // requires — "┌" above the first block, "├" between blocks (the
    // vertical edge passes through), "└" below the last. The closing rule
    // is what delineates the bottom of the column; without it the edge just
    // stops mid-air below the final gadget.
    const out: SidebarLine[] = [];
    if (isFramedBorder(ctx.border)) {
      if (this.rules?.width !== ctx.width) {
        this.rules = {
          width: ctx.width,
          lines: {
            "┌": blockRule(ctx.width, "┌"),
            "├": blockRule(ctx.width, "├"),
            "└": blockRule(ctx.width, "└"),
          },
        };
      }
      const rules = this.rules.lines;
      out.push(rules["┌"]);
      blocks.forEach((block, i) => {
        if (i > 0) {
          out.push(rules["├"]);
        }
        out.push(...block);
      });
      out.push(rules["└"]);
      return out;
    }
    const separator =
      ctx.border === "rule" ? BLOCK_SEPARATOR_RULE : BLOCK_SEPARATOR;
    blocks.forEach((block, i) => {
      if (i > 0) {
        out.push(separator);
      }
      out.push(...block);
    });
    return out;
  }
}
