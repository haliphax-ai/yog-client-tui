/**
 * Focus-ring entry geometry for chat-log components: which focusable unit
 * the ring enters at when nothing is focused, picked from what is visible
 * in the viewport window.
 *
 * All helpers run on the cached height summary (`heightSummaryOf`) — the
 * same tops array the viewport slicing uses — so entry tops are strictly
 * increasing and every window lookup below is a binary search rather than
 * a scan.
 */
import type { FocusTarget } from "../../core/focus.ts";
import type { LogEntry } from "../../core/entries.ts";
import { cachedRows, heightSummaryOf, type HeightSummary } from "../render/index.ts";
import { resolveTableLayout, splitTableSections } from "../render/table/index.ts";
import { tableState } from "../../core/entries.ts";

/** Bounds of entry `i`: first terminal row and full block height (incl.
 *  separator). Heights come from the memoized row cache. */
export interface EntryBounds {
  top: number;
  height: number;
}

/** Bounds of entry `i`: first row and full block height (incl. separator). */
export function entryBounds(entries: LogEntry[], cols: number, index: number): EntryBounds {
  const summary = heightSummaryOf(entries, cols);
  const top = summary.tops[index] ?? summary.total;
  const entry = entries[index];
  const height = entry === undefined ? 0 : cachedRows(entry, cols).length + 1;
  return { top, height };
}

/** Index of the entry whose span contains terminal-row `row` (clamped). */
export function entryAt(tops: readonly number[], row: number): number {
  let lo = 0;
  let hi = tops.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((tops[mid] as number) <= row) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** First unit index whose entry starts at or after terminal-row `row`. */
function firstUnitAtOrAfter(
  units: readonly FocusTarget[],
  summary: HeightSummary,
  row: number,
): number {
  let lo = 0;
  let hi = units.length - 1;
  let found = units.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const top = summary.tops[(units[mid] as FocusTarget).entry] ?? summary.total;
    if (top >= row) {
      found = mid;
      hi = mid - 1;
    } else lo = mid + 1;
  }
  return found;
}

/** Last unit index whose entry ends at or before terminal-row `row`. */
function lastUnitEndingAtOrBefore(
  window: FocusWindow,
  units: readonly FocusTarget[],
  summary: HeightSummary,
  row: number,
): number {
  const { cols, entries } = window;
  let lo = 0;
  let hi = units.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const { top, height } = entryBounds(entries, cols, (units[mid] as FocusTarget).entry);
    if (top + height <= row) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/**
 * The viewport window the entry point is picked from: the log's entries and
 * the geometry of the visible slice (width, scroll offset, row count).
 */
export interface FocusWindow {
  readonly entries: LogEntry[];
  readonly cols: number;
  readonly scrollOffset: number;
  readonly rows: number;
}

/**
 * The unit to enter the focus ring at when nothing is focused, picked from
 * what is visible: the first (dir=1) or last (dir=-1) focusable unit whose
 * entry is AT LEAST PARTIALLY visible in the [offset, offset + rows) window.
 * When nothing is visible, the next-closest unit wins: the first unit at or
 * after the window for Tab, the last at or before it for Shift+Tab. A
 * viewport holding a single unit resolves to it from both directions.
 * Returns undefined when the log has no focusable units.
 *
 * Entry tops from the cached height summary are strictly increasing, so
 * the visible span and both fallbacks are bisected rather than scanned.
 */
export function visibleFocusUnit(
  window: FocusWindow,
  units: readonly FocusTarget[],
  dir: 1 | -1,
): FocusTarget | undefined {
  if (units.length === 0) return undefined;
  const { entries, cols, rows } = window;
  const scrollOffset = Math.max(0, window.scrollOffset);
  const windowBottom = scrollOffset + Math.max(1, rows);
  const summary = heightSummaryOf(entries, cols);
  if (summary.total === 0) return dir === 1 ? units[0] : units[units.length - 1];

  const topEntry = entryAt(summary.tops, scrollOffset);
  const bottomEntry = entryAt(summary.tops, Math.max(0, windowBottom - 1));
  const firstVisibleEntry = Math.min(topEntry, entries.length - 1);
  const lastVisibleEntry = Math.min(bottomEntry, entries.length - 1);

  const firstUnit = firstUnitAtOrAfter(units, summary, summary.tops[firstVisibleEntry] ?? 0);
  let lastUnit = units.length - 1;
  while (lastUnit >= 0 && (units[lastUnit] as FocusTarget).entry > lastVisibleEntry) lastUnit -= 1;

  if (firstUnit <= lastUnit && lastUnit >= 0 && firstUnit < units.length) {
    return dir === 1 ? units[firstUnit] : units[lastUnit];
  }

  if (dir === 1) {
    const next = firstUnitAtOrAfter(units, summary, scrollOffset);
    return next < units.length ? units[next] : units[units.length - 1];
  }
  const prev = lastUnitEndingAtOrBefore(window, units, summary, windowBottom);
  return prev >= 0 ? units[prev] : units[0];
}

/** True when the entry kind folds/unfolds a single boolean: chat chunks and
 *  debug notes collapse, tool calls and tool results expand their args. */
function flipsBooleanState(entry: LogEntry): boolean {
  return (
    entry.kind === "chunk" ||
    entry.kind === "debug" ||
    entry.kind === "tool" ||
    entry.kind === "toolResult"
  );
}

/** Flip the boolean fold of a chunk/debug/tool entry; true when it applied. */
function flipBooleanState(entry: LogEntry): boolean {
  if (entry.kind === "chunk" || entry.kind === "debug") entry.collapsed = !entry.collapsed;
  else entry.expanded = !entry.expanded;
  return true;
}

/**
 * Toggle the table at `tableIndex` inside a user/assistant entry between
 * its collapsed and expanded layouts: false when the index names no table,
 * or the layout has nothing to toggle. Collapsing resets the horizontal
 * scroll; expanding keeps it.
 */
function toggleTableLayout(entry: LogEntry, tableIndex: number, cols: number): boolean {
  const sections = splitTableSections(entry.lines.join("\n"));
  const tables = sections.filter((section) => section.kind === "table");
  const section = tables[tableIndex];
  if (section === undefined || section.kind !== "table") return false;
  const bodyW = Math.max(1, cols - 2);
  const natural = section.table.columns.map((column) => column.width);
  const state = tableState(entry, tableIndex);
  const layout = resolveTableLayout(natural, bodyW, state.expanded === true);
  if (!layout.expandable) return false; // nothing to toggle
  state.expanded = !state.expanded;
  if (state.expanded !== true) state.scrollX = 0; // collapsing resets the scroll
  return true;
}

/**
 * Toggle the focusable unit of `entry` at `tableIndex` (`-1` = entry
 * level): a chunk's collapse, a tool call's args expansion, or a table's
 * layout switch. False when the unit has nothing to toggle. The caller
 * records the mutation when this returns true.
 */
export function toggleEntry(entry: LogEntry, tableIndex: number, cols: number): boolean {
  if (flipsBooleanState(entry)) return flipBooleanState(entry);
  if ((entry.kind === "user" || entry.kind === "assistant") && tableIndex >= 0) {
    return toggleTableLayout(entry, tableIndex, cols);
  }
  return false;
}
