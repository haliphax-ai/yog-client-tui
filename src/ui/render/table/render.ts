/**
 * Table rendering: box-drawing borders, bold header, zebra-striped data
 * rows, 1-cell top/bottom margins, and horizontal scroll.
 *
 * The renderer owns presentation only: the widths come from the layout
 * engine, the scroll offset from the caller.
 */
import { displayWidth, scrollLeft, stripAnsi, wrapText } from "../../../util/ansi.ts";
import { ST } from "../../theme.ts";
import { hangWrapRows, renderInlineMarkdown } from "../markdown.ts";
import { cellLines, type ParsedTable } from "./parse.ts";
import { tableRowWidth } from "./layout.ts";

/**
 * Top/bottom margins around a rendered table. The first and last blocks of
 * a prose sequence drop their outer margin (the entry separators and
 * surrounding prose spacing already provide the gap).
 */
export interface TableMargin {
  top: boolean;
  bottom: boolean;
}

/** Default margins: both sides kept. */
const FULL_MARGIN: TableMargin = { top: true, bottom: true };

/** The border-rune geometry of one table row: the vertical border, the
 *  horizontal run, and the six joints (corners, side tees, crosses). */
interface BorderRunes {
  v: string;
  h: string;
  tl: string;
  tr: string;
  ml: string;
  mr: string;
  bl: string;
  br: string;
  cross: string;
  tCross: string;
  bCross: string;
}

/**
 * The border runes for one render: focused borders carry the focus blue
 * WITHOUT a trailing reset — a reset inside a zebra-striped row would
 * punch a hole in the zebra background (the row is wrapped in
 * `ST.tableZebra.render()` below, and each border rune's `ESC[0m` would
 * override the bg it just set). Unfocused borders carry an explicit white
 * fg so the border is always white regardless of stale SGR state from a
 * previously-focused table rendered above — bare runes would inherit the
 * terminal's current fg, which may still be blue.
 */
function borderRunes(focused: boolean): BorderRunes {
  const style = focused ? ST.tableBorderFocused : ST.tableBorderUnfocused;
  const rune = (r: string): string => style.render(r).replace(/\x1b\[0?m$/, "");
  return {
    v: rune("│"),
    h: rune("─"),
    tl: rune("┌"),
    tr: rune("┐"),
    ml: rune("├"),
    mr: rune("┤"),
    bl: rune("└"),
    br: rune("┘"),
    cross: rune("┼"),
    tCross: rune("┬"),
    bCross: rune("┴"),
  };
}

/** True when any line looks like a list item (bullet or ordered marker). */
function looksLikeList(lines: string[]): boolean {
  return lines.some((l) => /^\s*(?:[-*+]|\d{1,9}[.)])\s/.test(l));
}

/**
 * Render one cell to styled physical lines capped to `maxCells`.
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
    const styled = renderInlineMarkdown(cell, displayWidth(cell) + 16);
    const out: string[] = [];
    for (const s of styled) {
      if (displayWidth(stripAnsi(s)) <= maxCells) {
        out.push(s);
      } else {
        out.push(...wrapText(s, Math.max(1, maxCells)));
      }
    }
    // Same hanging indent as prose: continuation rows of a wrapped item
    // pad to the marker's content column instead of the cell's first
    // column (hangWrapRows capping to maxCells replaces the per-row cap
    // above, so every emitted row is within the pane budget).
    return hangWrapRows(out, maxCells);
  }
  return lines.flatMap((l) =>
    looksLikeList([l])
      ? hangWrapRows(styleCellLine(l, maxCells), maxCells)
      : styleCellLine(l, maxCells),
  );
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

/**
 * Background-safe post-process: strip inner bg SGRs, replace glamour's
 * full resets with attr-off + fg resets so the outer zebra/selected
 * background survives AND underlined link runs close cleanly (24) without
 * leaking bold/italic (22/23/29) into following text.
 */
function backgroundSafe(text: string): string {
  return (
    text
      // full resets → attr-offs + fg reset (bg preserved)
      .replaceAll("\x1b[0m", "\x1b[22;23;24;25;27;29;39m")
      .replaceAll("\x1b[m", "\x1b[22;23;24;25;27;29;39m")
      // strip any remaining background SGRs (48;2;... / 48;5;...)
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[(?:48;2;\d{1,3};\d{1,3};\d{1,3}|48;5;\d{1,3})(?:;\d+)*m/g, "")
  );
}

