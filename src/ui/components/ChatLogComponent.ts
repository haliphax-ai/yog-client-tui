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
import { FOCUS_NONE, isProseTable, moveFocus } from "../../core/focus.ts";
import { cachedRows, totalRows } from "../render/index.ts";
import { parseTable } from "../render/table.ts";
import type { LogEntry } from "../render/types.ts";

/** Table predicate bound to the GFM parser (one wiring point for the ring). */
const hasTable = (e: { kind: string; lines?: readonly string[] }): boolean =>
  isProseTable(e, (text) => parseTable(text));

/** Bounds of entry `i`: first row and full block height (incl. separator). */
function entryBounds(
  entries: LogEntry[],
  cols: number,
  index: number,
): { top: number; height: number } {
  const top = totalRows(entries.slice(0, index), cols);
  const entry = entries[index];
  const height = entry === undefined ? 0 : cachedRows(entry, cols).length + 1;
  return { top, height };
}

export abstract class ChatLogComponent extends ViewportComponent {
  /** The log's entries (shared with the store in the current wiring). */
  protected entries: LogEntry[];
  /** Focused entry index (`FOCUS_NONE` = none). */
  protected focusIndex: number = FOCUS_NONE;

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

  /** Focused entry index (`FOCUS_NONE` = none). */
  getFocusIndex(): number {
    return this.focusIndex;
  }

  /** Focus the given entry directly (no ring movement, no reveal). */
  setFocus(index: number): void {
    this.focusIndex = index;
  }

  /** Drop focus entirely (leaves focus mode). */
  clearFocus(): void {
    this.focusIndex = FOCUS_NONE;
  }

  /**
   * Focus the next/previous focusable entry (wrap-through-none ring: past
   * the last entry lands on none, and the next press re-enters from that end).
   */
  moveFocus(dir: 1 | -1): void {
    this.focusIndex = moveFocus(this.entries, this.focusIndex, dir, hasTable);
  }

  /**
   * Keep the whole focused entry inside the viewport: above → align its top;
   * below → bottom-align short entries, top-align tall ones (an entry taller
   * than the viewport must never be scrolled at from its middle).
   */
  revealFocus(viewportRows: number): void {
    if (this.focusIndex < 0 || this.focusIndex >= this.entries.length) return;
    const rows = Math.max(1, viewportRows);
    const { top, height } = entryBounds(this.entries, this.cols, this.focusIndex);
    if (top < this.scrollOffset) {
      this.follow = false;
      this.scrollOffset = top;
    } else if (top + height > this.scrollOffset + rows) {
      this.follow = false;
      this.scrollOffset = Math.min(top, top + height - rows);
    }
  }

  // -- collapse / expand ---------------------------------------------------

  /** Toggle the focused entry's collapse/expand; false when nothing is focused. */
  toggleFocused(): boolean {
    const entry = this.entries[this.focusIndex];
    if (entry === undefined) return false;
    if (entry.kind === "chunk") {
      entry.collapsed = !entry.collapsed;
    } else if (entry.kind === "tool") {
      entry.expanded = !entry.expanded;
    } else if ((entry.kind === "user" || entry.kind === "assistant") && hasTable(entry)) {
      // Prose carrying a table: Enter toggles horizontal expansion. A table
      // with nothing reflowed renders identically expanded — harmless.
      entry.tableExpanded = !entry.tableExpanded;
      if (!entry.tableExpanded) entry.tableScrollX = 0; // unexpanded resets scroll
    } else {
      return false;
    }
    return true;
  }

  // -- rendering -----------------------------------------------------------

  /**
   * Produce all content rows at `cols`: entries walked via the shared
   * memoized row cache, with a blank separator after each entry. The base
   * viewport clamps, slices, and pads — entry-walking here means scrolling
   * over a warm cache never re-renders.
   */
  override produceRows(cols: number): string[] {
    const rows: string[] = [];
    for (let i = 0; i < this.entries.length; i++) {
      const entryRows = cachedRows(this.entries[i] as LogEntry, cols, i === this.focusIndex);
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
