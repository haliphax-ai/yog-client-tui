/**
 * Generating notification: the busy spinner plus the "generating" label.
 *
 * A self-contained producer component — it knows nothing about the drawer (or
 * the status bar) it may be drawn in. It is visible exactly while a turn is
 * in flight (`busy` in the store) and fully collapsed (zero rows) otherwise.
 *
 * The spinner is the Bubbles spinner model (`Dot` — the full-sized braille
 * preset), driven the way every Bubbles model in this codebase is driven:
 * the host feeds its tick messages and reads its view; the returned commands
 * are ignored (the same precedent as the input's textarea, whose blink
 * commands are also discarded). `start()` / `stop()` own the tick timer at
 * the preset's own fps; the composition root calls them alongside the store's
 * `busy` flag.
 */
import { Dot } from "@oakoliver/bubbles";
import { newSpinner, withSpinner, withSpinnerStyle } from "@oakoliver/bubbles";
import type { SpinnerModel } from "@oakoliver/bubbles";
import { BaseComponent, type RenderContext } from "./Component.ts";
import { getState, setState } from "../../core/store.ts";
import { ST } from "../theme.ts";

/** Busy label drawn after the spinner frame (the frame supplies its own gap). */
const LABEL = "generating";

export class GeneratingComponent extends BaseComponent {
  private spinner: SpinnerModel;
  private timer: NodeJS.Timeout | undefined;

  constructor() {
    super(false);
    this.spinner = newSpinner(withSpinner(Dot), withSpinnerStyle(ST.generating));
  }

  /** Start the spinner tick timer (idempotent). */
  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      // Advance the Bubbles model one frame and poke the render scheduler
      // (cursor-only navigation does the same `setState({})` poke).
      [this.spinner] = this.spinner.update(this.spinner.tickMsg());
      setState({});
    }, this.spinner.spinner.fps);
  }

  /** Stop the spinner tick timer (idempotent). */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * One styled row while busy — the model's current frame plus the label —
   * or no rows while idle.
   */
  override render(_ctx: RenderContext): string[] {
    if (!getState().busy) return [];
    return [this.spinner.view() + ST.generating.render(LABEL)];
  }
}
