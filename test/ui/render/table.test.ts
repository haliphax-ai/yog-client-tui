import { describe, expect, it } from "vitest";

import {
  cellLines,
  parseTable,
  renderTable,
  splitTableSections,
  TableComponent,
} from "../../../src/ui/render/table.ts";
import { cachedRows } from "../../../src/ui/render/entry.ts";
import type { LogEntry } from "../../../src/ui/render/types.ts";
import { displayWidth, stripAnsi } from "../../../src/util/ansi.ts";

describe("parseTable — GFM pipe tables", () => {
  it("parses a basic table with header and two data rows", () => {
    const md = `| Name | Age |
| --- | --- |
| Alice | 30 |
| Bob | 25 |`;

    const t = parseTable(md);
    expect(t).not.toBeNull();
    expect(t!.columns).toEqual([
      { title: "Name", width: 5, align: "left" },
      { title: "Age", width: 3, align: "left" },
    ]);
    expect(t!.rows).toEqual([["Alice", "30"], ["Bob", "25"]]);
  });

  it("omits outer pipes (GFM allows it)", () => {
    const md = `Name | Age
--- | ---
Alice | 30
Bob | 25`;

    const t = parseTable(md);
    expect(t).not.toBeNull();
    expect(t!.columns).toEqual([
      { title: "Name", width: 5, align: "left" },
      { title: "Age", width: 3, align: "left" },
    ]);
  });

  it("computes column width from the widest cell", () => {
    const md = `| Name | Value |
| --- | --- |
| Alice | hello world |
| B | x |`;

    const t = parseTable(md);
    expect(t!.columns).toEqual([
      { title: "Name", width: 5, align: "left" },
      { title: "Value", width: 11, align: "left" },
    ]);
  });

  it("handles escaped pipes inside cells", () => {
    const md = `| a | b |
| --- | --- |
| x\\|y | z |`;

    const t = parseTable(md);
    expect(t!.rows).toEqual([["x|y", "z"]]);
  });

  it("parses left/center/right alignment from the delimiter row", () => {
    const md = `| left | center | right |
| :--- | :---: | ---: |
| a | b | c |`;

    const t = parseTable(md);
    expect(t).not.toBeNull();
    expect(t!.columns).toHaveLength(3);
    expect(t!.columns.map((c) => c.align)).toEqual([
      "left",
      "center",
      "right",
    ]);
    expect(t!.rows).toEqual([["a", "b", "c"]]);
  });

  it("defaults to left alignment when the delimiter has no colons", () => {
    const md = `| Name | Age |
| --- | --- |
| Alice | 30 |`;

    const t = parseTable(md);
    expect(t).not.toBeNull();
    expect(t!.columns.every((c) => c.align === "left")).toBe(true);
  });

  it("returns null when there is no delimiter row", () => {
    const md = `| Name | Age |
| Alice | 30 |`;

    expect(parseTable(md)).toBeNull();
  });

  it("returns null when the text has no pipes at all", () => {
    expect(parseTable("just some prose")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(parseTable("")).toBeNull();
  });

  it("parses a table with no data rows (header only)", () => {
    const md = `| Name | Age |
| --- | --- |`;

    const t = parseTable(md);
    expect(t).not.toBeNull();
    expect(t!.columns).toEqual([
      { title: "Name", width: 4, align: "left" },
      { title: "Age", width: 3, align: "left" },
    ]);
    expect(t!.rows).toEqual([]);
  });

  it("stops at the first non-table line after the delimiter", () => {
    const md = `| Name | Age |
| --- | --- |
| Alice | 30 |
This is not a table row
| Bob | 25 |`;

    const t = parseTable(md);
    expect(t!.rows).toEqual([["Alice", "30"]]);
  });

  it("skips leading blank lines before the header", () => {
    const md = `

| Name | Age |
| --- | --- |
| Alice | 30 |`;

    const t = parseTable(md);
    expect(t).not.toBeNull();
    expect(t!.rows).toEqual([["Alice", "30"]]);
  });

  it("trims whitespace around cells", () => {
    const md = `|  Name  |  Age  |
|  ---  |  ---  |
|  Alice  |  30  |`;

    const t = parseTable(md);
    expect(t!.columns).toEqual([
      { title: "Name", width: 5, align: "left" },
      { title: "Age", width: 3, align: "left" },
    ]);
  });

  it("converts <br> to newlines inside cells", () => {
    const md = `| Name | Description |
| --- | --- |
| Alice | line one<br>line two<br/>line three<br />line four |`;

    const t = parseTable(md);
    expect(t!.rows).toEqual([
      ["Alice", "line one\nline two\nline three\nline four"],
    ]);
  });

  it("sizes column width from the widest sub-line of a <br> cell", () => {
    const md = `| Name | Description |
| --- | --- |
| Alice | short<br>very long line here |`;

    const t = parseTable(md);
    expect(t!.columns).toEqual([
      { title: "Name", width: 5, align: "left" },
      { title: "Description", width: 19, align: "left" },
    ]);
  });

  it("parses left/center/right alignment from the delimiter row", () => {
    const md = `| left | center | right |
| :--- | :---: | ---: |
| a | b | c |`;

    const t = parseTable(md);
    expect(t).not.toBeNull();
    expect(t!.columns).toHaveLength(3);
    expect(t!.columns.map((c) => c.align)).toEqual([
      "left",
      "center",
      "right",
    ]);
    expect(t!.rows).toEqual([["a", "b", "c"]]);
  });

  it("defaults to left alignment when the delimiter has no colons", () => {
    const md = `| Name | Age |
| --- | --- |
| Alice | 30 |`;

    const t = parseTable(md);
    expect(t).not.toBeNull();
    expect(t!.columns.every((c) => c.align === "left")).toBe(true);
  });
});

describe("splitTableSections — prose/table interleaving", () => {
  it("returns a single prose section when there are no tables", () => {
    const sections = splitTableSections("just some prose\nwith two lines");
    expect(sections).toEqual([
      { kind: "prose", text: "just some prose\nwith two lines" },
    ]);
  });

  it("returns a single table section when the text is only a table", () => {
    const md = `| Name | Age |
| --- | --- |
| Alice | 30 |`;

    const sections = splitTableSections(md);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.kind).toBe("table");
    if (sections[0]!.kind === "table") {
      expect(sections[0]!.table.rows).toEqual([["Alice", "30"]]);
    }
  });

  it("splits prose → table → prose", () => {
    const md = `Here is the data:

| Name | Age |
| --- | --- |
| Alice | 30 |
| Bob | 25 |

And here is the conclusion.`;

    const sections = splitTableSections(md);
    expect(sections).toHaveLength(3);
    expect(sections[0]!.kind).toBe("prose");
    expect(sections[0]!.kind === "prose" && sections[0]!.text).toContain("Here is the data");
    expect(sections[1]!.kind).toBe("table");
    expect(sections[2]!.kind).toBe("prose");
    expect(sections[2]!.kind === "prose" && sections[2]!.text).toContain("conclusion");
  });

  it("handles multiple consecutive tables separated by prose", () => {
    const md = `| A | B |
| --- | --- |
| 1 | 2 |

prose

| C | D |
| --- | --- |
| 3 | 4 |`;

    const sections = splitTableSections(md);
    expect(sections).toHaveLength(3);
    // table, prose, table — no adjacent same-kind sections
    for (let i = 1; i < sections.length; i++) {
      expect(sections[i]!.kind).not.toBe(sections[i - 1]!.kind);
    }
  });

  it("treats a table-row line followed by a non-delimiter as prose", () => {
    const md = `| not a table |
| also not a table |`;

    const sections = splitTableSections(md);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.kind).toBe("prose");
  });

  it("trims leading/trailing blank lines from prose sections", () => {
    const md = `

| Name | Age |
| --- | --- |
| Alice | 30 |

`;

    const sections = splitTableSections(md);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.kind).toBe("table");
  });

  it("preserves interior blank lines (paragraph breaks) in prose", () => {
    const md = `First paragraph.

Second paragraph.`;

    const sections = splitTableSections(md);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.kind).toBe("prose");
    expect(sections[0]!.kind === "prose" && sections[0]!.text).toContain(
      "First paragraph.\n\nSecond paragraph.",
    );
  });

  it("returns empty array for empty input", () => {
    expect(splitTableSections("")).toEqual([]);
  });
});

