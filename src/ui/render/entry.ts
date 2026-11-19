/**
 * Entry rendering: the re-exports of the memoized row cache and the height
 * summaries the components consume.
 *
 * The implementation lives in its sibling modules: rowCache.ts (memoized
 * rows), entrySections.ts (prose/table split), heights.ts (viewport
 * height summaries), and the per-kind renderers (proseEntry, blocks,
 * notices, plain).
 */
import { cachedRows, cachedRowData, cacheOf, noteMutation, tableOffsetsOf } from "./rowCache.ts";
import type { RowCache } from "./rowCache.ts";
export { cachedRowData, cachedRows, cacheOf, noteMutation, tableOffsetsOf, type RowCache };

export {
  heightSummaryOf,
  heightSummaryAnchored,
  cheapHeight,
  estimateHeight,
  anchorEntryForRow,
  totalRows,
  type HeightSummary,
} from "./heights.ts";
