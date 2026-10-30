/**
 * Markdown pipe-table parser.
 *
 * Pure function: extracts GFM-style pipe tables from raw text before it
 * reaches glamour (which would render them as ugly ASCII art). No
 * rendering, no caching — just detection + extraction.
 */

/** One column: its header text, computed width (in cells), and alignment. */
export interface ParsedColumn {
  title: string;
  width: number;
  align: "left" | "center" | "right";
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
        .replace(/\x00/g, "|")
        .trim()
        .replace(/<br\s*\/?>/gi, "\n"),
    );
  }
  return result;
}

/** Split one cell's display breaks into separate lines (ANSI-safe: no
 * in-cell escape carries a newline; lipgloss wraps and glamour styles the
 * same way). A break rune at the end of the text is a hard cap, not padding.
 * Each break-line wider than `maxCells` wraps (word-aware, cell-accurate). */
export function cellLines(cell: string, maxCells = Number.POSITIVE_INFINITY): string[] {
  const broken = cell === "" ? [""] : cell.includes("\n") ? cell.split("\n") : [cell];
  if (maxCells === Number.POSITIVE_INFINITY) return broken;
  const out: string[] = [];
  for (const line of broken) {
    if (cellTextWidth(line) <= maxCells) {
      out.push(line);
    } else {
      out.push(...wrapText(line, Math.max(1, maxCells)));
    }
  }
  return out;
}

/** Display width of a cell line as it will RENDER: inline markdown
 * transforms (**bold**, *italic*, `code`) run first, so markers that
 * disappear at render time don't inflate the measured width. */
