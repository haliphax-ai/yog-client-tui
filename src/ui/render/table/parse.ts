/**
 * Markdown pipe-table parser.
 *
 * Pure functions: split raw text into prose and table sections, and parse
 * a GFM pipe table out of a block of lines. No rendering, no caching — the
 * caller caches the result.
 */
import { displayWidth, stripAnsi } from "../../../util/ansi.ts";
import { renderInlineMarkdown } from "../markdown.ts";

/** One column: its header text, computed width (in cells), and alignment. */
export interface ParsedColumn {
  title: string;
  width: number;
  align: "left" | "center" | "right";
}

/** A parsed table: columns + rows. Rows are rectangular — every row
 *  holds exactly `columns.length` cells (GFM normalization). */
export interface ParsedTable {
  columns: ParsedColumn[];
  rows: string[][];
}

/**
 * A section of split text: either prose or a parsed table.
 *
 * Produced by {@link splitTableSections}; consumed by the entry renderer to
 * route prose through glamour and tables through the table renderer. The
 * focus ring is built from the same list, so a table that renders is always
 * a table that can be focused.
 */
export type TableSection = { kind: "prose"; text: string } | { kind: "table"; table: ParsedTable };

/**
 * Split one table row into cells.
 *
 * Handles:
 * - Optional leading/trailing `|` (GFM allows omitting them)
 * - Escaped pipes `\|` (literal pipe inside a cell)
 * - Whitespace trimming around each cell
 * - `<br>` / `<br/>` / `<br />` → display break (rendered as separate lines)
 */
function splitCells(line: string): string[] {
  const PH = "\x00"; // placeholder for escaped pipes
  const escaped = line.replace(/\\\|/g, PH);
  const parts = escaped.split("|");
  // Drop leading/trailing empty cells (from optional outer pipes)
  let start = 0;
  let end = parts.length;
  while (start < end && (parts[start] ?? "").trim() === "") start++;
  while (end > start && (parts[end - 1] ?? "").trim() === "") end--;
  const result: string[] = [];
  for (let i = start; i < end; i++) {
    result.push(
      (parts[i] ?? "")
        // eslint-disable-next-line no-control-regex
        .replace(/\x00/g, "|")
        .trim()
        .replace(/<br\s*\/?>/gi, "\n"),
    );
  }
  return result;
}

/** Split one cell's display breaks (<br>) into separate logical lines. A
 * break rune at the end of the text is a hard cap, not padding. Wrapping to
 * the column width happens at render time (glamour), not here. */
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
function cellWidth(cell: string): number {
  let max = 0;
  for (const line of cellLines(cell)) {
    const w = cellTextWidth(line);
    if (w > max) max = w;
  }
  return max;
}

/** True if the line looks like a table row (has pipes and at least one non-empty cell). */
function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === "" || !trimmed.includes("|")) return false;
  const cells = splitCells(trimmed);
  return cells.some((c) => c !== "");
}

/** Parse one delimiter cell into an alignment token. */
function parseAlign(cell: string): "left" | "center" | "right" {
  const c = cell.trim();
  if (/^:.*:$/.test(c)) return "center";
  if (c.startsWith(":")) return "left";
  if (c.endsWith(":")) return "right";
  return "left";
}

/** True if the line is a table delimiter row (every cell is `---`-style). */
function isTableDelimiter(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return false;
  const cells = splitCells(trimmed);
  if (cells.length === 0) return false;
  return cells.every((c) => /^:?-+:?$/.test(c));
}

/**
 * Parse a GFM pipe table from `text`.
 *
 * Returns `null` when the text doesn't start with a valid table
 * (header row + delimiter row). Data rows are optional — a table
 * with only a header is still valid.
 *
 * Per GFM, the delimiter row fixes the column count; ragged rows are
 * normalized to it (short rows gain empty cells, excess cells are
 * dropped), so `rows` is always rectangular and every row's cell
 * count equals `columns.length`.
 *
 * The text may contain leading/trailing blank lines; they're skipped.
 * Parsing stops at the first non-table line after the delimiter.
 */
