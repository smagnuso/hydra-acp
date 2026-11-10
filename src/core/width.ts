import stringWidth from "string-width";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function textWidth(s: string): number {
  return stringWidth(s);
}

// Longest grapheme-aligned prefix of `s` that fits in `max` cells.
export function takeWidth(s: string, max: number): string {
  if (max <= 0) {
    return "";
  }
  let w = 0;
  let end = 0;
  for (const g of segmenter.segment(s)) {
    const gw = stringWidth(g.segment);
    if (w + gw > max) {
      break;
    }
    w += gw;
    end = g.index + g.segment.length;
  }
  return s.slice(0, end);
}

// Longest grapheme-aligned suffix of `s` that fits in `max` cells.
export function takeWidthEnd(s: string, max: number): string {
  if (max <= 0) {
    return "";
  }
  const parts = [...segmenter.segment(s)];
  let w = 0;
  let start = s.length;
  for (let i = parts.length - 1; i >= 0; i--) {
    const g = parts[i]!;
    const gw = stringWidth(g.segment);
    if (w + gw > max) {
      break;
    }
    w += gw;
    start = g.index;
  }
  return s.slice(start);
}

export function padEndWidth(s: string, width: number): string {
  const pad = width - stringWidth(s);
  return pad > 0 ? s + " ".repeat(pad) : s;
}

export function padStartWidth(s: string, width: number): string {
  const pad = width - stringWidth(s);
  return pad > 0 ? " ".repeat(pad) + s : s;
}

// Pad or hard-cut to exactly `width` cells (a wide glyph that straddles the edge is dropped and replaced by a space).
export function fitWidth(s: string, width: number): string {
  return padEndWidth(takeWidth(s, width), width);
}

export function truncateEndWidth(s: string, max: number): string {
  if (max <= 0) {
    return "";
  }
  if (stringWidth(s) <= max) {
    return s;
  }
  if (max === 1) {
    return "…";
  }
  return takeWidth(s, max - 1) + "…";
}

export function truncateMiddleWidth(s: string, max: number): string {
  if (max <= 0) {
    return "";
  }
  if (stringWidth(s) <= max) {
    return s;
  }
  if (max === 1) {
    return "…";
  }
  const head = Math.ceil((max - 1) / 2);
  const tail = max - 1 - head;
  return takeWidth(s, head) + "…" + takeWidthEnd(s, tail);
}

// Offset of the grapheme boundary before `offset` (0 when at the start).
export function prevGraphemeOffset(s: string, offset: number): number {
  if (offset <= 0) {
    return 0;
  }
  let prev = 0;
  for (const g of segmenter.segment(s)) {
    if (g.index >= offset) {
      break;
    }
    prev = g.index;
  }
  return prev;
}

// Offset of the grapheme boundary after `offset` (s.length when at the end).
export function nextGraphemeOffset(s: string, offset: number): number {
  for (const g of segmenter.segment(s)) {
    const end = g.index + g.segment.length;
    if (end > offset) {
      return end;
    }
  }
  return s.length;
}
