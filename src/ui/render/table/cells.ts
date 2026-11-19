/**
 * Table cell text and measurement: how one pipe-row splits into cells,
 * how a cell's display breaks become logical lines, and how wide a cell
 * renders once glamour has styled it.
 *
 * Cell splitting handles optional outer pipes, escaped pipes, whitespace
 * trimming, and `<br>` display breaks. Width is measured in CELLS against
 * the RENDERED text (glamour consumes the emphasis markers before the
 * table draws), memoized — the same cell text is measured on every layout
 * pass.
 */
import { displayWidth, stripAnsi } from "../../../util/ansi.ts";
import { renderInlineMarkdown } from "../markdown.ts";

/** Restore the escaped-pipe placeholder to a literal pipe, trim, and turn
 *  `<br>` markers into display breaks. */
function cellContent(part: string): string {
  return (
    part
      // eslint-disable-next-line no-control-regex
      .replace(/\x00/g, "|")
      .trim()
      .replace(/<br\s*\/?>/gi, "\n")
  );
}

/** Drop the empty cells the optional outer pipes produce. */
function trimOuterBlanks(parts: string[]): string[] {
  const isBlank = (part: string): boolean => part.trim() === "";
  const start = parts.findIndex((part) => !isBlank(part));
  if (start === -1) return [];
  const last = parts.findLastIndex((part) => !isBlank(part));
  return parts.slice(start, (last as number) + 1);
}

/**
 * Split one table row into cells.
 *
 * Handles:
 * - Optional leading/trailing `|` (GFM allows omitting them)
 * - Escaped pipes `\|` (literal pipe inside a cell)
 * - Whitespace trimming around each cell
 * - `<br>` / `<br/>` / `<br />` → display break (rendered as separate lines)
 */
export function splitCells(line: string): string[] {
  const PH = "\x00"; // placeholder for escaped pipes
  const parts = line.replace(/\\\|/g, PH).split("|");
  return trimOuterBlanks(parts).map(cellContent);
}

/** Split one cell's display breaks (<br>) into separate logical lines. A
 *  break rune at the end of the text is a hard cap, not padding. Wrapping to
 *  the column width happens at render time (glamour), not here. */
export function cellLines(cell: string): string[] {
  if (cell === "") return [""];
  if (!cell.includes("\n")) return [cell];
  return cell.split("\n");
}

/** Visible width of a cell line as it will RENDER: glamour runs first
 * (markers disappear, links/styles appear), so the rendered text — not the
 * raw markdown — is what's measured. Rendered unwrapped at a wide width.
 * Memoized: the same cell text is measured on every layout pass. */
const cellWidthCache = new Map<string, number>();

function cellTextWidth(text: string): number {
  const hit = cellWidthCache.get(text);
  if (hit !== undefined) return hit;
  const rendered = renderInlineMarkdown(text, displayWidth(text) + 16);
  const width =
    rendered.length === 0 ? displayWidth(text) : displayWidth(stripAnsi(rendered.join("")));
  if (cellWidthCache.size >= 1024) cellWidthCache.clear();
  cellWidthCache.set(text, width);
  return width;
}

/** Display width of a cell: the widest of its display-break lines. Wide
 * runes (emoji) count as 2 cells. */
export function cellWidth(cell: string): number {
  let max = 0;
  for (const line of cellLines(cell)) {
    const w = cellTextWidth(line);
    if (w > max) max = w;
  }
  return max;
}
