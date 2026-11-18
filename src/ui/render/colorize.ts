/**
 * Colorize tool call-line content (compact JSON args, ✅/❌ indicators)
 * with lightweight syntax highlighting.
 *
 * The work splits across modules in `colorize/`:
 *
 *   scanner.ts   the per-row tokenizer (the while loop)
 *   emit.ts      output assembly: the held row prefix and its release
 *   rowCarry.ts  the cross-row string-carry (per OPEN STRING, not per row)
 *   indicators.ts  the ✓/✗ status tokens
 *   slice.ts     the character-domain number/literal matchers
 *
 * ANSI-safety contract: escape sequences are copied through untouched and
 * never tokenized, so `stripAnsi(colorize(x)) === x` for any input. Width
 * is irrelevant to this pass — it copies characters verbatim and inserts
 * zero-width escapes around tokens — so character-domain slicing here does
 * not violate the cells-not-characters rule, which governs LAYOUT decisions.
 */
import { C } from "../theme.ts";
import type { RowCarry } from "./colorize/rowCarry.ts";
import { emptyCarry } from "./colorize/rowCarry.ts";
import { scanRowText } from "./colorize/scanner.ts";

/** One row's scan result plus the carry it leaves for the next row. */
type RowOutcome = { out: string; carry: RowCarry };

export function colorizeToolLine(text: string): string {
  let carry = emptyCarry();
  const outRows: string[] = [];

  for (const row of text.split("\n")) {
    const outcome = colorizeRow(row, carry);
    carry = outcome.carry;
    outRows.push(outcome.out);
  }
  return outRows.join("\n");
}

/**
 * Colorize one display row in the context of the incoming carry (see
 * rowCarry.ts) and return the carry for the NEXT row. A row that ends
 * inside a string re-arms the carried color — per OPEN STRING, not per
 * row, so arbitrarily long wrapped strings stay colored on every
 * continuation row. A dangling backslash only matters while a string is
 * open: it escapes the quote that would otherwise start the next string
 * (JSON strings cannot contain a literal newline), so the continuation
 * row starts INSIDE the escaped character, mid-string, with the string
 * color riding in ahead of it.
 */
function colorizeRow(row: string, carry: RowCarry): RowOutcome {
  const { out, inString, escaped } = scanRowText(row, carry);
  if (!inString) return { out, carry: emptyCarry() };
  // The string stays open into the next row: re-arm its color (the
  // incoming one, or a fresh string color when this row opened it) and
  // keep the dangling-backslash escape state if the row ended mid-escape.
  const pending = carry.pending !== "" ? carry.pending : C.str;
  return { out, carry: { pending, escaped } };
}
