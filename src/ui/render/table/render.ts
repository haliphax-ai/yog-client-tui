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

/**
 * Render a parsed table as styled rows.
 *
 * `widths` are the pane widths from the layout engine; the row may be
 * wider than `cols` when the table is expanded — the overflow is what
 * horizontal scroll reveals.
 *
 * `scrollX` shifts the rendered content left by that many cells.
 */
export function renderTable(
  table: ParsedTable,
  cols: number,
  focused = false,
  scrollX = 0,
  margin: TableMargin = FULL_MARGIN,
  widths?: readonly number[],
): string[] {
  // Column widths: the caller's resolved layout when given (the entry
  // renderer derives them from resolveTableLayout — expansion may push the
  // row past `cols`, which is the point), else the table's own widths.
  const w = widths !== undefined ? [...widths] : table.columns.map((c) => c.width);
  const colWidths = w;

  // Total table width: ╱ cell1 ╱ cell2 ╱ ... ╱ — Σ(w+2) per cell block plus
  // the (n+1) border runes (corners + one between every cell pair).
  const totalWidth = tableRowWidth(colWidths);

  // When focused, border runes carry the blue fg WITHOUT a trailing reset —
  // a reset inside a zebra-striped row would punch a hole in the zebra
  // background (the row is wrapped in ST.tableZebra.render() below, and
  // each border rune's \x1b[0m would override the bg it just set).
  // Unfocused border runes carry an explicit white fg so the border is
  // always white regardless of stale SGR state from a previously-focused
  // table rendered above. Bare runes would inherit the terminal's
  // current fg, which may still be blue.
  const whiteRune = (rune: string): string =>
    // eslint-disable-next-line no-control-regex
    ST.tableBorderUnfocused.render(rune).replace(/\x1b\[0?m$/, "");
  const border = focused
    ? // eslint-disable-next-line no-control-regex
      ST.tableBorderFocused.render("╱").replace(/\x1b\[0?m$/, "")
    : whiteRune("╱");
  const hBorder = focused
    ? // eslint-disable-next-line no-control-regex
      ST.tableBorderFocused.render("─").replace(/\x1b\[0?m$/, "")
    : whiteRune("─");
  // eslint-disable-next-line no-control-regex
  const tl = focused ? ST.tableBorderFocused.render("┌").replace(/\x1b\[0?m$/, "") : whiteRune("┌");
  // eslint-disable-next-line no-control-regex
  const tr = focused ? ST.tableBorderFocused.render("┐").replace(/\x1b\[0?m$/, "") : whiteRune("┐");
  // eslint-disable-next-line no-control-regex
  const ml = focused ? ST.tableBorderFocused.render("├").replace(/\x1b\[0?m$/, "") : whiteRune("├");
  // eslint-disable-next-line no-control-regex
  const mr = focused ? ST.tableBorderFocused.render("┤").replace(/\x1b\[0?m$/, "") : whiteRune("┤");
  // eslint-disable-next-line no-control-regex
  const bl = focused ? ST.tableBorderFocused.render("└").replace(/\x1b\[0?m$/, "") : whiteRune("└");
  // eslint-disable-next-line no-control-regex
  const br = focused ? ST.tableBorderFocused.render("┘").replace(/\x1b\[0?m$/, "") : whiteRune("┘");
  const cross = focused
    ? // eslint-disable-next-line no-control-regex
      ST.tableBorderFocused.render("┼").replace(/\x1b\[0?m$/, "")
    : whiteRune("┼");
  const tCross = focused
    ? // eslint-disable-next-line no-control-regex
      ST.tableBorderFocused.render("┬").replace(/\x1b\[0?m$/, "")
    : whiteRune("┬");
  const bCross = focused
    ? // eslint-disable-next-line no-control-regex
      ST.tableBorderFocused.render("┴").replace(/\x1b\[0?m$/, "")
    : whiteRune("┴");

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

  // Data rows: zebra-striped background. Display breaks inside a cell (<br>)
  // emit one physical line per break; stripes apply per LOGICAL row, so
  // every physical line of one row shares its background. Scroll is applied
  // BEFORE styling: slice the unstyled line, then wrap the result in the
  // zebra style so the escape sequence is never cut.
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
    // zebra striped — striping is for content rows only.
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
