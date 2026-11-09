/**
 * The render layer's public surface: entry rendering, the memoized row
 * cache, row accounting, and the table engine.
 */
export {
  cachedRowData,
  cachedRows,
  focusUnits,
  heightSummaryOf,
  heightSummaryAnchored,
  cheapHeight,
  estimateHeight,
  anchorEntryForRow,
  noteMutation,
  sectionsOf,
  tableOffsetsOf,
  totalRows,
  type HeightSummary,
} from "./entry.ts";
export { colorizeToolLine } from "./colorize.ts";
export { resultPreview } from "./formatting.ts";
export { highlightBlock, renderMarkdown } from "./markdown.ts";
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
