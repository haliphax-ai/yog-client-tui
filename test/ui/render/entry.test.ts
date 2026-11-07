import { describe, expect, it } from "vitest";

import { cachedRows, totalRows } from "../../../src/ui/render/entry.ts";
import { C, ST } from "../../../src/ui/theme.ts";
import { displayWidth, stripAnsi } from "../../../src/util/ansi.ts";
import type { LogEntry } from "../../../src/core/entries.ts";

/** The border cell: themed half-block rune + the single separator space. */
const BORDER = `${ST.assistantBorder.render("▐")} `;

describe("assistant prose left border", () => {
  it("prefixes every row of the prose with the themed border", () => {
    // Long enough to wrap (markdown soft-breaks merge short lines).
    const rows = cachedRows(
      {
        kind: "assistant",
        lines: ["first paragraph line that is long enough to wrap somewhere around here for sure"],
      },
      40,
    );
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      expect(row.startsWith(BORDER)).toBe(true);
      // The rune appears exactly once per row — at the border.
      expect(stripAnsi(row).indexOf("▐")).toBe(0);
      expect(stripAnsi(row).lastIndexOf("▐")).toBe(0);
    }
  });

  it("leaves the two-cell gutter intact when the prose wraps", () => {
    const cols = 20;
    const rows = cachedRows(
      { kind: "assistant", lines: ["this is a long reply that wraps across rows"] },
      cols,
    );
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      expect(row.startsWith(BORDER)).toBe(true);
      // Border (1 cell) + space (1 cell) + prose never exceeds the width.
      expect(stripAnsi(row).length).toBeLessThanOrEqual(cols);
    }
    // Round-trip: the prose survives wrapping with one border per row.
    const plain = stripAnsi(rows.join("\n"));
    for (const word of ["this", "is", "a", "long", "reply", "that", "wraps"]) {
      expect(plain).toContain(word);
    }
  });

  it("keeps prose markdown styling on continuation rows with the border", () => {
    const rows = cachedRows(
      { kind: "assistant", lines: ["a **bold** continuation of the paragraph"] },
      24,
    );
    for (const row of rows) expect(row.startsWith(BORDER)).toBe(true);
    // No row carries a second border rune: prose never inherits or
    // duplicates the border, and the border never wraps into the prose.
    for (const row of rows) {
      const plain = stripAnsi(row);
      expect(plain.indexOf("▐")).toBe(0);
      expect(plain.lastIndexOf("▐")).toBe(0);
    }
  });

  it("does not colorize the prose like a tool line (no arg-palette leaks)", () => {
    const rows = cachedRows({ kind: "assistant", lines: ['{"not": "a tool"}'] }, 40);
    // Glamour right-pads rows to the wrap width; compare without padding.
    expect(stripAnsi(rows[0] ?? "").trimEnd()).toBe('▐ {"not": "a tool"}');
    expect((rows[0] ?? "").includes(C.punct)).toBe(false);
  });
});

