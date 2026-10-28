/**
 * Special base for chat-log-style components: owns the entries collection,
 * scroll offset + follow mode, the focus ring over entries, per-entry
 * collapse/expand, and the memoized row cache. Subclasses (the main log
 * viewport, future split views, scratchpads) extend this instead of
 * re-implementing those mechanics.
 *
 * Row rendering is shared with the frame composer through `cachedRows` in
 * `ui/render/entry.ts` — the single memoization implementation in the codebase.
 */
import { BaseComponent, type RenderContext } from "./Component.ts";
import { FOCUS_NONE, moveFocus } from "../../core/focus.ts";
import { clampScroll, jump as jumpScroll, scrollBy as scrollByState } from "../../core/scroll.ts";
import { cachedRows, totalRows } from "../render/index.ts";
import { truncateAnsi } from "../../util/ansi.ts";
import type { LogEntry } from "../render/types.ts";

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

export abstract class ChatLogComponent extends BaseComponent {
  /** The log's entries (shared with the store in the current wiring). */
  protected entries: LogEntry[];
  /** First visible logical row index (clamped against the content). Public so
   *  the shared `core/scroll` helpers can operate on this as a `ScrollState`. */
  scrollOffset = 0;
  /** Follow mode pins the viewport to the bottom (same sharing as above). */
  follow = true;
  /** Focused entry index (`FOCUS_NONE` = none). */
  protected focusIndex: number = FOCUS_NONE;
  /** Display width in columns (last seen render width). */
  protected cols = 80;
  /** Layout-assigned viewport height; null = auto (full content height). */
  protected viewportRows: number | null = null;

  constructor(entries: LogEntry[] = []) {
    super(true);
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

  // -- scroll / follow -----------------------------------------------------

  /** Follow mode: viewport pinned to the bottom. */
  isFollowing(): boolean {
    return this.follow;
  }

  /** First visible row (clamped into the valid range before render). */
  getScrollOffset(): number {
    return this.scrollOffset;
  }

  /** Rows the content occupies at `cols` (incl. separators). */
  totalContentRows(cols: number = this.cols): number {
    return totalRows(this.entries, cols);
  }

  /** Maximum scroll offset for `viewportRows` visible rows. */
  maxScrollOffset(viewportRows: number, cols: number = this.cols): number {
    return Math.max(0, this.totalContentRows(cols) - Math.max(1, viewportRows));
  }

  /** Clamp the offset into range; in follow mode pin to the bottom first. */
  clampTo(viewportRows: number): void {
    clampScroll(this, this.maxScrollOffset(viewportRows));
  }

  /** Scroll by `delta` rows (positive = toward the bottom). */
  scrollBy(delta: number, viewportRows: number): void {
    scrollByState(this, delta, this.maxScrollOffset(viewportRows));
  }

  /** Jump to the top (stops follow) or the bottom (resumes it). */
  jump(top: boolean, viewportRows: number): void {
    jumpScroll(this, top);
    clampScroll(this, this.maxScrollOffset(viewportRows));
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
    this.focusIndex = moveFocus(this.entries, this.focusIndex, dir);
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
    } else {
      return false;
    }
    return true;
  }

  // -- layout --------------------------------------------------------------

  /** Assign the viewport height (rows available to this log). */
  setViewportRows(rows: number): void {
    this.viewportRows = Math.max(1, Math.floor(rows));
  }

  /** Effective viewport height: assigned by layout, else full content. */
  effectiveViewportRows(cols: number): number {
    return this.viewportRows ?? Math.max(1, this.totalContentRows(cols));
  }

  // -- rendering -----------------------------------------------------------

  /**
   * Rows visible at `ctx.cols`: entries intersecting the viewport, walked via
   * the shared memoized row cache (scrolling over a warm cache never
   * re-renders), padded to the full viewport height. The offset is clamped
   * first so a stale offset or a shrinking log can never overflow.
   */
  render(ctx: RenderContext): string[] {
    this.cols = Math.max(1, ctx.cols);
    const rows = this.effectiveViewportRows(this.cols);
    this.clampTo(rows);
    return this.renderViewport(this.cols, rows);
  }

  /** Build the visible viewport at `cols` for `rows` rows. */
  protected renderViewport(cols: number, rows: number): string[] {
    const offset = Math.max(0, this.scrollOffset);
    const visible: string[] = [];
    let base = 0; // first row of entries[i]
    let i = 0;
    const blockLen = (idx: number): number => {
      const entry = this.entries[idx] as LogEntry;
      return cachedRows(entry, cols, idx === this.focusIndex).length + 1;
    };
    while (i < this.entries.length && base + blockLen(i) <= offset) {
      base += blockLen(i);
      i += 1;
    }
    let pos = base; // first row of the entry being appended
    for (; i < this.entries.length && visible.length < rows; i += 1) {
      const entryRows = cachedRows(this.entries[i] as LogEntry, cols, i === this.focusIndex);
      const from = offset > pos ? Math.min(offset - pos, entryRows.length) : 0;
      for (let r = from; r < entryRows.length && visible.length < rows; r += 1) {
        visible.push(truncateAnsi(entryRows[r] as string, cols));
      }
      pos += entryRows.length + 1; // rows + separator
      if (pos > offset && visible.length < rows) visible.push("");
    }
    while (visible.length < rows) visible.push("");
    return visible;
  }

  /** Layout height: the assigned viewport height (or full content if unset). */
  measure(width: number): number {
    const cols = Math.max(1, Math.floor(width));
    return this.effectiveViewportRows(cols);
  }
}