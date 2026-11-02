/**
 * ANSI-aware string helpers: display width, escape stripping, cell-accurate
 * wrap, and cell-capped truncation. No styles live here — color belongs to
 * the theme.
 */
import {
  stringWidth,
  stripAnsi as lgStripAnsi,
  truncate as lgTruncate,
  wrap as lgWrap,
  ansiTokens,
  graphemes,
  graphemeWidth,
} from "@oakoliver/lipgloss";

/** Width of a string in terminal cells, ignoring ANSI escape sequences. */
export function displayWidth(text: string): number {
  return stringWidth(text);
}

/** Remove ANSI escape sequences (CSI, OSC, single-character escapes). */
export function stripAnsi(text: string): string {
  return lgStripAnsi(text);
}

/** Match one ANSI escape sequence at the start of `rest`, if any. */
export function matchEscape(rest: string): string | undefined {
  const esc = rest.match(
    /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|^\x1b\[[0-9;?]*[ -/]*[@-~]|^\x1b[@-Z\\-_]/,
  );
  return esc ? esc[0] : undefined;
}

/** Truncate to `max` display cells, keeping any leading ANSI sequences. */
export function truncateAnsi(text: string, max: number): string {
  return max <= 0 ? "" : lgTruncate(text, max);
}

/**
 * Word-wrap one line to `cols` (ANSI-aware, hard-breaks overlong tokens) via
 * the library's cell-accurate wrap; blank lines are preserved.
 */
export function wrapText(text: string, cols: number): string[] {
  if (cols < 1) return [""];
  return text.split("\n").flatMap((line) => (line === "" ? [""] : lgWrap(line, cols).split("\n")));
}

/**
 * Remove `n` cells from the left of a string.
 *
 * Unlike `truncateLeft` (which keeps wide graphemes whole when they
 * straddle the cut), this replaces a straddling wide grapheme's visible
 * half with blank cells. Table horizontal-scroll needs this: when an
 * emoji's first cell is off-screen, its second cell renders as a space
 * rather than pulling the whole 2-cell glyph into the viewport (which
 * breaks the cell-width count and shifts every following cell).
 */
export function scrollLeft(line: string, n: number): string {
  if (n <= 0) return line;
  const tokens = ansiTokens(line);
  let result = "";
  let cells = 0;
  for (const token of tokens) {
    if (token.ansi) {
      result += token.value;
      continue;
    }
    for (const g of graphemes(token.value)) {
      const w = graphemeWidth(g);
      const end = cells + w;
      if (end <= n) {
        cells = end; // entirely off-screen, drop
      } else if (cells < n) {
        // straddles: visible half → blank cells
        result += " ".repeat(end - n);
        cells = end;
      } else {
        result += g; // entirely visible
        cells = end;
      }
    }
  }
  return result;
}
