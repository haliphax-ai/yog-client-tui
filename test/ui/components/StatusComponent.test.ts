import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  formatTokenTotal,
  sessionStats,
  statusBody,
  StatusComponent,
} from "../../../src/ui/components/StatusComponent.ts";
import { resetForTests, setState } from "../../../src/core/store.ts";
import { displayWidth, stripAnsi } from "../../../src/util/ansi.ts";
import type { LogEntry } from "../../../src/core/entries.ts";

/** Collect one status line body, then restore the default store. */
function body(patch: Parameters<typeof setState>[0]): string {
  setState(patch);
  return statusBody();
}

/** A log with `turns` user messages and `toolCalls` ⚙️ call entries. */
function fixture(turns: number, toolCalls: number): LogEntry[] {
  return [
    ...Array.from({ length: turns }, () => ({ kind: "user" as const, lines: ["hello"] })),
    ...Array.from({ length: toolCalls }, () => ({ kind: "tool" as const, lines: ["⚙️ run"] })),
  ];
}

describe("statusBody", () => {
  beforeEach(() => {
    resetForTests();
  });
  afterEach(() => {
    resetForTests();
  });

  it("shows session and stats segments separated by a vertical bar", () => {
    const out = body({ model: "m-1", entries: fixture(2, 27) });
    expect(out).toBe("👤 m-1 ╱ 🔄 2  🔧 27");
  });

  it("stays on session + stats while busy (generating lives elsewhere)", () => {
    const out = body({ busy: true, model: "m-1" });
    expect(out).toBe("👤 m-1 ╱ 🔄 0  🔧 0");
    expect(out).not.toContain("generating");
  });

  it("counts turns and tool calls from the log entries", () => {
    expect(sessionStats(fixture(2, 27))).toEqual({ turns: 2, toolCalls: 27 });
    expect(sessionStats([])).toEqual({ turns: 0, toolCalls: 0 });
    // assistant/chunk/system entries do not count
    expect(
      sessionStats([
        { kind: "assistant", lines: ["hi"] },
        { kind: "chunk", lines: ["x"], collapsed: true },
        { kind: "system", lines: ["y"] },
        { kind: "toolResult", lines: ["🔚 noop"] },
      ]),
    ).toEqual({ turns: 0, toolCalls: 0 });
  });

  it("shows the 🪙 token total in the stats segment once totals exist", () => {
    const out = body({
      model: "m-1",
      entries: fixture(2, 27),
      tokenTotals: { prompt: 1200, completion: 600, total: 1800 },
    });
    expect(out).toBe("👤 m-1 ╱ 🔄 2  🔧 27  🪙 1.8K tok");
  });

  it("omits the 🪙 stat while totals are zero (no turns yet)", () => {
    const out = body({ model: "m-1", entries: fixture(0, 0) });
    expect(out).toBe("👤 m-1 ╱ 🔄 0  🔧 0");
  });

  it("falls back to prompt+completion when total is absent", () => {
    const out = body({
      model: "m-1",
      entries: fixture(1, 0),
      tokenTotals: { prompt: 1000, completion: 500, total: 0 },
    });
    expect(out).toBe("👤 m-1 ╱ 🔄 1  🔧 0  🪙 1.5K tok");
  });

  it("uses bright green for very low fill (<=10%)", () => {
    const out = body({
      model: "m-1",
      entries: fixture(1, 0),
      tokenTotals: { prompt: 1000, completion: 0, total: 1000 },
      contextWindow: 20000,
    });
    expect(stripAnsi(out)).toBe("👤 m-1 ╱ 🔄 1  🔧 0  🪙 5.0%/20.0K");
    expect(out).toContain("38;2;0;255;0"); // CONTEXT_WINDOW.brightGreen
    expect(out).toContain("38;2;0;0;0"); // restored status-bar black
  });

  it("uses green for low fill (<=25%)", () => {
    const out = body({
      model: "m-1",
      entries: fixture(1, 0),
      tokenTotals: { prompt: 1200, completion: 1800, total: 3000 },
      contextWindow: 20000,
    });
    // 3000 / 20000 = 15% → green band; window abbreviates to 20.0K.
    expect(stripAnsi(out)).toBe("👤 m-1 ╱ 🔄 1  🔧 0  🪙 15.0%/20.0K");
    expect(out).toContain("38;2;0;200;0"); // CONTEXT_WINDOW.green
    expect(out).toContain("38;2;0;0;0"); // restored status-bar black
  });

  it("uses yellow for mid fill (<=50%)", () => {
    const out = body({
      model: "m-1",
      entries: fixture(1, 0),
      tokenTotals: { prompt: 0, completion: 0, total: 40000 },
      contextWindow: 100000,
    });
    expect(stripAnsi(out)).toContain("🪙 40.0%/100.0K");
    expect(out).toContain("38;2;255;255;0"); // CONTEXT_WINDOW.yellow
    expect(out).toContain("38;2;0;0;0"); // restored status-bar black
  });

  it("uses orange for high fill (<=75%)", () => {
    const out = body({
      model: "m-1",
      entries: fixture(1, 0),
      tokenTotals: { prompt: 0, completion: 0, total: 60000 },
      contextWindow: 100000,
    });
    expect(stripAnsi(out)).toContain("🪙 60.0%/100.0K");
    expect(out).toContain("38;2;255;165;0"); // CONTEXT_WINDOW.orange
    expect(out).toContain("38;2;0;0;0"); // restored status-bar black
  });

  it("uses red for critical fill (>75%)", () => {
    const out = body({
      model: "m-1",
      entries: fixture(1, 0),
      tokenTotals: { prompt: 0, completion: 0, total: 80000 },
      contextWindow: 100000,
    });
    expect(stripAnsi(out)).toContain("🪙 80.0%/100.0K");
    expect(out).toContain("38;2;255;0;0"); // CONTEXT_WINDOW.red
    expect(out).toContain("38;2;0;0;0"); // restored status-bar black
  });

  it("omits the context-window segment when it is unknown or zero", () => {
    const totals = { prompt: 1200, completion: 1800, total: 3000 };
    const base = {
      model: "m-1",
      entries: fixture(1, 0),
      tokenTotals: totals,
    };
    expect(stripAnsi(body(base))).toBe("👤 m-1 ╱ 🔄 1  🔧 0  🪙 3.0K tok");
    expect(stripAnsi(body({ ...base, contextWindow: 0 }))).toBe("👤 m-1 ╱ 🔄 1  🔧 0  🪙 3.0K tok");
  });

  it("removes the key legend segment", () => {
    const out = body({ busy: true, model: "m-1" });
    expect(out).not.toContain("Shift+Up/Down focus");
    expect(out).not.toContain("Enter send");
    expect(out).not.toContain("/quit exit");
    expect(out).not.toContain("thinking");
  });
});

