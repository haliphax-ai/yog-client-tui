import { describe, expect, it } from "vitest";

import { ChatLogComponent } from "../../../src/ui/components/ChatLogComponent.ts";
import { type FocusTarget } from "../../../src/core/focus.ts";
import type { LogEntry } from "../../../src/core/entries.ts";
import { focusUnits } from "../../../src/ui/render/index.ts";
import { stripAnsi } from "../../../src/util/ansi.ts";

class Log extends ChatLogComponent {}

const COLS = 80;
const T = (entry: number, table = -1): FocusTarget => ({ entry, table });

function debugEntry(bodyLines: number): LogEntry {
  const body = Array.from({ length: bodyLines }, (_, i) => `dbg ${i + 1}`);
  return { kind: "debug", lines: ["🐞 debug →", ...body], collapsed: true };
}

describe("debug chunks — focus / collapse / expand", () => {
  it("contributes one focusable unit per debug chunk", () => {
    const entries: LogEntry[] = [
      { kind: "system", lines: ["conn"] },
      debugEntry(8),
      { kind: "assistant", lines: ["hi"] },
      debugEntry(3),
    ];
    // The assistant prose entry is now focusable too (for copy/branching
    // groundwork), so it contributes one unit between the two chunks.
    expect(focusUnits(entries)).toEqual([
      { entry: 1, table: -1 },
      { entry: 2, table: -1 },
      { entry: 3, table: -1 },
    ]);
  });

  it("toggles collapse on a focused debug chunk", () => {
    const log = new Log([debugEntry(8)]);
    log.setFocus(T(0));
    expect(log.toggleFocused()).toBe(true);
    expect(log.getEntries()[0]?.collapsed).toBe(false);
    expect(log.toggleFocused()).toBe(true);
    expect(log.getEntries()[0]?.collapsed).toBe(true);
  });

  it("renders collapsed by default: header + 5 body lines + footer", () => {
    const log = new Log([debugEntry(8)]);
    log.setViewportRows(20);
    const rows = log.render({ cols: COLS });
    const text = rows.map((r) => stripAnsi(r)).join("\n");
    expect(text).toContain("🐞 debug");
    expect(text).toContain("dbg 5");
    expect(text).toContain("… +3 lines (focus, Enter)");
    expect(text).not.toContain("dbg 6");
  });

  it("renders the full body when expanded", () => {
    const log = new Log([debugEntry(8)]);
    log.setViewportRows(20);
    log.setFocus(T(0));
    log.toggleFocused();
    const rows = log.render({ cols: COLS });
    const text = rows.map((r) => stripAnsi(r)).join("\n");
    expect(text).toContain("dbg 8");
    expect(text).not.toContain("… +3 lines");
  });

  it("short debug bodies are always full-height (never collapse)", () => {
    const log = new Log([debugEntry(2)]);
    log.setViewportRows(20);
    const rows = log.render({ cols: COLS });
    const text = rows.map((r) => stripAnsi(r)).join("\n");
    expect(text).toContain("dbg 2");
    expect(text).not.toContain("(focus, Enter)");
  });
});
