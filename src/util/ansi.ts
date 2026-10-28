/**
 * ANSI-aware string helpers: display width, escape stripping, cell-accurate
 * wrap, and cell-capped truncation. No styles live here — color belongs to
 * the theme.
 */
import { stringWidth, stripAnsi as lgStripAnsi, truncate as lgTruncate, wrap as lgWrap } from "@oakoliver/lipgloss";

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
  return text
    .split("\n")
    .flatMap((line) => (line === "" ? [""] : lgWrap(line, cols).split("\n")));
}