import { describe, expect, it } from "vitest";

import {
  evenDivision,
  paneSpace,
  resolveTableLayout,
  tableRowWidth,
  TABLE_MAX_COL,
} from "../../../src/ui/render/table/index.ts";

/**
 * The reshape order the layout engine follows:
 *
 *   1. shrinkwrap every pane to its content width
 *   2. fits the viewport → DONE (no expansion)
 *   3. divide the space evenly, never past a pane's content
 *   4. every pane fits its content OR got >= TABLE_MAX_COL → DONE
 *   5. otherwise the table is expandable; expanded caps panes at TABLE_MAX_COL
 */

describe("paneSpace — the cells left for the panes themselves", () => {
  it("subtracts the border runes and the pane padding", () => {
    // 3 panes: 4 border runes + 3 panes * 2 padding cells = 10 overhead.
    expect(paneSpace(80, 3)).toBe(70);
    expect(paneSpace(80, 1)).toBe(76);
  });

  it("never goes negative", () => {
    expect(paneSpace(4, 3)).toBe(0);
  });
});

describe("evenDivision — split the space, never past a pane's content", () => {
  it("splits evenly when every pane needs more than its share", () => {
    expect(evenDivision([100, 100, 100], 60)).toEqual([20, 20, 20]);
  });

  it("gives a pane only what it needs and re-splits the rest", () => {
    // The first pane needs 5; the other two share the remaining 25.
    expect(evenDivision([5, 100, 100], 30)).toEqual([5, 13, 12]);
  });

  it("never exceeds a pane's content width", () => {
    const result = evenDivision([3, 50], 40);
    expect(result[0]).toBeLessThanOrEqual(3);
    expect(result[1]).toBeLessThanOrEqual(50);
  });

  it("never exceeds the available space", () => {
    const result = evenDivision([100, 100], 30);
    expect(result.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(30);
  });

  it("hands out single cells when fewer cells than panes remain", () => {
    expect(evenDivision([100, 100, 100], 2)).toEqual([1, 1, 0]);
  });
});

describe("resolveTableLayout — step 2: shrinkwrap fits → done", () => {
  it("keeps the panes at their content width when the table fits", () => {
    const layout = resolveTableLayout([10, 12], 80, false);
    expect(layout.widths).toEqual([10, 12]);
    expect(layout.expandable).toBe(false);
  });

  it("is not expandable even when asked to expand", () => {
    const layout = resolveTableLayout([10, 12], 80, true);
    expect(layout.widths).toEqual([10, 12]);
    expect(layout.expandable).toBe(false);
  });

  it("a single pane that gets at least the ceiling is settled", () => {
    // 1 pane in 80 cells: it gets 76 cells — more than the ceiling, so
    // it is settled and the table is not expandable.
    const layout = resolveTableLayout([200], 80, false);
    expect(layout.widths[0]).toBe(76);
    expect(layout.expandable).toBe(false);
  });
});

describe("resolveTableLayout — step 4: every pane settled → done", () => {
  it("a pane that fits its content is settled", () => {
    // 2 panes: one needs 5, the other needs 200. Space = 80 - 3 - 4 = 73.
    // The even split gives the small pane 5 (its content) and the big one
    // 68 — the big pane got more than the ceiling, so both are settled
    // and the table is not expandable.
    const layout = resolveTableLayout([5, 200], 80, false);
    expect(layout.expandable).toBe(false);
    expect(layout.widths).toEqual([5, 68]);
  });

  it("a pane given at least TABLE_MAX_COL is settled", () => {
    // One huge pane: it gets everything (>= TABLE_MAX_COL) → settled.
    const layout = resolveTableLayout([200], 80, false);
    expect(layout.widths[0]).toBeGreaterThanOrEqual(TABLE_MAX_COL);
    expect(layout.expandable).toBe(false);
  });

  it("the ceiling never applies to a table that fits the viewport when collapsed", () => {
    // A table that fits at 60 cells in an 80-cell viewport keeps its panes
    // exactly as they are — the 30-cell ceiling is not applied to it.
    const layout = resolveTableLayout([25, 25], 80, false);
    expect(layout.widths).toEqual([25, 25]);
    expect(layout.expandable).toBe(false);
    // Even when expanded, nothing changes — there is nothing to expand.
    expect(resolveTableLayout([25, 25], 80, true).widths).toEqual([25, 25]);
  });
});

describe("resolveTableLayout — step 5: expandable", () => {
  it("the collapsed layout fits the viewport; the expanded one overflows", () => {
    // 2 panes in a 60-cell viewport: the space for the panes is 53, split
    // evenly → 27/26. Both are below the ceiling → expandable.
    const natural = [100, 100];
    const collapsed = resolveTableLayout(natural, 60, false);
    const expanded = resolveTableLayout(natural, 60, true);
    expect(collapsed.expandable).toBe(true);
    expect(expanded.expandable).toBe(true);
    expect(tableRowWidth(collapsed.widths)).toBeLessThanOrEqual(60);
    expect(tableRowWidth(expanded.widths)).toBeGreaterThan(60);
  });

  it("a pane given at least the ceiling settles the whole table", () => {
    // 2 panes in an 80-cell viewport: 37/36 — both above the ceiling, so
    // the table is DONE and cannot be expanded.
    const layout = resolveTableLayout([100, 100], 80, false);
    expect(layout.expandable).toBe(false);
  });

  it("expansion caps the squeezed panes at TABLE_MAX_COL", () => {
    const expanded = resolveTableLayout([100, 100], 60, true);
    expect(expanded.widths).toEqual([TABLE_MAX_COL, TABLE_MAX_COL]);
  });

  it("expansion never shrinks a pane", () => {
    const natural = [100, 100];
    const collapsed = resolveTableLayout(natural, 60, false);
    const expanded = resolveTableLayout(natural, 60, true);
    for (let i = 0; i < natural.length; i++) {
      expect(expanded.widths[i]!).toBeGreaterThanOrEqual(collapsed.widths[i]!);
      // …and never exceeds the pane's content width.
      expect(expanded.widths[i]!).toBeLessThanOrEqual(natural[i]!);
    }
  });

  it("a pane already wider than the ceiling keeps its own width", () => {
    // The pane needs 60 cells; the ceiling is 30 — the ceiling never
    // shrinks a pane, so it keeps at least its collapsed width.
    const collapsed = resolveTableLayout([60], 40, false);
    const expanded = resolveTableLayout([60], 40, true);
    expect(expanded.widths[0]!).toBeGreaterThanOrEqual(collapsed.widths[0]!);
    expect(expanded.widths[0]!).toBeLessThanOrEqual(60);
  });
});

describe("resolveTableLayout — worked example", () => {
  it("three 60-cell panes in an 80-cell viewport", () => {
    // Space = 80 - 4 borders - 6 padding = 70. Even split: 24/23/23.
    const collapsed = resolveTableLayout([60, 60, 60], 80, false);
    expect(collapsed.widths).toEqual([24, 23, 23]);
    expect(tableRowWidth(collapsed.widths)).toBe(80);
    expect(collapsed.expandable).toBe(true);
    // Expanded: every pane gets the ceiling.
    const expanded = resolveTableLayout([60, 60, 60], 80, true);
    expect(expanded.widths).toEqual([TABLE_MAX_COL, TABLE_MAX_COL, TABLE_MAX_COL]);
    expect(tableRowWidth(expanded.widths)).toBe(100);
  });

  it("a 100-cell pane in a 120-cell viewport renders at its content width", () => {
    const layout = resolveTableLayout([100], 120, false);
    expect(layout.widths).toEqual([100]);
    expect(layout.expandable).toBe(false);
  });
});
