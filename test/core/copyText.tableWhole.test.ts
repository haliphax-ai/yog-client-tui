import { beforeEach, describe, expect, it } from "vitest";
import { resetForTests, setState } from "../../src/core/store.ts";
import { proseCopyRequest, tableCopyRequest } from "../../src/core/copyText.ts";
import type { LogEntry } from "../../src/core/entries.ts";

describe("Shift+C through a tool result chunk (table inside streamed output)", () => {
  beforeEach(() => resetForTests());

  it("resolves the whole message via the prose chunk that holds the stamp", () => {
    const prose: LogEntry = {
      kind: "assistant",
      lines: ["before"],
      copyText: "before",
      copyIds: { itemId: "m1", wholeMessage: "WHOLE MESSAGE" },
    };
    const result: LogEntry = {
      kind: "toolResult",
      lines: ["| A | B |", "| - | - |", "| 1 | 2 |"],
      collapsed: true,
      result: { stdout: "x" },
      argsRaw: "{}",
      copyIds: { itemId: "c1" },
    };
    setState({ entries: [prose, result] });
    expect(proseCopyRequest(result, "sess-9", true)).toEqual({
      content: "WHOLE MESSAGE",
      itemId: "sess-9_c1",
      provided: true,
    });
  });

  it("table copy ids stay <session>_<entry>_<index>", () => {
    const result: LogEntry = {
      kind: "toolResult",
      lines: [],
      collapsed: true,
      argsRaw: "{}",
      copyIds: { itemId: "c1" },
    };
    expect(
      tableCopyRequest(
        result,
        { columns: [{ title: "A", align: "left", width: 1 }], rows: [["1"]] },
        0,
        "sess-9",
      ),
    ).toEqual({
      content: "| A |\n| --- |\n| 1 |",
      itemId: "sess-9_c1_0",
      provided: true,
    });
  });
});
