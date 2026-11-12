import { beforeEach, describe, expect, it } from "vitest";

import { FOCUS_NONE_TARGET } from "../../../src/core/focus.ts";
import { getState, resetForTests, setState } from "../../../src/core/store.ts";
import { cachedRows } from "../../../src/ui/render/entry.ts";
import { tableState, type LogEntry } from "../../../src/core/entries.ts";
import {
  parseTable,
  renderTable,
  resolveTableLayout,
  tableRowWidth,
  tableScrollChar,
  tableScrollKey,
  TABLE_MAX_COL,
} from "../../../src/ui/render/table/index.ts";
import { ChatViewport } from "../../../src/ui/components/ChatViewport.ts";
import { displayWidth, stripAnsi } from "../../../src/util/ansi.ts";

/**
 * A table that overflows a 40-cell viewport: col A is 45 wide naturally (one
 * long token), col B is 8 — together 45+8+3*2+1 = 61 cells, far past 40.
 */
const WIDE_TABLE = `| Name | Count |\n| --- | --- |\n| Supercalifragilisticexpialidocious-and-then-some | 42 |`;

/** Fixture: chunk, wide-table prose, plain prose. Focusable: [0, 1]. */
function fixture(): LogEntry[] {
  return [
    { kind: "chunk", lines: ["run exit 0", "l1", "l2", "l3", "l4", "l5", "l6", "l7"] },
    { kind: "assistant", lines: WIDE_TABLE.split("\n") },
    { kind: "assistant", lines: ["just prose"] },
  ];
}

/** A table with two naturally-narrow columns that always fits — never reflowed. */
const FIT_TABLE = `| A | B |\n| --- | --- |\n| one | two |`;

/** Two tables in one entry, each with its own wide column. */
const TWO_WIDE = `| First | Count |
| --- | --- |
| ${"a".repeat(45)} | 42 |

| Second | Count |
| --- | --- |
| ${"b".repeat(45)} | 42 |`;

