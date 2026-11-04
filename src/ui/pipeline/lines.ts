/**
 * Frame line helpers shared by the pipeline stages: a frame is a "\n"-joined
 * string whose short lines are padded to `width` cells with ANSI-aware
 * measurement. Lines longer than `width` (soft-wrapped prose, code, or tool
 * output) are left intact so the terminal can wrap them at the right margin.
 */
import { displayWidth } from "../../util/ansi.ts";

/** The composed frame lines (pre-pad) produced by the paint stage. */
export type FrameLines = readonly string[];

/** Pad an ANSI-bearing line to at least `width` cells; overlong lines are
 *  left unchanged (the terminal soft-wraps them). */
export function padLine(line: string, width: number): string {
  const w = displayWidth(line);
  if (w >= width) return line;
  return line + " ".repeat(width - w);
}

/** Normalize every line of a "\n"-joined frame: pad short lines to `width`. */
export function padFrame(frame: string, width: number): string {
  return frame
    .split("\n")
    .map((line) => padLine(line, width))
    .join("\n");
}
