/**
 * Base component contract: rendering, key dispatch, focus, measurement, and
 * lifecycle. Components are terminal-free — they return rows (or a whole
 * frame string) and leave composition/writing to the render layer.
 *
 * Key dispatch is pull-based: the router offers a sequence to the focused
 * component first; "handled" stops the walk, "unhandled" bubbles to the next
 * responder (global bindings last).
 */

/** What `render()` returns: rows, or one styled frame string. */
export type RenderResult = string | string[];

/** Shared context for one `render()` call. */
export interface RenderContext {
  /** Available width in columns. */
  cols: number;
}

/** Dispatch outcome — handled stops propagation, unhandled bubbles up. */
export type KeyResult = "handled" | "unhandled";

/** The contract every UI component implements. */
export interface Component {
  /** True when the component takes part in the focus cycle. */
  readonly focusable: boolean;
  /** True while this component holds focus in the ring. */
  readonly isFocused: boolean;
  /** Produce this component's rows (or a single frame string) at `ctx.cols`. */
  render(ctx: RenderContext): RenderResult;
  /** Handle a key sequence (an escape sequence such as `\x1b[A`). */
  handleKey(seq: string): KeyResult;
  /** Handle a single decoded character (printable or control). */
  handleChar(ch: string): KeyResult;
  /** Focus gain (`true`) / loss (`false`) notification. */
  onFocus(gain: boolean): void;
  /** Rows this component occupies when rendered at `width` columns. */
  measure(width: number): number;
  /** Lifecycle hook: the component joined the tree (optional). */
  mount?(): void;
  /** Lifecycle hook: the component left the tree (optional). */
  unmount?(): void;
}

/** Shared base: unhandled-by-default key handling, focus state, measure. */
export abstract class BaseComponent implements Component {
  /** True when this component takes part in the focus cycle. */
  readonly focusable: boolean;
  private focused = false;

  constructor(focusable = false) {
    this.focusable = focusable;
  }

  /** Subclasses render their rows here. */
  abstract render(ctx: RenderContext): RenderResult;

  /** Default: never handled — sequences bubble to the next responder. */
  handleKey(_seq: string): KeyResult {
    return "unhandled";
  }

  /** Default: never handled — characters bubble to the next responder. */
  handleChar(_ch: string): KeyResult {
    return "unhandled";
  }

  /**
   * Focus gain/loss: updates `isFocused` first, then runs the subclass hook,
   * so `focusChanged` always observes the new state. Callers drive the order
   * (loss of the old component before gain of the new one).
   */
  onFocus(gain: boolean): void {
    this.focused = gain;
    this.focusChanged(gain);
  }

  /** True while this component holds focus. */
  get isFocused(): boolean {
    return this.focused;
  }

  /** Subclass hook for focus transitions; `isFocused` is already updated. */
  protected focusChanged(_gain: boolean): void {}

  /** Row count of the render result at `width` columns (clamped to whole >= 0). */
  measure(width: number): number {
    const cols = Math.max(0, Math.floor(width));
    return measureRows(this.render({ cols }));
  }

  /** Lifecycle no-op — subclasses override when they own resources. */
  mount(): void {}

  /** Lifecycle no-op — subclasses override when they own resources. */
  unmount(): void {}
}

/** Rows a render result occupies (frame strings split on newlines). */
export function measureRows(result: RenderResult): number {
  if (typeof result !== "string") return result.length;
  return result === "" ? 0 : result.split("\n").length;
}
