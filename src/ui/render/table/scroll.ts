/**
 * Horizontal scroll steps for a focused table.
 *
 * Pure functions over (offset, row width, viewport width) — no component
 * state, no terminal access. The viewport owns the offset (it lives on the
 * table's state) and applies the step.
 */

/** Outcome of one table horizontal-scroll key: the new offset (when the key
 * moved the view) or null (key not claimed — bubble it). */
export type TableScrollStep = { scrollX: number } | null;

/** Pure horizontal-scroll handler for a focused table: Left/Right move by one
 * cell, Home/End jump; unclaimed sequences return null. `totalW` bounds the
 * offset at `totalW - cols` (0 when the row fits the viewport). */
export function tableScrollKey(
  seq: string,
  scrollX: number,
  totalW: number,
  cols: number,
): TableScrollStep {
  const max = Math.max(0, totalW - cols);
  switch (seq) {
    case "\x1bOD": // Left (application mode)
    case "\x1b[D": // Left
      return scrollX > 0 ? { scrollX: Math.max(0, scrollX - 1) } : null;
    case "\x1bOC": // Right (application mode)
    case "\x1b[C": // Right
      return max > 0 ? { scrollX: Math.min(max, scrollX + 1) } : null;
    case "\x1b[1~": // Home
      return { scrollX: 0 };
    case "\x1b[4~": // End
      return { scrollX: max };
    default:
      return null;
  }
}

/** True when `seq` is one of the horizontal-scroll key sequences. Used by
 * the viewport's fast path to skip a full table layout for keys that can
 * never scroll (the layout is only needed for scroll steps). */
export function isTableScrollSeq(seq: string): boolean {
  switch (seq) {
    case "\x1bOD": // Left (application mode)
    case "\x1b[D": // Left
    case "\x1bOC": // Right (application mode)
    case "\x1b[C": // Right
    case "\x1b[1~": // Home
    case "\x1b[4~": // End
      return true;
    default:
      return false;
  }
}

/** Char-level companion: h/l for fine-grained horizontal scroll. */
export function tableScrollChar(
  ch: string,
  scrollX: number,
  totalW: number,
  cols: number,
): TableScrollStep {
  const max = Math.max(0, totalW - cols);
  if (ch === "h") return scrollX > 0 ? { scrollX: Math.max(0, scrollX - 1) } : null;
  if (ch === "l") return max > 0 ? { scrollX: Math.min(max, scrollX + 1) } : null;
  return null;
}
