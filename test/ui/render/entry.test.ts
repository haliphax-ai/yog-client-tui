import { describe, expect, it } from "vitest";

import { cachedRows } from "../../../src/ui/render/entry.ts";
import { C, ST } from "../../../src/ui/theme.ts";
import { stripAnsi } from "../../../src/util/ansi.ts";

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

describe("terminal-state notice", () => {
  it("renders one line: padded label, default-fg dot, dimmed detail", () => {
    const rows = cachedRows({ kind: "notice", lines: ["⏹ turn aborted", "by operator"] }, 40);
    expect(rows).toHaveLength(1);
    // Padding, label, mid-dot separator, dimmed detail — single line.
    expect(stripAnsi(rows[0] ?? "")).toBe(" ⏹ turn aborted · by operator");
    // The label carries the themed style; the dot is a plain fg reset.
    expect(rows[0]).toContain(ST.notice.render("⏹ turn aborted"));
    expect(rows[0]).toContain("\x1b[39m· ");
    // The detail carries the dim style.
    expect(rows[0]).toContain(ST.noticeDetail.render("by operator"));
  });

  it("omits the dot when there is no detail", () => {
    const rows = cachedRows({ kind: "notice", lines: ["⏹ turn aborted", ""] }, 40);
    expect(rows).toHaveLength(1);
    expect(stripAnsi(rows[0] ?? "")).toBe(" ⏹ turn aborted ");
    expect(rows[0]).not.toContain("\x1b[39m");
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
    expect(rows[0]).toContain("\x1b[39m· ");
    // Detail is capped but starts correctly.
    expect(stripAnsi(rows[0] ?? "").endsWith("a very long")).toBe(true);
  });
});
