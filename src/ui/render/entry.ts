/**
 * Entry rendering: the focus ring's view of the entries (focusUnits) plus
 * the re-exports of the memoized row cache and the height summaries the
 * components consume.
 *
 * The implementation lives in its sibling modules: rowCache.ts (memoized
 * rows), entrySections.ts (prose/table split), heights.ts (viewport
 * height summaries), and the per-kind renderers (proseEntry, blocks,
 * notices, plain).
 */
import type { EntryKind, LogEntry } from "../../core/entries.ts";
import type { FocusTarget } from "../../core/focus.ts";
import { sectionsOf } from "./entrySections.ts";
import { cachedRows, cachedRowData, cacheOf, noteMutation, tableOffsetsOf } from "./rowCache.ts";
import type { RowCache } from "./rowCache.ts";

/** Entry kinds that contribute a focus target of their own (not counting
 *  the tables inside a prose entry — those walk after the entry unit). */
const FOCUSABLE_KINDS: ReadonlySet<EntryKind> = new Set([
  "chunk",
  "tool",
  "toolResult",
  "debug",
  "user",
  "assistant",
]);

/**
 * The focusable units of the given entries, in document order.
 *
 * A chunk, tool, user, or assistant entry contributes one unit
 * (`{entry, table: -1}`); a prose entry with N tables contributes N table
 * units (`{entry, table: 0..N-1}`) IN ADDITION to the entry itself. The
 * entry unit comes first, then its tables — Tab walks a prose entry's
 * tables after selecting the entry, mirroring the document order.
 *
 * The units come from the same sections the renderer draws, so every table
 * that renders is a table that can be focused.
 */
export function focusUnits(entries: readonly LogEntry[]): FocusTarget[] {
  const units: FocusTarget[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] as LogEntry;
    if (FOCUSABLE_KINDS.has(entry.kind)) units.push({ entry: i, table: -1 });
    let table = 0;
    for (const section of sectionsOf(entry)) {
      if (section.kind === "table") {
        units.push({ entry: i, table });
        table += 1;
      }
    }
  }
  return units;
}

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