export function parseTable(text: string): ParsedTable | null {
  const lines = text.split("\n");

  // Find the header: first line that looks like a table row
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (isTableRow(lines[i] ?? "")) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) return null;

  // Next line must be the delimiter
  const delimIdx = headerIdx + 1;
  if (delimIdx >= lines.length) return null;
  if (!isTableDelimiter(lines[delimIdx] ?? "")) return null;

  // GFM: the delimiter row (NOT the header row) fixes the column count, and
  // it must have at least one cell; rows may diverge mid-stream (a streamed
  // cell carrying an unescaped pipe, or the model re-aligning), so every row
  // is normalized below instead of being trusted.
  const delimCells = splitCells(lines[delimIdx] ?? "");
  if (delimCells.length === 0) return null;
  const colCount = delimCells.length;
  const headerCells = splitCells(lines[headerIdx] ?? "").slice(0, colCount);
  while (headerCells.length < colCount) headerCells.push("");

  // Data rows: consecutive table rows after the delimiter
  const rows: string[][] = [];
  for (let i = delimIdx + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (isTableRow(line)) {
      rows.push(splitCells(line));
    } else {
      break; // table ends at the first non-row line
    }
  }
  // GFM: rows with fewer cells gain empty trailing cells; rows with more
  // cells have the excess dropped. Streamed text routinely produces ragged
  // tables (an unescaped pipe mid-cell, or a row that arrives wider than the
  // header) — a row longer than colCount used to crash the renderer when it
  // indexed header-derived per-column state (widths, alignments).
  const normalized = rows.map((row) => {
    const cells = row.slice(0, colCount);
    while (cells.length < colCount) cells.push("");
    return cells;
  });

  // Compute column widths from header + all data cells.
  // Multi-line cells (from <br>) count their widest sub-line, not total length.
  const widths: number[] = headerCells.map((h) => cellWidth(h));
  for (const row of normalized) {
    for (let c = 0; c < colCount; c++) {
      const w = cellWidth(row[c] ?? "");
      if (w > widths[c]!) widths[c] = w;
    }
  }

  // Per-column alignment from the delimiter's own cells — every column has
  // one (delimCells.length IS colCount), so the align lookup cannot miss.
  const aligns = delimCells.map((c) => parseAlign(c));

  return {
    columns: headerCells.map((title, i) => ({
      title,
      width: widths[i]!,
      align: aligns[i] ?? "left",
    })),
    rows: normalized,
  };
}

/**
 * Split raw markdown text into alternating prose and table sections.
 *
 * A table starts when a line looks like a table row AND the next line
 * is a delimiter. It ends at the first non-table-row line after the
 * delimiter. Everything else is prose. Leading/trailing blank lines
 * on each prose section are trimmed; interior blank lines (paragraph
 * breaks) are preserved.
 *
 * Returns a flat list — adjacent sections are never of the same kind.
 *
 * This is the SINGLE source of truth about which parts of an entry are
 * tables: the renderer draws the table sections, the focus ring walks the
 * same sections, and the scroll bounds measure the same sections. They
 * cannot disagree.
 */
export function splitTableSections(text: string): TableSection[] {
  const lines = text.split("\n");
  const sections: TableSection[] = [];
  let proseLines: string[] = [];
  let i = 0;

  const flushProse = (): void => {
    const body = proseLines.join("\n").trim();
    if (body.length > 0) sections.push({ kind: "prose", text: body });
    proseLines = [];
  };

  while (i < lines.length) {
    const line = lines[i] ?? "";

    // A table starts here: this line is a table row AND the next is a delimiter.
    if (isTableRow(line) && i + 1 < lines.length && isTableDelimiter(lines[i + 1] ?? "")) {
      flushProse();
      const tableLines: string[] = [line, lines[i + 1] ?? ""];
      i += 2;
      while (i < lines.length && isTableRow(lines[i] ?? "")) {
        tableLines.push(lines[i] ?? "");
        i++;
      }
      const parsed = parseTable(tableLines.join("\n"));
      if (parsed) {
        sections.push({ kind: "table", table: parsed });
      } else {
        // parseTable failed — treat the lines as prose.
        proseLines.push(...tableLines);
      }
      continue;
    }

    proseLines.push(line);
    i++;
  }

  flushProse();
  return sections;
}
