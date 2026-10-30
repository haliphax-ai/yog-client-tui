/**
 * Generic scrollable viewport: owns scroll state and presents content rows.
 *
 * Subclasses implement `produceRows` to supply the full content — the
 * viewport doesn't care whether those rows come from chat entries, a
 * table, or anything else. It clamps the offset, slices the visible window,
 * and pads to the assigned height.
 *
 * Both axes are supported: `scrollOffset` for vertical, `scrollX` for
 * horizontal. The viewport only slices vertically; horizontal scroll is
 * applied by the content producer (e.g. `renderTable` takes `scrollX`).
 */
import { BaseComponent, type RenderContext } from "./Component.ts";
import { clampScroll, jump as jumpScroll, scrollBy as scrollByState } from "../../core/scroll.ts";
import { truncateAnsi } from "../../util/ansi.ts";

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

  /** Rows the content occupies at `cols`. */
  totalContentRows(cols: number = this.cols): number {
    return this.produceRows(cols).length;
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

  /** Slice the visible window from `produceRows` and pad to `rows`. */
  protected renderViewport(cols: number, rows: number): string[] {
    const allRows = this.produceRows(cols);
    const offset = Math.max(0, this.scrollOffset);
    const visible: string[] = [];
    for (let i = offset; i < allRows.length && visible.length < rows; i++) {
      visible.push(truncateAnsi(allRows[i] ?? "", cols));
    }
    while (visible.length < rows) visible.push("");
    return visible;
  }
}