describe("user prompt — padded bubble", () => {
  it("renders prompt rows with 1-cell horizontal padding", () => {
    const rows = cachedRows({ kind: "user", lines: ["hello world"] }, 40);
    // Vertical padding: 1 blank row above and below the content.
    expect(rows.length).toBe(3);
    expect(stripAnsi(rows[0] ?? "").trim()).toBe("");
    expect(stripAnsi(rows[2] ?? "").trim()).toBe("");
    // Horizontal padding: content starts one cell in from the left edge.
    const content = stripAnsi(rows[1] ?? "");
    expect(content.indexOf("hello")).toBe(1);
    expect(content).toContain("hello world");
  });

  it("hard-wraps overlong prompts at cols-2", () => {
    const cols = 20;
    const rows = cachedRows(
      { kind: "user", lines: ["this is a long prompt that wraps across rows"] },
      cols,
    );
    expect(rows.length).toBeGreaterThan(3);
    for (const row of rows) {
      expect(stripAnsi(row).length).toBeLessThanOrEqual(cols);
    }
    // Round-trip: the whole prompt survives wrapping intact.
    const plain = stripAnsi(rows.join("\n"));
    for (const word of ["this", "is", "a", "long", "prompt", "that", "wraps", "across"]) {
      expect(plain).toContain(word);
    }
  });

  it("keeps emphasis on wrapped continuation rows at the bubble's own colors", () => {
    // glamour re-emits wrap-split state as attr-leading combined SGRs
    // (`3;38;2;r;g;b`); the flattener must strip the theme fg but keep the
    // italic — otherwise continuation rows paint in glamour's blue-grey and
    // the emphasis drifts past its run.
    const rows = cachedRows(
      {
        kind: "user",
        lines: [
          "plain start *this italic run is long enough to wrap somewhere around here for sure* plain end",
        ],
      },
      30,
    );
    expect(rows.length).toBeGreaterThan(3);
    // The bubble fg (#d4d4d8 → 38;2;212;212;216) leads every content row;
    // glamour's #a9b1d6 (38;2;169;177;214) never appears on the user path.
    for (const row of rows) {
      expect(row).not.toContain("\x1b[38;2;169;177;214m");
      // eslint-disable-next-line no-control-regex
      expect(row).not.toMatch(/\x1b\[3;38;2;\d+;\d+;\d+m/);
    }
    // Emphasis survives on the wrapped rows: italic runs are re-emitted
    // standalone (`3`), never fused with a theme color.
    const italicRows = rows.filter((r) => r.includes("\x1b[3m"));
    expect(italicRows.length).toBeGreaterThanOrEqual(2);
    for (const row of italicRows) {
      expect(row).toContain("\x1b[3m");
      expect(row).toContain("\x1b[23m");
    }
    // Content round-trips: every word survives the wrap + flatten.
    const plain = stripAnsi(rows.join("\n"));
    for (const word of ["plain", "start", "italic", "run", "somewhere", "sure", "end"]) {
      expect(plain).toContain(word);
    }
  });

  it("keeps bold on wrapped continuation rows at the bubble's own colors", () => {
    const rows = cachedRows(
      {
        kind: "user",
        lines: ["a **very bold statement that spans across the wrap boundary here** tail"],
      },
      30,
    );
    for (const row of rows) {
      expect(row).not.toContain("\x1b[38;2;169;177;214m");
      // eslint-disable-next-line no-control-regex
      expect(row).not.toMatch(/\x1b\[1;38;2;\d+;\d+;\d+m/);
    }
    const boldRows = rows.filter((r) => r.includes("\x1b[1m"));
    expect(boldRows.length).toBeGreaterThanOrEqual(2);
  });
});

describe("notice and error entries", () => {
  it("renders one line: padded label, dot, dimmed detail", () => {
    const rows = cachedRows({ kind: "notice", lines: ["⏹️ turn aborted", "by operator"] }, 40);
    expect(rows).toHaveLength(1);
    // The padded label, mid-dot separator, and dimmed detail — one row.
    // Padding is TRUE padding: a space on BOTH sides (the trailing space is
    // the right pad, so the notice never butts against the viewport edge).
    expect(stripAnsi(rows[0] ?? "")).toBe(" ⏹️ turn aborted · by operator ");
    // The label carries the themed style; the detail carries the dim style.
    expect(rows[0]).toContain(ST.notice.render("⏹️ turn aborted"));
    expect(rows[0]).toContain(ST.noticeDetail.render("by operator"));
  });

  it("renders label only, no separator when there is no detail", () => {
    const rows = cachedRows({ kind: "notice", lines: ["⏹️ turn aborted", ""] }, 40);
    expect(rows).toHaveLength(1);
    expect(stripAnsi(rows[0] ?? "")).toBe(" ⏹️ turn aborted ");
    expect(rows[0]).toContain(ST.notice.render("⏹️ turn aborted"));
    expect(rows[0]).not.toContain("\x1b[39m");
  });

  it("wraps a long detail so every word survives (never truncated)", () => {
    const detail = "a very long detail line that would overflow the terminal width";
    const rows = cachedRows({ kind: "error", lines: ["❌ turn error", detail] }, 30);
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      expect(displayWidth(row)).toBeLessThanOrEqual(30);
    }
    // TRUE padding on the WHOLE block: every wrapped row — continuation rows
    // included — carries a 1-cell pad on both sides, so the block never butts
    // up against either edge of the viewport.
    for (const row of rows) {
      const plain = stripAnsi(row);
      expect(plain.startsWith(" ")).toBe(true);
      expect(plain.endsWith(" ")).toBe(true);
    }
    // Round-trip: the whole detail survives wrapping intact.
    const plain = stripAnsi(rows.join("\n"));
    for (const word of detail.split(" ")) {
      expect(plain).toContain(word);
    }
    // The label carries its themed style; the detail is dimmed.
    expect(rows[0]).toContain(ST.notice.render("❌ turn error"));
    expect(rows[1]).toContain(ST.noticeDetail.render("detail line that would"));
  });

  it("wraps wide emoji by CELLS, not characters (regression)", () => {
    // 20 emoji are 20 characters but 40 cells — a char-based wrap budget
    // would emit 80-cell rows and push content past the terminal edge.
    const rows = cachedRows({ kind: "error", lines: ["❌ turn error", "✅".repeat(20)] }, 30);
    for (const row of rows) {
      expect(displayWidth(row)).toBeLessThanOrEqual(30);
    }
    expect(stripAnsi(rows.join("\n"))).toContain("✅".repeat(14));
  });

  it("styles wait notices (⚠️) yellow instead of the info blue", () => {
    const rows = cachedRows(
      { kind: "notice", lines: ["⚠️ warning", "wait for the current turn, then /new"] },
      60,
    );
    expect(rows).toHaveLength(1);
    expect(stripAnsi(rows[0] ?? "")).toBe(" ⚠️ warning · wait for the current turn, then /new ");
    expect(rows[0]).toContain(ST.noticeWait.render("⚠️ warning"));
    expect(rows[0]).toContain(ST.noticeDetail.render("wait for the current turn, then /new"));
  });

  it("styles lifecycle notices (🪧) in the blue-grey tone", () => {
    const rows = cachedRows(
      { kind: "notice", lines: ["🪧 recovered", "stream interrupted — resumed"] },
      60,
    );
    expect(rows).toHaveLength(1);
    expect(stripAnsi(rows[0] ?? "")).toBe(" 🪧 recovered · stream interrupted — resumed ");
    expect(rows[0]).toContain(ST.noticeSystem.render("🪧 recovered"));
    expect(rows[0]).toContain(ST.noticeDetail.render("stream interrupted — resumed"));
  });

  it("counts one terminal row per rendered row (wrapping included)", () => {
    const entry: LogEntry = {
      kind: "error",
      lines: ["❌ turn error", "x".repeat(95)],
    };
    // One logical line word-wrapped at 38 cells: 4 rows (label + 3), plus
    // the separator.
    expect(totalRows([entry], 40)).toBe(5);
  });
});

describe("plain fallback (unhandled kinds)", () => {
  it("wraps a long system line instead of truncating it", () => {
    const lines = [
      "system message that is quite long and will definitely overflow the forty column terminal width",
    ];
    const rows = cachedRows({ kind: "system", lines }, 40);
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(40);
    // Round-trip: the whole line survives wrapping intact.
    const plain = stripAnsi(rows.join("\n"));
    for (const word of lines[0]?.split(" ") ?? []) {
      expect(plain).toContain(word);
    }
  });

  it("styles every wrapped row with the kind's style (no drift)", () => {
    const rows = cachedRows(
      {
        kind: "system",
        lines: ["a very long system transcript line that wraps somewhere around here for sure"],
      },
      30,
    );
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      expect(row).toContain(ST.system.render(stripAnsi(row).trimEnd()));
    }
  });

  it("keeps hard-wrapped wide emoji within the cell budget", () => {
    // 20 emoji are 20 characters but 40 cells — a char-count wrap would
    // emit 80-cell rows; the cell-based budget must hard-break them.
    const rows = cachedRows({ kind: "system", lines: ["✅".repeat(20)] }, 30);
    for (const row of rows) {
      expect(displayWidth(row)).toBeLessThanOrEqual(30);
    }
    expect(stripAnsi(rows.join("\n")).replace(/\n/g, "")).toContain("✅".repeat(20));
  });

  it("wraps every logical line of a multi-line entry", () => {
    const rows = cachedRows(
      {
        kind: "system",
        lines: [
          "short",
          "a very long system transcript line that wraps somewhere around here for sure",
        ],
      },
      30,
    );
    // 1 row for "short" + 3 wrapped rows for the long line.
    expect(rows.length).toBe(4);
    expect(stripAnsi(rows[0] ?? "")).toBe("short");
  });

  it("counts one terminal row per wrapped row", () => {
    const entry: LogEntry = {
      kind: "system",
      lines: ["a very long system transcript line that wraps somewhere around here for sure"],
    };
    expect(totalRows([entry], 30)).toBe(4); // 3 wrapped rows + separator
  });
});

