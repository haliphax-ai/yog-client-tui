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

export function colorizeToolLine(text: string): string {
  const carry: RowCarry = emptyCarry();
  const outRows: string[] = [];

  for (const row of text.split("\n")) {
    outRows.push(colorizeRow(row, carry));
  }
  return outRows.join("\n");
}

/**
 * Colorize one display row in the context of the threaded carry. On entry
 * `carry.pending` holds the open string color from the previous row ("" for
 * none) and `carry.escaped` whether a dangling backslash escapes this row's
 * first character; on exit both describe the NEXT row (see rowCarry.ts).
 */
function colorizeRow(row: string, carry: RowCarry): string {
  const carryIn = { ...carry };
  carry.pending = "";
  carry.escaped = false;

  // A dangling backslash escapes the quote that would otherwise open this
  // row's first string (JSON strings cannot contain a literal newline):
  // the continuation starts INSIDE the escaped character, mid-string, and
  // the string color rides in ahead of it.
  if (carryIn.escaped) {
    const startColor = carryIn.pending !== "" ? carryIn.pending : C.str;
    const { out } = scanRowText(row, { pending: startColor, escaped: true });
    carry.pending = startColor;
    return out;
  }

  // No escape state: the row starts inside a string iff one was carried.
  const { out, inString, escaped } = scanRowText(row, carryIn);
  if (inString) carry.pending = carryIn.pending !== "" ? carryIn.pending : C.str;
  carry.escaped = escaped;
  return out;
}
