import { describe, expect, it } from "vitest";

import { parseTable, splitTableSections } from "../../../src/ui/render/table.ts";

describe("parseTable — GFM pipe tables", () => {
  it("parses a basic table with header and two data rows", () => {
    const md = `| Name | Age |
| --- | --- |
| Alice | 30 |
| Bob | 25 |`;

    const t = parseTable(md);
    expect(t).not.toBeNull();
    expect(t!.columns).toEqual([
      { title: "Name", width: 5 },
      { title: "Age", width: 3 },
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
      { title: "Name", width: 5 },
      { title: "Age", width: 3 },
    ]);
  });

  it("computes column width from the widest cell", () => {
    const md = `| Name | Value |
| --- | --- |
| Alice | hello world |
| B | x |`;

    const t = parseTable(md);
    expect(t!.columns).toEqual([
      { title: "Name", width: 5 },
      { title: "Value", width: 11 },
    ]);
  });

  it("handles escaped pipes inside cells", () => {
    const md = `| a | b |
| --- | --- |
| x\\|y | z |`;

    const t = parseTable(md);
    expect(t!.rows).toEqual([["x|y", "z"]]);
  });

  it("handles left/right/center alignment in the delimiter", () => {
    const md = `| left | center | right |
| :--- | :---: | ---: |
| a | b | c |`;

    const t = parseTable(md);
    expect(t).not.toBeNull();
    expect(t!.columns).toHaveLength(3);
    // Alignment is cosmetic — the parser doesn't need to preserve it
    expect(t!.rows).toEqual([["a", "b", "c"]]);
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
      { title: "Name", width: 4 },
      { title: "Age", width: 3 },
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
      { title: "Name", width: 5 },
      { title: "Age", width: 3 },
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
      { title: "Name", width: 5 },
      { title: "Description", width: 19 },
    ]);
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