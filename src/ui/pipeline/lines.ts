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
 * The gap between the log and what follows it is owned by the drawer when
 * the drawer is visible: the drawer's own top padding IS that blank line,
 * so no separate gap row is added (adding one would stack two blank lines
 * between the log and the drawer's content). When the drawer is fully
 * collapsed (no rows), the composition guarantees exactly one blank line
 * between the log and the input without shrinking the frame: when the
 * viewport's last row is already blank (the log's trailing entry separator,
 * or padding for short content), that blank IS the gap and nothing is
 * added; when the last row is content (scrolled away from the bottom),
 * that row is consumed as the margin — the viewport renders one row of
 * content less and the blank takes its place, so the frame still fits the
 * terminal exactly.
 */
export function composeMainPane(
  viewportRows: readonly string[],
  drawerRows: readonly string[],
  inputRow: string,
  statusRow: string,
): string[] {
  if (drawerRows.length > 0) {
    return [...viewportRows, ...drawerRows, inputRow, statusRow];
  }
  const last = viewportRows[viewportRows.length - 1];
  if (stripAnsi(last ?? "").trim() !== "") {
    return [...viewportRows.slice(0, -1), "", inputRow, statusRow];
  }
  return [...viewportRows, inputRow, statusRow];
}
