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
import { cachedRows, focusUnits, tableOffsetsOf, totalRows } from "../render/index.ts";
import { resolveTableLayout, splitTableSections } from "../render/table/index.ts";
import { lineHeight } from "../../util/ansi.ts";

/** Bounds of entry `i`: first row and full block height (incl. separator). */
function entryBounds(
  entries: LogEntry[],
  cols: number,
  index: number,
): { top: number; height: number } {
  const top = totalRows(entries.slice(0, index), cols);
  const entry = entries[index];
  const height =
    entry === undefined ? 0 : cachedRows(entry, cols).reduce((acc, row) => acc + lineHeight(row, cols), 0) + 1;
  return { top, height };
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
  }

  /** Current entries collection (shared reference — do not reassign). */
  getEntries(): LogEntry[] {
    return this.entries;
  }

  /** Append one entry to the collection. */
  appendEntry(entry: LogEntry): void {
    this.entries.push(entry);
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
   */
  moveFocus(dir: 1 | -1): void {
    this.focusTarget = moveFocus(focusUnits(this.entries), this.focusTarget, dir);
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
    // only the entry top leaves the table off-screen.
    if (this.focusTarget.table >= 0) {
      const offsets = tableOffsetsOf(this.entries[entry] as LogEntry);
      if (offsets !== undefined && this.focusTarget.table < offsets.length) {
        const entryRows = cachedRows(this.entries[entry] as LogEntry, this.cols);
        const toTerm = (logIdx: number): number =>
          entryRows.slice(0, logIdx).reduce((acc, row) => acc + lineHeight(row, this.cols), 0);
        const tableTop = top + toTerm(offsets[this.focusTarget.table] ?? 0);
        const tableHeight = Math.max(
          1,
          toTerm(offsets[this.focusTarget.table + 1] ?? entryRows.length) -
            toTerm(offsets[this.focusTarget.table] ?? 0),
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
    if (entry.kind === "chunk") {
      entry.collapsed = !entry.collapsed;
      return true;
    }
    if (entry.kind === "tool") {
      entry.expanded = !entry.expanded;
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

  /** Rows the content occupies at `cols` (incl. separators). */
  override totalContentRows(cols: number = this.cols): number {
    return totalRows(this.entries, cols);
  }
}
