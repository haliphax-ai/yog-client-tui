/**
 * The stage runner: walks the fixed stage order (layout → paint → compose →
 * post → emit), runs each stage's core work, then that stage's registered
 * hooks in registration order. Stage order is the `STAGES` array — never a
 * free-for-all hook bag.
 *
 * Frame threading: each stage receives the frame produced so far and its
 * hooks receive/return it, so later hooks always observe earlier hooks'
 * output. `emit` is the single owner of the final write: its hooks run
 * before the write, and nothing runs after it.
 */
import { STAGES, type Stage } from "./stages.ts";
import { hooksFor } from "./registry.ts";
import { padFrame, type FrameLines } from "./lines.ts";

/** Options wiring the runner to the surrounding host (composition root). */
export interface RunOptions {
  /** Terminal width the post stage pads/truncates lines to. */
  width: number;
  /** layout: read terminal geometry (cols/rows/viewport rows) into components. */
  setMetrics?(): void;
  /** paint: render the component chain into the frame's lines. */
  paint?(): FrameLines;
  /** emit: the single owner of the actual stdout write. */
  emit?(frame: string): void;
}

let running = false;

/**
 * Run one frame through every stage in declared order.
 *
 * Per-stage core work, in order:
 *   layout   → `setMetrics` (terminal geometry), then layout hooks
 *   paint    → `paint()` component rows, joined into the frame, then paint hooks
 *   compose  → pass the joined frame through (viewport + input + status are
 *              already one frame), then compose hooks
 *   post     → pad/truncate every line to `width`, then post hooks
 *   emit     → emit hooks, then the single `emit` write (nothing after)
 */
export function runPipeline(options: RunOptions): void {
  if (running) throw new Error("pipeline re-entered while running");
  running = true;
  try {
    let frame = "";
    for (const stage of STAGES) {
      frame = runStage(stage, frame, options);
    }
  } finally {
    running = false;
  }
}

/** Core work per stage, followed by that stage's registered hooks. */
function runStage(stage: Stage, frame: string, options: RunOptions): string {
  let next = frame;
  switch (stage) {
    case "layout":
      options.setMetrics?.();
      break;
    case "paint":
      next = (options.paint?.() ?? []).join("\n"); // the composed frame
      break;
    case "compose":
      break; // paint already produced the joined frame; compose hooks run on it
    case "post":
      next = padFrame(next, options.width);
      break;
    case "emit":
      break; // handled below so nothing runs after the write
  }
  for (const hook of hooksFor(stage)) next = hook(next);
  if (stage === "emit") options.emit?.(next);
  return next;
}