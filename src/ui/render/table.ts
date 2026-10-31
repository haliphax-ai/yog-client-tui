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
 * Memoized: parseTable runs on every cache-signature check, so widths must
 * not re-invoke glamour per frame. */
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

/** True when any line looks like a list item (bullet or ordered marker). */
function looksLikeList(lines: string[]): boolean {
  return lines.some((l) => /^\s*(?:[-*+]|\d{1,9}[.)])\s/.test(l));
}

/** Render one cell to styled physical lines capped to `maxCells`.
 *
 * List-shaped cells render as ONE document: per-line rendering strips each
 * line's indentation, so nested children of numbered items lose their
 * nesting (same offset as the parent), and a 4-space-indented line rendered
 * standalone is an indented code block (literal markers). One document keeps
 * CommonMark semantics — children of `1. ` nest at >=3 spaces — and glamour
 * computes the offsets itself.
 */
function styleCell(cell: string, maxCells: number): string[] {
  const lines = cellLines(cell);
  if (lines.length > 1 && looksLikeList(lines)) {
    const styled = renderInlineMarkdown(cell, cellWidth(cell) + 16);
    const out: string[] = [];
    for (const s of styled) {
      if (displayWidth(stripAnsi(s)) <= maxCells) {
        out.push(s);
      } else {
        out.push(...wrapText(s, Math.max(1, maxCells)));
      }
    }
    return out.length > 0 ? out : [""];
  }
  return lines.flatMap((l) => styleCellLine(l, maxCells));
}

/** Render one break-line through glamour and cap it to `maxCells` visible
 * cells. Glamour styles (and OSC-8-linkifies) but is given a width it
 * cannot wrap at — its word-wrap reserves block margins that would shred
 * narrow cells into one-character lines — so wrapping to the column width
 * is done here with the ANSI/OSC-aware wrapper. */