describe("renderTable — styled output", () => {
  const md = `| Name | Age |
| --- | --- |
| Alice | 30 |
| Bob | 25 |`;
  const table = parseTable(md)!;

  it("renders heavy border runes when focused, light when not", () => {
    const focused = renderTable(table, 80, true, 0);
    const unfocused = renderTable(table, 80, false, 0);
    // Vertical + horizontal border runes present in both modes
    expect(focused.join("")).toContain("┃");
    expect(focused.join("")).toContain("━");
    expect(unfocused.join("")).toContain("│");
    expect(unfocused.join("")).toContain("─");
    // Corner runes differ: heavy vs light
    expect(focused[1]!.charAt(0)).toBe("┏");
    expect(unfocused[1]!.charAt(0)).toBe("┌");
  });

  it("renders the header row in bold", () => {
    const rows = renderTable(table, 80, false, 0);
    // Header is row 2 (after top margin + top border)
    expect(rows[2]).toContain("\x1b[1m");
    expect(rows[2]).toContain("\x1b[m"); // SGR reset (lipgloss emits \x1b[m, not \x1b[22m)
  });

  it("applies zebra background to odd data rows", () => {
    const rows = renderTable(table, 80, false, 0);
    // Row 4 = data row 0 (even, no zebra), row 5 = data row 1 (odd, zebra)
    // ST.tableZebra bg is #1a1a2e → ANSI 48;2;26;26;46
    expect(rows[4]).not.toMatch(/48;2;26;26;46/);
    expect(rows[5]).toMatch(/48;2;26;26;46/);
  });


  it("applies selected background to row 0 only when focused", () => {
    const focused = renderTable(table, 80, true, 0);
    const unfocused = renderTable(table, 80, false, 0);
    // ST.tableSelected bg is #1e3a8a → ANSI 48;2;30;58;138
    expect(focused[4]).toMatch(/48;2;30;58;138/);
    expect(unfocused[4]).not.toMatch(/1e3a8a/);
    // Row 1 (odd) gets zebra, not selected, in both modes
    expect(focused[5]).toMatch(/48;2;26;26;46/);
    expect(focused[5]).not.toMatch(/1e3a8a/);
  });

  it("scrollX truncates leading cells from each line", () => {
    const noScroll = renderTable(table, 80, false, 0);
    const scrolled = renderTable(table, 80, false, 3);
    // scrollX=3 slices the first 3 chars off data rows: "│ Alice..." → "lice..."
    expect(noScroll[4]!.charAt(0)).toBe("│");
    expect(scrolled[4]!.startsWith("lice")).toBe(true);
    // The scrolled data row differs from the unscrolled one
    expect(scrolled[4]).not.toBe(noScroll[4]);
  });


  it("produceRows on TableComponent matches the renderTable free function", () => {
    const tc = new TableComponent();
    tc.setTable(table);
    tc.onFocus(true);
    const rows = tc.produceRows(80);
    const expected = renderTable(table, 80, true, 0);
    expect(rows).toEqual(expected);
  });

  it("produceRows reflects unfocused state", () => {
    const tc = new TableComponent();
    tc.setTable(table);
    // onFocus(false) sets isFocused = false
    tc.onFocus(false);
    const rows = tc.produceRows(80);
    const expected = renderTable(table, 80, false, 0);
    expect(rows).toEqual(expected);
  });

  it("emits one physical line per <br> display break", () => {
    const md = `| A | B |
| --- | --- |
| line1<br>line2 | single |`;
    const rows = renderTable(parseTable(md)!, 80, false, 0);
    // margins(2) + borders(2) + header(1) + separator(1) + 2 physical lines
    expect(rows.length).toBe(8);
    // Data lines follow the separator (0 margin, 1 top, 2 header, 3 separator)
    expect(rows[4]).toContain("line1");
    expect(rows[5]).toContain("line2");
    // No embedded newline survives: every emitted row is one physical line
    for (const row of rows) expect(row).not.toContain("\n");
    // The single-line cell occupies BOTH physical lines (top-aligned)
    expect(stripAnsi(rows[4]!)).toContain("│");
    expect(stripAnsi(rows[5]!)).toContain("│");
  });

  it("keeps zebra stripes per logical row across <br> splits", () => {
    const md = `| A | B |
| --- | --- |
| one | x |
| two<br>two-b | y |`;
    const rows = renderTable(parseTable(md)!, 80, false, 0);
    // rows: 0 margin, 1 top, 2 header, 3 separator, 4 data0, 5 data1a, 6 data1b, 7 bottom, 8 margin
    // data1 is logical row index 1 → zebra on BOTH its physical lines
    const zebra = "48;2;26;26;46";
    expect(rows[5]).toMatch(zebra);
    expect(rows[6]).toMatch(zebra);
    expect(rows[4]).not.toMatch(zebra);
  });

  it("splits <br> in header cells into stacked lines", () => {
    const md = `| First<br>Second | B |
| --- | --- |
| a | b |`;
    const rows = renderTable(parseTable(md)!, 80, false, 0);
    // 2 margins + 2 borders + 2 header lines + 1 separator + 1 data row = 8
    expect(rows.length).toBe(8);
    expect(rows[2]).toContain("First");
    expect(rows[3]).toContain("Second");
    // Data row starts after the separator (row 5)
    expect(rows[5]).toContain("a");
  });

  it("treats a trailing <br> as a hard cap, not padding", () => {
    const md = `| A |
| --- |
| text<br> |`;
    const t = parseTable(md)!;
    expect(t.rows[0]![0]).toBe("text\n");
    expect(t.columns[0]!.width).toBe(4); // widest line is "text"
    const rows = renderTable(t, 80, false, 0);
    // second physical line is blank inside the borders (w=4 cell → 6 spaces)
    expect(stripAnsi(rows[5]!)).toBe("│      │");
  });

  it("keeps padded blank cells on continuation lines (dividers align)", () => {
    const md = `| A | B |
| --- | --- |
| one<br>two | x |`;
    const rows = renderTable(parseTable(md)!, 80, false, 0);
    const line1 = stripAnsi(rows[4]!);
    const line2 = stripAnsi(rows[5]!);
    // Line 2: cell A shows its second break-line, cell B is blank padding
    expect(line2).toMatch(/^│ two │ {3}│$/);
    // Dividers at the same offsets on both lines
    const d1 = line1.indexOf("│", 1);
    const d2 = line2.indexOf("│", 1);
    expect(d2).toBe(d1);
  });

  it("cellLines splits on newlines only", () => {
    expect(cellLines("a<br>b")).toEqual(["a<br>b"]); // parser already converted the break
    expect(cellLines("a\nb")).toEqual(["a", "b"]);
    expect(cellLines("trailing\n")).toEqual(["trailing", ""]);
    expect(cellLines("")).toEqual([""]);
  });
});

describe("renderEntry — tool-line wrapping", () => {
  it("cell-caps a collapsed tool line instead of wrapping it", () => {
    const longArgs = '{"cmd":"' + "x".repeat(120) + '"}';
    const entry: LogEntry = {
      kind: "tool",
      lines: [`⚙️ bash ❌ missing required field "script" ${longArgs}`],
    };
    const cols = 40;
    const rows = cachedRows(entry, cols);
    // ONE physical line: the overlong line is cell-capped, never wrapped
    expect(rows.length).toBe(1);
    // The style pads to the block width (cols); content itself capped to cols-2
    expect(displayWidth(stripAnsi(rows[0]!))).toBeLessThanOrEqual(cols);
    // The error reason survives the cap (label comes first)
    expect(stripAnsi(rows[0]!)).toContain("⚙️ bash ❌");
  });

  it("expanded tool bodies still wrap", () => {
    const entry: LogEntry = {
      kind: "tool",
      lines: ["⚙️ bash ❌ boom"],
      full: "a ".repeat(60),
      expanded: true,
    };
    const rows = cachedRows(entry, 40);
    expect(rows.length).toBeGreaterThan(1);
    expect(stripAnsi(rows[0]!)).toContain("⚙️ bash ❌ boom");
  });
});
