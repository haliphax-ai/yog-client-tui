/**
 * Table layout: how wide each pane renders, and whether the table can be
 * expanded.
 *
 * All widths are terminal CELLS. The reshape runs in a fixed order:
 *
 *   1. Shrinkwrap every pane to its content width.
 *   2. If the table fits the viewport that way, it is DONE — displayed
 *      as-is, with no expansion.
 *   3. Otherwise, divide the available space evenly among the panes,
 *      never giving a pane more than its content needs.
 *   4. If every pane either fits its content or was given at least
 *      {@link TABLE_MAX_COL} cells, the table is DONE — displayed as-is,
 *      with no expansion.
 *   5. Otherwise the table is expandable: the collapsed layout is the
 *      one that fits the viewport, and the expanded layout widens the
 *      panes that were squeezed below {@link TABLE_MAX_COL}.
 *
 * The {@link TABLE_MAX_COL} ceiling never applies to a pane that is
 * already wider than it — a table that fits the viewport when collapsed
 * keeps its panes exactly as they are, so expanding it can only ever
 * make it wider, never narrower.
 */

/**
 * Maximum width (in cells) a pane may be given when the table is
 * expanded. A ceiling, not a target: panes narrower than their content
 * allowance are untouched.
 */
export const TABLE_MAX_COL = 30;

/**
 * Rendered width of a table row in cells: Σ(width + 2 padding) + (n+1)
 * border runes — ╱ c1 ╱ c2 ╱ has a separator between every pair of cells
 * plus the two outer corners (Σw + 3n + 1).
 */
export function tableRowWidth(colWidths: readonly number[]): number {
  return colWidths.reduce((s, w) => s + w + 2, 0) + colWidths.length + 1;
}

/**
 * Cells available to the panes themselves: the viewport width minus the
 * border runes (one more than the pane count) and the one-cell padding on
 * each side of every pane.
 */
export function paneSpace(cols: number, panes: number): number {
  return Math.max(0, cols - (panes + 1) - 2 * panes);
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
export function evenDivision(natural: readonly number[], available: number): number[] {
  const count = natural.length;
  const result = Array.from<number>({ length: count }).fill(0);
  if (count === 0) return result;
  let remaining = Math.max(0, available);
  let active: number[] = [];
  for (let i = 0; i < count; i++) active.push(i);

  while (active.length > 0 && remaining > 0) {
    const before = remaining;
    const share = Math.floor(remaining / active.length);
    if (share === 0) {
      // Fewer cells left than panes: hand out single cells, one each.
      for (const i of active) {
        if (remaining <= 0) break;
        if ((result[i] ?? 0) < (natural[i] ?? 0)) {
          result[i] = (result[i] ?? 0) + 1;
          remaining -= 1;
        }
      }
      break;
    }
    const stillActive: number[] = [];
    for (const i of active) {
      const room = (natural[i] ?? 0) - (result[i] ?? 0);
      const give = Math.min(share, room);
      if (give > 0) {
        result[i] = (result[i] ?? 0) + give;
        remaining -= give;
      }
      if ((result[i] ?? 0) < (natural[i] ?? 0)) stillActive.push(i);
    }
    if (remaining === before) break; // no progress — stop rather than spin
    active = stillActive;
  }
  return result;
}

/** The resolved layout of one table. */
export interface TableLayout {
  /** The widths the panes render at, in the given state. */
  widths: number[];
  /** True when the table can be expanded/collapsed (Enter toggles it). */
  expandable: boolean;
}

/**
 * Resolve the layout of a table at `cols` cells wide.
 *
 * `natural` holds each pane's content width; `expanded` selects the
 * expanded layout (ignored for tables that are not expandable).
 */
export function resolveTableLayout(
  natural: readonly number[],
  cols: number,
  expanded: boolean,
): TableLayout {
  const count = natural.length;
  if (count === 0) return { widths: [], expandable: false };

  // 1. Shrinkwrap: every pane at its content width.
  const shrink = [...natural];

  // 2. Fits the viewport as-is → done, no expansion.
  if (tableRowWidth(shrink) <= cols) return { widths: shrink, expandable: false };

  // 3. Divide the available space evenly, capped at each pane's content.
  const filled = evenDivision(natural, paneSpace(cols, count));

  // 4. Every pane fits its content, or got at least TABLE_MAX_COL → done.
  const settled = filled.every((w, i) => w >= (natural[i] ?? 0) || w >= TABLE_MAX_COL);
  if (settled) return { widths: filled, expandable: false };

  // 5. Expandable: collapsed fits the viewport, expanded gives the
  //    squeezed panes room up to TABLE_MAX_COL. A pane already wider than
  //    the ceiling keeps its width — the ceiling never shrinks a pane.
  const collapsed = filled;
  const roomy = collapsed.map((w, i) => Math.max(w, Math.min(natural[i] ?? 0, TABLE_MAX_COL)));
  return { widths: expanded ? roomy : collapsed, expandable: true };
}
