/**
 * Focus ring over focusable log units — pure, terminal-free.
 *
 * Tab / Shift-Tab move focus forward (+1) or backward (-1) through the
 * ring. The ring wraps through the "nothing selected" state (-1): past the
 * last unit lands on none (as does Shift-Tab from the first), and the next
 * press continues from that end.
 *
 * A prose entry may carry more than one GFM table. Each table is an
 * independent focusable unit, so the ring is a flat list of targets:
 * chunk/tool entries are `{entry, table: -1}` and every table inside a
 * prose entry is `{entry, table: ti}`. Tab walks through the tables inside
 * an entry before moving on to the next entry.
 *
 * The ring is computed by the caller (the UI layer knows which entries
 * carry tables); this module only does the ring arithmetic, so it never
 * needs to know how a table is detected.
 */

/** No focused entry. */
export const FOCUS_NONE = -1;

/** A focus target: entry index + table index within that entry. */
export type FocusTarget = { entry: number; table: number };

/** The "nothing focused" target. */
export const FOCUS_NONE_TARGET: FocusTarget = { entry: FOCUS_NONE, table: FOCUS_NONE };

/**
 * Next focus target after pressing Tab (+1) or Shift-Tab (-1).
 *
 * When nothing is focused, the ring enters from the nearest end (first
 * unit going forward, last unit going backward). With no focusable units
 * it stays at none.
 *
 * A target that is no longer in the ring (entries changed underneath — a
 * streaming entry's table count shifted, or the focused entry was
 * replaced) falls back to the closest valid target by entry index, then
 * steps in the requested direction — instead of jumping to an end, which
 * reads as "selecting nothing" when the ring grew between the last focus
 * and this press.
 */
export function moveFocus(
  units: readonly FocusTarget[],
  current: FocusTarget,
  dir: 1 | -1,
): FocusTarget {
  if (units.length === 0) return FOCUS_NONE_TARGET;
  const idx = units.findIndex((t) => t.entry === current.entry && t.table === current.table);

  // Nothing focused → enter from the nearest end.
  if (current.entry < 0) {
    return dir === 1 ? (units[0] as FocusTarget) : (units[units.length - 1] as FocusTarget);
  }

  // Current target still in the ring → step normally.
  if (idx !== -1) {
    if (dir === 1)
      return idx === units.length - 1 ? FOCUS_NONE_TARGET : (units[idx + 1] as FocusTarget);
    return idx === 0 ? FOCUS_NONE_TARGET : (units[idx - 1] as FocusTarget);
  }

  // Current target is gone → find the closest valid target by entry
  // index, then step in the requested direction.
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < units.length; i++) {
    const t = units[i] as FocusTarget;
    const de = Math.abs(t.entry - current.entry);
    const dt = t.entry === current.entry ? Math.abs(t.table - current.table) : Infinity;
    const dist = de * 1000 + dt;
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  if (best === -1) return FOCUS_NONE_TARGET;
  return dir === 1
    ? best === units.length - 1
      ? FOCUS_NONE_TARGET
      : (units[best + 1] as FocusTarget)
    : best === 0
      ? FOCUS_NONE_TARGET
      : (units[best - 1] as FocusTarget);
}