describe("StatusComponent render", () => {
  afterEach(() => {
    resetForTests();
  });

  it("renders dark grey backing with black text, padded to the width", () => {
    const line = new StatusComponent().render({ cols: 80 });
    expect(line).toContain("48;2;63;63;70"); // #3f3f46 background
    expect(line).toContain("38;2;0;0;0"); // black text
    expect(displayWidth(stripAnsi(line))).toBe(80);
  });

  it("pads the status bar with 1 cell on each side inside the backing", () => {
    setState({ model: "m-1" });
    const line = new StatusComponent().render({ cols: 80 });
    const plain = stripAnsi(line);
    expect(plain.startsWith(" 👤 m-1")).toBe(true);
    expect(plain.endsWith(" ")).toBe(true);
    expect(displayWidth(line)).toBe(80);
    // Emoji regression: padding is measured in cells (👤 is 2 cells),
    // so the padded row is still exactly cols wide.
    expect(plain).toContain("👤");
    // The backing runs the full width: every cell carries the status-bar
    // background, including the padding and trailing fill cells.
    let bg = false;
    const covered: boolean[] = [];
    // eslint-disable-next-line no-control-regex
    for (const tok of line.split(/(\x1b\[[0-9;]*m)/)) {
      if (tok.startsWith("\x1b[")) {
        if (tok.includes("48;2;63;63;70")) bg = true;
        if (tok === "\x1b[m") bg = false;
        continue;
      }
      for (const ch of tok) {
        for (let i = 0; i < displayWidth(ch); i++) covered.push(bg);
      }
    }
    expect(covered).toHaveLength(80);
    expect(covered.every(Boolean)).toBe(true);
  });

  it("truncates an overlong status body to the padded interior", () => {
    setState({ model: "a-very-long-model-name-here" });
    const line = new StatusComponent().render({ cols: 10 });
    expect(displayWidth(line)).toBe(10);
    expect(stripAnsi(line).startsWith(" ")).toBe(true);
  });

  it("shows no generating label while busy", () => {
    setState({ busy: true, model: "m-1" });
    const line = new StatusComponent().render({ cols: 80 });
    expect(stripAnsi(line)).not.toContain("generating");
    expect(line).toContain("48;2;63;63;70"); // #3f3f46 background
  });

  it("emoji labels are two cells wide", () => {
    for (const label of ["👤", "🔄", "🔧", "🪙"]) {
      expect(displayWidth(label)).toBe(2);
    }
  });
});

describe("formatTokenTotal", () => {
  const cases: Array<[number, string]> = [
    [999, "999"],
    [1109, "1.1K"],
    [1590, "1.6K"],
    [1000000, "1.0M"],
    [1123456, "1.1M"],
    [999950, "1.0M"],
  ];
  for (const [input, expected] of cases) {
    it(`formats ${input} as ${expected}`, () => {
      expect(formatTokenTotal(input)).toBe(expected);
    });
  }
});
