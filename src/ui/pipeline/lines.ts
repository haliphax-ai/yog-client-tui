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
 * Compose the main pane rows (log viewport + drawer + input + status).
 *
 * Exactly one blank line separates the log from what follows it. When the
 * drawer is visible, that blank is the drawer's own top padding: the
 * viewport's trailing blank (the log's entry separator, or padding for
 * short content) is consumed so it does not stack with the padding into
 * two blank lines. When the viewport ends in content (scrolled away from
 * the bottom), its last row is consumed as the margin instead — the
 * viewport renders one row of content less and the drawer's padding takes
 * its place, so the frame still fits the terminal exactly. The layout
 * accounts for the consumed row (see `drawerGap` in main.ts).
 *
 * When the drawer is fully collapsed (no rows), the composition guarantees
 * the same single blank line between the log and the input: the viewport's
 * trailing blank is reused as the gap, or its last content row is consumed
 * as the margin, so the frame still fits the terminal exactly.
 */
export function composeMainPane(
  viewportRows: readonly string[],
  drawerRows: readonly string[],
  inputRow: string,
  statusRow: string,
): string[] {
  if (drawerRows.length > 0) {
    return [...viewportRows.slice(0, -1), ...drawerRows, inputRow, statusRow];
  }
  const last = viewportRows[viewportRows.length - 1];
  if (stripAnsi(last ?? "").trim() !== "") {
    return [...viewportRows.slice(0, -1), "", inputRow, statusRow];
  }
  return [...viewportRows, inputRow, statusRow];
}
