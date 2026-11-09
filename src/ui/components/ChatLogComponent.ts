/**
 * Special base for chat-log-style components: owns the entries collection,
 * the focus ring over entries, per-entry collapse/expand, and the memoized
 * row cache. Subclasses (the main log viewport, future split views,
 * scratchpads) extend this instead of re-implementing those mechanics.
 *
 * Scroll state, clamping, follow mode, and viewport slicing/padding live in
 * the shared `ViewportComponent` base — this class adds entry-walking row
 * production on top.
 *
 * Row rendering is shared with the frame composer through `cachedRows` in
 * `ui/render/entry.ts` — the single memoization implementation in the codebase.
 */
import { ViewportComponent } from "./ViewportComponent.ts";
import { FOCUS_NONE_TARGET, type FocusTarget, moveFocus } from "../../core/focus.ts";
import { tableState, type LogEntry } from "../../core/entries.ts";
import {
  anchorEntryForRow,
  cachedRowData,
  cachedRows,
  focusUnits,
  heightSummaryAnchored,
  heightSummaryOf,
  noteMutation,
  tableOffsetsOf,
  totalRows,
} from "../render/index.ts";
import { resolveTableLayout, splitTableSections } from "../render/table/index.ts";
/** Index of the entry whose span contains terminal-row `row` (clamped). */
function entryAt(tops: readonly number[], row: number): number {
  let lo = 0;
  let hi = tops.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((tops[mid] as number) <= row) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Bounds of entry `i`: first row and full block height (incl. separator). */
function entryBounds(
  entries: LogEntry[],
  cols: number,
  index: number,
): { top: number; height: number } {
  const summary = heightSummaryOf(entries, cols);
  const top = summary.tops[index] ?? summary.total;
  const entry = entries[index];
  const height = entry === undefined ? 0 : cachedRows(entry, cols).length + 1;
  return { top, height };
}

/** First unit index whose entry starts at or after terminal-row `row`. */
function firstUnitAtOrAfter(
  units: readonly FocusTarget[],
  summary: ReturnType<typeof heightSummaryOf>,
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
  units: readonly FocusTarget[],
  summary: ReturnType<typeof heightSummaryOf>,
  cols: number,
  entries: LogEntry[],
  row: number,
): number {
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
function visibleFocusUnit(
  entries: LogEntry[],
  units: readonly FocusTarget[],
  cols: number,
  scrollOffset: number,
  rows: number,
  dir: 1 | -1,
): FocusTarget | undefined {
  if (units.length === 0) return undefined;
  scrollOffset = Math.max(0, scrollOffset);
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
  const prev = lastUnitEndingAtOrBefore(units, summary, cols, entries, windowBottom);
  return prev >= 0 ? units[prev] : units[0];
}

export abstract class ChatLogComponent extends ViewportComponent {
  /** The log's entries (shared with the store in the current wiring). */
  protected entries: LogEntry[];
  /** Focused table target (`{entry:-1, table:-1}` = none). */
  protected focusTarget: FocusTarget = FOCUS_NONE_TARGET;

  constructor(entries: LogEntry[] = []) {
    super();
    this.entries = entries;
  }

  // -- entries -------------------------------------------------------------

  /** Replace the entries collection (the store hands over a new array). */
  setEntries(entries: LogEntry[]): void {
    this.entries = entries;
    noteMutation();
  }

  /** Current entries collection (shared reference — do not reassign). */
  getEntries(): LogEntry[] {
    return this.entries;
  }

  /** Append one entry to the collection. */
  appendEntry(entry: LogEntry): void {
    this.entries.push(entry);
    noteMutation(entry);
  }

  // -- focus ring ----------------------------------------------------------

  /** Focused entry index (`-1` = none). Convenience view of the target. */
  getFocusIndex(): number {
    return this.focusTarget.entry;
  }

  /** Focused table index within the focused entry (`-1` = entry-level). */
  getFocusTable(): number {
    return this.focusTarget.table;
  }

  /** Is anything focused? */
  hasFocus(): boolean {
    return this.focusTarget.entry >= 0;
  }

  /** Focus the given target directly (no ring movement, no reveal). */
  setFocus(target: FocusTarget): void {
    this.focusTarget = target;
  }

  /** Drop focus entirely (leaves focus mode). */
  clearFocus(): void {
    this.focusTarget = FOCUS_NONE_TARGET;
  }

  /**
   * Focus the next/previous focusable unit (wrap-through-none ring: past
   * the last lands on none, and the next press re-enters from that end).
   * The ring is a flat list of targets — tables inside one entry are
   * independently focusable, so Tab walks through them before moving on.
   *
   * When nothing is focused, the entry point is viewport-aware: the first
   * (dir=1) or last (dir=-1) unit at least partially visible in the
   * current window; the next-closest unit when the window holds none.
   */
  moveFocus(dir: 1 | -1, viewportRows: number = this.effectiveViewportRows(this.cols)): void {
    const units = focusUnits(this.entries);
    const enterAt =
      this.focusTarget.entry < 0
        ? visibleFocusUnit(this.entries, units, this.cols, this.scrollOffset, viewportRows, dir)
        : undefined;
    this.focusTarget = moveFocus(units, this.focusTarget, dir, enterAt);
  }

  /**
   * Keep the whole focused entry inside the viewport: above → align its top;
   * below → bottom-align short entries, top-align tall ones (an entry taller
   * than the viewport must never be scrolled at from its middle).
   */
  revealFocus(viewportRows: number): void {
    const entry = this.focusTarget.entry;
    if (entry < 0 || entry >= this.entries.length) return;
    const rows = Math.max(1, viewportRows);
    const { top, height } = entryBounds(this.entries, this.cols, entry);

    // When a table inside the entry is focused (not the entry itself),
    // scroll the TABLE into view — not just the entry. An entry can be
    // taller than the viewport with the table at the bottom, and scrolling
    // only the entry top leaves the table off-screen. Every rendered row is
    // one terminal row, so a table's row offset is its terminal offset.
    if (this.focusTarget.table >= 0) {
      const offsets = tableOffsetsOf(this.entries[entry] as LogEntry);
      if (offsets !== undefined && this.focusTarget.table < offsets.length) {
        const toTerm = (logIdx: number): number => logIdx;
        const tableTop = top + toTerm(offsets[this.focusTarget.table] ?? 0);
        const tableHeight = Math.max(
          1,
          toTerm(
            offsets[this.focusTarget.table + 1] ??
              cachedRows(this.entries[entry] as LogEntry, this.cols).length,
          ) - toTerm(offsets[this.focusTarget.table] ?? 0),
        );
        if (tableTop < this.scrollOffset) {
          this.follow = false;
          this.scrollOffset = tableTop;
        } else if (tableTop + tableHeight > this.scrollOffset + rows) {
          this.follow = false;
          this.scrollOffset = Math.min(tableTop, tableTop + tableHeight - rows);
        }
        return;
      }
    }

    // Entry-level focus (no table): scroll the whole entry into view.
    if (top < this.scrollOffset) {
      this.follow = false;
      this.scrollOffset = top;
    } else if (top + height > this.scrollOffset + rows) {
      this.follow = false;
      this.scrollOffset = Math.min(top, top + height - rows);
    }
  }

  // -- collapse / expand ---------------------------------------------------

  /**
   * Toggle the focused unit: a chunk collapses/expands, a tool call
   * expands/collapses its args, a table switches between its collapsed and
   * expanded layouts. False when the focused unit has nothing to toggle.
   *
   * A table's state is per-table, so expanding one table in an entry
   * leaves the entry's other tables untouched.
   */
  toggleFocused(): boolean {
    const entry = this.entries[this.focusTarget.entry];
    if (entry === undefined) return false;
    if (entry.kind === "chunk" || entry.kind === "debug") {
      entry.collapsed = !entry.collapsed;
      noteMutation(entry);
      return true;
    }
    if (entry.kind === "tool" || entry.kind === "toolResult") {
      entry.expanded = !entry.expanded;
      noteMutation(entry);
      return true;
    }
    if ((entry.kind === "user" || entry.kind === "assistant") && this.focusTarget.table >= 0) {
      const table = this.focusTarget.table;
      const sections = splitTableSections(entry.lines.join("\n"));
      const tables = sections.filter((s) => s.kind === "table");
      const section = tables[table];
      if (section === undefined || section.kind !== "table") return false;
      const bodyW = Math.max(1, this.cols - 2);
      const natural = section.table.columns.map((c) => c.width);
      const state = tableState(entry, table);
      const layout = resolveTableLayout(natural, bodyW, state.expanded === true);
      if (!layout.expandable) return false; // nothing to toggle
      state.expanded = !state.expanded;
      if (state.expanded !== true) state.scrollX = 0; // collapsing resets the scroll
      noteMutation(entry);
      return true;
    }
    return false;
  }

  // -- rendering -----------------------------------------------------------

  /**
   * Produce all content rows at `cols`: entries walked via the shared
   * memoized row cache, with a blank separator after each entry. The base
   * viewport clamps, slices, and pads — entry-walking here means scrolling
   * over a warm cache never re-renders. Focus is per-table: only the focused
   * table renders blue; every other table in the entry renders white.
   */
  override produceRows(cols: number): string[] {
    const rows: string[] = [];
    const focusedEntry = this.focusTarget.entry;
    const focusedTable = this.focusTarget.table;
    for (let i = 0; i < this.entries.length; i++) {
      const isEntryFocused = i === focusedEntry;
      const entryRows = cachedRows(
        this.entries[i] as LogEntry,
        cols,
        isEntryFocused,
        isEntryFocused ? focusedTable : -1,
      );
      rows.push(...entryRows);
      rows.push(""); // separator after each entry
    }
    return rows;
  }
  /**
   * Efficient window producer: renders only the entries intersecting
   * [top, bottom) instead of the whole log. Locates the first entry via the
   * cached height summary (binary search), then walks forward with per-entry
   * cached rows — visible-only rendering regardless of log size.
   */
  /**
   * Anchor-outward window producer (#67): the entry closest to the top of
   * the viewport renders first. The anchor is the entry containing `top`
   * (follow mode anchors on the last entry — the chunk the user actually
   * sees), heights are filled outward from there (up and down
   * simultaneously), and the walk proceeds downward from the window's
   * first entry. Placeholder entries take the cheap exact height, so a
   * placeholder-first log pays glamour only for the window, not the head.
   */
  override produceVisible(
    top: number,
    bottom: number,
    cols: number,
  ): { lines: string[]; top: number } {
    const entries = this.entries;
    if (entries.length === 0) return { lines: [], top: 0 };
    const anchor = this.follow ? entries.length - 1 : anchorEntryForRow(entries, cols, top);
    const summary = heightSummaryAnchored(entries, cols, anchor);
    if (top >= summary.total) return { lines: [], top: summary.total };
    const start = entryAt(summary.tops, top);
    const end = Math.min(entries.length - 1, entryAt(summary.tops, Math.max(0, bottom - 1)));
    const focusedEntry = this.focusTarget.entry;
    const focusedTable = this.focusTarget.table;
    const lines: string[] = [];
    for (let i = start; i <= end; i++) {
      const isEntryFocused = i === focusedEntry;
      const cache = cachedRowData(
        entries[i] as LogEntry,
        cols,
        isEntryFocused,
        isEntryFocused ? focusedTable : -1,
      );
      lines.push(...cache.rows);
      lines.push(""); // separator after each entry
    }
    return { lines, top: summary.tops[start] as number };
  }

  /** Rows the content occupies at `cols` (incl. separators). Exact. */
  override totalContentRows(cols: number = this.cols): number {
    return totalRows(this.entries, cols);
  }
}
