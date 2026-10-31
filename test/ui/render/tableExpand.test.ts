import { beforeEach, describe, expect, it } from "vitest";

import { isProseTable, moveFocus } from "../../../src/core/focus.ts";
import { getState, resetForTests, setState } from "../../../src/core/store.ts";
import { cachedRows } from "../../../src/ui/render/entry.ts";
import type { LogEntry } from "../../../src/ui/render/types.ts";
import {
  parseTable,
  renderTable,
  resolveTableLayout,
  TABLE_MAX_COL,
  tableRowWidth,
  tableScrollChar,
  tableScrollKey,
} from "../../../src/ui/render/table.ts";
import { ChatViewport } from "../../../src/ui/components/ChatViewport.ts";
import { FOCUS_NONE } from "../../../src/core/focus.ts";
import { displayWidth, stripAnsi } from "../../../src/util/ansi.ts";

/**
 * A table that overflows a 40-cell viewport: col A is 45 wide naturally (one
 * long token), col B is 8 — together 45+8+3*2+1 = 61 cells, far past 40. The
 * reflow squeezes col A to 32 and col B to 3.
 */
const WIDE_TABLE = `| Name | Count |
| --- | --- |
| Supercalifragilisticexpialidocious-and-then-some | 42 |`;

/** Fixture: chunk, wide-table prose, plain prose. Focusable: [0, 1]. */
function fixture(): LogEntry[] {
  return [
    { kind: "chunk", lines: ["run exit 0", "l1", "l2", "l3", "l4", "l5", "l6", "l7"] },
    { kind: "assistant", lines: WIDE_TABLE.split("\n") },
    { kind: "assistant", lines: ["just prose"] },
  ];
}

/** A table with two naturally-narrow columns that always fits — never reflowed. */
const FIT_TABLE = `| A | B |
| --- | --- |
| one | two |`;

describe("resolveTableLayout — reflow classification", () => {
  it("marks a table expandable exactly when reflow had to reshape a column", () => {
    const natural = [45, 8];
    // 40-cell body: fit squeezes 45→32, 8→3.
    const collapsed = resolveTableLayout(natural, 40, false);
    expect(collapsed.expandable).toBe(true);
    expect(collapsed.widths[0]!).toBeLessThan(45);

    // Wide viewport: nothing reshaped → not expandable, columns stretch to
    // fill the available width (no cap on stretch — only on overflow).
    const wide = resolveTableLayout(natural, 200, false);
    expect(wide.expandable).toBe(false);
    expect(wide.widths[0]!).toBeGreaterThan(45); // stretched past natural
    expect(wide.widths[1]!).toBeGreaterThan(8); // stretched past natural
    expect(tableRowWidth(wide.widths)).toBe(200); // fills the viewport
  });

  it("expanded layout gives squeezed columns up to the 30-cell ceiling", () => {
    const collapsed = resolveTableLayout([45, 8], 40, false);
    expect(collapsed.expandable).toBe(true); // col 0 squeezed below 30
    const expanded = resolveTableLayout([45, 8], 40, true);
    expect(expanded.expandable).toBe(true);
    // Col 0 was squeezed (45 → 32) → expanded to min(natural, 30) = 30.
    // Col 1 was untouched (natural 8, fit 8) → keeps its fit width.
    expect(expanded.widths[0]!).toBe(TABLE_MAX_COL);
    expect(expanded.widths[1]!).toBe(8);
    // The expanded row overflows the viewport (that's the point).
    expect(tableRowWidth(expanded.widths)).toBeGreaterThan(40);
  });

  it("expanded widths cap squeezed columns at 30, never their natural width", () => {
    // Columns 60 and 100 in a 50-cell viewport: fit squeezes both; expanded
    // gives each 30 — breathing room up to the ceiling, never past it (the
    // 100-wide cell scrolls, it does not render at natural width).
    const expanded = resolveTableLayout([60, 100], 50, true);
    expect(expanded.widths).toEqual([30, 30]);
  });

  it("a squeezed-but-over-30 reflow never expands (all cells fit within 30)", () => {
    // Two 40-wide columns in a 90-cell viewport: fit squeezes 40 → 33/34 —
    // reflow engaged, but nothing landed below the ceiling, so Enter is
    // inert and the widths stay at the fit.
    const collapsed = resolveTableLayout([40, 40], 90, false);
    expect(collapsed.expandable).toBe(false);
    const expanded = resolveTableLayout([40, 40], 90, true);
    expect(expanded.expandable).toBe(false);
    expect(expanded.widths).toEqual(collapsed.widths);
  });
});

