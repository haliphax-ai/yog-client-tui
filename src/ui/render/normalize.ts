/**
 * Post-processing for glamour output: the normalization shared by the
 * entry-prose pipeline and the table-cell renderer.
 *
 * Glamour renders a *document*: margins, a shared indent, padding rows,
 * wrapped list items pulled back to the item's left edge. The terminal
 * log wants *rows*: hard-capped lines that fit arbitrary widths (full
 * terminal rows for prose, column widths for cells). The helpers here
 * strip the furniture — in the ANSI domain, so every SGR the styled
 * output carries survives the trip. The hanging indent over wrapped
 * list items lives in `listRows.ts`; the glamour pipelines that use
 * these helpers live in `markdown.ts`.
 */
import { matchEscape, stripAnsi, truncateAnsi } from "../../util/ansi.ts";

/** Remove up to `n` leading plain spaces, keeping any embedded escapes. */
export function trimLeading(line: string, n: number): string {
  const out: string[] = [];
  let i = 0;
  let removed = 0;
  while (i < line.length && removed < n) {
    const esc = escapeLenAt(line, i);
    if (esc !== undefined) {
      out.push(line.slice(i, i + esc)); // escapes survive, never counted
      i += esc;
      continue;
    }
    const space = spaceLenAt(line, i, n - removed);
    if (space === undefined) break; // non-space before the indent is consumed
    i += space;
    removed += space;
  }
  return out.join("") + line.slice(i);
}

/** Length of the ANSI escape run at `i` (a bare ESC counts as 1), or
 *  undefined when the byte is not an escape. */
function escapeLenAt(line: string, i: number): number | undefined {
  if (line[i] !== "\x1b") return undefined;
  return matchEscape(line.slice(i))?.length ?? 1;
}

/** Length of the leading plain-space run at `i`, capped at `budget`; or
 *  undefined when the byte is not a space. */
function spaceLenAt(line: string, i: number, budget: number): number | undefined {
  if (line[i] !== " ") return undefined;
  let run = 0;
  while (run < budget && line[i + run] === " ") run += 1;
  return run;
}

/** Drop glamour's blank outer rows from a rendered block. */
export function trimBlankOuter(lines: string[]): string[] {
  while (lines.length > 0 && stripAnsi(lines[0] ?? "").trim() === "") lines.shift();
  while (lines.length > 0 && stripAnsi(lines[lines.length - 1] ?? "").trim() === "") lines.pop();
  return lines;
}

/** Shared leading indent (in cells) across a rendered block's content rows. */
export function sharedIndent(lines: string[]): number {
  const indents: number[] = [];
  for (const line of lines) {
    if (stripAnsi(line).trim() !== "") indents.push(line.match(/^ */)?.[0].length ?? 0);
  }
  return indents.length > 0 ? Math.min(...indents) : 0;
}

/** Shared group normalization: trim glamour's blank outer rows, strip the
 *  block's shared indent, keep interior blank rows (paragraph breaks), and
 *  cap every line to `cols`. Exported for the entry-prose module
 *  (prose.ts), which renders each paragraph group as its own glamour
 *  document and reuses this exact post-processing. */
export function normalizeLines(rendered: string, cols: number, source: string): string[] {
  const lines = trimBlankOuter(rendered.split("\n"));
  if (lines.length === 0) return source.trim() === "" ? [""] : [];
  const indent = sharedIndent(lines);
  const out: string[] = [];
  for (const line of lines) {
    if (stripAnsi(line).trim() === "") {
      out.push(""); // paragraph break inside the group
      continue;
    }
    out.push(truncateAnsi(trimLeading(line, indent), cols));
  }
  return out;
}
