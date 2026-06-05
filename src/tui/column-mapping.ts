import stringWidth from "string-width";

/**
 * Width-aware mapping between display columns and character offsets.
 *
 * All functions are pure and deterministic: no terminal state, no I/O.
 * Columns are 0-based display columns (a column is the position to the
 * *left* of the cell at that index). Offsets are JS string code-unit
 * offsets (i.e. suitable for `str.slice`/`str.substring`).
 *
 * The string is iterated by extended grapheme cluster via `Intl.Segmenter`,
 * and each cluster's width is measured by `string-width`. This handles:
 *   - ASCII / Latin-1 (width 1)
 *   - CJK ideographs and full-width punctuation (width 2)
 *   - Emoji, including ZWJ sequences and skin-tone modifiers (width 2)
 *   - Combining marks attached to a base (width 1, no drift)
 *   - Common BMP symbols (em-dash, bullets, box-drawing — width 1)
 */

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export interface Grapheme {
  /** The grapheme cluster text. */
  segment: string;
  /** Code-unit offset of the cluster's start within the original string. */
  offset: number;
  /** Display width in cells. */
  width: number;
}

export function segmentGraphemes(str: string): Grapheme[] {
  const out: Grapheme[] = [];
  for (const s of segmenter.segment(str)) {
    out.push({
      segment: s.segment,
      offset: s.index,
      width: stringWidth(s.segment),
    });
  }
  return out;
}

/** Total display width of a string (sum of grapheme widths). */
export function displayWidth(str: string): number {
  let w = 0;
  for (const s of segmenter.segment(str))
    w += stringWidth(s.segment);
  return w;
}

/**
 * Map a display column to a character (code-unit) offset.
 *
 * Semantics:
 *   - Column 0 -> offset 0.
 *   - Negative columns clamp to 0.
 *   - Columns at or beyond the total display width clamp to `str.length`.
 *   - When the target column falls *inside* a wide grapheme, the offset of
 *     the grapheme's *start* is returned (i.e. we snap left to the nearest
 *     grapheme boundary). This avoids splitting wide / composed glyphs.
 */
export function columnToOffset(str: string, column: number): number {
  if (!str)
    return 0;
  if (column <= 0)
    return 0;

  let col = 0;
  for (const s of segmenter.segment(str)) {
    const w = stringWidth(s.segment);
    if (column < col + w)
      return s.index;
    col += w;
    if (column === col)
      return s.index + s.segment.length;
  }
  return str.length;
}

/**
 * Map a character (code-unit) offset to its display column.
 *
 * The offset is snapped left to the nearest grapheme boundary, so passing
 * an offset that lands inside a multi-code-unit cluster (e.g. a surrogate
 * pair or a combining sequence) yields the column at the cluster's start.
 * Offsets beyond the string return the total display width.
 */
export function offsetToColumn(str: string, offset: number): number {
  if (!str || offset <= 0)
    return 0;
  let col = 0;
  for (const s of segmenter.segment(str)) {
    const end = s.index + s.segment.length;
    if (offset < end)
      return col;
    col += stringWidth(s.segment);
    if (offset === end)
      return col;
  }
  return col;
}

/**
 * Atomic display unit: a piece of text that occupies `width` cells.
 * Concatenating the `text` of every segment in order must reproduce the
 * original string. Zero-width segments (e.g. inline style markup) are
 * allowed; the column mapping treats them as boundaries that consume
 * code units without advancing the cursor.
 *
 * This shape is intentionally agnostic to *what* defines a segment: the
 * caller (e.g. the layer that owns terminal markup) supplies the
 * segmentation, and this module reuses it for offset math.
 */
export interface WidthSegment {
  text: string;
  width: number;
}

/**
 * Segment-aware variant of {@link columnToOffset}. The returned offset
 * always falls on a segment boundary, so a zero-width markup span is
 * never split. When a column lands inside a positive-width segment the
 * offset of that segment's start is returned (snap left). When a column
 * lands exactly between segments the offset advances past any adjacent
 * zero-width segments — clicking on a visible cell skips the styling
 * sequence that precedes it.
 */
export function columnToOffsetFromSegments(
  segments: Iterable<WidthSegment>,
  column: number,
): number {
  if (column <= 0)
    return 0;
  let col = 0;
  let offset = 0;
  for (const s of segments) {
    if (s.width > 0 && column < col + s.width)
      return offset;
    col += s.width;
    offset += s.text.length;
    if (s.width > 0 && column === col)
      return offset;
  }
  return offset;
}

/**
 * Segment-aware variant of {@link offsetToColumn}. Snaps the offset
 * left to the nearest segment boundary and returns the visible column
 * at that boundary. Mutually consistent with
 * {@link columnToOffsetFromSegments}: for any offset that lies on a
 * segment boundary, columnToOffsetFromSegments(segments, that_col) ===
 * offset (modulo trailing zero-width segments).
 */
export function offsetToColumnFromSegments(
  segments: Iterable<WidthSegment>,
  offset: number,
): number {
  if (offset <= 0)
    return 0;
  let col = 0;
  let off = 0;
  for (const s of segments) {
    const end = off + s.text.length;
    if (offset < end)
      return col;
    col += s.width;
    off = end;
    if (offset === end)
      return col;
  }
  return col;
}