describe("height summary", () => {
  it("counts one terminal row per rendered row plus the separator", () => {
    const row: LogEntry = { kind: "system", lines: ["hello world"] };
    const rows = cachedRows(row, 40);
    expect(rows.length).toBe(1);
    expect(totalRows([row], 40)).toBe(2);

    // Hard-wrapped prose: every rendered row fits within the width, so each
    // row is exactly one terminal row (no soft-wrap height).
    const long: LogEntry = {
      kind: "assistant",
      lines: ["this is a long reply that wraps across several rows for sure"],
    };
    const longRows = cachedRows(long, 20);
    expect(longRows.length).toBeGreaterThan(1);
    for (const r of longRows) expect(displayWidth(r)).toBeLessThanOrEqual(20);
    expect(totalRows([long], 20)).toBe(longRows.length + 1);
  });

  it("reuses the cached total while nothing changes and rebuilds on mutation", () => {
    const entries: LogEntry[] = [
      { kind: "error", lines: ["❌ err", "x".repeat(95)] },
      { kind: "error", lines: ["b"] },
    ];
    const first = totalRows(entries, 40);
    expect(totalRows(entries, 40)).toBe(first); // short-circuit hit
    (entries[1] as LogEntry).lines[1] = "x".repeat(95); // grows the wrapped detail
    cachedRows(entries[1] as LogEntry, 40); // render records the mutation → revision bump
    const second = totalRows(entries, 40);
    expect(second).toBeGreaterThan(first);
  });

  it("rebuilds after collapse/expand changes an entry's height", () => {
    const body: string[] = [];
    for (let i = 1; i <= 8; i++) body.push(`line ${i}`);
    const chunk: LogEntry = { kind: "chunk", lines: ["run exit 0", ...body] };
    const entries = [chunk];
    const open = totalRows(entries, 40);
    chunk.collapsed = true;
    cachedRows(chunk, 40);
    const closed = totalRows(entries, 40);
    expect(closed).toBeLessThan(open);
    chunk.collapsed = false;
    cachedRows(chunk, 40);
    expect(totalRows(entries, 40)).toBe(open);
  });

  it("rebuilds when the width changes", () => {
    const entries: LogEntry[] = [
      { kind: "assistant", lines: ["long line that wraps at narrow widths but not at wide ones"] },
    ];
    const wide = totalRows(entries, 80);
    const narrow = totalRows(entries, 10);
    expect(narrow).toBeGreaterThanOrEqual(wide);
    expect(totalRows(entries, 80)).toBe(wide); // back to the cached wide total
  });

  it("does not share state across different entries arrays", () => {
    const a: LogEntry[] = [{ kind: "system", lines: ["x"] }];
    const b: LogEntry[] = [{ kind: "system", lines: ["x"] }];
    expect(totalRows(a, 40)).toBe(totalRows(b, 40));
  });
});
describe("status entry", () => {
  it("renders one very dark-grey (but not black) line on the normal background with 1-cell padding", () => {
    const rows = cachedRows(
      { kind: "status", lines: ["runtime 5m21s · 2 tool calls · 1.3M tokens"] },
      60,
    );
    expect(rows.length).toBe(1);
    const plain = stripAnsi(rows[0] as string);
    expect(plain).toContain("runtime 5m21s · 2 tool calls · 1.3M tokens");
    // Horizontal padding 1: one leading + one trailing space.
    expect(plain.startsWith(" ")).toBe(true);
    expect(plain.endsWith(" ")).toBe(true);
    // Very dark grey foreground (not black), no background style.
    expect(rows[0]).toContain("38;2;63;63;70"); // #3f3f46
    expect(rows[0]).not.toContain("38;2;0;0;0"); // not black
    expect(rows[0]).not.toContain("48;2;");
    // Never exceeds the terminal width.
    expect(displayWidth(plain)).toBeLessThanOrEqual(60);
  });

  it("truncates long summary lines to the terminal width", () => {
    const rows = cachedRows(
      { kind: "status", lines: ["runtime 5m21s · 2 tool calls · 1.3M tokens · padded wide tail"] },
      20,
    );
    expect(rows.length).toBe(1);
    expect(displayWidth(stripAnsi(rows[0] as string))).toBeLessThanOrEqual(20);
  });
});
describe("toolResult entry", () => {
  it("renders like a tool call: collapsed 🔚 line, expandable to the full JSON result", () => {
    const entry: LogEntry = {
      kind: "toolResult",
      lines: ['🔚 noop { "note": "did nothing" }'],
      label: "🔚 noop",
      argsCompact: '{ "note": "did nothing" }',
      full: '{\n  "note": "did nothing"\n}',
      expanded: false,
    };
    const collapsed = cachedRows(entry, 60);
    expect(collapsed.length).toBe(1);
    expect(stripAnsi(collapsed[0] as string)).toContain("🔚 noop");
    entry.expanded = true;
    const expanded = cachedRows(entry, 60);
    expect(expanded.length).toBeGreaterThan(1);
    expect(stripAnsi(expanded.join("\n"))).toContain('"note"');
  });
});

