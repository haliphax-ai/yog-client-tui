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

/** The unit at the near end of the ring: first going forward, last going backward. */
function endUnit(units: readonly FocusTarget[], dir: 1 | -1): FocusTarget {
  return dir === 1 ? (units[0] as FocusTarget) : (units[units.length - 1] as FocusTarget);
}

/**
 * Step from ring position `i` in direction `dir`. Stepping off either end
 * of the ring lands on none; the next press re-enters from that end.
 */
function stepAt(units: readonly FocusTarget[], i: number, dir: 1 | -1): FocusTarget {
  const j = i + dir;
  return j < 0 || j >= units.length ? FOCUS_NONE_TARGET : (units[j] as FocusTarget);
}

/**
 * Ring position of the unit closest to a vanished `current`: by entry
 * index first, then table index within the same entry (an entry's tables
 * are contiguous in the ring). Linear scan — rings are tiny.
 */
function closestIndex(units: readonly FocusTarget[], current: FocusTarget): number {
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
  return best;
}

/**
 * Next focus target after pressing Tab (+1) or Shift-Tab (-1).
 *
 * When nothing is focused, the ring enters from the caller's viewport-aware
 * entry point when one is supplied (e.g. "the first unit partially visible
 * on screen" — see the log viewport's `visibleFocusUnit`); otherwise it
 * enters from the nearest end (first unit going forward, last unit going
 * backward). With no focusable units it stays at none.
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
  enterAt?: FocusTarget,
): FocusTarget {
  if (units.length === 0) return FOCUS_NONE_TARGET;

  // Nothing focused → the caller's viewport-aware entry point, else the
  // nearest end of the ring.
  if (current.entry < 0) return enterAt ?? endUnit(units, dir);

  // Current target still in the ring → step normally.
  const idx = units.findIndex((t) => t.entry === current.entry && t.table === current.table);
  if (idx !== -1) return stepAt(units, idx, dir);

  // Current target is gone → step from the closest valid target by entry
  // index, in the requested direction.
  const nearest = closestIndex(units, current);
  return nearest === -1 ? FOCUS_NONE_TARGET : stepAt(units, nearest, dir);
}