describe("resolveTableLayout — reflow classification", () => {
  it("marks a table expandable exactly when a pane was squeezed below the ceiling", () => {
    // 40-cell body: the space for the panes is 40 - 3 - 4 = 33, split
    // evenly → 17/16. Both panes are below the ceiling → expandable.
    const collapsed = resolveTableLayout([45, 8], 40, false);
    expect(collapsed.expandable).toBe(true);
    expect(collapsed.widths[0]!).toBeLessThan(45);

    // Wide viewport: nothing reshaped → not expandable, natural widths.
    const wide = resolveTableLayout([45, 8], 200, false);
    expect(wide.expandable).toBe(false);
    expect(wide.widths).toEqual([45, 8]);
  });

  it("expanded layout gives squeezed panes up to the ceiling", () => {
    const collapsed = resolveTableLayout([45, 8], 40, false);
    expect(collapsed.expandable).toBe(true);
    const expanded = resolveTableLayout([45, 8], 40, true);
    expect(expanded.expandable).toBe(true);
    // The squeezed pane gets the ceiling; the pane that needed only 8
    // keeps its (settled) width.
    expect(expanded.widths[0]!).toBe(TABLE_MAX_COL);
    expect(expanded.widths[1]!).toBe(8);
    // The expanded row overflows the viewport (that's the point).
    expect(tableRowWidth(expanded.widths)).toBeGreaterThan(40);
  });

  it("a table that fits the viewport is never expanded", () => {
    // 30 + 30 in a 90-cell viewport: it fits, so it renders as-is and
    // Enter does nothing.
    const collapsed = resolveTableLayout([30, 30], 90, false);
    expect(collapsed.expandable).toBe(false);
    expect(collapsed.widths).toEqual([30, 30]);
    const expanded = resolveTableLayout([30, 30], 90, true);
    expect(expanded.expandable).toBe(false);
    expect(expanded.widths).toEqual([30, 30]);
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

describe("ChatViewport — table focus interactions", () => {
  beforeEach(() => {
    resetForTests();
    setState({ entries: fixture() });
  });

  it("Tab lands on the table entry; Left/Right scroll the focused table", () => {
    const viewport = new ChatViewport();
    viewport.setViewportRows(24);
    viewport.cycleFocus(1);
    expect(getState().focusTarget).toEqual({ entry: 0, table: -1 }); // chunk first

    viewport.cycleFocus(1);
    // The prose entry itself is now focusable (user/assistant ring work) —
    // it comes first, then its tables.
    expect(getState().focusTarget).toEqual({ entry: 1, table: -1 });

    viewport.cycleFocus(1); // → the table inside the prose entry
    expect(getState().focusTarget).toEqual({ entry: 1, table: 0 });

    // Render once so the component sees the terminal width (as the live
    // render loop does before any key routing).
    viewport.render({ cols: 40 });

    // Enter expands; committed to the store.
    expect(viewport.handleChar("\r")).toBe("handled");
    expect(tableState(getState().entries[1]!, 0).expanded).toBe(true);

    // Right scrolls; committed.
    expect(viewport.handleKey("\x1b[C")).toBe("handled");
    expect(tableState(getState().entries[1]!, 0).scrollX).toBeGreaterThan(0);

    // h/l also scroll.
    expect(viewport.handleChar("l")).toBe("handled");
    const after = tableState(getState().entries[1]!, 0).scrollX;
    expect(after).toBeGreaterThan(0);

    // Left scrolls back and clamps at 0.
    for (let i = 0; i < 200; i++) viewport.handleKey("\x1b[D");
    expect(tableState(getState().entries[1]!, 0).scrollX).toBe(0);
  });

  it("a collapsed (fitting) table never scrolls; keys bubble", () => {
    setState({
      entries: [{ kind: "assistant", lines: FIT_TABLE.split("\n") }],
    });
    const viewport = new ChatViewport();
    viewport.setViewportRows(24);
    viewport.cycleFocus(1); // → the prose entry
    viewport.cycleFocus(1); // → the table
    viewport.render({ cols: 40 });
    expect(viewport.handleChar("l")).toBe("unhandled");
    expect(viewport.handleKey("\x1b[C")).toBe("unhandled");
    expect(getState().entries[0]!.tables).toBeUndefined();
  });

  it("fitting tables render identically expanded and unexpanded", () => {
    setState({
      entries: [{ kind: "assistant", lines: FIT_TABLE.split("\n") }],
    });
    const entry = getState().entries[0]!;
    const collapsed = cachedRows(entry, 40);
    tableState(entry, 0).expanded = true;
    const expanded = cachedRows(entry, 40);
    expect(expanded).toEqual(collapsed); // no reflow → expansion changes nothing
  });

  it("Enter on a table-free prose entry does not toggle (bubbles to submit)", () => {
    setState({ entries: [{ kind: "assistant", lines: ["plain prose"] }] });
    const viewport = new ChatViewport();
    viewport.setViewportRows(24);
    viewport.cycleFocus(1);
    // The prose entry itself is focused; a prose entry with no tables has
    // nothing to toggle, so Enter falls through to submit.
    expect(getState().focusTarget).toEqual({ entry: 0, table: -1 });
    expect(viewport.handleChar("\r")).toBe("unhandled");
  });

  it("emoji cells keep cell-accurate widths through expansion (regression)", () => {
    const md = `| Status | Note |\n| --- | --- |\n| ✅ done | ${"x".repeat(50)} |`;
    setState({ entries: [{ kind: "assistant", lines: md.split("\n") }] });
    const viewport = new ChatViewport();
    viewport.setViewportRows(24);
    viewport.render({ cols: 40 });
    viewport.cycleFocus(1); // → the prose entry itself (now focusable)
    expect(getState().focusTarget).toEqual({ entry: 0, table: -1 });
    viewport.cycleFocus(1); // → the table inside it
    expect(getState().focusTarget).toEqual({ entry: 0, table: 0 });
    viewport.handleChar("\r"); // expand
    expect(viewport.handleKey("\x1b[C")).toBe("handled");
    const scrollX = tableState(getState().entries[0]!, 0).scrollX;
    expect(scrollX).toBe(1);
    // Rendered rows stay within cell bounds: the border slice never shreds
    // the ✅ into a stray half-width artifact at this width.
    const rows = cachedRows(getState().entries[0]!, 40, true, 0);
    const plain = stripAnsi(rows.join("\n"));
    expect(plain).toContain("✅");
  });
});

describe("ChatViewport — per-table state is independent", () => {
  beforeEach(() => {
    resetForTests();
    setState({ entries: [{ kind: "assistant", lines: TWO_WIDE.split("\n") }] });
  });

  it("expanding table 1 leaves table 0 alone", () => {
    const viewport = new ChatViewport();
    viewport.setViewportRows(24);
    viewport.render({ cols: 40 });
    viewport.cycleFocus(1); // → the entry unit
    expect(getState().focusTarget).toEqual({ entry: 0, table: -1 });
    viewport.cycleFocus(1); // → table 0
    expect(getState().focusTarget).toEqual({ entry: 0, table: 0 });
    viewport.cycleFocus(1); // → table 1
    expect(getState().focusTarget).toEqual({ entry: 0, table: 1 });

    viewport.handleChar("\r"); // expand table 1
    const entry = getState().entries[0]!;
    expect(tableState(entry, 1).expanded).toBe(true);
    expect(tableState(entry, 0).expanded).toBeUndefined();
  });

  it("scrolling table 1 leaves table 0's offset at 0", () => {
    const viewport = new ChatViewport();
    viewport.setViewportRows(24);
    viewport.render({ cols: 40 });
    viewport.cycleFocus(1); // → the entry unit
    viewport.cycleFocus(1); // → table 0
    viewport.cycleFocus(1); // → table 1
    viewport.handleChar("\r"); // expand table 1 so it can scroll
    for (let i = 0; i < 5; i++) viewport.handleKey("\x1b[C");

    const entry = getState().entries[0]!;
    // The scroll clamps at the table's own maximum offset.
    expect(tableState(entry, 1).scrollX).toBeGreaterThan(0);
    expect(tableState(entry, 0).scrollX).toBe(0);
  });

  it("the focused table's scroll bounds come from its own layout", () => {
    const viewport = new ChatViewport();
    viewport.setViewportRows(24);
    viewport.render({ cols: 40 });
    viewport.cycleFocus(1); // → the entry unit
    viewport.cycleFocus(1); // → table 0
    viewport.cycleFocus(1); // → table 1
    viewport.handleChar("\r"); // expand table 1
    // Right scrolls to the max of TABLE 1's own row width.
    for (let i = 0; i < 500; i++) viewport.handleKey("\x1b[C");
    const entry = getState().entries[0]!;
    const state = tableState(entry, 1);
    const sections = entry.lines.join("\n");
    expect(state.scrollX).toBeGreaterThan(0);
    // The offset is bounded by table 1's own row width — table 0's identical
    // width means the bound is the same, but the state is separate.
    expect(state.scrollX).toBeLessThanOrEqual(
      tableRowWidth(resolveTableLayout([45, 4], 38, true).widths),
    );
    expect(sections).toContain("Second");
  });
});

describe("ChatViewport — T / Shift+T table cycling", () => {
  beforeEach(() => {
    resetForTests();
    setState({ entries: fixture() });
  });

  it("t enters the focused prose entry's tables and wraps back to the entry", () => {
    const viewport = new ChatViewport();
    viewport.setViewportRows(24);
    viewport.cycleFocus(1); // chunk
    viewport.cycleFocus(1); // prose entry (entry-level focus)
    expect(getState().focusTarget).toEqual({ entry: 1, table: -1 });

    expect(viewport.handleChar("t")).toBe("handled");
    expect(getState().focusTarget).toEqual({ entry: 1, table: 0 });

    expect(viewport.handleChar("t")).toBe("handled");
    expect(getState().focusTarget).toEqual({ entry: 1, table: -1 }); // wraps back
  });

  it("Shift+T cycles backward; Enter/Esc still work while a table is focused", () => {
    const viewport = new ChatViewport();
    viewport.setViewportRows(24);
    viewport.cycleFocus(1); // chunk
    viewport.cycleFocus(1); // prose entry

    expect(viewport.handleKey("\x1b[116;2u")).toBe("handled"); // Shift+T → last table
    expect(getState().focusTarget).toEqual({ entry: 1, table: 0 });

    // Enter toggles the focused table (existing behavior preserved).
    viewport.render({ cols: 40 }); // narrow → the table is expandable
    expect(viewport.handleChar("\r")).toBe("handled");
    expect(tableState(getState().entries[1]!, 0).expanded).toBe(true);

    // Esc unfocuses back to the log ring (nothing focused).
    expect(viewport.handleChar("\x1b")).toBe("handled");
    expect(getState().focusTarget).toEqual(FOCUS_NONE_TARGET);
  });

  it("t is unhandled for prose entries without tables and while nothing is focused", () => {
    const viewport = new ChatViewport();
    viewport.setViewportRows(24);
    expect(viewport.handleChar("t")).toBe("unhandled"); // nothing focused

    viewport.cycleFocus(1);
    viewport.cycleFocus(1);
    viewport.cycleFocus(1); // → the prose entry's table unit
    expect(getState().focusTarget).toEqual({ entry: 1, table: 0 });
    viewport.cycleFocus(1); // → "just prose" entry (no tables)
    expect(getState().focusTarget).toEqual({ entry: 2, table: -1 });
    expect(viewport.handleChar("t")).toBe("unhandled");
  });
});
