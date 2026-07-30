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
  "session",
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
    for (const gadget of this.gadgets) {
      if (!gadget.relevant(snapshot)) {
        continue;
      }
      // Border mode participates in the cache key: it decides the gutter
      // glyph baked into every row of the block below.
      const key = `${ctx.border}|${gadget.versionKey(snapshot, ctx)}`;
      const cached = this.cache.get(gadget.id);
      let block: SidebarLine[];
      if (cached !== undefined && cached.key === key) {
        block = cached.lines;
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
            : [{ body: gadget.title, bodyStyle: "dim" as const }, ...lines];
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
      blocks.push(block);
    }
    if (blocks.length === 0) {
      return [];
    }
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
