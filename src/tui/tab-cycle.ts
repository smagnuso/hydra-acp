// Menu-style Tab cycling for path and @ completion. When Tab cannot extend
// the token any further and several candidates remain, each further Tab
// swaps the token for the next candidate, wrapping around. Any other key
// ends the cycle (the caller drops it), and the next Tab starts afresh.

export interface TabCycle {
  row: number;
  start: number;
  // Full replacement tokens, parallel to `names`.
  choices: string[];
  // Display names for the candidate list.
  names: string[];
  index: number;
  // True for "@" mentions, whose file choices are recorded for resource_link.
  mention: boolean;
  // The token as typed before cycling began, restored on cancel.
  original: string;
}

export function startCycle(
  row: number,
  start: number,
  choices: string[],
  names: string[],
  mention: boolean,
  original: string,
): TabCycle {
  return { row, start, choices, names, index: 0, mention, original };
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
