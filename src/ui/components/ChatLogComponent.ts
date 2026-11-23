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
import { FOCUS_NONE_TARGET, type FocusTarget, moveFocus } from "../../core/index.ts";
import type { LogEntry } from "../../core/index.ts";
import { anchorEntryForRow, cachedRowData, cachedRows, noteMutation } from "../render/index.ts";
import { heightSummaryAnchored, tableOffsetsOf, totalRows } from "../render/index.ts";
import { focusUnits } from "../focus.ts";
import { entryAt, entryBounds, toggleEntry, visibleFocusUnit } from "./logFocus.ts";

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
        ? visibleFocusUnit(
            {
              entries: this.entries,
              cols: this.cols,
              scrollOffset: this.scrollOffset,
              rows: viewportRows,
            },
            units,
            dir,
          )
        : undefined;
    this.focusTarget = moveFocus(units, this.focusTarget, dir, enterAt);
  }

  /**
   * Scroll the entry (or the focused table inside it) fully into view:
   * above → align its top; below → bottom-align short blocks, top-align
   * tall ones (a block taller than the viewport must never be scrolled
   * at from its middle). `follow` breaks when the clamp moves anything.
   */
  private scrollBlockIntoView(top: number, height: number): void {
    const rows = Math.max(1, this.effectiveViewportRows(this.cols));
    if (top < this.scrollOffset) {
      this.follow = false;
      this.scrollOffset = top;
    } else if (top + height > this.scrollOffset + rows) {
      this.follow = false;
      this.scrollOffset = Math.min(top, top + height - rows);
    }
  }

  /**
   * Keep the focused unit inside the viewport: the focused table when one
   * is selected, otherwise the whole entry. Delegates to the shared
   * scroll-block clamp; `follow` breaks when the clamp moves anything.
   */
  revealFocus(): void {
    const entry = this.focusTarget.entry;
    if (entry < 0 || entry >= this.entries.length) return;
    const { top, height } = entryBounds(this.entries, this.cols, entry);

    // When a table inside the entry is focused (not the entry itself),
    // scroll the TABLE into view — not just the entry. An entry can be
    // taller than the viewport with the table at the bottom, and scrolling
    // only the entry top leaves the table off-screen. Every rendered row is
    // one terminal row, so a table's row offset is its terminal offset.
    if (this.focusTarget.table >= 0) {
      const offsets = tableOffsetsOf(this.entries[entry] as LogEntry);
      if (offsets !== undefined && this.focusTarget.table < offsets.length) {
        const tableOffset = offsets[this.focusTarget.table] ?? 0;
        const nextOffset = offsets[this.focusTarget.table + 1];
        const tableTop = top + tableOffset;
        const tableHeight = Math.max(
          1,
          (nextOffset ?? cachedRows(this.entries[entry] as LogEntry, this.cols).length) -
            tableOffset,
        );
        this.scrollBlockIntoView(tableTop, tableHeight);
        return;
      }
    }

    // Entry-level focus (no table): scroll the whole entry into view.
    this.scrollBlockIntoView(top, height);
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
    const toggled = toggleEntry(entry, this.focusTarget.table, this.cols);
    if (toggled) noteMutation(entry);
    return toggled;
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
