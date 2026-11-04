import { describe, expect, it } from "vitest";

import { cachedRows, totalRows } from "../../../src/ui/render/entry.ts";
import { C, ST } from "../../../src/ui/theme.ts";
import { displayWidth, stripAnsi } from "../../../src/util/ansi.ts";
import type { LogEntry } from "../../../src/core/entries.ts";

const ESC = "\x1b";

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
});

describe("terminal-state notice", () => {
  it("renders one line: padded label, default-fg dot, dimmed detail", () => {
    const rows = cachedRows({ kind: "notice", lines: ["⏹ turn aborted", "by operator"] }, 40);
    expect(rows).toHaveLength(1);
    // Padding, label, mid-dot separator, dimmed detail — single line.
    expect(stripAnsi(rows[0] ?? "")).toBe(" ⏹ turn aborted · by operator");
    // The label carries the themed style; the dot is a plain fg reset.
    expect(rows[0]).toContain(ST.notice.render("⏹ turn aborted"));
    expect(rows[0]).toContain(`${ESC}[39m· `);
    // The detail carries the dim style.
    expect(rows[0]).toContain(ST.noticeDetail.render("by operator"));
  });

  it("omits the dot when there is no detail", () => {
    const rows = cachedRows({ kind: "notice", lines: ["⏹ turn aborted", ""] }, 40);
    expect(rows).toHaveLength(1);
    expect(stripAnsi(rows[0] ?? "")).toBe(" ⏹ turn aborted ");
    expect(rows[0]).not.toContain(`${ESC}[39m`);
  });

  it("caps the label and detail so the line never exceeds the width", () => {
    const rows = cachedRows(
      {
        kind: "notice",
        lines: ["⏹ turn aborted", "a very long detail line that would overflow the terminal width"],
      },
      30,
    );
    expect(rows).toHaveLength(1);
    // Total line stays inside the terminal width.
    expect(stripAnsi(rows[0] ?? "").length).toBeLessThanOrEqual(30);
    // The dot survives the cap, so the separator never disappears.
    expect(rows[0]).toContain(`${ESC}[39m· `);
    // Detail is capped but starts correctly.
    expect(stripAnsi(rows[0] ?? "").endsWith("a very long")).toBe(true);
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
      { kind: "system", lines: ["a"] },
      { kind: "system", lines: ["b"] },
    ];
    const first = totalRows(entries, 40);
    expect(totalRows(entries, 40)).toBe(first); // short-circuit hit
    (entries[1] as LogEntry).lines.push("more content");
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
