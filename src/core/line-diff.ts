// Line-level diffing shared by every client of an edit: the TUI's diff
// rendering, and the per-edit line counts the daemon records on tool calls
// so clients holding only a blob ref still know an edit's extent.
import { sanitizeWireText } from "./render-update.js";

// Split an edit's old/new text into lines the way the unified diff does:
// a trailing empty line from a final \n is dropped so a 3-line edit
// doesn't count as 4. Shared so a summary and a rendered body always agree
// on line counts.
export function splitDiffLines(
  oldText: string,
  newText: string,
): { oldLines: string[]; newLines: string[] } {
  const oldLines = sanitizeWireText(oldText).split("\n");
  const newLines = sanitizeWireText(newText).split("\n");
  if (oldLines.length > 0 && oldLines[oldLines.length - 1] === "") {
    oldLines.pop();
  }
  if (newLines.length > 0 && newLines[newLines.length - 1] === "") {
    newLines.pop();
  }
  return { oldLines, newLines };
}

// Added / removed lines via the same op stream the unified diff renders,
// so a (+N -M) summary matches the hunk.
export function countLineChanges(
  oldText: string,
  newText: string,
): { added: number; removed: number } {
  const { oldLines, newLines } = splitDiffLines(oldText, newText);
  let added = 0;
  let removed = 0;
  for (const op of diffLines(oldLines, newLines)) {
    if (op.op === "+") {
      added++;
    } else if (op.op === "-") {
      removed++;
    }
  }
  return { added, removed };
}

export interface DiffOp {
  op: "=" | "-" | "+";
  text: string;
}

// LCS-based line diff. O(n*m) time/space — fine for the small hunks edit
// tools emit (old_string / new_string slices, not whole files). Write
// tools land here too, but their diff is "every new line is +", which
// the table reduces to a single column of inserts in linear time.
//
// Some agents (e.g. pi) emit FULL-FILE old/new text, so a 1-line edit to a
// 5000-line file would otherwise build a 5000x5000 LCS matrix (~26M cells,
// hundreds of MB, seconds of CPU) — and countDiffChanges runs this for the
// header summary of *every* edit, even collapsed. So we first strip the
// common leading/trailing lines (which are unchanged "=" context anyway)
// and run the quadratic LCS only on the differing middle. Localized edits
// then diff a handful of lines instead of the whole file.
export function diffLines(a: string[], b: string[]): DiffOp[] {
  let start = 0;
  const minLen = Math.min(a.length, b.length);
  while (start < minLen && a[start] === b[start]) {
    start++;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const out: DiffOp[] = [];
  for (let k = 0; k < start; k++) {
    out.push({ op: "=", text: a[k]! });
  }
  out.push(...lcsDiff(a.slice(start, endA), b.slice(start, endB)));
  for (let k = endA; k < a.length; k++) {
    out.push({ op: "=", text: a[k]! });
  }
  return out;
}

// Quadratic LCS diff over the (already prefix/suffix-trimmed) slices.
function lcsDiff(a: string[], b: string[]): DiffOp[] {
  const m = a.length;
  const n = b.length;
  if (m === 0 || n === 0) {
    const out: DiffOp[] = [];
    for (const text of a) {
      out.push({ op: "-", text });
    }
    for (const text of b) {
      out.push({ op: "+", text });
    }
    return out;
  }
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0) as number[],
  );
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (a[i] === b[j]) {
        dp[i]![j] = dp[i + 1]![j + 1]! + 1;
      } else {
        dp[i]![j] = Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
      }
    }
  }
  const out: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ op: "=", text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ op: "-", text: a[i]! });
      i++;
    } else {
      out.push({ op: "+", text: b[j]! });
      j++;
    }
  }
  while (i < m) {
    out.push({ op: "-", text: a[i]! });
    i++;
  }
  while (j < n) {
    out.push({ op: "+", text: b[j]! });
    j++;
  }
  return out;
}
