/**
 * Generic scrollable viewport: owns scroll state and presents content rows.
 *
 * Subclasses implement `produceRows` to supply the full content — the
 * viewport doesn't care whether those rows come from chat entries, a
 * table, or anything else. It clamps the offset, slices the visible window,
 * and pads to the assigned height.
 *
 * Rows are LOGICAL lines: a row may be longer than the terminal width
 * (soft-wrapped prose/code/tool output) and occupy several visual rows.
 * Scroll offsets are measured in TERMINAL rows; slicing therefore converts
 * logical rows to visual segments and cuts partial lines at the edges, the
 * way a terminal screen does. Both axes are supported: `scrollOffset` for
 * vertical, `scrollX` for horizontal. The viewport only slices vertically;
 * horizontal scroll is applied by the content producer (e.g. `renderTable`
 * takes `scrollX`).
 */
import { BaseComponent, type RenderContext } from "./Component.ts";
import { clampScroll, jump as jumpScroll, scrollBy as scrollByState } from "../../core/scroll.ts";
import { displayWidth, lineHeight, skipAnsi, truncateAnsi } from "../../util/ansi.ts";

export abstract class ViewportComponent extends BaseComponent {
  /** First visible row (clamped into range before render). */
  scrollOffset = 0;
  /** Horizontal scroll offset (in cells); applied by `produceRows`. */
  scrollX = 0;
  /** Follow mode: viewport pinned to the bottom. */
  follow = true;
  /** Display width in columns (last seen render width). */
  protected cols = 80;
  /** Layout-assigned viewport height; null = auto (full content height). */
  protected viewportRows: number | null = null;

  constructor() {
    super(true);
  }

  /** Produce all content rows at `cols` (before viewport slicing). */
  abstract produceRows(cols: number): string[];

  /** First visible row (clamped into range before render). */
  getScrollOffset(): number {
    return this.scrollOffset;
  }

  /** Follow mode: viewport pinned to the bottom. */
  isFollowing(): boolean {
    return this.follow;
  }

  /** Total rendered width of the content (for horizontal scroll bounds). */
  totalWidth(): number {
    return this.cols;
  }

  /** Total TERMINAL rows the content occupies at `cols`. */
  totalContentRows(cols: number = this.cols): number {
    let rows = 0;
    for (const row of this.produceRows(cols)) rows += lineHeight(row, cols);
    return rows;
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

  /** Assign the viewport height (rows available to this log). */
  setViewportRows(rows: number): void {
    this.viewportRows = Math.max(1, Math.floor(rows));
  }

  /** Effective viewport height: assigned by layout, else full content. */
  effectiveViewportRows(cols: number): number {
    return this.viewportRows ?? Math.max(1, this.totalContentRows(cols));
  }

  /** Layout height: the assigned viewport height (or full content if unset). */
  measure(width: number): number {
    const cols = Math.max(1, Math.floor(width));
    return this.effectiveViewportRows(cols);
  }

  /** Rows visible at `cols`: produce all content, slice, pad. */
  render(ctx: RenderContext): string[] {
    this.cols = Math.max(1, ctx.cols);
    const rows = this.effectiveViewportRows(this.cols);
    this.clampTo(rows);
    return this.renderViewport(this.cols, rows);
  }

  /** Slice the visible terminal rows from `produceRows`, cutting partial
   *  lines at the top/bottom edges, and pad to the assigned height. */
  protected renderViewport(cols: number, rows: number): string[] {
    const allRows = this.produceRows(cols);
    const heights = allRows.map((line) => lineHeight(line, cols));
    let offset = Math.max(0, this.scrollOffset);

    // Walk to the logical line containing the scroll offset.
    let i = 0;
    while (i < allRows.length && offset >= heights[i]!) {
      offset -= heights[i]!;
      i += 1;
    }

    const visible: string[] = [];
    let used = 0;
    let first = true;

    while (used < rows && i < allRows.length) {
      const line = allRows[i] as string;
      const height = heights[i] as number;
      const remaining = rows - used;

      if (first && offset > 0) {
        // Top edge cuts through this line: show its tail.
        const cut = offset * cols;
        if (cut >= displayWidth(line)) {
          offset -= height; // remainder lies above the viewport
          i += 1;
          continue;
        }
        const seg = skipAnsi(line, cut);
        const segHeight = lineHeight(seg, cols);
        if (segHeight > remaining) {
          visible.push(truncateAnsi(seg, remaining * cols));
          used += remaining;
        } else {
          visible.push(seg);
          used += segHeight;
        }
        first = false;
        i += 1;
        continue;
      }

      if (height <= remaining) {
        visible.push(line);
        used += height;
        i += 1;
        continue;
      }
      // Bottom edge cuts through this line: show its prefix only.
      visible.push(truncateAnsi(line, remaining * cols));
      used = rows;
    }

    while (used < rows) {
      visible.push("");
      used += 1;
    }
    return visible;
  }
}