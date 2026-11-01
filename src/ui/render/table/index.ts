/**
 * Table rendering: the parser, the layout engine, the renderer, and the
 * horizontal-scroll steps.
 *
 * The four concerns live in separate modules so each can be read (and
 * changed) on its own:
 *
 *   parse.ts   — GFM pipe-table parsing and prose/table splitting
 *   layout.ts  — how wide each pane renders, and expandability
 *   render.ts  — borders, header, zebra rows, margins
 *   scroll.ts  — horizontal scroll steps
 */
export {
  cellLines,
  parseTable,
  splitTableSections,
  type ParsedColumn,
  type ParsedTable,
  type TableSection,
} from "./parse.ts";
export {
  evenDivision,
  paneSpace,
  resolveTableLayout,
  tableRowWidth,
  TABLE_MAX_COL,
  type TableLayout,
} from "./layout.ts";
export { renderTable, type TableMargin } from "./render.ts";
export {
  isTableScrollSeq,
  tableScrollChar,
  tableScrollKey,
  type TableScrollStep,
} from "./scroll.ts";
