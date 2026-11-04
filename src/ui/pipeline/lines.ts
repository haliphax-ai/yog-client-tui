/**
 * Frame line helpers shared by the pipeline stages: a frame is a "\n"-joined
 * string whose lines are padded (or truncated) to exactly `width` cells with
 * ANSI-aware measurement. Every produced row is already hard-wrapped to the
 * terminal width, so truncation here is only a safety net for any straggler.
 */
import { displayWidth, stripAnsi, truncateAnsi } from "../../util/ansi.ts";

/** The composed frame lines (pre-pad) produced by the paint stage. */
export type FrameLines = readonly string[];

/** Pad (or truncate) an ANSI-bearing line to exactly `width` cells. */
export function padLine(line: string, width: number): string {
  const w = displayWidth(line);
  if (w === width) return line;
  if (w > width) return truncateAnsi(line, width);
  return line + " ".repeat(width - w);
}

/** Normalize every line of a "\n"-joined frame to exactly `width` cells. */
export function padFrame(frame: string, width: number): string {
  return frame
    .split("\n")
    .map((line) => padLine(line, width))
    .join("\n");
}

/**
 * Compose the main pane rows (log viewport + input + status), guaranteeing
 * exactly one blank line between the log and the input. The viewport is
 * already allocated one row short of the terminal; when its last row is a
 * blank (the log's trailing entry separator, or padding for short content),
 * that blank IS the gap and nothing is added. When the last row is content
 * (scrolled away from the bottom), a blank row is inserted.
 */
export function composeMainPane(
  viewportRows: readonly string[],
  inputRow: string,
  statusRow: string,
): string[] {
  const last = viewportRows[viewportRows.length - 1];
  const needsGap = stripAnsi(last ?? "").trim() !== "";
  return [...viewportRows, ...(needsGap ? [""] : []), inputRow, statusRow];
}