describe("chunk tokenNote", () => {
  it("keeps the collapsed tail to the line count (no token note, no guidance)", () => {
    const entry: LogEntry = {
      kind: "chunk",
      lines: ["bash → exit 0"],
      collapsed: true,
      result: { exitCode: 0, stdout: "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight" },
      tokenNote: "172 tok",
    };
    const rows = cachedRows(entry, 60);
    const tail = rows.map((r) => stripAnsi(r)).find((s) => s.includes("… +3 lines")) ?? "";
    const plain = stripAnsi(tail);
    expect(plain).toContain("… +3 lines");
    expect(plain).not.toContain("· 172 tok");
    expect(plain).not.toContain("(focus, Enter)");
    for (const row of rows) expect(displayWidth(stripAnsi(row))).toBeLessThanOrEqual(60);
  });

  it("does not repeat the note below the expanded body", () => {
    const entry: LogEntry = {
      kind: "chunk",
      lines: ["bash → exit 0"],
      collapsed: false,
      result: { exitCode: 0, stdout: "one\ntwo\nthree\nfour\nfive\nsix\nseven" },
      tokenNote: "172 tok",
    };
    const rows = cachedRows(entry, 60);
    const seen = rows.map((r) => stripAnsi(r).trim()).filter((s) => s === "172 tok").length;
    expect(seen).toBe(0);
  });
});

