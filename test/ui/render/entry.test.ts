import { describe, expect, it } from "vitest";

import { cachedRows } from "../../../src/ui/render/entry.ts";
import { C, ST } from "../../../src/ui/theme.ts";
import { displayWidth, stripAnsi } from "../../../src/util/ansi.ts";

const ESC = "\x1b";

describe("assistant prose — full-width, no border", () => {
  it("renders prose without the half-block border rune", () => {
    const rows = cachedRows(
      {
        kind: "assistant",
        lines: ["first paragraph line that is long enough to wrap somewhere around here for sure"],
      },
      40,
    );
    expect(rows.length).toBe(1);
    expect(stripAnsi(rows[0] ?? "").indexOf("▐")).toBe(-1);
  });

  it("keeps an overlong paragraph as one logical line (soft wrap)", () => {
    const cols = 30;
    const rows = cachedRows(
      { kind: "assistant", lines: ["this is a long reply that wraps across rows"] },
      cols,
    );
    // Soft-wrapped prose stays a single logical row; the terminal wraps it.
    expect(rows.length).toBe(1);
    expect(displayWidth(rows[0] ?? "")).toBeGreaterThan(cols);
    expect(stripAnsi(rows[0] ?? "").indexOf("▐")).toBe(-1);
    const plain = stripAnsi(rows.join("\n"));
    for (const word of ["this", "is", "a", "long", "reply", "that", "wraps"]) {
      expect(plain).toContain(word);
    }
  });

  it("preserves markdown styling across paragraph breaks", () => {
    const rows = cachedRows(
      { kind: "assistant", lines: ["a **bold** start", "", "finish"] },
      24,
    );
    expect(rows.length).toBe(3);
    expect(rows[1]).toBe("");
    expect(stripAnsi(rows[0] ?? "")).toContain("bold");
    expect(rows[0]).toContain(ESC); // styled with ANSI escape sequences
    expect(rows[0]).toContain(";1m"); // bold attribute retained
    for (const row of rows) expect(stripAnsi(row).indexOf("▐")).toBe(-1);
  });

  it("does not colorize the prose like a tool line (no arg-palette leaks)", () => {
    const rows = cachedRows({ kind: "assistant", lines: ['{"not": "a tool"}'] }, 40);
    expect((rows[0] ?? "").includes(C.punct)).toBe(false);
  });

  it("styles assistant prose with the assistant style (white text)", () => {
    const rows = cachedRows({ kind: "assistant", lines: ["hello world"] }, 40);
    // The row carries the assistant fg (white) — glamour splits the styled
    // text into segments, so check for the fg code rather than the whole
    // styled string.
    expect(rows[0]).toContain(`${ESC}[38;2;255;255;255m`);
  });

  it("keeps wide runes intact across soft wrap (emoji regression)", () => {
    const text = "✅ Done — " + "this line is intentionally long enough to exceed the terminal width ".repeat(2) + "end";
    const rows = cachedRows({ kind: "assistant", lines: [text] }, 24);
    expect(rows.length).toBe(1);
    expect(displayWidth(rows[0] ?? "")).toBeGreaterThan(24);
    expect(stripAnsi(rows[0] ?? "")).toContain("✅");
    expect(stripAnsi(rows[0] ?? "")).toContain("end");
  });
});
describe("user prompt — full-width, no horizontal padding", () => {
  it("renders prompt rows without leading/trailing padding", () => {
    const rows = cachedRows({ kind: "user", lines: ["hello world"] }, 40);
    // The user bubble has vertical padding (1 row top/bottom); the content
    // is in rows[1]. Horizontal padding is gone — text starts at column 0.
    const content = stripAnsi(rows[1] ?? "");
    expect(content).toContain("hello world");
    // No leading space from horizontal padding — text starts at col 0.
    expect(content.indexOf("hello")).toBe(0);
  });

  it("keeps an overlong prompt as one soft-wrapped line", () => {
    const cols = 20;
    const rows = cachedRows(
      { kind: "user", lines: ["this is a long prompt that wraps across rows"] },
      cols,
    );
    // bubble: blank fill row + content row + blank fill row
    expect(rows.length).toBe(3);
    const content = stripAnsi(rows[1] ?? "").trim();
    expect(content).toBe("this is a long prompt that wraps across rows");
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