function styleCellLine(line: string, maxCells: number): string[] {
  const styled = renderInlineMarkdown(line, displayWidth(line) + 16);
  const out: string[] = [];
  for (const s of styled) {
    if (displayWidth(stripAnsi(s)) <= maxCells) {
      out.push(s);
    } else {
      out.push(...wrapText(s, Math.max(1, maxCells)));
    }
  }
  return out;
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
 * does — floored at TABLE_MIN_COL so reflowed columns stay readable. Cell
 * its column width when capping squeezes it below the text's width.
 */
export function capWidths(colWidths: number[], cols: number): number[] {
  // Row geometry: │ w1 │ w2 │ = Σ(w + 2) + 2 borders = Σw + 2n + 2.
  const fits = (ws: number[]): boolean => tableRowWidth(ws) <= cols;
  if (fits(colWidths)) return [...colWidths];
  const w = [...colWidths];
  while (!fits(w) && w.some((x) => x > TABLE_MIN_COL)) {
    let max = 0;
    for (const x of w) if (x > max) max = x;
    for (let i = 0; i < w.length; i++) {
      if (w[i] === max) w[i] = max - 1;
    }
  }
  return w;
}

/** Minimum width (cells) a reflowed column may collapse to — below this
 *  the table cannot be collapsed and stays expanded instead. */
export const TABLE_MIN_COL = 10;

/** Maximum width (cells) a reflowed column may expand to — a ceiling, not
 *  a target. Reflowed columns render at `min(natural, this)` once expanded
 *  — breathing room, not unbounded width. */
export const TABLE_MAX_COL = 30;

/** Rendered width of a table row in cells: Σ(width + 2 padding) + (n+1)
 *  border runes — │ c1 │ c2 │ has a separator between every pair of cells
 *  plus the two outer corners (Σw + 3n + 1). */
export function tableRowWidth(colWidths: readonly number[]): number {
  return colWidths.reduce((s, w) => s + w + 2, 0) + colWidths.length + 1;
}

/**
 * Layout decision for one table: whether the entry is focus-expandable and,
 * when expanded, the per-column widths reflow should render at.
 *
 * Three states, decided in order:
 *
 * 1. Natural widths fit the viewport → collapsed, not expandable. The
 *    table shrinkwraps its content and Enter does nothing.
 *
 * 2. Natural widths don't fit, but reflowed columns at `min(natural, 30)`
 *    fit → fully expanded already, not expandable, not collapsible. The
 *    table renders at the expanded widths (which fit) and Enter does
 *    nothing — it's already using the full viewport.
 *
 * 3. Neither fits → expandable. Enter toggles between collapsed (reflowed
 *    columns squeezed widest-first, floored at `TABLE_MIN_COL`) and
 *    expanded (reflowed columns at `min(natural, 30)`, overflowing the
 *    viewport — scroll reveals it). If the collapsed squeeze can't keep
 *    every reflowed column at or above `TABLE_MIN_COL`, the table is not
 *    collapsible: it stays expanded permanently and Enter is inert.
 *
 * A column is "reflowed" when the collapsed layout squeezed it below its
 * natural width. Non-reflowed columns keep their collapsed width in both
 * states — expansion only relieves squeezed columns, never widens tidy
 * ones, and no column ever exceeds 30.
 */
export function resolveTableLayout(
  colWidths: readonly number[],
  cols: number,
  tableExpanded: boolean,
): { expandable: boolean; widths: number[] } {
  if (colWidths.length === 0) return { expandable: false, widths: [] };

  // State 1: natural widths fit → collapsed, not expandable.
  if (tableRowWidth(colWidths) <= cols) {
    return { expandable: false, widths: [...colWidths] };
  }

  // Collapsed layout: squeeze widest-first, floored at TABLE_MIN_COL.
  const collapsed = capWidths([...colWidths], cols);

  // State 3a: not collapsible — even at the floor the row doesn't fit.
  // Stay expanded permanently; Enter is inert.
  if (tableRowWidth(collapsed) > cols) {
    return { expandable: false, widths: buildExpanded(colWidths, collapsed) };
  }

  // Expanded layout: reflowed columns at min(natural, 30), non-reflowed
  // keep their collapsed width.
  const expanded = buildExpanded(colWidths, collapsed);

  // State 2: expanded fits → fully expanded already, not expandable.
  if (tableRowWidth(expanded) <= cols) {
    return { expandable: false, widths: expanded };
  }

  // State 3b: expandable — toggle between collapsed and expanded.
  return { expandable: true, widths: tableExpanded ? expanded : collapsed };
}

/** Build the expanded layout: reflowed columns (squeezed below natural in
 *  the collapsed layout) render at `min(natural, TABLE_MAX_COL)`; the rest
 *  keep their collapsed width. */
function buildExpanded(natural: readonly number[], collapsed: readonly number[]): number[] {
  return natural.map((n, i) =>
    (collapsed[i] ?? 0) < n ? Math.min(n, TABLE_MAX_COL) : (collapsed[i] ?? 0),
  );
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

import { sliceAnsi } from "@oakoliver/lipgloss";
import { type KeyResult } from "../components/Component.ts";
import { ViewportComponent } from "../components/ViewportComponent.ts";
import { displayWidth, stripAnsi, wrapText } from "../../util/ansi.ts";
import { ST } from "../theme.ts";
import { renderInlineMarkdown } from "./markdown.ts";

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

/** Background-safe post-process: strip inner bg SGRs, replace glamour's
 * full resets with attr-off + fg resets so the outer zebra/selected
 * background survives AND underlined link runs close cleanly (24) without
 * leaking bold/italic (22/23/29) into following text. */
function backgroundSafe(text: string): string {
  return (
    text
      // full resets → attr-offs + fg reset (bg preserved)
      .replaceAll("\x1b[0m", "\x1b[22;23;24;25;27;29;39m")
      .replaceAll("\x1b[m", "\x1b[22;23;24;25;27;29;39m")
      // strip any remaining background SGRs (48;2;... / 48;5;...)
      .replace(/\x1b\[(?:48;2;\d{1,3};\d{1,3};\d{1,3}|48;5;\d{1,3})(?:;\d+)*m/g, "")
  );
}

export class TableComponent extends ViewportComponent {
  private table: ParsedTable | null = null;
  private margin: TableMargin = { top: true, bottom: true };
  private fitWidths: readonly number[] | undefined = undefined;

  /** Set the table data (re-renders on next `render` call). */
  setTable(table: ParsedTable): void {
    this.table = table;
    this.scrollX = 0; // reset scroll when data changes
  }

  /** Set top/bottom margins (first/last blocks of a sequence drop theirs). */
  setMargin(margin: TableMargin): void {
    this.margin = margin;
  }

  /** Pin the column layout (resolveTableLayout output) — omit to fit-to-viewport. */
  setFitWidths(widths: readonly number[] | undefined): void {
    this.fitWidths = widths === undefined ? undefined : [...widths];
  }

  /** Current horizontal scroll offset (in cells). */
  getScrollX(): number {
    return this.scrollX;
  }

  /** Total rendered width: the natural table width capped at the viewport —
   * `renderTable` never emits lines wider than `cols` (it wraps instead). */
  override totalWidth(): number {
    if (!this.table) return 0;
    const widths = this.fitWidths ?? this.table.columns.map((c) => c.width);
    return Math.min(tableRowWidth(widths), this.cols);
  }

  /** Produce all content rows at `cols` (before viewport slicing). */
  override produceRows(cols: number): string[] {
    if (!this.table) return [];
    return renderTable(this.table, cols, this.isFocused, this.scrollX, this.margin, this.fitWidths);
  }

  override handleKey(seq: string): KeyResult {
    const step = tableScrollKey(seq, this.scrollX, this.totalWidth(), this.cols);
    if (step === null) return "unhandled";
    this.scrollX = step.scrollX;
    return "handled";
  }

  override handleChar(ch: string): KeyResult {
    const step = tableScrollChar(ch, this.scrollX, this.totalWidth(), this.cols);
    if (step === null) return "unhandled";
    this.scrollX = step.scrollX;
    return "handled";
  }
}

/** Outcome of one table horizontal-scroll key: the new offset (when the key
 *  moved the view) or null (key not claimed — bubble it). */
export type TableScrollStep = { scrollX: number } | null;

/** Pure horizontal-scroll handler for a focused table: Left/Right move by one
 *  cell, Home/End jump; unclaimed sequences return null. `totalW` bounds the
 *  offset at `totalW - cols` (0 when the row fits the viewport). */
export function tableScrollKey(
  seq: string,
  scrollX: number,
  totalW: number,
  cols: number,
): TableScrollStep {
  const max = Math.max(0, totalW - cols);
  switch (seq) {
    case "\x1bOD": // Left (application mode)
    case "\x1b[D": // Left
      return scrollX > 0 ? { scrollX: Math.max(0, scrollX - 1) } : null;
    case "\x1bOC": // Right (application mode)
    case "\x1b[C": // Right
      return max > 0 ? { scrollX: Math.min(max, scrollX + 1) } : null;
    case "\x1b[1~": // Home
      return { scrollX: 0 };
    case "\x1b[4~": // End
      return { scrollX: max };
    default:
      return null;
  }
}

/** True when `seq` is one of the horizontal-scroll key sequences. Used by
 * the viewport's fast path to skip a full table parse for keys that can
 * never scroll (the layout is only needed for scroll steps). */
export function isTableScrollSeq(seq: string): boolean {
  switch (seq) {
    case "\x1bOD": // Left (application mode)
    case "\x1b[D": // Left
    case "\x1bOC": // Right (application mode)
    case "\x1b[C": // Right
    case "\x1b[1~": // Home
    case "\x1b[4~": // End
      return true;
    default:
      return false;
  }
}

/** Char-level companion: h/l for fine-grained horizontal scroll. */
export function tableScrollChar(
  ch: string,
  scrollX: number,
  totalW: number,
  cols: number,
): TableScrollStep {
  const max = Math.max(0, totalW - cols);
  if (ch === "h") return scrollX > 0 ? { scrollX: Math.max(0, scrollX - 1) } : null;
  if (ch === "l") return max > 0 ? { scrollX: Math.min(max, scrollX + 1) } : null;
  return null;
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
/** Top/bottom margins around a rendered table. The first and last blocks of
 * a prose sequence drop their outer margin (the entry separators and
 * surrounding prose spacing already provide the gap). */
export interface TableMargin {
  top: boolean;
  bottom: boolean;
}

/** Default margins: both sides kept. */
const FULL_MARGIN: TableMargin = { top: true, bottom: true };

export function renderTable(
  table: ParsedTable,
  cols: number,
  focused = false,
  scrollX = 0,
  margin: TableMargin = FULL_MARGIN,
  fitWidths?: readonly number[],
): string[] {
  // Column widths: the caller's resolved layout when given (the entry
  // renderer derives them from resolveTableLayout — expansion may push the
  // row past `cols`, which is the point), else fit-to-viewport.
  const w =
    fitWidths !== undefined
      ? [...fitWidths]
      : capWidths(
          table.columns.map((c) => c.width),
          cols,
        );
  const colWidths = w;
  const numCols = colWidths.length;

  // Total table width: │ cell1 │ cell2 │ ... │ — Σ(w+2) per cell block plus
  // the (n+1) border runes (corners + one between every cell pair).
  const totalWidth = tableRowWidth(colWidths);

  const border = focused ? ST.tableBorderFocused.render("│") : "│";
  const hBorder = focused ? ST.tableBorderFocused.render("─") : "─";
  const tl = focused ? ST.tableBorderFocused.render("┌") : "┌";
  const tr = focused ? ST.tableBorderFocused.render("┐") : "┐";
  const ml = focused ? ST.tableBorderFocused.render("├") : "├";
  const mr = focused ? ST.tableBorderFocused.render("┤") : "┤";
  const bl = focused ? ST.tableBorderFocused.render("└") : "└";
  const br = focused ? ST.tableBorderFocused.render("┘") : "┘";
  const cross = focused ? ST.tableBorderFocused.render("┼") : "┼";
  const tCross = focused ? ST.tableBorderFocused.render("┬") : "┬";
  const bCross = focused ? ST.tableBorderFocused.render("┴") : "┴";

  // Pad ONE RENDERED physical line of a cell to `width` display cells,
  // honoring the cell's alignment on EVERY line (GFM centers blocks, not
  // just their first line). `text` arrives already glamour-styled and
  // background-safe; padding is measured against its visible width so
  // markdown markers (which glamour consumed) never inflate it. Pad spaces
  // land inside the outer style so the zebra/selected background covers them.
  const padCellLine = (text: string, width: number, align: "left" | "center" | "right"): string => {
    const safe = backgroundSafe(text);
    const dw = displayWidth(stripAnsi(text));
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

  const row = (cells: string[]): string => border + cells.join(border) + border;

  // Horizontal rule: left corner, interior cross between segments, right corner.
  // Top border ┌─┬─┐, separator ├─┼─┤, bottom └─┴─┘ (heavy variants when focused).
  const hr = (left: string, mid: string, right: string): string =>
    left + w.map((cw) => hBorder.repeat(cw + 2)).join(mid) + right;

  // Apply horizontal scroll to every structural row so the whole table
  // (borders, header, dividers, data) shifts together — scrolling only the
  // data rows left the borders stranded while the content slid, which read
  // as a broken table.
  const applyScroll = (line: string): string => {
    if (scrollX <= 0) return line;
    const sliced = sliceAnsi(line, scrollX);
    const padBack = Math.max(0, totalWidth - displayWidth(stripAnsi(sliced)));
    return sliced + " ".repeat(padBack);
  };

  const rows: string[] = [];

  // Top margin (skipped when the table opens the sequence).
  if (margin.top) rows.push("");

  // Top border.
  rows.push(applyScroll(hr(tl, tCross, tr)));

  // Header: bold, left-aligned (alignment is a data-row concern; headers are
  // always left-padded to match the column's content). Each break-line
  // renders through glamour (may yield several physical lines when the
  // capped column wraps it).
  const headerStyle = ST.assistant;
  const headerCells = table.columns.map((c, i) =>
    styleCell(c.title, w[i]!).map((rl) =>
      headerStyle.bold(true).render(padCellLine(rl, w[i]!, "left")),
    ),
  );
  const headerHeight = Math.max(...headerCells.map((c) => c.length));
  for (let hl = 0; hl < headerHeight; hl++) {
    // Short cells fill their missing lines with blank padded cells so the
    // dividers stay aligned (a bare "" would collapse the cell entirely).
    rows.push(applyScroll(row(headerCells.map((c, i) => c[hl] ?? padCellLine("", w[i]!, "left")))));
  }

  // Header separator.
  rows.push(applyScroll(hr(ml, cross, mr)));

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
      styleCell(c ?? "", w[i]!).map((rl) => padCellLine(rl, w[i]!, table.columns[i]!.align)),
    );
    const rowHeight = Math.max(...cellLinesArr.map((c) => c.length));
    const style = r % 2 === 0 ? ST.tableZebra : undefined;
    for (let sl = 0; sl < rowHeight; sl++) {
      // Short cells fill their missing lines with blank padded cells so the
      // dividers stay aligned (a bare "" would collapse the cell entirely).
      const line = row(cellLinesArr.map((c, i) => c[sl] ?? padCellLine("", w[i]!, "left")));
      // Cell-accurate pad-back: padEnd counts characters (escape bytes
      // included), so a sliced line bearing SGR/OSC runs would pad short.
      const scrolled = applyScroll(line);
      rows.push(style ? style.render(scrolled) : scrolled);
    }
    // Divider between data rows (after the WHOLE logical row, never inside
    // a multi-line row): same runes as the header separator, and never
    // zebra/selected striped — striping is for content rows only.
    if (r < table.rows.length - 1) {
      rows.push(applyScroll(hr(ml, cross, mr)));
    }
  }

  // Bottom border.
  rows.push(applyScroll(hr(bl, bCross, br)));

  // Bottom margin (skipped when the table closes the sequence).
  if (margin.bottom) rows.push("");

  return rows;
}

/**
 * A section of split text: either prose or a parsed table.
 *
 * Produced by {@link splitTableSections}; consumed by the entry
 * renderer to route prose through glamour and tables through Bubbles.
 */
export type TableSection = { kind: "prose"; text: string } | { kind: "table"; table: ParsedTable };

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
