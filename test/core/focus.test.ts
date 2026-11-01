import { describe, expect, it } from "vitest";

import {
  FOCUS_NONE_TARGET,
  focusRing,
  isProseTable,
  moveFocus,
  tableCount,
} from "../../src/core/focus.ts";
import { parseTable, splitTableSections } from "../../src/ui/render/table.ts";

const k = (kind: string, lines?: string[]) => ({ kind, lines: lines ?? [] });

/** A prose entry carrying exactly one table. */
const ONE_TABLE = (md: string) => k("assistant", md.split("\n"));
const TWO_TABLE = (a: string, b: string) => k("assistant", `${a}\n\n${b}`.split("\n"));

const T1 = `| A | B |
| --- | --- |
| 1 | 2 |`;
const T2 = `| X | Y |
| --- | --- |
| 3 | 4 |`;

const isTable = (e: { kind: string; lines?: readonly string[] }) =>
  isProseTable(e, (text) => parseTable(text));
const nTables = (e: { kind: string; lines?: readonly string[] }) =>
  tableCount(e, (text) => splitTableSections(text));

describe("focusRing — flat list of targets", () => {
  it("chunk/tool entries contribute one target each", () => {
    const entries = [k("system"), k("tool"), k("user"), k("chunk"), k("assistant")];
    expect(focusRing(entries, ["chunk", "tool"])).toEqual([
      { entry: 1, table: -1 },
      { entry: 3, table: -1 },
    ]);
  });

  it("a prose entry with one table contributes one table target", () => {
    const entries = [ONE_TABLE(T1)];
    expect(focusRing(entries, ["chunk", "tool"], isTable, nTables)).toEqual([
      { entry: 0, table: 0 },
    ]);
  });

  it("a prose entry with two tables contributes two table targets", () => {
    const entries = [TWO_TABLE(T1, T2)];
    expect(focusRing(entries, ["chunk", "tool"], isTable, nTables)).toEqual([
      { entry: 0, table: 0 },
      { entry: 0, table: 1 },
    ]);
  });

  it("tables are walked before the next entry", () => {
    const entries = [k("chunk"), ONE_TABLE(T1), ONE_TABLE(T2)];
    expect(focusRing(entries, ["chunk", "tool"], isTable, nTables)).toEqual([
      { entry: 0, table: -1 },
      { entry: 1, table: 0 },
      { entry: 2, table: 0 },
    ]);
  });

  it("is empty when nothing is focusable", () => {
    expect(focusRing([k("system"), k("user")], ["chunk", "tool"], isTable, nTables)).toEqual([]);
  });
});

describe("tableCount", () => {
  it("counts tables in prose entries", () => {
    expect(tableCount(ONE_TABLE(T1), splitTableSections)).toBe(1);
    expect(tableCount(TWO_TABLE(T1, T2), splitTableSections)).toBe(2);
    expect(tableCount(k("assistant", ["just prose"]), splitTableSections)).toBe(0);
    expect(tableCount(k("chunk", ["x"]), splitTableSections)).toBe(0);
  });
});

describe("moveFocus — table-level ring", () => {
  const entries = [k("system"), k("tool"), k("user"), k("chunk"), ONE_TABLE(T1), ONE_TABLE(T2)];
  // ring: tool(1,-1), chunk(3,-1), table0(4,0), table1(5,0)

  it("enters at the first target when starting from none (Tab)", () => {
    expect(moveFocus(entries, FOCUS_NONE_TARGET, 1, isTable, nTables)).toEqual({
      entry: 1,
      table: -1,
    });
  });

  it("enters at the last target when starting from none (Shift-Tab)", () => {
    expect(moveFocus(entries, FOCUS_NONE_TARGET, -1, isTable, nTables)).toEqual({
      entry: 5,
      table: 0,
    });
  });

  it("cycles forward through the ring", () => {
    expect(moveFocus(entries, { entry: 1, table: -1 }, 1, isTable, nTables)).toEqual({
      entry: 3,
      table: -1,
    });
    expect(moveFocus(entries, { entry: 3, table: -1 }, 1, isTable, nTables)).toEqual({
      entry: 4,
      table: 0,
    });
    expect(moveFocus(entries, { entry: 4, table: 0 }, 1, isTable, nTables)).toEqual({
      entry: 5,
      table: 0,
    });
  });

  it("cycles backward through the ring", () => {
    expect(moveFocus(entries, { entry: 5, table: 0 }, -1, isTable, nTables)).toEqual({
      entry: 4,
      table: 0,
    });
    expect(moveFocus(entries, { entry: 4, table: 0 }, -1, isTable, nTables)).toEqual({
      entry: 3,
      table: -1,
    });
    expect(moveFocus(entries, { entry: 3, table: -1 }, -1, isTable, nTables)).toEqual({
      entry: 1,
      table: -1,
    });
  });

  it("wraps through none at the end of the ring (Tab past last)", () => {
    expect(moveFocus(entries, { entry: 5, table: 0 }, 1, isTable, nTables)).toEqual(
      FOCUS_NONE_TARGET,
    );
    // …and the next press continues from that end.
    expect(moveFocus(entries, FOCUS_NONE_TARGET, 1, isTable, nTables)).toEqual({
      entry: 1,
      table: -1,
    });
  });

  it("wraps through none at the start of the ring (Shift-Tab past first)", () => {
    expect(moveFocus(entries, { entry: 1, table: -1 }, -1, isTable, nTables)).toEqual(
      FOCUS_NONE_TARGET,
    );
    // …and the next press continues from that end.
    expect(moveFocus(entries, FOCUS_NONE_TARGET, -1, isTable, nTables)).toEqual({
      entry: 5,
      table: 0,
    });
  });

  it("stays at none when there are no focusable entries", () => {
    const plain = [k("system"), k("user")];
    expect(moveFocus(plain, FOCUS_NONE_TARGET, 1, isTable, nTables)).toEqual(FOCUS_NONE_TARGET);
    expect(moveFocus(plain, { entry: 0, table: -1 }, -1, isTable, nTables)).toEqual(
      FOCUS_NONE_TARGET,
    );
  });
});

describe("moveFocus — tables inside one entry are independent", () => {
  it("walks through both tables in a two-table entry before moving on", () => {
    const entries = [TWO_TABLE(T1, T2), k("chunk")];
    // ring: table0(0,0), table1(0,1), chunk(1,-1)
    expect(moveFocus(entries, FOCUS_NONE_TARGET, 1, isTable, nTables)).toEqual({
      entry: 0,
      table: 0,
    });
    expect(moveFocus(entries, { entry: 0, table: 0 }, 1, isTable, nTables)).toEqual({
      entry: 0,
      table: 1,
    });
    expect(moveFocus(entries, { entry: 0, table: 1 }, 1, isTable, nTables)).toEqual({
      entry: 1,
      table: -1,
    });
  });
});
