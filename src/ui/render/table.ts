/**
 * Markdown pipe-table parser.
 *
 * Pure function: extracts GFM-style pipe tables from raw text before it
 * reaches glamour (which would render them as ugly ASCII art). No
 * rendering, no caching — just detection + extraction.
 */

/** One column: its header text and computed width (in cells). */
export interface ParsedColumn {
  title: string;
  width: number;
}

/** A parsed table: columns + rows (each row is an array of cell strings). */
export interface ParsedTable {
  columns: ParsedColumn[];
  rows: string[][];
}

/**
 * Split one table row into cells.
 *
 * Handles:
 * - Optional leading/trailing `|` (GFM allows omitting them)
 * - Escaped pipes `\|` (literal pipe inside a cell)
 * - Whitespace trimming around each cell
 * - `<br>` / `<br/>` / `<br />` → newline (cells can be multi-line)
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
        .replace(/\x00/g, "|")
        .trim()
        .replace(/<br\s*\/?>/gi, "\n"),
    );
  }
  return result;
}

/** Display width of a cell: the widest line when the cell contains `<br>` newlines. */
function cellWidth(cell: string): number {
  if (!cell.includes("\n")) return cell.length;
  let max = 0;
  for (const line of cell.split("\n")) {
    if (line.length > max) max = line.length;
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

/** True if the line is a table delimiter row (every cell is `---`-style). */
function isTableDelimiter(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return false;
  const cells = splitCells(trimmed);
  if (cells.length === 0) return false;
  return cells.every((c) => /^:?-+:?$/.test(c));
}

/**
 * A section of split text: either prose or a parsed table.
 *
 * Produced by {@link splitTableSections}; consumed by the entry
 * renderer to route prose through glamour and tables through Bubbles.
 */
export type TableSection =
  | { kind: "prose"; text: string }
  | { kind: "table"; table: ParsedTable };

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

/**
 * Parse a GFM pipe table from `text`.
 *
 * Returns `null` when the text doesn't start with a valid table
 * (header row + delimiter row). Data rows are optional — a table
 * with only a header is still valid.
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

  const headerCells = splitCells(lines[headerIdx] ?? "");
  if (headerCells.length === 0) return null;

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

  // Compute column widths from header + all data cells.
  // Multi-line cells (from <br>) count their widest sub-line, not total length.
  const colCount = headerCells.length;
  const widths: number[] = headerCells.map((h) => cellWidth(h));
  for (const row of rows) {
    for (let c = 0; c < colCount; c++) {
      const w = cellWidth(row[c] ?? "");
      if (w > widths[c]!) widths[c] = w;
    }
  }

  return {
    columns: headerCells.map((title, i) => ({ title, width: widths[i]! })),
    rows,
  };
}