describe("toolResult tokenNote", () => {
  it("appends the count to the collapsed line and never repeats it below the expanded body", () => {
    const entry: LogEntry = {
      kind: "toolResult",
      lines: ['🔚 noop { "note": "did nothing" }'],
      label: "🔚 noop",
      argsCompact: '{ "note": "did nothing" }',
      full: '{\n  "note": "did nothing"\n}',
      expanded: false,
      tokenNote: "172 tok",
    };
    const collapsed = cachedRows(entry, 80);
    expect(stripAnsi(collapsed[0] as string)).toContain("· 172 tok");
    entry.expanded = true;
    const expanded = cachedRows(entry, 80);
    const seen = expanded.map((r) => stripAnsi(r).trim()).filter((s) => s === "172 tok").length;
    expect(seen).toBe(0);
  });
});

describe("focus visuals on user and assistant messages (issue #65)", () => {
  it("paints the user bubble white-on-dark-blue while focused", () => {
    const e: LogEntry = { kind: "user", lines: ["a focused prompt"] };
    const rows = cachedRows(e, 40, true, -1);
    const text = rows.join("\n");
    // The bubble bg is the focus blue (#1e3a8a) — the same background the
    // other focus targets (tool calls, chunks) paint. The plain bubble's
    // dark grey (#3f3f46) must not appear anywhere in the block.
    expect(text).toContain("48;2;30;58;138");
    expect(text).not.toContain("48;2;63;63;70");
    // Content survives the recolor (bubble text flattened to the focused
    // fg — white).
    expect(stripAnsi(text)).toContain("a focused prompt");
    // Same geometry as the unfocused bubble: one pad row above and below.
    expect(rows.length).toBe(3);
  });

  it("keeps the unfocused user bubble dark grey", () => {
    const rows = cachedRows({ kind: "user", lines: ["plain prompt"] }, 40, false, -1);
    const text = rows.join("\n");
    expect(text).toContain("48;2;63;63;70");
    expect(text).not.toContain("48;2;30;58;138");
  });

  it("renders the assistant border rune in the focus blue while focused", () => {
    const e: LogEntry = {
      kind: "assistant",
      lines: ["a focused reply that is long enough to wrap across several rows here"],
    };
    const rows = cachedRows(e, 40, true, -1);
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      // The border rune leads every row and carries the focus blue fg
      // (#1e3a8a) — the "black edge" the issue describes.
      expect(row.startsWith(`${ST.assistantBorderFocus.render("▐")} `)).toBe(true);
      expect(row).toContain("38;2;30;58;138");
      // The unfocused blue (#60a5fa) never leaks into the focused block.
      expect(row).not.toContain("38;2;96;165;250");
    }
  });

  it("keeps the assistant border blue (#60a5fa) when unfocused", () => {
    const rows = cachedRows({ kind: "assistant", lines: ["an unfocused reply"] }, 40, false, -1);
    for (const row of rows) {
      expect(row.startsWith(BORDER)).toBe(true);
      expect(row).toContain("38;2;96;165;250");
      expect(row).not.toContain("38;2;30;58;138");
    }
  });

  it("recolors without reflowing: focused and unfocused rows wrap identically", () => {
    const e: LogEntry = {
      kind: "user",
      lines: ["a prompt long enough to wrap across rows when the bubble is narrow"],
    };
    const unfocused = cachedRows(e, 24, false, -1);
    const focused = cachedRows(e, 24, true, -1);
    expect(focused.length).toBe(unfocused.length);
    for (let i = 0; i < focused.length; i++) {
      expect(stripAnsi(focused[i] as string)).toBe(stripAnsi(unfocused[i] as string));
    }
  });
});
