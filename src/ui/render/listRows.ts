/**
 * List-row shaping for glamour output: the hanging indent over wrapped
 * list items.
 *
 * Glamour wraps a list item's continuation rows back to the item's own
 * left edge, so a wrapped bullet reads as several top-level rows. The
 * hang pass re-indents every row after a marker row to the marker's
 * content column — in the ANSI domain, so the row's own SGRs survive
 * (a plain-domain rebuild once dropped every style on wrapped rows —
 * italic/bold runs and fg colors vanished the moment an item wrapped).
 */
import { sliceAnsi } from "@oakoliver/lipgloss";
import { displayWidth, stripAnsi, truncateAnsi } from "../../util/index.ts";
import { trimLeading } from "./normalize.ts";

/** A list-marker row start: indent + (dash/asterisk/bullet or a 1-9 digit
 *  marker) + one separator space. The BULLET rune (•) is what glamour
 *  emits for unordered items after normalization, not the source "-". */
const LIST_MARK_RE = /^(\s*)(?:[-*+•]|\d{1,9}[.)])( )/;

/**
 * Hanging indent for list rows: glamour wraps an item's continuation
 * rows back to the item's own left edge, so a wrapped bullet reads as
 * several top-level rows. Every row after a marker row is padded to the
 * marker's content column (indent + marker + separator) until the next
 * marker row or blank row. Rows are already normalized text — glamour
 * colors words, not leading whitespace, so the pad itself needs no
 * styling; it is prepended as literal spaces BEFORE the row's own escape
 * sequences and any row pushed past `cols` is capped (its last word fit
 * before the pad, so the cap trims pad, not content — except at
 * pathological 1-cell budgets where the marker itself cannot fit).
 *
 * The continuation row's styling must survive: rebuilding it from
 * `stripAnsi(row)` (as this function once did) dropped every SGR on
 * wrapped rows — italic/bold runs and glamour's fg colors vanished the
 * moment a list item wrapped, in assistant prose and in table cells
 * alike. So the row is trimmed in the ANSI domain instead: leading
 * visible spaces are removed with {@link trimLeading} (escape sequences
 * are kept), trailing visible spaces (glamour's per-row padding) are
 * cut with `sliceAnsi` at the last visible cell, and the hang pad is
 * prepended to the intact styled row.
 */
export function hangWrapRows(rows: string[], cols: number): string[] {
  const out: string[] = [];
  let hang = 0;
  for (const row of rows) {
    const plain = stripAnsi(row).replace(/ +$/, "");
    const lead = (plain.match(/^ */) ?? [""])[0].length;
    const marker = plain.trimStart().match(LIST_MARK_RE);
    if (marker !== null) {
      hang = lead + marker[0].length;
      out.push(row);
      continue;
    }
    if (hang > 0 && plain.trim() !== "") {
      // Trim leading/trailing VISIBLE spaces without touching escapes:
      // trimLeading keeps embedded SGR/OSC runs, sliceAnsi keeps the
      // trailing runs attached past the last visible cell.
      const trimmed = trimLeading(row, Number.MAX_SAFE_INTEGER);
      const contentEnd = displayWidth(stripAnsi(trimmed).replace(/ +$/, ""));
      const styled = contentEnd > 0 ? sliceAnsi(trimmed, 0, contentEnd) : "";
      out.push(truncateAnsi(" ".repeat(hang) + styled, cols));
      continue;
    }
    out.push(row);
    if (plain.trim() === "") hang = 0;
  }
  return out;
}
