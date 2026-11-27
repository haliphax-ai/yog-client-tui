/**
 * Generating notification: the busy spinner plus the "generating" label.
 *
 * A self-contained producer component — it knows nothing about the drawer (or
 * the status bar) it may be drawn in. It renders its row while a turn is in
 * flight (`busy` in the store) and a blank placeholder otherwise (#145:
 * the drawer keeps the child's row so the busy edge shifts no layout).
 *
 * The spinner is the Bubbles spinner model (`Dot` — the full-sized braille
 * preset), driven the way every Bubbles model in this codebase is driven:
 * the host feeds its tick messages and reads its view; the returned commands
 * are ignored (the same precedent as the input's textarea, whose blink
 * commands are also discarded).
 *
 * The component feeds off the store's `busy` flag alone: `render()` gates
 * on it, and every render re-syncs the tick timer to the flag (armed while
 * busy, disarmed while idle). The flag is written by the composition root
 * (`spinnerHooks` in `app/terminalWiring.ts`); the component owns no
 * start/stop API of its own, so a missed stop call cannot freeze the
 * spinner on its last frame.
 */
import { Dot } from "@oakoliver/bubbles";
import { newSpinner, withSpinner, withSpinnerStyle } from "@oakoliver/bubbles";
import type { SpinnerModel } from "@oakoliver/bubbles";
import { BaseComponent, type RenderContext } from "./Component.ts";
import { getState, setState } from "../../core/index.ts";
import { ST } from "../theme.ts";

/** The busy label (one label: a turn is a turn — wake or user-typed). */
const LABEL = "generating";
export class GeneratingComponent extends BaseComponent {
  private spinner: SpinnerModel;
  private timer: NodeJS.Timeout | undefined;

  constructor() {
    super(false);
    this.spinner = newSpinner(withSpinner(Dot), withSpinnerStyle(ST.generating));
  }

  /** Advance the model one frame and poke the render scheduler (cursor-only
   *  navigation does the same `setState({})` poke). */
  private tick(): void {
    [this.spinner] = this.spinner.update(this.spinner.tickMsg());
    setState({});
  }

  /** Disarm the tick timer (idempotent). */
  private stopTicking(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Arm the tick timer at the preset's fps (idempotent). */
  private startTicking(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => this.tick(), this.spinner.spinner.fps);
  }

  /**
   * One row while busy — the model's current frame plus the label — or a
   * blank placeholder row while idle. The timer follows the flag here:
   * armed on the busy edge, disarmed on the idle edge, so rendering is the
   * only entry point the busy state needs (a dropped stop call cannot
   * freeze the spinner on its last frame).
   *
   * The idle row is the drawer-stability contract (#145): the drawer keeps
   * ONE row for this child in both busy and idle states, so the busy edge
   * shifts no layout rows — the log's first visible row holds still while
   * the spinner fades in in place. A retained height of zero on idle would
   * collapse the drawer by one row (two with the item separator) and shove
   * the whole log up mid-turn.
   */
  override render(_ctx: RenderContext): string[] {
    if (!getState().busy) {
      this.stopTicking();
      return [""];
    }
    this.startTicking();
    return [this.spinner.view() + ST.generating.render(LABEL)];
  }
}
