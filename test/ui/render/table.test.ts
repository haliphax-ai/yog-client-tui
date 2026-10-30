import { describe, expect, it } from "vitest";

import { parseTable } from "../../../src/ui/render/table.ts";

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