function cellTextWidth(text: string): number {
  return displayWidth(stripAnsi(renderCellMarkdown(text)));
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

/**
 * Fit column widths into `cols`: natural widths when the table fits,
 * otherwise shrink the widest columns first (one cell per pass) until it
 * does — floored at 3 so cells still wrap readably. Cell content wraps to
 * its column width when capping squeezes it below the text's width.
 */
function capWidths(colWidths: number[], cols: number): number[] {
  // Row geometry: Σ(width+2) + (n+1) border runes = Σw + 3n + 1.
  const fits = (ws: number[]): boolean =>
    ws.reduce((s, x) => s + x, 0) + 3 * ws.length + 1 <= cols;
  if (fits(colWidths)) return [...colWidths];
  const w = [...colWidths];
  while (!fits(w) && w.some((x) => x > 3)) {
    let max = 0;
    for (const x of w) if (x > max) max = x;
    for (let i = 0; i < w.length; i++) {
      if (w[i] === max) w[i] = max - 1;
    }
  }
  return w;
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
  if (/^:/.test(c)) return "left";
  if (/:$/.test(c)) return "right";
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

import { type KeyResult } from "../components/Component.ts";
import { ViewportComponent } from "../components/ViewportComponent.ts";
import { displayWidth, stripAnsi, wrapText } from "../../util/ansi.ts";
import { C, ST, TONE } from "../theme.ts";

/**
 * A hand-rolled table component: box-drawing borders, bold header,
 * zebra-striped data rows, 1-cell top/bottom margins, and horizontal
 * scroll via the arrow keys. Replaces Bubbles Table — Bubbles gives us
 * layout but no styling hooks, and we need borders, zebra, and scroll.
 *
 * The component is self-contained: it owns its scroll offset, renders its
 * own rows, and handles its own keys. It is not store-bound — the entry
 * that contains it owns the table data and passes it in.
 */
/** Render one line of inline markdown (bold / italic / code) with minimal
 * styling — glamour's full renderer pads to the wrap width, which is wrong
 * for table cells. We emit the same SGR escapes glamour would (tokyo-night
 * palette) so the output is background-safe and consistent with entry.ts. */
function renderCellMarkdown(text: string): string {
  return (
    text
      // **bold** → bold on, bold off (never a full reset)
      .replace(/\*\*(.+?)\*\*/g, "\x1b[1m$1\x1b[22m")
      // *italic* → italic on, italic off (avoid matching ** above)
      .replace(/(?<!\*)\*(.+?)\*(?!\*)/g, "\x1b[3m$1\x1b[23m")
      // `code` → tokyo-night comment colour (theme-owned, like the C palette)
      .replace(/`(.+?)`/g, `${TONE.code}$1${C.reset}`)
  );
}

/** Background-safe post-process: strip inner bg SGRs, replace full resets
 * with fg-only reset so the outer zebra/selected background survives. */
function backgroundSafe(text: string): string {
  return (
    text
      // full resets → fg-only reset (same philosophy as C.reset in theme.ts)
      .replaceAll("\x1b[0m", "\x1b[39m")
      .replaceAll("\x1b[m", "\x1b[39m")
      // strip any remaining background SGRs (48;2;... / 48;5;...)
      .replace(
        /\x1b\[(?:48;2;\d{1,3};\d{1,3};\d{1,3}|48;5;\d{1,3})(?:;\d+)*m/g,
        "",
      )
  );
}

export class TableComponent extends ViewportComponent {
  private table: ParsedTable | null = null;

  /** Set the table data (re-renders on next `render` call). */
  setTable(table: ParsedTable): void {
    this.table = table;
    this.scrollX = 0; // reset scroll when data changes
  }

  /** Current horizontal scroll offset (in cells). */
  getScrollX(): number {
    return this.scrollX;
  }

  /** Total rendered width: the natural table width capped at the viewport —
   * `renderTable` never emits lines wider than `cols` (it wraps instead). */
  override totalWidth(): number {
    if (!this.table) return 0;
    const colWidths = this.table.columns.map((c) => c.width);
    const numCols = colWidths.length;
    const natural = colWidths.reduce((s, w) => s + w, 0) + 3 * numCols + 1;
    return Math.min(natural, this.cols);
  }

  /** Produce all content rows at `cols` (before viewport slicing). */
  override produceRows(cols: number): string[] {
    if (!this.table) return [];
    return renderTable(this.table, cols, this.isFocused, this.scrollX);
  }

  override handleKey(seq: string): KeyResult {
    // Horizontal scroll: Left/Right move by one cell, Home/End jump.
    switch (seq) {
      case "\x1bOD": // Left (application mode)
      case "\x1b[D": // Left
        if (this.scrollX > 0) {
          this.scrollX = Math.max(0, this.scrollX - 1);
          return "handled";
        }
        return "unhandled";
      case "\x1bOC": // Right (application mode)
      case "\x1b[C": // Right
        if (this.totalWidth() > this.cols) {
          this.scrollX = Math.min(this.totalWidth() - this.cols, this.scrollX + 1);
          return "handled";
        }
        return "unhandled";
      case "\x1b[1~": // Home
        this.scrollX = 0;
        return "handled";
      case "\x1b[4~": // End
        this.scrollX = Math.max(0, this.totalWidth() - this.cols);
        return "handled";
      default:
        return "unhandled";
    }
  }

  override handleChar(ch: string): KeyResult {
    // h/l for fine-grained horizontal scroll (vim-style).
    if (ch === "h" && this.scrollX > 0) {
      this.scrollX = Math.max(0, this.scrollX - 1);
      return "handled";
    }
    if (ch === "l" && this.totalWidth() > this.cols) {
      this.scrollX = Math.min(this.totalWidth() - this.cols, this.scrollX + 1);
      return "handled";
    }
    return "unhandled";
  }
}

/**
 * Render a parsed table as styled rows: box-drawing borders, bold header,
 * zebra-striped data rows, and 1-cell top/bottom margins. Width-capped to
 * `cols` — when the table is too wide, the widest columns shrink first and
 * over-long cell text wraps.
 *
 * `scrollX` shifts the rendered content left by that many cells; the caller
 * is responsible for clamping it to `[0, totalWidth - cols]`.
 */
export function renderTable(
  table: ParsedTable,
  cols: number,
  focused = false,
  scrollX = 0,
): string[] {
  const colWidths = table.columns.map((c) => c.width);
  const numCols = colWidths.length;

  // Total table width: │ cell1 │ cell2 │ ... │
  // Each cell block = " content " (width + 2), cells adjacent, outer "│" each side.
  // Total = 2 + sum(widths + 2) = sum(widths) + 2*numCols + 2
  const totalWidth = colWidths.reduce((s, w) => s + w, 0) + 2 * numCols + 2;

  // Cap to the viewport: when the table doesn't fit, shrink the WIDEST
  // columns first (floor 3) instead of proportionally squeezing everything;
  // over-long cell text wraps to its capped width below.
  const w = capWidths(colWidths, cols);

  const border = focused ? "┃" : "│";
  const hBorder = focused ? "━" : "─";
  const tl = focused ? "┏" : "┌";
  const tr = focused ? "┓" : "┐";
  const ml = focused ? "┣" : "├";
  const mr = focused ? "┫" : "┤";
  const bl = focused ? "┗" : "└";
  const br = focused ? "┛" : "┘";
  const cross = focused ? "╋" : "┼";
  const tCross = focused ? "┳" : "┬";
  const bCross = focused ? "┻" : "┴";

  // Pad one display-break line of a cell to `width` display cells, honoring
  // the cell's alignment on EVERY line (GFM centers blocks, not just their
  // first line). Padding is computed against the display width of the
  // *unstyled* text so wide runes (emoji) count as 2 cells; the pad spaces
  // land inside the outer style so the zebra/selected background covers them.
  const padCellLine = (text: string, width: number, align: "left" | "center" | "right"): string => {
    const styled = renderCellMarkdown(text);
    const safe = backgroundSafe(styled);
    // Measure the RENDERED text: markdown markers (**, *, `) disappear at
    // render time and must not inflate the padding calculation.
    const dw = cellTextWidth(text);
    const pad = Math.max(0, width - dw);
    let body: string;
    switch (align) {
      case "right":
        body = " ".repeat(pad) + safe;
        break;
      case "center": {
        const left = Math.floor(pad / 2);
        const right = pad - left;
        body = " ".repeat(left) + safe + " ".repeat(right);
        break;
      }
      default:
        body = safe + " ".repeat(pad);
    }
    return ` ${body} `;
  };

  const row = (cells: string[]): string =>
    border + cells.join(border) + border;

  // Horizontal rule: left corner, interior cross between segments, right corner.
  // Top border ┌─┬─┐, separator ├─┼─┤, bottom └─┴─┘ (heavy variants when focused).
  const hr = (left: string, mid: string, right: string): string =>
    left +
    w.map((cw) => hBorder.repeat(cw + 2)).join(mid) +
    right;

  const rows: string[] = [];

  // Top margin.
  rows.push("");

  // Top border.
  rows.push(hr(tl, tCross, tr));

  // Header: bold, left-aligned (alignment is a data-row concern; headers are
  // always left-padded to match the column's content). A header containing a
  // display break emits one physical line per break.
  const headerCells = table.columns.map((c, i) =>
    cellLines(c.title, w[i]!).map((l) =>
      ST.assistant.bold(true).render(padCellLine(l, w[i]!, "left")),
    ),
  );
  const headerHeight = Math.max(...headerCells.map((c) => c.length));
  for (let hl = 0; hl < headerHeight; hl++) {
    // Short cells fill their missing lines with blank padded cells so the
    // dividers stay aligned (a bare "" would collapse the cell entirely).
    rows.push(row(headerCells.map((c, i) => c[hl] ?? padCellLine("", w[i]!, "left"))));
  }

  // Header separator.
  rows.push(hr(ml, cross, mr));

  // Data rows: zebra-striped background, with a selected-row highlight when
  // the table is focused. Both come from the theme so colors stay in sync.
  // Display breaks inside a cell (<br>) emit one physical line per break;
  // stripes apply per LOGICAL row, so every physical line of one row shares
  // its background. Scroll is applied BEFORE styling: slice the unstyled
  // line, then wrap the result in the zebra/selected style so the escape
  // sequence is never cut.
  for (let r = 0; r < table.rows.length; r++) {
    const src = table.rows[r]!;
    const cellLinesArr = src.map((c, i) =>
      cellLines(c ?? "", w[i]!).map((l) =>
        padCellLine(l, w[i]!, table.columns[i]!.align),
      ),
    );
    const rowHeight = Math.max(...cellLinesArr.map((c) => c.length));
    const style =
      focused && r === 0
        ? ST.tableSelected
        : r % 2 === 0
          ? ST.tableZebra
          : undefined;
    for (let sl = 0; sl < rowHeight; sl++) {
      // Short cells fill their missing lines with blank padded cells so the
      // dividers stay aligned (a bare "" would collapse the cell entirely).
      const line = row(
        cellLinesArr.map((c, i) => c[sl] ?? padCellLine("", w[i]!, "left")),
      );
      const scrolled =
        scrollX > 0 ? line.slice(scrollX).padEnd(totalWidth, " ") : line;
      rows.push(style ? style.render(scrolled) : scrolled);
    }
    // Divider between data rows (after the WHOLE logical row, never inside
    // a multi-line row): same runes as the header separator, and never
    // zebra/selected striped — striping is for content rows only.
    if (r < table.rows.length - 1) {
      rows.push(hr(ml, cross, mr));
    }
  }

  // Bottom border.
  rows.push(hr(bl, bCross, br));

  // Bottom margin.
  rows.push("");

  return rows;
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

  // Parse the delimiter row to capture per-column alignment.
  const delimCells = splitCells(lines[delimIdx] ?? "");
  const aligns = delimCells.map((c) => parseAlign(c));

  return {
    columns: headerCells.map((title, i) => ({
      title,
      width: widths[i]!,
      align: aligns[i] ?? "left",
    })),
    rows,
  };
}