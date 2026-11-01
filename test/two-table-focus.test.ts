import { describe, expect, it, beforeEach } from "vitest";
import { cachedRows } from "../src/ui/render/entry.ts";
import { getState, setState, resetForTests } from "../src/core/store.ts";
import { stripAnsi } from "../src/util/ansi.ts";

const TWO_TABLE_ENTRY = `## Mixed Ordered + Unordered Lists

| Scenario | Example |
| --- | --- |
| Ordered → Unordered | 1. Build |

## Do / Don't Reference

| # | Guideline |
| --- | --- |
| 1 | Use backticks |`;

const BLUE = "\x1b[38;2;96;165;250m";
const WHITE = "\x1b[38;2;255;255;255m";

/**
 * Find the byte offset of the Nth occurrence of `needle` in `text`.
 * Returns -1 when there is no Nth occurrence.
 */
function nthOf(text: string, needle: string, n: number): number {
  let idx = -1;
  let from = 0;
  for (let i = 0; i < n; i++) {
    idx = text.indexOf(needle, from);
    if (idx === -1) return -1;
    from = idx + 1;
  }
  return idx;
}

/**
 * The SGR sequence immediately preceding the rune at `idx` (empty string
 * when the rune is bare). Walks back through digits, semicolons and
 * letters — the payload of an `\x1b[...m` sequence.
 */
function sgrBefore(text: string, idx: number): string {
  // Walk back through the SGR sequence: payload digits/semicolons/letters,
  // the closing `m`, the `[`, and the ESC. Stops at any other byte.
  let s = idx - 1;
  while (s >= 0) {
    const c = text[s]!;
    if (c === "\x1b") return text.slice(s, idx);
    if (/[\d;]|[a-zA-Z]|\[/.test(c)) {
      s--;
      continue;
    }
    break;
  }
  return "";
}

describe("two tables in one entry — table-level focus", () => {
  beforeEach(() => {
    resetForTests();
    setState({
      entries: [{ kind: "assistant", lines: TWO_TABLE_ENTRY.split("\n") }],
    });
  });

  it("renders only the focused table blue; the other is white", () => {
    const e = getState().entries[0]!;
    const text = cachedRows(e, 80, true, 0).join("\n");
    const plain = stripAnsi(text);

    expect(plain).toContain("Scenario");
    expect(plain).toContain("Guideline");

    // First table's top-left corner carries the blue fg.
    expect(sgrBefore(text, nthOf(text, "┌", 1))).toContain(BLUE);
    // Second table's top-left corner carries the white fg, not blue.
    const secondCorner = nthOf(text, "┌", 2);
    expect(secondCorner).toBeGreaterThan(0);
    expect(sgrBefore(text, secondCorner)).toContain(WHITE);
    expect(sgrBefore(text, secondCorner)).not.toContain(BLUE);
  });

  it("renders both tables white when neither is focused", () => {
    const e = getState().entries[0]!;
    const text = cachedRows(e, 80, false, -1).join("\n");
    // No table-border corner carries the blue fg.
    for (const corner of ["┌", "┐", "└", "┘"]) {
      let from = 0;
      let i = text.indexOf(corner, from);
      while (i >= 0) {
        expect(sgrBefore(text, i)).not.toContain(BLUE);
        from = i + 1;
        i = text.indexOf(corner, from);
      }
    }
    expect(text).toContain(WHITE);
  });

  it("renders the second table blue when table 1 is focused", () => {
    const e = getState().entries[0]!;
    const text = cachedRows(e, 80, true, 1).join("\n");

    // Second table's corner carries the blue fg.
    const secondCorner = nthOf(text, "┌", 2);
    expect(secondCorner).toBeGreaterThan(0);
    expect(sgrBefore(text, secondCorner)).toContain(BLUE);
    // First table's corner does not.
    expect(sgrBefore(text, nthOf(text, "┌", 1))).not.toContain(BLUE);
  });
});
