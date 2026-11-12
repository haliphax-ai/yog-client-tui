/**
 * Toasts: transient drawer children, stacked, each with its own timer.
 *
 * `show(message)` appends a toast; it stays visible for 3 seconds, then
 * is removed while older/newer toasts remain — back-to-back copy/output
 * actions render in chronological order, one line per toast. Each
 * message word-wraps to the drawer's interior width (the drawer
 * truncates per row, so the component must pre-wrap).
 *
 * Self-contained like the spinner: it knows nothing about the drawer it
 * is drawn in; the composition root registers it and the timers'
 * expiries `setState({})` redraw without it.
 */
import { BaseComponent, type RenderContext } from "./Component.ts";
import { setState } from "../../core/store.ts";
import { wrapText } from "../../util/ansi.ts";
import { ST } from "../theme.ts";

/** How long one toast stays visible. */
const TOAST_MS = 3000;

/** One visible toast: its message and expiry timer. */
interface Toast {
  message: string;
  timer: NodeJS.Timeout;
}

export class ToastComponent extends BaseComponent {
  /** Visible toasts, oldest first. */
  private toasts: Toast[] = [];

  constructor() {
    super(false);
  }

  /** Add a toast; it disappears on its own after 3 seconds. */
  show(message: string): void {
    const toast: Toast = {
      message,
      timer: setTimeout(() => this.expire(toast), TOAST_MS),
    };
    this.toasts.push(toast);
    setState({}); // redraw: the drawer grows by the new toast
  }

  /** Remove one expired toast (the callback owns the timer handle). */
  private expire(toast: Toast): void {
    this.toasts = this.toasts.filter((t) => t !== toast);
    setState({}); // redraw: the drawer collapses by the expired toast
  }

  /** Hide every toast immediately. */
  hide(): void {
    for (const toast of this.toasts) clearTimeout(toast.timer);
    this.toasts = [];
  }

  /**
   * Every visible toast, oldest first, each WORD-WRAPPED to the
   * drawer's interior width. Zero rows while none are visible.
   */
  override render(ctx: RenderContext): string[] {
    if (this.toasts.length === 0) return [];
    return this.toasts.flatMap((toast) =>
      wrapText(toast.message, Math.max(1, ctx.cols - 2)).map((row) => ST.noticeSystem.render(row)),
    );
  }
}
