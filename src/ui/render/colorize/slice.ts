/**
 * Character-domain token slices for the colorizer.
 *
 * The colorizer's scanner indices are CHARACTER indices into the source
 * row, not cell offsets: it copies content verbatim and inserts color
 * escapes around tokens, and no token ever contains an escape sequence,
 * so character-domain slicing is safe here. Cell-domain helpers
 * (displayWidth/sliceAnsi) belong to the LAYOUT layer — the repo-wide
 * "width is cells" rule governs layout decisions, not this verbatim
 * copier — and would corrupt token boundaries if used here.
 */

/** Match a JSON number at `rest` (leading `-`, optional decimal/exponent). */
export function matchNumber(rest: string): string | undefined {
  const m = rest.match(/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/);
  return m ? m[0] : undefined;
}

/** Match a JSON literal (`true` / `false` / `null`) at `rest`. */
export function matchLiteral(rest: string): string | undefined {
  const m = rest.match(/^(?:true|false|null)/);
  return m ? m[0] : undefined;
}
