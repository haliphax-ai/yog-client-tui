import { describe, expect, it } from "vitest";

import { focusUnits } from "../../src/ui/render/entry.ts";
import type { LogEntry } from "../../src/core/entries.ts";

const T1 = `| A | B |\n| --- | --- |\n| 1 | 2 |`;
const T2 = `| X | Y |\n| --- | --- |\n| 3 | 4 |`;

/** A prose entry carrying exactly one table. */
const oneTable = (md: string): LogEntry => ({ kind: "assistant", lines: md.split("\n") });
/** A prose entry carrying two tables. */
const twoTables = (): LogEntry => ({ kind: "assistant", lines: `${T1}\n\n${T2}`.split("\n") });

describe("focusUnits — the ring is built from the rendered sections", () => {
  it("chunk/tool/user/assistant entries contribute one unit each", () => {
    const entries: LogEntry[] = [
      { kind: "system", lines: ["x"] },
      { kind: "tool", lines: ["x"] },
      { kind: "user", lines: ["x"] },
      { kind: "chunk", lines: ["x"] },
      { kind: "assistant", lines: ["x"] },
    ];
    expect(focusUnits(entries)).toEqual([
      { entry: 1, table: -1 },
      { entry: 2, table: -1 },
      { entry: 3, table: -1 },
      { entry: 4, table: -1 },
    ]);
  });

  it("a prose entry contributes its entry unit, then its tables", () => {
    expect(focusUnits([oneTable(T1)])).toEqual([
      { entry: 0, table: -1 },
      { entry: 0, table: 0 },
    ]);
  });

  it("a prose entry with two tables contributes three units", () => {
    expect(focusUnits([twoTables()])).toEqual([
      { entry: 0, table: -1 },
      { entry: 0, table: 0 },
      { entry: 0, table: 1 },
    ]);
  });

  it("the entry's tables are walked before the next entry", () => {
    const entries: LogEntry[] = [{ kind: "chunk", lines: ["x"] }, oneTable(T1), oneTable(T2)];
    expect(focusUnits(entries)).toEqual([
      { entry: 0, table: -1 },
      { entry: 1, table: -1 },
      { entry: 1, table: 0 },
      { entry: 2, table: -1 },
      { entry: 2, table: 0 },
    ]);
  });

  it("system entries are never focusable", () => {
    const entries: LogEntry[] = [
      { kind: "system", lines: ["x"] },
      { kind: "error", lines: ["x"] },
    ];
    expect(focusUnits(entries)).toEqual([]);
  });

  it("a pipe in prose does not hide the table that follows it", () => {
    // The prose line carries a pipe — the renderer still draws the table
    // after it, so the table must still be in the ring.
    const entry: LogEntry = {
      kind: "assistant",
      lines: ["Summary line with a | pipe in it", "", ...T1.split("\n")],
    };
    expect(focusUnits([entry])).toEqual([
      { entry: 0, table: -1 },
      { entry: 0, table: 0 },
    ]);
  });
});