describe("renderTable — expanded layout renders at the resolved widths", () => {
  it("expanded table renders past the viewport width (pre-scroll slice)", () => {
    const table = parseTable(WIDE_TABLE)!;
    const expanded = resolveTableLayout(
      table.columns.map((c) => c.width),
      40,
      true,
    );
    const rows = renderTable(table, 40, true, 0, undefined, expanded.widths);
    // Row width exceeds the viewport: the pre-slice row is wider than cols.
    const border = rows[1]!;
    expect(displayWidth(stripAnsi(border))).toBe(tableRowWidth(expanded.widths));
    expect(displayWidth(stripAnsi(border))).toBeGreaterThan(40);
  });

  it("scrollX slices the expanded row and pads back to its full width", () => {
    const table = parseTable(WIDE_TABLE)!;
    const expanded = resolveTableLayout(
      table.columns.map((c) => c.width),
      40,
      true,
    );
    const total = tableRowWidth(expanded.widths);
    const rows = renderTable(table, 40, true, 5, undefined, expanded.widths);
    // Row 1 = top border; header at 2, separator at 3, data at 4.
    // scrollX=5 eats the left border, both pads, and 'S u' of the cell.
    expect(stripAnsi(rows[4]!).startsWith("ercalifr")).toBe(true);
    // The border column is gone — the viewport re-slice covers that.
    expect(stripAnsi(rows[4]!).startsWith("│")).toBe(false);
    // Padded back to the full row width (so the viewport slice is stable).
    expect(displayWidth(stripAnsi(rows[4]!))).toBe(total);
  });
});

describe("tableScrollKey / tableScrollChar — pure scroll steps", () => {
  const totalW = 60;
  const cols = 40;
  const max = totalW - cols; // 20

  it("Left moves left and clamps at 0", () => {
    expect(tableScrollKey("\x1b[D", 3, totalW, cols)).toEqual({ scrollX: 2 });
    expect(tableScrollKey("\x1b[D", 0, totalW, cols)).toBeNull();
  });

  it("Right moves right and clamps at totalW - cols", () => {
    expect(tableScrollKey("\x1b[C", 0, totalW, cols)).toEqual({ scrollX: 1 });
    expect(tableScrollKey("\x1b[C", max, totalW, cols)).toEqual({ scrollX: max });
    expect(tableScrollKey("\x1b[C", 19, totalW, cols)).toEqual({ scrollX: max });
  });

  it("a fitting row never scrolls (max = 0)", () => {
    expect(tableScrollKey("\x1b[C", 0, 30, 40)).toBeNull();
    expect(tableScrollKey("\x1b[4~", 0, 30, 40)).toEqual({ scrollX: 0 });
  });

  it("Home/End jump to the bounds", () => {
    expect(tableScrollKey("\x1b[1~", 10, totalW, cols)).toEqual({ scrollX: 0 });
    expect(tableScrollKey("\x1b[4~", 0, totalW, cols)).toEqual({ scrollX: max });
  });

  it("unknown sequences bubble (null)", () => {
    expect(tableScrollKey("\x1b[A", 5, totalW, cols)).toBeNull();
    expect(tableScrollChar("x", 5, totalW, cols)).toBeNull();
  });

  it("h/l mirror Left/Right", () => {
    expect(tableScrollChar("h", 3, totalW, cols)).toEqual({ scrollX: 2 });
    expect(tableScrollChar("l", 0, totalW, cols)).toEqual({ scrollX: 1 });
    expect(tableScrollChar("l", max, totalW, cols)).toEqual({ scrollX: max });
    expect(tableScrollChar("h", 0, totalW, cols)).toBeNull();
  });
});

describe("isProseTable + focus ring", () => {
  it("detects a GFM table in prose entries only", () => {
    expect(isProseTable({ kind: "assistant", lines: WIDE_TABLE.split("\n") }, parseTable)).toBe(
      true,
    );
    expect(isProseTable({ kind: "user", lines: WIDE_TABLE.split("\n") }, parseTable)).toBe(true);
    expect(isProseTable({ kind: "assistant", lines: ["just prose"] }, parseTable)).toBe(false);
    expect(isProseTable({ kind: "chunk", lines: WIDE_TABLE.split("\n") }, parseTable)).toBe(false);
  });

  it("moveFocus includes table-bearing prose entries in the ring", () => {
    const entries = fixture();
    // Ring: chunk (0), table prose (1). Plain prose (2) is skipped.
    expect(moveFocus(entries, FOCUS_NONE, 1, (e) => isProseTable(e, parseTable))).toBe(0);
    expect(moveFocus(entries, 0, 1, (e) => isProseTable(e, parseTable))).toBe(1);
    expect(moveFocus(entries, 1, 1, (e) => isProseTable(e, parseTable))).toBe(-1); // wrap
  });
});

