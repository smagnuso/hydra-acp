// Menu-style Tab cycling for path and @ completion. When Tab cannot extend
// the token any further and several candidates remain, each further Tab
// swaps the token for the next candidate, wrapping around. Any other key
// ends the cycle (the caller drops it), and the next Tab starts afresh.

import { textWidth } from "../core/width.js";
import type { MentionTarget } from "./file-search.js";

export interface TabCycle {
  row: number;
  start: number;
  // Full replacement tokens, parallel to `names`.
  choices: string[];
  // Display names for the candidate list.
  names: string[];
  index: number;
  // What each choice links to, parallel to `choices`; null for plain path
  // completions and for text-only entries such as directories.
  targets: Array<MentionTarget | null>;
  // The token as typed before cycling began, restored on cancel.
  original: string;
}

export function startCycle(
  row: number,
  start: number,
  choices: string[],
  names: string[],
  targets: Array<MentionTarget | null>,
  original: string,
): TabCycle {
  return { row, start, choices, names, index: 0, targets, original };
}

// The next step of the cycle when `token` is still the choice we inserted
// last, at the same place; null when the user has moved on.
export function advanceCycle(
  cycle: TabCycle,
  token: string,
  row: number,
  start: number,
  step: number = 1,
): TabCycle | null {
  if (
    cycle.row !== row ||
    cycle.start !== start ||
    token !== cycle.choices[cycle.index]
  ) {
    return null;
  }
  return { ...cycle, index: (cycle.index + step + cycle.choices.length) % cycle.choices.length };
}

// Candidate list with the active choice marked.
export function cycleListing(
  cycle: TabCycle,
): Array<{ name: string; selected?: boolean }> {
  return cycle.names.map((name, i) =>
    i === cycle.index ? { name, selected: true } : { name },
  );
}

// Which slice of a long candidate list to draw. When the list exceeds
// `maxRows`, the last row is a "+N more" line and the rest show items; the
// window slides so the selected item is always among them.
export function completionWindow(
  total: number,
  selected: number,
  maxRows: number,
): { offset: number; shown: number; hidden: number } {
  if (total <= maxRows) {
    return { offset: 0, shown: total, hidden: 0 };
  }
  const shown = maxRows - 1;
  const offset =
    selected >= shown ? Math.min(selected - shown + 1, total - shown) : 0;
  return { offset, shown, hidden: total - shown };
}

// One-line summary of a candidate list for a single-row status line. The
// list keeps its order and the "\u203a" marks the selected item, so Left/Right
// move the marker along the row. When the row is too narrow, a window around
// the selection is shown with "..." on the cut side(s).
export function formatListingHint(
  all: Array<{ name: string; selected?: boolean; note?: boolean }>,
  width = Infinity,
): string {
  const items = all.filter((i) => !i.note);
  const flag = all.some((i) => i.note) ? "  (truncated)" : "";
  const sel = items.findIndex((i) => i.selected);
  if (sel === -1) {
    return `${items.length} matches: ${items.map((i) => i.name).join("  ")}${flag}`;
  }
  const prefix = `${sel + 1}/${items.length} `;
  const cells = items.map((it, i) => (i === sel ? `\u203a${it.name}` : it.name));
  const more = "... ";
  const room = width - textWidth(prefix);
  const last = items.length - 1;
  const cost = (lo: number, hi: number): number => {
    let n = 2 * (hi - lo);
    for (let i = lo; i <= hi; i++) {
      n += textWidth(cells[i]!);
    }
    return n + (lo > 0 ? more.length : 0) + (hi < last ? more.length : 0);
  };
  let lo = sel;
  let hi = sel;
  for (;;) {
    let grew = false;
    if (hi < last && cost(lo, hi + 1) <= room) {
      hi += 1;
      grew = true;
    }
    if (lo > 0 && cost(lo - 1, hi) <= room) {
      lo -= 1;
      grew = true;
    }
    if (!grew) {
      break;
    }
  }
  const body = `${lo > 0 ? more : ""}${cells.slice(lo, hi + 1).join("  ")}${hi < last ? " ..." : ""}`;
  const fits = textWidth(prefix) + textWidth(body) + textWidth(flag) <= width;
  return `${prefix}${body}${fits ? flag : ""}`;
}
