/**
 * Water-filling: dividing a shared budget so no pane takes more than it
 * needs.
 *
 * The metaphor: `available` cells pour into the panes like water poured
 * into a row of vessels — every vessel rises one level at a time, and a
 * vessel that is FULL (already at its content width) stops taking water
 * while the level keeps rising for the rest. Panes that need less than
 * an equal share settle at their content width; the remainder re-divides
 * among the rest, so no pane is ever given more than its content needs
 * and the total never exceeds the budget.
 */

/** Panes still taking water, with what they have and what they need. */
interface Vessel {
  index: number;
  given: number;
  capacity: number;
}

/** The division: `division[i]` is pane `i`'s width (0 when there are none). */
export type Division = number[];

/**
 * Deal `share` cells to each vessel in the level, capped at capacity.
 * Returns the cells consumed.
 */
function pourLevel(level: Vessel[], share: number): number {
  let used = 0;
  for (const vessel of level) {
    const give = Math.min(share, vessel.capacity - vessel.given);
    if (give > 0) {
      vessel.given += give;
      used += give;
    }
  }
  return used;
}

/**
 * Fewer cells left than vessels in the level: hand out single cells, one
 * each, to the first vessels that still have room. Returns the remainder.
 */
function pourSingles(level: Vessel[], remaining: number): number {
  let left = remaining;
  for (const vessel of level) {
    if (left <= 0) break;
    if (vessel.given < vessel.capacity) {
      vessel.given += 1;
      left -= 1;
    }
  }
  return left;
}

/**
 * Divide `available` cells evenly among the vessels, never past capacity.
 * Mutates the vessels; returns the unspendable remainder.
 */
function pour(level: Vessel[], available: number): number {
  let left = available;
  let active: Vessel[] = level;
  while (active.length > 0 && left > 0) {
    const before = left;
    const share = Math.floor(left / active.length);
    if (share === 0) {
      // Fewer cells left than vessels: hand out single cells, one each.
      left = pourSingles(active, left);
      break;
    }
    left -= pourLevel(active, share);
    active = active.filter((vessel) => vessel.given < vessel.capacity);
    if (left === before) break; // no progress — stop rather than spin
  }
  return left;
}

/**
 * Divide `available` cells evenly among the panes, never giving a pane
 * more than its content needs.
 *
 * Water-filling: every pane gets an equal share of what is left; a pane
 * that needs less than its share is done at its content width and the
 * remainder is re-divided among the rest. The result never exceeds
 * `available` and never exceeds any pane's content width.
 */
export function evenDivision(natural: readonly number[], available: number): Division {
  const result: Division = natural.map(() => 0);
  if (natural.length === 0) return result;
  const vessels: Vessel[] = natural.map((capacity, index) => ({ index, given: 0, capacity }));
  pour(vessels, Math.max(0, available));
  for (const vessel of vessels) result[vessel.index] = vessel.given;
  return result;
}
