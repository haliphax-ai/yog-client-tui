/**
 * Toast: a transient one-row drawer child.
 *
 * `show(message)` pins the message for 3 seconds, then the component
 * collapses back to zero rows (the drawer disappears with it). The
 * message word-wraps to the drawer's interior width — a long item id
 * wraps into more rows, never truncates (the drawer truncates per row,
 * so the component must pre-wrap). One message at a time — a new `show`
 * replaces the text and restarts the timer — and `hide()` drops it
 * immediately (not needed by the copy feature, but it keeps the
 * component honest for future producers).
 *
 * Self-contained like the spinner: it knows nothing about the drawer it
 * is drawn in; the composition root registers it and pokes the render
 * scheduler (the timer's expiry `setState({})` redraws without it).
 */
import { BaseComponent, type RenderContext } from "./Component.ts";
import { getState, setState } from "../../core/store.ts";
import { wrapText } from "../../util/ansi.ts";
import { ST } from "../theme.ts";

/** How long a toast stays visible. */
const TOAST_MS = 3000;

export class ToastComponent extends BaseComponent {
  /** The visible message ("" = hidden). */
  private message = "";
  /** The expiry timer. */
  private timer: NodeJS.Timeout | undefined;

  constructor() {
    super(false);
  }

  /** Show the message for 3 seconds (replaces any visible toast). */
  show(message: string): void {
    this.message = message;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.message = "";
      setState({}); // redraw: the drawer collapses
    }, TOAST_MS);
  }

  /** Hide the toast immediately. */
  hide(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.message = "";
  }

  /**
   * The visible toast, WORD-WRAPPED to the drawer's interior width —
   * a long item id must wrap into more rows, never truncate (the
   * drawer truncates per row, so the component must pre-wrap). Zero
   * rows while hidden.
   */
  override render(ctx: RenderContext): string[] {
    if (this.message === "" || !getState()) return [];
    return wrapText(this.message, Math.max(1, ctx.cols - 2)).map((row) =>
      ST.noticeSystem.render(row),
    );
  }
}