describe("ChatViewport — table focus interactions", () => {
  beforeEach(() => {
    resetForTests();
    setState({ entries: fixture() });
  });

  it("Tab lands on the table entry; Left/Right scroll the expanded table", () => {
    const viewport = new ChatViewport();
    viewport.setViewportRows(24);
    viewport.cycleFocus(1);
    expect(getState().focusIndex).toBe(0); // chunk first

    viewport.cycleFocus(1);
    expect(getState().focusIndex).toBe(1); // table prose

    // Not expanded yet: Left/Right are inert (bubble).
    expect(viewport.handleKey("\x1b[C")).toBe("unhandled");

    // Render once so the component sees the terminal width (as the live
    // render loop does before any key routing).
    viewport.render({ cols: 40 });

    // Enter expands; committed to the store.
    expect(viewport.handleChar("\r")).toBe("handled");
    expect(getState().entries[1]!.tableExpanded).toBe(true);

    // Right scrolls; committed.
    expect(viewport.handleKey("\x1b[C")).toBe("handled");
    expect(getState().entries[1]!.tableScrollX).toBeGreaterThan(0);

    // h/l also scroll.
    expect(viewport.handleChar("l")).toBe("handled");
    const after = getState().entries[1]!.tableScrollX ?? 0;
    expect(after).toBeGreaterThan(0);

    // Left scrolls back and clamps at 0.
    for (let i = 0; i < 200; i++) viewport.handleKey("\x1b[D");
    expect(getState().entries[1]!.tableScrollX).toBe(0);
  });

  it("collapsed (unexpanded) tables never scroll; keys bubble", () => {
    const viewport = new ChatViewport();
    viewport.setViewportRows(24);
    viewport.cycleFocus(1);
    viewport.cycleFocus(1); // → table entry, not expanded
    expect(viewport.handleChar("l")).toBe("unhandled");
    expect(viewport.handleKey("\x1b[C")).toBe("unhandled");
    expect(getState().entries[1]!.tableScrollX).toBeUndefined();
  });

  it("fitting tables render identically expanded and unexpanded", () => {
    setState({
      entries: [{ kind: "assistant", lines: FIT_TABLE.split("\n") }],
    });
    const entry = getState().entries[0]!;
    const collapsed = cachedRows(entry, 40);
    entry.tableExpanded = true;
    const expanded = cachedRows(entry, 40);
    expect(expanded).toEqual(collapsed); // no reflow → expansion changes nothing
  });

  it("Enter on a table-free prose entry does not toggle (bubbles to submit)", () => {
    setState({ entries: [{ kind: "assistant", lines: ["plain prose"] }] });
    const viewport = new ChatViewport();
    viewport.setViewportRows(24);
    viewport.cycleFocus(1);
    // No focusable entries → ring stays at none; Enter falls through.
    expect(getState().focusIndex).toBe(FOCUS_NONE);
    expect(viewport.handleChar("\r")).toBe("unhandled");
  });

  it("emoji cells keep cell-accurate widths through expansion (regression)", () => {
    const md = `| Status | Note |
| --- | --- |
| ✅ done | ${"x".repeat(50)} |`;
    setState({ entries: [{ kind: "assistant", lines: md.split("\n") }] });
    const viewport = new ChatViewport();
    viewport.setViewportRows(24);
    viewport.render({ cols: 40 });
    viewport.cycleFocus(1); // → the table entry (index 0)
    expect(getState().focusIndex).toBe(0);
    viewport.handleChar("\r"); // expand
    expect(viewport.handleKey("\x1b[C")).toBe("handled");
    const scrollX = getState().entries[0]!.tableScrollX ?? 0;
    expect(scrollX).toBe(1);
    // Rendered rows stay within cell bounds: the border slice never shreds
    // the ✅ into a stray half-width artifact at this width.
    const rows = cachedRows(getState().entries[0]!, 40, true);
    const plain = stripAnsi(rows.join("\n"));
    expect(plain).toContain("✅");
  });
});
