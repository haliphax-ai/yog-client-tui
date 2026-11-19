/**
 * Prose entry rendering (user prompts and assistant replies): the padded
 * prompt bubble and the bordered assistant block, with per-paragraph
 * glamour rendering and inline tables.
 */
import { truncateAnsi } from "../../util/ansi.ts";
import { flattenMarkdownFlat, renderMarkdownFlat } from "./prose.ts";
import { assistantBorderStyle, userBubbleStyle } from "./entryStyle.ts";
import { resolveTableLayout, renderTable, tableRowWidth } from "./table/index.ts";
import type { EntryRender } from "./entryRender.ts";
import { sectionsOf, type TableSection } from "./entrySections.ts";
import type { LogEntry } from "../../core/entries.ts";

/** Left-border rune marking assistant prose. */
const BORDER_RUNE = "▐";

/**
 * Render one prose entry to its styled block at `cols`. Prompts and
 * responses go through the glamour markdown renderer first: prompts render
 * in a light-grey padded bubble with theme colors flattened to the bubble's
 * light-grey text (emphasis kept); assistant replies keep full glamour
 * styling, prefixed on every row by a themed half-block border.
 *
 * The user bubble and the assistant border recolor when the entry is
 * focused (`focusedTable` is the entry-focus flag at this call site): the
 * bubble turns white-on-dark-blue like every other focus target, the
 * assistant border rune switches to the focus blue ("black" edge).
 * Geometry is identical in both states — focus only recolors, it never
 * reflows.
 *
 * Every chunk is HARD-wrapped: prose and table rows are programmatically
 * word-wrapped to the block's body width (cols-2 for padded/bordered
 * blocks), so no row exceeds the terminal width and the terminal never
 * soft-wraps a chunk.
 */
export function renderProseEntry(
  entry: LogEntry,
  cols: number,
  focusedTable: boolean,
  focusedTableIndex: number,
): EntryRender {
  const isUser = entry.kind === "user";
  // Prompt: 1-cell padding each side sits INSIDE the style width, so the
  // content wraps at cols-2 while the block spans the full terminal.
  // Assistant: rows are prefixed with the border cell + one space, so the
  // prose wraps at cols-2 too and the border gutter survives wrapping.
  const bodyW = Math.max(1, cols - 2);
  const sections = sectionsOf(entry);
  const edge = { first: sections[0], last: sections[sections.length - 1] };
  const parts: string[] = [];
  const tableOffsets: number[] = [];
  let tableIndex = 0;
  for (const section of sections) {
    if (section.kind === "prose") {
      // Per-paragraph rendering: each paragraph group renders as its own
      // glamour document so its list indent is assigned from its own
      // first block (see prose.ts). A group that fails to render falls
      // back to plain wrapText ON ITS OWN — groups are independent, so
      // one glamour failure must not flatten the whole section.
      const flat = isUser
        ? flattenMarkdownFlat(section.text, bodyW)
        : renderMarkdownFlat(section.text, bodyW);
      parts.push(...flat);
      continue;
    }
    tableOffsets.push(parts.length);
    const at: TablePosition = {
      section,
      prev: edge.first,
      next: edge.last,
      bodyW,
      focused: focusedTable && tableIndex === focusedTableIndex,
    };
    parts.push(...tableRows(section, tableContextOf(entry, tableIndex, at)));
    tableIndex += 1;
  }
  if (parts.length === 0) parts.push("");
  return isUser
    ? userBubble(parts, cols, focusedTable, tableOffsets)
    : borderedRows(parts, focusedTable, tableOffsets);
}

/** The context one table section renders in: the entry's per-table
 *  interaction state, the section's margins against its neighbors, and the
 *  cell budget. */
interface TableContext {
  state: { expanded?: boolean; scrollX?: number } | undefined;
  margin: { top: boolean; bottom: boolean };
  bodyW: number;
  focused: boolean;
}

/** The position of one table section within the entry's section list, with
 *  everything the table needs beyond the section itself: the section's
 *  neighbors (which sides draw a margin), the cell budget, and whether the
 *  table is the focus target. */
interface TablePosition {
  section: TableSection;
  prev: TableSection | undefined;
  next: TableSection | undefined;
  bodyW: number;
  focused: boolean;
}

/** The render context for one table section: the entry's per-table
 *  interaction state plus the margins and budget of its position. The
 *  margins come from the position: every table except the entry's first
 *  section draws a top margin, every table except the last draws a bottom
 *  margin (spacing to the entry's neighbors is the separator's job). */
function tableContextOf(entry: LogEntry, tableIndex: number, at: TablePosition): TableContext {
  return {
    state: entry.tables?.[tableIndex],
    margin: { top: at.section !== at.prev, bottom: at.section !== at.next },
    bodyW: at.bodyW,
    focused: at.focused,
  };
}

/** The rendered (cell-clipped) rows of one table section. The column
 *  layout comes from the layout engine: the collapsed layout fits the
 *  viewport, the expanded one widens the panes that were squeezed — the
 *  expanded row may exceed `cols`, and horizontal scroll reveals it. */
function tableRows(section: Extract<TableSection, { kind: "table" }>, ctx: TableContext): string[] {
  const natural = section.table.columns.map((c) => c.width);
  const resolved = resolveTableLayout(natural, ctx.bodyW, ctx.state?.expanded === true);
  const maxScroll = Math.max(0, tableRowWidth(resolved.widths) - ctx.bodyW);
  const scrollX = Math.max(0, Math.min(ctx.state?.scrollX ?? 0, maxScroll));
  // The table's cell budget is the entry's body width: a row wider than
  // that (the expanded layout) is clipped to the visible window.
  return renderTable(section.table, ctx.bodyW, {
    focused: ctx.focused,
    scrollX,
    margin: ctx.margin,
    widths: resolved.widths,
  }).map((row) => truncateAnsi(row, ctx.bodyW));
}

/** The prompt bubble: focus recolors the whole bubble (white on dark blue,
 *  same as the other focus targets); geometry is identical in both states,
 *  so focusing never reflows — only the palette swaps. */
function userBubble(
  parts: string[],
  cols: number,
  focusedTable: boolean,
  tableOffsets: number[],
): EntryRender {
  const style = userBubbleStyle(focusedTable).width(cols);
  const rendered = style.render(parts.join("\n"));
  return { rendered, rows: rendered.split("\n").length, tableOffsets };
}

/** The assistant block: style each prose row by itself, then glue the
 *  border in front — the border never crosses the prose styling and vice
 *  versa, and pre-wrapped rows (md or wrapText, both <= bodyW = cols-2
 *  cells) leave room for the two-cell gutter on every row. */
function borderedRows(parts: string[], focusedTable: boolean, tableOffsets: number[]): EntryRender {
  const border = assistantBorderStyle(focusedTable).render(BORDER_RUNE);
  const rows = parts.map((row) => `${border} ${row}`);
  return { rendered: rows.join("\n"), rows: rows.length, tableOffsets };
}
