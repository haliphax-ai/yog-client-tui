/**
 * The render layer's public surface: entry rendering, the memoized row
 * cache, row accounting, and the table engine.
 */
export {
  cachedRowData,
  cachedRows,
  heightSummaryOf,
  heightSummaryAnchored,
  cheapHeight,
  estimateHeight,
  anchorEntryForRow,
  noteMutation,
  tableOffsetsOf,
  totalRows,
  type HeightSummary,
} from "./entry.ts";
export { sectionsOf } from "./entrySections.ts";
export { colorizeToolLine } from "./colorize.ts";
export { resultPreview } from "./resultPreview.ts";
export { highlightBlock, renderMarkdown, mdRender } from "./markdown.ts";
export { normalizeLines } from "./normalize.ts";
export { hangWrapRows } from "./listRows.ts";
export {
  isTableScrollSeq,
  parseTable,
  renderTable,
  resolveTableLayout,
  splitTableSections,
  tableRowWidth,
  tableScrollChar,
  tableScrollKey,
  TABLE_MAX_COL,
  type ParsedColumn,
  type ParsedTable,
  type TableMargin,
  type TableSection,
} from "./table/index.ts";