/** The aligned body of one padded cell line (the one-cell side padding is
 *  added by the caller). */
function alignedBody(safe: string, pad: number, align: "left" | "center" | "right"): string {
  if (align === "right") return " ".repeat(pad) + safe;
  if (align === "center") {
    const left = Math.floor(pad / 2);
    return " ".repeat(left) + safe + " ".repeat(pad - left);
  }
  return safe + " ".repeat(pad);
}

/**
 * Pad ONE RENDERED physical line of a cell to `width` display cells,
 * honoring the cell's alignment on EVERY line (GFM centers blocks, not
 * just their first line). `text` arrives already glamour-styled and
 * background-safe; padding is measured against its visible width so
 * markdown markers (which glamour consumed) never inflate it. Pad spaces
 * land inside the outer style so the zebra/selected background covers them.
 */
function padCellLineOf(text: string, width: number, align: "left" | "center" | "right"): string {
  const safe = backgroundSafe(text);
  const pad = Math.max(0, width - displayWidth(stripAnsi(text)));
  return ` ${alignedBody(safe, pad, align)} `;
}

export interface RenderOptions {
  /** True when the table is the focus target (focused border + zebra). */
  focused?: boolean;
  /** Horizontal scroll offset, in cells. */
  scrollX?: number;
  /** Top/bottom margins (dropped at a sequence edge). */
  margin?: TableMargin;
  /** Pane widths from the layout engine; default: the table's own. */
  widths?: readonly number[];
}

/**
 * Render a parsed table as styled rows at `cols` cells wide.
 *
 * The row may be wider than `cols` when the table is expanded — the
 * overflow is what horizontal scroll reveals; `options.scrollX` shifts the
 * rendered content left by that many cells.
 */
export function renderTable(
  table: ParsedTable,
  cols: number,
  options: RenderOptions = {},
): string[] {
  const { focused = false, scrollX = 0, margin = FULL_MARGIN, widths } = options;
  // Column widths: the caller's resolved layout when given (the entry
  // renderer derives them from resolveTableLayout — expansion may push the
  // row past `cols`, which is the point), else the table's own widths.
  const w = widths !== undefined ? [...widths] : table.columns.map((c) => c.width);
  const colWidths = w;

  // Total table width: │ cell1 │ cell2 │ ... │ — Σ(w+2) per cell block plus
  // the (n+1) border runes (corners + one between every cell pair).
  const totalWidth = tableRowWidth(colWidths);

  const {
    v: border,
    h: hBorder,
    tl,
    tr,
    ml,
    mr,
    bl,
    br,
    cross,
    tCross,
    bCross,
  } = borderRunes(focused);

  const padCellLine = padCellLineOf;
  return assembleRows(table, {
    w,
    totalWidth,
    border,
    hBorder,
    runes: { tl, tr, ml, mr, bl, br, cross, tCross, bCross },
    focused,
    scrollX,
    margin,
  });
}

/** One rendered table row: `│ cell │ cell │`. */
function dataRow(cells: string[], border: string): string {
  return border + cells.join(border) + border;
}

/**
 * Assemble the table's rows: top margin/border, the bold header block, its
 * separator, the zebra-striped data rows (dividers BETWEEN rows, never
 * inside one), the bottom border, and the bottom margin.
 */
/** The shared drawing surface the row assemblers need: column widths,
 *  the border runes, and the scroll/focus state. */
interface Frame {
  w: number[];
  totalWidth: number;
  border: string;
  hBorder: string;
  runes: Omit<BorderRunes, "v" | "h">;
  focused: boolean;
  scrollX: number;
  margin: TableMargin;
}

function assembleRows(table: ParsedTable, frame: Frame): string[] {
  const { w, totalWidth, border, hBorder, runes, focused, scrollX, margin } = frame;

  // Horizontal rule: left corner, interior cross between segments, right corner.
  // Top border ┌─┬─┐, separator ├─┼─┤, bottom └─┴─┘.
  const hr = (left: string, mid: string, right: string): string =>
    left + w.map((cw) => hBorder.repeat(cw + 2)).join(mid) + right;

  // Apply horizontal scroll to every structural row so the whole table
  // (borders, header, dividers, data) shifts together — scrolling only the
  // data rows left the borders stranded while the content slid, which read
  // as a broken table.
  const applyScroll = (line: string): string => {
    if (scrollX <= 0) return line;
    const sliced = scrollLeft(line, scrollX);
    const padBack = Math.max(0, totalWidth - displayWidth(stripAnsi(sliced)));
    return sliced + " ".repeat(padBack);
  };

  const rows: string[] = [];

  // Top margin (skipped when the table opens the sequence).
  if (margin.top) rows.push("");

  // Top border.
  rows.push(applyScroll(hr(runes.tl, runes.tCross, runes.tr)));
  pushHeader(rows, table, { frame, hr, applyScroll });
  pushDataRows(rows, table, { frame, hr, applyScroll });

  // Bottom border.
  rows.push(applyScroll(hr(runes.bl, runes.bCross, runes.br)));

  // Bottom margin (skipped when the table closes the sequence).
  if (margin.bottom) rows.push("");

  return rows;
}

