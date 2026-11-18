/**
 * The cross-row "carry" for the tool-line colorizer.
 *
 * Tool lines are HARD-wrapped, so a JSON string token can be split across
 * display rows. The string's color must be RE-EMITTED at the start of the
 * next row's content — the carry is per OPEN STRING, not per row: a string
 * spanning three or more wrapped rows re-arms at the end of every row it
 * touches, so row N+1 is colored from the same string color as row N. (An
 * earlier implementation armed the carry only on the row that OPENED the
 * string: the second continuation row of a long string lost its color, and
 * a later row could even be misread as still inside the string, coloring a
 * following `}` as string text.)
 *
 * The carry also tracks the dangling-backslash escape state: a trailing
 * backslash escapes the (display-wrapped-away) quote before the newline,
 * so the continuation row starts INSIDE the escaped character, mid-string.
 */

/** Cross-row state threaded through a tool line's rows. A carry never
 *  holds `escaped` without `pending`: a dangling backslash only matters
 *  while a string is open (its quote-escape below). */
export type RowCarry = {
  /** The open string's color to re-emit, or "" when no string is open. */
  pending: string;
  /** Whether a dangling backslash escapes the next row's first character. */
  escaped: boolean;
};

/** A carry with nothing pending (line start). */
export const emptyCarry = (): RowCarry => ({ pending: "", escaped: false });