/** One row painter: where the finished rows land, plus the horizontal-rule
 *  and scroll helpers that share the frame's geometry. */
interface Painter {
  frame: Frame;
  hr(left: string, mid: string, right: string): string;
  applyScroll(line: string): string;
}

/** Header block: bold, left-aligned (alignment is a data-row concern;
 *  headers are always left-padded to match the column's content). Each
 *  break-line renders through glamour (may yield several physical lines
 *  when the capped column wraps it), then the header separator. */
function pushHeader(rows: string[], table: ParsedTable, paint: Painter): void {
  const { w, border, runes } = paint.frame;
  const headerStyle = ST.assistant;
  const headerCells = table.columns.map((c, i) =>
    styleCell(c.title, w[i]!).map((rl) =>
      headerStyle.bold(true).render(padCellLineOf(rl, w[i]!, "left")),
    ),
  );
  const headerHeight = Math.max(...headerCells.map((c) => c.length));
  for (let hl = 0; hl < headerHeight; hl++) {
    // Short cells fill their missing lines with blank padded cells so the
    // dividers stay aligned (a bare "" would collapse the cell entirely).
    const cells = headerCells.map((c, i) => c[hl] ?? padCellLineOf("", w[i]!, "left"));
    rows.push(paint.applyScroll(dataRow(cells, border)));
  }

  // Header separator.
  rows.push(paint.applyScroll(paint.hr(runes.ml, runes.cross, runes.mr)));
}

/** Data rows: zebra-striped background. Display breaks inside a cell (<br>)
 *  emit one physical line per break; stripes apply per LOGICAL row, so every
 *  physical line of one row shares its background. Scroll is applied BEFORE
 *  styling: slice the unstyled line, then wrap the result in the zebra style
 *  so the escape sequence is never cut. */
function pushDataRows(rows: string[], table: ParsedTable, paint: Painter): void {
  const { w, border, runes, focused } = paint.frame;
  for (let r = 0; r < table.rows.length; r++) {
    const src = table.rows[r]!;
    const cellLinesArr = src.map((c, i) =>
      styleCell(c ?? "", w[i]!).map((rl) => padCellLineOf(rl, w[i]!, table.columns[i]!.align)),
    );
    const rowHeight = Math.max(...cellLinesArr.map((c) => c.length));
    // Focus paints the blue THROUGH the zebra: a focused table's even rows
    // carry the focused zebra (white on the focus blue) instead of the
    // plain dark zebra, so the selection is unmistakable on data rows too —
    // borders alone read as "that table has a header" rather than
    // "selected". White fg in both states keeps contrast identical.
    const style = r % 2 === 0 ? (focused ? ST.tableZebraFocused : ST.tableZebra) : undefined;
    for (let sl = 0; sl < rowHeight; sl++) {
      // Short cells fill their missing lines with blank padded cells so the
      // dividers stay aligned (a bare "" would collapse the cell entirely).
      const cells = cellLinesArr.map((c, i) => c[sl] ?? padCellLineOf("", w[i]!, "left"));
      // Cell-accurate pad-back: padEnd counts characters (escape bytes
      // included), so a sliced line bearing SGR/OSC runs would pad short.
      const scrolled = paint.applyScroll(dataRow(cells, border));
      rows.push(style ? style.render(scrolled) : scrolled);
    }
    // Divider between data rows (after the WHOLE logical row, never inside
    // a multi-line row): same runes as the header separator, and never
    // zebra striped — striping is for content rows only.
    if (r < table.rows.length - 1) {
      rows.push(paint.applyScroll(paint.hr(runes.ml, runes.cross, runes.mr)));
    }
  }
}
